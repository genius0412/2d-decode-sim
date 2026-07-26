import type { Replay } from '../../src/sim/replay';
import type { AssistConfig, GameId, RobotSpec } from '../../src/types';
import type { PendingMatch, PendingRosterEntry } from '../matchTypes';
import { PLACEMENT_GAMES } from '../../src/config';
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
   * OPTIONAL because only the surfaces that actually render a badge pay for the
   * extra column: the profile page and the leaderboards do, the friends-list
   * queries (three per poll, every few seconds) deliberately do not. `undefined`
   * means "not asked", which the client renders identically to false.
   */
  supporter?: boolean;
}

/** the badge predicate, written once. `supporter_until` is an instant, and the
 *  comparison must happen in Postgres — the five regional machines do not share
 *  a clock, and a skewed one would show a badge that has already lapsed. */
const SUPPORTER_COL = `(supporter_until is not null and supporter_until > now()) as supporter`;

/** a user's public profile (display handle + unique username), or null */
export async function getProfile(userId: string): Promise<PublicProfile | null> {
  const rows = await q<{ handle: string; username: string | null; supporter: boolean }>(
    `select handle, username, ${SUPPORTER_COL} from profiles where user_id = $1`,
    [userId],
  );
  return rows[0]
    ? {
        userId,
        handle: rows[0].handle,
        username: rows[0].username,
        supporter: !!rows[0].supporter,
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
  }>(
    `select user_id, handle, username, ${SUPPORTER_COL} from profiles where username = $1`,
    [username],
  );
  const r = rows[0];
  return r
    ? { userId: r.user_id, handle: r.handle, username: r.username, supporter: !!r.supporter }
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
}

const NOT_A_SUPPORTER: SupporterState = {
  supporter: false,
  supporterUntil: null,
  autoRenews: false,
};

export async function getSupporter(userId: string): Promise<SupporterState> {
  const rows = await q<{ until: string | null; active: boolean; linked: boolean }>(
    `select supporter_until as until,
            (supporter_until is not null and supporter_until > now()) as active,
            (kofi_email is not null) as linked
       from profiles where user_id = $1`,
    [userId],
  );
  if (!rows[0]) return NOT_A_SUPPORTER;
  return {
    supporter: !!rows[0].active,
    supporterUntil: rows[0].until,
    autoRenews: !!rows[0].linked,
  };
}

/** the currently-active supporters among `userIds` — one query, for badges on a
 *  leaderboard page or an in-match roster (a per-row lookup would not do). */
