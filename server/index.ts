import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import v8 from 'node:v8';
import { Room, type Client } from './room';
import { decodeClientMsg, encodeMsg, DEFAULT_ROOM_CONFIG, RATED_FORMATS, SERVER_CAPS, type ClientMsg, type LiveRoom, type RoomConfig, type ServerMsg } from '../src/net/protocol';
import { sanitizePlayer } from '../src/net/sanitize';
import { verifyAuthToken } from './auth';
import { initPhysics } from '../src/sim/physicsEngine';
import { migrate } from './db/migrate';
import { persistMatch, persistDodges } from './persist';
import { routeTarget } from './routing';
import { SERVER_CHANNEL, isAlphaServer } from './channel';
import { chargeStanding, rankedLock } from './standing';
import { lockRemaining, tierOf } from '../src/standing';
import { isReportReason, REPORT_DETAIL_MAX } from '../src/report';
import { handleApi } from './api';
import { Matchmaker } from './matchmaking';
import { MATCHMAKER_REGION } from './regions';
import { BALANCE_VERSION } from '../src/config';
import { periodLabel } from '../src/seasons';
import { dbEnabled } from './db/pool';
import {
  currentSeasonNumber,
  purgeSeasonReplays,
  startNewSeason,
  takePendingMatch,
  createPendingMatch,
  cleanupStalePending,
  adminListRecords,
  deleteRecordById,
  deleteUserRecords,
  searchProfiles,
  setHandle,
  getProfile,
  getSupporter,
  grantSupporter,
  revokeSupporter,
  refundKofiPayment,
  listSupporterGrants,
  createAnnouncement,
  deleteAnnouncement,
  upsertPresence,
  globalPresence,
  globalLiveRooms,
  adminPresence,
  recentMatches,
  submitReport,
  distinctReporters,
  getStanding,
  listStandingEvents,
  standingsFor,
  listReportedUsers,
  listReportsFor,
  setReportsStatus,
  userRecentMatches,
  getMaintenance,
  setMaintenance,
  maintenanceBiting,
  type PresencePlayer,
  type PresenceAnon,
  type PresenceGuest,
  type MaintenanceWindow,
  challengeParty,
  syncStaffRoles,
  type GlobalPresence,
} from './db/repo';

/**
 * Authoritative DECODE game server (Phase 0). One WebSocket per client; rooms are
 * keyed by lowercased room code. The server imports the SHARED src/sim and runs
 * the match loop inside each Room (see room.ts). Lobby + match live on the same
 * connection, so there is no separate signaling service.
 *
 * Run: `npm run server` (tsx watch) or `npm run server:start`. Configure the
 * client with VITE_GAME_SERVER_URL=ws://localhost:8787. Deploy: see docs/deploy.md
 * (Fly.io). A plain GET /health returns 200 for the platform health check.
 */

const PORT = Number(process.env.PORT ?? 8787);
const rooms = new Map<string, Room>();

// Has this machine staged a ranked match whose row might still be sitting in
// `pending_matches`? Arms the reaper below; see the note on its interval for why
// an idle machine must not sweep on a timer.
let pendingStaged = false;
const matchmaker = new Matchmaker(
  dbEnabled
    ? {
        stage: async (m) => {
          pendingStaged = true;
          await createPendingMatch(m);
        },
      }
    : {},
);

// live presence, surfaced at GET /api/presence (polled by the client so the
// homepage/ranked screens can show who's around WITHOUT anyone holding a standing
// socket — a persistent presence connection from every visitor would keep the
// auto-stopping Fly machine awake 24/7 and defeat the idle-to-zero cost model).
// `online` = open sockets (people actually engaged with multiplayer; solo/free
// players never connect). `signedIn` = DISTINCT authenticated users (deduped by
// userId, so multiple tabs count once).
let onlineCount = 0;
const authedUsers = new Map<string, number>(); // userId -> live socket count
/** Publish this machine's presence row RIGHT NOW. Installed by the heartbeat below;
 *  a no-op until then (and in tests, which never start it). Called on the
 *  empty -> occupied edge so the first player of a quiet period is visible to the
 *  OTHER regions in milliseconds instead of on the next 5s tick. */
let beatNow: () => void = () => {};

// "one live game per user": userId -> code of the room whose MATCH they're currently
// in. Set by a room when its match begins (Room.onUserActive), cleared when their slot
// is released (finalize / grace-drop / room stop). A user with an entry here is refused
// a second join/queue elsewhere — they must rejoin or leave that game first. Reconnects
// (the `rejoin` message) bypass this, so returning to your OWN game always works.
const userRoom = new Map<string, string>();

/**
 * Every live socket on this machine, by its connection id, and whether it has
 * proven an account.
 *
 * Needed because an anonymous player who is just browsing belongs to no room and no
 * queue, so nothing else on the server knows they exist as an individual — only the
 * `onlineCount` integer does. The operator view lists guests row by row, and a row
 * needs something to BE. The id is this process's own per-socket routing id: not an
 * IP, not a fingerprint, deleted on close, and unrelated to the id the same person
 * gets if they reconnect.
 */
const liveSockets = new Map<string, { authed: boolean }>();

/**
 * MAINTENANCE LOCKDOWN, cached from the database.
 *
 * Read on a timer rather than per request: this is consulted on every join/queue,
 * and a database round trip on the hot path of starting a match would be a worse
 * problem than the one it solves. A few seconds of staleness is fine — the window
 * is announced minutes ahead, which is the entire point of scheduling it.
 *
 * Admins are exempt, deliberately: the person deploying has to be able to smoke-test
 * the thing they just shipped while everyone else is still held out.
 */
const MAINT_TTL_MS = 10_000;
let maint: MaintenanceWindow = { active: false, startsAt: null, endsAt: null, message: '' };
let maintAt = 0;
async function refreshMaintenance(force = false): Promise<MaintenanceWindow> {
  if (!dbEnabled) return maint;
  if (!force && Date.now() - maintAt < MAINT_TTL_MS) return maint;
  try {
    maint = await getMaintenance();
    maintAt = Date.now();
  } catch (e) {
    // a DB hiccup must not lock everyone out, nor silently unlock — keep the last
    // known answer and try again on the next tick
    console.error('[maintenance] read failed, keeping last known state:', e);
  }
  return maint;
}
/** is the lockdown biting for THIS caller? Admins always pass. */
function lockedOut(userId?: string | null): boolean {
  if (userId && ADMIN_IDS.has(userId)) return false;
  return maintenanceBiting(maint);
}
/** the message a locked-out client is shown */
function lockoutMessage(): string {
  const base = maint.message?.trim() || 'DSIM is down for maintenance.';
  if (!maint.endsAt) return `${base} Please try again shortly.`;
  const mins = Math.max(1, Math.round((maint.endsAt - Date.now()) / 60000));
  return `${base} Back in about ${mins} minute${mins === 1 ? '' : 's'}.`;
}
/** true if this user already has a LIVE match in a DIFFERENT room (stale entries whose
 * room has since vanished are pruned and treated as clear). */
const activeElsewhere = (userId: string, code: string): boolean => {
  const other = userRoom.get(userId);
  if (!other || other === code) return false;
  if (!rooms.has(other)) {
    userRoom.delete(userId);
    return false;
  }
  return true;
};

/**
 * "Play a friend", rated: turn the party token off the wire into a token the
 * matchmaker is allowed to trust — or refuse it.
 *
 * The token is a shared secret between two people who challenged each other, and
 * everything downstream treats entries sharing one as a pair that MUST be matched
 * together. So it cannot be taken on the client's word: without this check any two
 * clients could agree on a string and stage themselves a rated, leaderboard-moving
 * match having never been friends, never sent a challenge, and never had the other
 * person see anything. `challengeParty` resolves the token against the real
 * challenge row and only answers for an account actually named on it, which also
 * means a third client that GUESSES a live token still can't join the pair.
 *
 * Returns null for an ordinary open-queue entry (no token — the common case),
 * `'bad-token'` for one to reject, or the verified token to enqueue under.
 */
type VerifiedParty = { token: string; partyOnly: boolean } | null | 'bad-token';
async function verifyParty(
  userId: string,
  msg: Extract<ClientMsg, { t: 'queue' }>,
): Promise<VerifiedParty> {
  const token = typeof msg.party === 'string' ? msg.party.trim() : '';
  if (!token) return null;
  const format = typeof msg.partyFormat === 'string' ? msg.partyFormat : '';
  const spec = RATED_FORMATS[format];
  // the format decides the queue it belongs in, so a token issued for one must not
  // be spendable in the other
  if (!spec || spec.mode !== msg.mode) return 'bad-token';
  // no DB (local dev) ⇒ no challenges exist to verify against. Drop the party and
  // let them pair through the open queue, which on a single dev machine is the
  // same two people anyway.
  if (!dbEnabled) return null;
  const pair = await challengeParty(userId, token, format);
  if (!pair) return 'bad-token';
  return { token, partyOnly: spec.partyOnly };
}
/** a challenge is always exactly two people: the one who sent it and the one who
 * accepted. The matchmaker needs the number to know when the party is complete. */
const PARTY_SIZE = 2;

// accounts allowed to use the admin API (their auth-JWT `sub`/userId). Set as a
// Fly secret: ADMIN_USER_IDS="uuid1,uuid2". Empty => admin API is locked to nobody.
const ADMIN_LIST = (process.env.ADMIN_USER_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ADMIN_IDS = new Set(ADMIN_LIST);

/**
 * The OWNER — one account, badged apart from the admins it otherwise sits with.
 *
 * Defaults to the FIRST id in `ADMIN_USER_IDS` rather than requiring a second
 * secret, because that list has always been owner-first in practice and a feature
 * that silently does nothing until someone sets an env var they were never told
 * about is worse than a documented default. Set `OWNER_USER_ID` explicitly to
 * override it.
 *
 * Owner implies admin: the gate above is `ADMIN_IDS`, and the owner is in it.
 */
const OWNER_ID = (process.env.OWNER_USER_ID ?? '').trim() || ADMIN_LIST[0] || null;

// a pending admin notice (scheduled restart / info) broadcast to every client and
// re-sent to anyone who connects while it's still live, so late joiners see it too
let currentNotice: (ServerMsg & { t: 'serverNotice' }) | null = null;
const noticeLive = (): boolean =>
  !!currentNotice && (currentNotice.until === undefined || currentNotice.until > Date.now());

/** broadcast a message to EVERY open socket; returns how many got it */
function broadcastAll(m: ServerMsg): number {
  const payload = encodeMsg(m);
  let n = 0;
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
      n++;
    }
  }
  return n;
}

