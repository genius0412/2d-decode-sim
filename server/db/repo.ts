import type { Replay } from '../../src/sim/replay';
import type { AssistConfig, GameId, RobotSpec } from '../../src/types';
import type { PendingMatch, PendingRosterEntry } from '../matchTypes';
import { PLACEMENT_GAMES } from '../../src/config';
import {
  STANDING_MAX, HEAL_PER_DAY, HEAL_PER_CLEAN_MATCH, clampScore, type StandingVerdict,
} from '../../src/standing';
import { q, tx } from './pool';

/** every board/period is keyed by game; old callers/rows default to DECODE. */
type Game = GameId;
const g = (game?: Game): Game => game ?? 'decode';

/** the robot configuration a record run used (denormalized onto the row) */
export interface RecordConfig {
  spec: RobotSpec;
  assists: AssistConfig;
  /** in a DUO run, the co-op PARTNER's robot (each driver brings their own build,
   * so a duo can mix drivetrains). Absent for solo runs / legacy rows. */
  partnerSpec?: RobotSpec;
}

/**
 * Data-access for Phase 3 (records, ELO, replays, presets, seasons). The SERVER
 * is the only trusted writer — scores come from the authoritative sim, never a
 * client POST. Every write is stamped with the replay's BALANCE_VERSION (the
 * season key). All calls no-op when the DB is disabled.
 */

// ------------------------------------------------------------- seasons ------
// Periods are PER GAME: each game runs its own Act → Season progression, so DECODE
// and Chain Reaction never share a live season or an act. `game` defaults to DECODE.
/**
 * (game, balanceVersion) pairs this process has already seeded. `ensureSeason` is
 * two WRITES, and `GET /api/seasons` - the leaderboard's season picker, hit on
 * every visit to Records - ran it on every request. In production that made
 * `seasons` the second busiest table in the whole database (121k updates against
 * 8 inserts), all of it re-asserting a row that was already correct.
 *
 * Memoizing is safe precisely because the key IS the season: when an admin rolls a
 * new one, `currentSeasonNumber` returns the new number, which is a new key, so
 * the seed-and-deactivate runs again exactly when it has something to do.
 */
const seasonEnsured = new Set<string>();

export async function ensureSeason(
  balanceVersion: number,
  game?: Game,
  initialAct = 0,
): Promise<void> {
  const key = `${g(game)}:${balanceVersion}`;
  if (seasonEnsured.has(key)) return;
  // No baked-in name — the structured "Act X · Season Y" label is derived in
  // listSeasons. A brand-new game's first row seeds `initialAct` (Chain Reaction
  // starts at Act 1); on conflict we only re-activate — act is left untouched.
  await q(
    `insert into seasons (game, balance_version, act, active) values ($1, $2, $3, true)
     on conflict (game, balance_version) do update set active = true`,
    [g(game), balanceVersion, initialAct],
  );
  await q(`update seasons set active = false where game = $1 and balance_version <> $2`, [
    g(game),
    balanceVersion,
  ]);
  seasonEnsured.add(key);
}

/**
 * The CURRENT season number FOR A GAME. Season is the `balance_version` key, but the
 * live season is DB-controlled so an admin can start a fresh season at runtime WITHOUT
 * a code redeploy (`startNewSeason`). It is the greater of the highest season row for
 * this game and the code's `BALANCE_VERSION` fallback — so a genuine balance bump still
 * rolls the season automatically, and an admin bump wins when there's been no change.
 */
export async function currentSeasonNumber(fallback: number, game?: Game): Promise<number> {
  const rows = await q<{ bv: number | null }>(
    `select max(balance_version) as bv from seasons where game = $1`,
    [g(game)],
  );
  return Math.max(Number(rows[0]?.bv ?? 0), fallback);
}

export interface SeasonRow {
  /** internal balance_version key (stamped on every record/match/replay) */
  season: number;
  /** grouping era; 0 = beta/pre-season, then 1-indexed */
  act: number;
  /** 1-indexed ordinal of this season WITHIN its act (for display) */
  seasonNo: number;
  /** admin's custom title, or null to use the structured "Act X · Season Y" */
  name: string | null;
  active: boolean;
  startedAt: string;
  records: number;
  matches: number;
}

/** every season that exists (a `seasons` row OR any data stamped with it),
 * newest first, with its act + within-act ordinal and how much data it holds. */
export async function listSeasons(game?: Game): Promise<SeasonRow[]> {
  const rows = await q<{
    season: number;
    act: number;
    season_no: number;
    name: string | null;
    active: boolean | null;
    started_at: string | null;
    records: string;
    matches: string;
  }>(
    `with versions as (
       select balance_version as v from seasons where game = $1
       union select balance_version from records where game = $1
       union select balance_version from matches where game = $1
     ),
     rows as (
       select v.v as season,
              coalesce(s.act, 0) as act,
              s.name as name,
              coalesce(s.active, false) as active,
              s.started_at as started_at,
              (select count(*) from records r where r.balance_version = v.v and r.game = $1) as records,
              (select count(*) from matches m where m.balance_version = v.v and m.game = $1) as matches
       from versions v
       left join seasons s on s.balance_version = v.v and s.game = $1
     )
     select season, act, name, active, started_at, records, matches,
            (row_number() over (partition by act order by season))::int as season_no
     from rows
     order by season desc`,
    [g(game)],
  );
  // legacy rows carry the old baked-in "Season N" name — treat those as auto
  // (null) so the structured label wins; keep only genuine custom titles.
  const isAuto = (n: string | null): boolean => !n || /^season\s+\d+$/i.test(n.trim());
  return rows.map((r) => ({
    season: Number(r.season),
    act: Number(r.act),
    seasonNo: Number(r.season_no),
    name: isAuto(r.name) ? null : r.name,
    active: !!r.active,
    startedAt: r.started_at ?? '',
    records: Number(r.records),
    matches: Number(r.matches),
  }));
}

/** Archive the live season and open a fresh one (admin action). The new
 * balance_version is one past the current, so its boards start empty; old
 * seasons stay fully queryable. `bumpAct` opens a new ACT (act++, its season
 * ordinal resets to 1); otherwise it's a new season in the SAME act. `name` is
 * an optional custom title (null ⇒ the structured "Act X · Season Y"). Returns
 * the new version + its act and within-act ordinal. */
export async function startNewSeason(
  fallback: number,
  name?: string,
  bumpAct = false,
  game?: Game,
): Promise<{ season: number; act: number; seasonNo: number }> {
  const next = (await currentSeasonNumber(fallback, game)) + 1;
  const cur = await q<{ act: number | null }>(
    `select act from seasons where game = $1 order by balance_version desc limit 1`,
    [g(game)],
  );
  const act = Number(cur[0]?.act ?? 0) + (bumpAct ? 1 : 0);
  const custom = name && name.trim() ? name.trim() : null;
  await q(
    `insert into seasons (game, balance_version, name, act, active) values ($1, $2, $3, $4, true)
     on conflict (game, balance_version) do update set name = excluded.name, act = excluded.act, active = true`,
    [g(game), next, custom, act],
  );
  await q(`update seasons set active = false where game = $1 and balance_version <> $2`, [g(game), next]);
  const cnt = await q<{ n: number }>(
    `select count(*)::int as n from seasons where game = $1 and act = $2`,
    [g(game), act],
  );
  return { season: next, act, seasonNo: Number(cnt[0]?.n ?? 1) };
}

/** Delete all replays stamped with a given (archived) game×season. The record/match
 * rows survive — their `replay_id` FK is `on delete set null`, so leaderboard
 * entries stay visible, they just stop being watchable. Returns the count freed. */
export async function purgeSeasonReplays(season: number, game?: Game): Promise<number> {
  const rows = await q<{ id: string }>(
    `delete from replays where balance_version = $1 and game = $2 returning id`,
    [season, g(game)],
  );
  return rows.length;
}

// -------------------------------------------------------- announcements -----

export type AnnouncementKind = 'patch' | 'season' | 'act';
export interface AnnouncementRow {
  id: string;
  kind: AnnouncementKind;
  title: string;
  body: string;
  tagline: string | null;
  publishedAt: string;
}

const ANNOUNCEMENT_KINDS: AnnouncementKind[] = ['patch', 'season', 'act'];
const asKind = (k: unknown): AnnouncementKind =>
  ANNOUNCEMENT_KINDS.includes(k as AnnouncementKind) ? (k as AnnouncementKind) : 'patch';

/** publish an announcement (admin only). Returns the created row. */
export async function createAnnouncement(input: {
  kind: string;
  title: string;
  body: string;
  tagline?: string | null;
}): Promise<AnnouncementRow> {
  const rows = await q<{
    id: string;
    kind: string;
    title: string;
    body: string;
    tagline: string | null;
    published_at: string;
  }>(
    `insert into announcements (kind, title, body, tagline)
     values ($1, $2, $3, $4)
     returning id, kind, title, body, tagline, published_at`,
    [asKind(input.kind), input.title, input.body ?? '', input.tagline?.trim() || null],
  );
  const r = rows[0];
  return {
    id: r.id,
    kind: asKind(r.kind),
    title: r.title,
    body: r.body,
    tagline: r.tagline,
    publishedAt: r.published_at,
  };
}

/** recent active announcements, newest first (the client feed + admin list). */
export async function listAnnouncements(limit = 12): Promise<AnnouncementRow[]> {
  const rows = await q<{
    id: string;
    kind: string;
    title: string;
    body: string;
    tagline: string | null;
    published_at: string;
  }>(
    `select id, kind, title, body, tagline, published_at
       from announcements
      where active
      order by published_at desc
      limit $1`,
    [Math.min(50, Math.max(1, limit))],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: asKind(r.kind),
    title: r.title,
    body: r.body,
    tagline: r.tagline,
    publishedAt: r.published_at,
  }));
}

/** retire an announcement (soft delete — it stops appearing in the feed). */
export async function deleteAnnouncement(id: string): Promise<boolean> {
  const rows = await q<{ id: string }>(
    `update announcements set active = false where id = $1 and active returning id`,
    [id],
  );
  return rows.length > 0;
}

// ------------------------------------------------------------ profiles ------

/**
 * Users whose profile row this process has already created. The insert below is
 * `on conflict do nothing` and deliberately never touches `handle` (renames go
 * through `setHandle`), so once it has succeeded for a user it can never do
 * anything again - which makes skipping it exactly equivalent, not merely cheaper.
 *
 * Worth memoizing because `/api/friends` calls this on EVERY poll and a signed-in
 * player polls every 6s: a third of the queries on the busiest authenticated path
 * were provably no-ops. Bounded by the distinct users a machine sees before it
 * auto-stops; a restart simply re-learns them.
 */
const profileEnsured = new Set<string>();

export async function ensureProfile(userId: string, handle: string): Promise<void> {
  if (profileEnsured.has(userId)) return;
  await q(
    `insert into profiles (user_id, handle) values ($1, $2)
     on conflict (user_id) do nothing`,
    [userId, handle],
  );
  profileEnsured.add(userId);
}

export async function setHandle(userId: string, handle: string): Promise<void> {
  await q(`update profiles set handle = $2, updated_at = now() where user_id = $1`, [
    userId,
    handle,
  ]);
}

export interface PublicProfile {
  userId: string;
  handle: string;
  /** unique lowercase [a-z0-9] slug, or null for a legacy profile with none yet */
  username: string | null;
  /**
   * active supporter membership — drives the badge.
   *
   * OPTIONAL because a caller may not have asked for it, and because a client
   * talking to a server older than the feature will not receive it at all. Both
   * cases mean "not asked", which renders identically to false — never as a
   * missing field somewhere upstream.
   */
  supporter?: boolean;
  /**
   * 'owner' | 'admin' for staff, absent otherwise — drives the staff badge.
   *
   * Optional for the same reason `supporter` is. `undefined` means "not asked"
   * and renders as no badge, identically to a null role.
   */
  role?: StaffRole;
}

/** who runs the service. Projected from `ADMIN_USER_IDS` / `OWNER_USER_ID` into
 *  `profiles.role` at boot — see 0020_staff_roles.sql for why it is a column. */
export type StaffRole = 'owner' | 'admin';

/** is this row staff? Shared so "staff" means one thing in every query.
 *  `a` qualifies the column for a joined query — `staffPred('pp.')`. */
const staffPred = (a = ''): string => `${a}role in ('owner', 'admin')`;
const STAFF_PRED = staffPred();

/** narrow whatever the column holds. A value outside the check constraint could
 *  only come from a hand-edited row, and reads as no role. */
export const asRole = (v: unknown): StaffRole | undefined =>
  v === 'owner' || v === 'admin' ? v : undefined;

/**
 * The badge/perk predicate, written once. `supporter_until` is an instant, and the
 * comparison must happen in Postgres — the five regional machines do not share a
 * clock, and a skewed one would show a badge that has already lapsed.
 *
 * STAFF COUNT AS SUPPORTERS, and this expression is the only place that says so.
 * Every perk — no ads, the cosmetic robot fill, the entitlements endpoint — is
 * derived from it, so folding the role in here grants all of them at once and
 * makes it impossible for one surface to disagree with another about whether an
 * admin is entitled.
 */
const supporterPred = (a = ''): string =>
  `((${a}supporter_until is not null and ${a}supporter_until > now()) or ${staffPred(a)})`;
const SUPPORTER_COL = `${supporterPred()} as supporter`;

/**
 * The two badge columns for a JOINED `profiles` row — `badgeCols('p.')`.
 *
 * Every surface that prints a name prints the badge beside it, so every query
 * behind such a surface needs the same two columns, and writing them out by hand
 * is how a board ends up quietly badge-less (which is exactly what happened to
 * the ranked board while the record board had them). `prefix` names a SECOND
 * person in the same row — a duo partner — as `partnerRole`/`partnerSupporter`.
 *
 * `coalesce(..., false)` matters on a LEFT JOIN: a solo run has no partner row,
 * and the predicate over all-NULL columns is NULL, not false.
 */
function badgeCols(a: string, prefix?: string): string {
  const role = prefix ? `"${prefix}Role"` : 'role';
  const sup = prefix ? `"${prefix}Supporter"` : 'supporter';
  return `${a}role as ${role}, coalesce(${supporterPred(a)}, false) as ${sup}`;
}

/**
 * Reconcile `profiles.role` with the environment. Called once per boot, after
 * migrations.
 *
 * The env is the source of truth and this is a projection of it, so the sweep
 * must be SYMMETRIC: an id removed from `ADMIN_USER_IDS` has to lose the badge
 * and the perks, not keep them because nothing ever cleared the row. All five
 * machines run this on boot with the same input, so it is idempotent and
 * order-independent, and it only touches rows whose role is actually wrong.
 *
 * A staff id with no profile row yet is simply not updated; they pick up the role
 * on the next boot after they first sign in (`ensureProfile`), which is soon
 * enough for a badge.
 */
export async function syncStaffRoles(ownerId: string | null, adminIds: string[]): Promise<void> {
  const owner = ownerId && ownerId.trim() ? ownerId.trim() : null;
  // the owner is never also a plain admin — one row, one role
  const admins = [...new Set(adminIds.map((s) => s.trim()).filter((s) => s && s !== owner))];
  const want = `case
      when user_id = $1 then 'owner'
      when user_id = any($2::text[]) then 'admin'
      else null
    end`;
  await q(
    `update profiles set role = ${want}, updated_at = now()
      where role is distinct from (${want})`,
    [owner, admins],
  );
}

/** the staff among `userIds`, as id → role. The parallel of `supportersAmong`,
 *  for badges on a board or roster that was assembled in Node rather than by one
 *  query that could just join `profiles`. */
export async function staffAmong(userIds: string[]): Promise<Map<string, StaffRole>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await q<{ user_id: string; role: string }>(
    `select user_id, role from profiles where user_id = any($1::text[]) and ${STAFF_PRED}`,
    [ids],
  );
  const out = new Map<string, StaffRole>();
  for (const r of rows) {
    const role = asRole(r.role);
    if (role) out.set(r.user_id, role);
  }
  return out;
}

/** a user's public profile (display handle + unique username), or null */
export async function getProfile(userId: string): Promise<PublicProfile | null> {
  const rows = await q<{
    handle: string;
    username: string | null;
    supporter: boolean;
    role: string | null;
  }>(
    `select handle, username, role, ${SUPPORTER_COL} from profiles where user_id = $1`,
    [userId],
  );
  return rows[0]
    ? {
        userId,
        handle: rows[0].handle,
        username: rows[0].username,
        supporter: !!rows[0].supporter,
        role: asRole(rows[0].role),
      }
    : null;
}

/** resolve a public username → profile (the /profile/<username> read path), or null */
export async function getProfileByUsername(username: string): Promise<PublicProfile | null> {
  const rows = await q<{
    user_id: string;
    handle: string;
    username: string | null;
    supporter: boolean;
    role: string | null;
  }>(
    `select user_id, handle, username, role, ${SUPPORTER_COL} from profiles where username = $1`,
    [username],
  );
  const r = rows[0];
  return r
    ? {
        userId: r.user_id,
        handle: r.handle,
        username: r.username,
        supporter: !!r.supporter,
        role: asRole(r.role),
      }
    : null;
}

/** thrown by setUsername when the requested username is already taken */
export class UsernameTakenError extends Error {
  constructor() {
    super('username taken');
    this.name = 'UsernameTakenError';
  }
}

/** claim a username for a user (profile row must already exist — caller ensures
 * it). Usernames are one-per-account and globally unique; a collision throws
 * `UsernameTakenError` (Postgres unique-violation 23505 on profiles_username_key). */
