import { Room, type Client } from './room';
import { persistMatch } from './persist';
import { actForSeason, currentSeasonNumber, getRating, createPendingMatch } from './db/repo';
import { dbEnabled } from './db/pool';
import { BALANCE_VERSION } from '../src/config';
import type { GameId } from '../src/types';
import { bestHost, type PingInfo } from './regions';
import type { PendingMatch, PendingRosterEntry } from './matchTypes';
import { QUEUE_NEED, type LobbyPlayer, type QueueMode, type ServerMsg } from '../src/net/protocol';

/**
 * Region-aware ranked matchmaking. Runs on the DESIGNATED matchmaker machine (all
 * `?mm=1` connections are fly-replayed here), so it holds ONE global queue per
 * bucket across every region. Pairing is region-local first and widens over time:
 *
 *  - Each entry reports `homeRegion` + `accessMs`; the matchmaker estimates every
 *    player's latency to every region (`bestHost`) and hosts a match on the fair
 *    MIDPOINT region (minimax).
 *  - A pairing is only allowed once its cross-region `spread` fits under every
 *    member's SEARCH RADIUS, which starts at 0 (same region only) and widens with
 *    wait time / an explicit `expandSearch`. So you get a local match if one is
 *    available soon, and a farther one only after waiting.
 *
 * On a match the matchmaker STAGES the roster (Postgres `pending_matches`) and sends
 * `matchAssigned`; the clients reconnect to the host region, which builds the real
 * match. When the DB is off (local dev) it falls back to hosting the match right
 * here (`localStart`), which only works for same-machine players — fine for dev.
 */

/**
 * Search-radius schedule, in CROSS-REGION ms (not absolute ping — a player's own
 * access latency never counts against the gate, so a bad local link can't block a
 * local match).
 *
 * TUNED FOR A SMALL POOL, which is the pool this game actually has. The radius is
 * not a quality mechanism — `findMatch` picks the CLOSEST eligible opponent, so a
 * local match is taken whenever a local match exists, at any radius. All the
 * radius decides is HOW LONG YOU WAIT FOR A BETTER ONE TO SHOW UP. On a pool of
 * two or three people that better one is not coming, and the old schedule (0ms
 * for the first 8s, +60ms per 8s) charged everyone for it: 16 seconds before two
 * players on opposite US coasts were even allowed to meet, 40 before the queue
 * went global. With a handful of players online that wait WAS the matchmaking
 * time.
 *
 * So: open at 90ms, which already covers every same-continent pair (iad↔lhr 76,
 * iad↔sjc 85) — those are good matches, and there is nothing to gain by making
 * them wait. Then reach worldwide in 6 seconds instead of 40.
 */
export const RADIUS_BASE_MS = 90;
export const RADIUS_STEP_MS = 105;
export const RADIUS_INTERVAL_MS = 3000;
export const RADIUS_MAX_MS = 300;

/** the widening ceiling for one waiting entry (cross-region ms it will tolerate) */
export function radiusCeiling(waitedMs: number, expandBumps: number, noWiden?: boolean): number {
  if (noWiden) return 0; // stay region-local forever
  const steps = Math.floor(Math.max(0, waitedMs) / RADIUS_INTERVAL_MS) + expandBumps;
  return Math.min(RADIUS_MAX_MS, RADIUS_BASE_MS + RADIUS_STEP_MS * steps);
}