/** read a small request body (admin POSTs) with a hard cap so a bad client can't
 * exhaust memory. Rejects past 16KB — announcements are tiny. */
function readAdminBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 16 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// an explicit HTTP server so we can answer GET /health (Fly/Load-balancer probe)
// while the WebSocket upgrade rides the same port
const REGION = process.env.FLY_REGION ?? process.env.SERVER_REGION ?? '';

// ---- perf probe (GET /api/perf) ---------------------------------------------
// Sizing evidence. The question "can this machine run on a SHARED cpu?" is not
// answered by average cpu% — the room loop is a FIXED 60Hz step that must finish
// inside 16.67ms, and Fly throttles a shared machine to a small baseline once its
// burst credits drain. The symptom is then an event loop that stops turning: the
// /health probe misses its timeout and the machine flaps unhealthy (see fly.toml).
// So measure the thing that actually predicts that: EVENT LOOP DELAY, alongside
// cpu-seconds-per-second (= cores in use) and how many rooms produced that load.
// Read it repeatedly during real matches before changing any machine's cpu kind.
//
// RESOLUTION MUST STAY WELL UNDER THE 16.67ms STEP BUDGET. This was `resolution: 10`,
// which is the histogram's sampling period AND therefore its noise floor: a completely
// idle machine reported mean 10.18 / p99 11.2ms, and two machines in different regions
// on different CPU sizes returned identical numbers because the figure was measuring the
// timer, not the loop. That made the tuning rule this comment states — "p99 approaching
// 16.67ms means the loop is late" — impossible to apply: the floor was already 60% of
// the budget, so real lag and idle were indistinguishable. At 1ms an idle loop reads
// ~1ms and the number means what it claims to.
const loopDelay = monitorEventLoopDelay({ resolution: 1 });
loopDelay.enable();
/** ms epoch of the last `?reset=1` (or boot) — `max` is only meaningful relative to it */
let loopDelaySince = Date.now();
let cpuMark = process.cpuUsage();
let cpuMarkAt = process.hrtime.bigint();
/** cores in use since the previous call — sampling resets the window */
function coresInUse(): number {
  const now = process.hrtime.bigint();
  const d = process.cpuUsage(cpuMark);
  const elapsedUs = Number(now - cpuMarkAt) / 1000;
  cpuMark = process.cpuUsage();
  cpuMarkAt = now;
  if (elapsedUs <= 0) return 0;
  return (d.user + d.system) / elapsedUs;
}
// stable per-machine id for the shared presence table (unique per Fly machine)
const MACHINE = process.env.FLY_MACHINE_ID || REGION || 'local';

/**
 * GET /api/presence aggregates presence across ALL regions' machines (each machine
 * only knows its own sockets). This is the most-called endpoint on the site — every
 * open tab polls it every 8s for the online chip and every 20s for the admin-notice
 * banner — so it is throttled by a shared cache rather than run per request.
 *
 * THE ANSWER IS ALWAYS REAL. An earlier pass had an idle machine skip the query and
 * report zeros, on the theory that "no sockets here" meant "nobody anywhere". It
 * does not, and the failure was ugly: a visitor got a confident "0 online", and the
 * instant anything made that machine briefly non-idle the real count appeared and
 * then snapped back to the fake zero. A counter that flickers 0 -> 1 -> 0 reads as
 * broken, and greeting the first person through the door with "0 online" is a worse
 * outcome than any amount of compute. Never fabricate this number.
 *
 * The cost lever is the CACHE TTL instead, and the reason that is enough:
 *
 *   Someone with the page open IS a user, and keeping the database awake while a
 *   human is looking at the site is fine. What was never fine was staying awake
 *   when NOBODY was there — and that traffic came from the unconditional 5s
 *   heartbeat (now activity-gated) and from hidden background tabs (now paused in
 *   usePresence/NoticePoller). With those two gone, a site with nobody on it makes
 *   no queries at all and the compute suspends; a site with one person browsing
 *   costs about one query a minute, which is the correct thing to pay for.
 *
 * So: a long TTL when this machine is idle (one visitor's whole polling stream
 * collapses onto ~1 query/min), a short one when it is busy or when `?full=1` asks
 * for freshness — the ranked screen, where queue depth is a number people act on.
 */
const PRESENCE_TTL_BUSY_MS = 7_000;
/** Only when the world looks EMPTY and this machine is empty too. Halved from 45s
 *  once `globalPresence` became a single query — the cost of a refresh dropped, so
 *  the staleness budget could too. This is the worst-case delay before an idle
 *  machine notices the first player joining somewhere else. */
const PRESENCE_TTL_QUIET_MS = 20_000;
let presenceCache: { at: number; val: GlobalPresence } | null = null;
function machineIdle(): boolean {
  const qs = matchmaker.queueSizes();
  return onlineCount === 0 && authedUsers.size === 0 && qs['1v1'] === 0 && qs['2v2'] === 0;
}

/**
 * This machine's OWN live counts, as a FLOOR under the database's answer.
 *
 * The aggregate is assembled from rows every machine writes about itself, so between
 * a socket opening here and this machine's row landing in Postgres, the query
 * genuinely returns a total that does not include a player this process is holding a
 * socket to. Measured against production: a real client connected, and /api/presence
 * answered `online: 0` for ~8s afterwards — from the very machine serving that
 * socket. It knew, and said zero anyway.
 *
 * `max` per field, applied at RESPONSE time and never folded into the cache: the
 * cached value stays the pure database answer, so this can never outlive the socket
 * it describes. It cannot over-count either — a fresh row for this machine is already
 * in the sum, and the max is then a no-op.
 */
function withLocal(v: GlobalPresence): GlobalPresence {
  const qs = matchmaker.queueSizes();
  const byGame = matchmaker.queueSizesByGame();
  // same max-per-field rule, applied per game: this machine's own queue is already
  // in the aggregate once its beat lands, so the max is a no-op then and a floor
  // in the window before it
  const gameQueues: Record<string, { '1v1': number; '2v2': number }> = {};
  for (const g of new Set([...Object.keys(v.gameQueues ?? {}), ...Object.keys(byGame)])) {
    const a = v.gameQueues?.[g] ?? { '1v1': 0, '2v2': 0 };
    const b = byGame[g] ?? { '1v1': 0, '2v2': 0 };
    gameQueues[g] = { '1v1': Math.max(a['1v1'], b['1v1']), '2v2': Math.max(a['2v2'], b['2v2']) };
  }
  return {
    online: Math.max(v.online, onlineCount),
    signedIn: Math.max(v.signedIn, authedUsers.size),
    queues: {
      '1v1': Math.max(v.queues['1v1'], qs['1v1']),
      '2v2': Math.max(v.queues['2v2'], qs['2v2']),
    },
    gameQueues,
  };
}

/** How long the cached DB answer may be reused. The long TTL is for ONE case — a
 *  quiet machine on an apparently quiet site — because that is the only case where
 *  nobody is waiting on the number. If anyone is online ANYWHERE, the site is in use
 *  and the count is worth keeping honest. */
function presenceTtl(full: boolean): number {
  if (full || !machineIdle()) return PRESENCE_TTL_BUSY_MS;
  if (presenceCache && presenceCache.val.online > 0) return PRESENCE_TTL_BUSY_MS;
  return PRESENCE_TTL_QUIET_MS;
}

/**
 * This machine's operator snapshot: what every connected session is doing.
 *
 * Assembled entirely from state the server already holds to run matches — room
 * membership, queue membership, the socket registry. Nothing is asked of any client
 * to build it, and there is still no field for which SCREEN anybody is on: knowing
 * a player is "in Configure" moderates nothing, and collecting it would be tracking
 * for its own sake. `menu` means "connected, not in a room, not queued", the same
 * resolution a player's own friends already see.
 *
 * GUESTS ARE LISTED INDIVIDUALLY, by the server's per-socket connection id. That is
 * a deliberate change from counting them: an operator asking "is that session idle
 * or stuck in a lobby" cannot answer it from a total. The id is not an IP, not a
 * fingerprint, is written nowhere else, and dies with the socket — it distinguishes
 * two live sessions from each other and cannot connect either to a past one. The
 * privacy policy says exactly this; if this widens, that text moves with it.
 */
function operatorSnapshot(): {
  players: PresencePlayer[];
  guests: PresenceGuest[];
  anon: PresenceAnon;
} {
  const byUser = new Map<string, PresencePlayer>();
  const byGuest = new Map<string, PresenceGuest>();
  for (const [code, r] of rooms) {
    const s = r.presenceSnapshot();
    for (const p of s.players) byUser.set(p.userId, { userId: p.userId, act: p.act, room: code, game: r.gameId });
    for (const g of s.guests) byGuest.set(g.id, { id: g.id, act: g.act, room: code, game: r.gameId });
  }
  // queue membership layers ON TOP of where they are: the whole point of the
  // background queue is that you can be queued while doing something else, and an
  // operator debugging "my search never resolved" needs to see both at once.
  // `queueGame` is kept SEPARATE from `game` because they can differ — you can be
  // queued for Chain Reaction while sitting in a DECODE practice room, and an
  // operator who is shown only one of those is being told a half-truth.
  for (const q of matchmaker.queuedPlayers()) {
    const cur = byUser.get(q.userId);
    byUser.set(q.userId, {
      ...(cur ?? { userId: q.userId, act: 'menu' as const }),
      queue: q.mode,
      queuedS: q.waitedS,
      queueGame: q.game,
      game: cur?.game ?? q.game,
    });
  }
  // signed in and connected but in neither a room nor a queue
  for (const uid of authedUsers.keys()) {
    if (!byUser.has(uid)) byUser.set(uid, { userId: uid, act: 'menu' });
  }
  // stamp each account's SOCKET count so the operator tiles reconcile: sockets held
  // by accounts, plus guest rows, equals the online total exactly
  for (const [uid, p] of byUser) p.sessions = authedUsers.get(uid) ?? 1;
  // ...and the same for guests: a socket in the registry that is not authed and not
  // in any room is somebody sitting in the menus, which is a row, not a rounding
  // error. This is the only place idle guests are visible at all.
  for (const [sid, sock] of liveSockets) {
    if (sock.authed || byGuest.has(sid)) continue;
    byGuest.set(sid, { id: sid, act: 'menu' });
  }
  const guests = [...byGuest.values()];
  return {
    players: [...byUser.values()],
    guests,
    // the summary tiles are DERIVED from the rows, so a count can never disagree
    // with the list printed under it
    anon: {
      total: guests.length,
      inMatch: guests.filter((g) => g.act === 'match').length,
      inLobby: guests.filter((g) => g.act === 'lobby').length,
      idle: guests.filter((g) => g.act === 'menu').length,
    },
  };
}

