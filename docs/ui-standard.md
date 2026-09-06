# DSIM UI standard

**This document is STRICT.** Every rule below is a MUST unless it says otherwise. If a rule
is wrong, change the rule here first and then change the code — do not make an exception in
a component. A standard with exceptions scattered through 60 files is what produced the
sprawl this document exists to end.

Read alongside CLAUDE.md's **THEMING** gotcha (colour) and its **UI COPY** section (wording).
Those are not repeated here; this covers geometry, type, anatomy, state and enforcement.

---

## 0. Why this exists — the measured starting point

Counted 2026-09-06 across `src/ui/*.css` and `src/ui/*.tsx`:

| | found | should be |
|---|---|---|
| spacing tokens | **0** | 7 |
| distinct CSS `gap` values | 10 (2,3,4,5,6,7,8,10,12,14) | 7 |
| distinct `font-size` values | **18**, incl. 9.5/10.5/11.5/12.5/13.5/14.5 | 6 |
| distinct `font-weight` values | 7 (400,500,600,700,750,800,900) | 4 |
| inline `marginTop` in JSX | **43**, across 10 values | 0 |
| inline spacing declarations in JSX | **105** | 0 |

Nothing here was decided by taste. Each scale below keeps the value the codebase already
uses most and drops the near-duplicates around it.

---

## 1. Non-negotiables

1. **No spacing, size or colour literal in JSX.** `style={{ marginTop: 12 }}` is banned
   outright. Spacing belongs to a class. There is no exception for "just this one".
2. **Every value comes from a token.** Spacing, radius, type, colour. A raw `px` in CSS is
   allowed only for borders (`1px`), and for geometry that is genuinely one-off and
   documented in a comment saying why.
3. **Every interactive element has `:hover`, `:active`, `:focus-visible` and `:disabled`.**
   `:focus-visible` is not optional — the app suppresses the UA ring, so omitting it makes
   the control invisible to a keyboard.
4. **No state change may move layout.** Pressed, hovered, selected, loading, error and empty
   states must not change an element's box. Use `transform`, `box-shadow` and colour.
   `npm run shiftaudit` enforces this; it is not advisory.
5. **A control explains itself or it is redesigned.** Helper text is not a fix for an unclear
   label. See §8.

---

## 2. Spacing — a 4px grid

```css
--ds-s-1:  4px;   /* hairline: icon↔label, chip internals            */
--ds-s-2:  8px;   /* tight: within a row, between sibling controls   */
--ds-s-3: 12px;   /* default: row↔row, label↔field                   */
--ds-s-4: 16px;   /* panel body padding, section internals           */
--ds-s-5: 24px;   /* section↔section                                 */
--ds-s-6: 32px;   /* page block↔block                                */
--ds-s-7: 48px;   /* page top/bottom margin                          */
```

- **2px is allowed only inside a chip or badge** (`--ds-s-0: 2px`), where 4 is visibly loose.
  Nowhere else.
- **BANNED: 3, 5, 6, 7, 9, 10, 11, 13, 14, 15, 18, 20px.** Round to the nearest token. `10 →
  8` when it separates things inside one component, `10 → 12` when it separates components.
- **Padding is symmetric or it is on the grid.** `13px 15px` and `9px 11px` are banned. A
  horizontal/vertical difference is fine (`8px 12px`); an arbitrary one is not.
- **One owner per gap.** The space between stacked children belongs to the PARENT's `gap`,
  not to a margin on each child, and never to both. Adjacent-sibling margins
  (`.x + .x { margin-top }`) are allowed only where the parent cannot own the gap.
- **Panel body padding is `--ds-s-4`, always**, applied by a class. It is currently inlined
  as `style={{ padding: 16 }}` in several files; those are bugs, not style.

## 3. Type — six sizes, four weights

```css
--ds-t-xs: 11px;  /* eyebrows, mono labels, tick marks    */
--ds-t-sm: 12px;  /* hints, sub-lines, table meta         */
--ds-t-md: 13px;  /* body — the default                   */
--ds-t-lg: 15px;  /* panel titles, emphasis               */
--ds-t-xl: 20px;  /* h2                                   */
--ds-t-2xl: 28px; /* h1                                   */
```

- **Weights: 400, 500, 600, 700, 750, 800, 900 — and no eighth.** Both families are
  VARIABLE cuts, which `shell.css:164` documents, so half-steps like 750 are real type
  rather than a rounding accident, and 500 is a genuine de-emphasis. An earlier draft of
  this document banned 500/750/900 without reading that comment; the rule now guards
  against a NEW weight appearing instead of churning three deliberate ones.
- **No fractional PIXEL sizes.** 8.5, 9.5, 10.5, 11.5, 12.5, 13.5, 14.5, 15.5 and 16.5 were
  all in use; they are gone. If 11 is too big and 12 too small, the problem is the layout,
  not the type. Fractional `em` on rendered Markdown is fine — that is relative sizing, not
  a picked number.