export interface QueueEntry {
  id: string;
  send: (m: ServerMsg) => void;
  player: Omit<LobbyPlayer, 'clientId'>;
  userId?: string;
  mode: QueueMode;
  homeRegion: string;
  accessMs: number;
  /** true ⇒ never widen past my own region */
  noWiden?: boolean;
  /** protocol capabilities this client build advertised (mixed-version safe) */
  caps?: string[];
  /** which game this client queued for (part of the bucket key — see bucketKey).
   * Absent ⇒ 'decode'. */
  game?: GameId;
  /** release channel ('alpha' | 'stable' | …). The matchmaker ONLY pairs entries
   * of the same channel — alpha and stable run different src/sim, so a shared
   * authoritative match would desync. Absent ⇒ 'stable'. */
  channel?: string;
  /** this client build's id (the git sha, `__BUILD_ID__`). The matchmaker ALSO
   * segregates by build so two different builds NEVER share an authoritative match
   * even inside one channel — the exact "same code" invariant (a channel is only a
   * coarse, manually-set proxy). This is what actually keeps alpha and main apart
   * automatically: their shas always differ, no `VITE_APP_CHANNEL` required. Matches
   * the client-side version gate ("everyone on the same version for multiplayer"),
   * enforced authoritatively here. Absent (old client that predates this) ⇒ falls
   * back to channel-only separation. */
  build?: string;
  /**
   * "Play a friend": the verified challenge token this entry queued under. Entries
   * sharing one form a UNIT — the matchmaker adds them to a group all-or-nothing
   * and never splits them across alliances.
   *
   * VERIFIED, not claimed: `server/index.ts` resolves the token against the actual
   * challenge row before it reaches here, so an entry carrying one is known to be
   * a party to it. Two people who never challenged each other cannot hand each
   * other a string and stage themselves a rated match.
   */
  party?: string;
  /**
   * How many entries this party is waiting to be (2 for a friend challenge).
   *
   * Load-bearing, not bookkeeping. The two members enqueue SECONDS apart — one
   * accepts, the other is already waiting — and without a known target size the
   * matchmaker sees the first arrival as a complete unit of one and can hand them
   * to an open group before their partner ever connects. The friend then arrives
   * to a challenge whose other half is already in someone else's match.
   */
  partySize?: number;
  /** this party is the WHOLE match: pair it with itself and nobody else, and skip
   * the search radius (they chose each other; there is nothing to widen toward) */
  partyOnly?: boolean;
  /** set by enqueue (this.now()); drives the widening ceiling */
  enqueuedAt: number;
  /** extra manual widen steps from `expandSearch` */
  expandBumps: number;
  /** DEV FALLBACK only: told which local Room this connection landed in */
  onRoom?: (room: Room) => void;
}

/** how a paired group is handed off to its host machine. Production stages it to
 * Postgres; tests inject a recorder. */
export type StageFn = (m: PendingMatch) => Promise<void>;

export interface MatchmakerDeps {
  /** injectable clock (tests control widening); when set, the auto-widen timer is off */
  now?: () => number;
  /** override the staging step (default: Postgres pending_matches when dbEnabled) */
  stage?: StageFn;
}

let roomSeq = 0;
const rand6 = (): string => Math.floor(Math.random() * 0x7fffffff).toString(36).padStart(6, '0').slice(-6);

export class Matchmaker {
  private readonly queues: Record<QueueMode, QueueEntry[]> = { '1v1': [], '2v2': [] };
  private readonly rooms = new Set<Room>();
  private readonly now: () => number;
  private readonly stage?: StageFn;
  private readonly timer: ReturnType<typeof setInterval> | null;

  constructor(deps: MatchmakerDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    // default staging: write to Postgres so the host machine can claim it. Absent
    // (no injected stage AND no DB) ⇒ localStart fallback.
    this.stage = deps.stage ?? (dbEnabled ? (m) => createPendingMatch(m) : undefined);
    // auto-widen: re-attempt matches as ceilings grow. Disabled when a clock is
    // injected (deterministic tests drive matching via enqueue/expand/tick).
    this.timer = deps.now ? null : setInterval(() => this.tick(), 1000);
    if (this.timer?.unref) this.timer.unref(); // never keep the process alive
  }

  enqueue(entry: QueueEntry): void {
    this.remove(entry.id); // never double-queue a connection
    // never let one ACCOUNT hold two queue entries at once (a second tab, or a
    // stale entry a `?mm=1` reconnect left behind under a fresh connection id).
    // Otherwise the matchmaker could pair a user with THEMSELF, staging a roster
    // with two slots for one identity — on the host, `byUser` collapses to one
    // client, so one robot takes the driver's input (a "ghost" they control) and
    // the other is left unmapped + frozen. Drop any prior entry for this user.
    if (entry.userId) this.removeUser(entry.userId, entry.id);
    entry.enqueuedAt = this.now();
    entry.expandBumps = entry.expandBumps ?? 0;
    this.queues[entry.mode].push(entry);
    this.tryMatch(entry.mode);
    this.broadcastStatus(entry.mode);
  }

  remove(id: string): void {
    for (const mode of Object.keys(this.queues) as QueueMode[]) {
      const q = this.queues[mode];
      const i = q.findIndex((e) => e.id === id);
      if (i >= 0) {
        q.splice(i, 1);
        this.broadcastStatus(mode);
      }
    }
  }

  /** drop every queue entry belonging to `userId` EXCEPT connection `keepId`
   * (the fresh entry). Prevents one account from holding two queue slots. */
  private removeUser(userId: string, keepId: string): void {
    for (const mode of Object.keys(this.queues) as QueueMode[]) {
      const q = this.queues[mode];
      const before = q.length;
      this.queues[mode] = q.filter((e) => e.userId !== userId || e.id === keepId);
      if (this.queues[mode].length !== before) this.broadcastStatus(mode);
    }
  }

