import type { Replay } from '../sim/replay';
import type { LiveRoom, StaffRole } from './protocol';
import type { ReportedUser, ReportRow } from '../report';
import type { AssistConfig, GameId, RobotSpec } from '../types';
import { gameServerHttpUrl } from './env';
import { getAuthToken } from '../lib/authClient';

/** boards + periods are per-game; append `&game=chain` only for CR so DECODE URLs stay
 * byte-identical (the server defaults a missing game to DECODE). */
const gameParam = (game?: GameId): string => (game === 'chain' ? '&game=chain' : '');

/**
 * Client for the server's public read APIs (leaderboards + replays). These are
 * plain GET/JSON against the same host as the WS game server. Writes NEVER go
 * through here — scores/records/ELO are written only by the authoritative match
 * loop on the server.
 */

/**
 * The badge fields that travel with EVERY name the server sends — a leaderboard
 * row, a match-history participant, a friend, the sender of a challenge.
 *
 * One shared shape rather than a pair of fields copied into each interface,
 * because the failure mode is silent: a row type that forgets them still
 * compiles and still renders, just with no badge on that one surface — which is
 * how the ranked board ended up bare while the record board next to it was fine.
 *
 * Both are OPTIONAL. One Fly app serves every client build, so a client can be
 * newer than the server it is talking to and receive neither; "absent" must
 * render exactly like "not a supporter", never as a broken field.
 */
export interface BadgeFields {
  /** active supporter membership (staff are entitled without paying) */
  supporter?: boolean;
  /** 'owner' | 'admin' — renders the staff badge in place of the supporter one */
  role?: StaffRole;
}

export interface RecordConfig {
  spec: RobotSpec;
  assists: AssistConfig;
  /** in a DUO run, the co-op partner's robot (each driver brings their own build,
   * so a duo can mix drivetrains). Absent for solo runs / legacy rows. */
  partnerSpec?: RobotSpec;
}

export interface RecordRow extends BadgeFields {
  userId: string;
  handle: string;
  username: string | null;
  partnerId: string | null;
  /** duo partner's display name + username (null for solo runs / legacy) */
  partnerHandle: string | null;
  partnerUsername: string | null;
  /** the partner's own badge — a duo row prints two names, so it carries two */
  partnerSupporter?: boolean;
  partnerRole?: StaffRole;
  score: number;
  replayId: string | null;
  createdAt: string;
  config: RecordConfig | null;
}

export interface EloRow extends BadgeFields {
  userId: string;
  handle: string;
  username: string | null;
  rating: number;
  games: number;
}

/** the viewing player's own standing on a board (placed or not). `rank` is null
 * while still in placements; derive placement from `games` against PLACEMENT_GAMES. */
export interface EloStanding {
  rank: number | null;
  rating: number;
  games: number;
}

export type RecordMode = 'solo' | 'duo';
export type EloMode = '1v1' | '2v2';
/** a record board: a specific drivetrain or the cross-drivetrain 'overall'.
 * RANKED (ELO) is NOT split by drivetrain — only the record boards are. */
export type Board = 'mecanum' | 'tank' | 'swerve' | 'xdrive' | 'overall';

async function getJson<T>(path: string): Promise<T> {
  const base = gameServerHttpUrl();
  if (!base) throw new Error('Leaderboards need the game server (VITE_GAME_SERVER_URL).');
  const res = await fetch(base + path);
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return (await res.json()) as T;
}

export function fetchRecords(
  mode: RecordMode,
  drivetrain: Board,
  season?: number,
  game?: GameId,
): Promise<{ rows: RecordRow[] }> {
  const s = season != null ? `&season=${season}` : '';
  return getJson(`/api/records?mode=${mode}&drivetrain=${drivetrain}${s}${gameParam(game)}`);
}

export function fetchElo(
  mode: EloMode,
  season?: number,
  me?: string | null,
  game?: GameId,
): Promise<{ rows: EloRow[]; me: EloStanding | null }> {
  const s = season != null ? `&season=${season}` : '';
  const m = me ? `&me=${encodeURIComponent(me)}` : '';
  return getJson(`/api/elo?mode=${mode}${s}${m}${gameParam(game)}`);
}

export interface UserEloStat {
  mode: '1v1' | '2v2';
  rating: number;
  games: number;
  rank: number | null;
}
export interface UserRecordStat {
  mode: 'solo' | 'duo';
  best: number | null;
  rank: number | null;
  replayId: string | null;
}
export interface UserMatchRow {
  matchId: string;
  mode: '1v1' | '2v2';
  alliance: 'red' | 'blue';
  score: number;
  won: boolean;
  ratingBefore: number;
  ratingAfter: number;
  createdAt: string;
}
export interface UserStats {
  userId: string;
  handle: string | null;
  username: string | null;
  /** active supporter membership — the profile header badge. Absent from a
   *  server older than the perk, which renders identically to false. */
  supporter?: boolean;
  /** 'owner' | 'admin' — the staff badge, which replaces the supporter one */
  role?: StaffRole;
  season: number;
  elo: UserEloStat[];
  records: UserRecordStat[];
  match: { played: number; wins: number; losses: number };
  recent: UserMatchRow[];
  /** LIFETIME playtime + games played: this game, and the total across all of them.
   *  Absent from a server older than the tracker, which renders as nothing at all. */
  activity?: { games: number; seconds: number; allGames: number; allSeconds: number };
}

/** One round-trip: a user's whole competitive profile for the current season
 * (ranks computed server-side — no full board pulled to the client). */