async function aggregatePresence(full = false): Promise<GlobalPresence> {
  const now = Date.now();
  if (presenceCache && now - presenceCache.at < presenceTtl(full)) return withLocal(presenceCache.val);
  const val = await globalPresence();
  presenceCache = { at: now, val };
  return withLocal(val);
}

/**
 * Cross-region live rooms, cached.
 *
 * `/api/live` is polled every 4s by everyone sitting on the Watch screen and used
 * to cost zero database. One shared 3s cache keeps that nearly true: N watchers
 * cost one query per 3s instead of one each, which matters on a compute that bills
 * for being awake.
 */
const LIVE_TTL_MS = 3_000;
let liveCache: { at: number; val: unknown[] } | null = null;
async function aggregateLive(): Promise<unknown[]> {
  const now = Date.now();
  if (liveCache && now - liveCache.at < LIVE_TTL_MS) return liveCache.val;
  const val = await globalLiveRooms();
  liveCache = { at: now, val };
  return val;
}

/** every match running on THIS machine, unfiltered (see `Room.summary`) */
function localLive(): LiveRoom[] {
  return [...rooms.values()].map((r) => r.summary()).filter((s): s is LiveRoom => s !== null);
}

/**
 * May a stranger see this room in "Watch Live"? Everything EXCEPT custom rooms.
 *
 * A custom room is somebody's private game: it is reached by a code they chose to
 * hand out, and listing it publicly would hand that code to everyone. Friends
 * still spectate it (their friends list carries the code — see `liveRoomsByUser`),
 * anyone given the code can still type it in, and admins still see it.
 *
 * Ranked matches and record runs are both public: a ranked match is a rated game
 * nobody chose the opponent for, and a record run is a leaderboard attempt whose
 * score is published the moment it ends. Neither is reached by a shared secret.
 * A record room reports `ranked: false`, so kind has to be checked first or the
 * two would be filtered by the same test and record runs would vanish.
 */
function isPublicLive(r: unknown): boolean {
  const room = r as Partial<LiveRoom>;
  if (room?.kind === 'record') return true;
  return room?.ranked === true;
}

/** local rooms unioned with every other region's, newest information winning.
 *  Shared by `/api/live` and the admin view so the two can't disagree. */
function unionLive(local: LiveRoom[], global: unknown[]): unknown[] {
  const seen = new Set(local.map((r) => r.room));
  return [...local, ...global.filter((r) => !seen.has((r as { room: string }).room))];
}

