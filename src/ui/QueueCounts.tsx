import { createContext, useContext, type ReactNode } from 'react';
import type { Presence } from '../net/api';
import type { GameId } from '../types';
import { queuedModes, queuedGames, queuesFor, anyoneQueued } from './queueDepth';
import { SEASONS } from '../seasons';

/** the games a queue count can be shown for, in display order */
const GAME_IDS: readonly GameId[] = SEASONS.map((s) => s.key);
const GAME_LABEL: Record<string, string> = Object.fromEntries(SEASONS.map((s) => [s.key, s.name]));

/**
 * The live ranked queue depth, shared from ONE poller.
 *
 * `AppShell` already runs a single `usePresence()` for its online chip. Every menu
 * that wants to show queue depth reads THAT through this context instead of
 * mounting its own poll — each poll wakes the auto-stopping Fly machine and the
 * Neon compute behind it, so a second one for the same number on the same screen
 * would double the standing cost of an idle tab for nothing.
 *
 * `null` means "not known yet" (first fetch pending, or no game server), which
 * every consumer renders as nothing at all.
 */
const PresenceCtx = createContext<Presence | null>(null);
/**
 * The SELECTED game, so every count defaults to the one the reader can act on.
 *
 * Carried on the context rather than threaded through props because the consumers
 * (the nav rail, the mode tiles, the home menu) don't otherwise care what game is
 * selected — passing it to three components that only forward it would be three
 * chances to forget one, and forgetting one silently restores the bug this fixes.
 */
const PresenceGameCtx = createContext<GameId | undefined>(undefined);

export function PresenceProvider({
  value,
  game,
  children,
}: {
  value: Presence | null;
  game?: GameId;
  children: ReactNode;
}) {
  return (
    <PresenceCtx.Provider value={value}>
      <PresenceGameCtx.Provider value={game}>{children}</PresenceGameCtx.Provider>
    </PresenceCtx.Provider>
  );
}

export function usePresenceCtx(): Presence | null {
  return useContext(PresenceCtx);
}

/**
 * "1v1 2 · 2v2 1" — the modes with somebody actually waiting.
 *
 * A MODE AT ZERO IS OMITTED ENTIRELY, and when every mode is empty this renders
 * nothing. That is the whole point: "0 in queue" is a worse thing to show than no
 * number, because it reads as a verdict on whether to bother rather than as the
 * absence of information. A count only ever appears here when it is an argument
 * FOR queueing.
 */
export function QueueCounts({
  className = '',
  game,
  allGames = false,
}: {
  className?: string;
  /** scope the count to ONE game. Pairing is bucketed by game, so an unscoped
   *  number is one the reader cannot act on — a DECODE player was being told a
   *  Chain Reaction queuer was waiting for them. */
  game?: GameId;
  /** the TOP-BAR form: every game that has somebody waiting, each labelled by
   *  name. A game with an empty queue is omitted entirely, label included. */
  allGames?: boolean;
}) {
  const p = usePresenceCtx();
  const ctxGame = useContext(PresenceGameCtx);
  const scope = game ?? ctxGame;

  if (allGames) {
    const byGame = queuedGames(p, GAME_IDS);
    if (byGame.length === 0) return null;
    return (
      <span className={`ds-qcount ${className}`.trim()} aria-label="players waiting in ranked">
        {byGame.map((g, gi) => (
          <span key={g.game}>
            {gi > 0 && <span className="ds-qcount-sep"> · </span>}
            <span className="ds-qcount-game">{GAME_LABEL[g.game] ?? g.game}</span>
            {g.modes.map((m) => (
              <span key={m.mode}>
                {' '}
                {m.mode.toUpperCase()} <b>{m.n}</b>
              </span>
            ))}
          </span>
        ))}
      </span>
    );
  }

  const live = queuedModes(p, scope);
  const q = queuesFor(p, scope);
  if (!q || live.length === 0) return null;
  return (
    <span className={`ds-qcount ${className}`.trim()} aria-label="players waiting in ranked">
      {live.map((m, i) => (
        <span key={m}>
          {i > 0 && <span className="ds-qcount-sep"> · </span>}
          {m.toUpperCase()} <b>{q[m]}</b>
        </span>
      ))}
    </span>
  );
}

/** true when anyone at all is waiting — for callers that want to decorate a
 *  control (a dot on PLAY) rather than print the numbers. */
export function useAnyoneQueued(): boolean {
  return anyoneQueued(usePresenceCtx());
}
