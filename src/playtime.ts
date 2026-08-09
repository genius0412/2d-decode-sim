/**
 * PLAYTIME + GAMES PLAYED — the "how much have I actually played this" numbers.
 *
 * WHAT COUNTS, AND WHY IT IS NOT EVERYTHING. Playtime is measured from the SIM, on the
 * server, as the real duration of matches it ran: `replay.ticks × SIM_DT`. That has two
 * consequences worth being honest about rather than papering over:
 *
 *  • it is the time the ROBOT was live, not the time the app was open. A match you spent in
 *    the results screen, the builder or the menu does not count, which is the number most
 *    people actually mean by "playtime" in a game like this.
 *  • OFFLINE SOLO PRACTICE IS NOT COUNTED. A local free-drive or practice match never
 *    reaches the server (see the solo path in game.ts), so nothing authoritative exists to
 *    count. The alternative — letting the client report its own total — is a number any
 *    modified build can type in, and a leaderboard-adjacent stat that cannot be trusted is
 *    worse than one that is merely incomplete. The UI says which one this is.
 *
 * The formatting lives here, in the shared module, because the same string appears on the
 * career panel and in the moderation queue, and two implementations of "2h 14m" WILL drift.
 */

/** what the server has recorded for one account */
export interface Activity {
  /** matches the server ran with this player in them (ranked, custom and record runs) */
  games: number;
  /** seconds of live match time, summed from each match's real tick count */
  seconds: number;
}

export const EMPTY_ACTIVITY: Activity = { games: 0, seconds: 0 };

/**
 * "3h 24m" / "12m" / "48s".
 *
 * Two units at most, largest first, and the smaller one is dropped when it is zero — the
 * point is a glanceable sense of scale, and "3h 0m" reads as a template that failed to fill
 * rather than as a number. Seconds only appear on their own, because "1h 5m 12s" is a
 * stopwatch, not a playtime.
 */
export function playtimeText(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  if (s < 60) return `${s}s`;
  const mins = Math.floor(s / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem ? `${hours}h ${rem}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const hrem = hours % 24;
  return hrem ? `${days}d ${hrem}h` : `${days}d`;
}

/** the same figure spelled out, for a tooltip: "3 hours 24 minutes across 128 matches" */
export function playtimeLong(a: Activity): string {
  const mins = Math.round(a.seconds / 60);
  // "matches", not "matchs" — the one word here that does not take a bare -s
  const unit = (n: number, word: string, plural = `${word}s`): string => `${n} ${n === 1 ? word : plural}`;
  const time =
    mins < 60
      ? unit(mins, 'minute')
      : `${unit(Math.floor(mins / 60), 'hour')}${mins % 60 ? ` ${unit(mins % 60, 'minute')}` : ''}`;
  return `${time} across ${unit(a.games, 'match', 'matches')}`;
}

/** average match length, in seconds (0 with no games — never NaN on a fresh account) */
export const averageMatch = (a: Activity): number => (a.games > 0 ? a.seconds / a.games : 0);
