/* Layout-shift auditor. Drives the built app in Electron and, for every interactive
 * element, forces :hover / :hover:active and toggles the `on`/`primary` state classes,
 * asserting that NOTHING outside that element's own subtree moves.
 *
 *   npm run build && npx vite preview --port 4173      # in another shell
 *   npm run shiftaudit                                 # both themes
 *   DSIM_THEME=dark npm run shiftaudit                 # one theme
 *
 * Why it exists: the design system builds depth from HARD OFFSET SHADOWS and "thick"
 * keycap edges (`--ds-edge`, `--ds-block`). Those are easy to implement with a border
 * or margin that appears on hover, which reflows the page under the cursor. Every
 * pressable surface must instead move via `transform` + `box-shadow`, which don't
 * participate in layout. This catches the regression.
 *
 * It lived in a session scratchpad for two sessions and was twice presumed deleted.
 * It is a repo script now.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = process.env.DSIM_PORT || '4173';
const BASE = `http://localhost:${PORT}`;
// `system` is resolved in JS, so the audit forces an explicit theme (see src/theme.ts).
const THEMES = process.env.DSIM_THEME ? [process.env.DSIM_THEME] : ['light', 'dark'];
const OUT = process.env.DSIM_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'shiftaudit-'));
const LOG = path.join(OUT, 'shiftaudit.log');
fs.writeFileSync(LOG, '');
const log = (...a) => {
  const line = a.join(' ');
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
};

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { log('WATCHDOG'); process.exit(2); }, 600000);
process.on('unhandledRejection', (e) => { log('UNHANDLED REJECTION:', (e && e.stack) || e); process.exit(3); });
process.on('uncaughtException', (e) => { log('UNCAUGHT:', (e && e.stack) || e); process.exit(3); });

const ALL_PAGES = ['/', '/modes', '/configure/robot', '/configure/match', '/configure/controls',
               '/configure/audio', '/records', '/records/career', '/account', '/download'];
// DSIM_PAGES=/configure/robot,/records narrows a run to the routes you actually touched.
const PAGES = process.env.DSIM_PAGES
  ? process.env.DSIM_PAGES.split(',').map((p) => p.trim()).filter(Boolean)
  : ALL_PAGES;
// PAGE selectors — the controls that differ from route to route.
const SELECTORS = [
  '.ds-btn', '.ds-cta', '.ds-tile', '.ds-opt', '.ds-opt-add', '.ds-opt-del',
  '.ds-key', '.ds-seg', '.ds-tab', '.ds-menu-btn',
  '.ds-subnav-btn', '.ds-chip', '.ds-select', '.ds-input', 'input[type=range]',
];
// SHELL chrome — the rail, wordmark and footer are the SAME markup on all ten routes, so
// probing them per page was nine redundant passes. Probed once per theme instead.
const CHROME = ['.ds-rail-btn', '.ds-rail-home', '.ds-mark', '.ds-foot-link'];
const TOGGLE_CLASSES = [
  ['.ds-seg', 'on'], ['.ds-tab', 'on'], ['.ds-opt', 'on'], ['.ds-rail-btn', 'on'],
  ['.ds-subnav-btn', 'on'], ['.ds-key', 'on'], ['.ds-key', 'selected'],
  ['.ds-tile', 'primary'], ['.ds-btn', 'primary'], ['.ds-menu-btn', 'primary'],
];
// Regions whose CONTENT arrives from the server while the audit runs — the top bar's live
// queue/player counts. Their text width changes on its own schedule, and because the bar is
// right-aligned that nudges its siblings; the blame then lands on whichever element happened
// to be probed at that instant, which is why the reported culprit was different every run.
// It IS a reflow, but not a state-driven one, and this audit exists to police the latter:
// "does hovering/activating a control move anything outside itself".
// `.ds-qcount` is listed on its own as well as via the bar: the same counter also rides the
// left rail (`.ds-qcount.rail`), where its own width changes as the number ticks.
const LIVE = ['.ds-bar-right', '.ds-qcount'];
const FREEZE = `(() => { if (!document.getElementById('__freeze')) {
  const s = document.createElement('style'); s.id='__freeze';
  s.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}';
  document.head.appendChild(s);} return true; })()`;
const MAX_PER = 3;
const EPS = 0.5;
// settle after applying/clearing a forced state. Transitions are already frozen (FREEZE), so
// this only needs to outlast a paint — it was 60ms per read, i.e. ~2 min of pure sleeping
// across a full run.
const SETTLE = 25;

/**
 * ONE eval returns the rects AND the skip set, measured at the same instant.
 *
 * They used to be separate: subtree indices were computed ONCE per page and reused across
 * every probe. When the app re-rendered mid-run (version poll, stats, presence) the node
 * count changed, every index shifted, and the probed element fell out of its own skip set —
 * so it reported its own 1px hover `translate()` as a shift somewhere else. That is why the
 * same build audited 88, then 43, then 0. Resolving the skip against the very array being
 * diffed makes that impossible; a re-render between BASE and CUR is still caught by the
 * length guard in `diff`.
 *
 * `sel`/`i` name the element being probed; LIVE regions are folded in here too.
 */
