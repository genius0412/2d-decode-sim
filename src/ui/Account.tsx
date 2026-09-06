import { useEffect, useState } from 'react';
import type { GameSettings } from '../game';
import { defaultSettings } from '../settings';
import { authEnabled, authClient } from '../lib/authClient';
import { gameServerConfigured, multiServer, selectedServerId } from '../net/env';
import {
  deleteMyAccount,
  fetchEntitlements,
  fetchProfile,
  updateHandle,
  updateUsername,
  type Entitlements,
} from '../net/api';
import { AuthPanel } from './AuthPanel';
import { DesktopUpdate } from './DesktopUpdate';
import { ServerMenu } from './ServerMenu';
import { UsernameInput, useUsernameCheck, usernameHintColor } from './UsernameField';
import { APP_NAME } from '../seasons';
import { SUPPORT_ENABLED } from '../net/env';
import { LEGAL_CONTACT } from '../legalText';
import { trackEvent } from '../analytics';

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
  onDonate,
}: {
  settings: GameSettings;
  onChange: (s: GameSettings) => void;
  /** a saved display name, pushed straight back up to App so the header pill
   * updates on save instead of waiting for the next reload */
  onHandleSaved?: (handle: string) => void;
  /** navigate to the Support page — the membership card links to it rather than
   * duplicating the tier pitch here */
  onDonate?: () => void;
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

      {authEnabled && SUPPORT_ENABLED && <Membership onDonate={onDonate} />}

      <div className="ds-panel" style={{ marginTop: 18 }}>
        <div className="ds-panel-h">
          <span className="ds-panel-title">Reset</span>
        </div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
          <button
            className="ds-btn"
            onClick={() => {
              if (confirm(
                  'Reset every setting? This clears your robot build, saved robots, imported autos, ' +
                    'saved start positions, key bindings, audio and mobile layout. It cannot be undone.',
                )) {
                onChange(defaultSettings());
              }
            }}
          >
            Reset all settings
          </button>
        </div>
      </div>

      {authEnabled && <DeleteAccount />}
    </>
  );
}

/**
 * Membership status.
 *
 * Lives here rather than only on the Donate page because "when does my
 * subscription run out, and is it going to renew?" is an ACCOUNT question, and
 * making someone visit a page titled "Support DSIM" to answer it reads as a
 * second sales pitch. It also surfaces the one state a supporter genuinely needs
 * warning about: a membership that is active but NOT linked to a Ko-fi address,
 * which will simply stop at the end of the period with no renewal.
 */
function Membership({ onDonate }: { onDonate?: () => void }) {
  const [ent, setEnt] = useState<Entitlements | null>(null);
  const session = authClient!.useSession();
  const userId = session.data?.user?.id ?? null;

  useEffect(() => {
    if (!userId) {
      setEnt(null);
      return;
    }
    let cancelled = false;
    void fetchEntitlements().then((e) => {
      if (!cancelled) setEnt(e);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (!userId) return null;
  const until = ent?.supporterUntil ? new Date(ent.supporterUntil) : null;
  // ~10 days: long enough to renew before it lapses, short enough not to nag.
  const endingSoon = !!until && until.getTime() - Date.now() < 10 * 864e5;

  return (
    <div className="ds-panel" style={{ marginTop: 18 }}>
      <div className="ds-panel-h">
        <span className="ds-panel-title">Membership</span>
        {ent?.supporter && <span className="ds-count">supporter</span>}
      </div>
      <div style={{ padding: 16 }}>
        {!ent ? (
          <p className="ds-hint">Checking…</p>
        ) : ent.supporter ? (
          <>
            <p className="ds-hint">
              Supporter{until ? ` until ${until.toLocaleDateString()}` : ''} ·{' '}
              {ent.autoRenews ? 'renews automatically' : 'will not renew'}
            </p>
            {!ent.autoRenews && (
              <p className="ds-hint" style={{ marginTop: 8, color: 'var(--ds-warn)' }}>
                This membership isn’t linked to a Ko-fi account, so it will stop at the end of the
                period. Claim a payment on the Support page to link it.
              </p>
            )}
            {ent.autoRenews && endingSoon && (
              <p className="ds-hint" style={{ marginTop: 8 }}>
                Your next Ko-fi payment will extend this automatically. Nothing to do.
              </p>
            )}
          </>
        ) : (
          <p className="ds-hint">
            No membership. DSIM is free either way; supporting turns off ads and adds a few
            cosmetic extras.
          </p>
        )}
        {onDonate && (
          <button className="ds-btn ghost" style={{ marginTop: 12 }} onClick={onDonate}>
            {ent?.supporter ? 'Manage on the Support page' : 'See what supporting gets you'}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Account deletion.
 *
 * The privacy policy promises this, which means it has to be a button rather
 * than an inbox commitment someone honours by hand when they get round to it.
 *
 * Two guards, because it is irreversible and cascades across every table: a
 * typed confirmation (not an OK/Cancel dialog anyone can dismiss by muscle
 * memory) and an explicit note about what SURVIVES — a promise to erase
 * everything would be a lie, since a completed match's result still involves the
 * other players and financial records have to outlive the account.
 */
function DeleteAccount() {
  const session = authClient!.useSession();
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!session.data?.user) return null;

  const doDelete = async (): Promise<void> => {
    if (confirm !== 'DELETE' || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await deleteMyAccount();
      trackEvent('account_deleted');
      // Sign out AFTER the server confirms: signing out first would drop the very
      // token the delete request needs.
      await authClient!.signOut();
      location.href = '/';
    } catch (e) {
      // The route can be MISSING rather than broken: one Fly app serves every
      // client version, so a client deployed ahead of the server gets a 404 here.
      // The privacy policy promises deletion either way, so a failure has to fall
      // back to the promise we can always keep - a human answering the mailbox -
      // rather than leaving someone stuck on a button that does nothing.
      const msg = e instanceof Error ? e.message : '';
      setErr(
        /404|not found|unavailable/i.test(msg)
          ? `Self-service deletion isn’t available on this server yet. Email ${LEGAL_CONTACT} and your account will be deleted.`
          : msg || 'Couldn’t delete the account.',
      );
      setBusy(false);
    }
  };

  return (
    <div className="ds-panel" style={{ marginTop: 18 }}>
      <div className="ds-panel-h">
        <span className="ds-panel-title">Delete account</span>
      </div>
      <div style={{ padding: 16 }}>
        <p className="ds-hint">
          Permanently deletes your profile, username, saved settings and robot presets, records
          and practice runs with their replays, ranked rating and history, your playtime and
          account standing, and every friendship, block, and invite. This cannot be undone.
        </p>
        <p className="ds-hint" style={{ marginTop: 8 }}>
          Matches you played stay on other players' history without your name, and payment records
          are kept (without your email) because they are financial records. Your sign-in identity
          itself lives with our authentication provider. Delete it there too if you want it gone.
        </p>
        <div className="ds-claim-row" style={{ marginTop: 12 }}>
          <input
            className="ds-input"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Type DELETE to confirm"
            aria-label="Type DELETE to confirm account deletion"
          />
          <button
            className="ds-btn danger"
            disabled={busy || confirm !== 'DELETE'}
            onClick={() => void doDelete()}
          >
            {busy ? 'Deleting…' : 'Delete my account'}
          </button>
        </div>
        {err && (
          <p className="ds-claim-msg err" role="status">
            {err}
          </p>
        )}
      </div>
    </div>
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
            <span style={{ fontWeight: 700, color: 'var(--ds-ink)' }}>{user.email ?? 'signed in'}</span>
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
          'Unique. Lowercase letters and numbers, 4–20 characters. '
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
