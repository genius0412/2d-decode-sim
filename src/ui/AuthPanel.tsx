import { useMemo, useState, type FormEvent } from 'react';
import { authClient } from '../lib/authClient';
import { isEmbeddedBrowser } from '../lib/browserEnv';
import { updateUsername } from '../net/api';
import { UsernameInput, useUsernameCheck, usernameHintColor } from './UsernameField';

/** Sign-in / sign-up modal (email+password and Google), styled to Direction A.
 * Only rendered when auth is enabled, so `authClient` is non-null. */
export function AuthPanel({ onClose }: { onClose: () => void }) {
  const client = authClient!;
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const uname = useUsernameCheck(username);
  // In-app webviews (LinkedIn/Instagram/… browsers) get Google's
  // `disallowed_useragent` 403 — steer them to a real browser instead.
  const embedded = useMemo(() => isEmbeddedBrowser(), []);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setError('Couldn’t copy — long-press the address bar to copy this link.');
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mode === 'up' && !uname.ok) return; // username must be valid + free
    setBusy(true);
    setError('');
    try {
      if (mode === 'up') {
        await client.signUp.email({ email, password, name: name || email });
        // claim the chosen username on our own profile (server verifies the fresh
        // JWT). If it doesn't land here — e.g. the token isn't ready yet — the
        // blocking UsernameGate will prompt for it on the next load.
        try {
          await updateUsername(uname.normalized);
        } catch {
          /* gate is the fallback */
        }
      } else {
        await client.signIn.email({ email, password });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong — try again.');
    } finally {
      setBusy(false);
    }
  };

  const google = async () => {
    setError('');
    try {
      await client.signIn.social({ provider: 'google', callbackURL: window.location.href });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in failed.');
    }
  };

  return (
    <div className="ds-modal-backdrop" onClick={onClose}>
      <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ds-modal-h">
          <span className="ds-panel-title">{mode === 'in' ? 'Sign in' : 'Create account'}</span>
          <button className="ds-btn ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <form className="ds-form" onSubmit={submit}>
          {mode === 'up' && (
            <>
              <label>
                <span>Display name</span>
                <input className="ds-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="On the leaderboard" />
              </label>
              <label>
                <span>Username</span>
                <UsernameInput value={username} onChange={setUsername} />
                <span className="ds-form-hint" style={{ color: usernameHintColor(uname.status) }}>
                  {uname.message}
                </span>
              </label>
            </>
          )}
          <label>
            <span>Email</span>
            <input className="ds-input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            <span>Password</span>
            <input className="ds-input" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && <div className="ds-form-err">{error}</div>}
          <button
            className="ds-btn primary"
            type="submit"
            disabled={busy || (mode === 'up' && !uname.ok)}
          >
            {busy ? 'Working…' : mode === 'in' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        {embedded ? (
          <div className="ds-form-hint" style={{ minHeight: 0 }}>
            Google sign-in doesn’t work in this app’s in-app browser. Open this page in
            Safari or Chrome to continue with Google — or use email above.
            <button
              type="button"
              className="ds-btn"
              style={{ width: '100%', marginTop: 8 }}
              onClick={copyLink}
            >
              {copied ? 'Link copied — paste in your browser' : 'Copy link'}
            </button>
          </div>
        ) : (
          <button className="ds-btn" style={{ width: '100%' }} onClick={google}>Continue with Google</button>
        )}
        <div className="ds-form-switch">
          {mode === 'in' ? (
            <>New here? <button className="ds-btn ghost" onClick={() => setMode('up')}>Create an account</button></>
          ) : (
            <>Have an account? <button className="ds-btn ghost" onClick={() => setMode('in')}>Sign in</button></>
          )}
        </div>
      </div>
    </div>
  );
}
