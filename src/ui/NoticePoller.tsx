import { useEffect } from 'react';
import { fetchPresence } from '../net/api';
import { gameServerConfigured } from '../net/env';
import { setServerNotice } from '../net/notice';

/**
 * Poll the game server for a LIVE admin notice (scheduled restart / info) and
 * push it into the global notice store, so the restart banner shows on EVERY
 * page — including disconnected ones (Home, solo, leaderboard) where no
 * WebSocket delivers `serverNotice`. Connected screens still get it instantly
 * over the socket; this is the fallback that makes it truly global (and keeps
 * the "can't start a new game" gate working before you ever connect).
 *
 * Mounted once at the app root. Renders nothing. Coarse cadence (the countdown
 * itself ticks locally in the banner), so it barely adds to server load.
 *
 * Skips hidden tabs, and re-checks the moment one is focused - see `usePresence`
 * for why (a background tab polling forever holds the Fly machine and the Neon
 * compute awake, and Neon bills for every hour it is awake). A notice that lands
 * while the tab is hidden is picked up on the visibilitychange, which is before
 * the reader could have acted on it anyway.
 */
export function NoticePoller({ pollMs = 20000 }: { pollMs?: number }) {
  useEffect(() => {
    if (!gameServerConfigured()) return;
    let alive = true;
    const tick = (): void => {
      if (document.visibilityState !== 'visible') return;
      fetchPresence()
        .then((p) => {
          if (alive) setServerNotice(p.notice ?? null);
        })
        .catch(() => {
          /* server asleep / unreachable - keep the last value, retry next tick */
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
  }, [pollMs]);
  return null;
}