export async function supportersAmong(userIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Set();
  const rows = await q<{ user_id: string }>(
    `select user_id from profiles
      where user_id = any($1::text[]) and supporter_until > now()`,
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
    `insert into replays (format, balance_version, sim_version, seed, ticks, setups, tracks, game)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [
      replay.format,
      season, // balance_version = SEASON (purge key + index, see 0004)
      replay.balanceVersion, // sim_version = the sim-code version that recorded it
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
    game: Game;
    seed: string;
    ticks: number;
    setups: Replay['setups'];
    tracks: Replay['tracks'];
  }>(
    `select format, balance_version, sim_version, game, seed, ticks, setups, tracks from replays where id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    format: r.format,
    // the gate re-sims: it needs the CODE version. Fall back to balance_version for
    // any legacy row the sim_version backfill somehow missed.
    balanceVersion: r.sim_version ?? r.balance_version,
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
     select b.user_id as "userId", p.handle, p.username,
            (p.supporter_until is not null and p.supporter_until > now()) as supporter,
            b.partner_id as "partnerId",
            pp.handle as "partnerHandle", pp.username as "partnerUsername",
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
  }[]
> {
  return q(
    `select user_id as "userId", handle, username,
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

/** The public leaderboard for an ACT's board — PLACED players only (games >=
 * PLACEMENT_GAMES). Players still in placements are intentionally omitted;
 * `eloUserStanding` reports the viewer's own standing separately. */
export async function eloLeaderboard(opts: {
  mode: '1v1' | '2v2';
  act: number;
  limit?: number;
  game?: Game;
}): Promise<{ userId: string; handle: string; username: string | null; rating: number; games: number }[]> {
  return q<{ userId: string; handle: string; username: string | null; rating: number; games: number }>(
    `select e.user_id as "userId", p.handle, p.username, e.rating, e.games
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
}): Promise<{ userId: string; handle: string; username: string | null; rating: number; games: number }[]> {
  return q<{ userId: string; handle: string; username: string | null; rating: number; games: number }>(
    `select h.user_id as "userId", p.handle, p.username, h.rating, h.games
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
  season: number;
  elo: UserEloStat[];
  records: UserRecordStat[];
  match: { played: number; wins: number; losses: number };
  recent: UserMatchRow[];
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
    q<{ handle: string; username: string | null; supporter: boolean }>(
      `select handle, username, ${SUPPORTER_COL} from profiles where user_id = $1`,
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

  return {
    userId,
    handle: profile[0]?.handle ?? null,
    supporter: !!profile[0]?.supporter,
    username: profile[0]?.username ?? null,
    season: balanceVersion,
    elo: elos,
    records,
    match: { played, wins, losses: played - wins },
    recent,
  };
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
    }>(
      `select mp.match_id::text as id, mp.user_id, mp.alliance, mp.score, p.handle, p.username
       from match_participants mp join profiles p on p.user_id = mp.user_id
       where mp.match_id = any($1::uuid[])`,
      [versusIds],
    );
    for (const p of parts) {
      const list = byMatch.get(p.id) ?? [];
      list.push({ userId: p.user_id, handle: p.handle, username: p.username, alliance: p.alliance });
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
    const profs = await q<{ user_id: string; handle: string; username: string | null }>(
      `select user_id, handle, username from profiles where user_id = any($1::text[])`,
      [[...need]],
    );
    const byUser = new Map(profs.map((p) => [p.user_id, p]));
    const mk = (uid: string): MatchHistoryPlayer => {
      const p = byUser.get(uid);
      return { userId: uid, handle: p?.handle ?? 'Player', username: p?.username ?? null, alliance: null };
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
  queues: { '1v1': number; '2v2': number };
}

/** heartbeat THIS machine's live counts (upsert keyed by machine id). */
export async function upsertPresence(
  machine: string,
  region: string,
  online: number,
  authedUserIds: string[],
  q1v1: number,
  q2v2: number,
): Promise<void> {
  await q(
    `insert into presence (machine, region, online, authed, q1v1, q2v2, updated_at)
       values ($1, $2, $3, $4::jsonb, $5, $6, now())
     on conflict (machine) do update
       set region = $2, online = $3, authed = $4::jsonb, q1v1 = $5, q2v2 = $6, updated_at = now()`,
    [machine, region, online, JSON.stringify(authedUserIds), q1v1, q2v2],
  );
}

/** aggregate presence over every machine heartbeating within `freshSeconds` (a few
 * missed beats). Sums sockets + ranked queues; de-dups signed-in users across regions
 * (a user connected from two regions counts once). */
export async function globalPresence(freshSeconds = 15): Promise<GlobalPresence> {
  const win = `${Math.max(1, Math.floor(freshSeconds))} seconds`;
  const agg = await q<{ online: number; q1: number; q2: number }>(
    `select coalesce(sum(online), 0)::int as online,
            coalesce(sum(q1v1), 0)::int as q1,
            coalesce(sum(q2v2), 0)::int as q2
       from presence where updated_at > now() - $1::interval`,
    [win],
  );
  const su = await q<{ n: number }>(
    `select count(distinct uid)::int as n
       from presence p, jsonb_array_elements_text(p.authed) as uid
      where p.updated_at > now() - $1::interval`,
    [win],
  );
  const a = agg[0] ?? { online: 0, q1: 0, q2: 0 };
  return { online: a.online, signedIn: su[0]?.n ?? 0, queues: { '1v1': a.q1, '2v2': a.q2 } };
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
}

export interface FriendsPayload {
  friends: FriendRow[];
  incoming: PublicProfile[];
  outgoing: PublicProfile[];
  blocked: PublicProfile[];
  invites: RoomInvite[];
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
    }[];
    incoming: ProfileCols[];
    outgoing: ProfileCols[];
    blocked: ProfileCols[];
    invites: {
      id: string;
      from_user_id: string;
      handle: string;
      username: string | null;
      room: string;
      game: string;
      kind: string;
      record: string | null;
      created_at: string;
    }[];
    own_status: string | null;
  }>(
    `with pairs as (
       select case when user_low = $1 then user_high else user_low end as friend_id
         from friendships
        where user_low = $1 or user_high = $1
     ),
     f as (
       select p.user_id, p.handle, p.username,
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
       select p.user_id, p.handle, p.username, fr.created_at
         from friend_requests fr join profiles p on p.user_id = fr.from_user_id
        where fr.to_user_id = $1
     ),
     outg as (
       select p.user_id, p.handle, p.username, fr.created_at
         from friend_requests fr join profiles p on p.user_id = fr.to_user_id
        where fr.from_user_id = $1
     ),
     blk as (
       select p.user_id, p.handle, p.username
         from friend_blocks b join profiles p on p.user_id = b.blocked_id
        where b.blocker_id = $1
     ),
     inv as (
       select ri.id, ri.from_user_id, p.handle, p.username, ri.room, ri.game, ri.kind,
              ri.record, ri.created_at
         from room_invites ri join profiles p on p.user_id = ri.from_user_id
        where ri.to_user_id = $1 and ri.created_at > now() - $2::interval
     )
     select
       coalesce((select json_agg(f order by f.handle) from f), '[]'::json) as friends,
       coalesce((select json_agg(json_build_object(
         'user_id', inc.user_id, 'handle', inc.handle, 'username', inc.username)
         order by inc.created_at desc) from inc), '[]'::json) as incoming,
       coalesce((select json_agg(json_build_object(
         'user_id', outg.user_id, 'handle', outg.handle, 'username', outg.username)
         order by outg.created_at desc) from outg), '[]'::json) as outgoing,
       coalesce((select json_agg(json_build_object(
         'user_id', blk.user_id, 'handle', blk.handle, 'username', blk.username)
         order by blk.handle) from blk), '[]'::json) as blocked,
       -- created_at is formatted EXPLICITLY rather than let json_agg serialize the
       -- timestamptz: Postgres would emit '...798296+00:00' where the pg driver's
       -- Date gives '...798Z'. Same instant, different string, and this one is
       -- handed to clients verbatim - so match the old wire format exactly.
       coalesce((select json_agg(json_build_object(
         'id', inv.id, 'from_user_id', inv.from_user_id, 'handle', inv.handle,
         'username', inv.username, 'room', inv.room, 'game', inv.game,
         'kind', inv.kind, 'record', inv.record,
         'created_at', to_char(inv.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
         order by inv.created_at desc) from inv), '[]'::json) as invites,
       (select status from user_presence where user_id = $1) as own_status`,
    [userId, `${INVITE_TTL_S} seconds`],
  );

  const row = rows[0];
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
    };
  });

  const st = row?.own_status ?? null;
  return {
    friends,
    incoming: (row?.incoming ?? []).map(shapeProfile),
    outgoing: (row?.outgoing ?? []).map(shapeProfile),
    blocked: (row?.blocked ?? []).map(shapeProfile),
    invites: (row?.invites ?? []).map(shapeInvite),
    status: st === 'online' || st === 'dnd' || st === 'invisible' ? st : null,
  };
}

/** the exact profile columns every friends query selects — an allowlist, never
 * `select *`: `profiles` also holds `settings`, and a future column would
 * otherwise join the payload silently. */
interface ProfileCols {
  user_id: string;
  handle: string;
  username: string | null;
}
const shapeProfile = (r: ProfileCols): PublicProfile => ({
  userId: r.user_id,
  handle: r.handle,
  username: r.username,
});

/** the invite row shape, shared by `listFriends` (aggregated to JSON in one trip)
 * and `listRoomInvites` (its own query) so the two can never drift apart. */
interface InviteCols {
  id: string;
  from_user_id: string;
  handle: string;
  username: string | null;
  room: string;
  game: string;
  kind: string;
  record: string | null;
  created_at: string;
}
const shapeInvite = (r: InviteCols): RoomInvite => ({
  id: r.id,
  from: { userId: r.from_user_id, handle: r.handle, username: r.username },
  room: r.room,
  game: r.game === 'chain' ? 'chain' : 'decode',
  kind: r.kind,
  record: r.record,
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
  room: string;
  game: Game;
  kind: string;
  record: string | null;
  createdAt: string;
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
): Promise<InviteOutcome> {
  const [low, high] = fromId < toId ? [fromId, toId] : [toId, fromId];
  const friend = await q(
    `select 1 from friendships where user_low = $1 and user_high = $2`,
    [low, high],
  );
  if (friend.length === 0) return 'not-friends';
  await q(
    `insert into room_invites (from_user_id, to_user_id, room, game, kind, record)
     values ($1, $2, $3, $4, $5, $6)`,
    [fromId, toId, room, game, kind, record],
  );
  return 'sent';
}

/** invites addressed to `userId`, freshest first, older than the TTL dropped. */
export async function listRoomInvites(userId: string): Promise<RoomInvite[]> {
  const rows = await q<{
    id: string;
    from_user_id: string;
    handle: string;
    username: string | null;
    room: string;
    game: string;
    kind: string;
    record: string | null;
    created_at: string;
  }>(
    `select ri.id, ri.from_user_id, p.handle, p.username, ri.room, ri.game, ri.kind, ri.record,
            ri.created_at
       from room_invites ri
       join profiles p on p.user_id = ri.from_user_id
      where ri.to_user_id = $1 and ri.created_at > now() - $2::interval
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
export async function searchUsersByUsername(prefix: string, limit = 20): Promise<PublicProfile[]> {
  // Escape LIKE wildcards before appending `%`. Without this, searching for "%"
  // or "_" matches every username at once, turning a prefix lookup back into the
  // full-enumeration endpoint this function exists to avoid.
  const esc = prefix.replace(/[\\%_]/g, '\\$&');
  const rows = await q<ProfileCols>(
    `select user_id, handle, username from profiles
      where username ilike $1 escape '\\'
      order by username limit $2`,
    [esc + '%', Math.min(Math.max(1, limit), 50)],
  );
  return rows.map(shapeProfile);
}