const httpServer = createServer((req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/health')) {
    // `?region=<code>` lets the client ping a SPECIFIC region (the picker) or read
    // its home region: on Fly we fly-replay the GET to that region's machine, which
    // answers with its own x-region. Locally (REGION='') we just answer here.
    const want = new URL(req.url, 'http://x').searchParams.get('region');
    const already = !!req.headers['fly-replay-src'];
    if (REGION && want && want !== REGION && !already) {
      res.writeHead(200, {
        'fly-replay': `region=${want}`,
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }
    // CORS so the web client (different origin) can time this for the pre-connect
    // ping picker. Includes the region so a client can confirm which one answered.
    // `expose-headers` is REQUIRED for that: a cross-origin fetch can only read
    // CORS-safelisted response headers, so without it `res.headers.get('x-region')`
    // is null in the browser (curl sees the header fine — CORS is browser-side only).
    // That silently broke every home-region read: the matchmaker got homeRegion ''
    // and scored every region as the unknown-pair penalty.
    res.writeHead(200, {
      'content-type': 'text/plain',
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'x-region',
      'cache-control': 'no-store',
      ...(REGION ? { 'x-region': REGION } : {}),
    });
    res.end('ok');
    return;
  }
  // ADMIN API — gated by ADMIN_USER_IDS (your account's UUID, via the signed-in
  // JWT); the ADMIN_SECRET query still works for curl. CORS'd for the web app.
  //   GET  /api/admin/status                          -> { isAdmin, userId }
  //   POST /api/admin/announce?seconds=300&msg=…       schedule a restart notice
  //   POST /api/admin/announce?cancel=1                clear a pending notice
  if (req.url?.startsWith('/api/admin/')) {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const u = new URL(req.url, 'http://x');
    void (async () => {
      const auth = req.headers['authorization'];
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
      const user = await verifyAuthToken(token);
      const isAdmin = !!user && ADMIN_IDS.has(user.userId);

      if (req.method === 'GET' && u.pathname === '/api/admin/status') {
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ isAdmin, userId: user?.userId ?? null }));
        return;
      }
      /**
       * GET /api/admin/presence — the operator view of who is on the service.
       *
       * WHAT THIS SHOWS AND DELIBERATELY DOES NOT:
       *  - SIGNED-IN accounts: handle, coarse activity (menu/lobby/match), the room
       *    they are in, and their ranked-queue bucket + wait. Every field is either
       *    already public (`/api/live` lists live rooms WITH player names) or
       *    already shown to that player's own friends. Nothing new is collected
       *    from anyone to build this.
       *  - ANONYMOUS sessions: COUNTS ONLY, bucketed by activity. No identifier, no
       *    row, no history. A guest cannot be warned, banned or contacted, so
       *    identifying one enables no moderation action — it would be surveillance
       *    with no remedy attached to it.
       *  - NOBODY: which menu or screen they are on, their inputs, or any timeline.
       *    The table underneath is a ~5s snapshot that overwrites itself, so this
       *    cannot answer "what was X doing an hour ago" even in principle.
       */
      if (req.method === 'GET' && u.pathname === '/api/admin/presence') {
        if (!isAdmin) {
          res.writeHead(403, cors);
          res.end('forbidden');
          return;
        }
        const machines = dbEnabled ? await adminPresence() : [];
        const local = operatorSnapshot();
        // EVERY region and EVERY kind. The operator list used to be this machine's
        // rooms only, which on a multi-region deploy meant "Live matches" answered
        // with whatever happened to be hosted next to the admin — the same bug
        // `/api/live` had. Custom and record rooms are kept here (they are filtered
        // out of the PUBLIC list, not out of the room summary), so "spectate any
        // game" means any game.
        const liveRooms = dbEnabled
          ? unionLive(localLive(), await aggregateLive().catch(() => []))
          : localLive();
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            region: REGION,
            machines,
            // this machine's own numbers too, so a single-region/dev deploy — and
            // the gap between a socket opening and the next beat — still reads true
            local: { machine: MACHINE, region: REGION, online: onlineCount, ...local },
            rooms: liveRooms,
            queues: matchmaker.queueSizes(),
          }),
        );
        return;
      }
      /**
       * GET /api/admin/matches — the most recently FINISHED games, service-wide.
       *
       * The past half of "show me every game": the live list covers what is running
       * now, and this covers what just ran. A finished match cannot be spectated, so
       * each row carries its `replayId` and the panel opens the replay instead.
       *
       * This is a records read, not a surveillance one: every row is a match result
       * that already appears in its own players' public match history. It is here
       * because that history is per-account and an operator does not know the
       * account yet — which is the whole reason for the page.
       */
      if (req.method === 'GET' && u.pathname === '/api/admin/matches') {
        if (!isAdmin) {
          res.writeHead(403, cors);
          res.end('forbidden');
          return;
        }
        if (!dbEnabled) {
          res.writeHead(200, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ matches: [] }));
          return;
        }
        const gq = u.searchParams.get('game');
        const rows = await recentMatches(
          Number(u.searchParams.get('limit')) || 40,
          gq === 'chain' || gq === 'decode' ? gq : undefined,
        );
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ matches: rows }));
        return;
      }
      /**
       * MODERATION — the report queue, one player's reports, and their matches.
       *
       *   GET  /api/admin/reports                  the queue (one row per reported player)
       *   GET  /api/admin/reports?user=<id>        that player's reports + recent matches
       *   POST /api/admin/reports?user=<id>&status=reviewed|dismissed
       *
       * The per-user GET returns the MATCHES alongside the reports deliberately. A report
       * for cheating or throwing cannot be judged from its text — the moderator has to
       * watch the match — and a queue that makes them go and find the replay somewhere else
       * is a queue that stops being worked. One request, everything needed to make a call.
       */
      if (u.pathname === '/api/admin/reports') {
        if (!isAdmin) {
          res.writeHead(403, cors);
          res.end('forbidden');
          return;
        }
        if (!dbEnabled) {
          res.writeHead(200, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ users: [], reports: [], matches: [] }));
          return;
        }
        // `target` — NOT `user`, which is the verified ADMIN in this scope. Shadowing it
        // silently made the moderator id resolve to the reported player's.
        const target = u.searchParams.get('user');
        if (req.method === 'POST') {
          const status = u.searchParams.get('status');
          if (!target || (status !== 'reviewed' && status !== 'dismissed')) {
            res.writeHead(400, cors);
            res.end('bad request');
            return;
          }
          const n = await setReportsStatus(target, status, user?.userId ?? 'admin');
          // UPHELD is the only event in the standing system a human has actually verified,
          // so it is the only one big enough to move a player two tiers — and unlike the raw
          // reports it replaces, it restricts. DISMISSED deliberately does nothing: the raw
          // nudges those reports already applied heal off on their own, and reversing them
          // would need a per-report ledger to undo exactly, which is a lot of machinery for
          // a few points that expire anyway.
          if (status === 'reviewed' && n > 0) {
            void chargeStanding(target, 'reportUpheld', {}).catch((e) =>
              console.error('[standing] upheld charge failed:', e),
            );
          }
          res.writeHead(200, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, updated: n }));
          return;
        }
        if (target) {
          const [reports, matches, standings, events] = await Promise.all([
            listReportsFor(target),
            userRecentMatches(target),
            standingsFor([target]),
            listStandingEvents(target, 20),
          ]);
          res.writeHead(200, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ reports, matches, standing: standings[target] ?? null, standingEvents: events }));
          return;
        }
        // The QUEUE carries each player's standing alongside the report counts. It is the
        // corroborating half of a report: a name with twelve reports and a full standing is
        // a very different case from one the SERVER has independently watched leave three
        // matches, and a moderator should not have to open a row to tell them apart.
        const users = await listReportedUsers();
        const standings = await standingsFor(users.map((u) => u.userId));
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({
          users: users.map((u) => ({ ...u, standing: standings[u.userId]?.score ?? null })),
        }));
        return;
      }
      /**
       * GET/POST /api/admin/maintenance — the lockdown window.
       *
       * POST body (query params): active=1|0, startsAt/endsAt (ms epoch, blank for
       * "now"/"open-ended"), msg. Setting a FUTURE start is the normal path: it
       * announces the window to everyone without locking anyone out yet, which is
       * the difference between scheduled maintenance and an outage.
       */
      if (u.pathname === '/api/admin/maintenance') {
        if (!isAdmin) {
          res.writeHead(403, cors);
          res.end('forbidden');
          return;
        }
        if (!dbEnabled) {
          res.writeHead(200, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'no database — maintenance needs one to be shared across regions' }));
          return;
        }
        if (req.method === 'POST') {
          const num = (k: string): number | null => {
            const v = u.searchParams.get(k);
            if (!v) return null;
            const n = Number(v);
            return Number.isFinite(n) && n > 0 ? n : null;
          };
          const next = await setMaintenance({
            active: u.searchParams.get('active') === '1',
            startsAt: num('startsAt'),
            endsAt: num('endsAt'),
            message: (u.searchParams.get('msg') ?? '').slice(0, 200),
          });
          await refreshMaintenance(true); // this machine stops/starts enforcing NOW
          res.writeHead(200, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, maintenance: next }));
          return;
        }
        const cur = await getMaintenance();
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, maintenance: cur, biting: maintenanceBiting(cur) }));
        return;
      }
      if (req.method === 'POST' && u.pathname === '/api/admin/announce') {
        const secretOk =
          !!process.env.ADMIN_SECRET && u.searchParams.get('secret') === process.env.ADMIN_SECRET;
        if (!isAdmin && !secretOk) {
          res.writeHead(403, cors);
          res.end('forbidden');
          return;
        }
        if (u.searchParams.get('cancel')) {
          currentNotice = { t: 'serverNotice', kind: 'info', message: '' }; // empty => clear on client
          const n = broadcastAll(currentNotice);
          currentNotice = null;
          res.writeHead(200, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, cancelled: true, notified: n }));
          return;
        }
        const seconds = Math.max(0, Number(u.searchParams.get('seconds') ?? 300));
        const message = u.searchParams.get('msg') || 'Server restarting for an update';
        currentNotice = { t: 'serverNotice', kind: 'restart', message, until: Date.now() + seconds * 1000 };
        const notified = broadcastAll(currentNotice);
        console.log(`[admin] restart notice in ${seconds}s -> ${notified} clients: "${message}"`);
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, notified, until: currentNotice.until }));
        return;
      }
      // SEASONS: archive the live boards and open a fresh season, or purge the
      // replays of an archived season (frees storage; boards stay, watchability
      // drops). Both are admin-gated (JWT admin id OR the ADMIN_SECRET query).
      if (
        req.method === 'POST' &&
        (u.pathname === '/api/admin/season/start' || u.pathname === '/api/admin/season/purge-replays')
      ) {
        const secretOk =
          !!process.env.ADMIN_SECRET && u.searchParams.get('secret') === process.env.ADMIN_SECRET;
        if (!isAdmin && !secretOk) {
          res.writeHead(403, cors);
          res.end('forbidden');
          return;
        }
        if (!dbEnabled) {
          res.writeHead(503, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'DB disabled' }));
          return;
        }
        // which game's period to advance — DECODE and Chain Reaction run independent
        // Act → Season progressions (default DECODE).
        const adminGame = u.searchParams.get('game') === 'chain' ? 'chain' : 'decode';
        if (u.pathname === '/api/admin/season/start') {
          const name = u.searchParams.get('name') ?? undefined;
          // `act=new` opens a fresh ACT (act++, season resets to 1); otherwise a
          // new season in the current act.
          const bumpAct = u.searchParams.get('act') === 'new';
          const { season, act, seasonNo } = await startNewSeason(BALANCE_VERSION, name, bumpAct, adminGame);
          const label = periodLabel({ name, act, seasonNo });
          console.log(
            `[admin] started new ${bumpAct ? 'act' : 'season'}: bv=${season} (${label})`,
          );
          // auto-publish a cinematic announcement (editable/retire-able from the
          // admin console). `announce=0` opts out for a silent roll.
          if (u.searchParams.get('announce') !== '0') {
            await createAnnouncement({
              kind: bumpAct ? 'act' : 'season',
              title: label,
              tagline: bumpAct ? 'A NEW ACT BEGINS' : 'A NEW SEASON BEGINS',
              body: 'Fresh leaderboards and ranked ratings are live. Set a new record and climb from the top.',
            }).catch((e) => console.error('[admin] announcement failed:', e));
          }
          res.writeHead(200, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, season, act, seasonNo }));
          return;
        }
        // purge-replays: default to every season BEFORE the live one when unspecified
        const seasonArg = u.searchParams.get('season');
        const current = await currentSeasonNumber(BALANCE_VERSION, adminGame);
        let freed = 0;
        if (seasonArg !== null) {
          const s = Number(seasonArg);
          if (s >= current) {
            res.writeHead(400, { ...cors, 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'refusing to purge the live season' }));
            return;
          }
          freed = await purgeSeasonReplays(s, adminGame);
        } else {
          for (let s = 1; s < current; s++) freed += await purgeSeasonReplays(s, adminGame);
        }
        console.log(`[admin] purged ${freed} archived-season replays`);
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, freed }));
        return;
      }

      // MODERATION — inspect/delete leaderboard records + rename inappropriate
      // display names. Same admin gate as above (JWT admin id OR ADMIN_SECRET);
      // every action is re-authorized here on the server, never trusting the UI.
      if (
        u.pathname === '/api/admin/records' ||
        u.pathname === '/api/admin/record/delete' ||
        u.pathname === '/api/admin/user/records/clear' ||
        u.pathname === '/api/admin/users' ||
        u.pathname === '/api/admin/user/rename' ||
        u.pathname === '/api/admin/supporter/grant' ||
        u.pathname === '/api/admin/supporter/revoke' ||
        u.pathname === '/api/admin/supporter/history' ||
        u.pathname === '/api/admin/supporter/refund'
      ) {
        const secretOk =
          !!process.env.ADMIN_SECRET && u.searchParams.get('secret') === process.env.ADMIN_SECRET;
        if (!isAdmin && !secretOk) {
          res.writeHead(403, cors);
          res.end('forbidden');
          return;
        }
        if (!dbEnabled) {
          res.writeHead(503, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'DB disabled' }));
          return;
        }
        const jsonOut = (code: number, body: unknown): void => {
          res.writeHead(code, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };

        // GET /api/admin/records?mode=&drivetrain=&limit= — moderation board view
        if (req.method === 'GET' && u.pathname === '/api/admin/records') {
          const mode = u.searchParams.get('mode') === 'duo' ? 'duo' : 'solo';
          const drivetrain = u.searchParams.get('drivetrain') ?? 'overall';
          const limit = Math.min(500, Math.max(1, Number(u.searchParams.get('limit') ?? 100)));
          const adminRecGame = u.searchParams.get('game') === 'chain' ? 'chain' : 'decode';
          const season = await currentSeasonNumber(BALANCE_VERSION, adminRecGame);
          const rows = await adminListRecords({ mode, drivetrain, balanceVersion: season, limit, game: adminRecGame });
          jsonOut(200, { season, mode, drivetrain, rows, game: adminRecGame });
          return;
        }
        // POST /api/admin/record/delete?id= — remove one run (+ its replay)
        if (req.method === 'POST' && u.pathname === '/api/admin/record/delete') {
          const id = u.searchParams.get('id') ?? '';
          if (!id) {
            jsonOut(400, { ok: false, error: 'missing id' });
            return;
          }
          const deleted = await deleteRecordById(id);
          console.log(`[admin] delete record ${id} -> ${deleted}`);
          jsonOut(deleted ? 200 : 404, { ok: deleted });
          return;
        }
        // POST /api/admin/user/records/clear?userId= — nuke a cheater's runs
        if (req.method === 'POST' && u.pathname === '/api/admin/user/records/clear') {
          const uid = u.searchParams.get('userId') ?? '';
          if (!uid) {
            jsonOut(400, { ok: false, error: 'missing userId' });
            return;
          }
          const removed = await deleteUserRecords(uid);
          console.log(`[admin] cleared ${removed} records for user ${uid}`);
          jsonOut(200, { ok: true, removed });
          return;
        }
        // GET /api/admin/users?q= — find profiles to rename/moderate
        if (req.method === 'GET' && u.pathname === '/api/admin/users') {
          const query = (u.searchParams.get('q') ?? '').trim();
          const users = query ? await searchProfiles(query) : [];
          jsonOut(200, { users });
          return;
        }
        // POST /api/admin/user/rename?userId=&handle= — force a clean display name
        if (req.method === 'POST' && u.pathname === '/api/admin/user/rename') {
          const uid = u.searchParams.get('userId') ?? '';
          const handle = (u.searchParams.get('handle') ?? '').trim();
          if (!uid) {
            jsonOut(400, { ok: false, error: 'missing userId' });
            return;
          }
          if (handle.length < 2 || handle.length > 24) {
            jsonOut(400, { ok: false, error: 'name must be 2–24 characters' });
            return;
          }
          const profile = await getProfile(uid);
          if (!profile) {
            jsonOut(404, { ok: false, error: 'no such user' });
            return;
          }
          await setHandle(uid, handle);
          console.log(`[admin] renamed ${uid}: "${profile.handle}" -> "${handle}"`);
          jsonOut(200, { ok: true, userId: uid, handle });
          return;
        }

        // SUPPORTER MEMBERSHIPS. Ko-fi grants arrive by webhook, but two cases
        // will always need a human: comping someone (a contributor, a botched
        // payment, a currency Ko-fi settled oddly) and taking a membership back
        // after a chargeback. Without these the only remedies were a psql session
        // or nothing, which is not a remedy.
        //
        // Every change is written to `supporter_grants` with the acting admin's
        // id, so a membership can always be traced to who gave it and why.

        // POST /api/admin/supporter/grant?userId=&months=&note= — comp a membership
        if (req.method === 'POST' && u.pathname === '/api/admin/supporter/grant') {
          const uid = u.searchParams.get('userId') ?? '';
          const months = Math.floor(Number(u.searchParams.get('months') ?? 1));
          if (!uid) {
            jsonOut(400, { ok: false, error: 'missing userId' });
            return;
          }
          if (!Number.isFinite(months) || months < 1 || months > 60) {
            jsonOut(400, { ok: false, error: 'months must be 1–60' });
            return;
          }
          if (!(await getProfile(uid))) {
            jsonOut(404, { ok: false, error: 'no such user' });
            return;
          }
          const note = (u.searchParams.get('note') ?? '').slice(0, 200);
          const until = await grantSupporter(
            uid,
            months,
            'admin',
            `by ${user?.userId ?? 'secret'}${note ? `: ${note}` : ''}`,
          );
          console.log(`[admin] supporter +${months}mo for ${uid} -> ${until}`);
          jsonOut(200, { ok: true, userId: uid, until });
          return;
        }

        // POST /api/admin/supporter/revoke?userId=&note= — chargeback / mistake
        if (req.method === 'POST' && u.pathname === '/api/admin/supporter/revoke') {
          const uid = u.searchParams.get('userId') ?? '';
          if (!uid) {
            jsonOut(400, { ok: false, error: 'missing userId' });
            return;
          }
          const note = (u.searchParams.get('note') ?? '').slice(0, 200);
          const revoked = await revokeSupporter(
            uid,
            `by ${user?.userId ?? 'secret'}${note ? `: ${note}` : ''}`,
          );
          console.log(`[admin] supporter revoked for ${uid} -> ${revoked}`);
          jsonOut(200, { ok: true, userId: uid, revoked });
          return;
        }

        // POST /api/admin/supporter/refund?txn= — flag a payment as charged back.
        // Separate from revoke on purpose: the entitlement may cover other
        // payments too, so ending it is a second, deliberate decision.
        if (req.method === 'POST' && u.pathname === '/api/admin/supporter/refund') {
          const txn = (u.searchParams.get('txn') ?? '').trim();
          if (!txn) {
            jsonOut(400, { ok: false, error: 'missing txn' });
            return;
          }
          const flagged = await refundKofiPayment(txn);
          console.log(`[admin] payment ${txn} flagged refunded -> ${flagged}`);
          jsonOut(flagged ? 200 : 404, { ok: flagged });
          return;
        }

        // GET /api/admin/supporter/history?userId= — why does this account have one?
        if (req.method === 'GET' && u.pathname === '/api/admin/supporter/history') {
          const uid = u.searchParams.get('userId') ?? '';
          if (!uid) {
            jsonOut(400, { ok: false, error: 'missing userId' });
            return;
          }
          jsonOut(200, { grants: await listSupporterGrants(uid) });
          return;
        }
        jsonOut(404, { ok: false, error: 'unknown admin route' });
        return;
      }

      // ANNOUNCEMENTS — publish patch notes / new-season / new-act reveals, or
      // retire an existing one. Same admin gate (JWT admin id OR ADMIN_SECRET);
      // reads go through the PUBLIC GET /api/announcements (active feed).
      if (u.pathname === '/api/admin/announcement' || u.pathname === '/api/admin/announcement/delete') {
        const secretOk =
          !!process.env.ADMIN_SECRET && u.searchParams.get('secret') === process.env.ADMIN_SECRET;
        if (!isAdmin && !secretOk) {
          res.writeHead(403, cors);
          res.end('forbidden');
          return;
        }
        if (!dbEnabled) {
          res.writeHead(503, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'DB disabled' }));
          return;
        }
        const jsonOut = (code: number, body: unknown): void => {
          res.writeHead(code, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (req.method === 'POST' && u.pathname === '/api/admin/announcement/delete') {
          const id = u.searchParams.get('id') ?? '';
          if (!id) {
            jsonOut(400, { ok: false, error: 'missing id' });
            return;
          }
          const deleted = await deleteAnnouncement(id);
          console.log(`[admin] retire announcement ${id} -> ${deleted}`);
          jsonOut(deleted ? 200 : 404, { ok: deleted });
          return;
        }
        // POST /api/admin/announcement — publish. Body: {kind,title,body,tagline}
        if (req.method === 'POST' && u.pathname === '/api/admin/announcement') {
          let payload: { kind?: string; title?: string; body?: string; tagline?: string };
          try {
            payload = JSON.parse(await readAdminBody(req));
          } catch {
            jsonOut(400, { ok: false, error: 'bad request' });
            return;
          }
          const title = (payload.title ?? '').trim();
          if (title.length < 2 || title.length > 80) {
            jsonOut(400, { ok: false, error: 'title must be 2–80 characters' });
            return;
          }
          const body = (payload.body ?? '').slice(0, 8000); // long-form Markdown patch notes
          const tagline = (payload.tagline ?? '').trim().slice(0, 80) || null;
          const row = await createAnnouncement({ kind: payload.kind ?? 'patch', title, body, tagline });
          console.log(`[admin] published ${row.kind} announcement "${row.title}"`);
          // a live-info banner nudges connected players to look — the feed itself
          // shows on their NEXT load (localStorage "seen" gate), but this makes it
          // feel immediate for anyone already online.
          jsonOut(200, { ok: true, announcement: row });
          return;
        }
        jsonOut(404, { ok: false, error: 'unknown admin route' });
        return;
      }
      res.writeHead(404, cors);
      res.end();
    })().catch((e) => {
      console.error('[admin] handler error:', e);
      if (!res.headersSent) res.writeHead(500, cors);
      res.end();
    });
    return;
  }
  /**
   * LOOK UP ONE ROOM BY CODE — `GET /api/room?code=XXXXXX`.
   *
   * Answers "is this match live, and WHICH REGION is hosting it". Spectating needs
   * both: a custom room's code is a bare 6 characters with no region prefix, so a
   * spectate socket opened without a region lands on whichever machine anycast is
   * nearest and finds no such room. Ranked codes ARE region-coded and route
   * themselves, but they come through here identically so there is one path.
   *
   * NOT a directory: it answers about a code you already hold, and holding the code
   * is what lets you join the room in the first place — so this discloses nothing
   * that typing the code into the join box did not already. Custom rooms are absent
   * from the public `/api/live` list precisely so they can only be reached this way.
   */
  if (req.method === 'GET' && req.url?.startsWith('/api/room')) {
    const code = (new URL(req.url, 'http://x').searchParams.get('code') ?? '').toLowerCase();
    const send = (room: LiveRoom | null): void => {
      res.writeHead(room ? 200 : 404, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify(room ? { room } : { error: 'no such live match' }));
    };
    const find = (list: unknown[]): LiveRoom | null =>
      (list as LiveRoom[]).find((r) => r.room.toLowerCase() === code) ?? null;
    if (!code) {
      send(null);
      return;
    }
    const local = find(localLive());
    if (local || !dbEnabled) {
      send(local);
      return;
    }
    aggregateLive().then(
      (all) => send(find(all)),
      (e) => {
        console.error('[live] room lookup failed:', e);
        send(null);
      },
    );
    return;
  }
  // live presence (served here, not in api.ts, because the counts live on this
  // process: the socket registry + the in-memory matchmaker queues)
  // "Watch Live": every currently-running RANKED match ACROSS EVERY REGION. Each
  // entry's `room` code is spectated via the WS `spectate` message.
  if (req.method === 'GET' && req.url?.startsWith('/api/live')) {
    const local = localLive();
    const send = (list: unknown[]): void => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify({ region: REGION, rooms: list.filter(isPublicLive) }));
    };
    // EVERY region, not just this one. Anycast lands each caller on their nearest
    // machine, and a machine only knows its OWN rooms — so this answered with
    // whatever happened to be running in the caller's region and silently omitted
    // the rest of the service. Matches are hosted wherever the matchmaker judged
    // fairest, which is frequently not where a given spectator is, so "no live
    // matches right now" was routinely just wrong. Rooms ride the presence
    // heartbeat (0021); this machine's own list is unioned in on top so a room
    // started since the last beat is never missing from its own region's answer.
    if (dbEnabled) {
      aggregateLive().then(
        (all) => send(unionLive(local, all)),
        (e) => {
          console.error('[live] aggregate failed, using local:', e);
          send(local);
        },
      );
    } else {
      send(local);
    }
    return;
  }
  // machine-sizing evidence for THIS machine (see the perf probe above). Public and
  // read-only: counts and timings, no player or account data. `?reset=1` zeroes the
  // lag histogram so a sample can be scoped to one match instead of since boot.
  if (req.method === 'GET' && req.url?.startsWith('/api/perf')) {
    const live = localLive();
    const ms = (n: number): number => Math.round((n / 1e6) * 100) / 100; // ns → ms
    const heap = v8.getHeapStatistics();
    const mb = (n: number): number => Math.round(n / 1048576);
    const body = {
      region: REGION,
      machine: MACHINE,
      uptimeS: Math.round(process.uptime()),
      cores: Math.round(coresInUse() * 1000) / 1000,
      rooms: live.length,
      players: onlineCount,
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      // HEAP, not just RSS. RSS alone cannot distinguish "V8 is holding freed pages it
      // hasn't returned to the OS" (harmless) from "the live set is near the heap cap"
      // (pathological: every allocation triggers a full GC, and those pauses ARE the
      // stutter players report). `usedMb` against `limitMb` is the ratio that tells them
      // apart — a long-lived machine sitting at a high fraction of the limit while idle
      // is the one to restart or profile.
      heapMb: {
        used: mb(heap.used_heap_size),
        total: mb(heap.total_heap_size),
        limit: mb(heap.heap_size_limit),
      },
      // the decisive numbers: a p99 approaching the 16.67ms step budget means the
      // loop is already late, and a max past the /health timeout means a flap.
      // `windowS` is how long these have been accumulating: without it `max` is a
      // since-BOOT figure, so a week-old machine reports the one-off JIT/WASM stall
      // from its own startup forever and every reading looks alarming. Sample with
      // `?reset=1` to start a fresh window, then read it again during a real match —
      // that pair is the only way to attribute a stall to current load.
      windowS: Math.round((Date.now() - loopDelaySince) / 1000),
      loopLagMs: {
        mean: ms(loopDelay.mean),
        p50: ms(loopDelay.percentile(50)),
        p99: ms(loopDelay.percentile(99)),
        max: ms(loopDelay.max),
      },
    };
    if (new URL(req.url, 'http://x').searchParams.get('reset')) {
      loopDelay.reset();
      loopDelaySince = Date.now();
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify(body));
    return;
  }
  /**
   * YOUR OWN ACCOUNT STANDING, with the ledger behind it.
   *
   * Authed and self-only: the standing endpoint answers for the account on the token and
   * takes no user parameter at all, so it cannot be turned into a lookup for whether some
   * other player has been penalised. Moderators see other people's standing through the
   * admin reports API, which is separately gated.
   *
   * The EVENTS come with it, unasked. A number that dropped with no explanation attached is
   * the thing that makes a penalty system feel arbitrary, and the player should not have to
   * ask a human what happened to them.
   */
  if (req.method === 'GET' && new URL(req.url ?? '/', 'http://x').pathname === '/api/standing') {
    const head = { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
    const auth = req.headers['authorization'];
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
    void (async () => {
      const user = await verifyAuthToken(token).catch(() => null);
      if (!user || !dbEnabled) {
        res.writeHead(200, head);
        res.end(JSON.stringify({ standing: null }));
        return;
      }
      try {
        const s = await getStanding(user.userId);
        const events = await listStandingEvents(user.userId, 20);
        res.writeHead(200, head);
        res.end(JSON.stringify({ standing: { score: s.score, restrictedUntil: s.restrictedUntil }, events }));
      } catch (e) {
        console.error('[standing] read failed:', e);
        res.writeHead(200, head);
        res.end(JSON.stringify({ standing: null }));
      }
    })();
    return;
  }
  if (req.method === 'GET' && new URL(req.url ?? '/', 'http://x').pathname === '/api/presence') {
    // `?full=1` opts out of the idle short-circuit in `aggregatePresence` — the
    // ranked screen asks for it because its queue depth is a number people act on.
    const wantFull = new URL(req.url ?? '/', 'http://x').searchParams.get('full') === '1';
    void refreshMaintenance(); // keep the cached window fresh off this same poll
    // include any LIVE admin notice so the client can show the restart banner
    // (and block starting new games) on EVERY page — even disconnected ones
    // like Home/solo where no WebSocket delivers `serverNotice`.
    const notice =
      noticeLive() && currentNotice
        ? { kind: currentNotice.kind, message: currentNotice.message, until: currentNotice.until }
        : null;
    const respond = (
      online: number,
      signedIn: number,
      queues: Record<string, number>,
      gameQueues: Record<string, Record<string, number>>,
    ): void => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      // `caps` tells a NEW client what this (possibly older) deploy can honour —
      // see SERVER_CAPS. One app serves every client build, so a feature that
      // would misbehave rather than degrade has to be gated on the answer.
      //
      // `queues` (all games combined) STAYS for older clients that only know that
      // shape. `gameQueues` is the one a player can act on: pairing is bucketed by
      // game, so a combined count advertises a pool the reader cannot match from.
      // the maintenance window rides the presence poll every page already makes, so
      // the banner reaches disconnected screens (Home, solo) too — the same reason
      // `notice` is here rather than only on the WebSocket.
      const m = maint.active
        ? { startsAt: maint.startsAt, endsAt: maint.endsAt, message: maint.message, biting: maintenanceBiting(maint) }
        : null;
      res.end(JSON.stringify({ region: REGION, online, signedIn, queues, gameQueues, notice, maintenance: m, caps: SERVER_CAPS }));
    };
    // GLOBAL count: aggregate every region's heartbeat (this machine only sees its
    // own sockets — anycast routing means the caller often lands on an empty region).
    // Fall back to this machine's local numbers if the DB read fails.
    if (dbEnabled) {
      aggregatePresence(wantFull).then(
        (g) => respond(g.online, g.signedIn, g.queues, g.gameQueues ?? {}),
        (e) => {
          console.error('[presence] aggregate failed, using local:', e);
          respond(onlineCount, authedUsers.size, matchmaker.queueSizes(), matchmaker.queueSizesByGame());
        },
      );
    } else {
      respond(onlineCount, authedUsers.size, matchmaker.queueSizes(), matchmaker.queueSizesByGame());
    }
    return;
  }
  // public leaderboard / replay read API (GET /api/*)
  if (req.url?.startsWith('/api/')) {
    handleApi(req, res).catch((e) => {
      console.error('[api] handler crash:', e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    return;
  }
  res.writeHead(426, { 'content-type': 'text/plain' });
  res.end('WebSocket only');
});
// LOW-LATENCY SOCKETS. Disable Nagle's algorithm on every connection: the room
// loop streams a ~20 Hz burst of SMALL delta frames, and Nagle batches small
// writes (waiting on the peer's ACK) — which, against TCP delayed-ACK, injects
// 40–200 ms stalls. That is exactly the symptom seen here: a healthy p50 (~40 ms)
// but a p95/p99 tail of 400–570 ms (periodic spikes / rubberbanding), and the
// classic Fly.io 60 Hz-game report. Nagle is PER-SOCKET (no OS/Dockerfile toggle
// works), so we set TCP_NODELAY on each socket in-process. Covers WS upgrades and
// the small HTTP (health/API) responses too.
httpServer.on('connection', (socket) => socket.setNoDelay(true));

// perMessageDeflate off: compression buffers/among-frames context adds latency +
// memory for our tiny JSON frames and buys little on already-delta'd snapshots.
// noServer: we intercept the upgrade ourselves (below) to do region routing.
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

// WS-level liveness. A half-open TCP connection (laptop lid closed, wifi dropped,
// a tab hard-killed) does NOT fire 'close' until the OS keepalive eventually times
// out — minutes to hours. Until then the socket is a GHOST: it stays in the ranked
// QUEUE (so the bucket reads e.g. "4/4" and a match is staged against a player who
// will never reconnect) and holds its ROOM slot. A periodic ping/pong reaps them:
// any socket that missed the previous ping is terminated, which fires 'close' and
// runs the normal teardown (matchmaker.remove + room.detach). See the heartbeat
// interval at the bottom of this file.
const socketAlive = new WeakMap<WebSocket, boolean>();

// ---- region routing (fly-replay) --------------------------------------------
// One Fly app, one machine per region. A WebSocket upgrade carries a routing hint
// in its query string; if it belongs to a DIFFERENT region we answer the upgrade
// with a `fly-replay` header instead of accepting it, and Fly's proxy replays the
// whole upgrade to the target region's machine (which then holds the connection).
// Hints:  ?mm=1 → the designated matchmaker region;  ?room=<region>-<code> → that
// room's host region;  ?region=<code> → an explicit pick.
// Only active on Fly (FLY_REGION set); locally REGION='' so we always accept here.
/**
 * The region a `?mm=1` connection was FIRST received in, from Fly's `fly-replay-src`
 * header (format `instance=…;region=<r>;t=…`). Anycast lands the connection on the
 * client's NEAREST region, which then replays it here to the matchmaker — so this
 * is a SERVER-OBSERVED home region, immune to the client's `/health` probe failing
 * (a cold/auto-stopped satellite makes that probe fall back to the warm primary or
 * to '', which then defaults every player to iad and hosts every match one-sided).
 * Used only as a FALLBACK when the client didn't report its own homeRegion, so the
 * working path is unchanged. Empty string when not replayed (already nearest here).
 */
function replaySrcRegion(req: IncomingMessage): string {
  const h = req.headers['fly-replay-src'];
  const raw = Array.isArray(h) ? h[0] : h;
  if (!raw) return '';
  const m = /(?:^|;)\s*region=([a-z]{3})(?:;|$)/i.exec(raw);
  return m ? m[1].toLowerCase() : '';
}


httpServer.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const target = routeTarget(url, MATCHMAKER_REGION);
    // `fly-replay-src` is set by Fly after it has already replayed once — never
    // replay again (loop guard); accept locally as a graceful fallback.
    const alreadyReplayed = !!req.headers['fly-replay-src'];
    if (REGION && target && target !== REGION && !alreadyReplayed) {
      socket.write(
        'HTTP/1.1 200 OK\r\n' +
          `fly-replay: region=${target}\r\n` +
          'content-length: 0\r\n' +
          'connection: close\r\n\r\n',
      );
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } catch {
    socket.destroy();
  }
});

