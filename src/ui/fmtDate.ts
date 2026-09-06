/**
 * ONE absolute date format for the whole app.
 *
 * Four spellings of "when" were being printed on adjacent screens — `9/6/2026`
 * (membership expiry), `Sep 6` (practice runs), `Sep 6, 3:04 PM` (match history)
 * and `3h ago` (standing events). Two of those are the same fact told two ways,
 * and the bare `Sep 6` has a real bug in it: a run from last year reads as this
 * year.
 *
 * So there are exactly TWO roles, and this module owns the first:
 *
 *  - ABSOLUTE — a point in time you might look up or compare (when a run was
 *    played, when a match happened, when a membership runs out). Always
 *    `Sep 6, 2026`; the year is never dropped, because these lists are
 *    season-scoped and a year-less date silently reads as the current one.
 *    `fmtDayTime` appends the clock ONLY where several rows can share a day and
 *    the order within it matters — the date half is byte-identical either way.
 *
 *  - RELATIVE — an event whose RECENCY is the content, not its date. That is
 *    `StandingCard`'s offence log ("3h ago") and nothing else; a penalty from
 *    "2 days ago" is a different statement from one dated Sep 4.
 */

const DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
const DAY_TIME: Intl.DateTimeFormatOptions = { ...DAY, hour: 'numeric', minute: '2-digit' };

const asDate = (at: Date | number | string): Date | null => {
  const d = at instanceof Date ? at : new Date(at);
  return isNaN(d.getTime()) ? null : d;
};

/** `Sep 6, 2026` — the app's one absolute date. */
export function fmtDay(at: Date | number | string): string {
  const d = asDate(at);
  return d ? d.toLocaleDateString(undefined, DAY) : '';
}

/** `Sep 6, 2026, 3:04 PM` — the same date plus the clock, for lists whose rows
 *  can share a day (match history). */
export function fmtDayTime(at: Date | number | string): string {
  const d = asDate(at);
  return d ? d.toLocaleString(undefined, DAY_TIME) : '';
}
