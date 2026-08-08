import { PLACEMENT_GAMES } from './config';

/**
 * RANKED STANDINGS — the visible ladder over the Glicko-2 rating.
 *
 * The rating itself is unchanged and stays authoritative: this module only READS it and
 * names it. Nothing here is persisted, so the ladder can be re-cut (boundaries, names,
 * division count) without a migration and without touching a single stored rating.
 *
 * WHY A LADDER AT ALL. A bare number tells a player almost nothing: 1063 is meaningless
 * without knowing the distribution, and it moves by single digits once a rating settles, so
 * it reads as static even while real progress happens. A named tier plus a filling bar
 * answers "where am I" and "am I getting anywhere" at a glance, which is the whole job.
 *
 * THEME. The tiers are the FTC competition ladder, because DSIM is an FTC simulator and a
 * generic Bronze→Diamond run would be borrowed from games this one has nothing to do with.
 * A player climbs the same path a real team does — from a league Meet up to Worlds — and the
 * apex is INSPIRE, after FIRST's top award.
 *
 * WHERE THE NUMBERS COME FROM. Measured against the real Glicko implementation
 * (`server/ranked.ts`) at the rating players actually start on:
 *
 *   brand new (RD 350)   ±162 per match
 *   after placements     ± 51
 *   settled   (RD  80)   ± 17
 *   very settled (RD 50) ±  7
 *
 * So a DIVISION of 50 is ~3 net wins for a settled player and a TIER of 150 is ~9 — a
 * division is a session's worth of progress, a tier is a milestone. Placements (RD 350→150)
 * swing hundreds of points, which is exactly what placements are for: five games should be
 * able to put you anywhere on the ladder.
 */

/**
 * A fresh account's rating. NOT Glicko's 1500 centre — `getRatingFull` defaults an unrated
 * player to 1000 and the column defaults to 1000, so 1000 is where the population actually
 * enters. The ladder is centred on it: a new player who plays to a draw lands at the bottom
 * of REGIONAL, the third of six rating tiers, with three tiers above and two below.
 *
 * Getting this wrong is the easy mistake here — building the bands around Glicko's internal
 * centre would have put every real player two tiers below the middle of their own ladder.
 */
export const RANK_ENTRY_RATING = 1000;

/** Ratings never fall below this. Glicko has no floor of its own, and a long enough losing
 *  run (or a run of dodge penalties) would otherwise print an absurd number on a badge. */
export const RANK_FLOOR = 400;

/** rating span of one full tier, and of one division within it */
export const TIER_SPAN = 150;
export const DIVISIONS_PER_TIER = 3;
export const DIVISION_SPAN = TIER_SPAN / DIVISIONS_PER_TIER; // 50

export type RankTierKey = 'rookie' | 'meet' | 'qualifier' | 'regional' | 'championship' | 'worlds' | 'inspire';

export interface RankTier {
  key: RankTierKey;
  name: string;
  /** lowest rating in this tier. `-Infinity` for the bottom tier, so nothing falls off. */
  floor: number;
  /** does this tier subdivide into III / II / I? The apex does not — at the top there is
   *  nothing left to sub-divide toward, and a leaderboard POSITION says more than a
   *  division would. */
  divisions: boolean;
  /** the accent this tier paints with, as a CSS custom property name */
  varName: string;
}

/**
 * The ladder, lowest first.
 *
 * MEET has no floor of its own: it is where a player who loses their way down ends up, and
 * a tier you can fall out of the bottom of would need a name for the place below it.
 */
export const RANK_TIERS: readonly RankTier[] = [
  { key: 'meet', name: 'Meet', floor: -Infinity, divisions: true, varName: '--ds-rank-meet' },
  { key: 'qualifier', name: 'Qualifier', floor: 850, divisions: true, varName: '--ds-rank-qualifier' },
  { key: 'regional', name: 'Regional', floor: 1000, divisions: true, varName: '--ds-rank-regional' },
  { key: 'championship', name: 'Championship', floor: 1150, divisions: true, varName: '--ds-rank-championship' },
  { key: 'worlds', name: 'Worlds', floor: 1300, divisions: true, varName: '--ds-rank-worlds' },
  { key: 'inspire', name: 'Inspire', floor: 1450, divisions: false, varName: '--ds-rank-inspire' },
];

/** the placement tier — not part of `RANK_TIERS` because it is not a rating band. A player
 *  is in it because they have not finished placements, whatever their rating says. */