export function fetchUserStats(userId: string, season?: number, game?: GameId): Promise<UserStats> {
  const p = new URLSearchParams();
  if (season != null) p.set('season', String(season));
  if (game === 'chain') p.set('game', 'chain');
  const qs = p.toString();
  return getJson(`/api/user/${encodeURIComponent(userId)}/stats${qs ? `?${qs}` : ''}`);
}

export interface GlobalStats {
  users: number;
  /** total games played — COMBINED across every game (the homepage headline) */
  games: number;
  byCategory: { solo: number; duo: number; '1v1': number; '2v2': number };
  /** games played PER GAME (DECODE + Chain Reaction tracked separately); the
   * homepage sums these into `games`. Absent from older servers. */
  byGame?: Partial<Record<GameId, number>>;
}

/** site-wide totals for the homepage (players + games played, by category) */
export function fetchGlobalStats(): Promise<GlobalStats> {
  return getJson(`/api/stats`);
}

/** every live RANKED match currently running (for the "Watch Live" list). Each
 * `room` code is spectated via `LobbyClient.spectate`. Custom and record rooms are
 * deliberately absent — they are reached by code (`fetchLiveRoom`). */
export function fetchLiveRooms(): Promise<{ region: string; rooms: LiveRoom[] }> {
  return getJson(`/api/live`);
}

/**
 * Look up ONE live match by its room code — used to spectate a custom game, and to
 * find the region hosting a friend's match.
 *
 * Resolves to null when nothing is live under that code (a finished match, a typo,
 * a lobby that never started). The `region` on the result is what the spectate
 * socket must be opened with: a custom code carries no region prefix of its own, so
 * without it the connection lands on the wrong machine and the room "does not exist".
 */
export async function fetchLiveRoom(code: string): Promise<LiveRoom | null> {
  try {
    const r = await getJson<{ room: LiveRoom }>(`/api/room?code=${encodeURIComponent(code)}`);
    return r.room ?? null;
  } catch {
    return null; // 404 (not live) and an unreachable server read the same here
  }
}

export interface Presence {
  /** open sockets to the game server (people engaged with multiplayer — solo /
   * free-drive players never connect, so this is "who's around to play with") */
  online: number;
  /** distinct authenticated users currently connected */
  signedIn: number;
  /**
   * Waiting players per bucket, EVERY GAME COMBINED.
   *
   * Kept for compatibility, and deliberately not what the UI shows: pairing is
   * bucketed by game, so this number told a DECODE player that a Chain Reaction
   * queuer was waiting for them. Read `gameQueues` instead.
   */
  queues: { '1v1': number; '2v2': number };
  /** waiting players per bucket, SPLIT BY GAME — the only version a player can act
   *  on. Absent from servers older than this field; callers fall back to `queues`. */
  gameQueues?: Record<string, { '1v1': number; '2v2': number }>;
  /** the live admin notice (scheduled restart / info), or null — mirrors the
   * WebSocket `serverNotice` so disconnected pages can show the banner too */
  notice?: { kind: 'restart' | 'info'; message: string; until?: number } | null;
  /** a scheduled MAINTENANCE window, or null. `biting` is whether it is in force
   *  right now — an armed window with a future start announces itself first. */
  maintenance?: {
    startsAt: number | null;
    endsAt: number | null;
    message: string;
    biting: boolean;
  } | null;
  /** what THIS deploy can honour (see SERVER_CAPS in protocol.ts). One Fly app
   * serves every client build, so a new client checks here before offering
   * something an older server would mishandle rather than ignore. */
  caps?: string[];
}

/**
 * One-shot, cached read of the server's capabilities.
 *
 * Cached for the page's lifetime because the answer can't change under a running
 * client: a redeploy drops every socket, and the version gate reloads the page on
 * a new build. A FAILED read resolves to no capabilities and is not cached, so a
 * later call retries — and the safe direction is exactly that one, since every
 * caller uses this to decide whether to OFFER something. A hidden feature is
 * recoverable; a silently mismatched ranked match is not.
 */
let capsCache: Promise<string[]> | null = null;
export function serverCaps(): Promise<string[]> {
  if (!capsCache) {
    capsCache = fetchPresence()
      .then((p) => (Array.isArray(p.caps) ? p.caps : []))
      .catch(() => {
        capsCache = null;
        return [];
      });
  }
  return capsCache;
}

/**
 * Live presence: who's online + how deep each ranked queue is, so a player can
 * see it BEFORE queueing. Cheap JSON off the same host; poll it (usePresence).
 *
 * `full` asks for a FRESH aggregate rather than a cached one. The count is always
 * real either way; a server with nobody connected just holds its last read longer
 * (~45s) so one browsing visitor costs about a query a minute instead of one every
 * 8 seconds. Pass `full` where the number drives a decision rather than decorating
 * one - ranked queue depth - and leave it off for the ambient chip.
 */
export function fetchPresence(full = false): Promise<Presence> {
  return getJson(`/api/presence${full ? '?full=1' : ''}`);
}

export interface PublicProfile extends BadgeFields {
  userId: string;
  handle: string | null;
  username: string | null;
}

/** a user's public profile (display handle + unique username), keyed by user id */
export function fetchProfile(userId: string): Promise<PublicProfile> {
  return getJson(`/api/user/${encodeURIComponent(userId)}`);
}

/** a public profile by its username (the /profile/<username> page). Rejects on 404. */
export function fetchProfileByUsername(username: string): Promise<PublicProfile> {
  return getJson(`/api/profile/${encodeURIComponent(username)}`);
}