export async function setUsername(userId: string, username: string): Promise<void> {
  try {
    await q(`update profiles set username = $2, updated_at = now() where user_id = $1`, [
      userId,
      username,
    ]);
  } catch (e) {
    if (e && typeof e === 'object' && (e as { code?: string }).code === '23505') {
      throw new UsernameTakenError();
    }
    throw e;
  }
}

/** is a username free to claim? (false if any other user already holds it) */
export async function usernameAvailable(username: string, forUserId?: string): Promise<boolean> {
  const rows = await q<{ user_id: string }>(`select user_id from profiles where username = $1`, [
    username,
  ]);
  return rows.length === 0 || (!!forUserId && rows[0].user_id === forUserId);
}

// -------------------------------------------------- per-account settings ----
/** a user's synced GameSettings blob (client-shaped JSON), or null if unset */
export async function getUserSettings(userId: string): Promise<unknown | null> {
  const rows = await q<{ settings: unknown }>(`select settings from profiles where user_id = $1`, [
    userId,
  ]);
  return rows[0]?.settings ?? null;
}

/** upsert a user's settings blob (profile row is ensured first by the caller) */
export async function saveUserSettings(userId: string, settings: unknown): Promise<void> {
  await q(`update profiles set settings = $2, updated_at = now() where user_id = $1`, [
    userId,
    JSON.stringify(settings),
  ]);
}

// ---------------------------------------------- supporter entitlements ------
/**
 * Supporter membership, backed by Ko-fi. See 0018_supporter.sql for why this is
 * an expiry INSTANT on `profiles` rather than a boolean or a separate table.
 *
 * Every read compares against `now()` IN POSTGRES rather than in Node: the five
 * regional machines do not share a clock, and a skewed one would otherwise grant
 * or revoke a membership early.
 */
export interface SupporterState {
  supporter: boolean;
  supporterUntil: string | null;
  /** a Ko-fi payer address is linked, so payments renew without a manual claim */
  autoRenews: boolean;
  /** staff get the perks without paying — `supporter` is true with no expiry, and
   *  this is what lets the UI say "included with your role" rather than render a
   *  membership that appears to have already run out */
  role?: StaffRole;
}

const NOT_A_SUPPORTER: SupporterState = {
  supporter: false,
  supporterUntil: null,
  autoRenews: false,
};

export async function getSupporter(userId: string): Promise<SupporterState> {
  const rows = await q<{
    until: string | null;
    active: boolean;
    linked: boolean;
    role: string | null;
  }>(
    // `active` folds in the role deliberately: this is what the ad gate and the
    // cosmetics read, so staff must come back entitled here exactly as they do in
    // every badge query. `until` stays the REAL paid expiry (null for staff who
    // never paid) — conflating the two would show an admin a membership date they
    // do not have.
    `select supporter_until as until, role,
            ((supporter_until is not null and supporter_until > now()) or ${STAFF_PRED}) as active,
            (kofi_email is not null) as linked
       from profiles where user_id = $1`,
    [userId],
  );
  if (!rows[0]) return NOT_A_SUPPORTER;
  return {
    supporter: !!rows[0].active,
    supporterUntil: rows[0].until,
    autoRenews: !!rows[0].linked,
    role: asRole(rows[0].role),
  };
}

/** the currently-active supporters among `userIds` — one query, for badges on a
 *  leaderboard page or an in-match roster (a per-row lookup would not do). */
export async function supportersAmong(userIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Set();
  const rows = await q<{ user_id: string }>(
    // staff are entitled without paying — same rule as SUPPORTER_COL, or a roster
    // would badge an admin on the leaderboard and not in the lobby
    `select user_id from profiles
      where user_id = any($1::text[]) and (supporter_until > now() or ${STAFF_PRED})`,
    [ids],
  );
  return new Set(rows.map((r) => r.user_id));
}

/** the SQL that extends a membership. Shared by every grant path so the
 *  extend-don't-overwrite rule can only ever be written once.
 *
 *  EXTENDS rather than overwrites: `greatest(supporter_until, now())` means a
 *  renewal that arrives before the current period ends stacks on the remaining
 *  time instead of silently truncating it to one month from today. Someone who
 *  pays for a year up front, or whose renewal fires a day early, does not lose
 *  what they already bought. */
const EXTEND_SQL = `update profiles
     set supporter_until = greatest(coalesce(supporter_until, now()), now())
                           + ($2 || ' months')::interval,
         updated_at = now()
   where user_id = $1
   returning supporter_until as until`;

/** where a change to `supporter_until` came from — recorded in supporter_grants */
export type GrantSource = 'kofi' | 'admin' | 'revoke';

/**
 * Extend a membership by `months` and write the audit row.
 *
 * Two things can now move `supporter_until` — a Ko-fi payment and an admin — so
 * "why does this account have a membership?" stops being answerable from the
 * profile alone. Every write lands in `supporter_grants` with its source, which
 * is what makes a chargeback investigation possible after the fact.
 */
export async function grantSupporter(
  userId: string,
  months: number,
  source: GrantSource = 'admin',
  note?: string,
): Promise<string | null> {
  const n = Math.max(1, Math.floor(months));
  const rows = await q<{ until: string }>(EXTEND_SQL, [userId, String(n)]);
  const until = rows[0]?.until ?? null;
  if (rows[0]) await logGrant(userId, source, n, until, note ?? null);
  return until;
}

/**
 * End a membership immediately — a chargeback, a refund, or a mistaken comp.
 *
 * Clears the instant rather than winding it back, because there is no honest
 * "before" to restore to: a revoked membership is revoked, and if some of it was
 * legitimately paid for the correct remedy is a fresh admin grant for the part
 * that was. Returns false if there was nothing to revoke.
 */
export async function revokeSupporter(userId: string, note?: string): Promise<boolean> {
  const rows = await q<{ user_id: string }>(
    `update profiles set supporter_until = null, updated_at = now()
      where user_id = $1 and supporter_until is not null
      returning user_id`,
    [userId],
  );
  if (rows.length === 0) return false;
  await logGrant(userId, 'revoke', 0, null, note ?? null);
  return true;
}

async function logGrant(
  userId: string,
  source: GrantSource,
  months: number,
  until: string | null,
  note: string | null,
): Promise<void> {
  await q(
    `insert into supporter_grants (user_id, source, months, until, note)
     values ($1, $2, $3, $4, $5)`,
    [userId, source, months, until, note],
  );
}

/** audit trail for one account, newest first (admin console) */
export interface SupporterGrantRow {
  source: GrantSource;
  months: number;
  until: string | null;
  note: string | null;
  createdAt: string;
}

export async function listSupporterGrants(
  userId: string,
  limit = 20,
): Promise<SupporterGrantRow[]> {
  return q<SupporterGrantRow>(
    `select source, months, until, note, created_at as "createdAt"
       from supporter_grants where user_id = $1
      order by created_at desc limit $2`,
    [userId, limit],
  );
}

// ------------------------------------------------------- Ko-fi payments -----
/** a Ko-fi webhook event, already parsed and priced by `server/kofi.ts` */
export interface KofiEventRow {
  messageId: string;
  kind: string;
  email: string | null;
  transactionId: string | null;
  amount: string | null;
  currency: string | null;
  isSubscription: boolean;
  tierName: string | null;
  /** months this payment is worth — 0 for a tip below the tier */
  months: number;
}

export interface KofiRecordResult {
  /** false when Ko-fi retried an event we already stored */
  fresh: boolean;
  /** user id this was auto-granted to by matching `profiles.kofi_email`, if any */
  autoGrantedTo: string | null;
  /** supporter_until after an auto-grant */
  until: string | null;
}

/**
 * Record a Ko-fi webhook event and, when the payer is already known, grant it.
 *
 * IDEMPOTENCY: `message_id` is the primary key and Ko-fi retries delivery, so the
 * insert itself is the guard — there is no read-then-write race between the five
 * regional machines, and a retry cannot grant a second month. Everything below
 * the insert is skipped unless the insert actually took.
 *
 * AUTO-RENEWAL is the whole point of the email link. A membership's second month
 * arrives as a brand-new event with a new transaction id; without matching it to
 * the account that claimed the first one, the supporter silently lapses and has
 * to paste a new id every 30 days. `profiles.kofi_email` (set by the first manual
 * claim) closes that loop. A payer we have never seen still parks the payment for
 * a manual claim, which is how the FIRST one always works.
 */
export async function recordKofiPayment(p: KofiEventRow): Promise<KofiRecordResult> {
  return tx(async (query) => {
    const inserted = await query<{ message_id: string }>(
      `insert into kofi_payments
         (message_id, kind, email, transaction_id, amount, currency,
          is_subscription, tier_name, months)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (message_id) do nothing
       returning message_id`,
      [
        p.messageId,
        p.kind,
        p.email ? p.email.trim().toLowerCase() : null,
        p.transactionId,
        p.amount,
        p.currency,
        p.isSubscription,
        p.tierName,
        Math.max(0, Math.floor(p.months)),
      ],
    );
    if (inserted.length === 0) return { fresh: false, autoGrantedTo: null, until: null };
    if (!p.email || p.months <= 0) return { fresh: true, autoGrantedTo: null, until: null };

    const owner = await query<{ user_id: string }>(
      `select user_id from profiles where kofi_email = $1`,
      [p.email.trim().toLowerCase()],
    );
    if (!owner[0]) return { fresh: true, autoGrantedTo: null, until: null };
    const userId = owner[0].user_id;

    await query(
      `update kofi_payments
          set claimed_by = $1, claimed_at = now(), auto_claimed = true
        where message_id = $2`,
      [userId, p.messageId],
    );
    const granted = await query<{ until: string }>(EXTEND_SQL, [userId, String(p.months)]);
    const until = granted[0]?.until ?? null;
    await query(
      `insert into supporter_grants (user_id, source, months, until, note)
       values ($1, 'kofi', $2, $3, $4)`,
      [userId, p.months, until, `auto: ${p.messageId}`],
    );
    return { fresh: true, autoGrantedTo: userId, until };
  });
}

export type ClaimOutcome =
  | 'ok'
  | 'not-found'
  | 'already-claimed'
  | 'below-tier'
  | 'email-taken'
  | 'refunded';

export interface ClaimResult {
  outcome: ClaimOutcome;
  until?: string | null;
  /** months granted (outcome 'ok') */
  months?: number;
  /** the payment, so the caller can explain a 'below-tier' rejection precisely */
  payment?: { kind: string; amount: string | null; currency: string | null; isSubscription: boolean; tierName: string | null };
}

/**
 * Attach an unclaimed payment to an account, grant the membership, and LINK the
 * payer's email so every future payment from it renews automatically.
 *
 * One transaction throughout. The claiming UPDATE matches only
 * `claimed_by is null`, so two accounts racing the same transaction id cannot
 * both win — the loser updates zero rows and gets 'already-claimed'.
 *
 * The email link is the part that needs care: it is UNIQUE across profiles, so a
 * second account claiming a payment from an address already linked elsewhere is
 * rejected ('email-taken') rather than allowed to quietly steal the renewal
 * stream of the first. That is also the only thing stopping one $3 subscription
 * from removing ads on an unlimited number of accounts.
 */
export async function claimKofiPayment(
  userId: string,
  transactionId: string,
): Promise<ClaimResult> {
  return tx(async (query) => {
    const found = await query<{
      message_id: string;
      claimed_by: string | null;
      email: string | null;
      months: number;
      kind: string;
      amount: string | null;
      currency: string | null;
      is_subscription: boolean;
      tier_name: string | null;
      refunded_at: string | null;
    }>(
      `select message_id, claimed_by, email, months, kind, amount, currency,
              is_subscription, tier_name, refunded_at
         from kofi_payments where transaction_id = $1`,
      [transactionId],
    );
    const row = found[0];
    if (!row) return { outcome: 'not-found' as const };

    const payment = {
      kind: row.kind,
      amount: row.amount,
      currency: row.currency,
      isSubscription: row.is_subscription,
      tierName: row.tier_name,
    };
    if (row.refunded_at) return { outcome: 'refunded' as const, payment };
    if (row.claimed_by) return { outcome: 'already-claimed' as const, payment };
    // Recorded, but it bought nothing. Deliberately NOT claimed — leaving it open
    // means an admin can still comp it, and the buyer can top up to the tier and
    // claim the larger payment instead.
    if (row.months <= 0) return { outcome: 'below-tier' as const, payment };

    // Link the payer address for auto-renewal. `where kofi_email is null` keeps
    // this from clobbering an address the account already linked (someone whose
    // second subscription came from a different PayPal keeps their first link and
    // simply claims by hand — annoying, but never silently redirecting renewals).
    const email = row.email ? row.email.trim().toLowerCase() : null;
    if (email) {
      const taken = await query<{ user_id: string }>(
        `select user_id from profiles where kofi_email = $1`,
        [email],
      );
      if (taken[0] && taken[0].user_id !== userId) {
        return { outcome: 'email-taken' as const, payment };
      }
      if (!taken[0]) {
        await query(
          `update profiles set kofi_email = $2, updated_at = now()
            where user_id = $1 and kofi_email is null`,
          [userId, email],
        );
      }
    }

    // `returning` is how we detect whether the row was still unclaimed — the Tx
    // helper hands back rows, not a rowCount, so a bare UPDATE would look the
    // same whether it matched or not.
    const claimed = await query<{ message_id: string }>(
      `update kofi_payments set claimed_by = $1, claimed_at = now()
        where transaction_id = $2 and claimed_by is null
        returning message_id`,
      [userId, transactionId],
    );
    if (claimed.length === 0) return { outcome: 'already-claimed' as const, payment };

    const granted = await query<{ until: string }>(EXTEND_SQL, [userId, String(row.months)]);
    const until = granted[0]?.until ?? null;
    await query(
      `insert into supporter_grants (user_id, source, months, until, note)
       values ($1, 'kofi', $2, $3, $4)`,
      [userId, row.months, until, `claim: ${row.message_id}`],
    );
    return { outcome: 'ok' as const, until, months: row.months, payment };
  });
}

/**
 * Mark a payment refunded/charged back. Does NOT revoke on its own — the
 * entitlement is a running instant that may also cover other payments, so the
 * admin decides whether to revoke as a separate act.
 */
export async function refundKofiPayment(transactionId: string): Promise<boolean> {
  const rows = await q<{ message_id: string }>(
    `update kofi_payments set refunded_at = now()
      where transaction_id = $1 and refunded_at is null
      returning message_id`,
    [transactionId],
  );
  return rows.length > 0;
}

// ------------------------------------------------------------- replays ------
/** Persist a replay. `season` (= currentSeasonNumber) is the SEASON stamp used for
 * purge-by-season; `replay.balanceVersion` is the real sim-code version that
 * recorded it (config.BALANCE_VERSION) — stored separately in `sim_version` so the
 * playback gate compares CODE-vs-CODE, not code-vs-season. `game` keys the board
 * this replay belongs to (DECODE vs Chain Reaction). */
export async function saveReplay(replay: Replay, season: number, game?: Game): Promise<string> {
  const rows = await q<{ id: string }>(
    `insert into replays (format, balance_version, sim_version, behaviour_version, seed, ticks, setups, tracks, game)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      replay.format,
      season, // balance_version = SEASON (purge key + index, see 0004)
      replay.balanceVersion, // sim_version = the sim-code version that recorded it
      // ...and behaviour_version = SIM_VERSION, the one the playback gate actually compares.
      // Without it `getReplay` could not set `Replay.sim`, an absent `sim` reads as 0, and
      // EVERY stored replay was refused as stale on every build (see migration 0031).
      replay.sim ?? null,
      replay.seed,
      replay.ticks,
      JSON.stringify(replay.setups),
      JSON.stringify(replay.tracks),
      g(game),
    ],
  );
  return rows[0].id;
}

export async function getReplay(id: string): Promise<Replay | null> {
  const rows = await q<{
    format: number;
    balance_version: number;
    sim_version: number | null;
    behaviour_version: number | null;
    game: Game;
    seed: string;
    ticks: number;
    setups: Replay['setups'];
    tracks: Replay['tracks'];
  }>(
    `select format, balance_version, sim_version, behaviour_version, game, seed, ticks, setups, tracks
       from replays where id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    format: r.format,
    // the gate re-sims: it needs the CODE version. Fall back to balance_version for
    // any legacy row the sim_version backfill somehow missed.
    balanceVersion: r.sim_version ?? r.balance_version,
    // LEFT UNDEFINED when the column is null, which is what a row recorded before 0031 is:
    // the behaviour it ran is genuinely unknown. `replayExact` treats undefined as "cannot
    // promise", so the viewer plays it with a warning rather than asserting a mismatch.
    sim: r.behaviour_version ?? undefined,
    game: r.game ?? 'decode', // picks the sim module to re-simulate (CR vs DECODE)
    mode: 'match',
    seed: Number(r.seed),
    ticks: r.ticks,
    setups: r.setups,
    tracks: r.tracks,
  };
}

// --------------------------------------------------- record-chasing board ---
export interface RecordSubmit {
  userId: string;
  partnerId?: string;
  mode: 'solo' | 'duo';
  drivetrain: string;
  score: number;
  balanceVersion: number;
  replayId: string;
  config?: RecordConfig;
  game?: Game;
}

