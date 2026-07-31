import { createContext, useContext, type ReactNode } from 'react';
import type { Presence } from '../net/api';
import { queuedModes, anyoneQueued } from './queueDepth';

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

export function PresenceProvider({
  value,
  children,
}: {
  value: Presence | null;
  children: ReactNode;
}) {
  return <PresenceCtx.Provider value={value}>{children}</PresenceCtx.Provider>;
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
export function QueueCounts({ className = '' }: { className?: string }) {
  const p = usePresenceCtx();
  const live = queuedModes(p);
  if (!p || live.length === 0) return null;
  return (
    <span className={`ds-qcount ${className}`.trim()} aria-label="players waiting in ranked">
      {live.map((m, i) => (
        <span key={m}>
          {i > 0 && <span className="ds-qcount-sep"> · </span>}
          {m.toUpperCase()} <b>{p.queues[m]}</b>
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