// resilience: a game server must never let one stray error kill every room. Log
// loudly and keep listening (the ws / room handlers already catch closer in).
wss.on('error', (e) => console.error('[server] websocket server error:', e));
httpServer.on('error', (e) => console.error('[server] http server error:', e));
process.on('uncaughtException', (e) => console.error('[server] uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('[server] unhandledRejection:', e));

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  // liveness: mark alive now and on every pong; the heartbeat interval (bottom of
  // file) pings and reaps anything that stops answering
  socketAlive.set(ws, true);
  ws.on('pong', () => socketAlive.set(ws, true));

  // server-observed home region (see replaySrcRegion) — the fallback for a client
  // whose own region probe failed, so a cold-satellite player is no longer
  // mis-hosted at iad
  const edgeRegion = replaySrcRegion(req);

  let id: string = randomUUID(); // reassigned to the reclaimed clientId on a rejoin
  let room: Room | null = null;
  // the owning-connection stamp this socket was issued for its slot (0 until it
  // joins/rejoins). Passed to detach on close so a stale socket that a newer
  // reconnect already superseded can't knock the live player offline.
  let conn = 0;
  const wasEmpty = onlineCount === 0;
  onlineCount++;
  liveSockets.set(id, { authed: false });
  // FIRST arrival after a quiet spell: publish immediately rather than waiting up to
  // 5s for the next tick, and drop the cached answer — it was computed when this
  // machine was empty, so serving it again would report a zero we already know is
  // wrong. Only on the EDGE, so a busy machine still writes at its normal cadence.
  if (wasEmpty) {
    presenceCache = null;
    beatNow();
  }
  // the authed user this socket belongs to (set once its JWT verifies), so the
  // signed-in tally can be decremented cleanly on close
  let authedUserId: string | null = null;
  const markAuthed = (userId: string): void => {
    if (authedUserId) return; // count each connection's user exactly once
    authedUserId = userId;
    const sock = liveSockets.get(id);
    if (sock) sock.authed = true; // no longer a guest row
    authedUsers.set(userId, (authedUsers.get(userId) ?? 0) + 1);
  };
  const send = (m: ServerMsg): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encodeMsg(m));
  };
  // a late joiner during a pending restart still gets the countdown banner
  if (noticeLive() && currentNotice) send(currentNotice);

  // Join (or create) a room. Async because a region-coded code may name a ranked
  // match the designated matchmaker STAGED in Postgres: the first joiner claims it
  // (atomic delete-returning) and makes the room authoritative from that roster, and
  // we verify identity BEFORE adding so a ranked room can map each driver to a roster
  // slot by user id. The registry slot is claimed synchronously (before any await) so
  // a racing second joiner finds the same room instead of creating a duplicate.
  const joinRoom = async (msg: Extract<ClientMsg, { t: 'join' }>): Promise<void> => {
    const code = msg.room.toLowerCase();
    let r = rooms.get(code);
    let created = false;
    // sanitize the untrusted room game to a known id (unknown ⇒ 'decode'); the room
    // resolves its sim module from this, and a mismatched joiner is refused below.
    const cfg: RoomConfig = {
      ...(msg.config ?? DEFAULT_ROOM_CONFIG),
      game: msg.config?.game === 'chain' ? 'chain' : 'decode',
    };
    if (!r) {
      r = new Room(
        code,
        () => rooms.delete(code),
        cfg,
        persistMatch,
        (uid) => userRoom.set(uid, code),
        (uid) => {
          if (userRoom.get(uid) === code) userRoom.delete(uid);
        },
        persistDodges,
      );
      rooms.set(code, r);
      created = true;
    }
    // Room codes are KIND-SCOPED: a custom (versus) code must never admit a
    // duo-record joiner, or vice-versa (both mint codes from the same generator, so
    // a shared/typo'd code could otherwise drop you into the wrong game mode — wrong
    // capacity, alliance layout, and leaderboard). The client sends its intended
    // config on every join; when the code already names a room, its config wins and a
    // mismatched joiner is refused. (A just-created room can't mismatch — its config
    // IS the joiner's.)
    if (!created) {
      const want = cfg;
      if (
        r.config.kind !== want.kind ||
        r.config.record !== want.record ||
        (r.config.game ?? 'decode') !== (want.game ?? 'decode')
      ) {
        send({ t: 'error', message: 'That code is for a different game mode.' });
        return;
      }
    }
    if (created && dbEnabled) {
      const pending = await takePendingMatch(code).catch(() => null);
      if (pending) r.applyPending(pending);
    }
    let user: Awaited<ReturnType<typeof verifyAuthToken>> = null;
    if (msg.authToken) user = await verifyAuthToken(msg.authToken).catch(() => null);
    if (room) return; // a concurrent frame already placed this socket
    // MAINTENANCE: refuse new games while the window is biting. Enforced HERE, not
    // only in the client's start guard — the lockdown exists to protect a migration
    // mid-flight, and a guard anyone can skip by holding a stale tab is not one.
    // A room the matchmaker staged is exempt for the same reason it beats the
    // one-live-game guard: the server already committed those players to it.
    await refreshMaintenance();
    if (lockedOut(user?.userId) && !r.stagedFor(user?.userId ?? '')) {
      send({ t: 'error', message: lockoutMessage() });
      if (created) rooms.delete(code);
      return;
    }
    if (!r.canJoin()) {
      send({ t: 'error', message: 'Room is full or a match is already in progress.' });
      if (created) rooms.delete(code); // don't leave an empty just-created room behind
      return;
    }
    // one live game per user: refuse a second game while one is in progress (they
    // rejoin/leave it from Home). Reconnects use `rejoin`, so this never blocks
    // returning to your OWN match.
    //
    // ONE EXCEPTION, and it is the whole point of the background queue: a room the
    // MATCHMAKER STAGED FOR THIS USER is not a second game they chose to start — it
    // is the match the server has already committed them to, and it is about to
    // cost them ELO. Get matched while a solo record run is still in flight and the
    // run's slot is held for the reconnect grace, so this guard would refuse the
    // ranked join and turn "matched out of a background queue" into an automatic
    // forfeit. The staged roster is the server's own record of who belongs here, so
    // it wins: release the stale slot and let them in. (The abandoned room finalizes
    // on its own grace; its `onUserInactive` is code-scoped, so it can't then clear
    // the lock this match takes out.)
    if (user && activeElsewhere(user.userId, code)) {
      if (r.stagedFor(user.userId)) {
        userRoom.delete(user.userId);
      } else {
        send({ t: 'error', message: 'You already have a game in progress - rejoin or leave it first.' });
        if (created) rooms.delete(code);
        return;
      }
    }
    room = r;
    const client: Client = {
      id,
      send,
      // NEVER trust the wire spec: sanitize the whole player to legal ranges
      // before it lands on the roster (a spoofed devtools spec is clamped here)
      player: { ...sanitizePlayer(msg.player, cfg.game), clientId: id },
      connected: true,
      disconnectAt: 0,
      // protocol capabilities this client build understands (mixed-version safe:
      // the room only opens the strategy window if EVERY member supports it)
      caps: Array.isArray(msg.caps) ? msg.caps : [],
      // release channel: alpha rooms are segregated + never persisted (in-dev)
      channel: typeof msg.channel === 'string' ? msg.channel : undefined,
    };
    if (user) {
      client.userId = user.userId;
      client.player.name = user.handle;
      // Supporter badge, resolved once at join rather than per broadcast. A lapse
      // mid-match therefore keeps the badge until the next join, which is the
      // right trade: the alternative is a database read on every roster frame.
      // Never fatal — a DB hiccup costs a badge, not a join.
      if (dbEnabled) {
        const ent = await getSupporter(user.userId).catch(() => null);
        if (ent?.supporter) client.player.supporter = true;
        // staff badge rides the same read — `getSupporter` already returns the
        // role, so this costs nothing extra
        if (ent?.role) client.player.role = ent.role;
      }
      markAuthed(user.userId);
    }
    room.add(client);
    conn = client.conn ?? 0; // remember which socket-generation owns our slot
    room.maybeStartRanked(); // no-op unless a staged ranked room is now fully present
  };

  ws.on('message', (data: unknown) => {
    let msg;
    try {
      msg = decodeClientMsg(String(data));
    } catch {
      return; // ignore malformed frames
    }
    // never let a bad message take down the process (and every other room)
    try {
      if (msg.t === 'ping') {
        // latency probe — echo the client's timestamp straight back so it can
        // measure RTT for the connection-quality HUD (answered in lobby OR match)
        send({ t: 'pong', ts: msg.ts });
        return;
      }
      if (msg.t === 'join') {
        if (room) return; // already in a room on this connection
        void joinRoom(msg).catch((e) => console.error(`[server] join error from ${id}:`, e));
      } else if (msg.t === 'spectate') {
        if (room) return;
        const r = rooms.get(msg.room.toLowerCase());
        if (!r) {
          send({ t: 'error', message: 'That match is no longer live.' });
          return;
        }
        const spec = {
          id,
          send,
          player: { ...sanitizePlayer(undefined, r.config.game), clientId: id },
          connected: true,
          disconnectAt: 0,
          caps: Array.isArray(msg.caps) ? msg.caps : [],
        };
        room = r; // route this socket's close → r.detach (drops the spectator)
        // HIDDEN OBSERVER: an admin may watch without moving the spectator count.
        // The flag is NEVER taken from the message — `hidden: true` off the wire
        // would let anyone make themselves invisible. It is set only after this
        // server verifies the JWT and finds the subject in ADMIN_USER_IDS. Attach
        // immediately either way so a slow/failed verify never costs the admin the
        // start of the match; the count is corrected the moment it resolves.
        if (typeof msg.authToken === 'string' && msg.authToken) {
          void verifyAuthToken(msg.authToken)
            .then((u) => {
              if (u && ADMIN_IDS.has(u.userId)) r.hideSpectator(id);
            })
            .catch(() => {});
        }
        r.addSpectator(spec);
      } else if (msg.t === 'rejoin') {
        if (room) return;
        const r = rooms.get(msg.room.toLowerCase());
        const nc = r ? r.reattach(msg.clientId, send) : null;
        if (r && nc !== null) {
          liveSockets.delete(id);
          id = msg.clientId; // adopt the reclaimed identity on this socket
          liveSockets.set(id, { authed: !!authedUserId });
          room = r;
          conn = nc; // this socket now owns the slot (supersedes the dropped one)
        } else {
          send({ t: 'rejoined', ok: false });
        }
      } else if (msg.t === 'report') {
        /**
         * A player reporting another driver in their room. The ROOM resolves the robot id
         * onto an account (see `Room.resolveReport`) — this handler never sees a user id
         * from the client, so a crafted message cannot report an arbitrary person.
         *
         * Always answered `ok`, including when nothing was written: a duplicate, an
         * anonymous target and an unknown robot are all indistinguishable to the reporter
         * by design. Telling them apart would turn the button into a probe for who is
         * signed in and who has already been reported.
         */
        const r = room && isReportReason(msg.reason) ? room.resolveReport(id, msg.robotId) : null;
        if (r && dbEnabled) {
          void submitReport({
            reportedId: r.reportedId,
            reporterId: r.reporterId,
            reason: msg.reason,
            detail: typeof msg.detail === 'string' ? msg.detail.slice(0, REPORT_DETAIL_MAX) : null,
            roomCode: room!.code,
            game: room!.gameId,
          })
            .then((fresh) => {
              // A NEW report (not a duplicate) nudges the reported player's standing. It is
              // the weakest evidence in the system — one person's opinion, filed in a temper
              // as often as not — so it moves the number a little, never restricts anything,
              // and is capped per match inside `applyStandingEvent`. What it is really for is
              // SURFACING someone to a moderator; the moderator upholding it is what bites.
              if (!fresh) return;
              return distinctReporters(r.reportedId, room!.code).then((count) =>
                chargeStanding(r.reportedId, 'report', {
                  game: room!.gameId,
                  roomCode: room!.code,
                  count,
                }),
              );
            })
            .catch((e) => console.error('[report] write failed:', e));
        }
        send({ t: 'reported', ok: true });
      } else if (msg.t === 'queue') {
        if (room) return; // already in a room/match
        // ranked REQUIRES a verified account (ELO/leaderboard only make sense with
        // an identity). Anonymous players can still use custom rooms, just not
        // ranked. Verify the JWT, then enqueue; on a match the matchmaker sets our
        // `room` so subsequent input routes there.
        verifyAuthToken(msg.authToken).then((u) => {
          if (!u) {
            send({ t: 'error', message: 'Sign in to play ranked.' });
            return;
          }
          if (lockedOut(u.userId)) {
            send({ t: 'error', message: lockoutMessage() });
            return;
          }
          // one live game per user: can't queue ranked while another game is live
          if (activeElsewhere(u.userId, '')) {
            send({ t: 'error', message: 'You already have a game in progress - rejoin or leave it first.' });
            return;
          }
          markAuthed(u.userId);
          const enqueueNow = (): void => {
          void verifyParty(u.userId, msg).then((party) => {
            if (party === 'bad-token') {
              // Never silently fall back to the OPEN queue here. The player asked
              // to play one specific person; quietly matching them against a
              // stranger for rating is worse than saying it didn't work.
              send({ t: 'error', message: 'That challenge expired - send a new one.' });
              return;
            }
            matchmaker.enqueue({
            id,
            send,
            // sanitize the ranked player's spec/assists too (same clamp as join)
            player: { ...sanitizePlayer(msg.player, msg.game === 'chain' ? 'chain' : 'decode'), name: u.handle ?? msg.player.name },
            userId: u.userId,
            mode: msg.mode,
            // the client's home region (Fly's x-region for its connection) + measured
            // access latency; the matchmaker estimates cross-region ping from these to
            // pick a fair host. Prefer the client's own measurement; if it failed
            // (empty — a cold satellite Anycast-fell-back to the warm primary), use the
            // SERVER-OBSERVED source region from fly-replay-src before defaulting to
            // THIS instance's region (iad) — otherwise every unprobed player lands on
            // iad and every match hosts one-sided.
            homeRegion: msg.homeRegion || edgeRegion || REGION,
            accessMs: msg.accessMs ?? 0,
            noWiden: msg.noWiden ?? false,
            caps: Array.isArray(msg.caps) ? msg.caps : [],
            // segregate the queue by GAME (a CR queuer never pairs into a DECODE room)
            game: msg.game === 'chain' ? 'chain' : 'decode',
            channel: typeof msg.channel === 'string' ? msg.channel : undefined,
            // segregate the pool by build too (two builds never share a match)
            build: typeof msg.build === 'string' ? msg.build : undefined,
            // "play a friend": only ever the VERIFIED token (see verifyParty) —
            // never the raw one off the wire
            party: party?.token,
            partyOnly: party?.partyOnly,
            partySize: party ? PARTY_SIZE : undefined,
            enqueuedAt: 0, // stamped by enqueue()
            expandBumps: 0,
            onRoom: (r) => {
              room = r; // dev/no-DB local fallback only
            },
            });
          });
          };
          // ACCOUNT STANDING gate — checked HERE rather than in the matchmaker, because a
          // locked player must never enter the pool at all. Refusing them at PAIRING time
          // would mean the other players had already been staged and would have to be
          // requeued, which costs the wrong people their minutes. Fails OPEN (see
          // `rankedLock`): a database that cannot answer must not lock everybody out.
          void rankedLock(u.userId).then((lock) => {
            if (!lock) {
              enqueueNow();
              return;
            }
            const tier = tierOf(lock.score);
            if ((Array.isArray(msg.caps) ? msg.caps : []).includes('standing')) {
              // a lock is a state with a CLOCK, so the client is sent the deadline and
              // counts it down itself rather than being handed a sentence that is wrong
              // thirty seconds later
              send({ t: 'standingLock', until: lock.until, score: lock.score, tier: tier.key });
            } else {
              send({
                t: 'error',
                message:
                  `Ranked is locked for another ${lockRemaining(lock.until, Date.now())} ` +
                  `- your account standing is ${tier.name.toLowerCase()}.`,
              });
            }
          });
        });
      } else if (msg.t === 'expandSearch') {
        matchmaker.expand(id);
      } else if (msg.t === 'leaveQueue') {
        matchmaker.remove(id);
      } else if (room) {
        room.onMessage(id, msg);
      }
    } catch (e) {
      console.error(`[server] error handling ${msg.t} from ${id}:`, e);
    }
  });

  ws.on('close', () => {
    onlineCount--;
    liveSockets.delete(id);
    if (authedUserId) {
      const n = (authedUsers.get(authedUserId) ?? 1) - 1;
      if (n <= 0) authedUsers.delete(authedUserId);
      else authedUsers.set(authedUserId, n);
    }
    matchmaker.remove(id); // drop from any ranked queue
    // lobby ⇒ leave; mid-match ⇒ hold the slot for a reconnect. `conn` lets the room
    // ignore this close if a newer socket already reclaimed the slot (fast reconnect).
    room?.detach(id, conn);
  });

  ws.on('error', () => {
    /* a close event follows; teardown happens there */
  });
});