export async function submitRecord(r: RecordSubmit): Promise<string> {
  const rows = await q<{ id: string }>(
    `insert into records (user_id, partner_id, mode, drivetrain, score, balance_version, replay_id, config, game)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      r.userId,
      r.partnerId ?? null,
      r.mode,
      r.drivetrain,
      r.score,
      r.balanceVersion,
      r.replayId,
      r.config ? JSON.stringify(r.config) : null,
      g(r.game),
    ],
  );
  return rows[0].id;
}

export interface BoardRow {
  userId: string;
  handle: string;
  username: string | null;
  partnerId: string | null;
  /** partner's display name + username (duo runs only; null for solo / unknown) */
  partnerHandle: string | null;
  partnerUsername: string | null;
  score: number;
  replayId: string | null;
  createdAt: string;
  config: RecordConfig | null;
  /** active supporter membership — renders a small badge beside the name */
  supporter?: boolean;
  /** 'owner' | 'admin' — renders the staff badge instead of the supporter one */
  role?: StaffRole;
  /** the PARTNER's badge on a duo row. A duo record is two people's run and both
   *  names are printed, so both names carry their own badge. */
  partnerSupporter?: boolean;
  partnerRole?: StaffRole;
}

/** best score per player within a season × mode × drivetrain, ranked. Pass
 * drivetrain 'overall' (or omit) for the cross-drivetrain board (each player's
 * best run on ANY drivetrain). */
export async function recordLeaderboard(opts: {
  mode: 'solo' | 'duo';
  drivetrain?: string;
  balanceVersion: number;
  limit?: number;
  game?: Game;
}): Promise<BoardRow[]> {
  const params: unknown[] = [opts.balanceVersion, opts.mode, g(opts.game)];
  let dtFilter = '';
  if (opts.drivetrain && opts.drivetrain !== 'overall') {
    params.push(opts.drivetrain);
    dtFilter = `and r.drivetrain = $${params.length}`;
  }
  params.push(opts.limit ?? 100);
  return q<BoardRow>(
    `with best as (
       select distinct on (r.user_id)
         r.user_id, r.partner_id, r.score, r.replay_id, r.created_at, r.config
       from records r
       where r.balance_version = $1 and r.mode = $2 and r.game = $3 ${dtFilter}
       order by r.user_id, r.score desc, r.created_at asc
     )
     select b.user_id as "userId", p.handle, p.username, ${badgeCols('p.')},
            b.partner_id as "partnerId",
            pp.handle as "partnerHandle", pp.username as "partnerUsername",
            ${badgeCols('pp.', 'partner')},
            b.score, b.replay_id as "replayId", b.created_at as "createdAt", b.config
     from best b
       join profiles p on p.user_id = b.user_id
       left join profiles pp on pp.user_id = b.partner_id
     order by b.score desc, b.created_at asc
     limit $${params.length}`,
    params,
  );
}

export async function personalBest(
  userId: string,
  mode: 'solo' | 'duo',
  drivetrain: string,
  balanceVersion: number,
  game?: Game,
): Promise<number | null> {
  // 'overall' = the cross-drivetrain board (no drivetrain filter), matching
  // recordLeaderboard — a mixed-drivetrain duo run's PB is over ALL the user's
  // runs in this mode×season, not one drivetrain.
  const overall = drivetrain === 'overall';
  const rows = await q<{ score: number | null }>(
    `select max(score) as score from records
     where user_id = $1 and mode = $2 and balance_version = $3 and game = $4
       ${overall ? '' : 'and drivetrain = $5'}`,
    overall
      ? [userId, mode, balanceVersion, g(game)]
      : [userId, mode, balanceVersion, g(game), drivetrain],
  );
  return rows[0]?.score ?? null;
}

/** the user's standing in a season × mode × drivetrain bucket, by their BEST
 * score there: 1-based `rank` (ties share the better rank) and the bucket's
 * player `total`. Pass drivetrain 'overall' for the cross-drivetrain board (no
 * drivetrain filter — matching recordLeaderboard), where mixed-drivetrain duos
 * land. Call AFTER submitting the run so it reflects it. */
export async function recordRank(
  userId: string,
  mode: 'solo' | 'duo',
  drivetrain: string,
  balanceVersion: number,
  game?: Game,
): Promise<{ rank: number; total: number }> {
  const overall = drivetrain === 'overall';
  const rows = await q<{ rank: number; total: number }>(
    `with best as (
       select user_id, max(score) as s from records
       where balance_version = $1 and mode = $2 and game = $5
         ${overall ? '' : 'and drivetrain = $4'}
       group by user_id
     ), me as (select s from best where user_id = $3)
     select
       (select count(*) from best)::int as total,
       (1 + (select count(*) from best where s > (select s from me)))::int as rank`,
    [balanceVersion, mode, userId, overall ? null : drivetrain, g(game)],
  );
  return { rank: rows[0]?.rank ?? 1, total: rows[0]?.total ?? 1 };
}

// --------------------------------------------------- admin moderation -------
/** one moderation row: the best run per player in a bucket, WITH its record +
 * replay id so an admin can delete it (the public board omits these ids). */
export interface AdminRecordRow {
  recordId: string;
  userId: string;
  handle: string;
  score: number;
  drivetrain: string;
  replayId: string | null;
  createdAt: string;
}

/** admin: the moderation view of a leaderboard bucket — same best-per-player
 * ranking the public board shows, but carrying the record id for deletion. */
export async function adminListRecords(opts: {
  mode: 'solo' | 'duo';
  drivetrain?: string;
  balanceVersion: number;
  limit?: number;
  game?: Game;
}): Promise<AdminRecordRow[]> {
  const params: unknown[] = [opts.balanceVersion, opts.mode, g(opts.game)];
  let dtFilter = '';
  if (opts.drivetrain && opts.drivetrain !== 'overall') {
    params.push(opts.drivetrain);
    dtFilter = `and r.drivetrain = $${params.length}`;
  }
  params.push(opts.limit ?? 100);
  return q<AdminRecordRow>(
    `with best as (
       select distinct on (r.user_id)
         r.id, r.user_id, r.score, r.drivetrain, r.replay_id, r.created_at
       from records r
       where r.balance_version = $1 and r.mode = $2 and r.game = $3 ${dtFilter}
       order by r.user_id, r.score desc, r.created_at asc
     )
     select b.id as "recordId", b.user_id as "userId", p.handle, b.score,
            b.drivetrain, b.replay_id as "replayId", b.created_at as "createdAt"
     from best b join profiles p on p.user_id = b.user_id
     order by b.score desc, b.created_at asc
     limit $${params.length}`,
    params,
  );
}

/** admin: delete a single record run by id, plus its now-orphaned replay
 * (records → replays is `on delete set null`, so this can't strand a board row).
 * Returns true if a row was deleted. */
export async function deleteRecordById(id: string): Promise<boolean> {
  const rows = await q<{ replay_id: string | null }>(
    `delete from records where id = $1 returning replay_id`,
    [id],
  );
  const r = rows[0];
  if (!r) return false;
  if (r.replay_id) await q(`delete from replays where id = $1`, [r.replay_id]).catch(() => {});
  return true;
}

/** admin: delete EVERY record run by a user (a confirmed cheater) + their
 * replays. The profile + ELO stay; only the record board is cleared. Returns the
 * number of runs removed. */
export async function deleteUserRecords(userId: string): Promise<number> {
  const rows = await q<{ replay_id: string | null }>(
    `delete from records where user_id = $1 returning replay_id`,
    [userId],
  );
  const ids = rows.map((r) => r.replay_id).filter((x): x is string => !!x);
  if (ids.length) await q(`delete from replays where id = any($1)`, [ids]).catch(() => {});
  return rows.length;
}

/** admin: find profiles by handle (case-insensitive substring) or exact userId,
 * for the rename / moderation picker. */
export async function searchProfiles(
  query: string,
  limit = 25,
): Promise<
  {
    userId: string;
    handle: string;
    username: string | null;
    supporter: boolean;
    supporterUntil: string | null;
    /** a Ko-fi payer address is linked, so this account renews automatically */
    autoRenews: boolean;
    role: StaffRole | null;
  }[]
> {
  return q(
    // DELIBERATELY the PAID predicate, not the entitled one the rest of the file
    // uses. This is the admin console's grant/revoke row: an admin deciding
    // whether to add months needs to see the membership actually bought, and
    // showing every colleague as a supporter with no expiry would be misleading
    // exactly where precision matters. `role` is surfaced separately instead.
    `select user_id as "userId", handle, username, role,
            (supporter_until is not null and supporter_until > now()) as supporter,
            supporter_until as "supporterUntil",
            (kofi_email is not null) as "autoRenews"
       from profiles
      where handle ilike $1 or user_id = $2 or username = lower($2)
      order by handle limit $3`,
    [`%${query}%`, query, limit],
  );
}

// ------------------------------------------------------ account deletion ----
/**
 * Delete an account and everything attached to it.
 *
 * The privacy policy promises this, so it has to be a real code path rather than
 * a manual `psql` session someone half-remembers. Most tables hang off
 * `profiles(user_id) on delete cascade` (presets, records, ELO, match
 * participation, invites, friendships, blocks, presence), so deleting the profile
 * row does the bulk of the work in one statement.
 *
 * Three things do NOT cascade and are handled explicitly, in this order:
 *
 *  - `replays` has no user column at all — it is reached only through
 *    `records.replay_id`. Cascading the records first would orphan the replay
 *    rows permanently, so they are collected and deleted BEFORE the profile goes.
 *  - `elo_history` deliberately has no foreign key (it is a per-season snapshot
 *    that must survive a season roll), so it needs its own delete.
 *  - `kofi_payments.claimed_by` is `on delete set null`, which is correct — the
 *    payment record is financial history and outlives the account — but the payer
 *    EMAIL is personal data, so it is scrubbed here rather than left behind.
 *
 * Returns false if there was no such profile.
 */
export async function deleteAccount(userId: string): Promise<boolean> {
  return tx(async (query) => {
    const exists = await query<{ user_id: string }>(
      `select user_id from profiles where user_id = $1`,
      [userId],
    );
    if (!exists[0]) return false;

    // replays first — see the note above about the missing back-reference
    await query(
      `delete from replays
        where id in (select replay_id from records
                      where user_id = $1 and replay_id is not null)`,
      [userId],
    );
    await query(`delete from elo_history where user_id = $1`, [userId]);
    await query(
      `update kofi_payments set email = null where claimed_by = $1`,
      [userId],
    );
    await query(`delete from profiles where user_id = $1`, [userId]);
    return true;
  });
}

// -------------------------------------------------------- robot presets -----
export async function listPresets(
  userId: string,
): Promise<{ slot: number; name: string; spec: RobotSpec }[]> {
  return q<{ slot: number; name: string; spec: RobotSpec }>(
    `select slot, name, spec from robot_presets where user_id = $1 order by slot`,
    [userId],
  );
}

export async function savePreset(
  userId: string,
  slot: number,
  name: string,
  spec: RobotSpec,
): Promise<void> {
  await q(
    `insert into robot_presets (user_id, slot, name, spec) values ($1, $2, $3, $4)
     on conflict (user_id, slot)
       do update set name = excluded.name, spec = excluded.spec, updated_at = now()`,
    [userId, slot, name, JSON.stringify(spec)],
  );
}

export async function deletePreset(userId: string, slot: number): Promise<void> {
  await q(`delete from robot_presets where user_id = $1 and slot = $2`, [userId, slot]);
}

// -------------------------------------------------------------- ranked ELO --
// RANKED ELO is keyed by ACT, not season: ratings persist across seasons within an act and
// only reset on a new act (records reset every season). `actForSeason` maps a season to its act.
export async function actForSeason(balanceVersion: number, game?: Game): Promise<number> {
  const rows = await q<{ act: number | null }>(
    `select act from seasons where game = $1 and balance_version = $2`,
    [g(game), balanceVersion],
  );
  return Number(rows[0]?.act ?? 0);
}

export async function getRating(
  userId: string,
  mode: '1v1' | '2v2',
  act: number,
  game?: Game,
): Promise<number> {
  const rows = await q<{ rating: number }>(
    `select rating from elo_ratings
     where user_id = $1 and mode = $2 and act = $3 and game = $4`,
    [userId, mode, act, g(game)],
  );
  return rows[0]?.rating ?? 1000;
}

/** the full Glicko-2 state (rating + deviation + volatility). Defaults are a
 * fresh, maximally-uncertain player: 1000 / RD 350 / vol 0.06. */
export async function getRatingFull(
  userId: string,
  mode: '1v1' | '2v2',
  act: number,
  game?: Game,
): Promise<{ rating: number; rd: number; vol: number }> {
  const rows = await q<{ rating: number; rd: number; vol: number }>(
    `select rating, rd, vol from elo_ratings
     where user_id = $1 and mode = $2 and act = $3 and game = $4`,
    [userId, mode, act, g(game)],
  );
  const r = rows[0];
  return { rating: r?.rating ?? 1000, rd: r?.rd ?? 350, vol: r?.vol ?? 0.06 };
}

/** Upsert a player's rating for the ACT's board and return their NEW total games on it
 * (games after this match) — the caller uses it to decide the games-based
 * placement / provisional flag for the results screen. */
export async function upsertRating(
  userId: string,
  mode: '1v1' | '2v2',
  act: number,
  rating: number,
  rd: number,
  vol: number,
  game?: Game,
): Promise<number> {
  const rows = await q<{ games: number }>(
    `insert into elo_ratings (user_id, mode, act, game, rating, rd, vol, games)
     values ($1, $2, $3, $4, $5, $6, $7, 1)
     on conflict (user_id, mode, game, act)
       do update set rating = excluded.rating, rd = excluded.rd, vol = excluded.vol,
                     games = elo_ratings.games + 1, updated_at = now()
     returning games`,
    [userId, mode, act, g(game), Math.round(rating), rd, vol],
  );
  return rows[0]?.games ?? 1;
}

/**
 * Charge RATING for a behaviour offence — the LAST rung of the standing escalation, and the
 * only place behaviour is ever allowed to touch the skill number (see src/standing.ts: it is
 * zero above Probation).
 *
 * Deliberately NOT `upsertRating`, for two reasons that both matter:
 *
 *  - `games` is NOT incremented. Abandoning a match is not playing one; counting it would
 *    let a player finish placements — or shrink toward "established" — by quitting.
 *  - `rd` and `vol` are NOT touched. Rating deviation states how well we know someone's
 *    SKILL, and none of this says anything about that. Shrinking RD would mean misbehaving
 *    made the system MORE confident in you, which is backwards; growing it would hand the
 *    offender bigger swings to climb back with, which rewards the behaviour.
 *
 * The rating is floored, so a run of charges cannot print an absurd number. Returns what was
 * actually stored — at the floor that differs from the nominal charge, and the player should
 * be told the truth rather than the sticker price.
 */
export async function chargeRatingForBehaviour(
  userId: string,
  mode: '1v1' | '2v2',
  act: number,
  charge: number,
  floor: number,
  game?: Game,
): Promise<{ before: number; after: number }> {
  const cur = await getRatingFull(userId, mode, act, game);
  const before = Math.round(cur.rating);
  const after = Math.max(floor, before - Math.max(0, Math.round(charge)));
  if (after === before) return { before, after };
  // upsert WITHOUT touching games/rd/vol (see above). A player with no rating row on this
  // board yet gets one seeded at the charged value, games still 0.
  await q(
    `insert into elo_ratings (user_id, mode, act, game, rating, rd, vol, games)
     values ($1, $2, $3, $4, $5, $6, $7, 0)
     on conflict (user_id, mode, game, act)
       do update set rating = excluded.rating, updated_at = now()`,
    [userId, mode, act, g(game), after, cur.rd, cur.vol],
  );
  return { before, after };
}

/**
 * The ranked board this player most recently played on.
 *
 * Used when a behaviour charge has no board of its own — a moderator upholding reports days
 * after the fact. Charging their most recent board puts the penalty where the player will
 * actually see it, instead of on a game/mode they may never open. Null ⇒ they have no ranked
 * history at all, and the charge is dropped rather than invented.
 */
export async function lastRankedBoard(
  userId: string,
): Promise<{ mode: '1v1' | '2v2'; game: Game; act: number } | null> {
  const rows = await q<{ mode: string; game: string; act: number }>(
    `select mode, game, act from elo_ratings
      where user_id = $1 order by updated_at desc limit 1`,
    [userId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    mode: r.mode === '2v2' ? '2v2' : '1v1',
    game: (r.game === 'chain' ? 'chain' : 'decode') as Game,
    act: Number(r.act ?? 0),
  };
}

// ----------------------------------------------------- account standing ------

export interface StandingSnapshot {
  score: number;
  /** epoch ms the ranked queue reopens, or null */
  restrictedUntil: number | null;
}

const snap = (r: { score: number; restricted_until: string | null } | undefined): StandingSnapshot => ({
  score: clampScore(Number(r?.score ?? STANDING_MAX)),
  restrictedUntil: r?.restricted_until ? new Date(r.restricted_until).getTime() : null,
});

/**
 * This account's standing, with TIME HEALING applied on read.
 *
 * The heal is lazy rather than a scheduled job, and it advances `healed_at` by the same
 * whole days it credits — in ONE statement, so two concurrent reads cannot both credit the
 * same day. A cron would be a second thing to deploy and a second thing to be wrong about a
 * player's number.
 *
 * Creates the row on first sight: a player with no row has never offended, which is exactly
 * a full score, and seeding it here means every later write is a plain update.
 */
export async function getStanding(userId: string): Promise<StandingSnapshot> {
  return tx(async (query) => {
    await query(
      `insert into account_standing (user_id) values ($1) on conflict (user_id) do nothing`,
      [userId],
    );
    const healedRows = await query<{ score: number; restricted_until: string | null }>(
      `update account_standing
          set score = least($2::int, score + (floor(extract(epoch from (now() - healed_at)) / 86400)::int * $3::int)),
              healed_at = healed_at + (floor(extract(epoch from (now() - healed_at)) / 86400) || ' days')::interval,
              updated_at = now()
        where user_id = $1
          and score < $2::int
          and now() - healed_at >= interval '1 day'
        returning score, restricted_until`,
      [userId, STANDING_MAX, HEAL_PER_DAY],
    );
    if (healedRows.length) return snap(healedRows[0]);
    const rows = await query<{ score: number; restricted_until: string | null }>(
      `select score, restricted_until from account_standing where user_id = $1`,
      [userId],
    );
    return snap(rows[0]);
  });
}

/** standings for a set of accounts, for the moderation queue. Missing rows are simply
 *  absent — the caller reads that as a full score rather than paying for a write. */
export async function standingsFor(userIds: string[]): Promise<Record<string, StandingSnapshot>> {
  if (!userIds.length) return {};
  const rows = await q<{ user_id: string; score: number; restricted_until: string | null }>(
    `select user_id, score, restricted_until from account_standing where user_id = any($1::text[])`,
    [userIds],
  );
  const out: Record<string, StandingSnapshot> = {};
  for (const r of rows) out[r.user_id] = snap(r);
  return out;
}

/** How many offences of ONE kind this player has inside the escalation window. Counted by
 *  TIME alone — not per season or per board — so a season boundary cannot forgive a pattern
 *  mid-window, and switching between the 1v1 and 2v2 queues does not reset it. */
export async function recentStandingCount(userId: string, kind: string, hours: number): Promise<number> {
  const rows = await q<{ n: number }>(
    `select count(*)::int as n from standing_events
      where user_id = $1 and kind = $2 and at > now() - $3::interval`,
    [userId, kind, `${Math.max(1, Math.floor(hours))} hours`],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Commit one offence: the new score and lock, plus a LEDGER row.
 *
 * Both in one transaction because they are one fact. A score that moved with no event to
 * explain it is exactly the thing that makes a penalty system feel arbitrary, and it is the
 * first thing a player asks a moderator about.
 *
 * `healed_at` is reset to now: healing measures time since the last offence, so an offence
 * has to restart that clock or a player could bank idle days and spend them immediately.
 */
export async function writeStandingEvent(
  userId: string,
  v: StandingVerdict,
  ctx: { game?: Game; mode?: string; roomCode?: string } = {},
): Promise<void> {
  await tx(async (query) => {
    await query(
      `insert into account_standing (user_id, score, restricted_until, healed_at, updated_at)
       values ($1, $2, $3, now(), now())
       on conflict (user_id) do update
         set score = excluded.score,
             restricted_until = greatest(
               coalesce(account_standing.restricted_until, to_timestamp(0)),
               coalesce(excluded.restricted_until, to_timestamp(0))
             ),
             healed_at = now(),
             updated_at = now()`,
      [userId, v.scoreAfter, v.restrictedUntil ? new Date(v.restrictedUntil).toISOString() : null],
    );
    await query(
      `insert into standing_events (user_id, kind, points, score_after, cooldown_min, rating_charge, game, mode, room_code)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [userId, v.kind, v.points, v.scoreAfter, v.cooldownMin, v.ratingCharge,
       ctx.game ? g(ctx.game) : null, ctx.mode ?? null, ctx.roomCode ?? null],
    );
  });
}

