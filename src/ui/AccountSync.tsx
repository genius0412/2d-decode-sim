import { useEffect } from 'react';
import type { GameSettings } from '../game';
import { authClient, clearAuthToken } from '../lib/authClient';
import { fetchAccountSettings } from '../net/api';
import { coerceSettings } from '../settings';

// Module-level so it survives this component unmounting (it's only mounted on
// shell screens, not during a game): a given user is loaded from the server at
// most once per session, so returning to the menu never re-fetches and clobbers
// unsaved local edits. Reset when signed out.
let syncedUser: string | null = null;

/**
 * Per-account settings sync (rendered only when auth is enabled → `authClient`
 * non-null). On sign-in it loads the account's saved settings and applies them,
 * or — if the account has none yet — seeds it from the current local settings.
 * Ongoing saves happen in App's `update()` (debounced). Renders nothing.
 */
export function AccountSync({
  onUser,
  onLoad,
  seed,
}: {
  onUser: (id: string | null) => void;
  onLoad: (s: GameSettings) => void;
  seed: () => void;
}) {
  const session = authClient!.useSession();
  const uid = session.data?.user?.id ?? null;

  useEffect(() => {
    // The identity just changed - sign-in, sign-out, or a switch between accounts -
    // so the in-memory JWT belongs to whoever was here before. Clearing it here
    // covers every sign-out button at once, since they all land on this effect.
    clearAuthToken();
    onUser(uid);
    if (!uid) {
      syncedUser = null;
      return;
    }
    if (syncedUser === uid) return;
    syncedUser = uid;
    let alive = true;
    fetchAccountSettings()
      .then((raw) => {
        if (!alive) return;
        if (raw) onLoad(coerceSettings(raw));
        else seed();
      })
      .catch(() => {
        if (alive) syncedUser = null; // let a later render retry
      });
    return () => {
      alive = false;
    };
  }, [uid, onUser, onLoad, seed]);

  return null;
}