/** one user's full stats by username (the public profile page). Rejects on 404. */
export function fetchUserStatsByUsername(username: string, season?: number): Promise<UserStats> {
  const s = season != null ? `?season=${season}` : '';
  return getJson(`/api/profile/${encodeURIComponent(username)}/stats${s}`);
}

// ---- unified match history (Career + public profile) -----------------------

export interface MatchHistoryPlayer extends BadgeFields {
  userId: string;
  handle: string;
  username: string | null;
  alliance: 'red' | 'blue' | null; // null for record-run partners
}
export interface MatchHistoryEntry {
  kind: 'versus' | 'record';
  id: string;
  mode: string; // '1v1'|'2v2' (versus) or 'solo'|'duo' (record)
  ranked: boolean | null; // versus only
  drivetrain: string | null; // record only
  createdAt: string;
  replayId: string | null;
  score: number;
  /** both alliances' final totals (versus only; null for record runs) */
  redScore: number | null;
  blueScore: number | null;
  won: boolean | null; // versus only
  eloBefore: number | null;
  eloAfter: number | null;
  players: MatchHistoryPlayer[];
}
export interface MatchHistoryPage {
  rows: MatchHistoryEntry[];
  total: number;
  offset: number;
  limit: number;
}
/** filter/paging options for the match history */
export interface MatchHistoryOpts {
  season?: number;
  offset?: number;
  limit?: number;
  type?: 'all' | 'ranked' | 'custom' | 'solo' | 'duo';
  result?: 'all' | 'win' | 'loss';
  game?: GameId;
}
function historyQuery(o: MatchHistoryOpts): string {
  const p = new URLSearchParams();
  if (o.season != null) p.set('season', String(o.season));
  if (o.offset) p.set('offset', String(o.offset));
  if (o.limit != null) p.set('limit', String(o.limit));
  if (o.type && o.type !== 'all') p.set('type', o.type);
  if (o.result && o.result !== 'all') p.set('result', o.result);
  if (o.game === 'chain') p.set('game', 'chain');
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** a signed-in user's paginated match history (by user id — "my Career") */
export function fetchUserMatches(
  userId: string,
  opts: MatchHistoryOpts = {},
): Promise<MatchHistoryPage> {
  return getJson(`/api/user/${encodeURIComponent(userId)}/matches${historyQuery(opts)}`);
}

/** a public player's paginated match history (by username — profile page) */
export function fetchUserMatchesByUsername(
  username: string,
  opts: MatchHistoryOpts = {},
): Promise<MatchHistoryPage> {
  return getJson(`/api/profile/${encodeURIComponent(username)}/matches${historyQuery(opts)}`);
}

/** Public username format: 4–20 lowercase letters/digits. Mirrors the server
 * (`server/api.ts` USERNAME_RE) and the DB unique index. */
export const USERNAME_RE = /^[a-z0-9]{4,20}$/;

/** is a username validly-formatted AND free? (server-checked; format-checks
 * locally first so a bad string never hits the network) */
export async function checkUsername(
  username: string,
): Promise<{ valid: boolean; available: boolean }> {
  const u = username.trim().toLowerCase();
  if (!USERNAME_RE.test(u)) return { valid: false, available: false };
  const base = gameServerHttpUrl();
  if (!base) return { valid: true, available: true }; // no server ⇒ can't check; allow
  try {
    const res = await fetch(base + `/api/username-available?u=${encodeURIComponent(u)}`);
    if (!res.ok) return { valid: true, available: false };
    return (await res.json()) as { valid: boolean; available: boolean };
  } catch {
    return { valid: true, available: false };
  }
}

/** claim the signed-in user's unique username (server verifies the JWT + uniqueness).
 * Throws with the server's message (e.g. "That username is taken.") on failure. */
export async function updateUsername(username: string): Promise<{ username: string }> {
  const base = gameServerHttpUrl();
  if (!base) throw new Error('Setting a username needs the game server (VITE_GAME_SERVER_URL).');
  const token = await getAuthToken();
  if (!token) throw new Error('Please sign in again.');
  const res = await fetch(base + '/api/user/username', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ username: username.trim().toLowerCase() }),
  });
  const data = (await res.json().catch(() => ({}))) as { username?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}`);
  return { username: data.username ?? username.trim().toLowerCase() };
}

/** fetch the signed-in user's synced settings blob (null if never saved) */
export async function fetchAccountSettings(): Promise<unknown | null> {
  const base = gameServerHttpUrl();
  if (!base) return null;
  const token = await getAuthToken();
  if (!token) return null;
  const res = await fetch(base + '/api/user/settings', {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { settings?: unknown };
  return data.settings ?? null;
}

/** save the signed-in user's settings blob (best-effort; server verifies JWT) */
export async function saveAccountSettings(settings: unknown): Promise<void> {
  const base = gameServerHttpUrl();
  if (!base) return;
  const token = await getAuthToken();
  if (!token) return;
  await fetch(base + '/api/user/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ settings }),
  });
}

/** set the signed-in user's OWN display name (server verifies the Neon Auth JWT) */
export async function updateHandle(handle: string): Promise<{ userId: string; handle: string }> {
  const base = gameServerHttpUrl();
  if (!base) throw new Error('Changing your name needs the game server (VITE_GAME_SERVER_URL).');
  const token = await getAuthToken();
  if (!token) throw new Error('Please sign in again.');
  const res = await fetch(base + '/api/user/handle', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ handle }),
  });
  const data = (await res.json().catch(() => ({}))) as { handle?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}`);
  return { userId: '', handle: data.handle ?? handle };
}

export function fetchReplay(id: string): Promise<Replay> {
  return getJson(`/api/replay/${id}`);
}

