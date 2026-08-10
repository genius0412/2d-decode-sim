/**
 * WHICH DEPLOYMENT THIS SERVER IS — stable (production) or alpha (the preview).
 *
 * Until now there was ONE game server and every client version talked to it, so an in-dev
 * alpha build had to be walled off inside it: the matchmaker segregates alpha entries into
 * their own pool, and alpha results are never written to the database. That second rule is
 * what made the preview only half-testable — standing, dodge penalties, reports, playtime
 * and ranked all EXIST by writing to Postgres, so on a shared server they silently no-op and
 * there is nothing to look at.
 *
 * With a separate alpha app pointed at its own database, that protection comes from the
 * DEPLOYMENT instead of from a rule inside one process: alpha writes go to the alpha
 * database, and production cannot see them because it is not connected to it. So the alpha
 * server persists normally and the preview behaves like the real thing.
 *
 * The client-channel segregation STAYS regardless. It is cheap, and it is what still
 * protects production if an alpha client ever reaches the stable server — which it can,
 * since a browser tab can point anywhere.
 */
export const SERVER_CHANNEL: string = (process.env.SERVER_CHANNEL ?? 'stable').trim() || 'stable';

/** is this the alpha (preview) deployment? */
export const isAlphaServer = (): boolean => SERVER_CHANNEL === 'alpha';

/**
 * May a room's results be written to this server's database?
 *
 * Pure, and takes both channels, because the rule is about the PAIRING rather than about
 * either side alone:
 *
 *   alpha client on the STABLE server → NO. The old rule, still the important one: an
 *     in-development build's results must never land in production boards, and a browser
 *     tab can point anywhere it likes.
 *   alpha client on the ALPHA server → YES. That is the whole point of the preview: its
 *     database is its own, so there is nothing to protect it from.
 *   stable client anywhere → YES, as before.
 */
export function roomPersists(roomChannel: string | undefined, serverChannel = SERVER_CHANNEL): boolean {
  if (roomChannel !== 'alpha') return true;
  return serverChannel === 'alpha';
}