/**
 * Credit a completed, clean ranked match.
 *
 * Only touches rows that EXIST and are below the maximum: a player who has never offended
 * needs no row, and creating one for every finished match would write a table's worth of
 * "100" for nothing. The restriction clock is untouched — serving a cooldown and playing
 * your way back are separate things, and a match played before the lock lands should not
 * shorten it.
 */
export async function healStandingForCleanMatch(userIds: string[]): Promise<void> {
  if (!userIds.length) return;
  await q(
    `update account_standing
        set score = least($2::int, score + $3::int), updated_at = now()
      where user_id = any($1::text[]) and score < $2::int`,
    [userIds, STANDING_MAX, HEAL_PER_CLEAN_MATCH],
  );
}

/** the ledger for one player, newest first — the player's own "why" and the moderator's
 *  history in the same shape */
export async function listStandingEvents(userId: string, limit = 20): Promise<StandingEventRow[]> {
  const rows = await q<{
    id: string; kind: string; points: number; score_after: number;
    cooldown_min: number; rating_charge: number; game: string | null; at: string;
  }>(
    `select id, kind, points, score_after, cooldown_min, rating_charge, game, at
       from standing_events where user_id = $1 order by at desc limit $2`,
    [userId, Math.min(100, Math.max(1, Math.floor(limit)))],
  );
  return rows.map((r) => ({
    id: String(r.id),
    kind: r.kind,
    points: Number(r.points),
    scoreAfter: Number(r.score_after),
    cooldownMin: Number(r.cooldown_min),
    ratingCharge: Number(r.rating_charge),
    game: r.game,
    at: r.at,
  }));
}

export interface StandingEventRow {
  id: string;
  kind: string;
  points: number;
  scoreAfter: number;
  cooldownMin: number;
  ratingCharge: number;
  game: string | null;
  at: string;
}

// -------------------------------------------------------- score reports ------

export interface ScoreReportRow {
  id: string;
  matchId: string | null;
  roomCode: string;
  game: string;
  detail: string;
  status: string;
  smite: number;
  createdAt: string;
  reporterId: string;
  reporterHandle: string;
  reporterUsername: string | null;
  /** how many claims this reporter has EVER filed, and how many were rejected — the pattern
   * a moderator needs before deciding whether a claim is a mistake or a habit */
  reporterFiled: number;
  reporterRejected: number;
}

/**
 * File a misscore claim. False when this reporter already has one on this match — the unique
 * index, surfaced as a no-op, because a second look at the same result is the same claim.
 */
export async function submitScoreReport(r: {
  reporterId: string;
  matchId?: string | number | null;
  roomCode?: string;
  game?: Game;
  detail: string;
}): Promise<boolean> {
  const rows = await q<{ id: string }>(
    `insert into score_reports (reporter_id, match_id, room_code, game, detail)
     values ($1, $2, $3, $4, $5)
     on conflict do nothing
     returning id::text as id`,
    [r.reporterId, r.matchId ? String(r.matchId) : null, r.roomCode ?? '', g(r.game ?? 'decode'), r.detail],
  );
  return rows.length > 0;
}

/** the moderation queue: newest first, with the reporter's own history alongside each row. */
export async function listScoreReports(opts: { status?: string; limit?: number } = {}): Promise<ScoreReportRow[]> {
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
  const rows = await q<{
    id: string; match_id: string | null; room_code: string; game: string; detail: string;
    status: string; smite: number; created_at: string; reporter_id: string;
    handle: string; username: string | null; filed: string; rejected: string;
  }>(
    `select sr.id::text as id, sr.match_id::text as match_id, sr.room_code, sr.game, sr.detail,
            sr.status, sr.smite, sr.created_at, sr.reporter_id, p.handle, p.username,
            (select count(*) from score_reports x where x.reporter_id = sr.reporter_id) as filed,
            (select count(*) from score_reports x
              where x.reporter_id = sr.reporter_id and x.status = 'rejected') as rejected
       from score_reports sr
       join profiles p on p.user_id = sr.reporter_id
      where ($1::text is null or sr.status = $1::text)
      order by sr.created_at desc
      limit $2`,
    [opts.status ?? null, limit],
  );
  return rows.map((x) => ({
    id: x.id,
    matchId: x.match_id,
    roomCode: x.room_code,
    game: x.game,
    detail: x.detail,
    status: x.status,
    smite: Number(x.smite ?? 0),
    createdAt: x.created_at,
    reporterId: x.reporter_id,
    reporterHandle: x.handle,
    reporterUsername: x.username,
    reporterFiled: Number(x.filed ?? 0),
    reporterRejected: Number(x.rejected ?? 0),
  }));
}

/**
 * Resolve one claim: `upheld` or `rejected`, and record the smite that went with it.
 *
 * The STANDING charge itself is not written here. It goes through `writeStandingEvent` like
 * every other offence, so a smite appears in the same ledger the player already reads and is
 * subject to the same tier and cooldown machinery — a punishment invented in its own table
 * would be one the player is never shown and no other code path knows about.
 *
 * Returns the reporter's id so the caller can charge them, and null if the row is already
 * resolved (two moderators, one queue).
 */
export async function resolveScoreReport(
  id: string,
  status: 'upheld' | 'rejected',
  adminId: string,
  smite = 0,
): Promise<{ reporterId: string; roomCode: string; game: string } | null> {
  const rows = await q<{ reporter_id: string; room_code: string; game: string }>(
    `update score_reports
        set status = $2, reviewed_by = $3, reviewed_at = now(), smite = $4
      where id = $1::bigint and status = 'open'
      returning reporter_id, room_code, game`,
    [id, status, adminId, Math.max(0, Math.floor(smite))],
  );
  if (!rows.length) return null;
  return { reporterId: rows[0].reporter_id, roomCode: rows[0].room_code, game: rows[0].game };
}

// ------------------------------------------------------- player reports ------

/** File a report. Returns false when the same reporter has already filed this category
 *  against this player from this room — the unique index, surfaced as a no-op rather than
 *  an error, because a double-tap on the button is not a failure worth showing anyone. */
export async function submitReport(r: {
  reportedId: string;
  reporterId: string;
  reason: string;
  detail?: string | null;
  roomCode?: string;
  game?: Game;
}): Promise<boolean> {
  const rows = await q<{ id: string }>(
    `insert into player_reports (reported_id, reporter_id, reason, detail, room_code, game)
     values ($1, $2, $3, $4, $5, $6)
     on conflict do nothing
     returning id`,
    [r.reportedId, r.reporterId, r.reason, r.detail?.slice(0, 300) || null, r.roomCode ?? '', g(r.game)],
  );
  return rows.length > 0;
}

/** How many DISTINCT people have reported this player out of one room. The standing nudge
 *  is priced per reporter (and capped): one person filing three categories is one opinion,
 *  three people filing one each is three. */
