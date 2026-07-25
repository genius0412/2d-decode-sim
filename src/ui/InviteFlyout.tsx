import { useEffect, useRef, useState } from 'react';
import type { RoomConfig } from '../net/protocol';
import { useFriends } from './useFriends';

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
}: {
  signedIn: boolean;
  room?: { code: string; config: RoomConfig };
  /** Join clicked on an incoming invite — calls the SAME join(roomCode) the
   * manual code-entry path uses, so this can never diverge from it. */
  onJoinRoom: (code: string) => void;
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

  const join = (code: string, inviteId?: string): void => {
    setOpen(false);
    onJoinRoom(code);
    if (inviteId) void friends.dismissInvite(inviteId);
  };

  return (
    <div className="ds-invite-root" ref={rootRef}>
      <button className="ds-chip ds-invite-toggle" onClick={() => setOpen((o) => !o)}>
        👥 {room ? 'Invite friends' : 'Friends'}
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
                <div className="fr-section">
                  <h3 className="fr-sec-h">Invites</h3>
                  {invites.map((inv) => (
                    <div className="fr-row" key={inv.id}>
                      <span className="fr-who static">
                        <span className="fr-name">{inv.from.handle}</span>
                        <span className="fr-sub">invited you to a room</span>
                      </span>
                      <span className="fr-actions">
                        <button className="ds-btn small primary" onClick={() => join(inv.room, inv.id)}>
                          Join
                        </button>
                        <button
                          className="ds-btn small ghost"
                          onClick={() => void friends.dismissInvite(inv.id)}
                        >
                          ✕
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {room && (
                <div className="fr-section">
                  <h3 className="fr-sec-h">Invite a friend</h3>
                  {online.length === 0 ? (
                    <p className="fr-empty">No friends online right now.</p>
                  ) : (
                    online.map((f) => (
                      <div className="fr-row" key={f.userId}>
                        <span className="fr-who static">
                          <span className="fr-name">{f.handle}</span>
                          <span className="fr-sub">@{f.username}</span>
                        </span>
                        <span className="fr-actions">
                          <button
                            className="ds-btn small"
                            disabled={!f.username || !!(f.username && invited[f.username])}
                            onClick={() => {
                              const u = f.username;
                              if (!u) return;
                              void friends
                                .inviteToRoom(u, room.code, room.config.game ?? 'decode', room.config.kind, room.config.record)
                                .then(() => setInvited((m) => ({ ...m, [u]: true })));
                            }}
                          >
                            {f.username && invited[f.username] ? 'Invited ✓' : 'Invite'}
                          </button>
                        </span>
                      </div>
                    ))
                  )}
                </div>
              )}

              {invites.length === 0 && !room && <p className="fr-empty">No pending invites.</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
