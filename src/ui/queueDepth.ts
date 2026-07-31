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

/** anyone at all waiting — for callers decorating a control rather than printing */
export function anyoneQueued(p: Presence | null): boolean {
  return queuedModes(p).length > 0;
}
