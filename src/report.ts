/**
 * PLAYER REPORTS — the shared vocabulary, used by the client picker, the server validator
 * and the moderation panel, so the three can never disagree about what a category means.
 *
 * THE CATEGORIES COME FROM THIS GAME, not from a generic list. DSIM has no chat, no voice
 * and no direct messaging, so "abusive messages" is not a thing that can happen here and
 * offering it would collect reports nobody can act on. The surfaces a player can actually
 * misuse are:
 *
 *   - the MATCH itself (throwing, sitting out, abandoning)
 *   - the CLIENT (the sim is server-authoritative, but the robot SPEC is client-supplied
 *     and `coerceSpec` is the only thing standing between the wire and the world)
 *   - the free TEXT they own: display name, team name, robot name — the entire surface for
 *     harassment in a game with no chat, and the reason `name` is a first-class category
 *     rather than being folded into "other"
 *
 * `dodging` overlaps the automatic dodge penalty on purpose. The automatic one charges
 * rating for a single abandoned pairing; a report is how a HUMAN flags a pattern the
 * escalation window is too short to catch (someone dodging twice a day, every day).
 */

export const REPORT_REASONS = [
  'cheating',
  'throwing',
  'afk',
  'dodging',
  'name',
  'other',
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_LABELS: Record<ReportReason, string> = {
  cheating: 'Cheating / modified client',
  throwing: 'Throwing the match on purpose',
  afk: 'Not playing / AFK',
  dodging: 'Repeatedly abandoning matches',
  name: 'Offensive name',
  other: 'Something else',
};

export const REPORT_BLURBS: Record<ReportReason, string> = {
  cheating: 'Impossible robot, impossible movement, or scores that cannot happen',
  throwing: 'Deliberately losing — scoring for the other alliance, driving into walls',
  afk: 'Present but not driving, for most of the match',
  dodging: 'Keeps leaving ranked matches after being paired',
  name: 'Offensive display name, team name or robot name',
  other: 'Anything else — please describe it below',
};

/** free-text cap. Long enough for a sentence of context, short enough that the field is not
 *  a channel for the abuse it exists to report. */
export const REPORT_DETAIL_MAX = 300;

export const isReportReason = (v: unknown): v is ReportReason =>
  typeof v === 'string' && (REPORT_REASONS as readonly string[]).includes(v);

/** what the moderation panel shows per reported player */
export interface ReportedUser {
  userId: string;
  handle: string;
  username: string | null;
  /** total reports on file */
  total: number;
  /** reports not yet triaged */
  open: number;
  /** distinct reporters — four reports from four people is a very different signal from
   *  four from one, and the panel sorts on it */
  reporters: number;
  /** newest report timestamp (ISO) */
  latest: string;
  /** category counts, most common first */
  reasons: { reason: ReportReason; n: number }[];
  /** their ACCOUNT STANDING score, or null if they have never been charged one. The
   *  corroborating half of a report: reports are what other players claim, standing is what
   *  the server itself watched them do. */
  standing?: number | null;
}

/** one report in the per-user drill-down */
export interface ReportRow {
  id: string;
  reason: ReportReason;
  detail: string | null;
  roomCode: string;
  game: string;
  status: 'open' | 'reviewed' | 'dismissed';
  createdAt: string;
  reporterHandle: string;
  reporterUsername: string | null;
}
