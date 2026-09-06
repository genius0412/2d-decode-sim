/**
 * UI STANDARD AUDIT — `npm run uiaudit`. Zero dependencies, same shape as
 * `contrast.mjs` and `shiftaudit.cjs`.
 *
 * Enforces docs/ui-standard.md. Deliberately NOT wired into `npm test`, for the reason
 * the repo already applies to contrast and dbtest: a red `npm test` must keep meaning
 * "physics broke".
 *
 * ── WHY A RATCHET ─────────────────────────────────────────────────────────────
 * The standard landed on a codebase with 105 inline spacing declarations and 18 font
 * sizes. A check that simply failed would have to be switched off on day one, and a
 * check that is off is not a check. So each rule carries a BASELINE: the count measured
 * when the rule was written. The audit fails if a count goes UP, and tells you to lower
 * the baseline when it goes down. New code is held to the standard immediately; the
 * existing debt is paid off in whatever order suits, and can never grow back.
 *
 * Two rules have a baseline of 0 and are hard errors, because both describe bugs that
 * shipped silently and cost real time to find:
 *
 *   • UNDEFINED CUSTOM PROPERTY — `--ds-font` was used 13 times and never defined. In a
 *     `font:` shorthand an unresolvable var() voids the WHOLE declaration, so those rules
 *     set no weight, size or line-height at all, for months, with nothing in the console.
 *     `--accent` was the same bug wearing a fallback.
 *
 *   • DUPLICATE SELECTOR — `.ds-dl` was declared twice for two unrelated components. The
 *     later block won and laid the replay export menu out as a column. Both files are one
 *     cascade; source order is the only tiebreak, and nothing warns you.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const UI = 'src/ui';
const css = readdirSync(UI).filter((f) => f.endsWith('.css')).map((f) => join(UI, f));
const tsx = readdirSync(UI).filter((f) => f.endsWith('.tsx')).map((f) => join(UI, f));
// helpers like rangeFill.ts also hand custom properties to a style object
const ts = readdirSync(UI).filter((f) => f.endsWith('.ts')).map((f) => join(UI, f));
const read = (f) => readFileSync(f, 'utf8').split('\n');

/** every finding, grouped by rule id */
const found = new Map();
const hit = (rule, file, line, text) => {
  if (!found.has(rule)) found.set(rule, []);
  found.get(rule).push({ file, line, text: text.trim().slice(0, 110) });
};

/** the counts on the day each rule was written. LOWER these as debt is paid; never raise. */
const BASELINE = {
  'undefined-token': 0,
  'duplicate-selector': 0,
  'var-literal-fallback': 0,
  'inline-spacing': 78,
  'fractional-font-size': 46,
  'banned-font-weight': 9,
  'off-grid-gap': 237,
};

