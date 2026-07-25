import { useEffect, useState } from 'react';
import type { GameSettings } from '../game';
import { defaultSettings } from '../settings';
import { authEnabled, authClient } from '../lib/authClient';
import { gameServerConfigured, multiServer, selectedServerId } from '../net/env';
import { fetchProfile, updateHandle, updateUsername } from '../net/api';
import { AuthPanel } from './AuthPanel';
import { DesktopUpdate } from './DesktopUpdate';
import { ServerMenu } from './ServerMenu';
import { UsernameInput, useUsernameCheck, usernameHintColor } from './UsernameField';
import { APP_NAME } from '../seasons';

/**
 * Profile — identity (sign in / out via Neon Auth), the default server region,
 * and a settings reset. Audio and controls moved to `Configure`, which owns
 * everything you tune before a match; what stays here is the ACCOUNT itself.
 * Auth is a stable module constant, so the `authEnabled` branch that skips the
 * session hook is safe.
 */
export function Account({
  settings,
  onChange,
  onHandleSaved,
}: {
  settings: GameSettings;
  onChange: (s: GameSettings) => void;
  /** a saved display name, pushed straight back up to App so the header pill
   * updates on save instead of waiting for the next reload */
  onHandleSaved?: (handle: string) => void;
}) {
  return (
    <>
      <p className="ds-eyebrow">{APP_NAME} · Profile</p>
      <h1 className="ds-h1">Profile</h1>

      {authEnabled ? <Identity onHandleSaved={onHandleSaved} /> : <IdentityDisabled />}

      {multiServer() && (
        // `ds-panel-open` drops the panel's `overflow: hidden` so the region
        // dropdown can escape below the card instead of being clipped by it.
        <div className="ds-panel ds-panel-open" style={{ marginTop: 18 }}>
          <div className="ds-panel-h">
            <span className="ds-panel-title">Server</span>
          </div>
          <div style={{ padding: 16 }}>
            <ServerMenu
              value={settings.preferredServerId ?? selectedServerId()}
              onChange={(id) => onChange({ ...settings, preferredServerId: id })}
            />
          </div>
        </div>
      )}

      <DesktopUpdate />

      <div className="ds-panel" style={{ marginTop: 18 }}>
        <div className="ds-panel-h">
          <span className="ds-panel-title">Reset</span>
        </div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
          <button
            className="ds-btn"
            onClick={() => {
              if (confirm('Reset all settings to defaults? This cannot be undone.')) {
                onChange(defaultSettings());
              }
            }}
          >
            Reset all settings
          </button>
        </div>
      </div>
    </>
  );
}

function Identity({ onHandleSaved }: { onHandleSaved?: (handle: string) => void }) {
  const client = authClient!;
  const session = client.useSession();
  const [open, setOpen] = useState(false);
  const user = session.data?.user;

  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <span className="ds-panel-title">Account</span>
        {session.isPending && <span className="ds-chip">…</span>}
      </div>
      {user ? (
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <span className="ds-chip">
              <b>{user.email ?? 'signed in'}</b>
            </span>
            <span className="ds-head-spacer" />
            <button className="ds-btn ghost" onClick={() => client.signOut()}>
              Sign out
            </button>
          </div>
          <DisplayName userId={user.id} fallback={user.name ?? 'Player'} onSaved={onHandleSaved} />
          <Username userId={user.id} />
          <div>
            <p className="ds-hint" style={{ margin: '0 0 4px' }}>Account ID</p>
            {/* --ds-mut, not the --muted bridge: that one belongs to the in-match HUD */}
            <code
              title="Click to copy"
              onClick={() => void navigator.clipboard?.writeText(user.id)}
              style={{ cursor: 'pointer', fontSize: 12, wordBreak: 'break-all', color: 'var(--ds-mut)' }}
            >
              {user.id}
            </code>
          </div>
        </div>
      ) : (
        <div style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <p className="ds-hint" style={{ margin: 0 }}>
            Sign in to save records and rank up.
          </p>
          <span className="ds-head-spacer" />
          <button className="ds-btn primary" onClick={() => setOpen(true)}>
            Sign in
          </button>
        </div>
      )}
      {open && <AuthPanel onClose={() => setOpen(false)} />}
    </div>
  );
}