// ---- announcements (patch notes / new season / new act) --------------------

export type AnnouncementKind = 'patch' | 'season' | 'act';
export interface Announcement {
  id: string;
  kind: AnnouncementKind;
  title: string;
  /** newline-separated bullet lines (rendered as a list) */
  body: string;
  /** optional headline for the cinematic season/act reveal */
  tagline: string | null;
  publishedAt: string;
}

/** recent active announcements (newest first). Empty when no server/DB. Never
 * throws — the announcements gate is best-effort and must not break the app. */
export async function fetchAnnouncements(limit = 12): Promise<Announcement[]> {
  const base = gameServerHttpUrl();
  if (!base) return [];
  try {
    const res = await fetch(base + `/api/announcements?limit=${limit}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { announcements?: Announcement[] };
    return data.announcements ?? [];
  } catch {
    return [];
  }
}

/** publish an announcement (admin only; server re-authorizes). */
export async function adminPublishAnnouncement(input: {
  kind: AnnouncementKind;
  title: string;
  body: string;
  tagline?: string;
}): Promise<Announcement | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  const res = await fetch(base + '/api/admin/announcement', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { announcement?: Announcement };
  return data.announcement ?? null;
}

/** retire an announcement (soft delete — stops appearing in the feed). */
export async function adminDeleteAnnouncement(id: string): Promise<boolean> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return false;
  const res = await fetch(base + '/api/admin/announcement/delete?id=' + encodeURIComponent(id), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  return res.ok;
}

// ---- seasons ---------------------------------------------------------------

export interface SeasonInfo {
  /** internal balance_version key */
  season: number;
  /** grouping era; 0 = beta/pre-season, then 1-indexed */
  act: number;
  /** 1-indexed ordinal of this season within its act (for display) */
  seasonNo: number;
  /** admin's custom title, or null to use the structured "Act X · Season Y" */
  name: string | null;
  active: boolean;
  startedAt: string;
  records: number;
  matches: number;
}

/** all seasons (newest first) + which one is live, for the board's season picker */
export function fetchSeasons(game?: GameId): Promise<{ current: number; seasons: SeasonInfo[] }> {
  return getJson(`/api/seasons${game === 'chain' ? '?game=chain' : ''}`);
}

// ---- admin (authorized server-side by ADMIN_USER_IDS against your auth JWT) ----

/** whether the signed-in user is an admin (+ their userId, so you can find the
 * UUID to put in ADMIN_USER_IDS). Safe for anyone to call — false when signed out. */
export async function fetchAdminStatus(): Promise<{ isAdmin: boolean; userId: string | null }> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return { isAdmin: false, userId: null };
  try {
    const res = await fetch(base + '/api/admin/status', { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return { isAdmin: false, userId: null };
    return (await res.json()) as { isAdmin: boolean; userId: string | null };
  } catch {
    return { isAdmin: false, userId: null };
  }
}

/**
 * The operator view of who is on the service right now.
 *
 * Deliberately scoped (server: GET /api/admin/presence). Signed-in accounts carry
 * only state that is already public or already shown to their own friends;
 * anonymous sessions are COUNTS with no identifier; nobody's screen or menu is
 * reported; and there is no history, because the source row is a ~5s snapshot that
 * overwrites itself.
 */
export interface AdminPresencePlayer {
  userId: string;
  /** how many SOCKETS this account holds — one player with two tabs is two
   *  sessions and one account, which is why the tiles need both numbers */
  sessions?: number;
  handle: string | null;
  username: string | null;
  act: 'menu' | 'lobby' | 'match';
  room?: string;
  queue?: '1v1' | '2v2';
  queuedS?: number;
  /** the game they are QUEUED for, which can differ from the one they are in */
  queueGame?: string;
  game?: string;
}
/** ONE anonymous session. `id` is the server's per-socket connection id: not an IP,
 *  not a fingerprint, gone when the socket closes. See 0024_presence_guests.sql. */
export interface AdminPresenceGuest {
  id: string;
  act: 'menu' | 'lobby' | 'match';
  room?: string;
  game?: string;
}
export interface AdminAnonBucket {
  total: number;
  inMatch: number;
  inLobby: number;
  idle: number;
}
export interface AdminMachineRow {
  machine: string;
  region: string;
  online: number;
  updatedAt?: string;
  players: AdminPresencePlayer[];
  guests: AdminPresenceGuest[];
  anon: AdminAnonBucket;
}
export interface AdminPresence {
  region: string;
  machines: AdminMachineRow[];
  local: AdminMachineRow;
  rooms: LiveRoom[];
  queues: Record<string, number>;
}

export interface MaintenanceWindow {
  active: boolean;
  startsAt: number | null;
  endsAt: number | null;
  message: string;
}

export async function adminFetchMaintenance(): Promise<{ maintenance: MaintenanceWindow; biting: boolean } | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  try {
    const res = await fetch(base + '/api/admin/maintenance', {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { ok: boolean; maintenance: MaintenanceWindow; biting: boolean };
    return j.ok ? { maintenance: j.maintenance, biting: j.biting } : null;
  } catch {
    return null;
  }
}

export async function adminSetMaintenance(w: MaintenanceWindow): Promise<boolean> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return false;
  const q = new URLSearchParams({ active: w.active ? '1' : '0', msg: w.message });
  if (w.startsAt) q.set('startsAt', String(w.startsAt));
  if (w.endsAt) q.set('endsAt', String(w.endsAt));
  try {
    const res = await fetch(base + '/api/admin/maintenance?' + q.toString(), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false;
    return ((await res.json()) as { ok: boolean }).ok === true;
  } catch {
    return false;
  }
}

export async function adminFetchPresence(): Promise<AdminPresence | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  try {
    const res = await fetch(base + '/api/admin/presence', {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as AdminPresence;
  } catch {
    return null;
  }
}

/** one finished game in the admin's "Recent games" list. A finished match can't be
 *  spectated, so `replayId` (when the match saved one) is what the row opens. */
export interface AdminMatchRow {
  kind: 'versus' | 'record';
  id: string;
  game: GameId;
  mode: string;
  ranked: boolean | null;
  createdAt: string;
  replayId: string | null;
  balanceVersion: number;
  redScore: number | null;
  blueScore: number | null;
  score: number | null;
  players: { userId: string; handle: string; alliance: 'red' | 'blue' | null }[];
}

/** the most recently finished games service-wide (admin only) */
export async function adminFetchMatches(limit = 40, game?: GameId): Promise<AdminMatchRow[] | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  const qs = new URLSearchParams({ limit: String(limit) });
  if (game) qs.set('game', game);
  try {
    const res = await fetch(`${base}/api/admin/matches?${qs.toString()}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return ((await res.json()) as { matches: AdminMatchRow[] }).matches;
  } catch {
    return null;
  }
}

/** the moderation queue: one row per reported player, most recently reported first */
/** one row of the account-standing ledger, as the server sends it */
export interface StandingEvent {
  id: string;
  kind: string;
  points: number;
  scoreAfter: number;
  cooldownMin: number;
  ratingCharge: number;
  game: string | null;
  at: string;
}

export interface StandingInfo {
  score: number;
  /** epoch ms the ranked queue reopens, or null */
  restrictedUntil: number | null;
}

/**
 * THIS account's standing and the offences behind it.
 *
 * Self-only by construction — the endpoint takes no user parameter, so there is no version
 * of this call that reads someone else's standing. Null (signed out, no server, no database)
 * simply hides the panel: a player with no account has nothing to be in bad standing about.
 */
export async function fetchStanding(): Promise<{ standing: StandingInfo | null; events: StandingEvent[] }> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return { standing: null, events: [] };
  try {
    const res = await fetch(`${base}/api/standing`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return { standing: null, events: [] };
    const body = (await res.json()) as { standing: StandingInfo | null; events?: StandingEvent[] };
    return { standing: body.standing ?? null, events: body.events ?? [] };
  } catch {
    return { standing: null, events: [] };
  }
}

export async function adminFetchReports(): Promise<ReportedUser[] | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  try {
    const res = await fetch(`${base}/api/admin/reports`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return ((await res.json()) as { users: ReportedUser[] }).users ?? [];
  } catch {
    return null;
  }
}

/** one player's reports AND their recent matches — the drill-down. Both in one request
 *  because a moderator cannot judge a cheating report without watching a match. */
export async function adminFetchReportedUser(userId: string): Promise<{
  reports: ReportRow[];
  matches: ModMatch[];
  standing: StandingInfo | null;
  standingEvents: StandingEvent[];
} | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  try {
    const res = await fetch(`${base}/api/admin/reports?user=${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      reports: ReportRow[]; matches: ModMatch[];
      standing?: StandingInfo | null; standingEvents?: StandingEvent[];
    };
    return { ...body, standing: body.standing ?? null, standingEvents: body.standingEvents ?? [] };
  } catch {
    return null;
  }
}

/** one of a reported player's recent matches, with the replay a moderator watches */
export interface ModMatch {
  matchId: string;
  replayId: string | null;
  game: GameId;
  mode: string;
  ranked: boolean | null;
  createdAt: string;
  score: number;
  won: boolean | null;
}

/** triage every OPEN report against a player */
export async function adminSetReportStatus(
  userId: string,
  status: 'reviewed' | 'dismissed',
): Promise<boolean> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return false;
  try {
    const res = await fetch(
      `${base}/api/admin/reports?user=${encodeURIComponent(userId)}&status=${status}`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` } },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** broadcast a scheduled-restart countdown to every connected client */
export async function adminAnnounce(seconds: number, message: string): Promise<boolean> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return false;
  const q = new URLSearchParams({ seconds: String(Math.max(0, Math.round(seconds))), msg: message });
  const res = await fetch(base + '/api/admin/announce?' + q.toString(), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  return res.ok;
}

/** clear a pending restart notice */
export async function adminCancelNotice(): Promise<boolean> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return false;
  const res = await fetch(base + '/api/admin/announce?cancel=1', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  return res.ok;
}

/** archive the live boards and open a fresh period; `newAct` opens a new ACT
 * (else a new season in the current act). Returns the new balance_version. */
export async function adminStartSeason(
  name?: string,
  opts?: { newAct?: boolean },
): Promise<number | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  const params = new URLSearchParams();
  if (name && name.trim()) params.set('name', name.trim());
  if (opts?.newAct) params.set('act', 'new');
  const qs = params.toString() ? `?${params.toString()}` : '';
  const res = await fetch(base + '/api/admin/season/start' + qs, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { season?: number };
  return data.season ?? null;
}

/** delete the replays of an archived season (omit `season` to purge every one
 * before the live season). Boards stay; those runs just stop being watchable. */
export async function adminPurgeReplays(season?: number): Promise<number | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  const q = season != null ? '?season=' + season : '';
  const res = await fetch(base + '/api/admin/season/purge-replays' + q, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { freed?: number };
  return data.freed ?? 0;
}

// ---- admin moderation: leaderboard records + display names ------------------

/** one moderation row: the best run per player in a bucket, with its record id */
export interface AdminRecordRow {
  recordId: string;
  userId: string;
  handle: string;
  score: number;
  drivetrain: string;
  replayId: string | null;
  createdAt: string;
}

/** fetch the moderation view of a record-board bucket (live season) */
export async function adminFetchRecords(
  mode: 'solo' | 'duo',
  drivetrain: string,
  limit = 100,
): Promise<AdminRecordRow[]> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return [];
  const q = new URLSearchParams({ mode, drivetrain, limit: String(limit) });
  const res = await fetch(base + '/api/admin/records?' + q.toString(), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = (await res.json().catch(() => ({}))) as { rows?: AdminRecordRow[] };
  return data.rows ?? [];
}

/** delete one record run (+ its replay) by id */
export async function adminDeleteRecord(id: string): Promise<boolean> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return false;
  const res = await fetch(base + '/api/admin/record/delete?id=' + encodeURIComponent(id), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  return res.ok;
}

/** delete EVERY record run by a user (confirmed cheater); returns count removed */
export async function adminClearUserRecords(userId: string): Promise<number | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  const res = await fetch(base + '/api/admin/user/records/clear?userId=' + encodeURIComponent(userId), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { removed?: number };
  return data.removed ?? 0;
}

/** one row of the admin user search — now also the supporter console */
export interface AdminUserRow {
  userId: string;
  handle: string;
  username?: string | null;
  /** a PAID membership. Deliberately not the entitled-or-staff predicate the rest
   *  of the app uses: this row is where an admin decides whether to grant months,
   *  and a colleague showing as a supporter with no expiry would mislead exactly
   *  there. Staff are identified by `role` instead. */
  supporter?: boolean;
  supporterUntil?: string | null;
  /** a Ko-fi payer address is linked, so this account renews automatically */
  autoRenews?: boolean;
  role?: StaffRole | null;
}

/** search profiles by handle (substring), exact userId, or exact username */
export async function adminSearchUsers(query: string): Promise<AdminUserRow[]> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token || !query.trim()) return [];
  const res = await fetch(base + '/api/admin/users?q=' + encodeURIComponent(query.trim()), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = (await res.json().catch(() => ({}))) as { users?: AdminUserRow[] };
  return data.users ?? [];
}

