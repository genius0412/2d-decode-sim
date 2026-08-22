import { useEffect, useRef, useState } from 'react';
import { checkUsername, USERNAME_RE } from '../net/api';

export type UsernameStatus =
  | 'empty'
  | 'invalid' // wrong format
  | 'blocked' // format ok but disallowed by content moderation
  | 'checking' // format ok, asking the server
  | 'available'
  | 'taken'
  | 'error'; // couldn't reach the server

export interface UsernameCheck {
  /** trimmed + lowercased candidate */
  normalized: string;
  status: UsernameStatus;
  /** true only when the server confirmed it's free (safe to submit) */
  ok: boolean;
  message: string;
}

/**
 * Live-validates a username as the user types: local FORMAT check (4–20 lowercase
 * letters/digits) is instant, then a debounced server AVAILABILITY check. Shared
 * by sign-up, the blocking username gate, and the account editor so all three
 * agree on the rules. `ownValue` (the user's current username) is treated as
 * "available" — editing back to your own name isn't a conflict.
 */
export function useUsernameCheck(raw: string, ownValue?: string): UsernameCheck {
  const normalized = raw.trim().toLowerCase();
  const [status, setStatus] = useState<UsernameStatus>('empty');
  const seq = useRef(0);

  useEffect(() => {
    if (normalized.length === 0) {
      setStatus('empty');
      return;
    }
    if (ownValue && normalized === ownValue) {
      setStatus('available');
      return;
    }
    if (!USERNAME_RE.test(normalized)) {
      setStatus('invalid');
      return;
    }
    setStatus('checking');
    const mySeq = ++seq.current;
    const t = setTimeout(() => {
      checkUsername(normalized)
        .then((r) => {
          if (mySeq !== seq.current) return; // a newer keystroke supersedes this
          setStatus(
            r.reason === 'inappropriate' ? 'blocked' : !r.valid ? 'invalid' : r.available ? 'available' : 'taken',
          );
        })
        .catch(() => {
          if (mySeq === seq.current) setStatus('error');
        });
    }, 400);
    return () => clearTimeout(t);
  }, [normalized, ownValue]);

  const message =
    status === 'empty'
      ? 'Lowercase letters and numbers, 4–20 characters.'
      : status === 'invalid'
        ? 'Only lowercase letters and numbers (4–20).'
        : status === 'blocked'
          ? 'That username isn’t allowed. Please choose another.'
          : status === 'checking'
            ? 'Checking…'
            : status === 'available'
              ? 'Available ✓'
              : status === 'taken'
                ? 'That username is taken.'
                : 'Couldn’t check right now - try again.';

  return { normalized, status, ok: status === 'available', message };
}

/** colour for the status hint TEXT. --ds-ok-ink, not --ds-ok: the latter is a fill
 *  (3.25:1 as 12px type on the light panel). --ds-danger is already a text token. */
export function usernameHintColor(status: UsernameStatus): string | undefined {
  if (status === 'available') return 'var(--ds-ok-ink)';
  if (status === 'invalid' || status === 'blocked' || status === 'taken' || status === 'error')
    return 'var(--ds-danger)';
  return undefined;
}

/** a bare username `<input>` with a live @-prefix; the parent owns validation via
 * `useUsernameCheck` and renders the hint. Coerces to lowercase-alnum as typed. */
export function UsernameInput({
  value,
  onChange,
  autoFocus,
  placeholder = 'yourname',
}: {
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="ds-username-input">
      <span className="at">@</span>
      <input
        className="ds-input"
        type="text"
        maxLength={20}
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ''))}
      />
    </div>
  );
}