const MEASURE = (sel, i) => `(() => {
  const all=[...document.querySelectorAll('*')];
  const o=new Array(all.length*4);
  for (let k=0;k<all.length;k++){const r=all[k].getBoundingClientRect();
    o[k*4]=r.x;o[k*4+1]=r.y;o[k*4+2]=r.width;o[k*4+3]=r.height;}
  o.push(document.documentElement.scrollHeight);
  const idx=new Map(all.map((e,n)=>[e,n]));
  const sub=(t)=> t ? [idx.get(t), ...[...t.querySelectorAll('*')].map(d=>idx.get(d))] : [];
  const skip=sub(document.querySelectorAll(${JSON.stringify(sel)})[${i}]);
  for (const el of document.querySelectorAll(${JSON.stringify(LIVE.join(','))})) skip.push(...sub(el));
  return {rects:o, skip};
})()`;
const TAGS = `[...document.querySelectorAll('*')].map(e=>e.tagName.toLowerCase()+
  (typeof e.className==='string'&&e.className.trim()?'.'+e.className.trim().split(/\\s+/).slice(0,2).join('.'):''))`;

function diff(base, cur, skip, tags) {
  const out = [];
  // The DOM CHANGED SHAPE between the two reads — a live re-render (version poll, stats
  // fetch, a flyout) added or removed nodes while we measured. Every index past that point
  // now names a DIFFERENT element in the two arrays, so rect-vs-rect comparison is garbage:
  // it used to read the LAST SHARED INDEX as the scrollHeight sentinel and report phantom
  // "document height 0 -> 815" lines on pages the change never touched. Nothing about a
  // pseudo-state can add nodes, so this is never a real shift — skip the sample.
  if (base.length !== cur.length) return out;
  const n = base.length - 1; // the scrollHeight sentinel RECTS appends
  if (Math.abs(base[n] - cur[n]) > EPS) out.push(`document height ${base[n]} -> ${cur[n]}`);
  for (let i = 0; i * 4 < n && out.length < 5; i++) {
    if (skip.has(i)) continue;
    for (let k = 0; k < 4; k++) {
      const a = base[i * 4 + k], b = cur[i * 4 + k];
      if (Math.abs(a - b) > EPS) {
        out.push(`${tags[i]}  ${'xywh'[k]}: ${a.toFixed(1)} -> ${b.toFixed(1)}`);
        break;
      }
    }
  }
  return out;
}

