import type { GameId } from '../types';
import type { Replay } from '../sim/replay';
import { APP_NAME } from '../seasons';
import { Leaderboard } from './Leaderboard';
import { Stats } from './Stats';
import { UserSearchBar } from './UserSearchBar';

export const RECORDS_TABS = ['leaderboard', 'career'] as const;
export type RecordsTab = (typeof RECORDS_TABS)[number];

export function isRecordsTab(s: string | null): s is RecordsTab {
  return s !== null && (RECORDS_TABS as readonly string[]).includes(s);
}

const LABELS: Record<RecordsTab, string> = {
  leaderboard: 'Leaderboard',
  career: 'Career',
};

/**
 * Records — the global leaderboard and your own career, behind one destination.
 * Both panels are the existing components; only the heading and the tab strip
 * are new. `/leaderboard` and `/stats` still resolve here (see App's parsePath)
 * so old links and the replay viewer's "back" keep working.
 */
export function Records({
  tab,
  onTab,
  myUserId,
  game,
  onWatch,
  onWatchLocal,
  onOpenProfile,
}: {
  tab: RecordsTab;
  onTab: (t: RecordsTab) => void;
  myUserId: string | null;
  game?: GameId;
  onWatch: (replayId: string) => void;
  /** watch a replay held only on this DEVICE (a local solo-practice run) */
  onWatchLocal?: (replay: Replay) => void;
  onOpenProfile: (username: string) => void;
}) {
  return (
    <>
      <p className="ds-eyebrow">{APP_NAME} · Records</p>
      <h1 className="ds-h1">Records</h1>

      <UserSearchBar onOpenProfile={onOpenProfile} />

      {/* These buttons change the URL (/records vs /records/career), so they are
          NAVIGATION, not an ARIA tablist. The old `role="tab"` + `aria-selected` was a
          partial tabs pattern — worse than none: a screen reader announced "tab, 1 of 2",
          the user pressed → expecting to move, and nothing happened (no tabpanel, no
          aria-controls, no roving tabindex). Matches Configure's sub-nav and NavRail. */}
      <nav className="ds-tabs" aria-label="Records sections">
        {RECORDS_TABS.map((t) => (
          <button
            key={t}
            className={`ds-tab${tab === t ? ' on' : ''}`}
            aria-current={tab === t ? 'page' : undefined}
            onClick={() => onTab(t)}
          >
            {LABELS[t]}
          </button>
        ))}
      </nav>

      {tab === 'leaderboard' ? (
        <Leaderboard myUserId={myUserId} game={game} onWatch={onWatch} onOpenProfile={onOpenProfile} />
      ) : (
        <Stats game={game} onWatch={onWatch} onWatchLocal={onWatchLocal} onOpenProfile={onOpenProfile} />
      )}
    </>
  );
}
