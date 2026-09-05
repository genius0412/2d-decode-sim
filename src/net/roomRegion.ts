/**
 * WHICH MACHINE a room join lands on.
 *
 * One Fly app runs in several regions, and a CUSTOM room code is BARE. A matchmaker-staged
 * room is `iad-abc123` and the proxy can route on the code alone, but a code two friends
 * share carries nothing — so a socket opened without a routing hint lands on whichever
 * machine Fly's anycast puts nearest to the JOINER. When the two of them had picked
 * different servers, that machine had no such room and cheerfully opened an empty one with
 * the same code: two lobbies, one code, both sides waiting, and no error on either screen.
 *
 * A LEAF MODULE with no imports, deliberately. The rule belongs beside `gameServerUrlWith`
 * in `env.ts` by subject, but that module reads `import.meta.env` at load time and so cannot
 * be imported by the headless smoke run at all — and this is exactly the rule that needs
 * pinning, because it was got wrong on two paths at once and neither failure says anything
 * out loud. Keeping it here costs one file and makes it testable.
 */

/**
 * The region a room join should use: the HOST's if we know it, ours otherwise.
 *
 * The host's region always wins, because it is a property of the ROOM and not of the person
 * joining it. Every path that could know it has to reach this same answer — an invite
 * accepted from the app shell, one accepted from the lobby's own friend flyout, and the
 * auto-join that fires when either navigates — or the paths drift and one of them quietly
 * connects to the wrong machine.
 *
 * An EMPTY host region means "we genuinely do not know": an invite recorded before the
 * region was stored, or a single-server deploy where every region string is ''. Falling back
 * to our own pick is right for both, and is also right for a code typed in by hand, which
 * has no host region to offer.
 */
export const roomJoinRegion = (hostRegion: string | null | undefined, ownRegion: string): string =>
  (hostRegion ?? '').trim() || ownRegion;
