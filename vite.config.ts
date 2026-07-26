import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';

// a stable build id (git sha, timestamp fallback) baked into the client AND emitted
// to /version.json, so a running client can detect that a newer build has deployed.
const BUILD_ID = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return String(Date.now());
  }
})();

// The desktop (Electron) build gets NO Vercel env injection, so without this the
// bundled offline-fallback bundle would ship with multiplayer + accounts disabled
// (`VITE_GAME_SERVERS`/`VITE_NEON_AUTH_URL` absent → SERVERS=[] → the Multiplayer
// menu is hidden). Bake the PUBLIC client config into the Electron build only
// (`ELECTRON=1`). These EXACT values already ship in the deployed web bundle —
// nothing secret (server DB/auth secrets are never VITE_-prefixed). The web build
// (ELECTRON unset) is untouched: it still reads these from Vercel's env, and an
// explicitly-set env var wins here too (Vite: process.env VITE_* overrides), so a
// local `ELECTRON=1` build can still point at localhost by exporting its own.
if (process.env.ELECTRON === '1') {
  process.env.VITE_GAME_SERVERS ??=
    '[{"id":"iad","label":"US East","region":"iad","url":"wss://dohun-sim-decode.fly.dev"},' +
    '{"id":"sjc","label":"US West","region":"sjc","url":"wss://dohun-sim-decode.fly.dev"},' +
    '{"id":"lhr","label":"Europe","region":"lhr","url":"wss://dohun-sim-decode.fly.dev"},' +
    '{"id":"syd","label":"Oceania","region":"syd","url":"wss://dohun-sim-decode.fly.dev"},' +
    '{"id":"nrt","label":"Asia","region":"nrt","url":"wss://dohun-sim-decode.fly.dev"}]';
  process.env.VITE_NEON_AUTH_URL ??=
    'https://ep-lingering-pine-ahq640vd.neonauth.c-3.us-east-1.aws.neon.tech/neondb/auth';
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'emit-version-json',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'version.json',
          source: JSON.stringify({ build: BUILD_ID }),
        });
      },
    },
  ],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  // Absolute base for the WEB build so path-based routes (/leaderboard, /replay/…)
  // still resolve assets on a deep load / refresh (paired with the vercel.json SPA
  // rewrite). The Electron desktop build sets ELECTRON=1 (see the `dist` script) to
  // keep the relative base needed under file:// — it routes by state, not URL.
  base: process.env.ELECTRON === '1' ? './' : '/',
});
