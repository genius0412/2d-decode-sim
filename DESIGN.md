---
name: DSIM
description: Driver-practice sim for FTC games (DECODE, Chain Reaction) — a driver-station UI wrapped around a live scored match.
colors:
  bg: "#f9faf7"
  bar: "#f3f4f1"
  panel: "#ffffff"
  tile: "#edeeec"
  ink: "#191c1b"
  ink-dim: "#404945"
  mut: "#5c645f"
  line: "#c0c9c4"
  line-soft: "#d9dad8"
  line-strong: "#8b9691"
  accent: "#366758"
  accent-ink: "#ffffff"
  accent-edge: "#24463b"
  accent-soft: "#b5ead7"
  red-chip: "#d32020"
  blue-chip: "#1f6fe0"
  gold: "#f5a623"
  ok: "#2f9e5f"
  ok-ink: "#1f7a46"
  danger: "#ba1a1a"
  warn: "#8f5400"
  hud: "rgba(255, 255, 255, 0.94)"
  hud-line: "#c0c9c4"
  on-field: "#f9faf7"
  on-field-dim: "#b9beb8"
  on-field-accent: "#5fb597"
typography:
  ui:
    fontFamily: "Plus Jakarta Sans Variable, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
  data:
    fontFamily: "Space Grotesk Variable, ui-monospace, SF Mono, Menlo, Consolas, monospace"
rounded:
  sm: "4px"
  DEFAULT: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  full: "9999px"
spacing:
  xxs: "2px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "22px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.DEFAULT}"
    padding: "9px 16px"
  button-secondary:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.DEFAULT}"
    padding: "9px 16px"
  chip:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.data}"
    rounded: "{rounded.full}"
    padding: "5px 11px"
---

# Design System: DSIM

## Overview

**Creative North Star: "The Driver Station"**

DSIM's chrome is built to feel like the physical control box a real FTC team stands behind during a match, not a generic web app shell. Every interactive surface reads as a keycap — a flat colored cap sitting on a slightly darker edge, sinking on hover and pressing flush on click via `transform`, never layout-shifting margin. Data that a driver would glance at mid-match (scores, timers, coordinates, ping) is set in a monospace face with tabular numerals; everything else — labels, menu copy, prose — is set in a rounded-geometric sans. The palette spends most of its area in quiet desaturated neutrals so that the two colors reserved for competition state — alliance red and alliance blue — read as genuinely alarming the instant they appear, the way a real field-control light does.

The system is explicitly **dual-theme** (light/dark, user-toggled, WCAG-audited both ways via `npm run contrast`) and explicitly **three-zone**: chrome surfaces invert between themes (ink-on-light becomes ink-on-dark), fixed-hue fills keep one ink regardless of theme (alliance chips, gold), and anything drawn on the game canvas itself uses a third, non-inverting family (`on-field*`) because the field mat is hardcoded dark in both themes. Confusing these three is the single most common contrast bug in this codebase — see the Colors Named Rule below.