/** POST to an admin route with the signed-in token; null when not authorized */
async function adminPost<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  const res = await fetch(base + path + '?' + new URLSearchParams(params).toString(), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as T | null;
}

/** comp a supporter membership (contributor, botched payment, goodwill) */
export function adminGrantSupporter(
  userId: string,
  months: number,
  note = '',
): Promise<{ until: string | null } | null> {
  return adminPost('/api/admin/supporter/grant', { userId, months: String(months), note });
}

/** end a membership now — chargeback, refund, or a comp given in error */
export function adminRevokeSupporter(
  userId: string,
  note = '',
): Promise<{ revoked: boolean } | null> {
  return adminPost('/api/admin/supporter/revoke', { userId, note });
}

/** flag a Ko-fi payment as charged back. Does NOT revoke — that is a second,
 *  deliberate decision, because the membership may cover other payments too. */
export function adminRefundPayment(txn: string): Promise<{ ok: boolean } | null> {
  return adminPost('/api/admin/supporter/refund', { txn });
}

export interface SupporterGrantRow {
  source: 'kofi' | 'admin' | 'revoke';
  months: number;
  until: string | null;
  note: string | null;
  createdAt: string;
}

/** why does this account have a membership? (audit trail, newest first) */
export async function adminSupporterHistory(userId: string): Promise<SupporterGrantRow[]> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return [];
  const res = await fetch(
    base + '/api/admin/supporter/history?userId=' + encodeURIComponent(userId),
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return [];
  const data = (await res.json().catch(() => ({}))) as { grants?: SupporterGrantRow[] };
  return data.grants ?? [];
}

