import type { LobbyClient, MatchStart } from '../net/lobbyClient';
import type { LobbyPlayer, PlayerIntro, QueueMode } from '../net/protocol';
import type { GameId } from '../types';
import type { PendingChallenge } from './challenge';

/** a `strategyStart` that arrived while parked, kept whole so the screen that
 *  adopts the socket can open the window the event already announced */
export interface ParkedStrategy {
  deadline: number;
  yourRobotId: number;
  mode: QueueMode;
  intros: PlayerIntro[];
  players: LobbyPlayer[];
  myClientId: string;
}

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
  /**
   * WHICH GAME this search is for — DECODE or Chain Reaction.
   *
   * Load-bearing, and its absence was a real bug: the whole point of parking is
   * that the player goes off and does something else, and "something else" can be
   * the OTHER game, which moves `settings.game`. Without the queue remembering its
   * own game, adopting it read whatever game the player happened to be in — queue
   * Chain Reaction, start a DECODE run, and the match-found takeover came up as
   * DECODE for a Chain Reaction match. The parked queue is the authority here; the
   * live setting is not.
   */
  game: GameId;
  /**
   * The "play a friend" challenge this search was queued under, if any.
   *
   * Carried for the same reason as `game`: the parked queue is the authority on
   * what the search IS. Without it an adopted challenge came back as an ordinary
   * open queue — "Finding a match…" instead of "Waiting for @them", and a CANCEL
   * that no longer knew it was leaving a private challenge.
   */
  challenge: PendingChallenge | null;
  /** Date.now() the search began, so a remount shows a continuous elapsed timer */
  since: number;
  size: number;
  need: number;
  /**
   * Signals that arrived WHILE PARKED. Each is an event that has already fired and
   * will never fire again, so the screen that adopts the socket has to be handed
   * the payload rather than left waiting for it.
   *
   * `assignedRoom` is the production path (reconnect to the host region).
   * `start`/`strategy` are the single-region / no-DB path, where the match runs on
   * the matchmaker socket itself — those two used to be recorded as a bare
   * `found: true` with the payload dropped on the floor, which left the player
   * watching "Finding a match…" for a match the server had already begun.
   */
  assignedRoom: string | null;
  start: MatchStart | null;
  strategy: ParkedStrategy | null;
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

/**
 * Whole seconds a search has been running, from when it ACTUALLY started.
 *
 * The one definition of queue time, shared by the bar and the search screen. The
 * screen used to count up from its own mount instead, so adopting a parked queue
 * restarted the stopwatch at zero and told the player they had been waiting a
 * second when they had been waiting two minutes. Elapsed is a function of `since`;
 * it is not something a component gets to have its own opinion about.
 */
export function elapsedSeconds(since: number, now = Date.now()): number {
  return Math.max(0, Math.floor((now - since) / 1000));
}

/** "1:07" — a parked search's elapsed time, formatted for the queue bar */
export function elapsedLabel(since: number, now = Date.now()): string {
  const s = elapsedSeconds(since, now);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
