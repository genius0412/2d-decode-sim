import type { LobbyClient } from '../net/lobbyClient';
import type { QueueMode } from '../net/protocol';

/**
 * A ranked queue that outlives the screen that started it.
 *
 * `Matchmaking` owns the socket while it is on screen. When it unmounts mid-search
 * it PARKS the live `LobbyClient` here instead of disposing it, and re-adopts it on
 * remount. Nothing about how the socket is opened, queued or handed to a match
 * changes — this only changes how long it lives and who is listening while nobody
 * is looking.
 *
 * A module singleton rather than context state on purpose: the whole point is to
 * survive the unmount of the component tree that created it, so it must not live
 * in that tree. `LobbyClient.on()` REPLACES the handler for an event, so the
 * hand-off in both directions is a plain re-registration with no unsubscribe
 * bookkeeping to get wrong.
 */
export interface ParkedQueue {
  lobby: LobbyClient;
  mode: QueueMode;
  /** Date.now() the search began, so a remount shows a continuous elapsed timer */
  since: number;
  size: number;
  need: number;
  /** the assignment that arrived while parked — a remount acts on it immediately
   *  rather than waiting for an event that has already been and gone */
  assignedRoom: string | null;
  /** a match exists (assigned, or started on the single-region path) */
  found: boolean;
  error: string | null;
}

let parked: ParkedQueue | null = null;
const subs = new Set<() => void>();

function notify(): void {
  for (const fn of [...subs]) fn();
}

export function peekQueue(): ParkedQueue | null {
  return parked;
}

/** hand the live socket over to the keeper (Matchmaking is unmounting) */
export function parkQueue(q: ParkedQueue): void {
  parked = q;
  notify();
}

/** take it back (Matchmaking is mounting). The caller MUST re-register handlers. */
export function takeQueue(): ParkedQueue | null {
  const q = parked;
  parked = null;
  notify();
  return q;
}

/** cancel a parked search outright — leaves the queue, closes the socket */
export function dropQueue(): void {
  if (!parked) return;
  const { lobby } = parked;
  parked = null;
  notify();
  try {
    lobby.leaveQueue();
  } catch {
    /* already closed — dispose still runs */
  }
  lobby.dispose();
}

export function updateQueue(patch: Partial<ParkedQueue>): void {
  if (!parked) return;
  // A NEW OBJECT, never a mutation. `useSyncExternalStore` compares snapshots by
  // reference, so mutating in place notifies subscribers who then read an identical
  // snapshot and skip the render. That is not theoretical — it shipped in the first
  // cut of this file and the match-found takeover silently never fired, while the
  // bar still looked correct because it repaints on its own one-second timer.
  parked = { ...parked, ...patch };
  notify();
}

/**
 * DEV-ONLY test handle: drive the bar and the match-found takeover without a second
 * player. The real flow needs two signed-in accounts completing a rated match, so
 * this is the only way to exercise the UI locally.
 *
 * Gated on `import.meta.env.DEV`, which is false for every production build — a
 * shipped bundle must not carry a handle that lets anything on the page cancel a
 * stranger's ranked queue.
 */
export function exposeForTesting(enabled: boolean): void {
  if (!enabled || typeof window === 'undefined') return;
  (window as unknown as Record<string, unknown>).__dsimQueue = {
    park: parkQueue, take: takeQueue, drop: dropQueue, update: updateQueue, peek: peekQueue,
  };
}

export function subscribeQueue(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** "1:07" — a parked search's elapsed time, formatted for the queue bar */
export function elapsedLabel(since: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