export const ROOKIE_TIER: RankTier = {
  key: 'rookie',
  name: 'Rookie',
  floor: -Infinity,
  divisions: false,
  varName: '--ds-rank-rookie',
};

export interface Standing {
  tier: RankTier;
  /** 1 (highest) .. DIVISIONS_PER_TIER (lowest) within the tier; 0 when the tier has none */
  division: number;
  /** "Regional II", "Inspire", "Rookie" */
  label: string;
  /** 0..1 through the CURRENT division (or the tier, when it has no divisions) — what the
   *  progress bar fills to */
  progress: number;
  /** rating still needed to reach the next division/tier, or null at the apex */
  toNext: number | null;
  /** still playing placement matches: the rating is not yet meaningful */
  placement: boolean;
  /** placement matches played / required (only meaningful while `placement`) */
  played: number;
  /** the rating this standing was derived from, floored */
  rating: number;
}

/** clamp a raw rating into the ladder's range */
export const clampRating = (rating: number): number =>
  Number.isFinite(rating) ? Math.max(RANK_FLOOR, Math.round(rating)) : RANK_ENTRY_RATING;

/** the tier a rating sits in (ignores placements — see `standingFor`) */
export function tierFor(rating: number): RankTier {
  const r = clampRating(rating);
  let out = RANK_TIERS[0];
  for (const t of RANK_TIERS) if (r >= t.floor) out = t;
  return out;
}

/**
 * The full standing for a player: tier, division, and how far through it they are.
 *
 * PLACEMENTS COME FIRST. Below `PLACEMENT_GAMES` the rating is still swinging by ±50–160 a
 * match, so naming a tier from it would promote and demote a new player several times in
 * their first evening. They are ROOKIE until placements finish, and the bar tracks games
 * played rather than rating — the honest thing to show, because games played is exactly
 * what stands between them and a real rank.
 */
export function standingFor(rating: number, games: number): Standing {
  const r = clampRating(rating);
  if (games < PLACEMENT_GAMES) {
    return {
      tier: ROOKIE_TIER,
      division: 0,
      label: ROOKIE_TIER.name,
      progress: Math.max(0, Math.min(1, games / PLACEMENT_GAMES)),
      toNext: null,
      placement: true,
      played: games,
      rating: r,
    };
  }
  const tier = tierFor(r);
  if (!tier.divisions) {
    // the apex has no ceiling to fill toward, so the bar is shown full rather than
    // pretending there is a next step
    return {
      tier,
      division: 0,
      label: tier.name,
      progress: 1,
      toNext: null,
      placement: false,
      played: games,
      rating: r,
    };
  }
  // how far into the tier, in divisions. The bottom tier is open-ended downward, so it is
  // measured from its own TOP (the next tier's floor) rather than from a floor it lacks.
  const next = RANK_TIERS[RANK_TIERS.indexOf(tier) + 1];
  const top = next ? next.floor : tier.floor + TIER_SPAN;
  const base = Number.isFinite(tier.floor) ? tier.floor : top - TIER_SPAN;
  const into = Math.max(0, Math.min(TIER_SPAN - 1e-9, r - base));
  const idx = Math.floor(into / DIVISION_SPAN); // 0 = lowest division
  const division = DIVISIONS_PER_TIER - idx; // III is lowest, I is highest
  const within = (into - idx * DIVISION_SPAN) / DIVISION_SPAN;
  return {
    tier,
    division,
    label: `${tier.name} ${ROMAN[division] ?? division}`,
    progress: Math.max(0, Math.min(1, within)),
    toNext: Math.max(0, Math.ceil(base + (idx + 1) * DIVISION_SPAN - r)),
    placement: false,
    played: games,
    rating: r,
  };
}

const ROMAN: Record<number, string> = { 1: 'I', 2: 'II', 3: 'III' };

/** Did a rating change cross a tier boundary? Drives the results screen's promotion /
 *  demotion callout — the one moment the ladder is worth interrupting for. */
export function tierChange(
  before: number,
  after: number,
  gamesAfter: number,
): 'promoted' | 'demoted' | null {
  // a player finishing placements has no "before" tier to have been promoted FROM
  if (gamesAfter <= PLACEMENT_GAMES) return null;
  const a = tierFor(before);
  const b = tierFor(after);
  if (a.key === b.key) return null;
  return RANK_TIERS.indexOf(b) > RANK_TIERS.indexOf(a) ? 'promoted' : 'demoted';
}