export async function distinctReporters(reportedId: string, roomCode: string): Promise<number> {
  const rows = await q<{ n: number }>(
    `select count(distinct reporter_id)::int as n from player_reports
      where reported_id = $1 and room_code = $2`,
    [reportedId, roomCode],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * The moderation QUEUE: one row per reported player, most recently reported first.
 *
 * Aggregated in SQL rather than by fetching every report and grouping in JS — the panel
 * wants counts and a recency ordering, and a moderator on a busy day should not be paging
 * thousands of rows to see twelve names. `reporters` is a DISTINCT count on purpose: four
 * reports from four people and four from one are completely different signals, and the
 * panel shows both numbers so a moderator can tell a pattern from a grudge.
 */
export async function listReportedUsers(limit = 60): Promise<ReportedUserRow[]> {
  const n = Math.min(200, Math.max(1, Math.floor(limit)));
  const rows = await q<{
    reported_id: string;
    handle: string;
    username: string | null;
    total: number;
    open: number;
    reporters: number;
    latest: string;
    reasons: { reason: string; n: number }[] | null;
  }>(
    `select r.reported_id,
            p.handle, p.username,
            count(*)::int as total,
            count(*) filter (where r.status = 'open')::int as open,
            count(distinct r.reporter_id)::int as reporters,
            max(r.created_at) as latest,
            (select json_agg(x) from (
               select reason, count(*)::int as n
                 from player_reports r2
                where r2.reported_id = r.reported_id
                group by reason
                order by n desc
             ) x) as reasons
       from player_reports r
       join profiles p on p.user_id = r.reported_id
      group by r.reported_id, p.handle, p.username
      order by max(r.created_at) desc
      limit $1`,
    [n],
  );
  return rows.map((x) => ({
    userId: x.reported_id,
    handle: x.handle,
    username: x.username,
    total: Number(x.total),
    open: Number(x.open),
    reporters: Number(x.reporters),
    latest: x.latest,
    reasons: (x.reasons ?? []).map((r) => ({ reason: r.reason, n: Number(r.n) })),
  }));
}

export interface ReportedUserRow {
  userId: string;
  handle: string;
  username: string | null;
  total: number;
  open: number;
  reporters: number;
  latest: string;
  reasons: { reason: string; n: number }[];
}

export interface ReportDetailRow {
  id: string;
  reason: string;
  detail: string | null;
  roomCode: string;
  game: string;
  status: string;
  createdAt: string;
  reporterHandle: string;
  reporterUsername: string | null;
}

/** every report filed against one player, newest first — the drill-down */
export async function listReportsFor(userId: string, limit = 100): Promise<ReportDetailRow[]> {
  const rows = await q<{
    id: string; reason: string; detail: string | null; room_code: string; game: string;
    status: string; created_at: string; handle: string; username: string | null;
  }>(
    `select r.id::text as id, r.reason, r.detail, r.room_code, r.game, r.status,
            r.created_at, p.handle, p.username
       from player_reports r
       join profiles p on p.user_id = r.reporter_id
      where r.reported_id = $1
      order by r.created_at desc
      limit $2`,
    [userId, Math.min(300, Math.max(1, Math.floor(limit)))],
  );
  return rows.map((x) => ({
    id: x.id,
    reason: x.reason,
    detail: x.detail,
    roomCode: x.room_code,
    game: x.game,
    status: x.status,
    createdAt: x.created_at,
    reporterHandle: x.handle,
    reporterUsername: x.username,
  }));
}

/** triage: mark every open report against a player reviewed or dismissed. Per-user rather
 *  than per-report because that is how the queue is actually worked — a moderator judges a
 *  PLAYER after watching their matches, not each complaint in isolation. */
export async function setReportsStatus(
  userId: string,
  status: 'reviewed' | 'dismissed',
  moderatorId: string,
): Promise<number> {
  const rows = await q<{ id: string }>(
    `update player_reports
        set status = $2, reviewed_by = $3, reviewed_at = now()
      where reported_id = $1 and status = 'open'
      returning id`,
    [userId, status, moderatorId],
  );
  return rows.length;
}

/**
 * A reported player's recent matches WITH their replay ids — the whole point of the
 * moderation drill-down. A cheating or throwing report is unjudgeable from text; the
 * moderator has to watch the match, and making them go and find it elsewhere is how a
 * report queue stops being worked.
 */
export async function userRecentMatches(userId: string, limit = 15): Promise<{
  matchId: string;
  replayId: string | null;
  game: string;
  mode: string;
  ranked: boolean | null;
  createdAt: string;
  score: number;
  won: boolean | null;
}[]> {
  const rows = await q<{
    id: string; replay_id: string | null; game: string; mode: string;
    ranked: boolean | null; created_at: string; score: number; won: boolean | null;
  }>(
    `select m.id::text as id, m.replay_id::text as replay_id, m.game, m.mode, m.ranked,
            m.created_at, mp.score, mp.won
       from match_participants mp
       join matches m on m.id = mp.match_id
      where mp.user_id = $1
      order by m.created_at desc
      limit $2`,
    [userId, Math.min(50, Math.max(1, Math.floor(limit)))],
  );
  return rows.map((x) => ({
    matchId: x.id,
    replayId: x.replay_id,
    game: x.game,
    mode: x.mode,
    ranked: x.ranked,
    createdAt: x.created_at,
    score: x.score,
    won: x.won,
  }));
}

/** one row of a ranked board. Same name-plus-badge shape as `BoardRow` — the two
 *  boards sit behind one segmented control and render through the same cell. */
export interface EloBoardRow {
  userId: string;
  handle: string;
  username: string | null;
  rating: number;
  games: number;
  /** active supporter membership — renders a small badge beside the name */
  supporter?: boolean;
  /** 'owner' | 'admin' — renders the staff badge instead of the supporter one */
  role?: StaffRole;
}

/** The public leaderboard for an ACT's board — PLACED players only (games >=
 * PLACEMENT_GAMES). Players still in placements are intentionally omitted;
 * `eloUserStanding` reports the viewer's own standing separately. */
export async function eloLeaderboard(opts: {
  mode: '1v1' | '2v2';
  act: number;
  limit?: number;
  game?: Game;
}): Promise<EloBoardRow[]> {
  return q<EloBoardRow>(
    `select e.user_id as "userId", p.handle, p.username, e.rating, e.games,
            ${badgeCols('p.')}
     from elo_ratings e join profiles p on p.user_id = e.user_id
     where e.act = $1 and e.mode = $2 and e.game = $5 and e.games >= $4
     order by e.rating desc, e.games desc
     limit $3`,
    [opts.act, opts.mode, opts.limit ?? 100, PLACEMENT_GAMES, g(opts.game)],
  );
}

/** The viewing player's own standing on an ACT's board, whether or not they're placed:
 * their rating + games, and their rank AMONG PLACED PLAYERS (null while still in
 * placements). Returns null if they've never played this board. Rank uses the
 * same order as `eloLeaderboard` so the two always agree. */
export async function eloUserStanding(opts: {
  userId: string;
  mode: '1v1' | '2v2';
  act: number;
  game?: Game;
}): Promise<{ rank: number | null; rating: number; games: number } | null> {
  const rows = await q<{ rating: number; games: number; rnk: string | null }>(
    `with placed as (
       select user_id,
              rank() over (order by rating desc, games desc) as rnk
       from elo_ratings
       where act = $1 and mode = $2 and game = $5 and games >= $3
     )
     select e.rating, e.games, p.rnk
     from elo_ratings e
     left join placed p on p.user_id = e.user_id
     where e.act = $1 and e.mode = $2 and e.game = $5 and e.user_id = $4`,
    [opts.act, opts.mode, PLACEMENT_GAMES, opts.userId, g(opts.game)],
  );
  const r = rows[0];
  if (!r) return null;
  return { rank: r.rnk != null ? Number(r.rnk) : null, rating: r.rating, games: r.games };
}

// -------- per-season ELO SNAPSHOT (historical, frozen at each season's end) --
/** Snapshot a player's post-match rating for the SEASON it was played in. While the season is
 * live this tracks the latest rating; after it rolls it stays frozen = the end-of-season state.
 * Called alongside `upsertRating` on every rated match. `games` is the act-cumulative count. */
export async function upsertEloHistory(
  userId: string,
  mode: '1v1' | '2v2',
  balanceVersion: number,
  rating: number,
  rd: number,
  vol: number,
  games: number,
  game?: Game,
): Promise<void> {
  await q(
    `insert into elo_history (user_id, mode, game, balance_version, rating, rd, vol, games)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (user_id, mode, game, balance_version)
       do update set rating = excluded.rating, rd = excluded.rd, vol = excluded.vol,
                     games = excluded.games, updated_at = now()`,
    [userId, mode, g(game), balanceVersion, Math.round(rating), rd, vol, games],
  );
}

/** The historical leaderboard for a PAST season — the ratings frozen at that season's end. Same
 * shape + placement filter as `eloLeaderboard`, but reads the per-season snapshot. */
export async function eloHistoryLeaderboard(opts: {
  mode: '1v1' | '2v2';
  balanceVersion: number;
  limit?: number;
  game?: Game;
}): Promise<EloBoardRow[]> {
  return q<EloBoardRow>(
    `select h.user_id as "userId", p.handle, p.username, h.rating, h.games,
            ${badgeCols('p.')}
     from elo_history h join profiles p on p.user_id = h.user_id
     where h.balance_version = $1 and h.mode = $2 and h.game = $5 and h.games >= $4
     order by h.rating desc, h.games desc
     limit $3`,
    [opts.balanceVersion, opts.mode, opts.limit ?? 100, PLACEMENT_GAMES, g(opts.game)],
  );
}

/** A player's own frozen standing in a PAST season (mirrors `eloUserStanding`). */
export async function eloHistoryUserStanding(opts: {
  userId: string;
  mode: '1v1' | '2v2';
  balanceVersion: number;
  game?: Game;
}): Promise<{ rank: number | null; rating: number; games: number } | null> {
  const rows = await q<{ rating: number; games: number; rnk: string | null }>(
    `with placed as (
       select user_id,
              rank() over (order by rating desc, games desc) as rnk
       from elo_history
       where balance_version = $1 and mode = $2 and game = $5 and games >= $3
     )
     select h.rating, h.games, p.rnk
     from elo_history h
     left join placed p on p.user_id = h.user_id
     where h.balance_version = $1 and h.mode = $2 and h.game = $5 and h.user_id = $4`,
    [opts.balanceVersion, opts.mode, PLACEMENT_GAMES, opts.userId, g(opts.game)],
  );
  const r = rows[0];
  if (!r) return null;
  return { rank: r.rnk != null ? Number(r.rnk) : null, rating: r.rating, games: r.games };
}

// -------------------------------------------------------- global stats -----
export interface GlobalStats {
  users: number;
  /** total games played — COMBINED across every game (the homepage headline) */
  games: number;
  byCategory: { solo: number; duo: number; '1v1': number; '2v2': number };
  /** games played PER GAME (DECODE + Chain Reaction tracked separately). The
   * homepage sums these into `games`; the split is here if a surface wants it. */
  byGame: Record<Game, number>;
}

/** site-wide totals for the homepage: registered players + games played, split
 * by category (solo/duo record runs + 1v1/2v2 PvP matches — the server-tracked
 * games) AND by game (DECODE vs Chain Reaction, recorded separately). The
 * headline `games` COMBINES every game. Cheap COUNT/GROUP BY over indexed tables. */
export async function getGlobalStats(): Promise<GlobalStats> {
  const [users, recRows, matchRows] = await Promise.all([
    q<{ n: string }>(`select count(*) as n from profiles`),
    q<{ game: Game; mode: string; n: string }>(`select game, mode, count(*) as n from records group by game, mode`),
    q<{ game: Game; mode: string; n: string }>(`select game, mode, count(*) as n from matches group by game, mode`),
  ]);
  const byCategory: GlobalStats['byCategory'] = { solo: 0, duo: 0, '1v1': 0, '2v2': 0 };
  const byGame: Record<Game, number> = { decode: 0, chain: 0 };
  for (const r of [...recRows, ...matchRows]) {
    const n = Number(r.n);
    // combined-by-category (homepage) — sums across games
    if (r.mode in byCategory) byCategory[r.mode as keyof GlobalStats['byCategory']] += n;
    // recorded separately per game
    const gk = (r.game ?? 'decode') as Game;
    if (gk in byGame) byGame[gk] += n;
  }
  const games = byCategory.solo + byCategory.duo + byCategory['1v1'] + byCategory['2v2'];
  return { users: Number(users[0]?.n ?? 0), games, byCategory, byGame };
}

// ---------------------------------------------------------- per-user stats --
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
  /** active supporter membership — the profile header badge */
  supporter?: boolean;
  /** 'owner' | 'admin' — the staff badge, which replaces the supporter one */
  role?: StaffRole;
  season: number;
  elo: UserEloStat[];
  records: UserRecordStat[];
  match: { played: number; wins: number; losses: number };
  recent: UserMatchRow[];
  /**
   * LIFETIME playtime and games played — for THIS game, plus the combined total across
   * every game. Deliberately not season-scoped like everything above it: "how much have I
   * played" is a question about the account, not about the current act, and resetting it
   * every season would make the number meaningless the moment it got interesting.
   */
  activity?: { games: number; seconds: number; allGames: number; allSeconds: number };
}

/**
 * A user's whole competitive profile for a season in ONE round-trip: overall ELO
 * (+ live rank) per mode, record personal-bests (+ rank) per mode, W/L totals,
 * and recent PvP history. Ranks are computed server-side with window functions
 * so the client never pulls a full board to find one row. Empty/zero when the
 * player hasn't competed; the DB is disabled ⇒ callers no-op before this.
 */
export async function getUserStats(
  userId: string,
  balanceVersion: number,
  game?: Game,
): Promise<UserStats> {
  const gm = g(game);
  // ELO for the LIVE season = the per-ACT board (persists across seasons); for an ARCHIVED
  // season = the per-season SNAPSHOT frozen at that season's end. Records/matches stay per-season.
  const act = await actForSeason(balanceVersion, game);
  const current = await currentSeasonNumber(balanceVersion, game);
  const isLive = balanceVersion >= current;
  const eloTable = isLive ? 'elo_ratings' : 'elo_history';
  const eloKeyCol = isLive ? 'act' : 'balance_version';
  const eloKeyVal = isLive ? act : balanceVersion;
  const [profile, elo, recPb, recRank, match, recent] = await Promise.all([
    q<{ handle: string; username: string | null; supporter: boolean; role: string | null }>(
      `select handle, username, role, ${SUPPORTER_COL} from profiles where user_id = $1`,
      [userId],
    ),
    q<{ mode: '1v1' | '2v2'; rating: number; games: number; rnk: string | null }>(
      `with placed as (
         select user_id, mode,
                rank() over (partition by mode order by rating desc, games desc) as rnk
         from ${eloTable}
         where ${eloKeyCol} = $1 and game = $4 and games >= $3
       )
       select e.mode, e.rating, e.games, p.rnk
       from ${eloTable} e
       left join placed p on p.user_id = e.user_id and p.mode = e.mode
       where e.${eloKeyCol} = $1 and e.game = $4 and e.user_id = $2`,
      [eloKeyVal, userId, PLACEMENT_GAMES, gm],
    ),
    q<{ mode: 'solo' | 'duo'; score: number; replay_id: string | null }>(
      `select distinct on (mode) mode, score, replay_id
       from records where user_id = $1 and balance_version = $2 and game = $3
       order by mode, score desc, created_at asc`,
      [userId, balanceVersion, gm],
    ),
    q<{ mode: 'solo' | 'duo'; rnk: string }>(
      `with best as (
         select user_id, mode, max(score) as score
         from records where balance_version = $1 and game = $3 group by user_id, mode
       ), ranked as (
         select user_id, mode, rank() over (partition by mode order by score desc) as rnk
         from best
       )
       select mode, rnk from ranked where user_id = $2`,
      [balanceVersion, userId, gm],
    ),
    q<{ played: string; wins: string }>(
      `select count(*) as played, count(*) filter (where mp.won) as wins
       from match_participants mp join matches m on m.id = mp.match_id
       where mp.user_id = $1 and m.balance_version = $2 and m.game = $3`,
      [userId, balanceVersion, gm],
    ),
    q<UserMatchRow>(
      `select mp.match_id as "matchId", m.mode, mp.alliance, mp.score, mp.won,
              mp.rating_before as "ratingBefore", mp.rating_after as "ratingAfter",
              m.created_at as "createdAt"
       from match_participants mp join matches m on m.id = mp.match_id
       where mp.user_id = $1 and m.balance_version = $2 and m.game = $3
       order by m.created_at desc limit 10`,
      [userId, balanceVersion, gm],
    ),
  ]);

  const rankByMode = new Map(recRank.map((r) => [r.mode, Number(r.rnk)]));
  const elos: UserEloStat[] = (['1v1', '2v2'] as const).map((mode) => {
    const row = elo.find((e) => e.mode === mode);
    return {
      mode,
      rating: row ? row.rating : 1000,
      games: row ? row.games : 0,
      // placed-only rank: null while the player is still in placements
      rank: row && row.rnk != null ? Number(row.rnk) : null,
    };
  });
  const records: UserRecordStat[] = (['solo', 'duo'] as const).map((mode) => {
    const pb = recPb.find((r) => r.mode === mode);
    return {
      mode,
      best: pb ? pb.score : null,
      rank: rankByMode.get(mode) ?? null,
      replayId: pb?.replay_id ?? null,
    };
  });
  const played = Number(match[0]?.played ?? 0);
  const wins = Number(match[0]?.wins ?? 0);
  const activity = await getActivity(userId);
  const mine = activity.byGame[gm] ?? { games: 0, seconds: 0 };

  return {
    userId,
    handle: profile[0]?.handle ?? null,
    supporter: !!profile[0]?.supporter,
    role: asRole(profile[0]?.role),
    username: profile[0]?.username ?? null,
    season: balanceVersion,
    elo: elos,
    records,
    match: { played, wins, losses: played - wins },
    recent,
    activity: {
      games: mine.games,
      seconds: mine.seconds,
      allGames: activity.total.games,
      allSeconds: activity.total.seconds,
    },
  };
}

// ------------------------------------------------------- playtime + games ---

/**
 * Credit one finished match to every account that played it.
 *
 * ONE STATEMENT for the whole roster, not a query per player: this runs at match end
 * alongside the other writes, and a four-player match should not be four round-trips to add
 * four integers. `unnest` turns the id list into rows the upsert can join against.
 *
 * Seconds are ROUNDED here rather than stored as a float. The input is a tick count, the
 * output is read in hours, and a column that accumulates 0.7333-second fragments for years
 * is a column that will eventually be explained to somebody.
 */
export async function addActivity(
  userIds: string[],
  seconds: number,
  game?: Game,
): Promise<void> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return;
  const secs = Math.max(0, Math.round(seconds));
  await q(
    `insert into user_activity (user_id, game, games, seconds)
     select id, $2, 1, $3 from unnest($1::text[]) as id
     on conflict (user_id, game) do update
       set games = user_activity.games + 1,
           seconds = user_activity.seconds + excluded.seconds,
           updated_at = now()`,
    [ids, g(game), secs],
  );
}

/** what this account has played, per game plus the combined total */
export async function getActivity(userId: string): Promise<{
  total: { games: number; seconds: number };
  byGame: Record<string, { games: number; seconds: number }>;
}> {
  const rows = await q<{ game: string; games: number; seconds: number }>(
    `select game, games, seconds from user_activity where user_id = $1`,
    [userId],
  );
  const byGame: Record<string, { games: number; seconds: number }> = {};
  let games = 0;
  let seconds = 0;
  for (const r of rows) {
    byGame[r.game] = { games: Number(r.games), seconds: Number(r.seconds) };
    games += Number(r.games);
    seconds += Number(r.seconds);
  }
  return { total: { games, seconds }, byGame };
}

// ------------------------------------------------------ PvP match history ---
export async function saveMatch(
  mode: '1v1' | '2v2',
  balanceVersion: number,
  replayId: string,
  ranked: boolean,
  game?: Game,
): Promise<string> {
  const rows = await q<{ id: string }>(
    `insert into matches (mode, balance_version, replay_id, ranked, game) values ($1, $2, $3, $4, $5) returning id`,
    [mode, balanceVersion, replayId, ranked, g(game)],
  );
  return rows[0].id;
}

export async function addMatchParticipant(p: {
  matchId: string;
  userId: string;
  alliance: 'red' | 'blue';
  drivetrain: string;
  score: number;
  won: boolean;
  /** null for a custom (unranked) match — no rating change */
  ratingBefore: number | null;
  ratingAfter: number | null;
}): Promise<void> {
  await q(
    `insert into match_participants
       (match_id, user_id, alliance, drivetrain, score, won, rating_before, rating_after)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (match_id, user_id) do nothing`,
    [p.matchId, p.userId, p.alliance, p.drivetrain, p.score, p.won, p.ratingBefore, p.ratingAfter],
  );
}

// ---------------------------------------------------- unified match history ---
export interface MatchHistoryPlayer {
  userId: string;
  handle: string;
  username: string | null;
  alliance: 'red' | 'blue' | null; // null for record-run partners
  /** active supporter membership — renders a small badge beside the name */
  supporter?: boolean;
  /** 'owner' | 'admin' — renders the staff badge instead of the supporter one */
  role?: StaffRole;
}
export interface MatchHistoryEntry {
  kind: 'versus' | 'record';
  id: string;
  mode: string; // '1v1'|'2v2' (versus) or 'solo'|'duo' (record)
  ranked: boolean | null; // versus only
  drivetrain: string | null; // record only (its leaderboard bucket)
  createdAt: string;
  replayId: string | null;
  score: number;
  /** both alliances' FINAL totals (versus only; null for record runs). The
   * per-participant `score` is the alliance total, so red/blue are recoverable
   * from the participant fan-out below without a dedicated match-score column. */
  redScore: number | null;
  blueScore: number | null;
  won: boolean | null; // versus only
  eloBefore: number | null;
  eloAfter: number | null;
  players: MatchHistoryPlayer[]; // everyone who played (incl. the queried user)
}
export interface MatchHistoryPage {
  rows: MatchHistoryEntry[];
  total: number;
  offset: number;
  limit: number;
}

/**
 * A user's UNIFIED match history for a season — versus matches (ranked + custom,
 * with every participant) AND record runs (solo/duo, with the partner) merged and
 * newest-first, paginated + filterable. `type`: all|ranked|custom|solo|duo;
 * `result`: all|win|loss (win/loss applies to versus only). One feed query + one
 * participant fan-out; ranks/deltas already stored, so it's cheap.
 */
