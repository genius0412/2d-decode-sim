/**
 * The Contributors page's roster.
 *
 * This is HAND-MAINTAINED, and deliberately so: none of it is derivable from the
 * account system. Auth is Neon Auth only — there is no Discord OAuth anywhere in
 * this codebase, so a Discord avatar or profile link can't be looked up, and a
 * contributor's game account (if they even have one) isn't linked to their GitHub
 * handle either. Keep it in step with `CONTRIBUTORS.md`, which is the CLA record;
 * this file is only what the page renders.
 *
 * EVERY field except `fallbackName` is optional, and the card degrades cleanly
 * without each one — a contributor with no game account, no Discord, or no avatar
 * still renders. That matters because the page must also work when the game server
 * is unreachable (a cold Fly machine, or a Vercel preview with no
 * `VITE_GAME_SERVER_URL`), where NO live handle resolves for anyone.
 */
export interface Contributor {
  /** Shown until (or instead of) a live game handle resolves. Required — it is the
   * only thing standing between a cold server and a page of blank cards. */
  fallbackName: string;
  /** Short role/credit line, e.g. "Project owner". */
  role?: string;
  /** In-game username (the `/profile/<username>` slug). Drives the LIVE display
   * name and the profile link. Omit for contributors with no game account: the
   * card then shows `fallbackName` and isn't clickable. */
  inGameUsername?: string;
  /** Full Discord CDN avatar URL. Omit to render initials instead. */
  discordAvatarUrl?: string;
  /** Discord profile link (`https://discord.com/users/<id>`). */
  discordUrl?: string;
  /** GitHub profile link. */
  githubUrl?: string;
}

/**
 * TODO(fill in): `discordAvatarUrl`, `discordUrl`, and `inGameUsername` have to be
 * collected from each contributor — they aren't recorded anywhere in the repo. The
 * names and GitHub handles below come straight from `CONTRIBUTORS.md`. Cards render
 * correctly with the fields still missing, so this list can be completed one person
 * at a time without breaking the page.
 */
export const CONTRIBUTORS: Contributor[] = [
  {
    fallbackName: 'Dohun Kim',
    role: 'Project owner',
    inGameUsername: 'ace',
    githubUrl: 'https://github.com/genius0412',
  },
  {
    fallbackName: 'Felix D',
    inGameUsername: 'felix',
    githubUrl: 'https://github.com/crescent',
  },
  {
    fallbackName: 'Baron',
    inGameUsername: 'Baron',
    githubUrl: 'https://github.com/BaronClaps',
  },
  {
    fallbackName: 'therealkingcob',
    githubUrl: 'https://github.com/therealkingcob',
  },
  {
    fallbackName: 'Shaan Sridhara',
  },
];
