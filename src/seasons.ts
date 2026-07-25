/**
 * App branding + the SEASON registry.
 *
 * The product is **DohunSim** — a 2D FTC driver-practice simulator. Each FTC
 * game is a "season". Right now only DECODE (2025–26) is playable; the sim's
 * geometry/scoring in `src/config.ts` + `src/sim/` are DECODE-specific. This
 * module is the seam for adding future seasons: register another `Season` here,
 * flip `playable: true` once its rules land, and the UI (season badge/picker)
 * picks it up automatically. Keep the APP name ("DohunSim") separate from the
 * SEASON name ("DECODE") everywhere in the UI — the brand is the app, DECODE is
 * just the game currently loaded.
 */

export const APP_NAME = 'DSIM';
export const APP_TAGLINE = '2D Driver Practice';
/** One plain sentence saying what this is. Shown on the home menu and reused as
 * the first sentence of the meta description (`src/seo.ts`) — so it is also the
 * line that shows up in a search result and a pasted-link preview. The static
 * copy in `index.html` and the web manifest repeat it verbatim (they ship before
 * any JS runs); keep all three in step, and keep it a description, not a pitch. */
export const APP_BLURB = 'An online 2D driving simulator for FIRST Tech Challenge.';

/** external links surfaced in the footer / download page */
export const LINKS = {
  repo: 'https://github.com/genius0412/dsim',
  discord: 'https://discord.gg/YB4tXnx7Pj',
} as const;

import type { GameId } from './games/types';

export interface Season {
  /** stable key (used for future save bucketing / URLs) — matches a `GameId` */
  key: GameId;
  /** short game name, e.g. "DECODE" */
  name: string;
  /** full presenting name, e.g. "DECODE presented by RTX" */
  fullName: string;
  /** competition program */
  program: string;
  /** playing years, e.g. "2025–26" */
  years: string;
  /** one-line description of the game */
  blurb: string;
  /** false ⇒ shown in the picker as "coming soon", not selectable */
  playable: boolean;
}

export const SEASONS: readonly Season[] = [
  {
    key: 'decode',
    name: 'DECODE',
    fullName: 'DECODE presented by RTX',
    program: 'FIRST Tech Challenge',
    years: '2025–26',
    blurb: 'Classify artifacts into cross-court goals, match the motif, park on base.',
    playable: true,
  },
  {
    key: 'chain',
    name: 'Chain Reaction',
    fullName: 'Chain Reaction',
    program: 'Unofficial FTC · CAD Competition',
    years: '2026',
    blurb: 'The 2026 Unofficial FTC CAD-competition game - a new shooter (rules to come).',
    playable: true,
  },
] as const;

/** the season the sim is currently built for (the first playable game) */
export const CURRENT_SEASON: Season =
  SEASONS.find((s) => s.playable) ?? SEASONS[0];

/** the season record for a game id (defaults to the first entry, DECODE). */
export function seasonFor(game: GameId): Season {
  return SEASONS.find((s) => s.key === game) ?? SEASONS[0];
}

/**
 * Canonical label for a competitive PERIOD (a leaderboard/records bucket).
 *
 * Periods form an Act → Season hierarchy: multiple seasons per act, both
 * 1-indexed, plus a historical **Act 0** for the beta / pre-season. The label is
 * the admin's custom title when set, else the structured "Act X · Season Y"
 * coordinate. Used by the leaderboard badge/picker and the career panel so every
 * surface names a period identically.
 */
export function periodLabel(p: { name?: string | null; act: number; seasonNo: number }): string {
  const custom = p.name?.trim();
  if (custom) return custom;
  return `Act ${p.act} · Season ${p.seasonNo}`;
}