app.whenReady().then(async () => {
  log('boot · themes: ' + THEMES.join(', ') + ' · log: ' + LOG);
  const win = new BrowserWindow({ width: 1400, height: 900, show: true,
    webPreferences: { backgroundThrottling: false } });
  // Load a real document BEFORE attaching: on a blank target, DOM.enable never
  // resolves and the whole run silently hangs until the watchdog.
  await win.loadURL(BASE + '/');
  await sleep(1200);
  win.show();
  const dbg = win.webContents.debugger;
  try { dbg.attach('1.3'); log('debugger attached'); }
  catch (e) { log('ATTACH FAILED:', e.message); process.exit(3); }

  // every CDP call gets a deadline, so a hang is reported not swallowed
  const cmd = (method, params) => Promise.race([
    dbg.sendCommand(method, params),
    new Promise((_, rej) => setTimeout(() => rej(new Error('CDP timeout: ' + method)), 10000)),
  ]);
  await cmd('DOM.enable');
  await cmd('CSS.enable');
  log('CDP ready');
  const js = (s) => win.webContents.executeJavaScript(s);

  let checked = 0, problems = 0;

  const probePseudo = async (sel, nodeIds, tags) => {
    for (let i = 0; i < Math.min(nodeIds.length, MAX_PER); i++) {
      const M = MEASURE(sel, i);
      for (const pseudo of [['hover'], ['hover', 'active']]) {
        const base = await js(M);
        await cmd('CSS.forcePseudoState', { nodeId: nodeIds[i], forcedPseudoClasses: pseudo });
        await sleep(SETTLE);
        const cur = await js(M);
        await cmd('CSS.forcePseudoState', { nodeId: nodeIds[i], forcedPseudoClasses: [] });
        // SETTLE AFTER CLEARING. Pressable surfaces hover via `transform: translate(-1px,-1px)`
        // — correct, since transforms don't reflow — but getBoundingClientRect() REPORTS the
        // transform. Without this wait, the cleared transform is still applied when the NEXT
        // element's baseline is read, and its 1px snap-back gets blamed on that element.
        // (Cost me a false positive on `.ds-subnav-btn` that was really `.ds-opt`.)
        await sleep(SETTLE);
        checked++;
        const d = diff(base.rects, cur.rects, new Set(cur.skip), tags);
        if (d.length) {
          problems++;
          log(`  SHIFT ${sel}[${i}] :${pseudo.join(':')}`);
          d.forEach((x) => log(`          ${x}`));
        }
      }
    }
  };

  for (const theme of THEMES) {
    // stamped by the blocking inline script in index.html, so it must precede the load
    await js(`localStorage.setItem('decodesim.theme', ${JSON.stringify(theme)}); 'ok'`);
    log(`\n############################ THEME: ${theme.toUpperCase()}`);

    let chromeDone = false;
    for (const page of PAGES) {
      await win.loadURL(BASE + page);
      await sleep(1400);
      win.show();
      await js(FREEZE);          // transitions would bleed into the next probe
      await sleep(120);
      log(`\n##### [${theme}] ${page}`);
      const tags = await js(TAGS);
      const { root } = await cmd('DOM.getDocument', { depth: -1 });

      for (const sel of chromeDone ? SELECTORS : [...SELECTORS, ...CHROME]) {
        let nodeIds = [];
        try {
          nodeIds = (await cmd('DOM.querySelectorAll',
            { nodeId: root.nodeId, selector: sel })).nodeIds || [];
        } catch { continue; }
        if (!nodeIds.length) continue;
        await probePseudo(sel, nodeIds, tags);
      }
      chromeDone = true;

      for (const [sel, cls] of TOGGLE_CLASSES) {
        const n = await js(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
        if (!n) continue;
        for (let i = 0; i < Math.min(n, MAX_PER); i++) {
          const M = MEASURE(sel, i);
          const base = await js(M);
          const had = await js(`(()=>{const e=document.querySelectorAll(${JSON.stringify(sel)})[${i}];
            const h=e.classList.contains(${JSON.stringify(cls)});e.classList.toggle(${JSON.stringify(cls)});return h;})()`);
          await sleep(SETTLE);
          const cur = await js(M);
          await js(`document.querySelectorAll(${JSON.stringify(sel)})[${i}].classList.toggle(${JSON.stringify(cls)})`);
          await sleep(SETTLE); // settle before the next baseline — see probePseudo
          checked++;
          const d = diff(base.rects, cur.rects, new Set(cur.skip), tags);
          if (d.length) {
            problems++;
            log(`  SHIFT ${sel}[${i}] .${cls} ${had ? 'removed' : 'added'}`);
            d.forEach((x) => log(`          ${x}`));
          }
        }
      }
    }

    // ---- in-game HUD: the one surface not reachable by URL ----
    // Post-Phase-5 the console screens are plain <button>s, so match on TEXT rather than
    // the old `.ds-menu-btn` / `.ds-tile` classes, and click one per eval (React batches).
    await win.loadURL(BASE + '/');
    await sleep(1500);
    const clickText = async (txt) => js(`(() => {
      const b = [...document.querySelectorAll('button,a')]
        .find(e => e.textContent.replace(/\\s+/g,' ').includes(${JSON.stringify(txt)}));
      if (!b) return 'MISS';
      b.click(); return 'ok';
    })()`);
    if (await clickText('Play') === 'MISS') log('  (could not reach Play)');
    await sleep(900);
    if (await clickText('Free Drive') === 'MISS') log('  (could not reach Free Drive)');
    await sleep(3500);
    await js(FREEZE);
    await sleep(150);
    const inGame = await js(`!!document.querySelector('.game-canvas')`);
    log(`\n##### [${theme}] in-game HUD (free drive) canvas=${inGame}`);
    if (inGame) {
      const tags = await js(TAGS);
      const { root } = await cmd('DOM.getDocument', { depth: -1 });
      for (const sel of ['.game-btn', '.chip', '.hopper-pip', '.power-gauge']) {
        let nodeIds = [];
        try { nodeIds = (await cmd('DOM.querySelectorAll', { nodeId: root.nodeId, selector: sel })).nodeIds || []; }
        catch { continue; }
        if (!nodeIds.length) { log(`  (no ${sel})`); continue; }
        await probePseudo(sel, nodeIds, tags);
      }
    }
  }

  await js(`localStorage.removeItem('decodesim.theme'); 'ok'`);
  log(`\n===== ${checked} state changes checked · ${problems} caused layout shift =====`);
  dbg.detach();
  process.exit(problems === 0 ? 0 : 1);
});
app.on('window-all-closed', () => process.exit(0));
