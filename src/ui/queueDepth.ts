import type { EloMode, Presence } from '../net/api';

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
export function queuedModes(p: Presence | null): EloMode[] {
  if (!p || !p.queues) return [];
  return QUEUE_MODES.filter((m) => {
    const n = p.queues[m];
    return typeof n === 'number' && Number.isFinite(n) && n > 0;
  });
}

/**
 * What the widening controls SAY, given how long we have waited and how many times
 * the player pressed EXPAND SEARCH.
 *
 * Pulled out of the JSX because the bug being fixed was precisely that these strings
 * never changed: the button called `expandSearch()` on the socket and nothing on
 * screen moved, so it read as dead and invited repeated pressing. The searching
 * screen needs a signed-in account to reach, so this is the part that can actually
 * be tested — and it is the part that was wrong.
 */
export function expandLabel(bumps: number): string {
  return bumps > 0 ? `EXPANDED ×${bumps}` : 'EXPAND SEARCH';
}

/**
 * The line under the spinner: manual presses win over the automatic ramp, because
 * a press is a thing the player just did and deserves the acknowledgement.
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
