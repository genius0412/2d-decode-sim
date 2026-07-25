/**
 * Per-route document metadata (title / description / canonical / og:url).
 *
 * `index.html` carries the HOMEPAGE values statically — that file is all a
 * social scraper or a non-rendering crawler ever sees, so it has to describe
 * the home route on its own. This module keeps those same tags correct once
 * React is up, for the crawlers that DO render (Googlebot) and for the browser
 * tab. The home entry below must stay in sync with the static tags in
 * `index.html`; everything else only exists here.
 *
 * Canonical URLs matter more than usual here: `/`, `/decode` and any legacy
 * unprefixed path (`/leaderboard`, `/my-robot`, …) all resolve to the same
 * screen, and the router rewrites the address bar on load. Without an explicit
 * canonical, search engines would see several URLs serving one page.
 */

import type { GameId } from './games/types';
import { APP_BLURB, seasonFor } from './seasons';

/** the deployed origin — canonical/og:url must be absolute for scrapers */
export const SITE_URL = 'https://www.playdsim.com';

const HOME_TITLE = 'DSIM — Online 2D FTC Driving Simulator';
// the on-page sentence plus what you can do here. Descriptions are what shows
// under the link in a search result — say what the page IS, don't sell it.
const HOME_DESC = `${APP_BLURB} Build a robot, drive DECODE or Chain Reaction, and play solo or ranked.`;

/** title + description for a route, keyed by the App's `Screen` union. */
interface RouteMeta {
  /** full <title>; the home route is the bare brand title (no ` · DSIM` suffix) */
  title: string;
  description: string;
}

const ROUTE_META: Record<string, RouteMeta> = {
  home: { title: HOME_TITLE, description: HOME_DESC },
  modes: {
    title: 'Game modes',
    description:
      'Free drive, solo match, record runs, ranked 1v1 and 2v2, custom rooms and spectating.',
  },
  configure: {
    title: 'Configure your robot',
    description:
      'Set drivetrain, mass, motor RPM, flywheel inertia, intake and starting position, and rebind your controls.',
  },
  records: {
    title: 'Leaderboards & records',
    description:
      'DSIM leaderboards, personal bests, world records and career stats, by mode and drivetrain.',
  },
  download: {
    title: 'Download the desktop app',
    description: 'DSIM for Windows, macOS and Linux.',
  },
  contributors: {
    title: 'Contributors',
    description: 'The people who build DSIM.',
  },
  changelogs: {
    title: 'Changelog',
    description: 'Patch notes and release history for DSIM.',
  },
  profile: {
    title: 'Player profile',
    description: 'A DSIM player’s rating, records and recent matches.',
  },
};

/** upsert a <meta> by name= or property= (they are distinct attributes) */
function setMeta(attr: 'name' | 'property', key: string, value: string): void {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', value);
}

/** upsert <link rel="canonical"> */
function setCanonical(url: string): void {
  let el = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!el) {
    el = document.createElement('link');
    el.rel = 'canonical';
    document.head.appendChild(el);
  }
  el.href = url;
}

/**
 * Point title / description / canonical / og:url at the current route.
 *
 * `path` is the router's canonical path for the screen (always game-prefixed).
 * The HOME route canonicalizes to the bare origin instead: `/`, `/decode` and
 * the legacy unprefixed paths are one page, and `/` is the one we want indexed.
 * Non-DECODE homes keep their own prefix (`/chain` is a different landing).
 */
export function applyRouteMeta(screen: string, path: string, game: GameId): void {
  if (typeof document === 'undefined') return;
  const season = seasonFor(game).name;
  const meta = ROUTE_META[screen];
  // screens with no entry (live game, lobby, queue, replay, account, admin) are
  // transient app surfaces — robots.txt keeps them out of the index; just keep
  // the tab honest and leave the home description in place.
  //
  // The selected game stays in the title on every screen but DECODE's home, so
  // the two games keep reading as separate apps (the tab title always named the
  // game before this module existed) without burying the brand on the one page
  // search engines actually rank.
  const title = !meta
    ? `${season} · DSIM`
    : screen === 'home'
      ? game === 'decode'
        ? meta.title
        : `${season} · ${meta.title}`
      : `${meta.title} · ${season} · DSIM`;
  document.title = title;
  if (meta) {
    const description =
      screen === 'home' && game !== 'decode'
        ? `${seasonFor(game).blurb} Drive it in DSIM, ${APP_BLURB[0].toLowerCase()}${APP_BLURB.slice(1, -1)}.`
        : meta.description;
    setMeta('name', 'description', description);
    setMeta('property', 'og:description', description);
    setMeta('name', 'twitter:description', description);
    setMeta('property', 'og:title', title);
    setMeta('name', 'twitter:title', title);
  }

  const canonicalPath = screen === 'home' && game === 'decode' ? '/' : path;
  const url = SITE_URL + canonicalPath;
  setCanonical(url);
  setMeta('property', 'og:url', url);
}
