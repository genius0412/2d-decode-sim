import { useEffect, useState } from 'react';
import { fetchAnnouncements, type Announcement } from './api';
import { gameServerConfigured } from './env';

/**
 * Fetch the announcement feed on load and surface any the player hasn't seen yet.
 * "Seen" is tracked in localStorage (works for anon + signed-in, no per-user DB
 * write), so a player sees each announcement ONCE — the first time they open the
 * app after it's published. Best-effort: any failure just shows nothing.
 *
 * A brand-new browser (no seen key at all) is silently caught up instead of shown
 * the backlog — see `isFirstVisit`. The full history stays available on the
 * Changelog page, which is where a first-time visitor should meet it.
 */

const SEEN_KEY = 'decodesim.seenAnnouncements.v1';
// don't dump ancient history on a brand-new visitor (empty seen set): only unseen
// announcements newer than this are shown. Comfortably longer than a patch cadence.
const MAX_AGE_DAYS = 21;
const MAX_SHOWN = 4;

/** has this browser ever been here? (the key's ABSENCE, not its emptiness — a
 * player who dismissed everything still has a key, just possibly pruned to []) */
function isFirstVisit(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === null;
  } catch {
    // storage disabled: treat every load as a first visit rather than opening a
    // modal that can never be dismissed for good
    return true;
  }
}

function loadSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveSeen(ids: Set<string>): void {
  try {
    // cap so the key can't grow unbounded across a long-lived install
    localStorage.setItem(SEEN_KEY, JSON.stringify([...ids].slice(-200)));
  } catch {
    /* storage disabled / full — the worst case is re-showing, not a crash */
  }
}

export interface AnnouncementsState {
  /** unseen announcements to show now (newest first), or [] */
  unseen: Announcement[];
  /** mark the currently-shown announcements as seen and dismiss them */
  dismiss: () => void;
}

export function useAnnouncements(): AnnouncementsState {
  const [unseen, setUnseen] = useState<Announcement[]>([]);

  useEffect(() => {
    if (!gameServerConfigured()) return;
    let alive = true;
    const first = isFirstVisit();
    fetchAnnouncements(12).then((all) => {
      if (!alive || all.length === 0) return;
      // FIRST EVER load in this browser: swallow the backlog. "What's new" is
      // meaningless to someone who has never seen what came before, and greeting
      // a brand-new visitor with a full-screen patch-notes modal is the worst
      // possible first impression. It is also what every crawler and social
      // scraper is (empty localStorage, always) — before this they read the patch
      // notes as the homepage's content. Mark the feed seen and show nothing.
      if (first) {
        saveSeen(new Set(all.map((a) => a.id)));
        return;
      }
      const seen = loadSeen();
      const cutoff = Date.now() - MAX_AGE_DAYS * 86400_000;
      const fresh = all
        .filter((a) => !seen.has(a.id) && Date.parse(a.publishedAt) >= cutoff)
        .slice(0, MAX_SHOWN);
      // prune the seen set to ids still in the feed so it stays small; keep any
      // just-fetched-but-unseen out (they become seen on dismiss)
      const feedIds = new Set(all.map((a) => a.id));
      const pruned = new Set([...seen].filter((id) => feedIds.has(id)));
      if (pruned.size !== seen.size) saveSeen(pruned);
      if (fresh.length) setUnseen(fresh);
    });
    return () => {
      alive = false;
    };
  }, []);

  const dismiss = (): void => {
    if (unseen.length === 0) return;
    const seen = loadSeen();
    for (const a of unseen) seen.add(a.id);
    saveSeen(seen);
    setUnseen([]);
  };

  return { unseen, dismiss };
}
