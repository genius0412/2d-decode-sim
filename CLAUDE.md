# CLAUDE.md — DSIM, a 2D FTC driver-practice simulator

2D top-down driver-practice sim hosting **more than one game**:

| id | game | status |
|----|------|--------|
| `decode` | **DECODE presented by RTX** (FTC 2025–26) | full match, scored, ranked |
| `chain` | **Chain Reaction** (2026 Unofficial-FTC CAD competition) | full match, scored, ranked |

Vite + React + TypeScript, Canvas 2D. The CLIENT bundle is React + **Rapier 2D**
(`@dimforge/rapier2d-compat`, wasm) and nothing else; the rest of `dependencies`
(`ws`, `tsx`, `pg`, `jose`, `@neondatabase/auth`) exists for the SERVER and auth — keep the
client that lean. Deploys to Vercel zero-config; a Node/`ws` authoritative game server on
Fly; Electron wrapper for the desktop build.

**The app brand is DSIM; a game is a "season" (`src/seasons.ts`).** Keep them separate in
UI copy — DECODE/Chain Reaction are what is currently loaded, not the product name.

> Read this top-to-bottom once. The **Shared core** rules apply to BOTH games; each game
> then has its own section. When you touch a game, check whether the thing you're editing
> is shared (`src/sim/`, `src/config.ts`) or game-owned (`src/games/<id>/`) — that
> distinction is the single most load-bearing fact in the repo.

## Session protocol

**At the end of every working session, write/refresh `HANDOFF.md`** (repo root): current
state (is the build green?), what was finished, exact next steps, and gotchas. Read it at
session start if it exists — it may describe uncommitted mid-refactor state. HANDOFF is a
reverse-chronological log; prepend a new dated section and demote the old "READ FIRST".

## Commands

- `npm run dev` — dev server (localhost:5173)
- `npm test` — **headless sim verification** (`scripts/smoke.ts`, 564 checks, BOTH games).
  Run this after ANY change to `src/sim/`, `src/config.ts`, or `src/games/`. It is fast and
  catches almost everything. **Add a check per behavior change.**
- `npm run test:mm` — **matchmaker verification** (`scripts/mmsmoke.ts`, 36 checks, no DB or
  sockets — injected clock + `stage`). Run after ANY change to `server/matchmaking.ts`. Kept
  out of `npm test` on purpose, same reasoning as `contrast`: a red `npm test` must keep
  meaning "physics broke".
- `npm run build` — tsc (strict) + vite build. Run before claiming work done.
- `npm run server:check` — typecheck the server against the shared sim (`tsconfig.server.json`).
- `npm run contrast` — WCAG audit of the palette (`scripts/contrast.mjs`, 175 pairs, light +
  dark, no deps). Run after ANY colour/token edit. Not wired into `npm test` on purpose: a red
  `npm test` must keep meaning "physics broke".
- `npm run dbtest` — **database + payments verification** (`scripts/dbtest.ts`, ~61 checks).
  Boots **PGlite** (Postgres 17 in WASM, a devDependency — there is no Postgres on a dev box),
  runs the REAL migrations and the REAL `server/db/repo.ts` against it, and asserts the Ko-fi
  webhook's idempotency, the claim race, the auto-renewal path, the tier policy, admin
  grant/revoke, and account deletion's cascade. Run after ANY change to `server/db/`,
  `server/kofi.ts`, or a migration. Same rule as `contrast`: deliberately NOT in `npm test`.
  `server/db/pool.ts` exposes a structural `DbPool` + `setPoolForTests` so the swap is possible;
  production still builds a real `pg.Pool`.
- `npm run shiftaudit` — layout-shift audit (`scripts/shiftaudit.cjs`, Electron). Needs a
  build + `npx vite preview --port 4173` in another shell. Forces `:hover`/`:active` and the
  `on`/`primary` state classes on every interactive element across 10 routes + the live HUD,
  in BOTH themes, and asserts nothing outside that element's own subtree moves. Pressables must
  move via `transform`/`box-shadow`, never a border or margin that appears on hover.
- `npm run server` / `server:start` — the authoritative game server locally.
- `npm run electron` / `npm run dist` — desktop shell / installers (`release/`).
  **Desktop builds MUST be built with `ELECTRON=1`** (relative asset base — see Gotchas).

## Repo map

```
src/
  config.ts        SHARED constants: robot/drivetrain/motor balance + ALL DECODE geometry
  types.ts         World / RobotState / RobotSpec / Artifact / BallState (shared shapes)
  math.ts          rot/clamp/hyp + the deterministic trig wrappers (dsin/dcos/datan2)
  game.ts          GameController: rAF loop, fixed-timestep stepping, predict+reconcile, HUD
  settings.ts      GameSettings + coerceSettings (localStorage, field-by-field validation)
  seasons.ts       app brand + the SEASON/GameId registry
  sim/             SHARED deterministic core (see below) — DECODE's rules also live here
  games/
    types.ts       the GAME-ABSTRACTION seam (DOM-free): GameSimModule, StaticSpec, bounds
    module.ts      GameModule = GameSimModule + canvas renderers + builder/HUD spec
    index.ts       CLIENT registry (moduleFor/gameOf) — falls back to DECODE
    sim.ts         SERVER-SAFE registry (simModuleFor/simGameOf) — no DOM imports
    decode/        thin: points at src/sim + src/render (DECODE is NOT relocated)
    chain/         Chain Reaction: config/spawn/step/play/state/beams/penalties/mounts/draw*
  render/          DECODE canvas renderers + the shared camera/robot/wheel drawing
  ui/              React menus, HUD, leaderboard, lobby (read-only over world state)
  input/           keyboard/gamepad → RobotCommand (+ rebindable bindings.ts)
  net/             protocol / transport / lobbyClient / serverSession / sanitize
server/            Node + ws authoritative rooms, Neon Postgres repo, Glicko-2 ranked
scripts/           smoke.ts (the real test suite), contrast.mjs, shiftaudit.cjs, fly-deploy.sh
docs/              decode-reference.md (field sources), netcodeplan.md (roadmap), deploy.md
```

---

# The game-abstraction seam

`src/games/types.ts` defines it. Read that file before adding a game or moving code.

- **`GameSimModule`** (DOM-free): `id`, `scored`, `startLegality`, `bounds`, `colliders`,
  `createWorld`, `step`. This is all the authoritative server and headless smoke need.
- **`GameModule`** (`module.ts`) = `GameSimModule` + `drawField`/`drawRobot`/`drawBalls`/
  `drawOverlays` + `ui` (`showScoreHud`, `startEditor`, `intakes`). Client-only.
- **Two registries on purpose**: `games/index.ts` (client, full) and `games/sim.ts`
  (server-safe). The server importing the client registry would drag in canvas code.
- Both resolvers **fall back to DECODE** for an absent/unknown/missing `game` — that is the
  single back-compat rule (old worlds/snapshots/replays carry no `game` field).
  **`'decode'` must always be registered.**
- Modules emit **plain-number collider specs** (`StaticSpec`), never Rapier handles.
  `physicsEngine.ts` owns RAPIER and turns specs into bodies. A game with a different field
  size just works, because the shared Rapier solve + camera are parameterized on
  `bounds`/`colliders`.
- `World.game: GameId` tags a world; `GameSettings.game` is the player's current pick.
  DB rows, leaderboards, records, and ranked periods are **keyed per game** already.

**Rule of thumb when adding behavior:** if it would be true of any FTC-style game (drive
feel, robot-robot shove, match phases, HUD chrome, netcode) it belongs in the shared core;
if it names a game element (artifact, gate, particle, catalyst, beam) it belongs in
`src/games/<id>/`.

---

# Shared core (both games)

## Determinism — the non-negotiable

- **`src/sim/` is a pure deterministic state machine.** No DOM, no clock, no `Math.random`,
  no `Date`. It consumes per-tick `RobotCommand`s keyed by robot id and a seeded mulberry32
  PRNG stored in `world.rngState`. The same rule binds `src/games/*/` sim code.
- Fixed timestep 60 Hz (`SIM_DT` = 1/60, `MAX_STEPS_PER_FRAME` 5); rAF render loop in
  `src/game.ts` (`GameController`). HUD is React, polled at 10 Hz from `getHud()`.
- All game state must be **plain JSON** (`world.chain`, `world.penalties`, …) so snapshots,
  reconcile, and replays hold.
- `dsin`/`dcos`/`datan2` (`math.ts`) exist from the old cross-machine-lockstep era. Under
  server authority they are no longer a *correctness* requirement, but **they stay in
  `src/sim` until the Rapier ball port lands** — do not rip them out yet.

## Physics

- **ROBOT collision is Rapier 2D** (`@dimforge/rapier2d-compat`). `src/sim/physicsEngine.ts`
  `solveRobots()` rebuilds a fresh Rapier world each `step()` (stateless → reconcile/
  determinism safe, no WASM leak), owns robot translation + velocity (field colliders from
  the active module + mass-weighted robot-robot + velocity-kill), and writes `pos`/`vel` back
  into the canonical `RobotState`. The bespoke square-up torque + `rrContacts` stay in
  `physics.ts`. `RAPIER.init()` is async → **`initPhysics()` must be awaited** in smoke, the
  server, and `main.tsx` before any step.
- **BALLS/PARTICLES are still bespoke** (Rapier slice 2, deferred). Key gotcha: the world is
  in **INCHES** → set `integrationParameters.lengthUnit` (see `PHYS_*` constants).
- Wall/structure contacts apply **TORQUE** (summed over touching corners) so a tilted robot
  squares up flush. Torque is PRESSURE-SCALED (`CONTACT_PRESS_GAIN`); a fast angled hit also
  injects spin (`CONTACT_IMPACT_SPIN`, scaled by torque×speed — it **must** scale with torque;
  a sign()-only kick once caused a numerical-noise spin-up on dead-center contacts). Flat-face
  alignment is capped at the REMAINING TILT (`flushErr` in `pushRobotAt`) so the heading never
  steps past flush and buzzes.
