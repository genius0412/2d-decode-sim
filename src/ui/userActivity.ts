/**
 * "Is a human actually here?" — shared by every polling hook on the page.
 *
 * The hooks already skip a HIDDEN tab, which covers minimised windows and
 * background tabs. This covers the case that rule misses: a tab that is visible
 * and abandoned. DSIM left open on a second monitor is `visible` by every check
 * the browser offers, so it kept polling every 20s forever.
 *
 * That mattered more than it sounds. Neon suspends the database only after five
 * consecutive minutes with NO queries, and bills for every hour it stays awake —
 * so one forgotten tab anywhere in the world held the compute open indefinitely,
 * however cheap each individual poll became. This is the last always-on query
 * source on the site.
 *
 * The threshold ADDS to Neon's own five-minute timer: five minutes idle here
 * means polling stops at five minutes and the compute can suspend at about ten.
 *
 * `pointermove` counts, so anyone actually at their desk resets this constantly;
 * five minutes of literally no mouse movement, keystroke or touch means genuinely
 * away, not "reading carefully".
 *
 * TRADE-OFF, deliberately accepted: the friends poll doubles as the caller's
 * presence heartbeat (there is no separate ping), so going quiet ages the caller
 * out of the server's 45s online window and friends see them drop offline. That
 * is truer than showing someone as present because a tab is open, and it is what
 * every chat app does with idle status — but it IS a visible behaviour change.
 */

/** no input for this long ⇒ treat the page as unattended */
export const IDLE_AFTER_MS = 5 * 60_000;

/** cheap, passive, and capture-phase so a stopPropagation deeper in the tree
 * can't blind us to a real interaction */
const EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;
const OPTS: AddEventListenerOptions = { passive: true, capture: true };

let lastInput = Date.now();
const wakers = new Set<() => void>();

function note(): void {
  const wasIdle = Date.now() - lastInput >= IDLE_AFTER_MS;
  lastInput = Date.now();
  // Only the idle→active EDGE notifies. Firing on every pointermove would turn a
  // mouse twitch into a request storm; the timestamp update above is the cheap
  // part that runs constantly.
  if (wasIdle) for (const w of wakers) w();
}

if (typeof window !== 'undefined') {
  for (const e of EVENTS) window.addEventListener(e, note, OPTS);
  // returning to the tab is itself a sign of presence, and the polling hooks
  // already re-tick on these — keeping the timestamp in step stops a hook from
  // waking only to immediately class the page as idle again.
  window.addEventListener('focus', note);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') note();
  });
}

/** has the page gone unattended? Hidden tabs count as idle immediately — nobody
 * is reading a tab they cannot see, and the hooks check this before fetching. */
export function userIdle(): boolean {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return true;
  return Date.now() - lastInput >= IDLE_AFTER_MS;
}

/** run `cb` when the user comes back after being idle. Returns an unsubscribe. */
export function onUserActive(cb: () => void): () => void {
  wakers.add(cb);
  return () => wakers.delete(cb);
}
