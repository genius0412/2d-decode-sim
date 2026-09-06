import type { ShellNav } from './AppShell';
import { QueueCounts } from './QueueCounts';

/** the four top-level destinations, in the order they appear on the home menu.
 *
 * A hint NAMES WHAT IS BEHIND THE LABEL; it never restates it. "Play → Pick a
 * game mode" said nothing the word Play did not, in the one slot that renders
 * twice (the home keycap `.mh` and the rail `.rh`). */
export const RAIL_ITEMS: ReadonlyArray<{ id: ShellNav; label: string; hint: string }> = [
  { id: 'play', label: 'Play', hint: 'Practice & compete' },
  { id: 'configure', label: 'Configure', hint: 'Robot & match setup' },
  { id: 'records', label: 'Records', hint: 'Leaderboard & career' },
  { id: 'profile', label: 'Profile', hint: 'Account & settings' },
];

/**
 * Persistent left navigation for every screen EXCEPT home (where the same
 * destinations sit centered as the main menu). Renders as a flex sibling of the
 * content column INSIDE `.ds-app` — never `position: fixed`, because `.ds-app`
 * is the app's only scroll container (`html, body, #root` are `overflow:hidden`
 * for the full-screen game canvas) and a fixed rail would fight it.
 */
export function NavRail({
  active,
  onNav,
  showAdmin,
}: {
  active: ShellNav;
  onNav: (n: ShellNav) => void;
  showAdmin?: boolean;
}) {
  return (
    <nav className="ds-rail" aria-label="Main">
      <button className="ds-rail-home" onClick={() => onNav('home')}>
        ← Home
      </button>
      <div className="ds-rail-items">
        {RAIL_ITEMS.map((it) => (
          <button
            key={it.id}
            className={`ds-rail-btn${active === it.id ? ' on' : ''}`}
            aria-current={active === it.id ? 'page' : undefined}
            onClick={() => onNav(it.id)}
          >
            <span className="rl">
              {it.label}
              {it.id === 'play' && <QueueCounts className="rail" />}
            </span>
            <span className="rh">{it.hint}</span>
          </button>
        ))}
        {showAdmin && (
          <button
            className={`ds-rail-btn${active === 'admin' ? ' on' : ''}`}
            aria-current={active === 'admin' ? 'page' : undefined}
            onClick={() => onNav('admin')}
          >
            <span className="rl">Admin</span>
            <span className="rh">Server control</span>
          </button>
        )}
      </div>
    </nav>
  );
}