- `robotIntersectsRect` (SAT) exists because thin zones can be fully covered by a robot body
  with no corner inside.

## Robot spec, builder, and drive feel

`RobotSpec` is shared by both games; some fields are game-specific and optional.

Shared: `name`/`teamName`/`teamNumber`, `length`, `width`, `intake` (`IntakeStyle`), `massLb`
(20–42), `drivetrain`, `driveRpm` (200–600), `flywheelInertia` (0–1), `canSort`.
Chain-only (optional, defaulted in `coerceSpec`): `ballStorage`, `groundClearance`,
`scoreMode`, `chainIntake`, `intakeMount`, `shooterMount` (+ two deprecated mirrors).

- **`coerceSpec` (`src/sim/spawn.ts`) is the single sanitizing chokepoint** and is
  IDEMPOTENT — run at settings load, server ingress (`net/sanitize.ts`), AND `createWorld`.
  Its clamp order is deliberate and mirrors the builder's dependency graph:
  intake+drivetrain → size, drivetrain → rpm, inertia → 0..1, drivetrain×inertia → mass.
  Specs arrive from hand-editable localStorage AND untrusted clients — people have spoofed
  oversized/NaN robots. **Every new spec field must be clamped/enum-checked here.**
- The builder's slider envelopes come from the SAME limit functions (`massLimits`,
  `rpmLimits`, `lengthLimits`, `widthLimits` in `drivetrain.ts`), so the UI can't offer an
  illegal value the coercer would then rewrite.

### Drivetrain feel — REAL-MOTOR model (`BALANCE_VERSION` 2)

ALL drivetrain/motor knobs live in ONE documented `DRIVETRAIN & MOTOR BALANCE` block in
`config.ts` (edit there; `npm test` prints the `driveSummary` table so a tweak's effect is
visible). Grounded in real hardware: `SPEED_PER_RPM` is DERIVED from a **104 mm goBILDA
wheel** free-speed geometry × `DRIVE_EFFICIENCY` 0.95 → **~89 in/s at 435 wheel-rpm**. The
modeled motor is the **MATRIX / goBILDA 5000-series 12VDC** brushed motor (5800 rpm free,
20.45 oz-in stall) — its LINEAR torque–speed curve IS the `motorStep` model.

- **PEAK accel is TRACTION-limited (μ·g), NOT motor-limited** — stall torque could give
  ~460 in/s² but the wheels slip first, so `BASE_DRIVE_ACCEL` 240 × accelMult lands each
  drivetrain at its μ·g ceiling (tank μ≈0.9 → 348 … x-drive omni μ≈0.45 → 175).
- **MOTORS follow a torque–speed curve** (`motorStep`, used for fwd/strafe/turn): full stall
  accel off the line, falling ~linearly to `MOTOR_MIN_TORQUE_FRAC` at free speed
  (`MOTOR_TORQUE_CURVE` 1.0 = physically real), so speed approaches the top asymptotically
  (~0.5–0.8 s to 95%); braking pulls harder (`MOTOR_BRAKE_MULT`).
- **Mecanum is realistically LOSSY** (per GM0 rollers): speed 0.87 / strafe 0.80 / accel 0.88 /
  **push 0.65** — it loses straight-line speed AND gets shoved by tank. Realistic orders:
  speed tank>swerve>mecanum>xdrive · push tank>swerve≫mecanum>xdrive · accel
  tank>swerve>mecanum>xdrive (@435 rpm: speed 89/84/77/74 in/s; peak accel 348/312/211/175).
- Four wheel-saturation models: mecanum/xdrive `|f|+|s|+|ω|`, tank `|f|+|ω|` (strafe DEAD —
  left stick/W-S left side, right stick/Up-Down right side), swerve `hypot(f,s)+|ω|`.
  `maxTurn = wheelSpeed / halfDiagonal`, capped at `TURN_MAX_SPEED`. The mecanum
  wheel-saturation model is correct physics — keep it.
- **SWERVE = FOUR INDEPENDENT modules** (`RobotState.moduleAngles[4]`, FL/FR/BL/BR): real
  per-module inverse kinematics (target vel = translation + ω×r), WPILib-style module
  optimization (a >90° change FLIPS the pod + REVERSES drive, `MODULE_SLEW_RATE` 7), and
  forward kinematics of the pods for the achieved chassis motion. **Balancing weakness is
  WOBBLE, not weight** (a heavy-swerve nerf was tried and reverted): each module's control
  loop is imperfect (`SWERVE_WOBBLE_AMP`/`_FREQ`, INDEPENDENT phase per pod) → real path
  drift + yaw wobble driving straight. X-drive renders as a proper X (omnis at ±45°).
- **NICHES:** tank raw power/no-strafe · swerve strongest-but-imprecise · mecanum
  light/instant/precise but weaker · x-drive deliberately-weak novelty.
- **PUSHING POWER = effective Rapier shove mass** (`physicsEngine.ts` `setMass`):
  `massLb · pushMult · rpmPush · (1−powerDraw)`, `rpmPush = clamp(REF_DRIVE_RPM/driveRpm,
  0.6, 1.8)` — geared-for-speed ⇒ less torque. `driveParams.accel` uses REAL mass, so
  inflating shove mass never touches linear accel.
- **Per-drivetrain CLAMPS** live in `DRIVETRAIN_LIMITS`; the mass FLOOR is raised by flywheel
  inertia (`INERTIA_MASS_FLOOR` 14) via `massLimits(dt, inertia)`.

## Controls, settings, audio

- **Controls are fully rebindable** (`src/input/bindings.ts`, `src/ui/ControlsSection.tsx`):
  every keyboard action, gamepad buttons, AND the drive/turn stick assignment. Escape is
  reserved (menu/cancel — never bindable). Conflict policy: a rebound key is STOLEN from its
  old action (may show UNBOUND). Defaults: WASD drive, Q/E or ←/→ turn, Shift/K intake,
  Space fire, C catalyst (CR), F flip-front, P park, Enter start, R restart.
- "Flip front" reverses robot-centric drive so the shooter side leads — applied at INPUT level
  in `GameController`, sim untouched; REVERSED chip in the HUD.
- All `GameSettings` persist to `localStorage['decodesim.settings.v1']` via `src/settings.ts`
  (validated field-by-field on load — corrupt/stale data falls back per field) and sync to
  Postgres per account.
- **Assists are menu-only** (field/robot-centric, auto intake, auto fire) — NO in-game toggle
  keybinds. Auto-fire/intake must respect match phases (no firing in `pre`/`transition`).
- **AIM ASSIST IS ALWAYS ON, in BOTH games, and is NOT configurable.** `coerceAssists`
  (sim/spawn.ts) forces `aimAssist` true — deliberately in the SHARED coercer, not the UI,
  because a stored `false` can arrive from localStorage, a synced account blob, a saved robot
  slot, or the wire, and forcing it only in the menu would strand anyone who had switched it
  off with no control to switch back. The FLAG and both sims' manual-aim branches stay
  (DECODE's chassis-locked turret in `updateRobotActions`, Chain's `chainAimAssist` guard),
  tested by setting `r.aimAssist` on the spawned robot — restoring the option is deleting one
  line in `coerceAssists` and putting the toggle back in `Menu.tsx`. A DECODE "auto align"
  assist (hold fire → steer the chassis onto the shot) was built and then REMOVED: with the
  turret always tracking there is nothing for it to do. Chain's turretless hold-to-steer is a
  different thing and STAYS — see `chainAimAssist`.
- Audio: real FIRST field sounds (`public/sounds`, from Team254/cheesy-arena) + an announcer
  VOICE via speechSynthesis. Countdown digits must interrupt in-flight speech to stay on the
  visual beat. Menu has Sounds ON/OFF (master) + Voice lines ON/OFF (falls back to beeps).
  Shoot/intake/gate SFX are SYNTHESIZED (WebAudio, `sfx*` in `audio.ts`) and triggered by
  edge-detection on world state in `GameController.handleActionAudio` — **the sim core stays
  event-free for these**.

## HUD / UX product rules

- HUD mimics the FTC live scoring display: red|timer|blue bar at the BOTTOM.
- **No popup toasts over the field** — events go to the muted left-edge log; zone status lives
  in the top-right chips.
