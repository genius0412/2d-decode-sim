import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Room, type Client } from './room';
import { decodeClientMsg, encodeMsg, DEFAULT_ROOM_CONFIG, type ClientMsg, type RoomConfig, type ServerMsg } from '../src/net/protocol';
import { sanitizePlayer } from '../src/net/sanitize';
import { verifyAuthToken } from './auth';
import { initPhysics } from '../src/sim/physicsEngine';
import { migrate } from './db/migrate';
import { persistMatch } from './persist';
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
  cleanupStalePending,
  adminListRecords,
  deleteRecordById,
  deleteUserRecords,
  searchProfiles,
  setHandle,
  getProfile,
  createAnnouncement,
  deleteAnnouncement,
  upsertPresence,
  globalPresence,
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
const matchmaker = new Matchmaker();

// live presence, surfaced at GET /api/presence (polled by the client so the
// homepage/ranked screens can show who's around WITHOUT anyone holding a standing
// socket — a persistent presence connection from every visitor would keep the
// auto-stopping Fly machine awake 24/7 and defeat the idle-to-zero cost model).
// `online` = open sockets (people actually engaged with multiplayer; solo/free
// players never connect). `signedIn` = DISTINCT authenticated users (deduped by
// userId, so multiple tabs count once).
let onlineCount = 0;
const authedUsers = new Map<string, number>(); // userId -> live socket count

// "one live game per user": userId -> code of the room whose MATCH they're currently
// in. Set by a room when its match begins (Room.onUserActive), cleared when their slot
// is released (finalize / grace-drop / room stop). A user with an entry here is refused
// a second join/queue elsewhere — they must rejoin or leave that game first. Reconnects
// (the `rejoin` message) bypass this, so returning to your OWN game always works.
const userRoom = new Map<string, string>();
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