Rejected direction: the original (July 2025) pastel "low-poly indie game" identity — mint/blush/lavender fills, no dark mode, single flat palette. That system is superseded; its leftover `--ds-blush`/`--ds-sage`/`--ds-lavender` tokens are vestigial (see Don'ts) and should not be extended.

**Key Characteristics:**

- Flat "keycap" pressables — offset hard shadow, no blur, moves via `transform`
- Monospace-for-data / sans-for-copy split, enforced per component
- Alliance red/blue are the only saturated, non-inverting accent — spend them like an alarm
- Dual-theme by design token, not by override; a color either inverts, stays fixed, or belongs to the canvas — never guess which

## Colors

Mostly quiet, warm-neutral surfaces; color is spent deliberately, not decoratively.

### Primary

- **Driver Green** (`accent` #366758 light / #5fb597 dark): the one brand accent — primary buttons, links, focus rings, active states. Inverts between themes but stays saturated on both sides (deep green in light, mint in dark) so it never washes out.

### State / Alliance

- **Alliance Red** (`red-chip` #d32020) / **Alliance Blue** (`blue-chip` #1f6fe0): fixed-hue, fixed-ink fills reserved for red/blue alliance identity and win/loss framing. Never invert with theme — an alliance's color must mean the same thing in both themes. Filled, not tinted-text, so they clear contrast as a block of color.
- **Signal Gold** (`gold` #f5a623): staff/supporter badges only. Fixed-ink, chosen specifically because it stays legible and distinct from the green accent and the alliance blue on both panel colors.
- **Status Green** (`ok`/`ok-ink`): "ready" / "on" states, distinct from the brand accent so a ready-chip and a primary button are never visually confused.
- **Danger / Warn** (`danger`, `warn`): destructive actions and caution states; `warn` is burnt amber in light, gold-adjacent in dark — a fill/text split, not a fixed hex.

### Canvas-only (`on-field` family)

- **On-Field** (#f9faf7) / **On-Field Dim** / **On-Field Accent** (#5fb597): the ONLY colors allowed on the game canvas itself. The field mat is hardcoded dark in both app themes, so canvas text/lines never invert with the UI theme — they're a closed, separate set. Never reach for `ink`/`mut`/`accent` when drawing on the canvas.

### Neutral

- **Ink** (#191c1b light / #e8eae7 dark): primary text, inverts.
- **Mut** (#5c645f light / #949e98 dark): secondary/muted text, inverts, deliberately tuned to clear ~5.4:1 against the panel in both themes.
- **Line / Line Soft / Line Strong**: border hierarchy from barely-there dividers to emphasized card edges. `line-soft` doubles as the keycap's drop-shadow color, which is why it goes near-black in dark mode rather than staying a pale gray.
- **Panel / Bar / Tile / Bg**: surface layering from the page background up through the top bar, cards, and recessed tiles (a "tile" sits darker than its panel in both themes — recession is a lightness relationship, not a fixed color).

### Named Rules

**The Three-Zone Rule.** Every color token belongs to exactly one of three zones: *inverting* (reads against a themed surface — most of `ink`/`mut`/`accent`/`warn`), *fixed-ink* (a filled chip whose hue must mean the same thing regardless of theme — alliance red/blue, gold), or *canvas-only* (`on-field*`, because the field mat never themes). Reach for the wrong zone and the color either disappears in dark mode or silently changes what it signals.
**The Fill-Is-Not-Text Rule.** A color that works as a solid fill and a color that works as text on a surface are not the same token. Category collisions (`--ds-ok` doing both) are split into a fill token and an `-ink` sibling (`--ds-ok`/`--ds-ok-ink`).

## Typography

**UI Font:** Plus Jakarta Sans Variable (with system-ui, -apple-system, Segoe UI, Roboto fallbacks)
**Data Font:** Space Grotesk Variable (with ui-monospace, SF Mono, Menlo, Consolas fallbacks)

**Character:** A rounded, friendly geometric sans for everything a driver reads as language, paired with a squared-off mono for everything they read as a number — the same split a real telemetry dashboard makes, not a stylistic flourish.

### Hierarchy

- **Body** (Plus Jakarta Sans, 400–600): menu copy, labels, descriptions, buttons.
- **Data** (Space Grotesk, tabular-nums): scores, timers, coordinates, ping, any live-updating number. Always monospace so digits don't reflow their neighbors as they change.

### Named Rules

**The Digits-Are-Mono Rule.** Any number that updates during a match (score, clock, RTT) renders in `--ds-font-mono` with `font-variant-numeric: tabular-nums`. A body-font number that ticks is a tell that it was bolted on rather than designed as telemetry.

## Layout

No strict spacing grid — the codebase runs an even-pixel rhythm (2/4/6/8/10/12/14px for control clusters, 16–22px between grouped fields, 20–30px for section-level breathing room) rather than a rigid 8px multiple. Panels and forms are flex-based, not a fixed column grid; field rows wrap via `flex: 1 1 150px` rather than named breakpoints. The HUD reserves top/bottom bands (`HUD_TOP`/`HUD_BOTTOM`) so chips and score bars never overlap the field regardless of viewport.

## Elevation & Depth

Flat by default, with a hard-edged "block" shadow standing in for real elevation — no blur, ever. Two vocabularies:

- **Block** (`--ds-block` / `--ds-block-sm`, `4px 4px 0` / `2px 2px 0` in `line-soft`): the resting shadow under panels and cards — a flat offset, not a diffuse glow.
- **Edge** (`--ds-edge` / `--ds-edge-soft`, `0 3px 0`): the keycap's own "thickness" — a solid-color rim that a pressable sinks into on click.
- **Inset** (`box-shadow: inset 0 2px 0 var(--ds-inset)`): recessed fields (inputs) read as carved into the surface rather than sitting on it.

### Named Rules

**The No-Blur Rule.** Nothing in this system uses a soft/blurred shadow. Depth is communicated by hard offset shadows (block, edge) or insets, never `box-shadow` blur radius > 0 — that reads as generic-web rather than driver-station hardware.
**The Transform-Only Press Rule.** A pressable element must move via `transform`, never `margin` or `border`-width changes, so nothing in its neighborhood reflows on hover/press (enforced by `npm run shiftaudit`).

## Shapes

Corners run a small defined scale (4 / 8 / 12 / 16 / 24px, plus a `full` pill at 9999px) rather than one blanket radius. Rectangular components (buttons, panels, tiles, inputs) use the 8px default; small/compact controls step down to 4px; chips and high-identity status pills (alliance chips, badges) go full pill. No sharp (0px) corners anywhere in the chrome.

## Components

### Buttons (`.ds-btn`)

- **Shape:** 8px radius (`.small` variant: 4px), 1px border.
- **Default:** panel background, ink text, `edge-soft` shadow.
- **Primary:** accent fill, accent-ink text, no border, `edge` shadow (the accent-colored keycap edge).
- **Ghost:** no fill, no shadow, no press-transform — a flat text action, not a keycap.
- **Hover / Press:** sinks 1px on hover, 3px (flush with its own edge) on press, via `transform` only; disabled drops to 0.5 opacity and never presses.

### Chips (`.ds-chip`)

- **Style:** full-pill, mono font, panel background, 1px border by default.
- **Alliance variants:** filled solid (`red-chip`/`blue-chip`) with white text — identity is the fill, not a tint, because the raw hue alone doesn't clear contrast as small text.
- **Status variants (`.on`/`.off`):** text-carries-the-meaning, not opacity-fade — an "off" chip stays full-alpha and recedes through border+fill instead of dimming (dimming a status reads as disabled, and this isn't disabled, it's just not-ready).

### Cards / Panels (`.ds-panelbox`, `.ds-panel`)

- **Corner Style:** 8px.
- **Background:** `panel`.
- **Shadow Strategy:** `--ds-block` (flat 4px offset, no blur).
- **Border:** 1px `line`.
- **Internal Padding:** 15px, 14px internal gap between fields.

### Inputs (`.ds-input`)

- **Style:** panel-toned but visually recessed via an inset top shadow (`inset 0 2px 0 var(--ds-inset)`), not a raised card.
- **Focus:** `inset 0 0 0 1px var(--ds-accent)` — the focus ring lives inside the recess rather than adding an outer glow.

### HUD (game-screen chrome)

- **Style:** semi-opaque `hud`/`hud-soft` panels (94%/86% alpha) over the field, edged with `hud-line` — never `line`, which is tuned against `panel` and drops below 3:1 on the translucent HUD card.
- **Placement:** red|timer|blue bar pinned to the bottom, mirroring a real FTC field-control display; muted event log at the left edge; zone-status chips top-right. No popup toasts over the live field.

## Do's and Don'ts

### Do:

- **Do** keep every new color token in exactly one zone — inverting, fixed-ink, or canvas-only (see the Three-Zone Rule) — and name which zone it's in when you add it.
- **Do** use `--ds-hud-line` (not `--ds-line`) for any border drawn on a floating HUD card over the field.
- **Do** move pressables with `transform`/`box-shadow` only; run `npm run shiftaudit` after touching any interactive element's hover/active state.
- **Do** run `npm run contrast` after any token edit — 175 pairs, light + dark, must stay AA.
- **Do** set live-updating numbers in `--ds-font-mono` with tabular numerals.

### Don't:

- **Don't** reach for `--ds-blush`, `--ds-sage`, or `--ds-lavender` — vestigial tokens from the pre-dark-mode pastel identity. `--ds-lavender` specifically failed the "reads as an object against its own panel" test in dark mode and was rejected for the staff badge; treat all three as deprecated rather than a live secondary/tertiary palette.
- **Don't** add a blurred `box-shadow` anywhere in the chrome — this system has no soft-shadow vocabulary; use `--ds-block`/`--ds-edge`/inset instead.
- **Don't** tint alliance identity with text color alone — red/blue alliance meaning is carried by a filled chip, not a colored label.
- **Don't** use `--ds-ink`/`--ds-mut`/`--ds-accent` for anything drawn directly on the game canvas — use the `on-field*` family, which deliberately does not invert with the app theme.
