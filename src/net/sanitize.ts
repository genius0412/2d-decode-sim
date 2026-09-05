import type { LobbyPlayer, PlayerPatch } from './protocol';
import type { Replay } from '../sim/replay';
import { REPLAY_FORMAT, maxMatchTicks, trackStride } from '../sim/replay';
import { coerceSetup, type RobotSetup } from '../sim/spawn';
import type { GameId } from '../games/types';
import { coerceSpec, coerceAssists, coerceAutoPath, coerceStartPose, DEFAULT_SPEC, DEFAULT_ASSISTS } from '../sim/spawn';
import { START_POSES } from '../config';
import { clamp } from '../math';

/**
 * SERVER-SIDE untrusted-input sanitization for the lobby model. Everything a
 * client sends about its own robot (`join` player, `update` patch, ranked
 * `queue` player) is spoofable via devtools — people have edited the wire spec
 * to spawn oversized / malformed robots. The server must NEVER trust it: these
 * helpers force every field into a legal shape BEFORE it is stored on the room's
 * roster (which then feeds `createWorld`). The heavy lifting (spec/assist/auto
 * ranges) is the SAME `coerceSpec`/`coerceAssists`/`coerceAutoPath` the client
 * uses, so a client's own prediction matches what the server spawns.
 *
 * `game` MUST be threaded through: some chassis ranges are game-aware (Chain
 * Reaction runs its own length range, `CHAIN_MIN/MAX_LENGTH`, since its sweeper
 * doesn't eat into an 18" cube like DECODE's reach-limited intakes). Without it
 * the server would clamp a CR spec with DECODE's per-intake length range — a
 * DIFFERENT envelope than the config menu offered — silently resizing a
 * record-run / ranked robot away from what the player built. Pass the room's /
 * queue's game so server limits == config-menu limits.
 */

function coerceName(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && raw.trim() ? raw.slice(0, 24) : fallback;
}

function coerceStartIndex(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw)
    ? clamp(Math.round(raw), 0, START_POSES.length - 1)
    : 0;
}

/** sanitize a full lobby player (join / queue). `clientId` is assigned by the
 * server, never taken from the wire. */
export function sanitizePlayer(raw: unknown, game?: GameId): Omit<LobbyPlayer, 'clientId'> {
  const p = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const spec = coerceSpec(p.spec, DEFAULT_SPEC, game);
  const autoPath = coerceAutoPath(p.autoPath);
  return {
    name: coerceName(p.name, 'Driver'),
    // team name/number live on the spec AND the top-level player; keep them in
    // sync with the (already-clamped) spec so the roster can't disagree with it
    teamName: spec.teamName,
    teamNumber: spec.teamNumber,
    alliance: p.alliance === 'red' || p.alliance === 'blue' ? p.alliance : 'blue',
    startIndex: coerceStartIndex(p.startIndex),
    // structural + field-bounds only; G304 legality is snapped spec/alliance-aware
    // by createWorld → coerceSetup, the spawn chokepoint.
    startPose: p.startPose == null ? null : coerceStartPose(p.startPose),
    startRole: p.startRole === 'close' || p.startRole === 'far' ? p.startRole : undefined,
    swapReq: p.swapReq === true,
    ready: p.ready === true,
    spec,
    assists: coerceAssists(p.assists, DEFAULT_ASSISTS),
    autoPath: autoPath ?? undefined,
    autoPathEnabled: autoPath ? p.autoPathEnabled === true : false,
  };
}

/** sanitize an in-room `update` patch: only keys actually present are returned,
 * each coerced to a legal value. A malformed patch yields an empty patch (no-op)
 * rather than corrupting the stored player. `current` is the player's existing
 * spec/assists so a partial spec patch clamps against the right baseline. */
export function sanitizePlayerPatch(raw: unknown, current: LobbyPlayer, game?: GameId): PlayerPatch {
  if (typeof raw !== 'object' || raw === null) return {};
  const p = raw as Record<string, unknown>;
  const out: PlayerPatch = {};
  if ('name' in p) out.name = coerceName(p.name, current.name);
  if ('alliance' in p && (p.alliance === 'red' || p.alliance === 'blue')) out.alliance = p.alliance;
  if ('startIndex' in p) out.startIndex = coerceStartIndex(p.startIndex);
  if ('startPose' in p) out.startPose = p.startPose == null ? null : coerceStartPose(p.startPose);
  if ('startRole' in p) out.startRole = p.startRole === 'close' || p.startRole === 'far' ? p.startRole : undefined;
  if ('swapReq' in p) out.swapReq = p.swapReq === true;
  if ('ready' in p) out.ready = p.ready === true;
  if ('assists' in p) out.assists = coerceAssists(p.assists, current.assists);
  if ('spec' in p) {
    const spec = coerceSpec(p.spec, current.spec, game);
    out.spec = spec;
    // keep the top-level team fields consistent with the clamped spec
    out.teamName = spec.teamName;
    out.teamNumber = spec.teamNumber;
  } else {
    if ('teamName' in p) out.teamName = coerceName(p.teamName, current.teamName);
    if ('teamNumber' in p && typeof p.teamNumber === 'number' && Number.isFinite(p.teamNumber)) {
      out.teamNumber = clamp(Math.round(p.teamNumber), 0, 99999);
    }
  }
  if ('autoPath' in p) {
    const autoPath = coerceAutoPath(p.autoPath);
    out.autoPath = autoPath ?? undefined;
    out.autoPathEnabled = autoPath ? p.autoPathEnabled === true : false;
  } else if ('autoPathEnabled' in p) {
    // only meaningful with a path already stored
    out.autoPathEnabled = current.autoPath ? p.autoPathEnabled === true : false;
  }
  return out;
}

