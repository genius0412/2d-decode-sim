---
name: verify
description: Drive the built DECODE sim GUI via Electron and capture screenshots — use to verify UI/game changes at the real surface (menu, HUD, in-game input).
---

# Verifying this app end-to-end

Two surfaces:

1. **Sim core** (`src/sim/`, `src/config.ts`): `npm test` (scripts/smoke.ts) IS the
   runtime surface — it drives full worlds headlessly. Add a check per behavior change.
2. **GUI** (menu, HUD, input, audio wiring): drive the real app via Electron.

## Electron GUI drive recipe (no Playwright needed)

- **`ELECTRON=1 npm run build` — NOT a bare `npm run build`.** `vite.config.ts` sets
  `base: '/'` by default (the web build); under `file://` that makes the bundle's
  `/assets/index-*.js` resolve to the filesystem root and 404 **silently** — no console
  error, no failed-load event, just a permanently blank white window (`#root` stays
  empty forever). `ELECTRON=1` switches to a relative `./` base, matching what `npm run
  dist`/`npm run electron` already do. If a screenshot comes back blank, check this
  BEFORE assuming the app broke — `document.body.innerHTML.length` staying tiny (~30
  chars, just the empty `<div id="root">`) confirms it's this, not your change.
- Electron loads `dist/index.html` (see `electron/main.cjs`).
- Write a driver script (CJS) in the scratchpad and run `npx electron <script>`.
- **Gotchas (Windows, this machine):**
  - Agent shells export `ELECTRON_RUN_AS_NODE=1`, which makes a bare `npx electron
    script.cjs` run the script as plain Node — `app`/`BrowserWindow` are `undefined`.
    Unset it for the invocation: `env -u ELECTRON_RUN_AS_NODE npx electron script.cjs`.
  - `electron` must resolve `require('electron')` from a real `node_modules` — a driver
    script living outside the repo (e.g. the session scratchpad) fails with
    `Cannot find module 'electron'`. Put the script inside the project directory
    (delete it when done) rather than the scratchpad.
  - `capturePage()` throws `UnknownVizError` unless you call
    `app.disableHardwareAcceleration()` AND
    `app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')`,
    and `win.show(); win.focus();` before capturing.
  - Set `webPreferences: { backgroundThrottling: false }` or rAF (the game loop) stalls.
  - React: never `.click()` two buttons in one `executeJavaScript` call — the second
    handler sees stale props (state batching). One click per call, ~120 ms apart.
- Drive with `executeJavaScript`: `element.click()` works on React buttons;
  `window.dispatchEvent(new KeyboardEvent('keydown', {key:'j', bubbles:true}))`
  reaches both the menu capture listeners and the in-game `Keyboard` class
  (send a matching `keyup` to release held keys).
- Observe via DOM: hopper pips `.hopper-pip` (class `empty`), HUD chips `.chip`
  (text REVERSED / GATE OPEN), keycaps `.keycap`, and
  `localStorage['decodesim.settings.v1']` for persistence.
- Clean up: `localStorage.removeItem('decodesim.settings.v1')` at the end so the
  run doesn't leave test bindings on the user's machine.

Working example from a past session: rebind fire→J, check steal/UNBOUND, reload for
persistence, ENTER FIELD in Free Drive + Robot-centric, hold J to fire (pips empty),
press F for the REVERSED chip.
