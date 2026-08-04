// WCAG 2.x contrast checker for the low-poly palette. No deps; exits 1 on regression.
//   usage: node scripts/contrast.mjs [--list]
//
// Reads the REAL token values out of src/ui/shell.css — both the light `:root` block and
// the `:root[data-theme='dark']` overrides — so a token edit that breaks a documented
// pair fails here instead of in an audit.
// See docs/ui-phase6-accessibility.md and docs/ui-phase7-dark-mode.md.
//
// Two rules this file exists to defend:
//   1. A colour that is both a fill and a text colour will fail one of the two.
//   2. A token whose job is "readable against the surface" INVERTS with the theme.
//      A token whose job is "a fill with fixed ink" does NOT.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------- colour maths (WCAG 2.x relative luminance) ---------- */

const hex = (h) => {
  const s = h.trim().replace('#', '');
  const f = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
};

const lum = (h) => {
  const [r, g, b] = hex(h).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const cr = (a, b) => {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

const to = (n) => Math.round(n).toString(16).padStart(2, '0');

/** composite `fg` at `alpha` over `bg` — for --ds-hud, and for any `opacity` on text.
 *  `opacity` does not create a new colour; it blends toward whatever is behind. */
const composite = (fg, alpha, bg) => {
  const [a, b] = [hex(fg), hex(bg)];
  return '#' + a.map((v, i) => to(v * alpha + b[i] * (1 - alpha))).join('');
};

/* ---------- tokens, read from source ---------- */

const css = readFileSync(join(root, 'src/ui/shell.css'), 'utf8');

const parseBlock = (re, label) => {
  const m = css.match(re);
  if (!m) throw new Error(`could not find the ${label} token block in shell.css`);
  const out = {};
  for (const [, k, v] of m[1].matchAll(/(--ds-[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[k] = v.trim();
  return out;
};

// The FIRST `:root {` block is the light palette (the later ones are --ds-inset and the
// legacy bridge, which holds no --ds-* declarations, so a stray match would be harmless).
const LIGHT = parseBlock(/\n:root \{([\s\S]*?)\n\}/, 'light');
// Only the PALETTE block, not `:root[data-theme='dark'] .ds-select` (note the `\s*\{`).
const DARK = { ...LIGHT, ...parseBlock(/:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/, 'dark') };

const getter = (table, themeName) => (name) => {
  const v = table[name];
  if (!v) throw new Error(`token ${name} not found in the ${themeName} palette`);
  return v;
};

/* ---------- grounds ---------- */

// The canvas, which NEVER themes (src/render/, src/config.ts COLORS).
const FIELD = '#14161a'; // the dark tiles the robots drive on
const MAT = '#23262b'; // COLORS.mat, the lightest thing a HUD card can sit on
// the ranked-intro scrim, and the results/net scrim: dark in BOTH themes
const INTRO_SCRIM = composite('#080a0e', 0.72, FIELD);

/** `rgba(r, g, b, a)` → ['#rrggbb', a]. --ds-hud is translucent, so its real colour
 *  depends on what is behind it, and that is the canvas rather than a themed surface. */
const rgba = (v) => {
  const [r, g, b, a] = v.match(/[\d.]+/g).map(Number);
  return ['#' + [r, g, b].map(to).join(''), a];
};

/** The HUD card composited over its WORST-CASE ground — which is the mat in both
 *  themes: it is the darkest backing for light mode's translucent WHITE card, and the
 *  lightest backing for dark mode's translucent CHARCOAL one. */
const hudCard = (t, token) => {
  const [c, a] = rgba(t(token));
  return composite(c, a, MAT);
};

const AA = 4.5; // 1.4.3 body text (<24px, or <18.66px bold)
const NON_TEXT = 3.0; // 1.4.11 component boundary / meaningful graphic

/* ---------- pairs asserted in EVERY theme ---------- */

/** @param t token getter for the theme under test */
const themedPairs = (t) => {
  const bg = t('--ds-bg');
  const bar = t('--ds-bar');
  const panel = t('--ds-panel');
  const tile = t('--ds-tile');
  return [
    // ink on the four surfaces
    ['--ds-ink on bg', t('--ds-ink'), bg, AA],
    ['--ds-ink on panel', t('--ds-ink'), panel, AA],
    ['--ds-ink-dim on bg', t('--ds-ink-dim'), bg, AA],
    ['--ds-mut on bg', t('--ds-mut'), bg, AA],
    ['--ds-mut on panel', t('--ds-mut'), panel, AA],
    ['--ds-mut on tile', t('--ds-mut'), tile, AA],
    ['--ds-mut on bar', t('--ds-mut'), bar, AA],
    // Select.tsx's listbox trigger button: --ds-ink text on the same --ds-tile
    // "recessed well" .ds-select already used, never explicitly asserted before.
    ['--ds-ink on tile (listbox button)', t('--ds-ink'), tile, AA],

    // semantics that must stay READABLE — these invert
    ['--ds-accent on bg', t('--ds-accent'), bg, AA],
    ['--ds-warn on bg', t('--ds-warn'), bg, AA],
    ['--ds-danger on bg', t('--ds-danger'), bg, AA],
    ['--ds-danger on panel', t('--ds-danger'), panel, AA], // .ds-btn.danger (Admin)
    ['--ds-sky-ink on bg', t('--ds-sky-ink'), bg, AA],
    ['--ds-ok-ink on bg', t('--ds-ok-ink'), bg, AA],
    ['--ds-ok-ink on tile', t('--ds-ok-ink'), tile, AA],
    ['--ds-red-ink on bg', t('--ds-red-ink'), bg, AA],
    ['--ds-blue-ink on bg', t('--ds-blue-ink'), bg, AA],
    ['--ds-purple-ink on bg', t('--ds-purple-ink'), bg, AA],

    // the accent's ink inverts WITH its fill (white on light mint is 2.46:1)
    ['--ds-accent-ink on --ds-accent', t('--ds-accent-ink'), t('--ds-accent'), AA],
    ['--ds-accent-soft-ink on --ds-accent-soft', t('--ds-accent-soft-ink'), t('--ds-accent-soft'), AA],
    ['--ds-ink on --ds-accent-soft', t('--ds-ink'), t('--ds-accent-soft'), AA],

    /* SELECTED rows re-ground their SECONDARY text on --ds-accent-soft. The pairs
       above only ever asserted the PRIMARY ink, so a muted sub-label inherited the
       value tuned for --ds-panel and quietly missed AA on the selected state — the
       "readable against the surface" rule applied to the wrong surface. Found by the
       live-DOM audit (.claude/skills/frontend-consistency), which measures rendered
       pairs rather than token pairs. */
    ['--ds-accent-soft-mut on --ds-accent-soft', t('--ds-accent-soft-mut'), t('--ds-accent-soft'), AA],

    /* QUEUE COUNT CHIP (.ds-qcount) — the same text rides FOUR different grounds,
       which is exactly how it shipped unreadable: the defaults are tuned for the
       header bar and the recessed tile, and on the home menu's PLAY button, an
       --ds-accent FILL, the bold number was --ds-accent on --ds-accent. 1:1. The
       token pairs existed and passed; this pairing had simply never been declared,
       so the suite had nothing to fail on. Every ground it can land on is listed
       here now — adding a fifth placement means adding a fifth pair. */
    ['qcount label on --ds-bar', t('--ds-mut'), t('--ds-bar'), AA],
    ['qcount number on --ds-bar', t('--ds-accent'), t('--ds-bar'), AA],
    ['qcount label on --ds-tile', t('--ds-mut'), t('--ds-tile'), AA],
    ['qcount number on --ds-tile', t('--ds-accent'), t('--ds-tile'), AA],
    ['qcount label on --ds-panel (menu button)', t('--ds-mut'), t('--ds-panel'), AA],
    ['qcount number on --ds-panel (menu button)', t('--ds-accent'), t('--ds-panel'), AA],
    ['qcount on --ds-accent (PLAY primary)', t('--ds-accent-ink'), t('--ds-accent'), AA],
    ['qcount label on --ds-accent-soft (rail selected)', t('--ds-accent-soft-mut'), t('--ds-accent-soft'), AA],
    ['qcount number on --ds-accent-soft (rail selected)', t('--ds-accent-soft-ink'), t('--ds-accent-soft'), AA],

    // pastels are fills that carry --ds-ink; they get tinted-dark siblings in dark mode
    ['--ds-ink on --ds-blush', t('--ds-ink'), t('--ds-blush'), AA],
    ['--ds-ink on --ds-sage', t('--ds-ink'), t('--ds-sage'), AA],
    ['--ds-ink on --ds-lavender', t('--ds-ink'), t('--ds-lavender'), AA],
    ['--ds-ink on --ds-sky', t('--ds-ink'), t('--ds-sky'), AA],

    // FRIENDS PANEL — its ground is --ds-bar (like the nav rail), not bg/panel,
    // so these pairs are genuinely new even where the same token is checked above.
    // The status dots are FILLS carrying no text, hence NON_TEXT: they are only a
    // secondary cue anyway, since every row spells its status out in words (a red
    // DND dot and a green online dot are the same dot to a colourblind player).
    ['--ds-ink on bar (friend name)', t('--ds-ink'), bar, AA],
    ['--ds-ink-dim on bar (friends toggle)', t('--ds-ink-dim'), bar, AA],
    ['--ds-red-ink on bar (friends error)', t('--ds-red-ink'), bar, AA],
    ['--ds-ok-ink on bar (friends note)', t('--ds-ok-ink'), bar, AA],
    ['--ds-ok dot on bar (1.4.11)', t('--ds-ok'), bar, NON_TEXT],
    ['--ds-danger dot on bar (1.4.11)', t('--ds-danger'), bar, NON_TEXT],

    // CONTRIBUTORS cards sit on --ds-panel; the icon links go accent on hover
    ['--ds-accent on panel (contributor icon)', t('--ds-accent'), panel, AA],
    ['--ds-ink-dim on panel (contributor card)', t('--ds-ink-dim'), panel, AA],

    // 1.4.11 — interactive boundaries, measured against the card behind them
    ['--ds-line-strong on panel (1.4.11)', t('--ds-line-strong'), panel, NON_TEXT],
    ['focus ring --ds-accent on bg (1.4.11)', t('--ds-accent'), bg, NON_TEXT],

    // fills with fixed white ink — identical in both themes, asserted in both anyway
    ['alliance-red chip', '#ffffff', t('--ds-red-chip'), AA],
    ['alliance-blue chip', '#ffffff', t('--ds-blue-chip'), AA],
  ];
};

/** Identity fills that must never be small text. On the LIGHT floor that is a
 *  measurable fact — all five land near 3:1 — so we assert they still FAIL: if someone
 *  "fixes" one by darkening it, this fires and points them at an `-ink` sibling instead
 *  (src/render/ and .score-panel depend on these exact values).
 *
 *  On the DARK floor the same hues contrast fine (--ds-red is 4.67:1 on #20262c), so
 *  "fill-only" there is a POLICY, not a measurement, and asserting a failure would be
 *  asserting a falsehood. The `-ink` siblings exist for both themes regardless. */
const FILL_ONLY = ['--ds-red', '--ds-blue', '--ds-green', '--ds-ok', '--ds-purple'];

/** The in-match HUD. Its CARDS theme (--ds-hud is the themed panel over the canvas);
 *  its ON-CANVAS glyphs do not (--ds-on-field*, absent from the dark palette). Both
 *  halves are asserted in both themes.
 *
 *  The load-bearing pair is `--ds-hud-line vs FIELD`: a dark card on the dark field is
 *  ~1.4:1 by fill, so the EDGE is what identifies the card, and it has to read from the
 *  card side AND the field side. That is the check that lets the HUD theme at all. */
const hudPairs = (t) => {
  const card = hudCard(t, '--ds-hud');
  const soft = hudCard(t, '--ds-hud-soft');
  const panel = t('--ds-panel');
  return [
    ['HUD .timer-time', t('--ds-ink'), card, AA],
    ['HUD .timer-phase / .breakdown-row', t('--ds-mut'), soft, AA],
    ['HUD .chip ink', t('--ds-ink'), card, AA],
    ['HUD .chip.on / GATE OPEN', t('--ds-ok-ink'), card, AA],
    ['HUD .chip.off / GATE CLOSED', t('--ds-mut'), t('--ds-tile'), AA],
    ['HUD .chip.warn', t('--ds-warn'), card, AA],
    ['HUD .timer-panel.urgent', t('--ds-red-ink'), card, AA],
    ['HUD .robot-status ink', t('--ds-ink-dim'), card, AA],
    ['HUD .game-btn ink', t('--ds-ink-dim'), card, AA],
    ['HUD .eventlog-line ink', t('--ds-ink-dim'), soft, AA],
    ['HUD .hopper-pip / .pg-bar ring (1.4.11)', t('--ds-mut'), card, NON_TEXT],
    ['HUD alliance-red chip', '#ffffff', t('--ds-red-chip'), AA],
    ['HUD alliance-blue chip', '#ffffff', t('--ds-blue-chip'), AA],
    ['HUD .res-side.red label', '#ffffff', '#991b1b', AA],
    ['HUD .res-side.blue label', '#ffffff', '#1d4ed8', AA],

    // The standing "you are still queued" chip — the one menu-shell surface that
    // ALSO floats over the field. Its fill is the panel, so its ink is measured
    // there; its EDGE is what identifies it against the field, which
    // `checkCardIdentifiable` already asserts for --ds-hud-line. It is opaque on
    // purpose: fading it would blend ink and fill toward the field together and
    // quietly drop this pair below the floor, where nothing here would see it.
    ['HUD .ds-queuechip ink over the field', t('--ds-ink'), panel, AA],
    ['HUD .ds-queuechip live dot (1.4.11)', t('--ds-accent'), panel, NON_TEXT],

    // the .overlay-panel is `--ds-panel` on a dark scrim, so its ink is the panel's
    ['HUD .record-total on the results panel', t('--ds-ink'), panel, AA],
    ['HUD .results-table th.red', t('--ds-red-ink'), panel, AA],
    ['HUD .results-table th.blue', t('--ds-blue-ink'), panel, AA],
    ['HUD .elo-delta.up on its tint', t('--ds-ok-ink'), composite('#34d399', 0.12, panel), AA],
    ['HUD .elo-delta.down on its tint', t('--ds-danger'), composite('#f87171', 0.12, panel), AA],

    // ON-CANVAS text: fixed, and measured against the two dark grounds it ever meets
    ['canvas countdown on the field', t('--ds-on-field'), FIELD, AA],
    ['canvas .intro-vs on the scrim', t('--ds-on-field-dim'), INTRO_SCRIM, AA],
    ['canvas .intro-eyebrow on the scrim', t('--ds-on-field-accent'), INTRO_SCRIM, AA],
    ['canvas .mobile-joystick-label', t('--ds-on-field-dim'), FIELD, AA],
  ];
};

/** Screens that only render with a game server configured (Leaderboard, MatchHistory,
 *  ServerPicker, Account/Auth). They are the easiest place for a stale literal to hide,
 *  because a `npm run dev` without VITE_GAME_SERVER_URL never draws them. */
const serverPairs = (t) => {
  const panel = t('--ds-panel');
  const bg = t('--ds-bg');
  const tile = t('--ds-tile');
  return [
    ['ServerPicker .ping-dot.good (1.4.11)', t('--ds-ok-ink'), tile, NON_TEXT],
    ['ServerPicker .ping-dot.fair (1.4.11)', t('--ds-warn'), tile, NON_TEXT],
    ['ServerPicker .ping-dot.poor (1.4.11)', t('--ds-danger'), tile, NON_TEXT],
    ['ServerPicker .ping-dot.down (1.4.11)', t('--ds-mut'), tile, NON_TEXT],
    ['MatchHistory .mh-player.al-red', t('--ds-red-ink'), panel, AA],
    ['MatchHistory .mh-player.al-blue', t('--ds-blue-ink'), panel, AA],
    ['UsernameField hint / available', t('--ds-ok-ink'), panel, AA],
    ['UsernameField hint / taken', t('--ds-danger'), panel, AA],
    ['Account id <code>', t('--ds-mut'), panel, AA],
    ['Leaderboard .lb-standing-badge', t('--ds-gold-ink'), t('--ds-gold'), AA],
    // The supporter badge is a FILL with fixed ink for exactly this reason: it
    // renders on the leaderboard panel, the lobby roster tile, AND a profile
    // header, and no single coloured-text value clears AA on all three grounds.
    ['SupporterBadge glyph', t('--ds-gold-ink'), t('--ds-gold'), AA],
    // ...and the staff variants of the same badge. Unlike gold, both of these
    // fills INVERT between themes, so checking them in each theme is the whole
    // point: the assertion is that the PAIR stays legible, not that the hex does.
    ['SupporterBadge owner glyph', t('--ds-accent-ink'), t('--ds-accent'), AA],
    ['SupporterBadge admin glyph', '#ffffff', t('--ds-blue-chip'), AA],
    // .legal-warn paints --ds-warn as TEXT on a 9% tint of itself over the page
    ['Legal unfinished-terms warning', t('--ds-warn'), composite(t('--ds-warn'), 0.09, bg), AA],
    ['Leaderboard .lb-standing.placing text', t('--ds-warn'), composite(t('--ds-gold'), 0.09, panel), AA],
    ['ds-opt-del hover glyph', t('--ds-red-ink'), panel, AA],

    /* TINTED OPTION ROWS + the start-pose legality banner. Each paints a semantic
       hue as TYPE on a 12%-tinted panel — exactly the "a colour that is both a FILL
       and a TEXT colour will fail one of the two" trap called out at the top of
       shell.css. They now use the `-ink` siblings; these pairs keep them honest.
       The ground is the same color-mix the CSS composites. */
    ['.ds-opt.red .ot', t('--ds-red-ink'), panel, AA],
    ['.ds-opt.blue .ot', t('--ds-blue-ink'), panel, AA],
    ['.ds-opt.red.on .ot', t('--ds-red-ink'), composite(t('--ds-red'), 0.12, panel), AA],
    ['.ds-opt.blue.on .ot', t('--ds-blue-ink'), composite(t('--ds-blue'), 0.12, panel), AA],
    ['.ds-startpos-status.ok', t('--ds-ok-ink'), composite(t('--ds-ok'), 0.12, panel), AA],
    ['.ds-startpos-status.bad', t('--ds-red-ink'), composite(t('--ds-red'), 0.12, panel), AA],
  ];
};

/* ---------- run ---------- */

const listOnly = process.argv.includes('--list');
let failed = 0;
let total = 0;

const check = (label, ink, ground, floor) => {
  total++;
  const ratio = cr(ink, ground);
  const pass = ratio >= floor;
  if (!pass) failed++;
  if (listOnly || !pass) {
    console.log(
      `${pass ? 'PASS' : 'FAIL'}  ${ratio.toFixed(2).padStart(5)}:1 (need ${floor})  ${label}  ${ink} on ${ground}`,
    );
  }
};

/** A HUD card must be IDENTIFIABLE against the field (1.4.11) — but a border only has
 *  to do that job when the fill cannot. Light mode's near-white card is ~15:1 on the
 *  field and needs no edge at all; dark mode's card is ~1.4:1, so --ds-hud-line carries
 *  it. Asserting both would demand a light-mode border that reads on a white card. */
const checkCardIdentifiable = (themeName, t, card) => {
  total++;
  const byFill = cr(card, FIELD);
  const byEdge = cr(t('--ds-hud-line'), FIELD);
  const best = Math.max(byFill, byEdge);
  const pass = best >= NON_TEXT;
  if (!pass) failed++;
  if (listOnly || !pass) {
    console.log(
      `${pass ? 'PASS' : 'FAIL'}  ${best.toFixed(2).padStart(5)}:1 (need ${NON_TEXT})  ` +
        `[${themeName}] HUD card identifiable on the field ` +
        `(fill ${byFill.toFixed(2)}, edge ${byEdge.toFixed(2)})`,
    );
  }
};

for (const [themeName, table] of [['light', LIGHT], ['dark', DARK]]) {
  const t = getter(table, themeName);
  if (listOnly) console.log(`\n--- ${themeName.toUpperCase()} ---`);
  for (const group of [themedPairs, hudPairs, serverPairs]) {
    for (const [label, ink, ground, floor] of group(t)) {
      check(`[${themeName}] ${label}`, ink, ground, floor);
    }
  }
  checkCardIdentifiable(themeName, t, hudCard(t, '--ds-hud'));
  // Only assertable on the light floor — see FILL_ONLY.
  if (themeName !== 'light') continue;
  for (const name of FILL_ONLY) {
    total++;
    const ratio = cr(t(name), t('--ds-bg'));
    const stillFails = ratio < AA;
    if (!stillFails) failed++;
    if (listOnly || !stillFails) {
      console.log(
        `${stillFails ? 'PASS' : 'FAIL'}  [${themeName}] ${name} is fill-only (${ratio.toFixed(2)}:1 on bg` +
          `${stillFails ? ', correctly below 4.5 — never use as text)' : ' — now passes as text? add an -ink sibling instead of widening this token)'}`,
      );
    }
  }
}

const cards = ['light', 'dark']
  .map((n, i) => `${n} ${hudCard(getter([LIGHT, DARK][i], n), '--ds-hud')}`)
  .join(', ');

console.log(
  failed === 0
    ? `\nALL PASS — ${total} contrast checks across light + dark (HUD card over the mat: ${cards})`
    : `\n${failed}/${total} FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
