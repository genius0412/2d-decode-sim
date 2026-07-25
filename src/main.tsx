import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { ServerNoticeBanner } from './ui/ServerNoticeBanner';
import { NoticePoller } from './ui/NoticePoller';
import { initPhysics } from './sim/physicsEngine';
import { initTheme } from './theme';
import { AdsProvider } from './ads/AdsProvider';
import { Analytics } from '@vercel/analytics/react';
import { analyticsEnabled } from './analytics';
// Self-hosted (not a CDN <link>): the Electron build runs from file:// with
// vite `base: './'`, so fingerprinted woff2 must be bundled to resolve offline.
// Variable cuts, because shell.css asks for weights off the 100 grid (750).
import '@fontsource-variable/plus-jakarta-sans';
import '@fontsource-variable/space-grotesk';
import './ui/styles.css';
import './ui/shell.css';

// The inline script in index.html already stamped data-theme for the first paint.
// This re-stamps from the same key and, when the pref is 'system', arms the
// prefers-color-scheme listener so an OS switch is picked up live.
initTheme();

// Init the Rapier physics WASM (shared src/sim) before the first sim step. It
// inlines its WASM as base64 (no separate asset), so this is a fast local
// decode — block the initial render on it so no GameController steps early.
initPhysics().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {/* Wraps everything because the game screen renders OUTSIDE the app shell
          (App returns it early), and that is where the ad columns live. */}
      <AdsProvider>
        <App />
      </AdsProvider>
      <ServerNoticeBanner />
      <NoticePoller />
      {/* Cookieless page views. Gated on VITE_ANALYTICS so a self-hosted or
          Electron build never beacons a host it does not run on. */}
      {analyticsEnabled() && <Analytics />}
    </StrictMode>,
  );
});