  /** impatient player: widen their radius one step now, then retry */
  expand(id: string): void {
    for (const mode of Object.keys(this.queues) as QueueMode[]) {
      const e = this.queues[mode].find((x) => x.id === id);
      if (e) {
        e.expandBumps++;
        this.tryMatch(mode);
        return;
      }
    }
  }

  /** periodic re-attempt as wait-driven ceilings grow (auto-widen) */
  tick(): void {
    this.tryMatch('1v1');
    this.tryMatch('2v2');
  }

  private ceilingOf(e: QueueEntry, now: number): number {
    return radiusCeiling(now - e.enqueuedAt, e.expandBumps, e.noWiden);
  }

  private tryMatch(mode: QueueMode): void {
    let m = this.findMatch(mode);
    while (m) {
      const ids = new Set(m.group.map((g) => g.id));
      this.queues[mode] = this.queues[mode].filter((e) => !ids.has(e.id));
      void this.startMatch(mode, m.group, m.hostRegion);
      m = this.findMatch(mode);
    }
  }

  /**
   * FIFO-anchored greedy pairing over UNITS: for the oldest waiting unit, add the
   * units that keep the group hostable under EVERY member's current radius, until
   * the bucket is full. Returns the group + its fair host region, or null.
   *
   * NEAREST-FIRST, not first-fit. Each round picks the eligible unit that yields
   * the SMALLEST resulting spread, ties going to whoever has waited longer (the
   * comparison is strict, so FIFO order wins them). That inversion is what lets the
   * radius schedule be aggressive: proximity is now enforced directly, by choosing
   * the closest opponent available, instead of indirectly by refusing to look far
   * for the first 40 seconds. Under first-fit the two mechanisms were the same
   * knob, so making matchmaking quick necessarily made it worse; separated, a wide
   * radius only ever means "nothing closer exists", never "we stopped looking".
   *
   * A unit is normally one player. A "play a friend" party is one unit of two, and
   * pairing at unit granularity is what makes that work: a party is added
   * all-or-nothing, so it can never be half-matched into a group with no room left
   * for its other member.
   */
  private findMatch(mode: QueueMode): { group: QueueEntry[]; hostRegion: string } | null {
    const need = QUEUE_NEED[mode];
    const units = this.units(mode);
    const now = this.now();
    for (let i = 0; i < units.length; i++) {
      const anchor = units[i];
      if (anchor.length > need) continue; // malformed party — never stage it
      if (!partyReady(anchor)) continue; // still waiting on its other member
      const group = [...anchor];
      if (anchor.some((e) => e.partyOnly)) {
        // a CLOSED party (rated 1v1): it is the whole match or it waits. No
        // strangers, and no radius gate — two people who challenged each other
        // have already decided they'll play across whatever distance separates
        // them. The compatibility bucket still applies: same channel + build or no
        // match, because a mixed-build match desyncs no matter who asked for it.
        if (group.length !== need) continue;
        if (group.some((e) => bucketKey(e) !== bucketKey(anchor[0]))) continue;
        return { group, hostRegion: bestHost(group.map(toPing)).hostRegion };
      }
      const taken = new Set<number>([i]);
      while (group.length < need) {
        let pick: { j: number; unit: QueueEntry[]; spread: number } | null = null;
        for (let j = 0; j < units.length; j++) {
          if (taken.has(j)) continue;
          const cand = units[j];
          // a closed party never joins someone else's group
          if (cand.some((e) => e.partyOnly)) continue;
          // and a half-arrived party is not available to be taken
          if (!partyReady(cand)) continue;
          // all-or-nothing: a party that doesn't fit in the remaining slots is skipped
          if (group.length + cand.length > need) continue;
          // never pair across compatibility buckets (channel + build) — different
          // src/sim (alpha vs stable) OR different builds run different code, so a
          // shared authoritative match would desync both clients
          if (bucketKey(cand[0]) !== bucketKey(anchor[0])) continue;
          // never put the same account in a group twice (backstop for the userId
          // dedup above) — a self-pair produces a frozen "ghost" robot
          if (cand.some((c) => c.userId && group.some((g) => g.userId === c.userId))) continue;
          const trial = [...group, ...cand];
          const { spread } = bestHost(trial.map(toPing));
          const ceiling = Math.min(...trial.map((e) => this.ceilingOf(e, now)));
          if (spread > ceiling) continue;
          // STRICTLY closer to displace the incumbent, so an equally-close unit
          // never jumps the queue ahead of one that has been waiting longer
          if (!pick || spread < pick.spread) pick = { j, unit: cand, spread };
        }
        if (!pick) break;
        taken.add(pick.j);
        group.push(...pick.unit);
      }
      if (group.length === need) {
        const { hostRegion } = bestHost(group.map(toPing));
        return { group, hostRegion };
      }
    }
    return null;
  }

