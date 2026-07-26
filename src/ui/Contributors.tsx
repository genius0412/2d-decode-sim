import { useEffect, useState } from 'react';
import { CONTRIBUTORS, type Contributor } from '../contributors';
import { fetchProfileByUsername } from '../net/api';
import { APP_NAME } from '../seasons';

/**
 * Contributors — the people who built the sim, linked from the footer.
 *
 * Display names are NOT hardcoded. The whole point of the handle system is that
 * `handle` is the one source of truth for what a player is called and can change
 * at any time, so each card resolves its own live handle from `inGameUsername`
 * and falls back to the static `fallbackName` while that's in flight, when the
 * contributor has no game account, or when the game server is unreachable.
 *
 * One fetch per contributor is fine at this size; past ~15 people this wants a
 * batch endpoint rather than N parallel requests.
 */
export function Contributors({ onOpenProfile }: { onOpenProfile: (username: string) => void }) {
  return (
    <>
      <p className="ds-eyebrow">{APP_NAME} · Credits</p>
      <h1 className="ds-h1">Contributors</h1>

      <section className="ds-panel">
        <div className="ds-panel-h">
          <span className="ds-panel-title">Built by</span>
          <span className="ds-count">{CONTRIBUTORS.length}</span>
        </div>
        <div style={{ padding: 16 }}>
          <div className="contrib-grid">
            {CONTRIBUTORS.map((c) => (
              <ContributorCard key={c.fallbackName} c={c} onOpenProfile={onOpenProfile} />
            ))}
          </div>
          <p className="ds-hint" style={{ marginTop: 14 }}>
            Names link to that driver’s in-game profile where they have one.
          </p>
        </div>
      </section>
    </>
  );
}

function ContributorCard({
  c,
  onOpenProfile,
}: {
  c: Contributor;
  onOpenProfile: (username: string) => void;
}) {
  const [handle, setHandle] = useState<string | null>(null);

  useEffect(() => {
    const username = c.inGameUsername;
    if (!username) return;
    let cancelled = false;
    fetchProfileByUsername(username)
      .then((p) => {
        if (!cancelled) setHandle(p.handle);
      })
      // no game server, asleep, or the account was deleted — the static name stands
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [c.inGameUsername]);

  const name = handle ?? c.fallbackName;
  const username = c.inGameUsername;
  const open = (): void => {
    if (username) onOpenProfile(username);
  };

  return (
    <div className="contrib-card">
      <Avatar url={c.discordAvatarUrl} name={name} />
      <div className="contrib-body">
        {username ? (
          <button className="contrib-name" onClick={open} title={`View ${name}’s profile`}>
            {name}
          </button>
        ) : (
          <span className="contrib-name static">{name}</span>
        )}
        {username ? (
          <button className="contrib-user" onClick={open} title={`View ${name}’s profile`}>
            @{username}
          </button>
        ) : (
          c.role && <span className="contrib-user static">{c.role}</span>
        )}
        <div className="contrib-icons">
          {c.discordUrl && (
            <a
              className="contrib-icon"
              href={c.discordUrl}
              target="_blank"
              rel="noreferrer"
              title={`${name} on Discord`}
              aria-label={`${name} on Discord`}
            >
              <DiscordGlyph />
            </a>
          )}
          {c.githubUrl && (
            <a
              className="contrib-icon"
              href={c.githubUrl}
              target="_blank"
              rel="noreferrer"
              title={`${name} on GitHub`}
              aria-label={`${name} on GitHub`}
            >
              <GitHubGlyph />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

/** Discord avatar, or the contributor's initials when there's no URL on file.
 * `onError` covers a dead CDN link so a broken-image icon never ships. */
function Avatar({ url, name }: { url?: string; name: string }) {
  const [failed, setFailed] = useState(false);
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

  if (!url || failed) return <div className="contrib-avatar fallback">{initials || '?'}</div>;
  return (
    <img
      className="contrib-avatar"
      src={url}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function DiscordGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M20.32 4.37A19.8 19.8 0 0 0 15.43 3a13.9 13.9 0 0 0-.63 1.28 18.4 18.4 0 0 0-5.6 0A13.4 13.4 0 0 0 8.57 3 19.7 19.7 0 0 0 3.68 4.38C.57 9 -.28 13.53.15 18a19.9 19.9 0 0 0 6 3.03c.48-.66.91-1.36 1.28-2.09a13 13 0 0 1-2.02-.97c.17-.12.34-.25.5-.38a14.2 14.2 0 0 0 12.18 0c.16.14.33.26.5.38-.65.38-1.33.7-2.03.97.37.73.8 1.43 1.28 2.09a19.8 19.8 0 0 0 6.01-3.03c.5-5.18-.85-9.67-3.53-13.64ZM8.02 15.33c-1.18 0-2.15-1.08-2.15-2.41s.95-2.42 2.15-2.42 2.17 1.09 2.15 2.42c0 1.33-.95 2.41-2.15 2.41Zm7.96 0c-1.18 0-2.15-1.08-2.15-2.41s.95-2.42 2.15-2.42 2.17 1.09 2.15 2.42c0 1.33-.95 2.41-2.15 2.41Z" />
    </svg>
  );
}

function GitHubGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.73.5.7 5.53.7 11.8c0 4.99 3.24 9.22 7.73 10.72.57.1.78-.25.78-.55v-2.1c-3.15.69-3.81-1.34-3.81-1.34-.52-1.31-1.26-1.66-1.26-1.66-1.03-.7.08-.69.08-.69 1.14.08 1.74 1.17 1.74 1.17 1.01 1.74 2.66 1.24 3.31.95.1-.73.4-1.24.72-1.53-2.51-.29-5.15-1.26-5.15-5.6 0-1.24.44-2.25 1.17-3.04-.12-.29-.51-1.44.11-3 0 0 .95-.3 3.12 1.16a10.8 10.8 0 0 1 5.68 0c2.17-1.46 3.12-1.16 3.12-1.16.62 1.56.23 2.71.11 3 .73.79 1.17 1.8 1.17 3.04 0 4.35-2.65 5.31-5.17 5.59.41.35.77 1.04.77 2.1v3.11c0 .3.2.66.79.55A11.31 11.31 0 0 0 23.3 11.8C23.3 5.53 18.27.5 12 .5Z" />
    </svg>
  );
}
