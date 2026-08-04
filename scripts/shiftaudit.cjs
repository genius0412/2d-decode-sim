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

const PAGES = ['/', '/modes', '/configure/robot', '/configure/match', '/configure/controls',
               '/configure/audio', '/records', '/records/career', '/account', '/download'];
const SELECTORS = [
  '.ds-btn', '.ds-cta', '.ds-tile', '.ds-opt', '.ds-opt-add', '.ds-opt-del',
  '.ds-key', '.ds-seg', '.ds-tab', '.ds-menu-btn', '.ds-rail-btn', '.ds-rail-home',
  '.ds-subnav-btn', '.ds-chip', '.ds-select', '.ds-input', 'input[type=range]',
  '.ds-mark', '.ds-foot-link',
];
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
const MAX_PER = 6;
const EPS = 0.5;

// flat [x,y,w,h, ...] for every element, in document order
const RECTS = `(() => { const a=[...document.querySelectorAll('*')]; const o=new Array(a.length*4);
  for (let i=0;i<a.length;i++){const r=a[i].getBoundingClientRect();
    o[i*4]=r.x;o[i*4+1]=r.y;o[i*4+2]=r.width;o[i*4+3]=r.height;}
  o.push(document.documentElement.scrollHeight); return o; })()`;
const TAGS = `[...document.querySelectorAll('*')].map(e=>e.tagName.toLowerCase()+
  (typeof e.className==='string'&&e.className.trim()?'.'+e.className.trim().split(/\\s+/).slice(0,2).join('.'):''))`;
// for each match of `sel`, the set of document-order indices in its subtree
const SUBTREES = (sel) => `(() => { const all=[...document.querySelectorAll('*')];
  const idx=new Map(all.map((e,i)=>[e,i]));
  return [...document.querySelectorAll(${JSON.stringify(sel)})].map(t =>
    [idx.get(t), ...[...t.querySelectorAll('*')].map(d=>idx.get(d))]); })()`;

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
  // document-order indices of the live-data regions on the CURRENT page (see LIVE), refreshed
  // per page load and unioned into every probe's skip set
  let liveSkip = new Set();

  const probePseudo = async (sel, nodeIds, subs, tags) => {
    for (let i = 0; i < Math.min(nodeIds.length, MAX_PER); i++) {
      const skip = new Set([...(subs[i] || []), ...liveSkip]);
      for (const pseudo of [['hover'], ['hover', 'active']]) {
        const base = await js(RECTS);
        await cmd('CSS.forcePseudoState', { nodeId: nodeIds[i], forcedPseudoClasses: pseudo });
        await sleep(60);
        const cur = await js(RECTS);
        await cmd('CSS.forcePseudoState', { nodeId: nodeIds[i], forcedPseudoClasses: [] });
        // SETTLE AFTER CLEARING. Pressable surfaces hover via `transform: translate(-1px,-1px)`
        // — correct, since transforms don't reflow — but getBoundingClientRect() REPORTS the
        // transform. Without this wait, the cleared transform is still applied when the NEXT
        // element's baseline is read, and its 1px snap-back gets blamed on that element.
        // (Cost me a false positive on `.ds-subnav-btn` that was really `.ds-opt`.)
        await sleep(60);
        checked++;
        const d = diff(base, cur, skip, tags);
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

    for (const page of PAGES) {
      await win.loadURL(BASE + page);
      await sleep(1400);
      win.show();
      await js(FREEZE);          // transitions would bleed into the next probe
      await sleep(120);
      log(`\n##### [${theme}] ${page}`);
      liveSkip = new Set((await js(SUBTREES(LIVE.join(',')))).flat());
      const tags = await js(TAGS);
      const { root } = await cmd('DOM.getDocument', { depth: -1 });

      for (const sel of SELECTORS) {
        let nodeIds = [];
        try {
          nodeIds = (await cmd('DOM.querySelectorAll',
            { nodeId: root.nodeId, selector: sel })).nodeIds || [];
        } catch { continue; }
        if (!nodeIds.length) continue;
        await probePseudo(sel, nodeIds, await js(SUBTREES(sel)), tags);
      }

      for (const [sel, cls] of TOGGLE_CLASSES) {
        const n = await js(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
        if (!n) continue;
        const subs = await js(SUBTREES(sel));
        for (let i = 0; i < Math.min(n, MAX_PER); i++) {
          const skip = new Set([...(subs[i] || []), ...liveSkip]);
          const base = await js(RECTS);
          const had = await js(`(()=>{const e=document.querySelectorAll(${JSON.stringify(sel)})[${i}];
            const h=e.classList.contains(${JSON.stringify(cls)});e.classList.toggle(${JSON.stringify(cls)});return h;})()`);
          await sleep(60);
          const cur = await js(RECTS);
          await js(`document.querySelectorAll(${JSON.stringify(sel)})[${i}].classList.toggle(${JSON.stringify(cls)})`);
          await sleep(60); // settle before the next baseline — see probePseudo
          checked++;
          const d = diff(base, cur, skip, tags);
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
        await probePseudo(sel, nodeIds, await js(SUBTREES(sel)), tags);
      }
    }
  }

  await js(`localStorage.removeItem('decodesim.theme'); 'ok'`);
  log(`\n===== ${checked} state changes checked · ${problems} caused layout shift =====`);
  dbg.detach();
  process.exit(problems === 0 ? 0 : 1);
});
app.on('window-all-closed', () => process.exit(0));