export async function userMatchHistory(
  userId: string,
  opts: {
    balanceVersion: number;
    offset?: number;
    limit?: number;
    type?: string;
    result?: string;
    game?: Game;
  },
): Promise<MatchHistoryPage> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 25));
  const offset = Math.max(0, opts.offset ?? 0);

  const conds: string[] = [];
  switch (opts.type) {
    case 'ranked': conds.push(`kind = 'versus' and ranked is true`); break;
    case 'custom': conds.push(`kind = 'versus' and ranked is not true`); break;
    case 'solo': conds.push(`kind = 'record' and mode = 'solo'`); break;
    case 'duo': conds.push(`kind = 'record' and mode = 'duo'`); break;
    case 'versus': conds.push(`kind = 'versus'`); break;
    case 'record': conds.push(`kind = 'record'`); break;
  }
  if (opts.result === 'win') conds.push(`won is true`);
  else if (opts.result === 'loss') conds.push(`won is false`);
  const where = conds.length ? `where ${conds.join(' and ')}` : '';

  const feed = `
    with feed as (
      select 'versus' as kind, m.id::text as id, m.mode as mode, m.ranked as ranked,
             null::text as drivetrain, m.created_at as created_at, m.replay_id::text as replay_id,
             mp.score as score, mp.won as won,
             mp.rating_before as elo_before, mp.rating_after as elo_after
      from match_participants mp join matches m on m.id = mp.match_id
      where mp.user_id = $1 and m.balance_version = $2 and m.game = $3
      union all
      select 'record', r.id::text, r.mode, null::boolean,
             r.drivetrain, r.created_at, r.replay_id::text,
             r.score, null::boolean, null::int, null::int
      from records r
      where r.user_id = $1 and r.balance_version = $2 and r.game = $3
    )`;

  const [rows, countRows] = await Promise.all([
    q<{
      kind: 'versus' | 'record';
      id: string;
      mode: string;
      ranked: boolean | null;
      drivetrain: string | null;
      created_at: string;
      replay_id: string | null;
      score: number;
      won: boolean | null;
      elo_before: number | null;
      elo_after: number | null;
    }>(`${feed} select * from feed ${where} order by created_at desc limit $4 offset $5`, [
      userId,
      opts.balanceVersion,
      g(opts.game),
      limit,
      offset,
    ]),
    q<{ n: string }>(`${feed} select count(*)::int as n from feed ${where}`, [
      userId,
      opts.balanceVersion,
      g(opts.game),
    ]),
  ]);

  // fan-out players: all participants of the versus matches on this page, plus the
  // self+partner of record runs. One query for versus participants, one for the
  // profiles referenced by record runs.
  const versusIds = rows.filter((r) => r.kind === 'versus').map((r) => r.id);
  const byMatch = new Map<string, MatchHistoryPlayer[]>();
  // both alliances' final totals per match (score is the alliance total, so any
  // participant on a side carries it — see room.ts scores[alliance].total)
  const scoreByMatch = new Map<string, { red: number | null; blue: number | null }>();
  if (versusIds.length) {
    const parts = await q<{
      id: string;
      user_id: string;
      alliance: 'red' | 'blue';
      score: number;
      handle: string;
      username: string | null;
      role: string | null;
      supporter: boolean;
    }>(
      `select mp.match_id::text as id, mp.user_id, mp.alliance, mp.score, p.handle, p.username,
              ${badgeCols('p.')}
       from match_participants mp join profiles p on p.user_id = mp.user_id
       where mp.match_id = any($1::uuid[])`,
      [versusIds],
    );
    for (const p of parts) {
      const list = byMatch.get(p.id) ?? [];
      list.push({
        userId: p.user_id,
        handle: p.handle,
        username: p.username,
        alliance: p.alliance,
        supporter: !!p.supporter,
        role: asRole(p.role),
      });
      byMatch.set(p.id, list);
      const s = scoreByMatch.get(p.id) ?? { red: null, blue: null };
      if (p.alliance === 'red') s.red = p.score;
      else s.blue = p.score;
      scoreByMatch.set(p.id, s);
    }
  }
  // profiles for record runs (self + partners)
  const recordIds = rows.filter((r) => r.kind === 'record').map((r) => r.id);
  const recPlayers = new Map<string, MatchHistoryPlayer[]>();
  if (recordIds.length) {
    const recs = await q<{ id: string; partner_id: string | null }>(
      `select id::text as id, partner_id from records where id = any($1::uuid[])`,
      [recordIds],
    );
    const need = new Set<string>([userId]);
    for (const r of recs) if (r.partner_id) need.add(r.partner_id);
    const profs = await q<{
      user_id: string;
      handle: string;
      username: string | null;
      role: string | null;
      supporter: boolean;
    }>(
      `select user_id, handle, username, ${badgeCols('')} from profiles where user_id = any($1::text[])`,
      [[...need]],
    );
    const byUser = new Map(profs.map((p) => [p.user_id, p]));
    const mk = (uid: string): MatchHistoryPlayer => {
      const p = byUser.get(uid);
      return {
        userId: uid,
        handle: p?.handle ?? 'Player',
        username: p?.username ?? null,
        alliance: null,
        supporter: !!p?.supporter,
        role: asRole(p?.role),
      };
    };
    for (const r of recs) {
      const list = [mk(userId)];
      if (r.partner_id) list.push(mk(r.partner_id));
      recPlayers.set(r.id, list);
    }
  }

  return {
    rows: rows.map((r) => ({
      kind: r.kind,
      id: r.id,
      mode: r.mode,
      ranked: r.ranked,
      drivetrain: r.drivetrain,
      createdAt: r.created_at,
      replayId: r.replay_id,
      score: r.score,
      redScore: r.kind === 'versus' ? scoreByMatch.get(r.id)?.red ?? null : null,
      blueScore: r.kind === 'versus' ? scoreByMatch.get(r.id)?.blue ?? null : null,
      won: r.won,
      eloBefore: r.elo_before,
      eloAfter: r.elo_after,
      players: (r.kind === 'versus' ? byMatch.get(r.id) : recPlayers.get(r.id)) ?? [],
    })),
    total: Number(countRows[0]?.n ?? 0),
    offset,
    limit,
  };
}

/** one finished game in the operator's "Recent games" list */
export interface RecentMatchRow {
  kind: 'versus' | 'record';
  id: string;
  game: string;
  /** '1v1' | '2v2' (versus) or 'solo' | 'duo' (record) */
  mode: string;
  ranked: boolean | null;
  createdAt: string;
  replayId: string | null;
  balanceVersion: number;
  /** final alliance totals (versus) — both null for a record run */
  redScore: number | null;
  blueScore: number | null;
  /** the record run's score (record only) */
  score: number | null;
  players: { userId: string; handle: string; alliance: 'red' | 'blue' | null }[];
}

/**
 * The most recently FINISHED games across the whole service, for the admin panel.
 *
 * The counterpart to the live list: an operator investigating a report ("that
 * match five minutes ago") needs the game after it has stopped being live, and a
 * finished match cannot be spectated — only replayed. So this carries `replayId`,
 * which is what the row's button opens.
 *
 * Deliberately NOT season- or version-scoped. Every other history query filters by
 * `balance_version` because it feeds a leaderboard, where mixing balance versions
 * would compare incomparable runs; this one answers "what just happened on the
 * server", and the answer must not disappear the moment a season rolls over. The
 * version is reported per row instead.
 */
export async function recentMatches(limit = 40, game?: Game): Promise<RecentMatchRow[]> {
  const n = Math.min(200, Math.max(1, Math.floor(limit)));
  const gameFilter = game ? `where game = $2` : '';
  const params: unknown[] = game ? [n, g(game)] : [n];
  const rows = await q<{
    kind: 'versus' | 'record';
    id: string;
    game: string;
    mode: string;
    ranked: boolean | null;
    created_at: string;
    replay_id: string | null;
    balance_version: number;
    score: number | null;
  }>(
    `with feed as (
       select 'versus' as kind, m.id::text as id, m.game as game, m.mode as mode,
              m.ranked as ranked, m.created_at as created_at, m.replay_id::text as replay_id,
              m.balance_version as balance_version, null::int as score
         from matches m
       union all
       select 'record', r.id::text, r.game, r.mode, null::boolean, r.created_at,
              r.replay_id::text, r.balance_version, r.score
         from records r
     )
     select * from feed ${gameFilter} order by created_at desc limit $1`,
    params,
  );
  if (rows.length === 0) return [];

  // one fan-out for the versus rosters; record runs carry only their owner, which
  // the feed above does not select (the union has to stay column-compatible), so
  // they are fetched in the same round of work rather than per row.
  const versusIds = rows.filter((r) => r.kind === 'versus').map((r) => r.id);
  const recordIds = rows.filter((r) => r.kind === 'record').map((r) => r.id);
  const [parts, recs] = await Promise.all([
    versusIds.length
      ? q<{ match_id: string; user_id: string; handle: string; alliance: 'red' | 'blue'; score: number }>(
          `select mp.match_id::text as match_id, mp.user_id, p.handle, mp.alliance, mp.score
             from match_participants mp join profiles p on p.user_id = mp.user_id
            where mp.match_id = any($1::uuid[])`,
          [versusIds],
        )
      : Promise.resolve([]),
    recordIds.length
      ? q<{ id: string; user_id: string; handle: string }>(
          `select r.id::text as id, r.user_id, p.handle
             from records r join profiles p on p.user_id = r.user_id
            where r.id = any($1::uuid[])`,
          [recordIds],
        )
      : Promise.resolve([]),
  ]);

  const roster = new Map<string, RecentMatchRow['players']>();
  const scores = new Map<string, { red: number | null; blue: number | null }>();
  for (const p of parts) {
    const list = roster.get(p.match_id) ?? [];
    list.push({ userId: p.user_id, handle: p.handle, alliance: p.alliance });
    roster.set(p.match_id, list);
    // every participant on an alliance stores that alliance's TOTAL, so either
    // one gives the side's score (see MatchHistoryEntry)
    const s = scores.get(p.match_id) ?? { red: null, blue: null };
    s[p.alliance] = p.score;
    scores.set(p.match_id, s);
  }
  for (const r of recs) {
    roster.set(r.id, [{ userId: r.user_id, handle: r.handle, alliance: null }]);
  }

  return rows.map((r) => ({
    kind: r.kind,
    id: r.id,
    game: r.game,
    mode: r.mode,
    ranked: r.ranked,
    createdAt: r.created_at,
    replayId: r.replay_id,
    balanceVersion: r.balance_version,
    redScore: r.kind === 'versus' ? scores.get(r.id)?.red ?? null : null,
    blueScore: r.kind === 'versus' ? scores.get(r.id)?.blue ?? null : null,
    score: r.kind === 'record' ? r.score : null,
    players: roster.get(r.id) ?? [],
  }));
}

// -------------------------------------------------- pending (staged) matches ---
// The designated matchmaker stages a paired ranked match; the fair host-region
// machine claims it when the players reconnect. See server/matchTypes.ts.

export async function createPendingMatch(m: PendingMatch): Promise<void> {
  await q(
    `insert into pending_matches (code, host_region, mode, seed, roster, ranked)
     values ($1, $2, $3, $4, $5::jsonb, $6)
     on conflict (code) do nothing`,
    [m.code, m.hostRegion, m.mode, m.seed, JSON.stringify(m.roster), m.ranked],
  );
}

/** atomically claim a staged match (delete-returning, so exactly one host builds
 * it even if two clients race the first connect). Returns null if unknown/already
 * claimed. */
export async function takePendingMatch(code: string): Promise<PendingMatch | null> {
  const rows = await q<{
    code: string;
    host_region: string;
    mode: string;
    seed: string;
    roster: PendingRosterEntry[];
    ranked: boolean;
  }>(`delete from pending_matches where code = $1 returning *`, [code]);
  const r = rows[0];
  if (!r) return null;
  return {
    code: r.code,
    hostRegion: r.host_region,
    mode: r.mode as PendingMatch['mode'],
    seed: Number(r.seed),
    roster: r.roster,
    ranked: r.ranked,
    // channel + game are carried inside the roster jsonb (no schema column) — all
    // entries share one, so read them off the first
    channel: r.roster[0]?.channel,
    game: r.roster[0]?.game,
  };
}

/** reap staged matches nobody claimed (e.g. both clients vanished after assign) */
export async function cleanupStalePending(olderThanMs: number): Promise<number> {
  const rows = await q<{ code: string }>(
    `delete from pending_matches where created_at < now() - ($1 || ' milliseconds')::interval returning code`,
    [String(olderThanMs)],
  );
  return rows.length;
}

// -------------------------------------------------------- presence ----------
// Cross-machine presence: each region's machine only knows its OWN sockets, so a
// shared table + aggregate read gives a GLOBAL count (see 0015_presence.sql).

export interface GlobalPresence {
  online: number;
  signedIn: number;
  /** every game combined — the shape older clients read. Do not remove. */
  queues: { '1v1': number; '2v2': number };
  /**
   * Depth split BY GAME, which is the only version a player can act on: pairing is
   * bucketed by game, so a DECODE player can never be matched with a Chain Reaction
   * queuer and must not be told one is waiting for them. Keyed by game id.
   */
  gameQueues: Record<string, { '1v1': number; '2v2': number }>;
}

/** merge per-game queue depths from one machine into an accumulator */
function addGameQueues(
  into: Record<string, { '1v1': number; '2v2': number }>,
  from: unknown,
): void {
  if (!from || typeof from !== 'object') return;
  for (const [game, q] of Object.entries(from as Record<string, unknown>)) {
    if (!q || typeof q !== 'object') continue;
    const one = q as Partial<Record<'1v1' | '2v2', unknown>>;
    into[game] ??= { '1v1': 0, '2v2': 0 };
    for (const m of ['1v1', '2v2'] as const) {
      const n = one[m];
      if (typeof n === 'number' && Number.isFinite(n)) into[game][m] += n;
    }
  }
}

/**
 * What ONE signed-in account is doing, as the server already knows it.
 *
 * Everything here is state the match server must hold anyway to run a game — it is
 * republished for operators, not gathered for them. And it stops short of a
 * behavioural record on purpose: `act` is the same coarse bucket the player's own
 * friends list already shows their friends, and there is deliberately no field for
 * which screen or menu they are looking at.
 */
export interface PresencePlayer {
  userId: string;
  /** how many SOCKETS this account holds on this machine (two tabs, or a lobby
   *  socket plus a match socket). Without it the tiles cannot be made to add up:
   *  "online" counts sockets and "signed in" counts people, so one player with two
   *  tabs makes the two numbers disagree with no visible reason. */
  sessions?: number;
  /** coarse activity — the friends-list vocabulary, nothing finer */
  act: 'menu' | 'lobby' | 'match';
  /** the room they are in, when they are in one (already public via /api/live) */
  room?: string;
  /** ranked queue bucket, when queued — the operational fact behind "why is
   *  matchmaking not pairing?", and the one queue abuse is visible in */
  queue?: '1v1' | '2v2';
  /** whole seconds queued so far (a stuck queue is the thing worth seeing) */
  queuedS?: number;
  /** which GAME they are queued for — kept apart from `game` because the two can
   *  differ (queued for Chain Reaction while in a DECODE practice room), and an
   *  operator shown only one of them is being told a half-truth */
  queueGame?: string;
  game?: string;
}

/**
 * ONE anonymous (not signed in) session, for the operator view.
 *
 * Listed individually at the operator's request — earlier this was counts only. The
 * identifier is the SERVER'S OWN CONNECTION ID: a per-socket string this process
 * already generates to route messages. It is not derived from anything about the
 * person, it is not an IP or a fingerprint, it is not stored anywhere else, and it
 * ceases to exist when the socket closes — reconnecting produces an unrelated id.
 * So a guest can be told apart from another guest *right now*, which is what an
 * operator needs to see "who is idle vs in a lobby", without becoming something
 * that can follow anyone between sessions.
 */
export interface PresenceGuest {
  /** ephemeral per-connection id; dies with the socket */
  id: string;
  act: 'menu' | 'lobby' | 'match';
  room?: string;
  game?: string;
}

/** rolled-up guest counts, derived from the rows (kept for the summary tiles) */
export interface PresenceAnon {
  total: number;
  inMatch: number;
  inLobby: number;
  idle: number;
}

/** heartbeat THIS machine's live counts (upsert keyed by machine id). SNAPSHOT
 * only: every field is replaced by the next beat, so nothing accumulates here. */
export async function upsertPresence(
  machine: string,
  region: string,
  online: number,
  authedUserIds: string[],
  q1v1: number,
  q2v2: number,
  rooms: unknown[] = [],
  players: PresencePlayer[] = [],
  anon: PresenceAnon | null = null,
  gameQueues: Record<string, { '1v1': number; '2v2': number }> = {},
  guests: PresenceGuest[] = [],
): Promise<void> {
  await q(
    `insert into presence (machine, region, online, authed, q1v1, q2v2, rooms, players, anon, game_queues, guests, updated_at)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, now())
     on conflict (machine) do update
       set region = $2, online = $3, authed = $4::jsonb, q1v1 = $5, q2v2 = $6,
           rooms = $7::jsonb, players = $8::jsonb, anon = $9::jsonb,
           game_queues = $10::jsonb, guests = $11::jsonb, updated_at = now()`,
    [
      machine, region, online, JSON.stringify(authedUserIds), q1v1, q2v2,
      JSON.stringify(rooms), JSON.stringify(players), JSON.stringify(anon ?? {}),
      JSON.stringify(gameQueues), JSON.stringify(guests),
    ],
  );
}

/** where one player is playing right now, resolved from the heartbeat */
export interface UserLiveRoom {
  /** the room code to spectate */
  room: string;
  /** the Fly region hosting it — a custom room's code has no region prefix, so a
   *  spectate socket opened without this lands on the wrong machine */
  region: string;
  ranked: boolean;
}

const USER_ROOM_TTL_MS = 3_000;
let userRoomCache: { at: number; val: Map<string, UserLiveRoom> } | null = null;

/**
 * Which live match each signed-in player is IN, keyed by user id — the lookup
 * behind "watch your friend's game".
 *
 * Built from the presence heartbeat, so it is the SERVER's own observation of
 * where somebody is, not a claim the client makes about itself. Two columns of
 * the same rows are used together: `players` says which room each account holds a
 * socket in, and `rooms` says which of those rooms has a match actually running.
 * Both are needed — a room whose match has ended still holds its sockets for a
 * while, and offering that as watchable would send the watcher to a dead world.
 *
 * INVISIBLE players never reach this: a friend's row only asks for a room when
 * `listFriends` already resolved them as online, which invisibility rules out.
 *
 * Cached for a few seconds because every friends poll on the service asks for it
 * and the answer is the same for all of them.
 */
export async function liveRoomsByUser(freshSeconds = 15): Promise<Map<string, UserLiveRoom>> {
  const now = Date.now();
  if (userRoomCache && now - userRoomCache.at < USER_ROOM_TTL_MS) return userRoomCache.val;
  const rows = await q<{ region: string; rooms: unknown[] | null; players: PresencePlayer[] | null }>(
    `select region, rooms, players from presence
      where updated_at > now() - $1::interval and jsonb_array_length(players) > 0`,
    [`${Math.max(1, Math.floor(freshSeconds))} seconds`],
  );
  const out = new Map<string, UserLiveRoom>();
  for (const r of rows) {
    const live = new Map<string, { ranked: boolean; region?: string }>();
    for (const s of Array.isArray(r.rooms) ? r.rooms : []) {
      const lr = s as { room?: string; ranked?: boolean; region?: string };
      if (lr?.room) live.set(lr.room.toLowerCase(), { ranked: lr.ranked === true, region: lr.region });
    }
    for (const p of Array.isArray(r.players) ? r.players : []) {
      if (p.act !== 'match' || !p.room) continue;
      const hit = live.get(p.room.toLowerCase());
      if (!hit) continue; // holding a socket in a room whose match is over
      out.set(p.userId, { room: p.room, region: hit.region ?? r.region, ranked: hit.ranked });
    }
  }
  userRoomCache = { at: now, val: out };
  return out;
}