// accounts allowed to use the admin API (their auth-JWT `sub`/userId). Set as a
// Fly secret: ADMIN_USER_IDS="uuid1,uuid2". Empty => admin API is locked to nobody.
const ADMIN_IDS = new Set(
  (process.env.ADMIN_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

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
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();
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

// GET /api/presence aggregates presence across ALL regions' machines (each machine
// only knows its own sockets). A tiny cache absorbs a burst of client polls so the
// aggregate query doesn't hit the DB on every request.
let presenceCache: { at: number; val: GlobalPresence } | null = null;
async function aggregatePresence(): Promise<GlobalPresence> {
  const now = Date.now();
  if (presenceCache && now - presenceCache.at < 3000) return presenceCache.val;
  const val = await globalPresence();
  presenceCache = { at: now, val };
  return val;
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
        u.pathname === '/api/admin/user/rename'
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
  // live presence (served here, not in api.ts, because the counts live on this
  // process: the socket registry + the in-memory matchmaker queues)
  // "Watch Live": every currently-running versus match on THIS host, for the spectator
  // list. Each entry's `room` code is spectated via the WS `spectate` message.
  if (req.method === 'GET' && req.url?.startsWith('/api/live')) {
    const live = [...rooms.values()].map((r) => r.summary()).filter((s) => s !== null);
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify({ region: REGION, rooms: live }));
    return;
  }
  // machine-sizing evidence for THIS machine (see the perf probe above). Public and
  // read-only: counts and timings, no player or account data. `?reset=1` zeroes the
  // lag histogram so a sample can be scoped to one match instead of since boot.
  if (req.method === 'GET' && req.url?.startsWith('/api/perf')) {
    const live = [...rooms.values()].map((r) => r.summary()).filter((s) => s !== null);
    const ms = (n: number): number => Math.round((n / 1e6) * 100) / 100; // ns → ms
    const body = {
      region: REGION,
      machine: MACHINE,
      uptimeS: Math.round(process.uptime()),
      cores: Math.round(coresInUse() * 1000) / 1000,
      rooms: live.length,
      players: onlineCount,
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      // the decisive numbers: a p99 approaching the 16.67ms step budget means the
      // loop is already late, and a max past the /health timeout means a flap.
      loopLagMs: {
        mean: ms(loopDelay.mean),
        p50: ms(loopDelay.percentile(50)),
        p99: ms(loopDelay.percentile(99)),
        max: ms(loopDelay.max),
      },
    };
    if (new URL(req.url, 'http://x').searchParams.get('reset')) loopDelay.reset();
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify(body));
    return;
  }
  if (req.method === 'GET' && req.url === '/api/presence') {
    // include any LIVE admin notice so the client can show the restart banner
    // (and block starting new games) on EVERY page — even disconnected ones
    // like Home/solo where no WebSocket delivers `serverNotice`.
    const notice =
      noticeLive() && currentNotice
        ? { kind: currentNotice.kind, message: currentNotice.message, until: currentNotice.until }
        : null;
    const respond = (online: number, signedIn: number, queues: Record<string, number>): void => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify({ region: REGION, online, signedIn, queues, notice }));
    };
    // GLOBAL count: aggregate every region's heartbeat (this machine only sees its
    // own sockets — anycast routing means the caller often lands on an empty region).
    // Fall back to this machine's local numbers if the DB read fails.
    if (dbEnabled) {
      aggregatePresence().then(
        (g) => respond(g.online, g.signedIn, g.queues),
        (e) => {
          console.error('[presence] aggregate failed, using local:', e);
          respond(onlineCount, authedUsers.size, matchmaker.queueSizes());
        },
      );
    } else {
      respond(onlineCount, authedUsers.size, matchmaker.queueSizes());
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

function routeTarget(url: URL): string | null {
  if (url.searchParams.get('mm') === '1') return MATCHMAKER_REGION;
  const region = url.searchParams.get('region');
  if (region) return region;
  const room = url.searchParams.get('room');
  if (room) {
    const dash = room.indexOf('-');
    if (dash > 0) return room.slice(0, dash); // region-coded `<region>-<code>`
  }
  return null;
}

httpServer.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const target = routeTarget(url);
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
  onlineCount++;
  // the authed user this socket belongs to (set once its JWT verifies), so the
  // signed-in tally can be decremented cleanly on close
  let authedUserId: string | null = null;
  const markAuthed = (userId: string): void => {
    if (authedUserId) return; // count each connection's user exactly once
    authedUserId = userId;
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
    if (!r.canJoin()) {
      send({ t: 'error', message: 'Room is full or a match is already in progress.' });
      if (created) rooms.delete(code); // don't leave an empty just-created room behind
      return;
    }
    // one live game per user: refuse a second game while one is in progress (they
    // rejoin/leave it from Home). Reconnects use `rejoin`, so this never blocks
    // returning to your OWN match.
    if (user && activeElsewhere(user.userId, code)) {
      send({ t: 'error', message: 'You already have a game in progress — rejoin or leave it first.' });
      if (created) rooms.delete(code);
      return;
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
        r.addSpectator({
          id,
          send,
          player: { ...sanitizePlayer(undefined, r.config.game), clientId: id },
          connected: true,
          disconnectAt: 0,
          caps: Array.isArray(msg.caps) ? msg.caps : [],
        });
        room = r; // route this socket's close → r.detach (drops the spectator)
      } else if (msg.t === 'rejoin') {
        if (room) return;
        const r = rooms.get(msg.room.toLowerCase());
        const nc = r ? r.reattach(msg.clientId, send) : null;
        if (r && nc !== null) {
          id = msg.clientId; // adopt the reclaimed identity on this socket
          room = r;
          conn = nc; // this socket now owns the slot (supersedes the dropped one)
        } else {
          send({ t: 'rejoined', ok: false });
        }
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
          // one live game per user: can't queue ranked while another game is live
          if (activeElsewhere(u.userId, '')) {
            send({ t: 'error', message: 'You already have a game in progress — rejoin or leave it first.' });
            return;
          }
          markAuthed(u.userId);
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
            enqueuedAt: 0, // stamped by enqueue()
            expandBumps: 0,
            onRoom: (r) => {
              room = r; // dev/no-DB local fallback only
            },
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
});
initPhysics()
  .then(() => console.log('[server] Rapier physics ready — matches enabled'))
  .catch((e) => {
    console.error('[server] failed to init physics:', e);
    process.exit(1);
  });

// apply DB migrations at boot (off the hot path; no-ops without DATABASE_URL). A
// DB failure must NOT take the game server down — records just won't persist.
migrate()
  .then(() => console.log('[server] database ready'))
  .catch((e) => console.error('[server] migration failed (records disabled):', e));

// reap staged ranked matches nobody claimed (both clients vanished after assign).
// Only meaningful on the matchmaker/host machines; harmless elsewhere.
if (dbEnabled) {
  const reaper = setInterval(() => {
    cleanupStalePending(60_000).catch((e) => console.error('[server] pending cleanup:', e));
  }, 60_000);
  reaper.unref();

  // PRESENCE HEARTBEAT — publish this machine's live counts so /api/presence can
  // aggregate a GLOBAL total across regions. A stopped/crashed machine simply stops
  // beating and its row ages out of the freshness window; a restart with the same
  // FLY_MACHINE_ID overwrites its own row, so no ghosts accumulate.
  const beat = (): void => {
    const qs = matchmaker.queueSizes();
    upsertPresence(MACHINE, REGION, onlineCount, [...authedUsers.keys()], qs['1v1'], qs['2v2']).catch(
      (e) => console.error('[presence] heartbeat failed:', e),
    );
  };
  beat();
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
