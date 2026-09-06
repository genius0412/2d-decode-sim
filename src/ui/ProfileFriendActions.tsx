import { useState } from 'react';
import type { FriendsCtx } from './friendsContext';

/**
 * Friend/block controls for a profile you're viewing (not your own). Rendered
 * next to `ShareButton` in the profile header. Reads the shared friends store
 * (`FriendsCtx`) the menu shell already mounts — no new API surface, just
 * contextual buttons over the existing add/accept/decline/cancel/unfriend/block/
 * unblock/challenge mutations, picked by matching this profile's `username`
 * against the caller's friends/incoming/outgoing/blocked lists.
 */
export function ProfileFriendActions({
  username,
  friends,
}: {
  username: string;
  friends: FriendsCtx;
}) {
  const [busy, setBusy] = useState(false);
  if (friends.unavailable) return null;

  const { friends: list, incoming, outgoing, blocked } = friends.data;
  const friendRow = list.find((f) => f.username === username);
  const isFriend = !!friendRow;
  const incomingReq = incoming.find((p) => p.username === username);
  const outgoingReq = outgoing.find((p) => p.username === username);
  const isBlocked = blocked.some((p) => p.username === username);
  // challengeable straight from the profile when they're online + free (not DND,
  // not mid-match)
  const challengeable =
    !!friendRow && friendRow.online && friendRow.status !== 'dnd' && friendRow.activity !== 'match';

  const run = (fn: () => Promise<unknown>): void => {
    setBusy(true);
    void fn().finally(() => setBusy(false));
  };

  if (isBlocked) {
    return (
      <button
        className="ds-btn ghost"
        disabled={busy}
        onClick={() => run(() => friends.unblock(username))}
      >
        Blocked · Unblock
      </button>
    );
  }

  if (isFriend) {
    return (
      <span className="ds-profile-friend-actions">
        {/* the status LEADS the row. It sat between the primary action and the two
            destructive ones, which is the one place a badge cannot go: the eye
            groups by distance, so it read as a third button in the middle of a
            strip of buttons rather than as the state they act on. */}
        <span className="ds-chip on">✓ Friends</span>
        {challengeable && (
          <button
            className="ds-btn primary"
            disabled={busy}
            onClick={() => friends.openChallenge(username)}
          >
            Challenge
          </button>
        )}
        <button className="ds-btn ghost" disabled={busy} onClick={() => run(() => friends.unfriend(username))}>
          Unfriend
        </button>
        <button className="ds-btn ghost" disabled={busy} onClick={() => run(() => friends.block(username))}>
          Block
        </button>
      </span>
    );
  }

  if (incomingReq) {
    return (
      // DEFAULT size, like every other branch and like the `ShareButton` this shares
      // a header row with. This was the only state that used `.ds-btn small`, so the
      // profile header's controls changed HEIGHT depending on your relationship with
      // the person — and nothing about "they sent you a request" argues for smaller
      // buttons.
      <span className="ds-profile-friend-actions">
        <button className="ds-btn primary" disabled={busy} onClick={() => run(() => friends.accept(username))}>
          Accept
        </button>
        <button className="ds-btn ghost" disabled={busy} onClick={() => run(() => friends.decline(username))}>
          Decline
        </button>
      </span>
    );
  }

  if (outgoingReq) {
    return (
      <button className="ds-btn ghost" disabled={busy} onClick={() => run(() => friends.cancel(username))}>
        Request sent · Cancel
      </button>
    );
  }

  return (
    <span className="ds-profile-friend-actions">
      <button className="ds-btn" disabled={busy} onClick={() => run(() => friends.add(username))}>
        Add friend
      </button>
      <button className="ds-btn ghost" disabled={busy} onClick={() => run(() => friends.block(username))}>
        Block
      </button>
    </span>
  );
}