/** every live room across EVERY region with a fresh heartbeat. This is what makes
 *  "Watch Live" show the whole service instead of whichever region anycast picked. */
export async function globalLiveRooms(freshSeconds = 15): Promise<unknown[]> {
  const rows = await q<{ rooms: unknown[] }>(
    `select rooms from presence
      where updated_at > now() - $1::interval and jsonb_array_length(rooms) > 0
      order by region`,
    [`${Math.max(1, Math.floor(freshSeconds))} seconds`],
  );
  return rows.flatMap((r) => (Array.isArray(r.rooms) ? r.rooms : []));
}

/** the operator view: per-machine rows with their players + anonymous buckets.
 *  Handles are resolved HERE rather than stored on the heartbeat, so the snapshot
 *  itself carries ids only and no names are duplicated into it. */
export interface AdminPresenceRow {
  machine: string;
  region: string;
  online: number;
  updatedAt: string;
  players: (PresencePlayer & { handle: string | null; username: string | null })[];
  guests: PresenceGuest[];
  anon: PresenceAnon;
}
export async function adminPresence(freshSeconds = 20): Promise<AdminPresenceRow[]> {
  const rows = await q<{
    machine: string; region: string; online: number; updated_at: string;
    players: PresencePlayer[] | null; anon: PresenceAnon | null; guests: PresenceGuest[] | null;
  }>(
    `select machine, region, online, updated_at, players, anon, guests from presence
      where updated_at > now() - $1::interval order by region`,
    [`${Math.max(1, Math.floor(freshSeconds))} seconds`],
  );
  const ids = [...new Set(rows.flatMap((r) => (Array.isArray(r.players) ? r.players : []).map((p) => p.userId)))];
  const names = new Map<string, { handle: string; username: string | null }>();
  if (ids.length) {
    const profs = await q<{ user_id: string; handle: string; username: string | null }>(
      `select user_id, handle, username from profiles where user_id = any($1::text[])`,
      [ids],
    );
    for (const p of profs) names.set(p.user_id, { handle: p.handle, username: p.username });
  }
  return rows.map((r) => ({
    machine: r.machine,
    region: r.region,
    online: r.online,
    updatedAt: r.updated_at,
    players: (Array.isArray(r.players) ? r.players : []).map((p) => ({
      ...p,
      handle: names.get(p.userId)?.handle ?? null,
      username: names.get(p.userId)?.username ?? null,
    })),
    guests: Array.isArray(r.guests) ? r.guests : [],
    anon:
      r.anon && typeof r.anon === 'object' && typeof (r.anon as PresenceAnon).total === 'number'
        ? r.anon
        : { total: 0, inMatch: 0, inLobby: 0, idle: 0 },
  }));
}

// ---------------------------------------------------------- maintenance ----
/**
 * A scheduled MAINTENANCE LOCKDOWN: while it is live, only admins may start
 * anything. See 0023_maintenance.sql for why this lives in the database rather
 * than a machine's memory — it has to survive the restart it exists to protect,
 * and every region has to agree about it.
 */
export interface MaintenanceWindow {
  active: boolean;
  /** ms epoch it begins; null = the moment it was armed */
  startsAt: number | null;
  /** ms epoch it ends; null = open-ended ("until we say otherwise") */
  endsAt: number | null;
  message: string;
}

const NO_MAINTENANCE: MaintenanceWindow = { active: false, startsAt: null, endsAt: null, message: '' };

export async function getMaintenance(): Promise<MaintenanceWindow> {
  const rows = await q<{ active: boolean; starts_at: string | null; ends_at: string | null; message: string }>(
    `select active, starts_at, ends_at, message from maintenance where id = 1`,
  );
  const r = rows[0];
  if (!r) return NO_MAINTENANCE;
  return {
    active: !!r.active,
    startsAt: r.starts_at ? new Date(r.starts_at).getTime() : null,
    endsAt: r.ends_at ? new Date(r.ends_at).getTime() : null,
    message: r.message ?? '',
  };
}

export async function setMaintenance(w: MaintenanceWindow): Promise<MaintenanceWindow> {
  await q(
    `update maintenance
        set active = $1, starts_at = $2, ends_at = $3, message = $4, updated_at = now()
      where id = 1`,
    [
      w.active,
      w.startsAt ? new Date(w.startsAt).toISOString() : null,
      w.endsAt ? new Date(w.endsAt).toISOString() : null,
      w.message ?? '',
    ],
  );
  return getMaintenance();
}

/**
 * Is the lockdown BITING right now?
 *
 * Armed-but-not-yet-started deliberately does NOT lock. The point of scheduling a
 * window is to warn people before it takes effect, and a schedule that bites the
 * moment you set it cannot do that. A window whose end has passed also stops
 * biting on its own, so a lockdown somebody forgets to lift expires instead of
 * stranding the service until a human notices.
 */
export function maintenanceBiting(w: MaintenanceWindow, now = Date.now()): boolean {
  if (!w.active) return false;
  if (w.startsAt && now < w.startsAt) return false;
  if (w.endsAt && now >= w.endsAt) return false;
  return true;
}

/** aggregate presence over every machine heartbeating within `freshSeconds` (a few
 * missed beats). Sums sockets + ranked queues; de-dups signed-in users across regions
 * (a user connected from two regions counts once). */
export async function globalPresence(freshSeconds = 15): Promise<GlobalPresence> {
  const win = `${Math.max(1, Math.floor(freshSeconds))} seconds`;
  // ONE round trip, not two. This is the most-called query on the service and every
  // refresh used to cost a pair of statements — the sum, then a separate
  // `count(distinct)` over the same rows. Folding the distinct into a sub-select on a
  // shared CTE halves the per-refresh cost, which is what pays for the shorter cache
  // TTL in server/index.ts: accuracy and cost were traded against each other here, and
  // this is the move that buys both.
  const rows = await q<{
    online: number; q1: number; q2: number; signed_in: number; game_queues: unknown[];
  }>(
    `with fresh as (
       select * from presence where updated_at > now() - $1::interval
     )
     select coalesce(sum(online), 0)::int as online,
            coalesce(sum(q1v1), 0)::int as q1,
            coalesce(sum(q2v2), 0)::int as q2,
            (select count(distinct uid)::int
               from fresh f, jsonb_array_elements_text(f.authed) as uid) as signed_in,
            -- carried on the SAME round trip: this is the service's most-called
            -- query, and per-game depth is not worth a second one
            coalesce(jsonb_agg(game_queues), '[]'::jsonb) as game_queues
       from fresh`,
    [win],
  );
  const a = rows[0] ?? { online: 0, q1: 0, q2: 0, signed_in: 0, game_queues: [] };
  const gameQueues: Record<string, { '1v1': number; '2v2': number }> = {};
  for (const per of Array.isArray(a.game_queues) ? a.game_queues : []) addGameQueues(gameQueues, per);
  return {
    online: a.online,
    signedIn: a.signed_in ?? 0,
    queues: { '1v1': a.q1, '2v2': a.q2 },
    gameQueues,
  };
}

// ------------------------------------------------------------- friends ------
/**
 * Friends: a MUTUAL-CONSENT relation, plus presence, which is behavioural data
 * about a real person. Both are enforced here and in the handlers — never in the
 * client. The properties these functions exist to make structural:
 *
 *  - the acting user is ALWAYS the JWT `sub` the handler passes in; nothing here
 *    takes "who is acting" as data alongside "who to act on";
 *  - accept/decline/cancel/remove are CONDITIONAL writes scoped to the caller, and
 *    each returns false when it matched nothing — so naming a request that was
 *    never sent, or a friendship between two other people, is a 404 rather than a
 *    silent success;
 *  - presence is only ever reached THROUGH the caller's own friendship rows, so
 *    there is no query shape here that can return a non-friend's presence.
 */

/** a friend counts as online if their heartbeat landed within this window. The
 * client polls every ~30s, so 45s absorbs one missed beat without flapping. */
const ONLINE_WINDOW_S = 45;

export type PresenceStatus = 'online' | 'dnd' | 'invisible';

/** what a friend is doing right now — coarse and behavioural, reported by their
 * own heartbeat. null for an offline/invisible friend (blanked like last_seen). */
export type Activity = 'menu' | 'lobby' | 'match';

export interface FriendRow {
  userId: string;
  handle: string;
  username: string | null;
  online: boolean;
  /** 'dnd' shows a red dot; null = plain. NEVER 'invisible' — that is resolved
   * server-side into a plain offline row and is not observable by a friend. */
  status: 'dnd' | null;
  /** coarse seconds since last seen; null when online, never seen, or invisible.
   * Deliberately rounded (see `coarsen`) — the UI renders "3h", so second
   * precision would be a needlessly exact activity log to hand out. */
  offlineSeconds: number | null;
  /** 'menu' | 'lobby' | 'match' while online; null when offline/invisible/unknown */
  activity: Activity | null;
  /** which game they're in ('decode' | 'chain') — only meaningful with `activity` */
  game: Game | null;
  /** the room to SPECTATE, set only while a match they are in is actually running
   *  (see `liveRoomsByUser`). Absent otherwise — including in a lobby, and for the
   *  seconds a finished room lingers. */
  watch?: { room: string; region: string; ranked: boolean };
  /** active supporter membership — renders a small badge beside the name */
  supporter?: boolean;
  /** 'owner' | 'admin' — renders the staff badge instead of the supporter one */
  role?: StaffRole;
}

export interface FriendsPayload {
  friends: FriendRow[];
  incoming: PublicProfile[];
  outgoing: PublicProfile[];
  blocked: PublicProfile[];
  invites: RoomInvite[];
  /** challenges the CALLER sent that are still live — so the sender can see
   * "waiting for @x", cancel it, and be told once when it was declined. Without
   * this a sent challenge was invisible to the person who sent it. */
  sent: SentInvite[];
  status: PresenceStatus | null;
}

/** round an offline duration to the granularity the UI actually renders */
function coarsen(sec: number | null): number | null {
  if (sec === null || !Number.isFinite(sec) || sec < 0) return null;
  if (sec < 60) return 0; // "just now"
  if (sec < 3600) return Math.round(sec / 300) * 300; // 5-minute buckets
  if (sec < 86400) return Math.round(sec / 3600) * 3600; // hourly
  return Math.round(sec / 86400) * 86400; // daily
}

/** record that this user is around. Folded into the friends READ (see api.ts)
 * rather than given its own ping endpoint: the poll that refreshes everyone
 * else's status already proves the caller is here, and with no user id on the
 * wire there is nothing to forge. */
export async function touchPresence(
  userId: string,
  activity: Activity | null = null,
  game: Game | null = null,
): Promise<void> {
  await q(
    `insert into user_presence (user_id, last_seen_at, activity, activity_game)
       values ($1, now(), $2, $3)
     on conflict (user_id) do update
       set last_seen_at = now(), activity = $2, activity_game = $3`,
    [userId, activity, game],
  );
}

export async function setPresenceStatus(
  userId: string,
  status: PresenceStatus | null,
): Promise<void> {
  await q(
    `insert into user_presence (user_id, last_seen_at, status) values ($1, now(), $2)
     on conflict (user_id) do update set last_seen_at = now(), status = $2`,
    [userId, status],
  );
}

/**
 * The caller's whole friends view in ONE round trip. Every row is reached through
 * the caller's own friendships/requests/blocks, so this cannot be coaxed into
 * returning a stranger's presence.
 *
 * It genuinely is one trip now. This used to be six sequential `q()` calls, each
 * taking its own connection from the pool and paying its own latency to Neon, and
 * it is the single most-called authenticated query on the site — the friends panel
 * polls it on a timer for as long as anyone has the app open. Six trips became one
 * by aggregating each result set to JSON in the same statement: the row counts here
 * are tiny (your friends, your pending requests, your blocks), so the aggregation
 * costs nothing next to five extra round trips.
 *
 * Ordering lives inside each `json_agg` on purpose — an `order by` in a CTE is not
 * guaranteed to survive aggregation, so the sort has to be attached to the
 * aggregate itself, not to the subquery feeding it.
 */
export async function listFriends(userId: string): Promise<FriendsPayload> {
  const rows = await q<{
    friends: {
      user_id: string;
      handle: string;
      username: string | null;
      status: string | null;
      since: number | string | null;
      activity: string | null;
      activity_game: string | null;
      role: string | null;
      supporter: boolean;
    }[];
    incoming: ProfileCols[];
    outgoing: ProfileCols[];
    blocked: ProfileCols[];
    invites: InviteCols[];
    sent: SentCols[];
    own_status: string | null;
  }>(
    `with pairs as (
       select case when user_low = $1 then user_high else user_low end as friend_id
         from friendships
        where user_low = $1 or user_high = $1
     ),
     f as (
       select p.user_id, p.handle, p.username, ${badgeCols('p.')},
              case when up.status = 'invisible' then null else up.status end as status,
              case when up.status = 'invisible' then null
                   else extract(epoch from (now() - up.last_seen_at)) end as since,
              case when up.status = 'invisible' then null else up.activity end as activity,
              case when up.status = 'invisible' then null else up.activity_game end as activity_game
         from pairs
         join profiles p on p.user_id = pairs.friend_id
         left join user_presence up on up.user_id = pairs.friend_id
     ),
     inc as (
       select p.user_id, p.handle, p.username, ${badgeCols('p.')}, fr.created_at
         from friend_requests fr join profiles p on p.user_id = fr.from_user_id
        where fr.to_user_id = $1
     ),
     outg as (
       select p.user_id, p.handle, p.username, ${badgeCols('p.')}, fr.created_at
         from friend_requests fr join profiles p on p.user_id = fr.to_user_id
        where fr.from_user_id = $1
     ),
     blk as (
       select p.user_id, p.handle, p.username, ${badgeCols('p.')}
         from friend_blocks b join profiles p on p.user_id = b.blocked_id
        where b.blocker_id = $1
     ),
     inv as (
       select ri.id, ri.from_user_id, p.handle, p.username, ${badgeCols('p.')},
              ri.room, ri.game, ri.kind, ri.record, ri.format, ri.region, ri.created_at
         from room_invites ri join profiles p on p.user_id = ri.from_user_id
        -- a DECLINED challenge is gone for its recipient the instant they decline;
        -- the row lingers only so the SENDER can be told (see the snt CTE below)
        where ri.to_user_id = $1 and not ri.declined
          and ri.created_at > now() - $2::interval
     ),
     snt as (
       select ri.id, ri.to_user_id, p.handle, p.username, ${badgeCols('p.')},
              ri.room, ri.game, ri.kind, ri.record, ri.format, ri.region, ri.declined, ri.created_at
         from room_invites ri join profiles p on p.user_id = ri.to_user_id
        where ri.from_user_id = $1 and ri.created_at > now() - $2::interval
     )
     select
       coalesce((select json_agg(f order by f.handle) from f), '[]'::json) as friends,
       coalesce((select json_agg(json_build_object(
         'user_id', inc.user_id, 'handle', inc.handle, 'username', inc.username,
         'role', inc.role, 'supporter', inc.supporter)
         order by inc.created_at desc) from inc), '[]'::json) as incoming,
       coalesce((select json_agg(json_build_object(
         'user_id', outg.user_id, 'handle', outg.handle, 'username', outg.username,
         'role', outg.role, 'supporter', outg.supporter)
         order by outg.created_at desc) from outg), '[]'::json) as outgoing,
       coalesce((select json_agg(json_build_object(
         'user_id', blk.user_id, 'handle', blk.handle, 'username', blk.username,
         'role', blk.role, 'supporter', blk.supporter)
         order by blk.handle) from blk), '[]'::json) as blocked,
       -- created_at is formatted EXPLICITLY rather than let json_agg serialize the
       -- timestamptz: Postgres would emit '...798296+00:00' where the pg driver's
       -- Date gives '...798Z'. Same instant, different string, and this one is
       -- handed to clients verbatim - so match the old wire format exactly.
       coalesce((select json_agg(json_build_object(
         'id', inv.id, 'from_user_id', inv.from_user_id, 'handle', inv.handle,
         'username', inv.username, 'role', inv.role, 'supporter', inv.supporter,
         'room', inv.room, 'game', inv.game,
         'kind', inv.kind, 'record', inv.record, 'format', inv.format, 'region', inv.region,
         'created_at', to_char(inv.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
         order by inv.created_at desc) from inv), '[]'::json) as invites,
       coalesce((select json_agg(json_build_object(
         'id', snt.id, 'to_user_id', snt.to_user_id, 'handle', snt.handle,
         'username', snt.username, 'role', snt.role, 'supporter', snt.supporter,
         'room', snt.room, 'game', snt.game,
         'kind', snt.kind, 'record', snt.record, 'format', snt.format, 'region', snt.region,
         'declined', snt.declined,
         'created_at', to_char(snt.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
         order by snt.created_at desc) from snt), '[]'::json) as sent,
       (select status from user_presence where user_id = $1) as own_status`,
    [userId, `${INVITE_TTL_S} seconds`],
  );

  const row = rows[0];
  // where each friend is playing, for the Watch button. Resolved from the
  // heartbeat rather than from the friend's own activity beat: a client can claim
  // 'match' but cannot conjure a running room, and this is also the only source of
  // the hosting region. Never fatal — a failed lookup just costs the Watch buttons.
  const watchable = await liveRoomsByUser().catch((e) => {
    console.error('[friends] live-room lookup failed:', e);
    return new Map<string, UserLiveRoom>();
  });
  const friends: FriendRow[] = (row?.friends ?? []).map((r) => {
    const since = r.since === null ? null : Number(r.since);
    const online = since !== null && since <= ONLINE_WINDOW_S;
    // activity is meaningful only while online — an offline friend's LAST activity
    // is not something to report (they aren't doing it anymore)
    const activity =
      online && (r.activity === 'menu' || r.activity === 'lobby' || r.activity === 'match')
        ? (r.activity as Activity)
        : null;
    return {
      userId: r.user_id,
      handle: r.handle,
      username: r.username,
      online,
      status: r.status === 'dnd' ? 'dnd' : null,
      offlineSeconds: online ? null : coarsen(since),
      activity,
      game: activity ? (r.activity_game === 'chain' ? 'chain' : 'decode') : null,
      // `online` gates this so an invisible friend is never watchable: invisibility
      // nulls their last-seen, which is what `online` is computed from.
      watch: online ? watchable.get(r.user_id) : undefined,
      supporter: !!r.supporter,
      role: asRole(r.role),
    };
  });

  const st = row?.own_status ?? null;
  return {
    friends,
    incoming: (row?.incoming ?? []).map(shapeProfile),
    outgoing: (row?.outgoing ?? []).map(shapeProfile),
    blocked: (row?.blocked ?? []).map(shapeProfile),
    invites: (row?.invites ?? []).map(shapeInvite),
    sent: (row?.sent ?? []).map(shapeSent),
    status: st === 'online' || st === 'dnd' || st === 'invisible' ? st : null,
  };
}

