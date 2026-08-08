/**
 * DODGING — abandoning a match the matchmaker had already committed you to.
 *
 * WHAT A DODGE IS. A ranked pairing is a contract between two (or four) people: the moment
 * the matchmaker stages a roster, everybody else's next few minutes depend on you showing
 * up. DSIM's flow gives that contract exactly three ways to fail, and all three end in
 * `Room.cancelPending` — the match dies and everyone requeues:
 *
 *   1. NO-SHOW       — paired, never connected inside the join grace
 *   2. STRATEGY BAIL — connected, then disconnected during the pre-match window
 *   3. NEVER READIED — connected and sat there until the strategy deadline
 *
 * WHAT IT COSTS, AND WHY IT IS NOT RATING. A dodge is a BEHAVIOUR, so it is charged to
 * ACCOUNT STANDING (`src/standing.ts`) and not to the Glicko rating. Taking rating for it
 * says the dodger is a worse driver, which is not what happened, and it corrupts the one
 * number whose entire job is measuring skill. A dodge does not reduce rating at all until a
 * player has ignored a warning and two queue cooldowns — at which point standing itself
 * escalates into rating, which is the last rung of the ladder rather than the first.
 *
 * WHY THE COST IS CAUSE-BLIND. The obvious design punishes a deliberate leave harder than a
 * genuine disconnect. It cannot be built honestly: from the server, a pulled network cable,
 * a closed laptop and a killed browser tab are the same event — a socket that stopped
 * answering. A rule that charged less for "looked like a real disconnect" would just be
 * publishing the cheap way to dodge. What IS observable, and what actually separates an
 * accident from a habit, is REPETITION — so the first one is cheap enough to absorb a real
 * disconnect and repeats escalate (`repeatMult`).
 */
import type { StandingVerdict } from './standing';

/** why a staged ranked match died, per player. Reported to the client so a charged player is
 *  told what it cost and an innocent one is told they were not charged. */
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
  /** what it did to their standing — null for the innocent, and null when the database is
   *  off (a dodge that could not be recorded is not reported as if it had been) */
  standing: StandingVerdict | null;
  /** how many dodges this player now has inside the standing window */
  count: number;
}