- **Families are `--ds-font-ui` and `--ds-font-mono`.** There is no `--ds-font`; it never
  existed, and because an unresolvable `var()` in a `font:` shorthand voids the WHOLE
  declaration, thirteen rules silently set nothing for months. Grep a token before using it.
- **Prefer the longhands.** `font:` shorthand also resets `font-family` and `line-height`,
  which is how that bug stayed invisible.
- **Line height: 1 for single-line UI, 1.45 for prose.** No other values.

## 4. Radius and borders

- Use `--ds-round-sm|--ds-round|--ds-round-md|--ds-round-lg|--ds-round-full`. **No literal
  radius.** Today 10px appears 14 times with no token; it rounds to `--ds-round-md`.
- Borders are `1px`. A "heavier" edge is a colour change, not a width change — a width
  change moves layout (§1.4).
- **One radius per component.** A card and the button inside it may differ; two buttons in
  the same row may not.

## 5. Colour

Governed by CLAUDE.md's THEMING gotcha — the three token categories, `--ds-hud-line` on
floating surfaces, category-3 tokens on anything drawn on the canvas. Additionally:

- **No hex, `rgb()` or `hsl()` literal in CSS or JSX.** Today's offenders are documented
  debt (§10), not precedent.
- **No `var(--token, #fallback)`.** A fallback hides a missing token: `--accent` was
  undefined for months and every site silently used its literal.
- `npm run contrast` must stay ALL PASS. A new colour pair means a new entry in
  `scripts/contrast.mjs`, not an untested colour.

## 6. Component anatomy

These skeletons are fixed. A screen that needs something else needs a discussion, not a
variant.

**Page** — `ds-eyebrow` → `ds-h1` → optional `ds-sub` → panels, `--ds-s-5` between panels.

**Panel** — `.ds-panel` > `.ds-panel-h` (title + optional action) > body at `--ds-s-4`.
The title is a **short noun phrase**, sentence case, no trailing period, no full sentences.

**Row** — label left, value right, both vertically centred, `--ds-s-3` between rows. Values
in one column share an alignment and a format.

**Option grid** (`.ds-opts`/`.ds-opt`) — every tile in a grid is the **same height whether or
not it has a sub-line**. A grid that re-flows when one option gains a description is broken.

**Dialog** — title, body, actions last. **Primary action is rightmost, always.** Destructive
actions are `danger` and confirm; a confirm must name the target and the effect.

**List states** — every list has four: loading (`.ds-loading`), empty (`.ds-empty` with a
`.big` headline, no period, plus one sentence with one), error, and populated. **All four
share the same padding**, so the panel does not jump height when data lands.

## 7. Motion

- Transitions ≤ 150ms, and only on `transform`, `opacity`, `background`, `border-color`,
  `box-shadow`.
- `prefers-reduced-motion` must cap **`animation-iteration-count: 1`** as well as duration.
  Capping only the duration makes an infinite animation loop faster, not stop.
- No animation on first paint of a list or panel.

## 8. Copy

The wording rules are CLAUDE.md's **UI COPY** section. The one addition, which is stricter:

> **Descriptions are deleted, not shortened.** A sub-line, hint or tooltip must teach
> something the label cannot. If it restates the label, narrates what will happen, or
> reassures, it goes. "Free Drive" does not need a sentence explaining free driving.

Keep a blurb only where it names a real trade-off the user is choosing between — the robot
builder's drivetrain and archetype descriptions are the legitimate case, because picking
between them IS the task.

## 9. Enforcement

Before claiming UI work done:

```bash
npm run contrast && npm run build && npm run shiftaudit
```

And these must all return nothing:

```bash
grep -rnE "style=\{\{[^}]*(margin|padding|gap)" src/ui/*.tsx
grep -rnE "font-size: *[0-9]+\.[0-9]" src/ui/*.css
grep -rnE "font-weight: *(500|750|900)" src/ui/*.css
grep -rn "var(--[a-z-]*, *#" src/ui/*.css
```

## 10. Known debt

Recorded so it is not mistaken for precedent. These predate the standard; **new code does not
get to match them.**

- 105 inline spacing declarations in JSX (43 of them `marginTop`).
- 237 off-grid gap/padding values. (Fractional sizes and stray weights: cleared.)
- `10px` radius inlined 14×; `999px` 6× where `--ds-round-full` exists.
- ~20 interactive elements with `:hover` and no `:focus-visible`, including `.game-btn`,
  `.overlay-buttons button` and `button.ds-key` (the keybinding capture control).
- Dead rule families (`.server-picker/-list/-row`, `.ping-dot*`, `.final-score*`,
  `.ds-status`, `.ds-season*`, `.ds-kick`) and 6 palette tokens with no call sites, 5 of
  which `scripts/contrast.mjs` still audits.
- `styles.css` claims to be in-match-only; ~28% of it is shell UI, and 7 class namespaces are
  split across both stylesheets.