/**
 * SANITIZE AN UPLOADED SOLO-PRACTICE REPLAY.
 *
 * This is the one replay that arrives FROM a client rather than being produced by the
 * authoritative loop, because solo practice has no authoritative loop — it is the offline
 * mode. So the container is untrusted in exactly the way a wire spec is: every field is
 * spoofable, and `setups` feeds `createWorld` the moment anyone watches it back.
 *
 * What this cannot do, and deliberately does not pretend to: verify the SCORE. There is no
 * cheap way to — the honest check is re-simulating the whole match, which is ~9,900 ticks of
 * physics on a box running 60 Hz matches for other people, spent authenticating a number that
 * decorates the owner's own list and can never reach a board (`practice_runs` is unreachable
 * from `record_leaderboard` by construction; see migration 0032). It is also self-policing in
 * the only place it is shown: the viewer RE-SIMULATES the log, so a score that disagrees with
 * its own replay contradicts itself on screen.
 *
 * Returns null when the container is not something this build could ever play, which is the
 * point at which storing it would only waste the account's slots.
 */
export function sanitizeReplay(raw: unknown, game?: GameId): Replay | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Replay>;

  // A FUTURE format is refused rather than kept: the reader takes the stride from the
  // container, so one we cannot parse is a row nobody — including its owner — can watch.
  const format = typeof r.format === 'number' && Number.isFinite(r.format) ? Math.round(r.format) : 0;
  if (format < 1 || format > REPLAY_FORMAT) return null;
  if (r.mode !== 'match' && r.mode !== 'free') return null;

  const seed = typeof r.seed === 'number' && Number.isFinite(r.seed) ? r.seed >>> 0 : null;
  if (seed === null) return null;

  // bounded by what a MATCH can be. A longer log is either a different mode or a fabrication,
  // and either way it is not a practice match.
  const ticks = typeof r.ticks === 'number' && Number.isFinite(r.ticks) ? Math.round(r.ticks) : 0;
  if (ticks < 1 || ticks > maxMatchTicks() + 1) return null;

  if (!Array.isArray(r.setups) || r.setups.length < 1 || r.setups.length > 4) return null;
  const setups: RobotSetup[] = [];
  const seen = new Set<number>();
  for (const raws of r.setups) {
    if (!raws || typeof raws !== 'object') return null;
    const id = (raws as RobotSetup).id;
    if (typeof id !== 'number' || !Number.isFinite(id) || id < 0 || id > 3) return null;
    if (seen.has(id)) return null; // two robots with one id cannot be spawned
    seen.add(id);
    // the SAME coercion `createWorld` runs, so a stored setup can never spawn a robot the
    // builder would not have offered
    setups.push(coerceSetup({ ...(raws as RobotSetup), id: Math.round(id) }));
  }

  // tracks: flat number arrays keyed by a robot id that exists in `setups`, each a whole
  // number of entries at this container's stride, and bounded by the tick count
  const stride = trackStride(format);
  const tracks: Record<number, number[]> = {};
  const rawTracks = (r.tracks ?? {}) as Record<string, unknown>;
  if (typeof rawTracks !== 'object') return null;
  for (const [key, val] of Object.entries(rawTracks)) {
    const id = Number(key);
    if (!Number.isInteger(id) || !seen.has(id)) return null;
    if (!Array.isArray(val)) return null;
    if (val.length % stride !== 0) return null;
    // one entry per tick is the theoretical maximum; anything beyond it is padding
    if (val.length / stride > ticks + 1) return null;
    if (!val.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    tracks[id] = val as number[];
  }

  return {
    format,
    balanceVersion:
      typeof r.balanceVersion === 'number' && Number.isFinite(r.balanceVersion)
        ? Math.round(r.balanceVersion)
        : 0,
    sim: typeof r.sim === 'number' && Number.isFinite(r.sim) ? Math.round(r.sim) : undefined,
    game: r.game === 'chain' || r.game === 'decode' ? r.game : (game ?? 'decode'),
    mode: r.mode,
    seed,
    ticks,
    setups,
    tracks,
  };
}