/** editable public display name (the leaderboard/profile handle) */
function DisplayName({
  userId,
  fallback,
  onSaved,
}: {
  userId: string;
  fallback: string;
  onSaved?: (handle: string) => void;
}) {
  const configured = gameServerConfigured();
  const [name, setName] = useState(fallback);
  const [saved, setSaved] = useState(fallback);
  const [status, setStatus] = useState<'idle' | 'saving' | 'ok' | 'error'>('idle');
  const [error, setError] = useState('');

  // load the current handle from the server (may differ from the auth name)
  useEffect(() => {
    if (!configured) return;
    let alive = true;
    fetchProfile(userId)
      .then((p) => {
        if (!alive || !p.handle) return;
        setName(p.handle);
        setSaved(p.handle);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [userId, configured]);

  const trimmed = name.trim();
  const dirty = trimmed !== saved;
  const valid = trimmed.length >= 2 && trimmed.length <= 24;

  const save = (): void => {
    if (!dirty || !valid) return;
    setStatus('saving');
    setError('');
    updateHandle(trimmed)
      .then((r) => {
        setSaved(r.handle);
        setName(r.handle);
        setStatus('ok');
        onSaved?.(r.handle);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      });
  };

  return (
    <div className="ds-panelbox">
      <label className="ds-field">
        <span className="cap">
          Display name <span className="val" style={{ color: valid ? undefined : 'var(--ds-danger)' }}>
            {trimmed.length}/24
          </span>
        </span>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="ds-input"
            style={{ flex: '1 1 240px' }}
            type="text"
            maxLength={24}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (status !== 'idle') setStatus('idle');
            }}
            placeholder="Shown on leaderboards"
          />
          <button className="ds-btn primary" disabled={!dirty || !valid || status === 'saving'} onClick={save}>
            {status === 'saving' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </label>
      <p className="ds-hint" style={{ margin: 0 }}>
        Shown on leaderboards and to other drivers. 2–24 characters.
        {!configured && ' Editing needs the game server.'}
        {status === 'ok' && !dirty && <span style={{ color: 'var(--ds-ok)' }}> · Saved.</span>}
        {status === 'error' && <span style={{ color: 'var(--ds-danger)' }}> · {error}</span>}
      </p>
    </div>
  );
}

/** the unique public username (the /profile/<username> slug + @-mention) */
function Username({ userId }: { userId: string }) {
  const configured = gameServerConfigured();
  const [value, setValue] = useState('');
  const [current, setCurrent] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'ok' | 'error'>('idle');
  const [error, setError] = useState('');
  const check = useUsernameCheck(value, current ?? undefined);

  useEffect(() => {
    if (!configured) return;
    let alive = true;
    fetchProfile(userId)
      .then((p) => {
        if (!alive) return;
        setCurrent(p.username);
        if (p.username) setValue(p.username);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [userId, configured]);

  const dirty = check.normalized !== (current ?? '');
  const canSave = dirty && check.ok && status !== 'saving';

  const save = (): void => {
    if (!canSave) return;
    setStatus('saving');
    setError('');
    updateUsername(check.normalized)
      .then((r) => {
        setCurrent(r.username);
        setValue(r.username);
        setStatus('ok');
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      });
  };

  return (
    <div className="ds-panelbox">
      <label className="ds-field">
        <span className="cap">Username</span>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 240px' }}>
            <UsernameInput value={value} onChange={setValue} />
          </div>
          <button className="ds-btn primary" disabled={!canSave} onClick={save}>
            {status === 'saving' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </label>
      <p className="ds-hint" style={{ margin: 0 }}>
        {current ? (
          <>Your profile: <code>/profile/{current}</code>. </>
        ) : (
          'Unique — lowercase letters and numbers, 4–20 characters. '
        )}
        {!configured && 'Editing needs the game server. '}
        {status === 'error' ? (
          <span style={{ color: 'var(--ds-danger)' }}>{error}</span>
        ) : status === 'ok' && !dirty ? (
          <span style={{ color: 'var(--ds-ok)' }}>Saved.</span>
        ) : (
          dirty && <span style={{ color: usernameHintColor(check.status) }}>{check.message}</span>
        )}
      </p>
    </div>
  );
}

function IdentityDisabled() {
  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <span className="ds-panel-title">Account</span>
      </div>
      <div className="ds-empty">
        <div className="big">Accounts are off in this build</div>
        Set <code>VITE_NEON_AUTH_URL</code> to enable sign-in, saved records, and ranked ELO.
      </div>
    </div>
  );
}