/** force a user's display name to a clean value; returns the saved handle or null */
export async function adminRenameUser(userId: string, handle: string): Promise<string | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  const q = new URLSearchParams({ userId, handle: handle.trim() });
  const res = await fetch(base + '/api/admin/user/rename?' + q.toString(), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { handle?: string };
  return data.handle ?? null;
}

// ---- friends ---------------------------------------------------------------

/** a friend's presence, as resolved BY THE SERVER. `online` already accounts for
 * an 'invisible' friend (they arrive as a plain offline row with no last-seen),
 * so there is no client-side filtering to forget. */
/** what a friend is doing right now, for a chess.com-style activity line. Only
 * meaningful while `online`; null otherwise. */
export type Activity = 'menu' | 'lobby' | 'match';

export interface FriendRow extends BadgeFields {
  userId: string;
  handle: string;
  username: string | null;
  online: boolean;
  /** 'dnd' shows a red dot; null = plain */
  status: 'dnd' | null;
  /** coarse seconds since last seen — null when online or never seen. Already
   * rounded server-side to the buckets the UI renders. */
  offlineSeconds: number | null;
  /** 'menu' | 'lobby' | 'match' while online; null when offline/invisible/unknown */
  activity: Activity | null;
  /** which game the friend is in — only set alongside `activity` */
  game: GameId | null;
  /**
   * The match to SPECTATE, when this friend is in one that is actually running.
   *
   * Absent in a lobby, absent once the match ends, and absent for an invisible
   * friend. `region` is required to open the spectate socket — a custom room's
   * code carries no region of its own. Optional on the wire: a server older than
   * this feature simply never sends it and no Watch button appears.
   */
  watch?: { room: string; region: string; ranked: boolean };
}

export type PresenceStatus = 'online' | 'dnd' | 'invisible';

