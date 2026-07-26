import { useEffect, useState } from 'react';
import { fetchPresence, type Presence } from '../net/api';
import { gameServerConfigured } from '../net/env';

/**
 * Poll the game server's live presence (online / signed-in / per-queue depth).
 * Returns null until the first successful fetch, and stays null when the game
 * server isn't configured or a fetch fails (callers just render nothing).
 *
 * Polls only while mounted, so navigating away stops the requests - deliberate,
 * because each poll wakes the auto-stopping Fly machine. The default 8s cadence
 * keeps queue counts fresh enough to decide on without hammering the server.
 *
 * A HIDDEN TAB DOES NOT POLL. Nobody reads a chip they cannot see, and a
 * background tab left open for hours otherwise keeps both the Fly machine and the
 * Neon compute awake for all of it - the database bills by the hour it is awake,
 * so this is the difference between "someone forgot a tab" and a month of compute.
 * `visibilitychange` catches the tab up the moment it comes back, so the only
 * visible effect is that the first frame after refocusing can be one beat stale.
 * (`useFriends` does the same thing for the same reason.)
 *
 * `full` forces the true cross-region aggregate instead of letting an idle server
 * answer from memory - see `fetchPresence`. Pass it where the number decides
 * something (ranked queue depth); leave it off for the ambient online chip, which
 * is the one that sits on screen for hours.
 */
export function usePresence(pollMs = 8000, full = false): Presence | null {
  const [presence, setPresence] = useState<Presence | null>(null);
  useEffect(() => {
    if (!gameServerConfigured()) return;
    let alive = true;
    const tick = (): void => {
      if (document.visibilityState !== 'visible') return;
      fetchPresence(full)
        .then((p) => {
          if (alive) setPresence(p);
        })
        .catch(() => {
          /* server asleep / unreachable - keep the last value, try again next tick */
        });
    };
    tick();
    const iv = window.setInterval(tick, pollMs);
    document.addEventListener('visibilitychange', tick);
    return () => {
      alive = false;
      window.clearInterval(iv);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [pollMs, full]);
  return presence;
}
