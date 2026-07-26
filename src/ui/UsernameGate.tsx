import { useEffect, useState, type FormEvent } from 'react';
import { authClient } from '../lib/authClient';
import { gameServerConfigured } from '../net/env';
import { fetchProfile, updateUsername } from '../net/api';
import { UsernameInput, useUsernameCheck, usernameHintColor } from './UsernameField';

/** derive a reasonable default username from an auth name / email local-part */
function suggest(seed: string | undefined): string {
  if (!seed) return '';
  return seed.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
}

/**
 * Blocking username gate. A signed-in account that has no unique username yet
 * (every legacy account, and any Google sign-up) is REQUIRED to pick one before
 * doing anything else — the profile URL and both-names-on-duo-boards features
 * depend on everyone having one. Non-dismissible: no backdrop-close, no ✕. Renders
 * nothing when auth/server is off, signed out, or the account already has a
 * username. Only mounted when auth is enabled, so `authClient` is non-null.
 */
export function UsernameGate() {
  const configured = gameServerConfigured();
  const session = authClient!.useSession();
  const user = session.data?.user;

  // null = unknown (still checking); true = must pick; false = fine / N/A
  const [needs, setNeeds] = useState<boolean | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const check = useUsernameCheck(value);

  useEffect(() => {
    if (!configured || !user) {
      setNeeds(false);
      return;
    }
    let alive = true;
    fetchProfile(user.id)
      .then((p) => {
        if (!alive) return;
        setNeeds(!p.username);
        if (!p.username) setValue((v) => v || suggest(user.name ?? user.email));
      })
      .catch(() => {
        if (alive) setNeeds(false); // can't confirm ⇒ don't trap the user
      });
    return () => {
      alive = false;
    };
  }, [configured, user]);

  if (!configured || !user || needs !== true) return null;

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!check.ok || busy) return;
    setBusy(true);
    setErr('');
    updateUsername(check.normalized)
      .then(() => setNeeds(false))
      .catch((e2: unknown) => {
        setErr(e2 instanceof Error ? e2.message : String(e2));
        setBusy(false);
      });
  };

  return (
    <div className="ds-modal-backdrop">
      <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ds-modal-h">
          <span className="ds-panel-title">Choose your username</span>
        </div>
        <form className="ds-form" onSubmit={submit}>
          <label>
            <span>Username</span>
            <UsernameInput value={value} onChange={setValue} autoFocus />
          </label>
          <div className="ds-form-hint" style={{ color: usernameHintColor(check.status) }}>
            {err || check.message}
          </div>
          <button className="ds-btn primary" type="submit" disabled={!check.ok || busy}>
            {busy ? 'Saving…' : 'Save username'}
          </button>
        </form>
      </div>
    </div>
  );
}