/** a "come join my room" invite from a friend, addressed to the caller. Carries
 * everything `Lobby`'s `join()`/`config` need to auto-join, same shape as a
 * manually-typed room code + the room's `RoomConfig`. */
export interface RoomInvite {
  id: string;
  from: PublicProfile;
  /** the room code to join — EXCEPT for a rated format, where there is no room to
   * join and this is the party token both sides hand the matchmaker instead */
  room: string;
  game: GameId;
  kind: 'versus' | 'record';
  record: 'solo' | 'duo' | null;
  /** what was offered (see ChallengeFormat). Null on challenges sent by a client
   * older than formats — read as the historical casual-versus meaning. */
  format: string | null;
  /**
   * WHICH MACHINE the room is on — the sender's region.
   *
   * One app runs in several regions and a custom room code is BARE: unlike a
   * matchmaker-staged `iad-abc123`, there is nothing in it for the proxy to route on. So a
   * recipient who connects without this lands on whichever machine is nearest to THEM, and
   * if the two players picked different servers they each end up alone in a different room
   * that happens to share a code. Null ⇒ an older sender; the client falls back to its own
   * region, which is the behaviour that produced the split in the first place.
   */
  region?: string | null;
  createdAt: string;
}

/** a challenge the CALLER sent, as they see it: the other party is the recipient,
 * and `declined` is the answer they've been waiting for. */
export interface SentInvite extends Omit<RoomInvite, 'from'> {
  to: PublicProfile;
  declined: boolean;
}

export interface FriendsPayload {
  friends: FriendRow[];
  incoming: PublicProfile[];
  outgoing: PublicProfile[];
  blocked: PublicProfile[];
  invites: RoomInvite[];
  /** challenges the caller SENT and that are still live. Absent from an older
   * server, so every consumer must tolerate undefined. */
  sent?: SentInvite[];
  /** the caller's own self-set status (null = automatic) */
  status: PresenceStatus | null;
}

/** thrown when the server is reachable but has no friends API — an older build
 * than the client (one Fly app serves every client version). The panel renders
 * an "unavailable" state for this rather than an error. */
export class FriendsUnavailableError extends Error {
  constructor() {
    super('friends unavailable');
    this.name = 'FriendsUnavailableError';
  }
}

/**
 * Authenticated JSON call. `getJson` above is the PUBLIC reader — it sends no
 * Authorization header, so a friends read through it would just 401. Everything
 * here needs the Bearer token, hence the separate helper rather than repeating
 * the token dance nine times.
 */
