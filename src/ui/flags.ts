/**
 * Build/runtime feature flags for things that are finished but not yet trusted.
 *
 * `VITE_BG_QUEUE=1` flips it for a whole deploy; the localStorage key flips it for
 * ONE browser without shipping anything, which is what makes a live test possible
 * before committing every player to it.
 */

/** read a per-browser override without throwing in private mode / SSR */
function localFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

/**
 * BACKGROUND RANKED QUEUE — the queue keeps running while you browse or play, and
 * takes the screen back when a match is found.
 *
 * OFF BY DEFAULT and deliberately so: this is the ranked path, a dropped queue
 * socket reads to the other player as a forfeit, and the flow cannot be exercised
 * without two signed-in accounts actually completing a rated match. Everything
 * here typechecks and is unit-tested, but "it compiles" is not the bar for
 * something that costs strangers ELO. Turn it on in one browser
 * (`localStorage['dsim.flag.bgQueue'] = '1'`), play a real ranked match end to
 * end, and only then set `VITE_BG_QUEUE=1` for everyone.
 */
export function backgroundQueueEnabled(): boolean {
  return import.meta.env.VITE_BG_QUEUE === '1' || localFlag('dsim.flag.bgQueue');
}
