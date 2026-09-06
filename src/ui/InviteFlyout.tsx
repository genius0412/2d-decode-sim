import { useEffect, useRef, useState } from 'react';
import type { RoomConfig } from '../net/protocol';
import type { RoomInvite } from '../net/api';
import { useFriends } from './useFriends';
import { challengeLine, challengeOf } from './challenge';
import { PeopleGlyph, PersonRow, Section } from './FriendsPanel';

/**
 * Compact friend flyout for `Lobby`, which bypasses `AppShell` (and its
 * `FriendsPanel`) entirely as a full-screen surface — see `App.tsx`'s
 * full-screen-surface list. Mounts its own `useFriends` poll; safe because
 * `AppShell`'s panel is never mounted at the same time `Lobby` is.
 *
 * ALWAYS shows incoming room invites, so a friend inviting you while you're
 * still deciding create-vs-join (or already waiting in a room) reaches you
 * either way. When `room` is given (you're in a room with a code to share),
 * also lists your online friends with an Invite button per row.
 */
export function InviteFlyout({
  signedIn,
  room,
  onJoinRoom,
  onAcceptChallenge,
}: {
  signedIn: boolean;
  /** the room we are IN, when we are in one — `region` is which machine it is on, and it
   *  has to be stamped on every invite sent from here or the friend who accepts is routed
   *  to their OWN nearest machine and opens an empty room with the same code */
  room?: { code: string; config: RoomConfig; region?: string | null };
  /** Join clicked on an incoming invite — calls the SAME join(roomCode, region) the
   * manual code-entry path uses, so this can never diverge from it. The REGION is the
   * invite's (the host's): a bare room code carries no routing hint, so joining on our own
   * region is how two friends on different servers ended up in two rooms with one code. */
  onJoinRoom: (code: string, region?: string | null) => void;
  /** accept a RATED challenge, which has no room to join: it leaves this lobby and
   * queues under the challenge token instead. */
  onAcceptChallenge?: (inv: RoomInvite) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Lobby is a full-screen surface OUTSIDE AppShell's FriendsProvider, so this
  // keeps its own poll. Report 'lobby' activity + the room's game so friends see
  // "In a lobby · DECODE" while you're setting up / waiting.
  const friends = useFriends({ signedIn, activity: 'lobby', game: room?.config.game });
  const [invited, setInvited] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  if (!signedIn) return null;

  const { invites, friends: list } = friends.data;
  const online = list.filter((f) => f.online);
  const badge = invites.length;

  const join = (code: string, region?: string | null, inviteId?: string): void => {
    setOpen(false);
    onJoinRoom(code, region);
    if (inviteId) void friends.dismissInvite(inviteId);
  };

  return (
    <div className="ds-invite-root" ref={rootRef}>
      <button className="ds-chip ds-invite-toggle" onClick={() => setOpen((o) => !o)}>
        {/* NO typed space: `.ds-chip` is an inline-flex row with its own gap, so a
            JSX space becomes a leading space INSIDE the label's anonymous flex item
            — the gap plus ~3px of text, two spacing systems in one 20px stretch. */}
        <PeopleGlyph size={13} />
        {room ? 'Invite friends' : 'Friends'}
        {badge > 0 && (
          <span className="fr-badge ds-invite-badge" aria-label={`${badge} invites`}>
            {badge}
          </span>
        )}
      </button>
      {open && (
        <div className="ds-invite-pop">
          {friends.unavailable ? (
            <p className="fr-empty">Friends aren’t available on this server yet.</p>
          ) : (
            <>
              {invites.length > 0 && (
                <Section title="Challenges" count={invites.length}>
                  {invites.map((inv) => {
                    // a RATED challenge has no room to join — accepting it means
                    // leaving this lobby for the ranked queue, which only the app
                    // shell can do
                    const rated = !!challengeOf(inv, '');
                    return (
                      <PersonRow key={inv.id} p={inv.from} sub={challengeLine(inv.format)}>
                        <button
                          className="ds-btn small primary"
                          disabled={rated && !onAcceptChallenge}
                          onClick={() => {
                            if (rated) {
                              setOpen(false);
                              // deliberately NOT dismissed: the server verifies
                              // the party token against this very row on every
                              // `queue`, including the re-queue a transport
                              // reconnect sends. Deleting it here would fail the
                              // challenge the moment the socket blipped. It ages
                              // out on the read TTL instead.
                              onAcceptChallenge?.(inv);
                            } else {
                              // GO WHERE THE HOST IS, not where we are
                              join(inv.room, inv.region, inv.id);
                            }
                          }}
                        >
                          Accept
                        </button>
                        <button
                          className="ds-btn small ghost"
                          onClick={() => void friends.declineInvite(inv.id)}
                        >
                          Decline
                        </button>
                      </PersonRow>
                    );
                  })}
                </Section>
              )}

              {room && (
                <Section title="Invite a friend">
                  {online.length === 0 ? (
                    <p className="fr-empty">No friends online.</p>
                  ) : (
                    online.map((f) => (
                      <PersonRow key={f.userId} p={f}>
                        <button
                          className="ds-btn small"
                          disabled={!f.username || !!(f.username && invited[f.username])}
                          onClick={() => {
                            const u = f.username;
                            if (!u) return;
                            void friends
                              .inviteToRoom(
                                u,
                                room.code,
                                room.config.game ?? 'decode',
                                room.config.kind,
                                room.config.record,
                                null,
                                room.region ?? null,
                              )
                              .then(() => setInvited((m) => ({ ...m, [u]: true })));
                          }}
                        >
                          {/* NO trailing ✓: 'Invite' → 'Invited ✓' grew the button
                              ~22px inside a `flex: none` `.fr-actions`, squeezing
                              the name beside it into its ellipsis — a row visibly
                              reflowing on a click that changed only a label. */}
                          {f.username && invited[f.username] ? 'Invited' : 'Invite'}
                        </button>
                      </PersonRow>
                    ))
                  )}
                </Section>
              )}

              {invites.length === 0 && !room && <p className="fr-empty">No pending challenges.</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