// bind 0.0.0.0 explicitly — Fly (and most platforms) route to the app there, NOT
// localhost/127.0.0.1 (a bind to localhost is unreachable ⇒ 502 / "not listening").
// LISTEN FIRST so GET /health answers within the platform's boot window, THEN load
// the Rapier WASM: loading it before listen() left nothing bound to the port during
// the (sub-second, but real on a shared CPU) WASM init, so Fly saw "app not listening
// on 8080" and flapped the machine. A match can't start until physicsReady() (guarded
// in room.ts), so serving /health ahead of physics is safe.
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] DECODE game server listening on 0.0.0.0:${PORT}`);
/**
 * WHICH DEPLOYMENT, AND WHICH DATABASE. One line, at boot, because the single most
 * expensive mistake available here is an ALPHA server pointed at the PRODUCTION database:
 * everything would work, and test matches, test ratings and test standing charges would
 * quietly land in real boards. The host is printed (never the credentials) so the answer is
 * visible in `fly logs` instead of being inferred from behaviour.
 */
console.log(
  `[server] channel=${SERVER_CHANNEL} db=${
    process.env.DATABASE_URL
      ? (process.env.DATABASE_URL.match(/@([^/?]+)/)?.[1] ?? 'set')
      : 'none'
  }${isAlphaServer() ? ' (alpha results PERSIST here)' : ''}`,
);
});
initPhysics()
  .then(() => console.log('[server] Rapier physics ready - matches enabled'))
  .catch((e) => {
    console.error('[server] failed to init physics:', e);
    process.exit(1);
  });

// apply DB migrations at boot (off the hot path; no-ops without DATABASE_URL). A
// DB failure must NOT take the game server down — records just won't persist.
migrate()
  .then(async () => {
    console.log('[server] database ready');
    // Project ADMIN_USER_IDS / OWNER_USER_ID onto profiles.role. The env stays the
    // source of truth; this is what lets a badge be JOINED by the leaderboard and
    // roster queries instead of post-processed row by row (0020_staff_roles.sql).
    // Symmetric — an id removed from the env loses its role here.
    if (!dbEnabled) return;
    await syncStaffRoles(OWNER_ID, ADMIN_LIST);
    console.log(
      `[server] staff synced: ${OWNER_ID ? '1 owner' : 'no owner'}, ${Math.max(0, ADMIN_LIST.filter((id) => id !== OWNER_ID).length)} admin(s)`,
    );
  })
  .catch((e) => console.error('[server] migration failed (records disabled):', e));

/*
 * IDLE MEANS SILENT. Everything below is a recurring timer that touches Postgres,
 * and Neon bills COMPUTE HOURS: the compute suspends only after five consecutive
 * minutes with NO queries, and bills for every second it is awake. So a timer that
 * fires unconditionally does not cost "one small query" — it costs the entire
 * month of compute. `min_machines_running = 1` (fly.toml) keeps iad up forever, so
 * an unconditional beat there pinned the database on 24/7 whether or not a single
 * person was playing.
 *
 * Rule for anything added here: fire only when there is something to say.
 */
if (dbEnabled) {
  // Reap staged ranked matches nobody claimed (both clients vanished after assign).
  // Self-arming: rows only exist after THIS machine stages one (`stagePending`
  // below), so an idle machine sweeps nothing. A sweep that finds nothing left
  // disarms until the next match is staged. Rows orphaned by a crash are inert —
  // their code only ever went to the two clients, so nobody can claim them — and
  // the next staged match sweeps the whole table, so it still self-heals.
  const reaper = setInterval(() => {
    if (!pendingStaged) return;
    cleanupStalePending(60_000)
      .then((n) => {
        if (n === 0) pendingStaged = false;
      })
      .catch((e) => console.error('[server] pending cleanup:', e));
  }, 60_000);
  reaper.unref();

  // PRESENCE HEARTBEAT — publish this machine's live counts so /api/presence can
  // aggregate a GLOBAL total across regions. A stopped/crashed machine simply stops
  // beating and its row ages out of the freshness window; a restart with the same
  // FLY_MACHINE_ID overwrites its own row, so no ghosts accumulate.
  //
  // An EMPTY machine beats once to publish the zero and then goes quiet until
  // someone shows up. Nothing reads a missing row as anything but absent —
  // `globalPresence` already filters to rows updated inside its freshness window,
  // so silence and a zero row mean the same thing to every consumer.
  let lastBeatEmpty = false;
  const beat = (): void => {
    const qs = matchmaker.queueSizes();
    const empty =
      onlineCount === 0 && authedUsers.size === 0 && qs['1v1'] === 0 && qs['2v2'] === 0;
    if (empty && lastBeatEmpty) return; // nothing here, and we already said so
    lastBeatEmpty = empty;
    const snap = operatorSnapshot();
    upsertPresence(
      MACHINE, REGION, onlineCount, [...authedUsers.keys()], qs['1v1'], qs['2v2'],
      // live rooms ride the SAME beat, so "Watch Live" sees every region (0021).
      // UNFILTERED — the admin view reads this too, and a beat that had already
      // dropped custom/record rooms could not be widened back at the endpoint.
      localLive(),
      snap.players, snap.anon, matchmaker.queueSizesByGame(), snap.guests,
    ).catch((e) => console.error('[presence] heartbeat failed:', e));
  };
  beat();
  beatNow = beat;
  const hb = setInterval(beat, 5_000);
  hb.unref();
}

// WS heartbeat — reap ghost sockets (see socketAlive above). Every interval:
// terminate any socket that didn't pong since the last ping (fires 'close' → the
// normal matchmaker.remove + room.detach teardown), then ping the rest. A live
// client answers pong automatically at the protocol level (no app code needed).
// 15s cadence ⇒ a dead socket is gone within ~30s instead of lingering for the OS
// TCP timeout, so it can no longer pad a ranked bucket or hold a match slot.
const WS_HEARTBEAT_MS = 15_000;
const pinger = setInterval(() => {
  for (const ws of wss.clients) {
    if (socketAlive.get(ws) === false) {
      ws.terminate();
      continue;
    }
    socketAlive.set(ws, false);
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }
}, WS_HEARTBEAT_MS);
pinger.unref();
