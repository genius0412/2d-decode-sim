import type { Presence } from '../net/api';

/** the maintenance window as the presence poll reports it */
export type MaintenanceInfo = NonNullable<Presence['maintenance']>;

/**
 * A short human window: "21:00 – 21:40", "until 21:40", "from 21:00".
 *
 * Local time, deliberately — a player reading "maintenance at 02:00 UTC" has to do
 * arithmetic to find out whether that affects them tonight, and most won't.
 */
export function windowLabel(m: MaintenanceInfo): string {
  const t = (ms: number): string =>
    new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (m.startsAt && m.endsAt) return `${t(m.startsAt)} – ${t(m.endsAt)}`;
  if (m.endsAt) return `until ${t(m.endsAt)}`;
  if (m.startsAt) return `from ${t(m.startsAt)}`;
  return '';
}

/**
 * What the banner SAYS, given the window and the clock.
 *
 * Three states, because they call for three different things from the reader:
 *  - BITING: it is happening now, nothing will start, wait.
 *  - SCHEDULED: it is coming; keep playing, but don't start something long.
 *  - none: render nothing.
 *
 * Pure so the wording can be tested — this is copy people act on, and it is shown
 * on screens that are otherwise mid-game.
 */
export function maintenanceLine(m: MaintenanceInfo | null | undefined, now = Date.now()): string | null {
  if (!m) return null;
  const win = windowLabel(m);
  const base = m.message?.trim();
  if (m.biting) {
    return `${base || 'Maintenance in progress'} — new games are paused${win ? ` (${win})` : ''}.`;
  }
  if (m.startsAt && m.startsAt > now) {
    const mins = Math.max(1, Math.round((m.startsAt - now) / 60000));
    return `${base || 'Scheduled maintenance'} — starting in ${mins} minute${mins === 1 ? '' : 's'}${
      win ? ` (${win})` : ''
    }. New games will be paused.`;
  }
  return null;
}

/**
 * The standing maintenance banner.
 *
 * Rendered from the presence poll rather than the WebSocket, so it also reaches the
 * screens that hold no socket at all — Home, the solo menus — which are exactly
 * where somebody is standing when they are about to start the thing we need them
 * not to start.
 */
export function MaintenanceBanner({ presence }: { presence: Presence | null }) {
  const line = maintenanceLine(presence?.maintenance ?? null);
  if (!line) return null;
  const biting = presence?.maintenance?.biting ?? false;
  // The WRAPPER carries the shell's own 22px side inset (`.ds-bar`, `.ds-main`
  // and `.ds-foot` all use it). The banner is a direct child of `.ds-app`, so
  // without it the strip sat 8px outboard of the brand mark above it and the page
  // heading below it. It is inside this component rather than around the call
  // site so that nothing is rendered at all when there is no maintenance window.
  return (
    <div className="ds-maint-wrap">
      <div className={`ds-maint${biting ? ' biting' : ''}`} role="status">
        <span aria-hidden>{biting ? '⛔' : '🛠'}</span>
        <span>{line}</span>
      </div>
    </div>
  );
}
