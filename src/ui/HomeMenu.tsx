import { useEffect, useState } from 'react';
import type { GameSettings } from '../game';
import type { DrivetrainType, GameId } from '../types';
import { APP_BLURB, APP_NAME, APP_TAGLINE, LINKS, seasonFor } from '../seasons';
import { registeredGames } from '../games';
import { fetchGlobalStats, type GlobalStats } from '../net/api';
import { RAIL_ITEMS } from './NavRail';
import { QueueCounts } from './QueueCounts';
import type { ShellNav } from './AppShell';

const DRIVETRAIN_LABELS: Record<DrivetrainType, string> = {
  mecanum: 'Mecanum',
  tank: 'Tank',
  swerve: 'Swerve',
  xdrive: 'X-Drive',
};

/**
 * The main menu. The four top-level destinations sit CENTERED as chunky keycaps
 * — on every other screen the same four live in the left rail (`NavRail`), and
 * both read from `RAIL_ITEMS` so they can never drift apart.
 *
 * It is also the site's landing page, so it states what DSIM is exactly once
 * (`APP_BLURB`) — a first-time visitor and a crawler both arrive here with no
 * other context. One sentence, no pitch. The static fallback in `index.html`
 * says the same sentence for clients that never run the bundle.
 */
export function HomeMenu({
  settings,
  multiplayer,
  onNav,
  onGame,
}: {
  settings: GameSettings;
  /** the game server is configured — gates the live player counters */
  multiplayer: boolean;
  onNav: (n: ShellNav) => void;
  /** switch the selected game (DECODE / Chain Reaction) */
  onGame: (g: GameId) => void;
}) {
  const spec = settings.spec;
  // only the games whose modules are actually registered are selectable; the
  // switcher hides itself until there are ≥2 to choose between.
  const games = registeredGames();
  const season = seasonFor(settings.game);

  // site-wide counters (players + games played), when the server is configured
  const [stats, setStats] = useState<GlobalStats | null>(null);
  useEffect(() => {
    if (!multiplayer) return;
    let alive = true;
    fetchGlobalStats()
      .then((s) => alive && setStats(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [multiplayer]);

  return (
    <div className="ds-home">
      {/* The eyebrow is CSS-uppercased, so the presenting sponsor gets its own
          span that opts back out: goBILDA is not GOBILDA. Hence `presenter` is
          a field of its own rather than part of one pre-joined string. */}
      <p className="ds-eyebrow">
        {season.name}
        {season.presenter && (
          <>
            {' presented by '}
            <span className="ds-brand">{season.presenter}</span>
          </>
        )}
        <br />
        {APP_TAGLINE}
      </p>
      <h1 className="ds-home-title">{APP_NAME}</h1>

      <p className="ds-home-lead">{APP_BLURB}</p>

      {games.length > 1 && (
        <div className="ds-segs ds-home-games" role="tablist" aria-label="Game">
          {games.map((g) => (
            <button
              key={g.id}
              role="tab"
              aria-selected={settings.game === g.id}
              className={`ds-seg${settings.game === g.id ? ' on' : ''}`}
              onClick={() => onGame(g.id)}
            >
              {seasonFor(g.id).name}
            </button>
          ))}
        </div>
      )}

      <div className="ds-home-links">
        <a className="ds-home-link" href={LINKS.discord} target="_blank" rel="noreferrer">
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="currentColor">
            <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
          </svg>
          Discord
        </a>
        <a className="ds-home-link" href={LINKS.repo} target="_blank" rel="noreferrer">
          <svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          GitHub
        </a>
      </div>

      <nav className="ds-menu" aria-label="Main">
        {RAIL_ITEMS.map((it, i) => (
          <button
            key={it.id}
            className={`ds-menu-btn${i === 0 ? ' primary' : ''}`}
            onClick={() => onNav(it.id)}
          >
            <span className="ml">
              {it.label}
              {it.id === 'play' && <QueueCounts className="menu" />}
            </span>
            <span className="mh">{it.hint}</span>
          </button>
        ))}
      </nav>

      <p className="ds-home-loadout">
        Driving <b>{spec.name}</b> · {DRIVETRAIN_LABELS[spec.drivetrain]} ·{' '}
        {spec.teamNumber ? `#${spec.teamNumber}` : 'no team'}
      </p>

      {stats && (
        <div className="ds-homestats">
          <div className="ds-stat">
            <span className="sv">{stats.users.toLocaleString()}</span>
            <span className="sl">Players</span>
          </div>
          <div className="ds-stat">
            <span className="sv">{stats.games.toLocaleString()}</span>
            <span className="sl">Games played</span>
          </div>
          <span className="ds-homestats-break">
            solo {stats.byCategory.solo} · duo {stats.byCategory.duo} · 1v1{' '}
            {stats.byCategory['1v1']} · 2v2 {stats.byCategory['2v2']}
          </span>
        </div>
      )}
    </div>
  );
}
