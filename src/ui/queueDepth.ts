import type { EloMode, Presence } from '../net/api';
import type { GameId } from '../types';

/** the ranked buckets, in the order they are shown */
export const QUEUE_MODES: readonly EloMode[] = ['1v1', '2v2'] as const;

/**
 * Which ranked modes have somebody actually waiting.
 *
 * A MODE AT ZERO IS OMITTED, and when nothing is queued this returns empty and the
 * caller renders nothing at all. That is the rule, not a styling preference:
 * "0 waiting" reads as a verdict on whether to bother, so the number should only
 * ever appear when it is an argument FOR queueing. An absent count says "we don't
 * know / nothing to report"; a zero says "don't bother", which is a stronger and
 * less useful claim than the data supports.
 *
 * Pure and separate from the component so the rule can be tested directly — this
 * is logic, not markup, and it is the part that would silently regress.
 */
export function queuedModes(p: Presence | null, game?: GameId): EloMode[] {
  const src = queuesFor(p, game);
  if (!src) return [];
  return QUEUE_MODES.filter((m) => {
    const n = src[m];
    return typeof n === 'number' && Number.isFinite(n) && n > 0;
  });
}

/**
 * The depths that apply to `game` — or every game combined when no game is named.
 *
 * `gameQueues` is absent on servers older than it, and the fallback is the combined
 * `queues`. That is knowingly the pre-fix (wrong-for-one-game) number, but it is the
 * only one such a server can offer, and showing a slightly-too-high count beats
 * showing nothing while a deploy rolls out.
 */
export function queuesFor(p: Presence | null, game?: GameId): Record<EloMode, number> | null {
  if (!p) return null;
  if (game && p.gameQueues) return p.gameQueues[game] ?? { '1v1': 0, '2v2': 0 };
  return p.queues ?? null;
}

/**
 * Every game that has somebody waiting, with its modes — for the top bar, which
 * shows the WHOLE service rather than just the game you happen to be in.
 *
 * A game with nothing queued is omitted entirely, label and all: the same rule that
 * hides a zero mode, applied one level up. "Chain Reaction 0" is not a smaller
 * version of useful information, it is a reason not to bother, printed next to the
 * button whose job is to get you to bother.
 */
export function queuedGames(
  p: Presence | null,
  games: readonly GameId[],
): { game: GameId; modes: { mode: EloMode; n: number }[] }[] {
  if (!p?.gameQueues) return [];
  const out: { game: GameId; modes: { mode: EloMode; n: number }[] }[] = [];
  for (const game of games) {
    const q = p.gameQueues[game];
    if (!q) continue;
    const modes = QUEUE_MODES.map((mode) => ({ mode, n: q[mode] ?? 0 })).filter(
      (x) => Number.isFinite(x.n) && x.n > 0,
    );
    if (modes.length) out.push({ game, modes });
  }
  return out;
}

/**
 * The line under the spinner: manual presses win over the automatic ramp, because
 * a press is a thing the player just did and deserves the acknowledgement.
 *
 * This is the ONLY thing that moves on a press now. There used to be an
 * `expandLabel` that rewrote the button to "EXPANDED ×2", which turned a control
 * into a past-tense status — the button says what it does, the hint says what
 * happened.
 *
 * The thresholds track `RADIUS_INTERVAL_MS` on the server (3s a step, worldwide by
 * the second one). It never claims to be searching "your region" any more, because
 * it isn't: the queue opens wide enough for a same-continent match immediately, and
 * the closest available opponent is preferred at every radius.
 */
export function widenHint(bumps: number, elapsedSec: number): string {
  if (bumps > 0) return `Widened ${bumps}× — searching further out`;
  if (elapsedSec < 3) return 'Searching nearby regions…';
  return elapsedSec < 6 ? 'Widening — looking further out…' : 'Searching worldwide…';
}

/** anyone at all waiting — for callers decorating a control rather than printing */
export function anyoneQueued(p: Presence | null): boolean {
  return queuedModes(p).length > 0;
}
