import { useEffect, useRef, useState } from 'react';
import { searchUsers, type PublicProfile } from '../net/api';
import { SupporterBadge } from './SupporterBadge';

/**
 * "Search name or @username" — a standalone public search, independent of the friends
 * panel's own add-friend box. Same debounce/sequence-guard shape as
 * `FriendsPanel`'s `AddFriend` (250ms, drop stale responses), but this one just
 * opens a profile — no friend-request affordance.
 */
export function UserSearchBar({ onOpenProfile }: { onOpenProfile: (username: string) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PublicProfile[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    const mine = ++seq.current;
    const t = window.setTimeout(() => {
      void searchUsers(q).then((users) => {
        if (seq.current === mine) setResults(users);
      });
    }, 250);
    return () => window.clearTimeout(t);
  }, [query]);

  const pick = (username: string | null): void => {
    if (!username) return;
    onOpenProfile(username);
    setQuery('');
    setResults([]);
  };

  return (
    <div className="ds-usersearch">
      <input
        className="ds-input"
        value={query}
        placeholder="Search name or @username"
        aria-label="Search for a player by display name or username"
        onChange={(e) => setQuery(e.target.value)}
      />
      {results.length > 0 && (
        <div className="ds-usersearch-results">
          {results.map((p) => (
            <button
              key={p.userId}
              className="fr-who"
              onClick={() => pick(p.username)}
              disabled={!p.username}
              title={p.username ? `View @${p.username}` : undefined}
            >
              <span className="fr-nameline">
                <span className="fr-name">{p.handle}</span>
                <SupporterBadge supporter={p.supporter} role={p.role} />
              </span>
              <span className="fr-sub">@{p.username}</span>
            </button>
          ))}
        </div>
      )}
      {query.trim().length >= 2 && results.length === 0 && (
        <p className="fr-empty">No players found.</p>
      )}
    </div>
  );
}
