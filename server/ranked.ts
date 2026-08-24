import type { Alliance, GameId } from '../src/types';
import type { MatchOutcome, MatchParticipant } from './room';
import {
  actForSeason,
  addMatchParticipant,
  getRatingFull,
  saveMatch,
  upsertEloHistory,
  upsertRating,
} from './db/repo';

/**
 * Ranked ratings — Glicko-2 (the chess.com model). Beyond a single Elo number,
 * each rating carries a rating DEVIATION (RD, the confidence interval) and a
 * VOLATILITY. A fresh/idle player has a high RD, so early games swing the rating
 * hard; as RD shrinks with games the rating settles. `computeGlicko` is PURE +
 * unit-tested; `persistVersusMatch` wraps it with the DB reads/writes at match end
 * (ranked matches only — custom rooms persist the match but move no rating).
 *
 * Boards: one rating per (mode × season) — ranked is NOT divided by drivetrain.
 * `mode` is inferred from the head count: 2 players ⇒ 1v1, 4 ⇒ 2v2.
 */

// Glicko-2 constants. SCALE/CENTER map the public rating onto the internal (μ, φ)
// scale; TAU constrains volatility change; below RD_PROVISIONAL a rating is
// "established" (shown without the provisional "?").
const SCALE = 173.7178;
const CENTER = 1500;
const TAU = 0.5;
export const RD_PROVISIONAL = 110;

export interface Glicko {
  rating: number;
  rd: number;
  vol: number;
}

const gphi = (phi: number): number => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const expect = (mu: number, muj: number, phij: number): number =>
  1 / (1 + Math.exp(-gphi(phij) * (mu - muj)));

/** one Glicko-2 update for a player against a single (possibly team-aggregate)
 * opponent, given the game score s (1 win / 0.5 draw / 0 loss). Pure. */
export function glicko2Update(player: Glicko, oppRating: number, oppRd: number, s: number): Glicko {
  const mu = (player.rating - CENTER) / SCALE;
  const phi = player.rd / SCALE;
  const sigma = player.vol;
  const muj = (oppRating - CENTER) / SCALE;
  const phij = oppRd / SCALE;

  const gj = gphi(phij);
  const e = expect(mu, muj, phij);
  const v = 1 / (gj * gj * e * (1 - e));
  const delta = v * gj * (s - e);

  // new volatility via the Illinois (regula-falsi) root find on Glicko-2's f(x)
  const d2 = delta * delta;
  const phi2 = phi * phi;
  const a = Math.log(sigma * sigma);
  const f = (x: number): number => {
    const ex = Math.exp(x);
    return (
      (ex * (d2 - phi2 - v - ex)) / (2 * Math.pow(phi2 + v + ex, 2)) - (x - a) / (TAU * TAU)
    );
  };
  let A = a;
  let B: number;
  if (d2 > phi2 + v) {
    B = Math.log(d2 - phi2 - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }
  let fA = f(A);
  let fB = f(B);
  let iter = 0;
  while (Math.abs(B - A) > 1e-6 && iter++ < 100) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
  }
  const newVol = Math.exp(A / 2);

  const phiStar = Math.sqrt(phi2 + newVol * newVol);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * gj * (s - e);

  return { rating: SCALE * newMu + CENTER, rd: SCALE * newPhi, vol: newVol };
}

export interface EloParticipant {
  userId: string;
  alliance: Alliance;
  rating: Glicko;
}

export interface EloBoardUpdate {
  userId: string;
  before: number; // rating before, rounded
  after: number; // rating after, rounded
  rd: number; // new RD, rounded (drives the provisional "?" indicator)
  state: Glicko; // full new state to persist
}

/** the OVERALL-board rating change for one player, returned to the room so it can
 * show each driver their rating delta (+ provisional flag) on the results screen.
 * `games` is the player's OVERALL-board game count AFTER this match — it drives
 * the games-based placement / provisional "?" (see PLACEMENT_GAMES). */
export interface EloOutcome {
  userId: string;
  before: number;
  after: number;
  rd: number;
  games: number;
}

/** Glicko-2 team update: each player is scored against the OPPOSING alliance as a
 * single aggregate opponent (mean rating, RMS rating-deviation). Winner = higher
 * alliance score (equal ⇒ draw). Returns per-board rating + RD changes. */