async function authedJson<T>(path: string, init?: RequestInit): Promise<T> {
  const base = gameServerHttpUrl();
  if (!base) throw new FriendsUnavailableError();

  const send = async (force: boolean): Promise<Response> => {
    const token = await getAuthToken(force);
    if (!token) throw new Error('Please sign in again.');
    return fetch(base + path, {
      ...init,
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${token}`,
        ...init?.headers,
      },
    });
  };

  // The token is cached in memory until it nears expiry (see getAuthToken), which
  // is what keeps a polling client off Neon Auth — and therefore off the database
  // it reads. The one case a cache can't predict is a session revoked server-side:
  // the token is still unexpired but no longer accepted. A 401 is exactly that
  // signal, so retry ONCE with a forced refresh before surfacing an error. Only
  // once, so a genuinely signed-out client fails fast instead of looping.
  let res = await send(false);
  if (res.status === 401) res = await send(true);

  // 404 = this server predates the friends API. Distinguished from other errors
  // so the caller can degrade instead of showing a failure.
  if (res.status === 404 && !init?.method) throw new FriendsUnavailableError();
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}`);
  return data as T;
}

/** the caller's friends, requests and blocks. This request also records the
 * caller's own presence server-side — there is no separate ping — including WHAT
 * the caller is doing (`activity`) + which game, so friends see a live activity
 * line. Both are optional; an old server ignores the query params. */
export function fetchFriends(activity?: Activity, game?: GameId): Promise<FriendsPayload> {
  const qs = new URLSearchParams();
  if (activity) qs.set('a', activity);
  if (game) qs.set('g', game);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return authedJson<FriendsPayload>('/api/friends' + suffix);
}

const friendPost = (path: string, username: string): Promise<{ ok?: boolean; outcome?: string }> =>
  authedJson(`/api/friends/${path}`, { method: 'POST', body: JSON.stringify({ username }) });

/** send a request. Resolves to 'accepted' when the target had already sent one
 * to the caller (the server turns that into an immediate friendship). */
export async function sendFriendRequest(username: string): Promise<'sent' | 'accepted'> {
  const r = await friendPost('request', username);
  return r.outcome === 'accepted' ? 'accepted' : 'sent';
}

export const acceptFriendRequest = (username: string) => friendPost('accept', username);
export const declineFriendRequest = (username: string) => friendPost('decline', username);
export const cancelFriendRequest = (username: string) => friendPost('cancel', username);
export const removeFriend = (username: string) => friendPost('remove', username);
export const blockUser = (username: string) => friendPost('block', username);
export const unblockUser = (username: string) => friendPost('unblock', username);

/** set your own presence status (null = automatic) */
export function setPresenceStatus(status: PresenceStatus | null): Promise<unknown> {
  return authedJson('/api/friends/status', {
    method: 'POST',
    body: JSON.stringify({ status }),
  });
}

/** invite a friend to a room by code — must already be friends (server-checked,
 * same as every other friends mutation). `record` only applies when
 * `kind === 'record'`. */
export function inviteToRoom(
  username: string,
  room: string,
  game: GameId,
  kind: 'versus' | 'record',
  record?: 'solo' | 'duo' | null,
  format?: string | null,
  /** the region the sender will HOST the room in — see `RoomInvite.region` */
  region?: string | null,
): Promise<unknown> {
  return authedJson('/api/friends/invite', {
    method: 'POST',
    body: JSON.stringify({
      username, room, game, kind,
      record: record ?? null, format: format ?? null, region: region ?? null,
    }),
  });
}

/** dismiss (or consume, on join) an invite addressed to the caller */
export function dismissRoomInvite(id: string): Promise<unknown> {
  return authedJson('/api/friends/invite/dismiss', {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
}

/** DECLINE a challenge sent to me. Unlike dismiss, the sender is told: the row is
 * marked rather than deleted so their client can say "@you declined" once. */
export function declineRoomInvite(id: string): Promise<unknown> {
  return authedJson('/api/friends/invite/decline', {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
}

/** withdraw a challenge I sent (or clear one I've been told was declined) */
export function cancelRoomInvite(id: string): Promise<unknown> {
  return authedJson('/api/friends/invite/cancel', {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
}

/** public player search — matches the @username or the DISPLAY NAME (min 2 chars).
 *  Feeds both the Records look-up bar and the add-a-friend box. */
export async function searchUsers(query: string): Promise<PublicProfile[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  try {
    const r = await getJson<{ users: PublicProfile[] }>(
      `/api/users/search?q=${encodeURIComponent(q)}`,
    );
    return r.users ?? [];
  } catch {
    return []; // server asleep or older than this client — no results, not an error
  }
}

/** the supporter tier's price, as the SERVER charges it (server/kofi.ts). Read
 *  from the server rather than hardcoded in the UI so the number on the Donate
 *  page can never drift from the number the grant policy actually enforces. */
export interface TierPrice {
  amount: number;
  /** ISO 4217, e.g. 'USD' */
  currency: string;
}

/** an account's paid entitlements. Extend the shape (never replace it) as tiers grow. */
export interface Entitlements {
  /** an active supporter membership — removes ads, unlocks cosmetic perks */
  supporter: boolean;
  /** ISO instant the membership lapses, or null if not a supporter — and always
   *  null for staff, who are entitled by role rather than by a purchase */
  supporterUntil: string | null;
  /** 'owner' | 'admin'. Staff get the supporter perks without paying, so
   *  `supporter` is true while `supporterUntil` stays null; this is what lets the
   *  UI say "included with your role" instead of rendering a lapsed membership. */
  role?: StaffRole;
  /** a Ko-fi payer address is linked, so payments renew with no manual claim */
  autoRenews: boolean;
  /** absent when talking to a server older than the pricing route */
  price?: TierPrice;
}

const NO_ENTITLEMENTS: Entitlements = {
  supporter: false,
  supporterUntil: null,
  autoRenews: false,
};

/**
 * The caller's entitlements. NEVER throws — an ad gate that fails loudly would
 * break the menu for a signed-out player, and a server older than this client
 * (the one Fly app serves every client version) simply 404s this route. Both
 * degrade to "not a supporter", which shows ads; the server independently
 * enforces every perk, so a wrong answer here costs nothing but a few pixels.
 */
export async function fetchEntitlements(): Promise<Entitlements> {
  try {
    const r = await authedJson<Partial<Entitlements>>('/api/user/entitlements');
    return {
      supporter: !!r.supporter,
      supporterUntil: r.supporterUntil ?? null,
      role: r.role === 'owner' || r.role === 'admin' ? r.role : undefined,
      autoRenews: !!r.autoRenews,
      price: r.price,
    };
  } catch {
    return NO_ENTITLEMENTS;
  }
}

/** the tier price for a SIGNED-OUT visitor. Same never-throws contract: the
 *  Donate page falls back to "see Ko-fi for the price" rather than breaking. */
export async function fetchPricing(): Promise<TierPrice | null> {
  try {
    const base = gameServerHttpUrl();
    if (!base) return null;
    const res = await fetch(base + '/api/pricing');
    if (!res.ok) return null;
    const data = (await res.json()) as { price?: TierPrice };
    return data.price && typeof data.price.amount === 'number' ? data.price : null;
  } catch {
    return null;
  }
}

/**
 * Delete the signed-in account and everything DSIM stores about it.
 *
 * Irreversible, so the server demands the literal string `DELETE` in the body —
 * a value no accidental or replayed request carries. Throws on failure: someone
 * who asked for deletion must never be told "done" when it was not.
 */
export async function deleteMyAccount(): Promise<boolean> {
  const r = await authedJson<{ deleted?: boolean }>('/api/user/delete', {
    method: 'POST',
    body: JSON.stringify({ confirm: 'DELETE' }),
  });
  return !!r.deleted;
}

/**
 * Attach a Ko-fi payment to the signed-in account by its transaction id.
 *
 * Unlike `fetchEntitlements` this DOES throw — the user is actively waiting on
 * the result of a payment they made, and silently swallowing "already claimed"
 * or "not found" would leave them staring at a page that never changes. The
 * caller shows the message.
 */
export async function claimKofiPayment(
  transactionId: string,
): Promise<{ ok: boolean; supporterUntil: string | null; months: number }> {
  const r = await authedJson<{ ok?: boolean; supporterUntil?: string | null; months?: number }>(
    '/api/user/claim-kofi',
    { method: 'POST', body: JSON.stringify({ transactionId }) },
  );
  return { ok: !!r.ok, supporterUntil: r.supporterUntil ?? null, months: r.months ?? 0 };
}