/** the exact profile columns every friends query selects — an allowlist, never
 * `select *`: `profiles` also holds `settings`, and a future column would
 * otherwise join the payload silently.
 *
 * The two badge columns are part of the allowlist because these rows are NAMES ON
 * SCREEN — the friends list, the incoming/outgoing request lists, the challenge
 * toast — and a badge that appears on the leaderboard but not next to the same
 * person in your friends list reads as a bug. They cost nothing extra to read:
 * the `profiles` row is already joined, and this projects two more of its
 * columns rather than adding a lookup. */
interface ProfileCols {
  user_id: string;
  handle: string;
  username: string | null;
  role?: string | null;
  supporter?: boolean | null;
}
const shapeProfile = (r: ProfileCols): PublicProfile => ({
  userId: r.user_id,
  handle: r.handle,
  username: r.username,
  supporter: !!r.supporter,
  role: asRole(r.role),
});

/** the invite row shape, shared by `listFriends` (aggregated to JSON in one trip)
 * and `listRoomInvites` (its own query) so the two can never drift apart. */
interface InviteCols {
  id: string;
  from_user_id: string;
  handle: string;
  username: string | null;
  role: string | null;
  supporter: boolean | null;
  room: string;
  game: string;
  kind: string;
  record: string | null;
  format: string | null;
  region: string | null;
  created_at: string;
}
const shapeInvite = (r: InviteCols): RoomInvite => ({
  id: r.id,
  from: {
    userId: r.from_user_id,
    handle: r.handle,
    username: r.username,
    supporter: !!r.supporter,
    role: asRole(r.role),
  },
  room: r.room,
  game: r.game === 'chain' ? 'chain' : 'decode',
  kind: r.kind,
  record: r.record,
  format: r.format,
  region: r.region,
  createdAt: r.created_at,
});

/** the same row seen from the SENDER's side: the other party is the recipient,
 * and `declined` is meaningful (the recipient's own list never shows a declined
 * challenge at all). */
interface SentCols extends Omit<InviteCols, 'from_user_id'> {
  to_user_id: string;
  declined: boolean;
}
const shapeSent = (r: SentCols): SentInvite => ({
  id: r.id,
  to: {
    userId: r.to_user_id,
    handle: r.handle,
    username: r.username,
    supporter: !!r.supporter,
    role: asRole(r.role),
  },
  room: r.room,
  game: r.game === 'chain' ? 'chain' : 'decode',
  kind: r.kind,
  record: r.record,
  format: r.format,
  region: r.region,
  declined: !!r.declined,
  createdAt: r.created_at,
});

export type RequestOutcome = 'sent' | 'accepted' | 'already-friends' | 'blocked' | 'duplicate';

/**
 * Send a friend request. Returns an outcome instead of throwing so the handler
 * can map it to a status code.
 *
 * If the target has ALREADY sent the caller a request, this accepts it rather
 * than creating the mirror image — otherwise two people who both press Add end
 * up with two pending requests and no friendship, each looking at a request
 * they can't tell is already reciprocated.
 */
export async function sendFriendRequest(fromId: string, toId: string): Promise<RequestOutcome> {
  if (fromId === toId) return 'duplicate';
  return tx(async (query) => {
    // a block in EITHER direction stops the request. The handler reports this
    // the same way as an ordinary failure — telling a sender they were blocked
    // is itself the signal that lets someone confirm they were blocked.
    const blocks = await query<{ n: string }>(
      `select count(*) as n from friend_blocks
        where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1)`,
      [fromId, toId],
    );
    if (Number(blocks[0]?.n ?? 0) > 0) return 'blocked';

    const [low, high] = fromId < toId ? [fromId, toId] : [toId, fromId];
    const already = await query(`select 1 from friendships where user_low = $1 and user_high = $2`, [
      low,
      high,
    ]);
    if (already.length > 0) return 'already-friends';

    const reverse = await query(
      `delete from friend_requests where from_user_id = $1 and to_user_id = $2 returning 1`,
      [toId, fromId],
    );
    if (reverse.length > 0) {
      await query(
        `insert into friendships (user_low, user_high) values ($1, $2) on conflict do nothing`,
        [low, high],
      );
      return 'accepted';
    }

    const ins = await query(
      `insert into friend_requests (from_user_id, to_user_id) values ($1, $2)
       on conflict (from_user_id, to_user_id) do nothing returning 1`,
      [fromId, toId],
    );
    return ins.length > 0 ? 'sent' : 'duplicate';
  });
}

/**
 * Accept a pending request. The DELETE *is* the authorization check: it is
 * scoped to (from = the named sender, to = the CALLER), so it matches only a
 * request that person actually sent this caller, and the friendship is inserted
 * only when it matched. A read-then-write here would let a client accept a
 * request that was never sent and mint a friendship the other party never
 * agreed to — which then leaks that person's presence. False ⇒ handler 404s.
 */
export async function acceptFriendRequest(callerId: string, fromId: string): Promise<boolean> {
  if (callerId === fromId) return false;
  return tx(async (query) => {
    const del = await query(
      `delete from friend_requests where from_user_id = $1 and to_user_id = $2 returning 1`,
      [fromId, callerId],
    );
    if (del.length === 0) return false;
    const [low, high] = callerId < fromId ? [callerId, fromId] : [fromId, callerId];
    await query(
      `insert into friendships (user_low, user_high) values ($1, $2) on conflict do nothing`,
      [low, high],
    );
    return true;
  });
}

/** decline a request sent TO the caller (caller is the `to` side) */
export async function declineFriendRequest(callerId: string, fromId: string): Promise<boolean> {
  const del = await q(
    `delete from friend_requests where from_user_id = $1 and to_user_id = $2 returning 1`,
    [fromId, callerId],
  );
  return del.length > 0;
}

/** withdraw a request the caller SENT (caller is the `from` side) */
export async function cancelFriendRequest(callerId: string, toId: string): Promise<boolean> {
  const del = await q(
    `delete from friend_requests where from_user_id = $1 and to_user_id = $2 returning 1`,
    [callerId, toId],
  );
  return del.length > 0;
}

/** unfriend. One side of the pair is bound to the caller, so this can never
 * delete a friendship between two other people. */
export async function removeFriend(callerId: string, otherId: string): Promise<boolean> {
  const [low, high] = callerId < otherId ? [callerId, otherId] : [otherId, callerId];
  const del = await q(
    `delete from friendships where user_low = $1 and user_high = $2 returning 1`,
    [low, high],
  );
  return del.length > 0;
}

/** block someone: record it, then tear down the friendship and any pending
 * request in BOTH directions. Leaving the friendship in place would keep
 * leaking presence to the very person just blocked. */
export async function blockUser(callerId: string, targetId: string): Promise<boolean> {
  if (callerId === targetId) return false;
  return tx(async (query) => {
    await query(
      `insert into friend_blocks (blocker_id, blocked_id) values ($1, $2) on conflict do nothing`,
      [callerId, targetId],
    );
    const [low, high] = callerId < targetId ? [callerId, targetId] : [targetId, callerId];
    await query(`delete from friendships where user_low = $1 and user_high = $2`, [low, high]);
    await query(
      `delete from friend_requests
        where (from_user_id = $1 and to_user_id = $2) or (from_user_id = $2 and to_user_id = $1)`,
      [callerId, targetId],
    );
    return true;
  });
}

export async function unblockUser(callerId: string, targetId: string): Promise<boolean> {
  const del = await q(
    `delete from friend_blocks where blocker_id = $1 and blocked_id = $2 returning 1`,
    [callerId, targetId],
  );
  return del.length > 0;
}

// ------------------------------------------------------- room invites -------
/**
 * "Come join my room" for a friend, ridden on the same GET /api/friends read as
 * everything else here (no separate poll — see api.ts's block comment). Ephemeral:
 * a room outlives an invite by minutes, so expiry is enforced at READ time
 * (`INVITE_TTL_S`), not by a cron cleanup job.
 */
export interface RoomInvite {
  id: string;
  from: PublicProfile;
  /** for a casual/record challenge, the room code to join. For a RATED format
   * there is no room to join — this is the party token both sides hand the
   * matchmaker, which pairs them and stages the ranked match. */
  room: string;
  game: Game;
  kind: string;
  record: string | null;
  /** what was offered: 'casual1v1' | 'casual2v2' | 'rated1v1' | 'ranked2v2' |
   * 'duorecord'. Null on rows written before challenges carried a format, which
   * the client reads as the historical casual-versus meaning. */
  format: string | null;
  /** the REGION the room is hosted in. A custom code carries no region for the proxy to
   *  route on, so the recipient needs this to reach the machine the room is actually on;
   *  null on rows from a client older than the field. */
  region?: string | null;
  createdAt: string;
}

/** a challenge as its SENDER sees it — same row, other party, and `declined`
 * carries the one piece of news the sender is waiting on. */
export interface SentInvite extends Omit<RoomInvite, 'from'> {
  to: PublicProfile;
  declined: boolean;
}

const INVITE_TTL_S = 10 * 60;

export type InviteOutcome = 'sent' | 'not-friends';

/** invite a FRIEND to a room. Scoped to an existing friendship the same way a
 * friend request itself is scoped to a non-blocked pair — an invite is not a
 * new trust relationship, so it rides the one that already exists. */
export async function inviteToRoom(
  fromId: string,
  toId: string,
  room: string,
  game: Game,
  kind: string,
  record: string | null,
  format: string | null = null,
  /** the REGION the sender is hosting the room in. A custom room code is bare, so without
   *  this the recipient's socket routes to whichever machine is nearest to THEM — a
   *  different one, if the two players picked different servers, holding a different room
   *  with the same code. Empty ⇒ an older client; the recipient falls back to its own. */
  region: string | null = null,
): Promise<InviteOutcome> {
  const [low, high] = fromId < toId ? [fromId, toId] : [toId, fromId];
  const friend = await q(
    `select 1 from friendships where user_low = $1 and user_high = $2`,
    [low, high],
  );
  if (friend.length === 0) return 'not-friends';
  // One live challenge per direction. Spamming Challenge used to stack a row per
  // click, and for a RATED format that is worse than untidy: each row carries its
  // own party token, so the recipient could accept a stale one and sit in a
  // private queue waiting for a challenger who is already waiting under a
  // different token. Replacing keeps exactly one token in play.
  await q(`delete from room_invites where from_user_id = $1 and to_user_id = $2`, [fromId, toId]);
  await q(
    `insert into room_invites (from_user_id, to_user_id, room, game, kind, record, format, region)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [fromId, toId, room, game, kind, record, format, region || null],
  );
  return 'sent';
}

/**
 * Decline a challenge addressed to the caller. MARKS rather than deletes: the row
 * is what tells the sender their challenge was answered at all, and deleting it
 * makes a decline indistinguishable from being ignored. The sender's client
 * collects the news and then cancels it for real; one never collected falls out
 * of the read TTL like anything else here.
 */
export async function declineRoomInvite(userId: string, id: string): Promise<boolean> {
  const upd = await q(
    `update room_invites set declined = true where id = $1 and to_user_id = $2 returning 1`,
    [id, userId],
  );
  return upd.length > 0;
}

/** withdraw a challenge the caller SENT. Scoped to the sender, mirroring
 * `dismissRoomInvite`'s scoping to the recipient — neither can touch the other's
 * view of a row they don't own. */
export async function cancelRoomInvite(userId: string, id: string): Promise<boolean> {
  const del = await q(
    `delete from room_invites where id = $1 and from_user_id = $2 returning 1`,
    [id, userId],
  );
  return del.length > 0;
}

/**
 * Resolve a party token to the two accounts it belongs to, for a caller claiming
 * to be one of them. Returns null if there is no live challenge on that token
 * naming the caller.
 *
 * This is the matchmaker's gate for a RATED friend match, and it is not optional.
 * A party token is otherwise just a string two clients agreed on: without this
 * check any pair of clients could hand each other one and stage themselves a
 * rated, leaderboard-affecting match with no friendship, no challenge, and no
 * invite the other person ever saw. Returning the PAIR (rather than a yes/no) is
 * what lets the matchmaker also refuse to pair a token with anyone but its two
 * rightful members.
 */
export async function challengeParty(
  userId: string,
  token: string,
  format: string,
): Promise<{ from: string; to: string } | null> {
  const rows = await q<{ from_user_id: string; to_user_id: string }>(
    `select from_user_id, to_user_id from room_invites
      where room = $2 and format = $3 and created_at > now() - $4::interval
        and (from_user_id = $1 or to_user_id = $1)
      limit 1`,
    [userId, token, format, `${INVITE_TTL_S} seconds`],
  );
  const r = rows[0];
  return r ? { from: r.from_user_id, to: r.to_user_id } : null;
}

/** invites addressed to `userId`, freshest first, older than the TTL dropped. */
export async function listRoomInvites(userId: string): Promise<RoomInvite[]> {
  const rows = await q<{
    id: string;
    from_user_id: string;
    handle: string;
    username: string | null;
    role: string | null;
    supporter: boolean | null;
    room: string;
    game: string;
    kind: string;
    record: string | null;
    format: string | null;
    region: string | null;
    created_at: string;
  }>(
    `select ri.id, ri.from_user_id, p.handle, p.username, ${badgeCols('p.')},
            ri.room, ri.game, ri.kind, ri.record, ri.format, ri.region, ri.created_at
       from room_invites ri
       join profiles p on p.user_id = ri.from_user_id
      where ri.to_user_id = $1 and not ri.declined
        and ri.created_at > now() - $2::interval
      order by ri.created_at desc`,
    [userId, `${INVITE_TTL_S} seconds`],
  );
  return rows.map(shapeInvite);
}

/** dismiss (or consume, on join) an invite. Scoped to the RECIPIENT, so a
 * caller can never clear someone else's invite. */
export async function dismissRoomInvite(userId: string, id: string): Promise<boolean> {
  const del = await q(
    `delete from room_invites where id = $1 and to_user_id = $2 returning 1`,
    [id, userId],
  );
  return del.length > 0;
}

/**
 * Public user search for the "add a friend" box. Deliberately NOT `searchProfiles`
 * (the admin substring-on-handle search): a public substring search over display
 * names lets anyone enumerate every name on the service. This is a PREFIX match on
 * the unique `username` — the same public identifier already exposed one at a time
 * at /api/profile/<username>.
 */
export async function searchUsersByName(query: string, limit = 20): Promise<PublicProfile[]> {
  // Escape LIKE wildcards before appending `%`. Without this, searching for "%"
  // or "_" matches every row at once, turning a lookup back into the
  // full-enumeration endpoint this function exists to avoid.
  const esc = query.replace(/[\\%_]/g, '\\$&');
  const rows = await q<ProfileCols>(
    // Matches the @username OR the DISPLAY NAME. The handle match is a WORD prefix
    // (`kim` finds "Dohun Kim") rather than a free substring: a substring match makes
    // the endpoint a general "give me every name containing these two letters" probe,
    // and word-prefix covers what someone searching a name actually types. Display
    // names are already public on every leaderboard row, so this exposes no new field
    // — it changes how cheaply the set can be walked, which is why it stays bounded.
    //
    // `username is not null` because BOTH callers need one: the search bar opens
    // /profile/<username> and the friends box sends a request by username, so a row
    // without one is a dead result the UI has to disable.
    `select user_id, handle, username, ${badgeCols('')} from profiles
      where username is not null
        and (username ilike $1 escape '\\'
             or handle ilike $1 escape '\\'
             or handle ilike $2 escape '\\')
      order by
        -- the thing they typed most literally, first
        case when username ilike $1 escape '\\' then 0
             when handle ilike $1 escape '\\' then 1
             else 2 end,
        username
      limit $3`,
    [esc + '%', '% ' + esc + '%', Math.min(Math.max(1, limit), 50)],
  );
  return rows.map(shapeProfile);
}