// ── 1. undefined custom properties ───────────────────────────────────────────
// definitions can come from either stylesheet, or from JS setting a property inline
const defined = new Set();
for (const f of [...css, ...tsx, ...ts]) {
  for (const l of read(f)) {
    for (const m of l.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
    // JSX sets custom properties two ways: `'--x':` and the computed
    // `['--x' as string]:` form React needs for a typed style object
    for (const m of l.matchAll(/\[?\s*['"](--[a-zA-Z0-9-]+)['"]/g)) defined.add(m[1]);
  }
}
for (const f of css) {
  read(f).forEach((l, i) => {
    for (const m of l.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
      if (!defined.has(m[1])) hit('undefined-token', f, i + 1, `${m[1]} — ${l}`);
    }
  });
}

// ── 2. a var() fallback hides a missing token ────────────────────────────────
// `var(--accent, #6ea8ff)` looked fine and used the literal 100% of the time.
for (const f of css) {
  read(f).forEach((l, i) => {
    if (/var\(\s*--[a-zA-Z0-9-]+\s*,\s*(#|rgb|hsl)/.test(l)) hit('var-literal-fallback', f, i + 1, l);
  });
}

// ── 3. one selector, one owner ───────────────────────────────────────────────
// Only top-level blocks: a @media re-declaring a selector is the point of a @media.
const owner = new Map();
for (const f of css) {
  let depth = 0;
  read(f).forEach((l, i) => {
    const code = l.replace(/\/\*.*?\*\//g, '');
    if (depth === 0) {
      const m = code.match(/^([.#][^{}@]*?)\s*\{\s*$/);
      if (m) {
        for (const sel of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
          // a compound like `.a .b` or `.a:hover` is its own thing; only exact repeats count
          const prev = owner.get(sel);
          if (prev) hit('duplicate-selector', f, i + 1, `${sel} — also at ${prev}`);
          else owner.set(sel, `${f}:${i + 1}`);
        }
      }
    }
    depth += (code.match(/\{/g) || []).length - (code.match(/\}/g) || []).length;
    if (depth < 0) depth = 0;
  });
}

// ── 4. spacing literals in JSX ───────────────────────────────────────────────
for (const f of tsx) {
  read(f).forEach((l, i) => {
    if (/style=\{\{/.test(l) || /^\s*(margin|padding|gap)[A-Za-z]*:\s*['"]?[0-9]/.test(l)) {
      if (/(margin|padding|gap)[A-Za-z]*:\s*['"]?[0-9]/.test(l)) hit('inline-spacing', f, i + 1, l);
    }
  });
}

// ── 5. type scale ────────────────────────────────────────────────────────────
for (const f of css) {
  read(f).forEach((l, i) => {
    if (/font-size:\s*[0-9]+\.[0-9]/.test(l)) hit('fractional-font-size', f, i + 1, l);
    if (/font:\s*[0-9]+\s+[0-9]+\.[0-9]/.test(l)) hit('fractional-font-size', f, i + 1, l);
    if (/font-weight:\s*(500|750|900)\b/.test(l)) hit('banned-font-weight', f, i + 1, l);
    if (/font:\s*(500|750|900)\s/.test(l)) hit('banned-font-weight', f, i + 1, l);
  });
}

// ── 6. the 4px grid ──────────────────────────────────────────────────────────
// 2px is allowed inside chips/badges only; every other off-grid value is a finding.
const ON_GRID = new Set([0, 2, 4, 8, 12, 16, 24, 32, 48]);
for (const f of css) {
  read(f).forEach((l, i) => {
    const m = l.match(/^\s*(gap|row-gap|column-gap):\s*([0-9]+)px/);
    if (m && !ON_GRID.has(Number(m[2]))) hit('off-grid-gap', f, i + 1, l);
    const p = l.match(/^\s*padding:\s*([0-9]+)px(?:\s+([0-9]+)px)?/);
    if (p) {
      for (const v of [p[1], p[2]].filter(Boolean)) {
        if (!ON_GRID.has(Number(v))) { hit('off-grid-gap', f, i + 1, l); break; }
      }
    }
  });
}

// ── report ───────────────────────────────────────────────────────────────────
const DESC = {
  'undefined-token': 'var() names a custom property that is defined nowhere',
  'duplicate-selector': 'one selector declared by two top-level blocks',
  'var-literal-fallback': 'var(--x, #literal) — the fallback hides a missing token',
  'inline-spacing': 'spacing literal in JSX; it belongs to a class',
  'fractional-font-size': 'fractional font-size; the scale has six whole steps',
  'banned-font-weight': 'weight outside 400/600/700/800',
  'off-grid-gap': 'gap/padding off the 4px grid',
};

let failed = 0;
let ratcheted = 0;
const rules = Object.keys(BASELINE);
console.log('UI STANDARD AUDIT — docs/ui-standard.md\n');
for (const rule of rules) {
  const n = (found.get(rule) ?? []).length;
  const base = BASELINE[rule];
  const state = n > base ? 'FAIL' : n < base ? 'IMPROVED' : 'ok';
  if (n > base) failed++;
  if (n < base) ratcheted++;
  const pad = rule.padEnd(21);
  console.log(`${state === 'FAIL' ? '✗' : state === 'IMPROVED' ? '↓' : '·'} ${pad} ${String(n).padStart(3)} / ${String(base).padStart(3)}  ${DESC[rule]}`);
  if (n > base || base === 0) {
    for (const v of (found.get(rule) ?? []).slice(0, 25)) {
      console.log(`    ${v.file}:${v.line}  ${v.text}`);
    }
    const extra = n - 25;
    if (extra > 0) console.log(`    … and ${extra} more`);
  }
}
console.log();
if (failed) {
  console.log(`${failed} rule(s) got WORSE than the recorded baseline. Fix them, or change`);
  console.log('the standard in docs/ui-standard.md first and say so in the commit.');
  process.exit(1);
}
if (ratcheted) {
  console.log(`${ratcheted} rule(s) IMPROVED — lower the BASELINE in scripts/uiaudit.mjs to lock it in.`);
  process.exit(1);
}
console.log('ALL RULES AT OR UNDER BASELINE');
