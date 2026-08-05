# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two overlapping primary users, both FTC (FIRST Tech Challenge) participants, grades 7–12:

- **Solo drivers** benchmarking and honing stick/gamepad control and match strategy alone, between team meetings, via the ranked ladder and solo record-attack runs.
- **Drive teams**, practicing coordinated play together — 1v1/2v2 ranked matches, friend-challenged scrimmages, and free-drive sessions — ahead of competition, without needing the physical robot or field.

## Product Purpose

DSIM is a 2D top-down driver-practice simulator that lets FTC teams and drivers practice driving and in-match strategy without physical access to a robot or field. It hosts more than one FTC game ("season" in-app): DECODE presented by RTX (2025–26) and Chain Reaction (2026 Unofficial-FTC CAD competition), both fully scored and ranked. Success means a driver's practice reps here transfer to real match performance — the drive feel, scoring, and penalties are meant to be trustworthy enough to train on, not just fun to click through.

## Positioning

Rules-accurate FTC simulation, not a generic driving sandbox. Robots are modeled off real hardware (goBILDA 104mm wheel geometry, a MATRIX/goBILDA 5000-series motor torque–speed curve, per-drivetrain traction/push/mass tradeoffs) and collide via real 2D physics (Rapier). Scoring, penalties, and field geometry are derived from the actual current-season competition manual, verified against extracted manual figures rather than approximated. The mechanism a generic sim couldn't truthfully copy: the numbers you get in practice are the numbers the real game would give you.

## Operating Context

Played in-browser (Vercel-hosted client) or via a thin Electron desktop wrapper (falls back to a bundled build offline). Used between physical build/practice sessions, solo or with teammates, over a server-authoritative netcode layer (Node/`ws` on Fly) so ranked and scrimmage matches work over the open internet. Controls are fully rebindable (keyboard and gamepad, including the drive/turn stick assignment) so a team can mirror their actual driver-station layout.

## Capabilities and Constraints

- Two playable games (DECODE, Chain Reaction), each with a full scored/penalized match, free drive, and solo record-attack (score-attack) mode.
- Ranked 1v1/2v2 via Glicko-2, leaderboards and records kept per game × mode × drivetrain × season, friend challenges, and a background ranked queue that survives navigating away.
- Accounts and match history via Neon Postgres; admin/staff roles with badges.
- Client bundle is intentionally minimal (React + Rapier 2D only); everything else is server/auth-only — a constraint on future dependency choices, not just current state.
- One Fly server instance serves every deployed client version simultaneously, so protocol changes must stay backward-compatible.

## Brand Commitments

- App brand is **DSIM**; a loaded game is a **"season"** — kept distinct in UI copy (DECODE / Chain Reaction are what's currently loaded, not the product name).
- `LEGAL_OPERATOR` / `LEGAL_JURISDICTION` (`src/legalText.ts`) are unfilled placeholders — the Terms page shows a visible warning until set, and no real payment should be taken before they're filled.

## Evidence on Hand

None on hand (no case studies, testimonials, or press). Do not fabricate any for marketing copy.

## Product Principles

1. **Physical accuracy over convenience.** Drive feel and scoring are derived from real hardware specs and the actual game manual, even where an approximation would be easier to build or tune.
2. **Free and accessible core experience.** Full solo and ranked play works fully signed out; monetization (ads, Ko-fi supporter tier) is cosmetic/convenience-only and never touches gameplay, scoring, or matchmaking fairness.
3. **Multiplayer parity across client versions.** Because one server serves every deployed client build, new capabilities are additive and feature-gated, never a breaking protocol change.
4. **Determinism as a first-class constraint.** The sim core is a pure deterministic state machine (no DOM, no clock, no non-seeded randomness) so replay, reconcile, and multiplayer prediction never drift from the authoritative result.

## Accessibility & Inclusion

Color system is WCAG AA-audited in both light and dark themes (175 pairs, checked via `npm run contrast`). Every keyboard action and gamepad binding, including the drive/turn stick assignment, is rebindable. Audio has independent Sounds/Voice-lines toggles with a beep fallback.
