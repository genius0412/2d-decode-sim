import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GameId } from '../src/types';
import { BALANCE_VERSION } from '../src/config';
import { dbEnabled } from './db/pool';
import {
  acceptFriendRequest,
  actForSeason,
  blockUser,
  cancelFriendRequest,
  currentSeasonNumber,
  declineFriendRequest,
  dismissRoomInvite,
  ensureProfile,
  ensureSeason,
  inviteToRoom,
  listAnnouncements,
  listFriends,
  removeFriend,
  searchUsersByUsername,
  sendFriendRequest,
  setPresenceStatus,
  touchPresence,
  unblockUser,
  type Activity,
  type PresenceStatus,
  eloLeaderboard,
  eloHistoryLeaderboard,
  eloHistoryUserStanding,
  eloUserStanding,
  getGlobalStats,
  getProfile,
  getProfileByUsername,
  getReplay,
  getUserSettings,
  getUserStats,
  listSeasons,
  recordLeaderboard,
  saveUserSettings,
  setHandle,
  setUsername,
  userMatchHistory,
  usernameAvailable,
  UsernameTakenError,
} from './db/repo';
import { verifyAuthToken } from './auth';
import { DEPLOY_REGIONS, interRegionMs } from './regions';

/**
 * Public read API for the leaderboards + replay viewer (GET), plus ONE
 * authenticated write: a user editing their own display name (`POST
 * /api/user/handle`, JWT-verified — every other write still goes through the
 * authoritative match loop). Same port as the WS server. CORS-open because the
 * data is public and the client is a different origin (Vercel). Returns
 * empty/404 gracefully when the DB is disabled.
 *
 *   GET  /api/stats                          — site-wide players + games played
 *   GET  /api/records?mode=solo|duo&drivetrain=<dt|overall>&season=<n>&limit=<n>
 *   GET  /api/elo?mode=1v1|2v2&season=<n>&limit=<n>
 *   GET  /api/user/<id>/stats?season=<n>   — one user's ELO+records+W/L+history
 *   GET  /api/user/<id>                     — a user's public profile (handle)
 *   POST /api/user/handle  {handle}         — set your OWN display name (Bearer JWT)
 *   POST /api/user/username {username}       — claim your OWN unique username (Bearer JWT)
 *   GET  /api/username-available?u=<name>    — is a username free + valid-format?
 *   GET  /api/profile/<username>             — public profile by username (handle+id)
 *   GET  /api/profile/<username>/stats?season=<n> — one user's stats, by username
 *   GET  /api/user/settings                  — your synced settings (Bearer JWT)
 *   POST /api/user/settings {settings}       — save your settings (Bearer JWT)
 *   GET  /api/replay/<id>
 *
 *   GET  /api/friends                        — friends + requests + presence (Bearer JWT)
 *   POST /api/friends/request  {username}    — send (or auto-accept a reciprocal) request
 *   POST /api/friends/accept   {username}
 *   POST /api/friends/decline  {username}
 *   POST /api/friends/cancel   {username}    — withdraw one you sent
 *   POST /api/friends/remove   {username}
 *   POST /api/friends/block    {username} / /api/friends/unblock {username}
 *   POST /api/friends/status   {status}      — your own online/dnd/invisible
 *   POST /api/friends/invite   {username,room,game,kind,record?} — invite a friend
 *                                               to a room (must be friends)
 *   POST /api/friends/invite/dismiss {id}    — dismiss/consume an invite sent to you
 *   GET  /api/users/search?q=<prefix>        — public username-PREFIX search
 */

/** Public usernames: lowercase letters + digits only, 4–20 chars. Kept in sync
 * with the client's validator (src/net/api.ts `USERNAME_RE`) and the DB's unique
 * index. Returns the normalized (trimmed, lowercased) value or null if invalid.
 *
 * CLAIM-TIME ONLY. Use `lookupUsername` for a name that identifies an EXISTING
 * account — see the note there. */
const USERNAME_RE = /^[a-z0-9]{4,20}$/;
function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const u = raw.trim().toLowerCase();
  return USERNAME_RE.test(u) ? u : null;
}

