/**
 * RANKED DODGE PENALTIES — the cost of abandoning a match the matchmaker already committed
 * you to.
 *
 * WHAT A DODGE IS. A ranked pairing is a contract between four (or two) people: the moment
 * the matchmaker stages a roster, everyone else's next few minutes depend on you showing up.
 * DSIM's flow gives that contract exactly three ways to fail, and all three end in
 * `Room.cancelPending` — the match dies and everybody requeues:
 *
 *   1. NO-SHOW      — paired, never connected inside the join grace
 *   2. STRATEGY BAIL — connected, then disconnected during the pre-match window
 *   3. NEVER READIED — connected and sat there until the strategy deadline
 *
 * Until now none of the three cost anything, which made dodging strictly free: a player who
 * disliked a matchup could drop it and requeue at no charge, and the three people they
 * stranded paid the whole price.
 *
 * WHY THE PENALTY IS CAUSE-BLIND. The obvious design is to punish deliberate leaves harder
 * than genuine disconnects. It cannot be built honestly: from the server, a pulled network
 * cable, a closed laptop and a killed browser tab are the same event — a socket that stopped
 * answering. Any rule that charged less for "looked like a real disconnect" would just be
 * telling players the cheap way to dodge is to yank the cable, which is worse than not
 * distinguishing at all.
 *
 * So intent is not guessed. What IS observable, and what actually separates an accident from
 * a habit, is REPETITION — so the first dodge in a window is cheap enough to absorb a real
 * disconnect, and repeats get expensive fast. That is the distinction the data can actually
 * support, and it degrades gracefully: someone with genuinely bad internet pays a first-tier
 * penalty occasionally, while someone dodging matchups walks up the ladder of costs.
 *
 * WHY THE FIRST ONE STILL COSTS MORE THAN A LOSS. A settled player's match is worth about
 * ±17 rating (measured — see `src/ranks.ts`). If a dodge cost less than a loss, dodging a
 * matchup you expect to lose would be the RATIONAL play, and a penalty that rewards the
 * behaviour it is meant to deter is worse than none. 20 is the smallest round number above a
 * settled loss.
 */

/** Rolling window the escalation counts over. Long enough that dodging three matches in an
 *  evening is expensive, short enough that a bad night doesn't follow you all season — a
 *  player who dodges once a week is treated as a first offender every time, which is the
 *  right read of "occasional accident". */
export const DODGE_WINDOW_HOURS = 12;

/**
 * Rating cost by how many dodges (including this one) the player has inside the window.
 *
 * The step from 20 to 45 is deliberately more than double: one dodge is an accident, two in
 * twelve hours is a pattern, and the jump is where a player is meant to notice. 90 is about
 * five settled matches of progress — enough that a habitual dodger cannot out-earn it in the
 * same session they spent dodging.
 */
export const DODGE_PENALTIES = [20, 45, 90] as const;

/** the rating cost of a player's `n`-th dodge in the window (1-based) */
export function dodgePenalty(n: number): number {
  if (n < 1) return 0;
  return DODGE_PENALTIES[Math.min(n, DODGE_PENALTIES.length) - 1];
}

/** why a staged ranked match died, per player. Reported to the client so a penalised player
 *  is told what it cost and an innocent one is told they were not charged. */
export type DodgeKind = 'noshow' | 'bail' | 'unready';

export const DODGE_REASON: Record<DodgeKind, string> = {
  noshow: 'did not connect in time',
  bail: 'left before the match started',
  unready: 'did not ready up in time',
};

/** what one player is told after a cancelled ranked pairing */
export interface DodgeVerdict {
  userId: string;
  /** null when this player was NOT at fault (they still get told the match died) */
  kind: DodgeKind | null;
  /** rating actually deducted (0 for the innocent) */
  penalty: number;
  /** how many dodges this player now has inside the window */
  count: number;
  ratingBefore: number;
  ratingAfter: number;
}