- Visible MENU/RESET buttons on the game screen (don't rely on Esc/R knowledge); "MATCH
  BEGINS IN" text lead-in before the 3-2-1 digits.
- END GAME at 20 s left (`ENDGAME_START` / `CHAIN_ENDGAME_S`): warning cue + HUD label/tint.
- Games opt into chrome via `GameModule.ui` (`showScoreHud`, `startEditor`, `intakes`).

## Netcode (server-authoritative + client prediction)

The old P2P lockstep/mesh/TURN/Supabase-lobby is DELETED. Full roadmap: `docs/netcodeplan.md`.

- **`server/`** (Node + `ws`, run via `tsx`) imports the SHARED sim (no fork) and runs a
  fixed-`SIM_DT` authoritative loop per room: ingest each client's latest `RobotCommand` by
  robot id, `step(world, SIM_DT, inputs)`, broadcast a **delta snapshot every 2 ticks
  (30 Hz)**. `server/room.ts` = lobby + match + host lifecycle + deterministic drop.
  `SNAPSHOT_INTERVAL` was dropped from 60 Hz after profiling (the lag was NETWORK, not CPU;
  halving snapshot bandwidth + `setNoDelay(true)` to kill Nagle was the fix).
- **`src/net/protocol.ts`** — JSON `ClientMsg` (join/update/start/restart/input) and
  `ServerMsg` (welcome/roster/matchStart/snapshot/drop), plus quantize helpers. The client
  must PREDICT on `localizeCommand(cmd)` (exactly what the server decodes).
- **`game.ts` `stepServer`** applies its OWN command locally + `sendInput`, buffering it; on a
  snapshot it snaps `this.world` to the authoritative world and REPLAYS buffered inputs past
  `serverTick` (`reconcile`). Only the local robot is predicted. **`session: null` ⇒ the solo
  path is bit-identical.**
- **SMOOTHING is Minecraft-style entity INTERPOLATION, not extrapolation** (`displayWorld`/
  `snapBuf`/`renderTick`): the render clock runs a few ticks behind the newest snapshot and
  REMOTE robots lerp between the two bracketing snapshots. The LOCAL robot stays predicted
  with a decaying `localSmooth` error offset (cosmetic only — never touches `this.world`).
  **BALLS are NOT interpolated** — they spawn/despawn and collide, and lerping ghost-cloned
  fresh balls and blended colliding balls through each other.
- **DELTA SNAPSHOTS**: `slimWorld`/`unslimWorld` strip static robot `spec` (client re-injects
  from setups) + delta the balls (send the id ORDER every frame — determinism — but only
  CHANGED ball data); reconnect re-primes with a keyframe.
- **CONNECTION-QUALITY HUD**: `ping`/`pong` probe → smoothed RTT; snapshot arrival rate +
  inter-arrival JITTER measured client-side → SMOOTH/OK/CHOPPY dot. **Jitter is the real
  choppiness signal** — surface it when diagnosing lag reports.
- **RECONNECTION**: the server holds a dropped slot `RECONNECT_GRACE_MS` (`detach`/`reattach`/
  `checkGrace`), the transport auto-reconnects, the session re-sends `rejoin`.
- **DEPLOY**: Fly app `dohun-sim-decode`, `Dockerfile` + `fly.toml` + `docs/deploy.md`,
  `GET /health`; `ws` + `tsx` are runtime `dependencies`. Protocol: commit → **`./scripts/
  fly-deploy.sh`** → verify `/health` → Vercel auto-deploys clients.
  **NEVER deploy with a bare `flyctl deploy`** — fly.toml expresses only ONE `[[vm]]` size, so
  a bare deploy re-applies `shared-cpu-4x` to EVERY machine and silently upsizes the cheap
  satellites. The wrapper re-shrinks them; verify with `fly machine list -a dohun-sim-decode`.
- **The one Fly app serves EVERY client version** (alpha/beta/main bake the same
  `VITE_GAME_SERVER_URL`), so protocol changes MUST stay backward-compatible. New clients
  advertise `caps` (`CLIENT_CAPS`) on `join`/`queue` and the server feature-gates on them.
  With that discipline you don't have to sync branches before deploying the server.
  **A new `RobotSpec` field is NOT a protocol change** — but an older server's `coerceSpec`
  will drop it, so mirror it onto an older field when one exists (see CR mounts).

## Accounts / ranked / leaderboards / records

Neon Postgres via `server/db/` (`repo.ts` + `migrations/`), written at match end OFF the hot
path. **Ranked is Glicko-2** (`server/ranked.ts`: rating + RD + volatility, `SCALE 173.7178`,
`CENTER 1500`, provisional RD shown with "?"), decided AFTER the score SETTLES
(`MATCH_SETTLE_S` — late-draining balls finish scoring before finalize); an opponent who
LEAVES mid-match is retained (`departed`) so the match still rates. **SOLO RECORD RUNS**
(score-attack): results show NET score (earned − own penalties), no opponent/winner, and
PB / WR / global rank per **mode × drivetrain × season**. Boards, records, and Act→Season
periods are **keyed per game**, so DECODE and CR never share a leaderboard.
**ADMIN MENU** (`src/ui/Admin.tsx`, `/admin`) gated on the signed-in UUID (`ADMIN_USER_IDS`;
the server enforces every action independently). **VERSION GATE**: a new build is detected
(`__BUILD_ID__` → `/version.json` poll) and forces a refresh when a player STARTS a run
(never mid-run) — no "play anyway", everyone must be on the same version for multiplayer.

**STAFF ROLES — owner + admin badges, and perks, DONE.** `profiles.role`
(`0020_staff_roles.sql`) is null | 'owner' | 'admin'. It is a **PROJECTION** of
`ADMIN_USER_IDS` / `OWNER_USER_ID` (`OWNER_USER_ID` defaults to the FIRST id in
`ADMIN_USER_IDS`), reconciled by `syncStaffRoles` once per boot after `migrate()` — the
env stays the source of truth; the column exists so the badge can be JOINED by the
leaderboard/roster queries instead of post-processed row by row (or the admin list
leaked to clients). **The sweep is SYMMETRIC** — an id removed from the env loses the
badge and the perks. **THE PERK IS ONE PREDICATE**: `SUPPORTER_COL` in repo.ts is read
by the ad gate, the cosmetic chassis colours, the saved-start cap, `/api/user/
entitlements` AND the badge, so `role in ('owner','admin')` is folded into that single
expression — never add a second "is staff entitled" check, extend that one. TWO places
deliberately keep the PAID predicate instead, because the entitled one would mislead
there: `searchProfiles` (the admin console's grant/revoke row — a colleague must not
read as a supporter with no expiry when you are deciding whether to comp months) and
the Donate page (staff get their own panel; the supporter one would say "through -"
and nag them to link a Ko-fi account that will never pay). `getSupporter` returns
`supporter: true` with `supporterUntil: null` for staff — that shape is intentional.
`LobbyPlayer.role` is **server-authored** exactly like `supporter` (a self-declared
"owner" beside a driver's name is an impersonation primitive). UI: ONE
`SupporterBadge` renders owner ★ > admin ◆ > supporter ♥ — exactly one, since staff are
also `supporter: true`. **Badge colours must be SATURATED IN BOTH THEMES**: the audit
checks the glyph against its own fill, NOT the badge against the card behind it, so the
lavender pastel (#34305c in dark) passed contrast while being invisible on the dark
panel. Distinguish by SHAPE as well as hue.
**THE BADGE GOES ON EVERY NAME**, and the failure mode is SILENT — a query that just
doesn't project the two columns still compiles and still renders, only bare, which is how
the ranked board sat badge-less next to a record board that was fine. So: `badgeCols(alias
[, prefix])` in repo.ts writes the pair once (the `prefix` form names a SECOND person in
the same row — a duo partner — as `partnerRole`/`partnerSupporter`, and `coalesce(…,false)`
is load-bearing on the LEFT JOIN a solo run takes), and client-side every row type
`extends BadgeFields` (`src/net/api.ts`) instead of re-declaring the fields. Surfaces
covered: both leaderboards (records incl. the duo partner + ranked, live AND archived),
career/profile (the `CareerPanel` name chip — the ONLY place My Stats prints who you are),
match history (every participant + record-run partners), friends/requests/challenges (both
directions), and username search. The friends poll used to skip the columns deliberately;
it no longer does — same already-joined row, and a badge that shows on the leaderboard but
not beside the same person in your friends list reads as a bug.
**A BADGE IS DECORATION BESIDE A NAME, NEVER PART OF ONE**: render it as a SIBLING of the
name element, because the name carries the hover underline (`.lb-name-h`, `.mh-player.link`)
and the ellipsis (`.fr-name`) — nested inside, it gets underlined with the name or
truncated with it. `.fr-nameline` exists for the stacked name-over-subline rows.
Tests: 36 checks in `npm run dbtest`.

**BACKGROUND RANKED QUEUE, LIVE (no flag).** The queue used to die when you left the
matchmaking screen — that screen owned the socket (`useEffect(() => teardown, [])`),
so queueing locked you out of the rest of the app, which is what stopped people
queueing at all. Now `Matchmaking` PARKS the live `LobbyClient` in `queueKeeper.ts`
(a module singleton — it must outlive the tree that made it) on unmount mid-search,
and ADOPTS it back on remount. **Nothing about how the socket is opened, queued or
handed to a match changed — only how long it lives**; that was the design constraint,
because this path costs real ELO when it breaks. `LobbyClient.on()` REPLACES, so both
hand-overs are plain re-registration. Two cases still tear down for real rather than
park: a match that already STARTED (the session owns the transport) and an in-flight
reconnect to the host region (`assigning`). `QueueBar` shows bucket/elapsed/cancel
while parked; match-found takes the screen back WITHOUT asking (the server forfeits
the slot after `RANKED_JOIN_GRACE_MS`, so a dialog is just a slower way to lose) and
DISCARDS any run in progress. An assignment arriving while parked is remembered on
the parked state — its event has already fired and won't fire again for the adopting
screen. **`updateQueue` must return a NEW object**: it mutated in place at first, so
`useSyncExternalStore` re-read an identical snapshot, skipped the render, and the
takeover silently never fired (the bar still looked right — it repaints on its own
1s timer). A smoke check asserts snapshot IDENTITY changes. `exposeForTesting` is
`import.meta.env.DEV`-only; a shipped bundle must never carry a handle that can
cancel a stranger's queue. **NOT yet validated end-to-end** — that needs two
signed-in accounts completing a rated match.

**PLAY A FRIEND — challenges (chess.com's model), DONE.** A challenge (`room_invites` +
migration `0019`) carries a **`format`**: `casual1v1`/`casual2v2` (a `versus` room),
`duorecord` (a `record`/`duo` room), or the two RATED ones. Rating is only ever applied to a
matchmaker-STAGED room (`Room.ranked` ← `pending_matches`), so a code-joined room can NEVER
rate — the rated formats therefore resolve through the MATCHMAKER, not through a room code.
The challenge's `room` column doubles as a **party token** both sides send on `queue`
(`party`/`partyOnly`/`partyFormat`; `RATED_FORMATS` in protocol.ts maps format → mode +
partyOnly). The matchmaker pairs on **UNITS** (`groupUnits`), never individual entries:
`rated1v1` is a CLOSED party (the token IS the match — no strangers, and the search radius is
skipped since they chose each other; the channel+build bucket still applies), `ranked2v2` is a
PREMADE that queues into the OPEN pool and is kept on one alliance by `allianceOrder`. That
same ordering needs NO 1v1 exception: there the party is the two opponents and half=1 splits
them correctly. **`partySize` (2) is load-bearing** — the members enqueue seconds apart, and
without it the first arrival reads as a complete unit and is swallowed by an open group.
**The token is VERIFIED, never trusted** (`challengeParty` → `verifyParty`): it resolves
against the real challenge row and only answers for an account named on it, so two clients
can't agree on a string and stage themselves a rated match, and a guessed token can't join a
pair. A token that fails is REFUSED, never downgraded to an open queue. Rated formats are
gated on **`SERVER_CAPS`** (`/api/presence` `caps`, read via `serverCaps()`) — the first
server→client capability, and NOT optional: an older server IGNORES the party fields rather
than rejecting them, silently matching two friends against strangers. Lifecycle is
Accept/**Decline** (decline MARKS `declined` so the sender is told once, then their client
cancels the row; dismiss stays a silent clear), the sender SEES their outgoing challenge
(`listFriends`'s `snt` CTE → `sent`) and can cancel it, and one live challenge per direction
(`inviteToRoom` replaces — stacked rated rows would let someone accept an abandoned token).
`src/ui/challenge.ts` `challengeOf` is the ONE place deciding lobby-vs-queue. Tests:
**`npm run test:mm`** (`scripts/mmsmoke.ts`, 36 checks, injected clock + `stage`, no DB) —
party pairing fails SILENTLY, so it is covered there rather than by a live two-account run.
NOTE `enqueue` matches synchronously but STAGES asynchronously; assertions must await a
microtask flush. Rated friend games are farmable by a colluding pair and deliberately
unmitigated (as chess.com); damp repeat-opponent deltas in `ranked.ts` if it shows up.


---

## Monetization (branch `monetization`) — ads + supporter tier

Not yet deployed. `HANDOFF.md` has the full write-up; the load-bearing rules:

- **`src/ads/adsense.ts` is the single gate.** Ads are OFF unless `VITE_ADSENSE_CLIENT`
  is set, and are suppressed unconditionally in the Electron build (AdSense forbids app
  wrappers), on touch, and for supporters. `AdsProvider` FAILS CLOSED — ads stay off
  until the entitlement check settles, so a supporter never sees a flash of them.
- **Ads are NON-PERSONALIZED by default and tagged TFUAC.** DSIM simulates FTC
  (grades 7–12) and the sim is fully playable SIGNED OUT, so most impressions carry no
  age signal. `VITE_ADSENSE_PERSONALIZED=1` is a deliberate opt-in. TFCD (COPPA) stays
  off: the terms set 13+, so asserting child-directed would be inaccurate, not cautious.
- **A CMP (Google Funding Choices) is REQUIRED, not optional** — without a certified CMP
  Google serves EEA/UK/CH users no ads at all. It loads with the client id; the message
  itself is authored in the AdSense dashboard. The footer "Privacy & cookie settings"
  link must keep existing (consent you can't withdraw isn't consent).
- **Three ad units, each with its own slot id**: `menu` (shell pages) and `results`
  (post-match) are SAFE; `game` (columns flanking the live field) is the risky one —
  60 Hz canvas + AdSense's 150px game-clearance rule. **Do not enable
  `VITE_ADSENSE_SLOT_GAME` without first comparing p95 frame time via `?perf=1`**
  (`GameController.getFrameStats`).
- **`/ads.txt` is GENERATED** from `VITE_ADSENSE_CLIENT` in `vite.config.ts` — never
  commit one, it would drift.
- **Supporter tier is Ko-fi.** `server/kofi.ts` is a PURE policy module (no DB, no
  import-time env) deciding what a payment buys: a subscription payment is always
  exactly 1 month; a one-off buys `floor(amount/price)` months, capped; a foreign
  currency buys nothing. Months are priced ONCE at webhook time and stored on the row.
- **`profiles.kofi_email` is what makes a membership RENEW.** The first manual claim
  links the payer address; every later webhook from it grants automatically. The UNIQUE
  index is also the only thing stopping one subscription covering many accounts.
- **Every write to `supporter_until` logs a `supporter_grants` audit row** (source =
  kofi/admin/revoke). Two actors can move that column; "why does this account have a
  membership?" has to stay answerable.
- **Perks are cosmetic/convenience ONLY** — never anything affecting how a robot drives
  or scores. That is a product rule AND a statement in the terms. All four advertised
  perks are BUILT (badge, ads-off, 6 saved starts, chassis colours); **do not list a
  perk on the Donate page before it exists.**
- **The saved-start PERSIST cap is the SUPPORTER ceiling**
  (`MAX_SAVED_STARTS_SUPPORTER`), in `coerceSettings` AND `saveStart`. Only the editor's
  Save button applies the free cap. Sanitizing to the free cap would DELETE a supporter's
  poses before the entitlement resolved, and on every lapse.
- **The chassis colour is an ALLOWLIST key** (`CHASSIS_COLORS`), never a free colour
  string on the wire, and it recolours only the FILL — alliance identity is the OUTLINE.
- **`LobbyPlayer.supporter` is SERVER-AUTHORED** (set at join). `sanitizePlayer` is an
  allowlist and `PlayerPatch` is a `Pick`, so a client cannot self-declare a paid badge.
- ⚠️ **`LEGAL_OPERATOR`/`LEGAL_JURISDICTION` in `src/legalText.ts` are PLACEHOLDERS.**
  Until filled, the Terms page shows a visible warning to every visitor. Fill them
  before taking a payment; do not guess them from a timezone or an email domain.
- Analytics (`src/analytics.ts`, `VITE_ANALYTICS=1`, Vercel Web Analytics — cookieless).
  **Rule: no identifiers in any event payload** — counts and enums only.

---

# GAME: DECODE (`decode`)

DECODE's rules live in **`src/sim/`** and **`src/config.ts`** (they predate the seam and were
deliberately NOT relocated); `src/games/decode/` is a thin module that points at them.
`src/config.ts` is the single source of truth for ALL DECODE geometry, physics, and scoring
constants. Tune there, not inline.

## Field geometry — verified, do not "fix" from intuition

Measured from the official Competition Manual Section 9 figures (extracted the embedded
images from the PDF and pixel-measured them). See `docs/decode-reference.md`. Facts people
get wrong:

- World frame: origin center, +x = audience's right, +y away from audience. Inches.
- **Goals are cross-court**: BLUE goal far-LEFT corner (tag 20), RED far-RIGHT (tag 24).
  Red alliance wall = left (x=−72), blue wall = right (x=+72).
- Driver view rotation: `viewAngleOf()` in `src/sim/field.ts` — blue looks from the right wall
  (−π/2), red from the left (+π/2). Camera AND driver-frame input both use it.
- Launch zones are **shared** (not per alliance): big triangle `y >= |x|` (apex at field
  center) + small audience triangle. Any robot part inside ⇒ may launch.
- Each goal's classifier channel runs down the adjacent side wall to a gate near mid-wall
  (y≈0); released/overflow balls roll out beneath it toward the audience.
- **GOAL FOOTPRINT is a right triangle in the corner, NOT a symmetric 45° face**
  (`smoke.ts` asserts it): legs flush along the walls — `GOAL_FACE_WIDTH` 26.5" along the far
  wall, `GOAL_DEPTH` 18.3" down the side wall, right angle at the field corner. The FACE
  robots shoot at is the hypotenuse (`GOAL_FACE_LEN` ~32.2", ~34.6° off the far wall).
  `goalTriangle`/`goalFacePoints`/`goalFaceNormal` (unit normal into the field)/`goalCenter`.
  **`goalLineValue` returns TRUE perpendicular inches** from the face (>0 behind, inside the
  footprint; <0 field side) — do NOT divide by SQRT2 anywhere.
- Spike marks: horizontal 10" tape at x=±48.5 — ONE tile (~23.5") from the side wall; rows
  y = −35.5 / −12.8 / +11.1, 3 balls per row (GPP / PGP / PPG near→far). BASE zone 18×18,
  corners at (d·24,−48) & (d·42,−30), `BASE_CENTER` (d·33,−39), d = driverSide (blue +x,
  red −x). Loading zones = audience corners, 23×23.
- GATE ZONE: the real marking is TWO thin alliance-colored tape LINES, 10" long, 2.75" apart
  (`GATE_TAPE_W`), starting at the classifier edge (x=±66) and running into the field
  (`gateTapeSegments`). The larger 10×5 `gateZone()` INTERACTION rect works the gate and is
  intentionally undrawn (feel > strict tape).
- DEPOT tape runs flush ALONG the goal face (the hypotenuse) from the far-wall corner to the
  classifier edge — it does NOT run through the channel (`depotSegment` clips at the
  classifier). Band `DEPOT_DEPTH` 6"; band fill is not drawn (white tape line drawn last).
- SECRET TUNNEL: `TUNNEL_W` 6.125" (its own constant, not `CLASSIFIER_W`). `tunnelStrip(X)` is
  beneath X's goal but belongs to the OPPOSING alliance (whose drive team is on that wall).
- ALLIANCE (drive-team) AREAS are NOT DRAWN (removed to enlarge the field); the `allianceArea`
  helper stays (96×54 outside each wall) for zone logic. `VIEW_MARGIN` 14; the camera reserves
  HUD bands (`HUD_TOP`/`HUD_BOTTOM` in camera.ts) so chips never cover the field.

## START POSITIONS — configurable + rulebook-constrained (G304)

A robot may start on any pose satisfying **G304** (Section 11): (A) footprint OVER a white
LAUNCH LINE, (B) TOUCHING the GOAL or the FIELD perimeter, (C) fully within its own half
(blue x≤0 / red x≥0) — PLUS the collision box may only rest AGAINST a solid, never penetrate
it. All in `src/sim/field.ts`: `evalStartPose(spec,pose,a)→StartLegality` (footprint =
chassis+intake via `footprintExtents`/`footprintCorners`, SAT tests), `snapStartToLegal`,
`mirrorStartPose` (canonical goalSide=+1 ↔ actual, self-inverse), `startPose(a,index,custom?,
spec?)`. Tolerances `START_TOUCH_TOL`/`START_PEN_SLOP`.

`START_POSES` (GOAL·FAR / AUDIENCE / GOAL·GATE) are **semantic ANCHORS resolved DYNAMICALLY
per chassis** via `presetPose(index,a,spec)` — a preset is legal at ANY size, not a fixed
coordinate. **Anchor index 0 & 1 MUST stay far apart** (a 2-robot alliance spawns slots 0/1 —
smoke-checked). Custom poses ride `RobotSetup.startPose`/`GameSettings.startPose`/
`LobbyPlayer.startPose`, sanitized by `coerceStartPose` + snapped legal at `coerceSetup`.

UI `src/ui/StartPositionEditor.tsx`: a CANVAS reusing the real `drawField`/`drawRobot`
renderers + drag/rotate + X/Y/heading inputs; snapping is OPT-IN (default OFF) and an illegal
pose is previewed red but NEVER saved. **Starts split CLOSE vs FAR** (by distance to goal):
a per-player SAVED library (`savedStartPoses{close,far}`) + `startMemory` + `startCat`, with
pure patch-helpers in `src/ui/startPositions.ts`. In a 2v2 the robot's role LOCKS the category
(1st on the alliance by clientId = CLOSE, 2nd = FAR). Editor gotcha: a preset pick must be ONE
settings patch (`selectStart`), never two `set()` calls (stale-closure overwrite drops one).
**ROLE is SWAPPABLE by mutual consent** (`useRoleSwap.ts` + `RoleSwapBar.tsx`): a two-flag
handshake (propose→accept; when both set, each client flips ITS OWN role, race-free). Decline
is LOCAL-only.

## Ball lifecycle (no teleporting — user is emphatic)

flight → (crosses opening plane, either direction) → **basin** (jumbles inside the goal wedge
with real containment/collisions, funnels to the SQUARE when slow) → **rail** (1D flow down
the classifier, gravity + contact stacking, position always continuous — hand-offs preserve
position and blend onto the rail line) → gate exit → ground. Overflow rides OVER the stack at
`OVERFLOW_Z` and always exits.

**Classified-vs-overflow is decided at CONTACT, not at hand-off** (user was explicit): a ball
boards the rail as `pending`, and only when it first meets the column (or gate floor) does it
commit — 9 retained below it at that instant ⇒ overflow (1 pt), else classified (3 pts).
Scoring happens at that decision moment, so a gate tap that drains in time SAVES an incoming
ball. A pending ball that flows out an open gate untouched classifies at exit.

Stray balls must never enter goal wedges or classifier channels (solid to balls), and no
collision may ever push a ball outside the field (final wall clamp pass). Balls have "mass"
feel: robot→ball contact is near-inelastic (`BALL_ROBOT_RESTITUTION`), and a ball PINNED
between chassis and wall transmits the refused push back onto the robot (`pushRobotAt`) — the
robot stalls on a dead-center pinned ball while off-center balls squirt out sideways. The pin
only transmits when the ROBOT drives into it (`BALL_PIN_PUSH_MIN_SPEED`).

## Gate physics (manual 9.8.3, `updateGates` in goal.ts)

The gate is a PHYSICAL class-1 LEVER, not a boolean: continuous `GoalState.gatePos`
(0 closed .. 1 lifted) + `gateVel` + `gateLatch`. **Geometry (Figure 9-15):** it HINGES at the
classifier edge where the gate-zone tape starts (|x| = `FIELD_HALF − CLASSIFIER_W`) — a SHORT
handle (`GATE_ARM_SHORT`) pokes OUT into the gate zone (what a robot pushes) and a LONG paddle
(`GATE_ARM_LONG` = `CLASSIFIER_W`) lies ACROSS the channel, covering the artifacts.

- **Opening is ONE-DIRECTIONAL** (`pushingGate`): only a STRAIGHT push toward the wall opens it
  (`velToward = r.vel.x·goalSide`); driving SIDEWAYS along the wall does not, and loitering
  does not.
- **A tap LATCHES it open** (`GATE_OPEN_LATCH_S`) so the driver need not keep pressing; resting
  against an already-OPEN gate RE-ARMS the latch (touch-hold). Released, the latch decays and
  it is **closed by gravity** — it SWINGS shut (`GATE_GRAVITY`/`GATE_CLOSE_MAX`), never snaps.
- **Flow holds an OPEN gate open** — a ball in the gateway suspends gravity (drains the whole
  column) but does NOT LIFT it: a ball reaching an almost-closed gate (below `GATE_PASS_FRAC`)
  can't reopen it, only a robot push can. `gateOpen` is DERIVED = `gatePos >= GATE_PASS_FRAC`.
- **The handle is a PHYSICAL one-way door** — a robot-only Rapier collider (`buildGateArms`),
  so a robot can't strafe THROUGH the closed lever; a straight push lifts `gatePos` and
  RETRACTS the collider so the opening robot glides in.
- **The lift is RAM-SPEED-SCALED and the retract is ANTICIPATED (no jolt):**
  `gateLiftRate(ramSpeed) = GATE_OPEN_RATE + GATE_OPEN_RATE_SPEED·ramSpeed`. `buildGateArms`
  runs one step BEFORE `updateGates`, so `gateColliderPos(world,dt,cmds,a)` anticipates the
  exact lift about to be applied and world.ts passes it into `solveRobots`→`buildGateArms` —
  the handle retracts on the SAME tick the push lands (this killed the old 1-tick jolt).
- Rendered (`drawGateArm`) top-down by FORESHORTENING each arm toward the pivot
  (`len·cos(gatePos·GATE_LIFT)`), the long paddle greening past the pass fraction.

## Shooter + intake (DECODE)

- **The shooter NEVER misses**: no dispersion; `solveShot` uses the MINIMUM-SPEED trajectory to
  the goal opening — the adaptive hood angle sweeps ~89° (near-vertical lob at point-blank)
  down to ~45° far out, so an exact finite solution exists at EVERY distance and the required
  speed is a SMOOTH function of distance (`v²=g·(dh+√(d²+dh²))`). The turret is always exactly
  on the lead-compensated solution (no slew limit). No aim ray drawn.
- **No flywheel spin-up before the FIRST shot** — the opening shot is always instant. BETWEEN
  shots the cadence is the intake preset's transfer interval (`INTAKE_PRESETS[*].fireInterval`:
  0.1 s, triangle 0.3 s) PLUS a flywheel-recovery term: `recovery = closeRecovery +
  FLYWHEEL_RECOVERY_MAX · shotNorm² · (1−inertia)`, where `shotNorm` ramps in only past
  `FLYWHEEL_CLOSE_SPEED`. FAR shots are slowed for low-inertia flywheels. **Close-range rapid
  fire carries a SMALL floor for near-zero inertia** (`closeRecovery = FLYWHEEL_CLOSE_RECOVERY
  · max(0, 1 − inertia/FLYWHEEL_CLOSE_INERTIA_KNEE)`): +0.04 s at inertia 0, fading to 0 by
  0.2 — a close-zone cycler wants a LITTLE inertia (~0.1–0.2), not 0. `r.fireReadyAt` gates it.
- **POWER DRAW**: a running intake plus the flywheel pull current off the drive motors. Two
  flywheel terms, both ×`flywheelInertia`: a small steady HOLD
  (`POWER_DRAW_FLYWHEEL_HOLD·spin`) and the DOMINANT SPIN-UP
  (`POWER_DRAW_FLYWHEEL_SPINUP·flywheelSpinRate` — the cost of ACCELERATING the wheel while
  driving AWAY from the goal; spinning DOWN is free). `flywheelSpin` ramps 0→1 with distance to
  the robot's OWN goal (`FLY_SPIN_NEAR`→`FLY_SPIN_FAR`); it seeds at the spawn-distance target
  so there's no phantom first-tick spin-up. `r.powerDraw` scales a LOCAL `driveParams` copy
  (speed/accel/turn ×(1−draw)) — `driveParams()` itself is untouched — AND weakens the shove.
- **The intake is physical**: the collision OBB extends by intake reach (`footprintExtents` →
  `robotExtents`) — it cannot clip walls/goals. THREE presets (**keep these user-given names**):
  **Sloped** (ramp, trapezoid mouth, devours clumps), **Vector wheel** (VERTICAL compliant
  wheels drawn as a row of small rects — never circles; chassis 11.5–14.5"), **Triangle**
  (TRIANGULAR internal storage — hopper pips draw in a triangle; longest reach, slower
  transfer). Internal keys sloped/vector/triangle ('compact'/'extended' migrate in settings).
- **CAPTURE MODEL**: each preset carries a `mouth` sub-object (`mouthHalf`, `wheelHalf`,
  `wedge`/`wedgeWidth`/`funnel`, `capMin`/`capMax`, `clumpInterval`, `dual`). A ball is captured
  on the wheel line at the tip of reach; non-overhang presets clamp the mouth inside the frame
  so a full-width chassis geometrically forbids side intake. **Timing depends on WHERE the ball
  enters**: `single = capMin + (capMax−capMin)·(|localY|/wheelHalf)`. **Wedges FUNNEL** off-center
  balls toward the centerline via a lateral VELOCITY nudge only, never a position write — it
  runs before the ball solve so Rapier owns penetration. **Triangle takes TWO per cycle**
  (`dual`). Flank capture (`sideTouch`) exists only where the vector's wheel span overhangs a
  narrower chassis, comparing SPANS not penetration. NOTE: `halfWidth`/`perBall`/`clumpPerBall`
  were REMOVED — grep before reintroducing.
- BASE PARKING counts only the four WHEEL ground-contact points (`wheelContacts`, inset
  `WHEEL_INSET`): intake/turret overhang neither earns nor spoils credit. The turret never
  protrudes (`TURRET_OFFSET_FRAC`). The chassis may be NARROWER than the intake
  (`ROBOT_MIN_WIDTH` 10 < vector's 17).

## Scoring + multi-robot

Classified 3 / overflow 1 / pattern 2 per slot / leave 3 / depot 1 / base 5/10+10. PATTERN
shows only BANKED points (assessed end-of-AUTO and end-of-match — never a live matched count);
breakdown chips show artifact COUNTS, not points. `canSort` robots fire the hopper color
matching the next unfilled motif slot (else FIFO). A 2-robot alliance splits the 6 preload
balls (slot A `PRELOAD`, slot B `HP_INITIAL_STOCK`) and starts that alliance's HP stock empty.
Free-Drive has a "practice dummies" toggle (3 idle robots as obstacles).

## Penalty engine (`src/sim/penalties.ts`)

**MINOR = 5 pts, MAJOR = 15 pts** (user-set, NOT the manual's 10/30), awarded to the OPPOSING
(victim) alliance via `awardFoul` → the victim's `ScoreBreakdown.foulPoints`;
`match.fouls[offender]` tallies committed counts for the HUD.

- **G417** — TOUCHING an opponent's gate is an immediate **MAJOR**, edge-triggered on bumper
  contact with the gate ARM (`robotIntersectsRect(r, gateArmRect(a))`), **even if it never
  opens**. Deliberately DIFFERENT from `updateGates`' physical `pushingGate` (which also needs
  an active shove). Touching your OWN gate is legal.
- **G418.B** — each classified artifact that LEAVES an opponent's RAMP because you opened their
  gate is a MAJOR **per artifact**. Billed **on the DRAIN, not on the touch**:
  `penalties.rampBallIds` holds last tick's committed non-overflow rail balls per goal and every
  id that is gone this tick costs the culprit one MAJOR — so the bill keeps running after the
  offender drives away (the flow finishes the drain), and a TAP that never lifts the arm past
  the pass fraction costs **G417 alone** (billing the standing column on contact was a bug,
  fixed Aug 2026). `penalties.gateCulprit` is pinned to an opponent who actually `pushingGate`s
  the arm, not to one merely brushing it, so an owner draining their own ramp is never billed to
  a leaning opponent. Both are reset whenever the phase isn't auto/teleop, so a drain across the
  frozen transition is nobody's foul. Matches manual Example 3.
- **Protected zones use one uniform model** — each zone is OWNED by an alliance and a
  cross-alliance CONTACT while either robot is in it fouls the NON-owner ("regardless of who
  initiates"): **G424 gate zone** (MINOR — opening the gate is legal for anyone; only in-zone
  *contact* fouls), **G425 tunnel** (MINOR — `tunnelStrip(a)` sits under a's goal but is OWNED
  by `other(a)`; fires only when the INTRUDER itself is in the strip). **G424.A gate↔tunnel
  exception**: they overlap in the classifier corner and are MUTUALLY EXCLUSIVE — if the gate
  robot is also in the opponent's tunnel it's G425 only, else G424 only.
- **G426 loading** (MINOR). **G427 base** (MAJOR in endgame + sets `RobotState.baseAwarded`).
- **G402 auto interference** (MAJOR): an alliance BELONGS on its **goalSide** (blue −x, red +x
  — NOT driverSide, which was inverted and fouled the alliance sitting on its own side); fires
  when fully on the opponent's side + contact during AUTO, on the CROSSER.
- **G422 pinning** (MINOR → MAJOR on a repeat by the same pinner): 3 s of contact while the
  pinned robot commands motion, stays < 8 in/s, and hasn't escaped 24". Pinner-vs-pinned is
  disambiguated by `pinnedAgainstWall` — the VICTIM must be trapped against a boundary with the
  pinner on the open-field side; without it a wall shove satisfied BOTH orderings.
- **Fouls are EDGE-triggered — NO cooldown/timer** (user was emphatic): fire on the false→true
  edge, once while held, and AGAIN immediately on re-entry. `fire()` is idempotent within a
  tick. All penalty state is plain JSON.

---

# GAME: Chain Reaction (`chain`)

The 2026 Unofficial-FTC CAD-competition game. **Everything CR lives in `src/games/chain/`**
(nothing CR belongs in `src/config.ts` or `src/sim/`). Numbers come from the competition
manual (`cm.pdf` — its page streams are corrupt, so values came from manual PAGES supplied as
images + explicit dimensions); mm are converted via `mm()` (÷25.4). Values still approximated
from description rather than a figure are FLAGGED `APPROX` in `config.ts` — refine those
rather than inventing new ones.

**Fully playable and SCORED** (`CHAIN_SIM.scored = true`), so CR matches ride the ranked/record
boards under their own per-game periods. `startLegality: false` — CR start poses are legal by
construction, so the server's DECODE-only G304 gate stays off.

## Field + elements

- Square 12'×12', walls at ±72 (`CHAIN_HALF_X/Y`), origin center — same frame convention as
  DECODE. Colliders are just the four perimeter walls; there are **no in-field solids**, so
  `chainColliders` has no `dynamic` entry.
- **ACCELERATOR** — the alliance goal, OUTSIDE each side wall (red left x<0, blue right x>0),
  centered in y. `CHAIN_ACCEL_DEPTH` 27.46" out of the wall × `CHAIN_ACCEL_WIDTH` 54.87" along
  it. Its opening HANGS over the field, so launchers score from a stand-off distance, not
  point-blank. The camera bounds (`CHAIN_VIEW_HALF_X`) include the protrusion; the WALLS stay
  at ±72.
- **PARTICLE** — a 3"-OD wiffle ball, **300 of them** (`CHAIN_PARTICLE_SIM`), all simulated.
  Conserved: ground + flight + in-hoppers === 300, always.
- **CATALYST** — a 6"-OD purple ring (4 total). Seated on a **HOOK** (on the accelerator wall
  at y = ±`CHAIN_HOOK_Y`, four total) it raises that accelerator's multiplier.
  **Three MECHANISMS handle it** (`CHAIN_CATALYSTS`, resolved by `chainCatalystGeom(spec)` —
  the ONE resolver, so the action, the HUD prompt and the mass floor can't disagree). One claw
  does both grabbing and placing, so each has a single `reach`, measured from the mounted
  chassis EDGE (`catalystMouth`), plus a `cone` half-angle: **arm** (reach specialist, ±50°,
  slow) · **launcher** (shortest claw, ±35°, plus the inaccurate `fling` catapult) ·
  **turret** (rail + turret, cone = π so facing never matters, fastest, heaviest).
  **The ARM's reach is PER-CHASSIS, not a constant** — see `chainArmReach`. G02/G03 give a
  24" control prism (`CHAIN_PRISM`), so what's legally left to extend is
  `24 − (chassis + any sweeper on that same axis) + the ring radius`. That spans **9" on a
  maxed-out 18" chassis to 17" on a compact one**, making the arm the mechanism you build
  small to exploit; `CHAIN_EXPANSION` is now just the maxed-robot worst case, derived rather
  than assumed. **This never changes the SPRITE**: both `drawCatalystMech` and `RobotPreview`
  draw the arm at the fixed stowed `CHAIN_ARM_DRAW` (2.2"), because an arm is only extended
  while it actuates — top-down it just says which way it points. Do NOT wire the sprite to
  `reach`; drawing it extended made every robot look permanently mid-grab.
- **RING STAND** — a 22.5" vertical pole very close to each field corner (inset APPROX).
  Robots ASCEND (endgame) / DESCEND (auto).
- **LAB AREA** — each alliance's two 24" corner squares on its side: start / leave / park.
- **PARTICLE ZONE** — the central white-tape diamond (`CHAIN_DIAMOND_SIDE` 48" outer side,
  half-diagonal `CHAIN_DIAMOND_R` ≈ 33.94"). Neutral and unprotected — it is the carve-out in
  the auto-protection rule.
- **BEAMS** — four 1"×1" black tubes on the x/y axes, 56" long, running IN from each wall
  (inner end 16" from centre, crossing the diamond). See *Terrain* below.

## Scoring (`CHAIN_PTS`)

Particle **1 pt × the accelerator's multiplier**; `accelMultiplier(state, a)` = 1 + one per
CATALYST seated on that alliance's hooks. Ring-Stand **descend 100** (auto) / **ascend 100**
(endgame); Lab-Area **leave 5** (auto) / **park 5** (endgame). Match timing 30 s auto / 120 s
teleop / last 20 s endgame. The alliance total is recomputed each tick as
`particlePoints + endgame + foulPoints` — endgame status is DERIVED from position
(`endgameOf`: ascended = slow near a stand > parked = centre in a Lab square), and the AUTO
descent is LATCHED (`descentAwarded`) so a robot that came down keeps the points all match.

## Particle lifecycle (bespoke, not Rapier)

Ground particles use a bespoke integrator + a spatial-hash SEPARATION pass so they never
overlap (`separateParticles`, scales to 300 cheaply).

**PRE-MATCH RANDOMIZATION** — the manual has the accelerators fling all 300 particles back out
to randomize the field. We STAGE half inside each goal (`staged` flight balls, inert) and the
launcher ejects `CHAIN_PRELAUNCH_PER_TICK` per goal per tick during the pre-match window
(~2.5 s to clear 150), scattering deterministically off the world RNG.

**In match:** launched → ballistic flight → crosses the wall plane within `CHAIN_ACCEL_HALF_Y`
⇒ **SCORED** (count + points at that instant) → it KEEPS its momentum and BOUNCES inside the
goal box (restitution + friction, `CHAIN_FUNNEL_MIN`..`CHAIN_FUNNEL_S` dwell) → drifts to the
wall-side launcher → **EJECTED back onto the field** (`CHAIN_EJECT_*`, randomized power/arc/
spread). A shot that MISSES the opening is retrieved by a human and thrown back in
(`CHAIN_THROWBACK_*`). Nothing is ever consumed — that is why the count stays at 300.

## Robot archetypes (`RobotSpec.scoreMode`)

- **turret** — a dye-rotor + turreted single shooter: indexes ONE particle per
  `CHAIN_FIRE_INTERVAL` (**13 bps**) from ANY range, auto-aiming. The turret **SLEWS** at
  `CHAIN_TURRET_SLEW` — it cannot snap, so a sudden velocity change (a shove) makes the lead
  solution jump faster than the turret can follow and shots fired mid-correction MISS. Aim is a
  physical state, not a promise. (Contrast DECODE, where the shooter never misses.)
- **twinturret** — two barrels on ONE turret, firing alternately from a real muzzle offset
  (`CHAIN_TWIN_BARREL_OFFSET`). Only **~15 bps** (`CHAIN_TWIN_FIRE_MULT` **1.15**) — a SLIGHT
  edge over the single turret, not a near-doubling (user's call, revised down from 1.65). The
  barrel is not the bottleneck: one indexer and one aim solution gate the rate, so a second
  barrel mostly hides handoff latency. It pays ~24% of its storage (`CHAIN_STORE_TWIN_MULT`)
  and +2.5 lb of mass floor for that, which makes it a NARROW pick — this multiplier is the
  dial if it should become mainline.
- **drum** — a chassis-wide flywheel drum, no turret: streams SINGLE particles at ~**24 bps**
  (`CHAIN_DRUM_INTERVAL` with ±`CHAIN_DRUM_JITTER`) from a RANDOM lateral position across the
  rollers, uniform launch speed. NEVER a rigid uniform line, never a "6-then-wait" burst.
- **dumper** — a chassis-wide catapult: flings the WHOLE hopper at once within
  `CHAIN_DUMP_RANGE` (56"), with side-to-side speed variance (`CHAIN_DUMP_SIDE_VAR`) ⇒ real
  scatter.

**Cadence gotcha:** the turret ACCUMULATES its interval (`fireReadyAt += INTERVAL`) rather than
re-anchoring to `world.time`, so the sub-tick remainder carries and the rate averages exactly
13 bps (a plain re-anchor tick-quantizes to 12 or 15, never 13). An idle-guard clamps
`fireReadyAt` forward so a refilled hopper can't burst-fire accumulated debt.

**Turretless aiming**: drum/dumper have no turret, so **the robot aims by TURNING** —
`chainAimAssist` (called from `chainStep` BEFORE the drivetrain model) overrides `rotate` while
the MANUAL fire button is held, and the shot is gated on `CHAIN_AIM_TOL`. Auto-fire fires
opportunistically and never hijacks the driver's heading. This is BUILT IN, not an option:
`aimAssist` is forced on everywhere (see the assists bullet above), so its `!r.aimAssist`
early-out is unreachable in the product — kept, and kept tested, for if the toggle returns.
A CR TURRET ignores the flag entirely and always tracks. **SHOOTING ON THE MOVE**: a launched
particle inherits the CHASSIS velocity, so both archetypes lead — a turret by offsetting
`turretHeading`, a turretless one by offsetting the whole chassis heading (`leadDir`).

## Mechanism MOUNTS (`src/games/chain/mounts.ts`)

The sweeper intake and the turretless launcher can sit on any chassis edge. Robot frame
throughout: **+x = forward, +y = the robot's LEFT**.

- `RobotSpec.intakeMount`: **front · back · side (both flanks) · frontback (both ends)**.
- `RobotSpec.shooterMount`: **front · back · left · right** (no effect on a turret, which is
  top-mounted — the builder hides the picker for it).
- `intakeSide`/`shooterRear` are **DEPRECATED MIRRORS — never read them.** Use
  `intakeMountOf(spec)` / `shooterMountOf(spec)`. `coerceSpec` resolves the new field (falling
  back to the legacy boolean, so old saves migrate) and keeps the boolean MIRRORED, so a spec
  round-tripped through an older peer/server returns the nearest legal mount instead of
  resetting.
- `mounts.ts` is a **LEAF module** (imports only `types`) on purpose: the mount decides the
  collision footprint, so `src/sim/field.ts` must import it, and anything heavier would cycle.
  It owns `EDGE_ANGLE`/`EDGE_DIR`/`EDGE_PERP` (exact integer unit vectors — no `cos(π/2)`
  residue on the flanks), `edgeGeom(spec, edge) → {dist, span}`, `isEndEdge`.

**A mount moves three things together — change one, change all three:**
1. **CAPTURE** — `chainIntakeMouths(spec)` returns one robot-local rect per mounted edge (so
   `frontback`/`side` are simply two rects); `mouthContains(m, lx, ly, pad)` pads ONLY the
   outward lip. END edges span the chassis WIDTH, FLANK edges its LENGTH.
2. **COLLISION** — `footprintExtents` grows on exactly the mounted edge(s). DECODE resolves to
   `front`, so DECODE geometry is unchanged.
3. **AIM + LAUNCH** — `chainGoalAimHeading` returns `lead − EDGE_ANGLE[mount]` so the robot
   turns the MOUNTED edge at the goal; `launchAt` spreads the launch line across that edge.

The drawn intake bars ARE the grab area (renderer and `interact` share
`chainIntakeMouths`) — keep it that way.

## Ball storage

The manual sets no fixed particle limit (G01 unlimited control; G02 bounds them to an
18"×24"×18" CONTROL PRISM, G03 permits expanding into it), so the practical max is
VOLUME-limited. `chainStorageMax` derives it from footprint area ÷ `CHAIN_STORE_AREA_PER_BALL`
× an archetype factor × a mount factor, clamped to [1, `CHAIN_STORAGE_MAX` 122]:

- archetype — turret `0.55` (loses centre volume to the rotor+shooter), twin turret `0.42` (a
  second shooter assembly eats more), drum/dumper `1.0`.
- mount (`chainMountStoreMult`) — front == back `1.0` (mirror images; a rear sweeper is a free
  stylistic choice), frontback `0.75` (two open ends), side `0.6` (two full-length flanks).

**`CHAIN_STORE_AREA_PER_BALL` is the ONE dial for storage across the whole game** — it is the
cap's only size term, so changing it moves every archetype, mount and chassis by the same
proportion and leaves the relative trade-offs above intact. It was cut 3.6 → **2.67** for a
+35% pass (Aug 2026), with `CHAIN_STORAGE_MAX` 90 → 122, `CHAIN_STORAGE_DEFAULT` 12 → 16 and
each `CHAIN_PRESETS` `ballStorage` scaled to match; `CHAIN_STORAGE_MIN` stays 1 (a floor of one
ball is a floor, not a quantity to scale). Do NOT hand-tune the per-archetype multipliers to
change overall capacity — that silently re-balances the archetypes against each other.

The `ballStorage` slider picks any capacity up to that max; `chainHopperCap` is the ACTIVE cap
read by the sim, renderer, and HUD.

## Terrain — beams + ground clearance (`beams.ts`)

`groundClearance` (0.3–1.5", default 1.0) must be ≥ `CHAIN_BEAM_HEIGHT` 1" to cross a beam, but
more clearance RAISES the centre of gravity (`cogFactor`) and makes the drive sluggish —
`CHAIN_COG_PENALTY` 0.16 generally, and `CHAIN_COG_SWERVE_PENALTY` 0.6 on a squared curve for
SWERVE (tall modules tip and scrub). `chainStep` scales the whole movement command by
`cogFactor` BEFORE the drivetrain model.

**Beam crossing is modeled PER WHEEL**, not by chassis overlap: a beam drags only while one of
the four `wheelContacts` is perched on the ridge (within `CHAIN_BEAM_WHEEL_R` 2.5" of the beam
line). So a robot STRADDLING a beam (tube under the belly, all wheels down) rolls DRAG-FREE,
and a perpendicular crossing is TWO distinct bumps (front axle, then rear). Lifted wheels lose
traction: `grounded = (4−wheelsUp)/4` scales the forward retain toward
`CHAIN_BEAM_GROUND_FLOOR` 0.82. Momentum eases the climb only a little
(`CHAIN_BEAM_MOMENTUM_EASE`) — a beam ALWAYS costs speed.

**A strafing MECANUM is CURBED, not dragged** (this was revised twice from feedback — a
velocity drag let the wheel ooze onto the ridge and get stuck on top). Real mecanum climbs a
bump it drives straight at (full-diameter wheel rolls over it — which is why mecanum has the
BEST forward beam traction), but sideways force is the sum of four 45° rollers whose tiny outer
diameter cannot climb a 1" tube. So: a **pre-solve velocity wall** in `beamDrag` caps inward
speed so the leading wheel stops EXACTLY at the near face this tick, plus a **post-solve
positional clamp** `beamStrafeBlock` for numerical slop. It engages only when the crossing is
strafe-dominant (`forwardness < CHAIN_BEAM_STRAFE_BLOCK_FWD` 0.5) and there is a **STRADDLE
GUARD** so a robot already across isn't shoved back. Mecanum ONLY — tank can't strafe, swerve
steers its pods into travel, x-drive is 4-fold symmetric.

Rendering EXAGGERATES the invisible 1" tube (`CHAIN_BEAM_RENDER_H`) and bobs a crossing robot
up with a ground shadow + `CHAIN_BEAM_RUMBLE` shudder — cosmetic only; the physics footprint
stays the flat 1".

## Start poses + roles

**G04**: a robot must begin completely in the Lab Area (tile floor OR already ascended on a
corner Ring Stand). `CHAIN_START_POSES` are four named anchors — LAB·TOP, LAB·BOTTOM, RING
STAND·TOP, RING STAND·BOTTOM — CANONICAL for BLUE and x-MIRRORED for RED (`chainStartPose`).
The anchors are all legal by construction. Starting on a stand ARMS the auto-descent award
(`descentArmed`).

**FREE PLACEMENT — `src/ui/ChainStartEditor.tsx`** (the CR twin of DECODE's
`StartPositionEditor`, replacing the old slider-and-buttons `ChainStartSelector`): a canvas
stage running the REAL `drawChainField` / `drawChainRobot`, drag to place, a heading handle,
numeric X/Y/heading, live legality, and the four anchors as quick-picks. It reuses every
`ds-startpos-*` style, so there is no new CSS for the contrast/shift audits. Rules of the
seam:
- `chainEvalStart(spec,pos)` is the verdict + its REASON (`inLab` / `clearOfStand`), and its
  `legal` is the `chainSnapStart` round-trip the SPAWN runs — never a re-derivation, so the
  ring can't disagree with where the robot actually starts. `extent` is the conservative,
  rotation-agnostic half-extent the rules test, and the editor draws THAT box (not a rotated
  footprint) so a red ring always explains itself. Heading is therefore always free.
- `chainMirrorStart(pose,a)` is canonical↔actual, SELF-INVERSE, mirroring `chainStartPose`.
  Poses are stored CANONICAL, so a placement survives an alliance switch.
- **Snap defaults ON and snaps LIVE during the drag** (DECODE's defaults OFF). G04 plus the
  solid corner assembly leave a narrow legal band — at the widest chassis
  `CHAIN_RINGSTAND_BOX <= CHAIN_LAB - 2*half-extent` is nearly tight — so free-dragging would
  paint almost every drop red. Live snapping makes the robot glide along the legal band.
- **No saved-pose library** (unlike DECODE). `GameSettings.savedStartPoses` is ONE canonical
  list shared across games; a CR pose saved into it would show up unreachable in DECODE's
  Close/Far library. Adding one means namespacing that setting first.
- `startSelectionLegal(game, spec, alliance, pose)` in `src/ui/startPositions.ts` is the
  ready-up / start gate for BOTH games (DECODE G304 via `activeStartLegal`, CR G04 via
  `chainStartLegal`). CR used to be waved through as "legal by construction" — free placement
  ended that.

**CR roles are TOP / BOTTOM** (which Lab corner), NOT DECODE's CLOSE / FAR. The shared
`StartCat` slots carry them (close = TOP y≥0, far = BOTTOM y<0) via `chainAnchorCat` /
`chainDefaultIndex` / `chainRoleLabel`, so a locked role limits the selector to that corner's
floor + ring-stand anchors and two alliance robots never stack.

## Penalties (`src/games/chain/penalties.ts`)

Only the runtime CONTACT rules are modeled, and all are **MAJOR**, awarded to the victim:

- **G06** — during AUTO, contacting an opponent COMPLETELY within its own Alliance Section (its
  half, EXCLUDING the neutral Particle Zone diamond) → MAJOR on the aggressor.
- **G05** — during ENDGAME, contacting an ASCENDING opponent → MAJOR.

Edge-triggered via `chain.foulEdge` (same discipline as DECODE: fire on the false→true edge,
once while held, again on re-entry) and cleared outside auto/teleop. G01–G04 are structurally
enforced; G07 (de-score) is legal — you can lift a ring off EITHER goal's hook. G02 plowing,
G08, G09 are intentionally not modeled.

## CR pipeline order (`chainStep`)

resolve commands → `chainAimAssist` rotate override → CoG scaling → shared drivetrain/motor
(`updateRobot`) → Rapier + wall containment → `updateChain` (particles, intake, shooter,
accelerator score/recycle, catalysts, endgame) → `updateChainPenalties` → phase/timer machine.
It DELIBERATELY skips DECODE's `updateRobotActions`, goals/gates, penalties, and scoring — CR
owns all of that.

---

# Gotchas

- **THEMING (dark mode).** Pref lives in `localStorage['decodesim.theme']` (`src/theme.ts`),
  never in `GameSettings` (that syncs to Postgres per account). First paint is stamped by a
  blocking inline script in `index.html`; `system` is resolved in JS so CSS sees only
  `data-theme="light|dark"`. **EVERYTHING THEMES, INCLUDING THE IN-MATCH HUD.** Three
  categories decide how a token behaves: (1) *readable against the surface* ⇒ INVERTS
  (`--ds-ink`, `--ds-mut`, `--ds-accent`, `--ds-warn`, the `-ink` siblings); (2) *a fill with
  fixed ink* ⇒ does NOT (`--ds-red`, `--ds-*-chip`, `--ds-gold`); (3) *its ground is the
  CANVAS* ⇒ does NOT, because the field is hardcoded dark — that is `--ds-on-field`/`-dim`/
  `-accent`, deliberately absent from the dark block. Use category 3 for anything drawn
  straight on the field or the dark overlay scrims.
  A dark HUD card is only ~1.4:1 on the dark field by FILL, so its EDGE identifies it:
  floating surfaces take **`--ds-hud-line`**, never `--ds-line` (tuned against the card behind
  it). `--ds-line-strong` is tuned against `--ds-panel` and drops to 2.73:1 on the translucent
  HUD card — rings that must read there use `--ds-mut`. Detect the theme in JS via
  `document.documentElement.dataset.theme`, not `getComputedStyle`. **A colour that is both a
  fill and a text colour will fail one of the two** — split it (`--ds-ok`/`--ds-ok-ink`).
  The letterbox themes (`COLORS.backdropDark`) but the field mat does NOT; the board is
  separated from the dark floor by its outline alone (1.03:1), so keep the outline.
- **Camera/screen math**: `worldToScreen` = rotate by `viewAngle`, then y-flip. Driver stick →
  field frame uses `rot(stick, -viewAngle)` (the INVERSE — sign matters at ±90°).
- **Bird's-eye vs mirrored** (bit us once): for a nose-up schematic, robot (x,y) → screen
  must be `[[0,−1],[−1,0]]` (forward → up, robot-LEFT → screen LEFT), NOT `rotate(-90)`, which
  puts the robot's left on the screen's right. Symmetric mechanisms can't reveal the
  difference; anything left/right-asymmetric can. See `ROBOT_FRAME` in `RobotPreview.tsx`.
- The DECODE basin containment normal points INTO the field; push balls back inside with `-n`
  (a sign inversion here once made positions explode to 1e250).
- **Ball containment invariant**: ground balls get a HARD geometric eviction pass in `world.ts`
  (walls + goal faces via `clampBallPosToStatics`, AND `collideBallRect` against both
  classifier rects) because Rapier's soft contacts can't clear a DEEPLY embedded body. **Any
  new solid a ball can tunnel into needs the same geometric clamp**, not just a collider.
- **Electron builds need `ELECTRON=1`** (`vite.config.ts` switches `base` to `./`). A bare
  `npm run build` loaded under `file://` resolves `/assets/*.js` at the filesystem root and
  404s **silently** — a permanently blank white window. Check this before assuming the app
  broke. The desktop shell is a THIN SHELL: online it loads the live site, offline it falls
  back to the bundled `dist`.
- The manual PDFs re-download from ftc-resources.firstinspires.org/ftc/game/manual-NN via
  WebFetch; figures are embedded images — extract and Read them as images when geometry
  questions come up.
- Windows PowerShell 5.1: no `&&` in npm-adjacent commands; use `;` or `if ($?)`.

---

# State of play

**DECODE** — complete: full solo match + free drive, scoring per manual, motif randomization,
human-player restock, gamepad + keyboard, physical basin/rail/gate classifier, contact-torque
physics, driver assists, audio, pre-match countdown, Electron packaging, three intake presets
with the physical `mouth` capture model, power draw, the drivetrain retune (`BALANCE_VERSION`
2), configurable G304 start positions with the canvas editor, and the Phase C penalty engine.

**Chain Reaction** — complete and scored: 300-particle bespoke physics with pre-match
randomization + the accelerator score/recycle loop, three archetypes (turret/drum/dumper) with
lead-compensated shooting on the move, four-edge shooter mounts + four intake mounts, catalysts
and hooks (multiplier, de-score allowed), ring-stand ascend/descend + Lab park, per-wheel beam
terrain with the mecanum strafe-curb, ground-clearance↔CoG tradeoff, Lab-Area start anchors
with TOP/BOTTOM roles, and the G05/G06 penalty pair.

**Netcode** — Phase 0 (server authority + prediction), Phase 1 (30 Hz delta snapshots,
interpolation, reconnection, connection-quality HUD, Fly deploy), and Phase 3 (accounts,
Glicko-2 ranked, leaderboards, records, admin, version gate) are LIVE.
**Phase 2 (Rapier)** — ROBOTS slice done; **BALLS still bespoke**.

## Next up (not started)

1. **Rapier slice 2 — balls/particles.** Port to Rapier bodies/sensors while KEEPING the
   scripted basin/rail/gate (the contact-time classified-vs-overflow commit must stay exact).
   ONLY after that: delete the dead `collideRobots`/`constrainRobot` and drop the
   `dsin/dcos/datan2` discipline.
2. **DECODE penalty hitbox audit** — the rules are right; re-verify the ZONE GEOMETRY each one
   tests (`gateZone`/`gateTapeSegments`, `tunnelStrip`, `allianceArea`, `pinnedAgainstWall`
   slop, the SAT `rrContacts` test) against the manual figures. Tighten with smoke cases.
3. **Chain Reaction manual refinement** — replace the `APPROX` constants (ring-stand inset,
   Lab-Area size/geometry, exact zone coordinates) with measured manual values. This is the
   last real gap in CR; everything else there is feature-complete.
4. Deferred: WebTransport (needs TLS-deploy validation + an ACK-keyed delta), full-reload
   reconnect, obelisk AprilTag visuals, DECODE deferred fouls (G408 possession>3 / plowing),
   matchmaking polish, replay UI, leaderboard tiers.