  /**
   * Group a queue into matchable units, preserving FIFO: a party takes the queue
   * position of its FIRST member, so waiting together never jumps the line and
   * never loses your place either.
   */
  private units(mode: QueueMode): QueueEntry[][] {
    return groupUnits(this.queues[mode]);
  }

  /** current overall ELO for a driver's intro card (best-effort; null on DB-off /
   * signed-out / read failure — the intro just shows "Unranked") */
  private async introElo(entry: QueueEntry, mode: QueueMode): Promise<number | null> {
    if (!dbEnabled || !entry.userId) return null;
    try {
      // ELO is keyed by the game's current ACT (persists across seasons in an act).
      const bv = await currentSeasonNumber(BALANCE_VERSION, entry.game);
      const act = await actForSeason(bv, entry.game);
      return await getRating(entry.userId, mode, act, entry.game);
    } catch {
      return null;
    }
  }

  private async startMatch(mode: QueueMode, group: QueueEntry[], hostRegion: string): Promise<void> {
    if (this.stage) await this.assign(mode, group, hostRegion);
    else this.localStart(mode, group); // dev fallback: host here (same-machine only)
  }

  /** stage the roster for the host region + tell each client to reconnect there */
  private async assign(mode: QueueMode, rawGroup: QueueEntry[], hostRegion: string): Promise<void> {
    const group = allianceOrder(rawGroup);
    const half = group.length / 2;
    const seed = (this.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    const code = `${hostRegion}-${mode}${roomSeq++}${rand6()}`;
    const roster: PendingRosterEntry[] = await Promise.all(
      group.map(async (e, i) => ({
        userId: e.userId,
        name: e.player.name,
        teamName: e.player.teamName,
        teamNumber: e.player.teamNumber,
        spec: e.player.spec,
        assists: e.player.assists,
        // distinct START_POSES index per alliance (not trusted from the client)
        startIndex: i < half ? i : i - half,
        alliance: (i < half ? 'red' : 'blue') as PendingRosterEntry['alliance'],
        introElo: await this.introElo(e, mode),
        channel: e.channel,
        // stash the game in the roster jsonb so the host recovers it (no schema col)
        game: e.game,
      })),
    );
    await this.stage!({ code, hostRegion, mode, seed, roster, ranked: true, channel: group[0].channel, game: group[0].game });
    for (const e of group) e.send({ t: 'matchAssigned', mode, room: code, hostRegion });
  }

  /** DEV/no-DB fallback: run the match on THIS machine. Only reachable when
   * DATABASE_URL is unset, where everyone is on one machine anyway. Routes through
   * the SAME staged-roster path (`applyPending`) as production so the pre-match
   * STRATEGY window runs in dev too — dev clients may be anonymous, so synthesize a
   * stable per-connection id for the userId→slot mapping. */
  private localStart(mode: QueueMode, rawGroup: QueueEntry[]): void {
    const group = allianceOrder(rawGroup);
    const code = `mm-${mode}-${roomSeq++}`;
    const room = new Room(code, () => this.rooms.delete(room), { kind: 'versus', game: group[0].game }, persistMatch);
    this.rooms.add(room);
    const half = group.length / 2;
    const seed = (this.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    const roster: PendingRosterEntry[] = group.map((e, i) => ({
      userId: e.userId ?? e.id, // dev: a stable id so the host can map roster slots
      name: e.player.name,
      teamName: e.player.teamName,
      teamNumber: e.player.teamNumber,
      spec: e.player.spec,
      assists: e.player.assists,
      startIndex: i < half ? i : i - half,
      alliance: (i < half ? 'red' : 'blue') as PendingRosterEntry['alliance'],
      introElo: null,
    }));
    group.forEach((e, i) => {
      const client: Client = {
        id: e.id,
        send: e.send,
        player: { ...e.player, clientId: e.id, alliance: roster[i].alliance },
        connected: true,
        disconnectAt: 0,
        userId: roster[i].userId,
        caps: e.caps,
        channel: e.channel,
      };
      room.add(client);
      e.onRoom?.(room);
    });
    room.applyPending({ code, hostRegion: '', mode, seed, roster, ranked: true });
  }

  /** live queue depth per bucket, for the public presence endpoint. CLOSED parties
   * are excluded: they can never pair with anyone reading this number, so counting
   * them would advertise a pool that isn't there. */
  queueSizes(): Record<QueueMode, number> {
    const open = (m: QueueMode): number => this.queues[m].reduce((n, e) => n + (e.partyOnly ? 0 : 1), 0);
    return { '1v1': open('1v1'), '2v2': open('2v2') };
  }

  private broadcastStatus(mode: QueueMode): void {
    // report each waiter the depth of ITS OWN bucket (channel + build) — pairing is
    // bucket-scoped, so a mixed count would falsely read "enough players" and never
    // match (a lone alpha queuer must not be told a pool of stable/older builds is ready)
    for (const e of this.queues[mode]) {
      // a closed party isn't waiting on the pool, it's waiting on one person — so
      // count only its own members. Otherwise a friend challenge would read "6/2"
      // off a busy open queue it can never be matched from.
      const size = e.partyOnly
        ? this.queues[mode].reduce((n, x) => n + (x.party === e.party ? 1 : 0), 0)
        : this.queues[mode].reduce((n, x) => n + (!x.partyOnly && bucketKey(x) === bucketKey(e) ? 1 : 0), 0);
      e.send({ t: 'queued', mode, size, need: QUEUE_NEED[mode] });
    }
  }
}

const toPing = (e: QueueEntry): PingInfo => ({ homeRegion: e.homeRegion, accessMs: e.accessMs });

/**
 * Split a queue into matchable UNITS: each "play a friend" party is one unit,
 * everyone else is a unit of one. A party takes the queue position of its first
 * member, so the whole thing keeps that member's place in line.
 *
 * Exported for the matchmaker test script — this and `allianceOrder` are the two
 * pieces of party logic that a live two-account test would otherwise be the only
 * way to exercise.
 */
/**
 * Is this unit matchable yet? A solo always is; a party only once every member it
 * is waiting for has actually connected.
 *
 * The two members of a challenge enqueue seconds apart, and treating the first
 * arrival as a complete unit lets an open group swallow them — their friend then
 * accepts into a challenge whose other half is already playing someone else.
 */
export function partyReady(unit: QueueEntry[]): boolean {
  const want = unit[0]?.partySize ?? 0;
  return !unit[0]?.party || unit.length >= want;
}

export function groupUnits(q: QueueEntry[]): QueueEntry[][] {
  const byParty = new Map<string, QueueEntry[]>();
  const out: QueueEntry[][] = [];
  for (const e of q) {
    if (!e.party) {
      out.push([e]);
      continue;
    }
    const unit = byParty.get(e.party);
    if (unit) unit.push(e);
    else {
      const fresh = [e];
      byParty.set(e.party, fresh);
      out.push(fresh);
    }
  }
  return out;
}

/**
 * Order a matched group so `assign`'s index split (`i < half` ⇒ red) puts each
 * party on ONE alliance.
 *
 * The split is positional, so all this has to do is make parties contiguous and
 * front-loaded — a stable sort by descending unit size does it: a 2v2 with one
 * party becomes [P, P, S, S], red = the party.
 *
 * The 1v1 case looks like it should be the exception and isn't. A `rated1v1`
 * party of two lands at indices 0 and 1 with half = 1, so it splits ACROSS the
 * alliances — which is exactly right, because in that format the party is the two
 * opponents, not two teammates. Same rule, both meanings.
 */
export function allianceOrder(group: QueueEntry[]): QueueEntry[] {
  const units = groupUnits(group);
  if (units.length === group.length) return group; // no parties — leave FIFO alone
  return units.sort((a, b) => b.length - a.length).flat();
}

/** matchmaking compatibility bucket: two entries may only be paired when this key
 * matches — same release channel AND same client build. Absent build ⇒ '' (old
 * clients fall back to channel-only separation). */
// GAME is part of the bucket: a Chain-Reaction queuer and a DECODE queuer run
// DIFFERENT `step()`s, so they must NEVER share one authoritative room (instant
// desync). Old clients advertise no game ⇒ 'decode', so they only ever bucket with
// other DECODE players.
const bucketKey = (e: QueueEntry): string => `${e.game ?? 'decode'}|${e.channel ?? 'stable'}|${e.build ?? ''}`;
