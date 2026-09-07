/**
 * Game-server config, read from Vite env (baked in at build time on Vercel + in
 * the Electron build). When absent, the Multiplayer entry is hidden and the solo
 * game is completely unaffected — there is no runtime network dependency.
 *
 * MULTI-SERVER: the app supports a LIST of game servers (regions) so a player can
 * pick the closest one (a pre-connection ping picker) for a record run or a
 * match. Configure with `VITE_GAME_SERVERS` — a JSON array of
 * `{ id, label, region, url }`. For back-compat, a single `VITE_GAME_SERVER_URL`
 * still works and becomes a one-entry list. The SELECTED server (module state,
 * restored from the account preference) is what every connect site uses via
 * `gameServerUrl()` / `gameServerHttpUrl()`.
 */

export interface GameServer {
  /** stable id used to persist the player's preference */
  id: string;
  /** human label for the picker (defaults to region/url) */
  label: string;
  /** region code, e.g. 'iad', 'lhr' — '' if single/unknown */
  region: string;
  /** ws:// or wss:// base URL of the server */
  url: string;
}

function parseServers(): GameServer[] {
  const raw = import.meta.env.VITE_GAME_SERVERS as string | undefined;
  if (raw) {
    try {
      const arr = JSON.parse(raw) as Partial<GameServer>[];
      const clean = arr
        .filter((s): s is Partial<GameServer> => !!s && typeof s.url === 'string' && !!s.url)
        .map((s, i) => ({
          id: s.id || `srv${i}`,
          label: s.label || s.region || (s.url as string),
          region: s.region || '',
          url: s.url as string,
        }));
      if (clean.length) return clean;
    } catch {
      /* malformed JSON → fall back to the single-URL var */
    }
  }
  const single = import.meta.env.VITE_GAME_SERVER_URL as string | undefined;
  if (single) return [{ id: 'default', label: 'Default', region: '', url: single }];
  return [];
}

const SERVERS = parseServers();
let selectedId = SERVERS[0]?.id ?? '';

/**
 * RELEASE CHANNEL of THIS client build (baked from `VITE_APP_CHANNEL`; default
 * 'stable'). The pre-release 'alpha' deployment sets it to 'alpha'. The server
 * uses it to (a) matchmake alpha players SEPARATELY from stable ones — they run
 * a different `src/sim`, so mixing them in one authoritative match would desync —
 * and (b) NOT persist alpha results to the leaderboard/ELO DB (in-development
 * scores stay off the boards). Sent to the server on join/queue; absent ⇒
 * 'stable' (older builds + the stable deployment). */
export const appChannel = (): string =>
  (import.meta.env.VITE_APP_CHANNEL as string | undefined)?.trim() || 'stable';

/** THIS client's build id — the git sha baked in by vite (`__BUILD_ID__`; the same
 * value `/version.json` carries). Sent to the server on `queue` so the matchmaker
 * segregates the pool by build (two different builds never share an authoritative
 * match — the "same code" invariant behind the version gate). 'dev' when unbuilt.
 * Declared here (not imported from `version.ts`, which pulls in React) so pure net
 * modules can read it. */
declare const __BUILD_ID__: string;
export const appBuild = (): string =>
  typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev';

/** friendly short names for the Fly deploy regions (code → place). Unknown codes
 * fall back to their uppercase code so a new region still shows something sane. */
const REGION_LABELS: Record<string, string> = {
  iad: 'US East',
  ord: 'US Central',
  sjc: 'US West',
  lhr: 'Europe',
  gru: 'South America',
  jnb: 'Africa',
  syd: 'Australia',
  nrt: 'Asia',
};
export const regionLabel = (code: string): string =>
  REGION_LABELS[code] ?? (code ? code.toUpperCase() : '');

/** whether `code` is a known deploy region (used to tell a region-coded room code
 * like `iad-abc` from an ordinary custom room code). */
export const isKnownRegion = (code: string): boolean => code in REGION_LABELS;

/** all configured servers (regions); empty ⇒ multiplayer/records disabled */
export const gameServers = (): GameServer[] => SERVERS;

export const gameServerConfigured = (): boolean => SERVERS.length > 0;

/** whether the player actually has a CHOICE of server (≥2 configured) */
export const multiServer = (): boolean => SERVERS.length > 1;

export const selectedServer = (): GameServer | undefined =>
  SERVERS.find((s) => s.id === selectedId) ?? SERVERS[0];

export const selectedServerId = (): string => selectedServer()?.id ?? '';

/** choose the active server (by id). No-ops on an unknown id. */
export function setSelectedServer(id: string): void {
  if (SERVERS.some((s) => s.id === id)) selectedId = id;
}

export const gameServerUrl = (): string => selectedServer()?.url ?? '';

/**
 * The game-server WS URL with a fly-replay routing HINT in the query string (one
 * app, many regions). The server's upgrade interceptor reads these to route the
 * connection to the right machine:
 *   - `{ mm: '1' }`            → the designated matchmaker region (ranked queueing)
 *   - `{ room: 'iad-abc123' }` → the room's host region (region-coded code)
 *   - `{ region: 'lhr' }`      → an explicit region pick (manual "play elsewhere")
 * On a single-region deploy the hints are harmless (the one machine accepts them).
 */
export function gameServerUrlWith(params: Record<string, string>): string {
  const base = gameServerUrl();
  if (!base) return base;
  const qs = new URLSearchParams(params).toString();
  return qs ? `${base}?${qs}` : base;
}

/** the selected server over HTTP(S) for the read APIs (leaderboards, replays,
 * health/ping): ws://→http://, wss://→https:// */
export const gameServerHttpUrl = (): string => httpOf(selectedServer()?.url);

/** ws(s):// → http(s):// for any server's url */
export const httpOf = (wsUrl: string | undefined): string =>
  wsUrl ? wsUrl.replace(/^ws/, 'http') : '';

/**
 * Is the supporter tier OPEN for business?
 *
 * OFF by default, and it gates the Support page AND its footer link. The tier's
 * code is complete, but a page cannot go live before the Ko-fi page and the
 * server's KOFI_VERIFICATION_TOKEN both exist: the "Support on Ko-fi" button
 * would lead somewhere that cannot take a payment, and the claim box would fail
 * on every submission. That is a dead end for a visitor and, more concretely, a
 * broken purchase path is a cited AdSense rejection reason - which matters a
 * great deal on the exact deploy whose purpose is passing that review.
 *
 * Lives HERE, not in `seasons.ts`: the server compiles that file too, and
 * `import.meta.env` does not exist outside the Vite build.
 *
 * Flip `VITE_SUPPORT_ENABLED=1` once Ko-fi is connected and the Fly secret is
 * set. Nothing else needs to change; the routes stay reachable by direct URL for
 * testing, only the navigation and the page body are gated.
 */
export const SUPPORT_ENABLED =
  (import.meta.env.VITE_SUPPORT_ENABLED as string | undefined)?.trim() === '1';
