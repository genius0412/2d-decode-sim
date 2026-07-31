import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  dropQueue, elapsedLabel, exposeForTesting, peekQueue, subscribeQueue, type ParkedQueue,
} from './queueKeeper';
import { backgroundQueueEnabled } from './flags';

/** re-render on any change to the parked queue (null when nothing is parked). Lives
 *  here rather than in the keeper so that module stays React-free and its store can
 *  be exercised directly by the test suite. */
export function useParkedQueue(): ParkedQueue | null {
  return useSyncExternalStore(subscribeQueue, peekQueue, peekQueue);
}

/**
 * The standing "you are still in the ranked queue" bar.
 *
 * Only ever visible while a search is PARKED — i.e. the player queued and then went
 * somewhere else. On the matchmaking screen itself the queue is not parked (that
 * screen owns the socket), so this does not double up with the search UI there.
 *
 * It is the only thing telling someone their queue is still live while they are
 * reading a leaderboard, so it carries the two facts that matter — which bucket and
 * how long — plus the way out. Cancel drops the socket for real; there is no
 * "minimise", because a queue you cannot see and cannot leave is the thing this
 * whole feature exists to avoid.
 */
export function QueueBar({ onOpen }: { onOpen: () => void }) {
  useEffect(() => exposeForTesting(backgroundQueueEnabled()), []);
  const q = useParkedQueue();
  const [, tick] = useState(0);

  // one repaint a second, only while the bar is up
  useEffect(() => {
    if (!q) return;
    const iv = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(iv);
  }, [q]);

  if (!q) return null;

  const found = q.found;
  return (
    <div className={`ds-queuebar${found ? ' found' : ''}`} role="status">
      <span className="qb-dot" aria-hidden />
      <span className="qb-txt">
        {found ? (
          <b>Match found</b>
        ) : (
          <>
            <b>{q.mode.toUpperCase()}</b> queue · {elapsedLabel(q.since)}
            {q.size > 0 && ` · ${q.size}/${q.need}`}
          </>
        )}
      </span>
      {q.error && <span className="qb-err">{q.error}</span>}
      <button className="ds-btn small primary" onClick={onOpen}>
        {found ? 'Play →' : 'View'}
      </button>
      {!found && (
        <button className="ds-btn small ghost" onClick={dropQueue}>
          Cancel
        </button>
      )}
    </div>
  );
}
