/* TEMP verification driver — drives the real Electron GUI to check new features in the
 * builder AND in a live match. Delete after the run. Usage: node arg picks the scenario. */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const OUT = path.join(__dirname, 'verify-shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** the spec under test — overridden per scenario via SPEC_JSON env */
const SPEC = JSON.parse(process.env.SPEC_JSON || '{}');
const GAME = process.env.GAME || 'chain';
const LABEL = process.env.LABEL || 'run';

async function main() {
  const win = new BrowserWindow({
    width: 1400, height: 900, show: true,
    webPreferences: { backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, 'dist', 'index.html'));
  win.show();
  win.focus();
  await sleep(2500);

  const js = (code) => win.webContents.executeJavaScript(code);
  // capturePage can throw UnknownVizError right after a paint; retry a few times
  const grab = async (rect) => {
    for (let i = 0; i < 6; i++) {
      try { return rect ? await win.webContents.capturePage(rect) : await win.webContents.capturePage(); }
      catch (e) { await sleep(600); }
    }
    throw new Error('capturePage failed after retries');
  };
  const shot = async (name) => {
    const img = await grab();
    fs.writeFileSync(path.join(OUT, `${LABEL}-${name}.png`), img.toPNG());
    console.log('shot:', `${LABEL}-${name}`);
  };
  const crop = async (name, rect) => {
    const img = await grab(rect);
    fs.writeFileSync(path.join(OUT, `${LABEL}-${name}.png`), img.resize({ width: rect.width * 3, quality: 'best' }).toPNG());
    console.log('crop:', `${LABEL}-${name}`);
  };

  await js(`(()=>{
    const cur = JSON.parse(localStorage.getItem('decodesim.settings.v1')||'{}');
    localStorage.setItem('decodesim.settings.v1', JSON.stringify({
      ...cur, game: ${JSON.stringify(GAME)}, spec: { ...(cur.spec||{}), ...${JSON.stringify(SPEC)} },
      assists: { fieldCentric: false, aimAssist: true, autoIntake: true, autoFire: true },
    }));
    return 'seeded';
  })()`);
  await win.webContents.reload();
  await sleep(2500);

  const clickText = async (txt) => {
    const r = await js(`(()=>{
      const el=[...document.querySelectorAll('button')].find(b=>(b.innerText||'').trim().toUpperCase().includes(${JSON.stringify(txt.toUpperCase())}));
      if(!el) return 'miss:'+${JSON.stringify(txt)};
      el.click(); return 'ok:'+${JSON.stringify(txt)};
    })()`);
    console.log('click', r);
    await sleep(600);
    return r;
  };
  for (const t of ['CONTINUE', 'GOT IT', 'GOT IT']) await clickText(t);

  // ---- BUILDER: show the robot section so the new controls + preview render ----
  await clickText('Configure');
  await sleep(900);
  await shot('01-builder');
  const built = await js(`(()=>{
    const heads=[...document.querySelectorAll('.ds-subh,h3')].map(h=>h.textContent.trim());
    const caps=[...document.querySelectorAll('.cap')].map(c=>c.textContent.trim());
    const dts=[...document.querySelectorAll('.ds-opt.mini .ot')].map(o=>o.textContent.trim());
    const on=[...document.querySelectorAll('.ds-opt.on .ot')].map(o=>o.textContent.trim());
    return JSON.stringify({heads,caps,dts,on});
  })()`);
  console.log('BUILDER', built);

  // ---- LIVE MATCH ----
  await clickText('Play');
  await clickText('Free Drive');
  await sleep(2600);
  await shot('02-match');

  const hold = async (key, ms) => {
    await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true}))`);
    await sleep(ms);
    await js(`window.dispatchEvent(new KeyboardEvent('keyup',{key:${JSON.stringify(key)},bubbles:true}))`);
  };
  const chips = async (tag) => {
    const c = await js(`JSON.stringify([...document.querySelectorAll('.chip')].map(c=>c.innerText.trim()))`);
    console.log('CHIPS', tag, c);
    return c;
  };
  await chips('initial');
  await crop('03-robot-mode-a', { x: 600, y: 250, width: 190, height: 170 });

  // exercise the scenario-specific key
  const KEY = process.env.KEY || '';
  if (KEY) {
    await hold(KEY, 120);
    await sleep(700);
    await chips('after-toggle');
    await shot('04-after-toggle');
    await crop('05-robot-mode-b', { x: 600, y: 250, width: 190, height: 170 });
    // drive a moment in the new mode so it visibly moves
    await hold('w', 900);
    await sleep(400);
    await shot('06-driving');
  }

  await js(`localStorage.removeItem('decodesim.settings.v1'); 'cleared'`);
  await sleep(300);
  app.quit();
}

app.whenReady().then(() => main().catch((e) => { console.error('DRIVER ERROR', e); app.quit(); }));