export function computeGlicko(
  participants: EloParticipant[],
  scores: Record<Alliance, number>,
): EloBoardUpdate[] {
  const sRed = scores.red > scores.blue ? 1 : scores.red < scores.blue ? 0 : 0.5;
  const updates: EloBoardUpdate[] = [];

  const red = participants.filter((p) => p.alliance === 'red');
  const blue = participants.filter((p) => p.alliance === 'blue');
  if (!red.length || !blue.length) return updates;
  const agg = (ps: EloParticipant[]): { rating: number; rd: number } => ({
    rating: ps.reduce((s, p) => s + p.rating.rating, 0) / ps.length,
    rd: Math.sqrt(ps.reduce((s, p) => s + p.rating.rd * p.rating.rd, 0) / ps.length),
  });
  const oppOfRed = agg(blue);
  const oppOfBlue = agg(red);
  for (const p of participants) {
    const s = p.alliance === 'red' ? sRed : 1 - sRed;
    const opp = p.alliance === 'red' ? oppOfRed : oppOfBlue;
    const cur = p.rating;
    const next = glicko2Update(cur, opp.rating, opp.rd, s);
    updates.push({
      userId: p.userId,
      before: Math.round(cur.rating),
      after: Math.round(next.rating),
      rd: Math.round(next.rd),
      state: next,
    });
  }
  return updates;
}

/** infer the ranked mode from the roster size */
export function eloMode(count: number): '1v1' | '2v2' {
  return count >= 4 ? '2v2' : '1v1';
}

/** Persist a finished VERSUS match + its participants (for the match history and
 * replay). Requires both alliances present (≥2 authed players). When `ranked`, it
 * also reads current ratings, applies Glicko-2, upserts the new ratings, and
 * stores each player's rating before/after — returning the per-player overall
 * deltas for the results-screen reveal. When NOT ranked (a custom room) it records
 * the match with `ranked=false` and NULL ratings, moves NO ELO, and returns [].
 * Called from persistMatch. */
export async function persistVersusMatch(
  authed: MatchParticipant[],
  outcome: MatchOutcome,
  balanceVersion: number,
  replayId: string,
  ranked: boolean,
  game?: GameId,
  /** filled with the row id of the match this wrote, so the caller can hand it to anything
   *  that needs to point AT the match later — the misscore queue opens the replay by it. */
  out?: { matchId?: string },
): Promise<EloOutcome[]> {
  const reds = authed.filter((p) => p.alliance === 'red');
  const blues = authed.filter((p) => p.alliance === 'blue');
  if (!reds.length || !blues.length) return []; // not a two-sided match
  const mode = eloMode(authed.length);
  const { red, blue } = outcome.result.score;

  let updates: EloBoardUpdate[] = [];
  const gamesAfter = new Map<string, number>(); // userId -> board games after this match
  if (ranked) {
    // ELO is keyed by ACT (persists across seasons); resolve this season's act once.
    const act = await actForSeason(balanceVersion, game);
    const parts: EloParticipant[] = [];
    for (const p of authed) {
      parts.push({
        userId: p.userId!,
        alliance: p.alliance,
        rating: await getRatingFull(p.userId!, mode, act, game),
      });
    }
    updates = computeGlicko(parts, outcome.result.score);
    for (const u of updates) {
      const games = await upsertRating(u.userId, mode, act, u.state.rating, u.state.rd, u.state.vol, game);
      gamesAfter.set(u.userId, games);
      // snapshot the post-match rating for THIS SEASON — freezes into the season's final
      // standings once it rolls (the live act board keeps evolving in elo_ratings).
      await upsertEloHistory(u.userId, mode, balanceVersion, u.state.rating, u.state.rd, u.state.vol, games, game);
    }
  }

  const matchId = await saveMatch(mode, balanceVersion, replayId, ranked, game);
  if (out) out.matchId = String(matchId);
  for (const p of authed) {
    const u = ranked ? updates.find((x) => x.userId === p.userId) : undefined;
    await addMatchParticipant({
      matchId,
      userId: p.userId!,
      alliance: p.alliance,
      drivetrain: p.drivetrain,
      score: p.score,
      won: p.alliance === 'red' ? red > blue : blue > red,
      ratingBefore: u ? u.before : null,
      ratingAfter: u ? u.after : null,
    });
  }

  // the rating change per player, for the results-screen reveal (ranked only;
  // custom returns nothing so no reveal fires)
  return updates.map((u) => ({
    userId: u.userId,
    before: u.before,
    after: u.after,
    rd: u.rd,
    games: gamesAfter.get(u.userId) ?? 0,
  }));
}
