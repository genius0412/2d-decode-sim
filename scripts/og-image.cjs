/* Renders public/og.png — the 1200x630 card that Discord / iMessage / Slack / X
 * show when someone pastes a playdsim.com link.
 *
 *   npm run og
 *
 * The output is COMMITTED (scrapers fetch a static URL, and the web build just
 * copies public/ through), so this only needs re-running when the branding or
 * the tagline changes. Electron is already a devDependency for `shiftaudit`, so
 * this adds no install weight and no image library.
 *
 * The palette is DSIM's dark theme (see :root[data-theme='dark'] in shell.css) —
 * a link card sits on someone else's chat background, so it commits to one look
 * rather than trying to be theme-aware like the app.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const W = 1200;
const H = 630;
const OUT = path.join(__dirname, '..', 'public', 'og.png');
const LOGO = path.join(__dirname, '..', 'public', 'icon-512.png');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const logo = 'data:image/png;base64,' + fs.readFileSync(LOGO).toString('base64');
const font = (f) =>
  'data:font/woff2;base64,' +
  fs
    .readFileSync(
      path.join(__dirname, '..', 'node_modules', f),
    )
    .toString('base64');
const JAKARTA = font('@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2');
const GROTESK = font('@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2');

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family: 'Jakarta'; src: url('${JAKARTA}') format('woff2-variations'); font-weight: 200 800; }
  @font-face { font-family: 'Grotesk'; src: url('${GROTESK}') format('woff2-variations'); font-weight: 300 700; }
  * { margin: 0; box-sizing: border-box; }
  body {
    width: ${W}px; height: ${H}px; overflow: hidden;
    background: #20262c; color: #e8eae7;
    font-family: 'Jakarta', sans-serif;
    display: flex; flex-direction: column; justify-content: center;
    padding: 0 84px; position: relative;
  }
  /* a soft mint bloom behind the mark, so the card isn't a flat rectangle */
  .glow {
    position: absolute; right: -140px; top: -160px; width: 620px; height: 620px;
    border-radius: 50%; background: radial-gradient(circle, rgba(95,181,151,.20), transparent 62%);
  }
  .row { display: flex; align-items: center; gap: 26px; margin-bottom: 26px; }
  .row img { width: 96px; height: 96px; border-radius: 22px; }
  .row b { font-size: 92px; font-weight: 800; letter-spacing: -.03em; line-height: 1; }
  .eyebrow {
    font-family: 'Grotesk', monospace; font-size: 22px; font-weight: 700;
    letter-spacing: .17em; text-transform: uppercase; color: #5fb597; margin-bottom: 20px;
  }
  .lead { font-size: 33px; line-height: 1.42; color: #b6bcb8; max-width: 900px; }
  .lead b { color: #e8eae7; font-weight: 700; }
  .foot {
    position: absolute; left: 84px; bottom: 56px;
    font-family: 'Grotesk', monospace; font-size: 21px; letter-spacing: .07em; color: #949e98;
  }
  .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 10px; background: #5fb597; }
</style></head><body>
  <div class="glow"></div>
  <p class="eyebrow">FIRST Tech Challenge &middot; 2D Driver Practice</p>
  <div class="row"><img src="${logo}" alt=""><b>DSIM</b></div>
  <!-- APP_BLURB (src/seasons.ts) verbatim, then the two games. Same sentence the
       homepage and the meta description use — keep them identical. -->
  <p class="lead">
    An online 2D driving simulator for FIRST Tech Challenge.<br>
    <b>DECODE</b> &middot; <b>Chain Reaction</b>
  </p>
  <p class="foot">playdsim.com</p>
  <div class="bar"></div>
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    useContentSize: true,
    webPreferences: { offscreen: true, deviceScaleFactor: 1 },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => 1)');
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage();
  const png = img.resize({ width: W, height: H }).toPNG();
  fs.writeFileSync(OUT, png);
  console.log(`wrote ${OUT} (${W}x${H}, ${(png.length / 1024).toFixed(0)} kB)`);
  app.exit(0);
});