/** Normalize a username used as a LOOKUP KEY (naming someone else).
 *
 * This deliberately does NOT apply `USERNAME_RE`'s 4-char floor. A claim rule and
 * a lookup rule are different things: some live accounts hold a username that
 * predates today's minimum (e.g. a 3-char one), and running their name through
 * the CLAIM validator rejected it before the DB was ever consulted — so every
 * /api/friends action naming that player failed with a bare 400 "bad request",
 * accept included, with no way for either side to clear it. The public
 * /api/profile/<username> routes always did a plain lowercase-and-look-up, which
 * is why those pages worked for the same account while friends didn't.
 *
 * Bounds only what the DB column could ever hold; the query is parameterized. */
const USERNAME_LOOKUP_RE = /^[a-z0-9]{1,20}$/;
function lookupUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const u = raw.trim().toLowerCase();
  return USERNAME_LOOKUP_RE.test(u) ? u : null;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '600',
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 512 * 1024) reject(new Error('body too large')); // 512KB cap (settings can carry an auto-path)
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** the Bearer token from an Authorization header, if it looks like one */
function bearer(req: IncomingMessage): string | undefined {
  const auth = req.headers['authorization'];
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
}

export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return false;

  const json = (code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS });
    res.end(JSON.stringify(body));
  };

  // CORS preflight for the authenticated POST
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }

  try {
    // ---- authenticated write: set your own display name --------------------
    if (req.method === 'POST' && url.pathname === '/api/user/handle') {
      const auth = req.headers['authorization'];
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
      const user = await verifyAuthToken(token);
      if (!user) return json(401, { error: 'sign in required' }), true;
      let handle: unknown;
      try {
        handle = JSON.parse(await readBody(req)).handle;
      } catch {
        return json(400, { error: 'bad request' }), true;
      }
      const clean = typeof handle === 'string' ? handle.trim() : '';
      if (clean.length < 2 || clean.length > 24) {
        return json(400, { error: 'name must be 2–24 characters' }), true;
      }
      if (dbEnabled) {
        await ensureProfile(user.userId, clean);
        await setHandle(user.userId, clean);
      }
      return json(200, { userId: user.userId, handle: clean }), true;
    }

    // ---- authenticated write: claim your own unique username ----------------
    if (req.method === 'POST' && url.pathname === '/api/user/username') {
      const auth = req.headers['authorization'];
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
      const user = await verifyAuthToken(token);
      if (!user) return json(401, { error: 'sign in required' }), true;
      let raw: unknown;
      try {
        raw = JSON.parse(await readBody(req)).username;
      } catch {
        return json(400, { error: 'bad request' }), true;
      }
      const username = normalizeUsername(raw);
      if (!username) {
        return json(400, { error: '4–20 characters, lowercase letters and numbers only' }), true;
      }
      if (dbEnabled) {
        await ensureProfile(user.userId, user.handle);
        try {
          await setUsername(user.userId, username);
        } catch (e) {
          if (e instanceof UsernameTakenError) {
            return json(409, { error: 'That username is taken.' }), true;
          }
          throw e;
        }
      }
      return json(200, { userId: user.userId, username }), true;
    }

    // ---- public: is a username free to claim? (format + uniqueness) ---------
    if (req.method === 'GET' && url.pathname === '/api/username-available') {
      const username = normalizeUsername(url.searchParams.get('u'));
      if (!username) return json(200, { valid: false, available: false }), true;
      const available = dbEnabled ? await usernameAvailable(username) : true;
      return json(200, { valid: true, available, username }), true;
    }

    // ---- per-account settings (read + write your own) ----------------------
    if (url.pathname === '/api/user/settings' && (req.method === 'GET' || req.method === 'POST')) {
      const auth = req.headers['authorization'];
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
      const user = await verifyAuthToken(token);
      if (!user) return json(401, { error: 'sign in required' }), true;

      if (req.method === 'GET') {
        const settings = dbEnabled ? await getUserSettings(user.userId) : null;
        return json(200, { settings }), true;
      }
      // POST: save the whole settings blob
      let settings: unknown;
      try {
        settings = JSON.parse(await readBody(req)).settings;
      } catch {
        return json(400, { error: 'bad request' }), true;
      }
      if (typeof settings !== 'object' || settings === null) {
        return json(400, { error: 'settings must be an object' }), true;
      }
      if (dbEnabled) {
        await ensureProfile(user.userId, user.handle);
        await saveUserSettings(user.userId, settings);
      }
      return json(200, { ok: true }), true;
    }

    // ---- friends ------------------------------------------------------------
    // Friendship is MUTUAL CONSENT and presence is behavioural data about a real
    // person, so every rule here is enforced server-side. Two invariants hold
    // across this whole block:
    //
    //  1. The acting user is ALWAYS `user.userId` from the verified JWT. No
    //     endpoint accepts an actor/userId parameter naming who is acting —
    //     otherwise anyone could forge another account's presence or consent.
    //  2. The wire carries USERNAMES, not user ids. `userId` is the auth
    //     provider's `sub`, which also authorises match writes; keeping it off
    //     these responses means a leaked friends list doesn't hand out a set of
    //     valid `sub` values. (/api/profile/<username> returns one today —
    //     pre-existing, but don't widen it.)
    //
    // CORS is `*` here as elsewhere, which stays safe ONLY because auth is a
    // Bearer token JS must attach explicitly: a wildcard ACAO can't be combined
    // with credentials, so a hostile page can't make an authed cross-origin call
    // for a victim. If auth ever moves to a cookie, every route below becomes
    // CSRF-able and needs SameSite + an origin check the same day.
    if (url.pathname === '/api/friends' || url.pathname.startsWith('/api/friends/')) {
      const user = await verifyAuthToken(bearer(req));
      if (!user) return json(401, { error: 'sign in required' }), true;
      if (!dbEnabled) {
        return json(200, { friends: [], incoming: [], outgoing: [], blocked: [], invites: [], status: null }), true;
      }

      // the friends READ doubles as the presence heartbeat: the poll that
      // refreshes everyone else's status already proves the caller is here, so a
      // separate ping endpoint would double the request rate against a
      // scale-to-zero machine to say something this request already said.
      if (req.method === 'GET' && url.pathname === '/api/friends') {
        // the heartbeat also carries WHAT the caller is doing, so friends can see
        // "In a match"/"In a lobby". Both are coarse + validated to a small set;
        // an old client that sends neither simply records a plain 'online' beat.
        const a = url.searchParams.get('a');
        const activity: Activity | null = a === 'menu' || a === 'lobby' || a === 'match' ? a : null;
        const g = url.searchParams.get('g');
        const activityGame: GameId | null = g === 'chain' ? 'chain' : g === 'decode' ? 'decode' : null;
        await ensureProfile(user.userId, user.handle);
        await touchPresence(user.userId, activity, activityGame);
        return json(200, await listFriends(user.userId)), true;
      }

      if (req.method !== 'POST') return json(405, { error: 'method not allowed' }), true;

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      } catch {
        return json(400, { error: 'bad request' }), true;
      }
      await ensureProfile(user.userId, user.handle);

      // set your OWN presence status (the only friends POST not naming someone else)
      if (url.pathname === '/api/friends/status') {
        const s = body.status;
        const status: PresenceStatus | null =
          s === 'online' || s === 'dnd' || s === 'invisible' ? s : null;
        await setPresenceStatus(user.userId, status);
        return json(200, { status }), true;
      }

      // dismiss (or consume, on join) a room invite ADDRESSED TO the caller — not
      // "names another player", so it doesn't fit the username-resolution block below
      if (url.pathname === '/api/friends/invite/dismiss') {
        const id = typeof body.id === 'string' ? body.id : null;
        if (!id) return json(400, { error: 'bad request' }), true;
        const ok = await dismissRoomInvite(user.userId, id);
        if (!ok) return json(404, { error: 'no such invite' }), true;
        return json(200, { ok: true }), true;
      }

      // every remaining route names another player by username. This is a LOOKUP,
      // not a claim — see `lookupUsername` (a claim-time validator here made every
      // action against a legacy short username fail with an opaque 400).
      const username = lookupUsername(body.username);
      if (!username) return json(400, { error: 'No player named.' }), true;
      const target = await getProfileByUsername(username);
      if (!target) return json(404, { error: 'no such user' }), true;
      if (target.userId === user.userId) {
        return json(400, { error: "That's you." }), true;
      }
      const other = target.userId;

      switch (url.pathname) {
        case '/api/friends/request': {
          // The recipient accepts by naming the SENDER by username, so a sender
          // who has none would plant a row nobody can ever act on. The username
          // gate normally guarantees one; this covers the accounts that slipped
          // past it (a failed profile fetch there deliberately doesn't trap the
          // user, which leaves exactly this hole).
          const me = await getProfile(user.userId);
          if (!me?.username) return json(400, { error: 'Pick a username first.' }), true;
          const outcome = await sendFriendRequest(user.userId, other);
          // 'blocked' deliberately reports the same generic failure as any other
          // refusal: a distinct message would let someone confirm they've been
          // blocked, which is exactly what the block exists to withhold.
          if (outcome === 'blocked') return json(409, { error: "Couldn't send that request." }), true;
          if (outcome === 'already-friends') return json(409, { error: 'Already friends.' }), true;
          if (outcome === 'duplicate') return json(409, { error: 'Request already sent.' }), true;
          return json(200, { outcome }), true;
        }
        case '/api/friends/accept': {
          const ok = await acceptFriendRequest(user.userId, other);
          // no pending request from that person ⇒ 404, never a silent success
          if (!ok) return json(404, { error: 'No pending request from that player.' }), true;
          return json(200, { ok: true }), true;
        }
        case '/api/friends/decline': {
          const ok = await declineFriendRequest(user.userId, other);
          if (!ok) return json(404, { error: 'No pending request from that player.' }), true;
          return json(200, { ok: true }), true;
        }
        case '/api/friends/cancel': {
          const ok = await cancelFriendRequest(user.userId, other);
          if (!ok) return json(404, { error: 'No pending request to that player.' }), true;
          return json(200, { ok: true }), true;
        }
        case '/api/friends/remove': {
          const ok = await removeFriend(user.userId, other);
          if (!ok) return json(404, { error: 'Not friends with that player.' }), true;
          return json(200, { ok: true }), true;
        }
        case '/api/friends/block':
          await blockUser(user.userId, other);
          return json(200, { ok: true }), true;
        case '/api/friends/unblock':
          await unblockUser(user.userId, other);
          return json(200, { ok: true }), true;
        // "come join my room" — scoped to an existing friendship (see
        // inviteToRoom), not a new trust relationship of its own.
        case '/api/friends/invite': {
          const room = typeof body.room === 'string' ? body.room.trim() : '';
          if (!room || room.length > 40 || !/^[a-z0-9-]+$/i.test(room)) {
            return json(400, { error: 'bad request' }), true;
          }
          const game: GameId = body.game === 'chain' ? 'chain' : 'decode';
          const kind = body.kind === 'record' ? 'record' : 'versus';
          const record = body.record === 'duo' || body.record === 'solo' ? (body.record as string) : null;
          const outcome = await inviteToRoom(user.userId, other, room, game, kind, record);
          if (outcome === 'not-friends') return json(409, { error: 'Not friends with that player.' }), true;
          return json(200, { ok: true }), true;
        }
        default:
          return json(404, { error: 'unknown endpoint' }), true;
      }
    }

    // ---- public: username-PREFIX search (the "add a friend" box) ------------
    // Public because it returns only what /api/profile/<username> already does
    // one at a time. It is a PREFIX match on `username`, never a substring match
    // on `handle` — the latter would let anyone enumerate every display name.
    // Presence never appears here; it is friends-only, in /api/friends.
    if (req.method === 'GET' && url.pathname === '/api/users/search') {
      const raw = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      if (raw.length < 2) return json(200, { users: [] }), true;
      const users = dbEnabled ? await searchUsersByUsername(raw, 20) : [];
      return json(200, { users }), true;
    }

    // which GAME's boards/periods to read — DECODE and Chain Reaction each have their own
    // ranked/record boards and Act → Season progression (default DECODE for old clients).
    const game: GameId = url.searchParams.get('game') === 'chain' ? 'chain' : 'decode';
    // default board view = the live season FOR THIS GAME (which may be admin-advanced past
    // the code's BALANCE_VERSION); an explicit ?season= picks an archived one.
    const seasonParam = url.searchParams.get('season');
    const season =
      seasonParam !== null
        ? Number(seasonParam)
        : dbEnabled
          ? await currentSeasonNumber(BALANCE_VERSION, game)
          : BALANCE_VERSION;
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100)));
    // paginated match-history opts (repo clamps limit to [1,100], default 25)
    const historyOpts = {
      balanceVersion: season,
      game,
      offset: Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0),
      limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
      type: url.searchParams.get('type') ?? undefined,
      result: url.searchParams.get('result') ?? undefined,
    };
    const emptyHistory = { rows: [], total: 0, offset: historyOpts.offset, limit: historyOpts.limit ?? 25 };

    // recent announcements (patch notes / new season / new act) — public, cheap;
    // the client fetches this on load and shows any it hasn't marked seen locally.
    if (url.pathname === '/api/announcements') {
      const rows = dbEnabled ? await listAnnouncements(Math.min(50, limit)) : [];
      return json(200, { announcements: rows }), true;
    }

    // Region topology for the client's server picker. The picker used to MEASURE
    // every region by fly-replaying a /health probe to each one — which, with
    // `auto_start_machines`, BOOTED every idle region on each visit and defeated
    // auto-stop (the satellites are only cheap while stopped). The matchmaker has
    // always avoided this (see server/regions.ts): one probe of your OWN region
    // plus a static RTT matrix estimates the rest. This endpoint hands the client
    // that same matrix so the picker can do it too — no wakes, one source of truth.
    if (url.pathname === '/api/regions') {
      const rtt: Record<string, Record<string, number>> = {};
      for (const a of DEPLOY_REGIONS) {
        rtt[a] = {};
        for (const b of DEPLOY_REGIONS) rtt[a][b] = interRegionMs(a, b);
      }
      return json(200, { regions: DEPLOY_REGIONS, rtt }), true;
    }

    if (url.pathname === '/api/stats') {
      const stats = dbEnabled
        ? await getGlobalStats()
        : { users: 0, games: 0, byCategory: { solo: 0, duo: 0, '1v1': 0, '2v2': 0 } };
      return json(200, stats), true;
    }

    // season list for the leaderboard's season picker; `current` is the live one
    if (url.pathname === '/api/seasons') {
      // seed Chain Reaction's first period at Act 1 · Season 1 (DECODE keeps act 0/beta)
      const current = dbEnabled ? await currentSeasonNumber(BALANCE_VERSION, game) : BALANCE_VERSION;
      if (dbEnabled) await ensureSeason(current, game, game === 'chain' ? 1 : 0);
      const seasons = dbEnabled ? await listSeasons(game) : [];
      return json(200, { current, seasons, game }), true;
    }

    if (url.pathname === '/api/records') {
      const mode = url.searchParams.get('mode') === 'duo' ? 'duo' : 'solo';
      const drivetrain = url.searchParams.get('drivetrain') ?? 'overall';
      const rows = dbEnabled
        ? await recordLeaderboard({ mode, drivetrain, balanceVersion: season, limit, game })
        : [];
      return json(200, { season, mode, drivetrain, rows, game }), true;
    }

    if (url.pathname === '/api/elo') {
      const mode = url.searchParams.get('mode') === '2v2' ? '2v2' : '1v1';
      const meId = url.searchParams.get('me');
      // The LIVE season reads the per-ACT board (elo_ratings — every currently-placed player);
      // an ARCHIVED season reads the per-season SNAPSHOT (elo_history — ratings frozen at that
      // season's end, so it shows the historical standings, not the moved-on live rating).
      const current = dbEnabled ? await currentSeasonNumber(BALANCE_VERSION, game) : season;
      const isLive = season >= current;
      let rows: Awaited<ReturnType<typeof eloLeaderboard>> = [];
      let me: Awaited<ReturnType<typeof eloUserStanding>> = null;
      if (dbEnabled && isLive) {
        const act = await actForSeason(season, game);
        rows = await eloLeaderboard({ mode, act, limit, game });
        me = meId ? await eloUserStanding({ userId: meId, mode, act, game }) : null;
      } else if (dbEnabled) {
        rows = await eloHistoryLeaderboard({ mode, balanceVersion: season, limit, game });
        me = meId ? await eloHistoryUserStanding({ userId: meId, mode, balanceVersion: season, game }) : null;
      }
      return json(200, { season, mode, rows, me, game, historical: !isLive }), true;
    }

    // public match history keyed by USERNAME (the profile page's history list)
    const profMatchesMatch = url.pathname.match(/^\/api\/profile\/([^/]+)\/matches$/);
    if (profMatchesMatch) {
      const username = decodeURIComponent(profMatchesMatch[1]).toLowerCase();
      const profile = dbEnabled ? await getProfileByUsername(username) : null;
      if (!profile) return json(404, { error: 'no such user' }), true;
      const page = await userMatchHistory(profile.userId, historyOpts);
      return json(200, page), true;
    }

    // public profile + stats keyed by USERNAME (the /profile/<username> page)
    const profStatsMatch = url.pathname.match(/^\/api\/profile\/([^/]+)\/stats$/);
    if (profStatsMatch) {
      const username = decodeURIComponent(profStatsMatch[1]).toLowerCase();
      const profile = dbEnabled ? await getProfileByUsername(username) : null;
      if (!profile) return json(404, { error: 'no such user' }), true;
      const stats = await getUserStats(profile.userId, season, game);
      return json(200, stats), true;
    }
    const profMatch = url.pathname.match(/^\/api\/profile\/([^/]+)$/);
    if (profMatch) {
      const username = decodeURIComponent(profMatch[1]).toLowerCase();
      const profile = dbEnabled ? await getProfileByUsername(username) : null;
      if (!profile) return json(404, { error: 'no such user' }), true;
      return json(200, profile), true;
    }

    const matchesMatch = url.pathname.match(/^\/api\/user\/([^/]+)\/matches$/);
    if (matchesMatch) {
      const userId = decodeURIComponent(matchesMatch[1]);
      const page = dbEnabled ? await userMatchHistory(userId, historyOpts) : emptyHistory;
      return json(200, page), true;
    }

    const statsMatch = url.pathname.match(/^\/api\/user\/([^/]+)\/stats$/);
    if (statsMatch) {
      const userId = decodeURIComponent(statsMatch[1]);
      const stats = dbEnabled ? await getUserStats(userId, season, game) : null;
      if (!stats) return json(200, { season, userId, elo: [], records: [], match: { played: 0, wins: 0, losses: 0 }, recent: [], handle: null, username: null }), true;
      return json(200, stats), true;
    }

    const profileMatch = url.pathname.match(/^\/api\/user\/([^/]+)$/);
    if (profileMatch) {
      const userId = decodeURIComponent(profileMatch[1]);
      const profile = dbEnabled ? await getProfile(userId) : null;
      return json(200, profile ?? { userId, handle: null, username: null }), true;
    }

    const replayMatch = url.pathname.match(/^\/api\/replay\/([\w-]+)$/);
    if (replayMatch) {
      const replay = dbEnabled ? await getReplay(replayMatch[1]) : null;
      if (!replay) return json(404, { error: 'not found' }), true;
      return json(200, replay), true;
    }

    return json(404, { error: 'unknown endpoint' }), true;
  } catch (e) {
    console.error('[api] error:', e);
    return json(500, { error: 'internal error' }), true;
  }
}
