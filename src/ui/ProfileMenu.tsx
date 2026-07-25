import { useEffect, useRef, useState } from 'react';
import { authClient } from '../lib/authClient';
import { multiServer } from '../net/env';
import { AuthPanel } from './AuthPanel';
import { ServerMenu } from './ServerMenu';

/** first two characters of a display name, uppercased — the avatar glyph when
 * there's nothing better (a real photo) to show. */
function initialsOf(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 2).toUpperCase() : '?';
}

/**
 * Top-bar profile control. Replaces the old always-visible region `<Select>` +
 * name chip + sign-out button with ONE avatar (initials, like every other chat/
 * game client) that opens a popover holding everything account-shaped: who you
 * are, the server region picker (+ on-demand ping), and sign out. Only mounted
 * when auth is enabled, so `authClient` is non-null (keeps the `useSession` hook
 * call unconditional).
 *
 * `handle` is the app's own mutable display name (see the old AccountButton doc)
 * — it must win over `user.name`, which never updates after sign-up.
 */
export function ProfileMenu({
  handle,
  preferredServerId,
  onChangeServer,
  onAccount,
}: {
  handle?: string | null;
  preferredServerId: string;
  onChangeServer: (id: string) => void;
  /** navigate to the full Account/Profile page */
  onAccount: () => void;
}) {
  const client = authClient!;
  const session = client.useSession();
  const [open, setOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  if (session.isPending) return <span className="ds-chip">…</span>;

  const user = session.data?.user;
  // `undefined` handle means the fetch is still in flight — never flash the raw
  // auth name (see AccountButton's original note on this exact bug).
  const label = user ? (handle === undefined ? undefined : handle ?? user.name ?? user.email ?? 'Player') : null;
  const initials = label ? initialsOf(label) : null;

  return (
    <div className="ds-profile-root" ref={rootRef}>
      <button
        className="ds-avatar-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={user ? label ?? 'Account' : 'Sign in'}
      >
        <span className="ds-avatar">{initials ?? '?'}</span>
      </button>
      {open && (
        <div className="ds-profile-pop" role="menu">
          {user ? (
            <button
              className="ds-profile-id"
              onClick={() => {
                setOpen(false);
                onAccount();
              }}
            >
              <span className="ds-avatar md">{initials}</span>
              <span className="ds-profile-who">
                <span className="ds-profile-name">{label === undefined ? '…' : label}</span>
                <span className="ds-profile-sub">Account settings</span>
              </span>
            </button>
          ) : (
            <div className="ds-profile-guest">
              <p className="ds-hint" style={{ margin: 0 }}>
                Sign in to save records and rank up.
              </p>
            </div>
          )}

          {multiServer() && (
            <div className="ds-profile-section">
              <span className="ds-profile-label">Server &amp; ping</span>
              <ServerMenu value={preferredServerId} onChange={onChangeServer} />
            </div>
          )}

          <div className="ds-profile-actions">
            {user ? (
              <button
                className="ds-btn ghost"
                onClick={() => {
                  setOpen(false);
                  void client.signOut();
                }}
              >
                Sign out
              </button>
            ) : (
              <button
                className="ds-btn primary"
                onClick={() => {
                  setOpen(false);
                  setAuthOpen(true);
                }}
              >
                Sign in
              </button>
            )}
          </div>
        </div>
      )}
      {authOpen && <AuthPanel onClose={() => setAuthOpen(false)} />}
    </div>
  );
}
