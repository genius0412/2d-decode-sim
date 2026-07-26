# CLAUDE.md — DECODE 2D Simulator

2D top-down driver-practice sim for the FTC 2025-26 game **DECODE presented by RTX**.
Vite + React + TypeScript, Canvas 2D, zero runtime deps beyond React. Deploys to
Vercel zero-config; Electron wrapper for a desktop build.

## Session protocol

**At the end of every working session, write/refresh `HANDOFF.md`** (repo root): current
state (is the build green?), what was finished, exact next steps, and gotchas. Read it
at session start if it exists — it may describe uncommitted mid-refactor state.

## Commands

- `npm run dev` — dev server (localhost:5173)
- `npm test` — **headless sim verification** (`scripts/smoke.ts`, ~30 checks). Run this
  after ANY change to `src/sim/` or `src/config.ts`. It is fast and catches almost everything.
- `npm run build` — tsc (strict) + vite build. Run before claiming work done.
- `npm run contrast` — WCAG audit of the palette (`scripts/contrast.mjs`, 135 pairs, light +
  dark, no deps). Run after ANY colour/token edit. Not wired into `npm test` on purpose: a red
  `npm test` must keep meaning "physics broke".
- `npm run shiftaudit` — layout-shift audit (`scripts/shiftaudit.cjs`, Electron). Needs a
  build + `npx vite preview --port 4173` in another shell. Forces `:hover`/`:active` and the
  `on`/`primary` state classes on every interactive element across 10 routes + the live HUD,
  in BOTH themes, and asserts nothing outside that element's own subtree moves. Pressables must
  move via `transform`/`box-shadow`, never a border or margin that appears on hover.
- `npm run electron` / `npm run dist` — desktop shell / Windows installer (`release/`)

## Architecture (load-bearing rules)

- **`src/sim/` is a pure deterministic state machine.** No DOM, no clock, no
  `Math.random`, no `Date`. It consumes per-tick `RobotCommand`s keyed by robot id and
  a seeded mulberry32 PRNG stored in `world.rngState`. This is the seam for future
  **2v2 multiplayer with real people** (a stated user goal): more robots = more
  `RobotState`s + command sources replayed into `step()`.
- **ROBOT collision is now Rapier 2D** (`@dimforge/rapier2d-compat`, Phase 2 slice 1):
  `src/sim/physicsEngine.ts` `solveRobots()` rebuilds a fresh Rapier world each `step()`
  (stateless → reconcile/determinism safe, no WASM leak), owns robot translation +
  velocity (walls/goal-faces/classifier + mass-weighted robot-robot + velocity-kill),
  and writes `pos/vel` back into the canonical `RobotState`. The bespoke square-up
  torque + `rrContacts` stay in `physics.ts` `squareUpRobots`. `RAPIER.init()` is async
  → `initPhysics()` is awaited in smoke, server, and `main.tsx` before any step.
  **BALLS are still bespoke** (slice 2, deferred). Rapier is deterministic in-process
  (all the server-authoritative model needs); the `dsin/dcos/datan2` discipline STAYS
  until balls also move to Rapier. Key gotcha: the world is in INCHES → set
  `integrationParameters.lengthUnit` (see `PHYS_*` constants + `HANDOFF.md`).
- `src/config.ts` is the single source of truth for ALL geometry, physics, and scoring
  constants. Tune there, not inline.
- `src/render/` and `src/ui/` only read world state. `src/input/` only produces commands.
- Fixed timestep 60 Hz (`SIM_DT` = 1/60, `MAX_STEPS_PER_FRAME` 5), rAF render loop in
  `src/game.ts` (GameController).
- HUD is React, polled at 10 Hz from `GameController.getHud()`.

## Field geometry — verified, do not "fix" from intuition

Geometry was measured from the official Competition Manual Section 9 figures (extracted
the embedded images from the PDF and pixel-measured them). See `docs/decode-reference.md`
for the full map and sources. Key facts people get wrong:

- World frame: origin center, +x = audience's right, +y away from audience. Inches.
- **Goals are cross-court**: BLUE goal far-LEFT corner (tag 20), RED far-RIGHT (tag 24).
  Red alliance wall = left (x=-72), blue wall = right (x=+72).
- Driver view rotation: `viewAngleOf()` in `src/sim/field.ts` — blue looks from the
  right wall (-π/2), red from the left (+π/2). Camera AND driver-frame input both use it.
- Launch zones are **shared** (not per alliance): big triangle `y >= |x|` (apex at field
  center) + small audience triangle. Any robot part inside ⇒ may launch.
- Each goal's classifier channel runs down the adjacent side wall to a gate near
  mid-wall (y≈0); released/overflow balls roll out beneath it toward the audience.
- **GOAL FOOTPRINT is a right triangle in the corner, NOT a symmetric 45° face**
  (corrected July 2026, `smoke.ts` asserts it): legs flush along the walls —
  `GOAL_FACE_WIDTH` 26.5" along the far wall, `GOAL_DEPTH` 18.3" down the side wall,
  right angle at the field corner. The FACE robots shoot at is the hypotenuse
  (`GOAL_FACE_LEN` ~32.2", ~34.6° off the far wall). `goalTriangle`/`goalFacePoints`/
  `goalFaceNormal` (unit normal into the field) / `goalCenter` (opening centroid).
  **`goalLineValue` now returns TRUE perpendicular inches** from the face (>0 behind,
  inside the footprint; <0 field side) — do NOT divide by SQRT2 anywhere (the old
  45°-face scaling was removed at every call site).
- **START POSITIONS are configurable + rulebook-constrained (G304).** A robot may
  start on any pose satisfying **G304** (verified from Section 11): (A) footprint
  OVER a white LAUNCH LINE, (B) TOUCHING the GOAL or the FIELD perimeter, (C) fully
  within its own half (blue x≤0 / red x≥0) — PLUS the collision box may only rest
  AGAINST a solid, never penetrate it (goal wedge / classifier channel). All in
  `src/sim/field.ts`: `evalStartPose(spec,pose,a)→StartLegality` (footprint =
  chassis+intake via `footprintExtents`/`footprintCorners`, SAT tests), `snapStartToLegal`
  (nearest legal along the goal-face + audience loci), `mirrorStartPose` (canonical
  goalSide=+1 ↔ actual, self-inverse), `startPose(a,index,custom?,spec?)`. Tolerances
  `START_TOUCH_TOL`/`START_PEN_SLOP` in config. `START_POSES` (3 named quick-picks:
  GOAL·FAR / AUDIENCE / GOAL·GATE) are **semantic ANCHORS resolved DYNAMICALLY per
  chassis** via `presetPose(index,a,spec)` (= snap the anchor legal for THAT robot),
  so a preset is legal at ANY size — not a fixed coordinate. **Anchor index 0 & 1
  MUST stay far apart** (a 2-robot alliance spawns slots at 0/1 — smoke-checked). Custom poses ride
  `RobotSetup.startPose`/`GameSettings.startPose`/`LobbyPlayer.startPose` (canonical,
  overrides `startIndex`), sanitized by `coerceStartPose` + snapped legal at the spawn
  chokepoint `coerceSetup`. UI `src/ui/StartPositionEditor.tsx`: a CANVAS reusing the
  real `drawField`/`drawRobot` renderers + drag/rotate + X/Y/heading inputs; snapping
  is an OPT-IN toggle (default OFF) and an illegal pose is previewed red but NEVER
  saved (reverts to the last legal on release). Wired into MatchSetup / Lobby /
  MatchStrategy. `caps:'startpose'` advertised for future server-gating.
  **START POSITIONS split CLOSE vs FAR** (by distance to goal; presets carry `cat` in
  config): a per-player SAVED library (`GameSettings.savedStartPoses{close,far}`, ≤
  `MAX_SAVED_STARTS` each) + `startMemory` (last pick per category, restored on tab
  switch) + `startCat`. Pure patch-helpers in `src/ui/startPositions.ts`
  (`categoryPresets/switchCategory/selectStart/saveStart/deleteSavedStart/samePose`).
  `startIndex`/`startPose` stay the ACTIVE start (spawn+wire); the library/memory are
  LOCAL settings (persist + account-sync, no protocol change). In a 2v2 the robot's
  role LOCKS the category (1st on the alliance by clientId = CLOSE, 2nd = FAR; derived
  client-side in Lobby/MatchStrategy → `lockedCategory`). Editor gotcha: a preset pick
  must be ONE settings patch (`selectStart`), never two `set()` calls (stale-closure
  overwrite drops one). **ROLE is SWAPPABLE by mutual consent** (`src/ui/useRoleSwap.ts`
  + `RoleSwapBar.tsx`): `LobbyPlayer.startRole?`/`swapReq?` (protocol + sanitize passthrough
  — needs a server redeploy) drive a two-flag handshake (propose→accept; when both set
  each client flips ITS OWN role to the opposite, race-free; `enacted` ref guards the
  broadcast window). The enact also resets the active start to the new category default.
  Decline is LOCAL-only (a partner can't clear your flag).
- Spike marks: horizontal 10" tape at x=±48.5 — that is ONE tile (~23.5") from the
  side wall (re-verified July 2026; an old "two tiles" comment was wrong, the value
  right), rows y = -35.5 / -12.8 / +11.1, 3 balls per row (GPP / PGP / PPG near→far).
  BASE zone 18×18, corners at (d·24,−48) & (d·42,−30), `BASE_CENTER` (d·33,−39) where
  d = driverSide (blue +x, red −x). Loading zones = audience corners, 23×23.
- GATE ZONE: the real marking is TWO thin alliance-colored tape LINES, 10" long,
  2.75" apart (`GATE_TAPE_W`), **starting at the classifier edge (x=±66) and running
  into the field** (`gateTapeSegments` → `[[Vec2,Vec2],[Vec2,Vec2]]` line pairs,
  drawn). The larger 10×5 `gateZone()` INTERACTION rect works the gate and is
  intentionally undrawn (feel > strict tape).
- DEPOT tape runs flush ALONG the goal face (the hypotenuse) from the far-wall corner
  to the classifier edge (x=±66) — it does NOT run through the channel to the side
  wall (`depotSegment` clips at the classifier). Band `DEPOT_DEPTH` 6" deep; band fill
  is no longer drawn (white tape line drawn last so the goal outline can't overdraw it).
- SECRET TUNNEL: `TUNNEL_W` 6.125" (its own constant, not CLASSIFIER_W), drawn with a
  colored outline. `tunnelStrip(X)` is beneath X's goal but belongs to the OPPOSING
  alliance (whose drive team is on that wall).
- ALLIANCE (drive-team) AREAS are NO LONGER DRAWN (removed to enlarge the field); the
  `allianceArea` helper stays (96×54 outside each wall, flush with the audience end)
  for zone logic / the coming penalty engine. `VIEW_MARGIN` 14 (bigger field); the
  camera reserves HUD bands (`HUD_TOP`/`HUD_BOTTOM` in camera.ts) so the score bar and
  chips never cover the field.
- The manual PDFs re-download from ftc-resources.firstinspires.org/ftc/game/manual-NN
  via WebFetch (saves the binary); scratchpad extract.cjs (text) and
  extract-imgs.cjs (figures) from this session extract them with Node stdlib.

## Ball lifecycle (no teleporting — user is emphatic)

flight → (crosses opening plane, either direction) → **basin** (jumbles inside goal
wedge with real containment/collisions, funnels to the SQUARE when slow) → **rail**
(1D flow down the classifier, gravity + contact stacking, position always continuous —
hand-offs preserve position and blend onto the rail line) → gate exit → ground.
Overflow rides OVER the stack at `OVERFLOW_Z` and always exits.
**Classified-vs-overflow is decided at CONTACT, not at hand-off** (user was explicit):
a ball boards the rail as `pending`, and only when it first meets the column (or gate
floor) does it commit — 9 retained below it at that instant ⇒ overflow (1 pt), else
classified (3 pts). Scoring happens at that decision moment, so a gate tap that drains
in time SAVES an incoming ball. A pending ball that flows out an open gate untouched
classifies at exit.
Gate physics (manual 9.8.3, `updateGates` in goal.ts): the gate is a PHYSICAL class-1
LEVER, not a boolean. A continuous `GoalState.gatePos` (0 closed .. 1 fully lifted) +
`gateVel` + `gateLatch` model it. **Geometry (Figure 9-15):** the lever HINGES at the
CLASSIFIER EDGE where the gate-zone tape starts (|x| = `FIELD_HALF − CLASSIFIER_W`) — a
SHORT handle (`GATE_ARM_SHORT`) pokes OUT into the gate zone (what a robot pushes) and a
LONG paddle (`GATE_ARM_LONG` = `CLASSIFIER_W`) lies ACROSS the channel to the WALL edge,
COVERING the artifacts. **Opening is ONE-DIRECTIONAL** (`pushingGate`): only a STRAIGHT
push toward the wall opens it — `velToward = r.vel.x·goalSide` (or the drive-command
component); driving SIDEWAYS along the wall does NOT open it. Merely LOITERING doesn't
open it either. **A tap LATCHES it open** (`gateLatch = GATE_OPEN_LATCH_S`) so the driver
does NOT keep pressing; **resting against an already-OPEN gate re-arms the latch** (touch-
hold) so it stays open without re-pushing. When released/untouched the latch decays and it
is **"closed by gravity"** — SWINGS shut (`GATE_GRAVITY`/`GATE_CLOSE_MAX`, non-instant).
**Flow holds an OPEN gate open** — a ball in the gateway suspends gravity (drains the whole
column) but does NOT LIFT it: a ball reaching an ALMOST-CLOSED gate (below `GATE_PASS_FRAC`)
can't reopen it — only a robot push can. `gateOpen` (an artifact can pass) is DERIVED =
`gatePos >= GATE_PASS_FRAC`. **The handle is a PHYSICAL one-way door** — a robot-only
Rapier collider (`buildGateArms` in physicsEngine.ts, robot solve only) spanning the SHORT
arm's foreshortened reach, so a robot can't strafe/drive THROUGH the closed lever; a
straight push lifts `gatePos` and RETRACTS the collider so the opening robot glides in
(not shoved), and touch-hold means it never swings closed against a resting robot (light
arm). **The lift is RAM-SPEED-SCALED and the collider retract is ANTICIPATED (no jolt):**
`gateLiftRate(ramSpeed) = GATE_OPEN_RATE + GATE_OPEN_RATE_SPEED·ramSpeed` (cap
`GATE_OPEN_RATE_MAX`) — harder ram ⇒ opens faster (~fully in one tick at a hard ram),
`GATE_OPEN_HOLD` is now 0. `buildGateArms` runs one step BEFORE `updateGates`, so it would
otherwise build the handle from last tick's still-closed `gatePos` and hard-stop a robot
that is, THIS tick, ramming it open (the old "1-tick jolt"). `gateColliderPos(world,dt,
cmds,a)` in goal.ts anticipates the exact lift `updateGates` is about to apply and world.ts
passes it (`Record<Alliance,number>`) into `solveRobots`→`buildGateArms`, so the handle
retracts on the SAME tick the push lands (`gateRamSpeed` is the shared ram metric;
`pushingGate = gateRamSpeed>0`). A non-pushing robot (strafe) still sees the raw closed
stub. The LONG paddle needs no collider (over the already-solid classifier). `gateArmRect`
(the push/foul contact rect, `GATE_ARM_REACH`/`GATE_ARM_Y0/Y1`) is kept TIGHT around the
handle. Rendered (`drawGateArm`) top-down by FORESHORTENING each arm toward the pivot
(`len·cos(gatePos·GATE_LIFT)`), the long paddle greening past the pass fraction. See
`GATE_*` constants in config.ts.

## Product decisions the user insisted on (do not regress)

1. **No flywheel spin-up before the FIRST shot** (the original product decision,
   preserved): a robot's opening shot is always instant. BETWEEN shots the cadence
   is the intake preset's hopper→shooter transfer interval
   (`INTAKE_PRESETS[*].fireInterval`: 0.1 s, except triangle 0.3 s — slower transfer
   is its stated tradeoff) PLUS a flywheel-recovery term (Phase B, in the approved
   plan). Recovery scales with the previous shot's energy and the robot's
   `flywheelInertia` (0–1 builder slider): `recovery = closeRecovery +
   FLYWHEEL_RECOVERY_MAX · shotNorm² · (1−inertia)`, where `shotNorm` ramps in only
   past `FLYWHEEL_CLOSE_SPEED` (the DISTANCE term). FAR shots are slowed for low-inertia
   flywheels (high inertia ⇒ base cadence even at range). **CLOSE-range rapid fire now
   carries a SMALL floor for near-zero inertia** (`closeRecovery = FLYWHEEL_CLOSE_RECOVERY
   · max(0, 1 − inertia/FLYWHEEL_CLOSE_INERTIA_KNEE)`): +0.04 s cadence at inertia 0,
   fading to 0 by inertia 0.2 — so a close-zone cycler wants a LITTLE inertia (~0.1–0.2)
   rather than 0, without needing a heavy far-range wheel. (Previously close fire was
   unchanged at any inertia; user revised this.) `r.fireReadyAt` gates the next shot in
   `robot.ts`. The DEFAULT robot (inertia 0.5) keeps a snappy burst.
   **POWER DRAW** (session 7; rebalanced session 11): a running intake plus the
   flywheel pull current off the drive motors. The flywheel has TWO terms, both
   ×`flywheelInertia`: a small steady HOLD (`POWER_DRAW_FLYWHEEL_HOLD·spin` — just
   being far from the goal barely matters, by design) and the DOMINANT SPIN-UP
   (`POWER_DRAW_FLYWHEEL_SPINUP·flywheelSpinRate` — the cost of ACCELERATING the
   wheel while driving AWAY from the goal; spinning DOWN costs nothing). `flywheelSpin`
   ramps 0→1 with distance to the robot's OWN goal (`FLY_SPIN_NEAR`→`FLY_SPIN_FAR`,
   via `flywheelSpinTarget`) and `flywheelSpinRate` is its positive rate of change
   (1/s); both set in `updateRobotActions`. `r.powerDraw = min(inertia·(HOLD·spin +
   SPINUP·spinRate) + (intake?POWER_DRAW_INTAKE:0), POWER_DRAW_MAX 0.18)`. It scales a
   LOCAL `driveParams` copy in `updateRobot` (speed/accel/turn ×(1−draw)) —
   `driveParams()` itself is untouched so the 75/7/280 calibration holds — AND weakens
   the shove (see #7). One-tick lag (fire runs after drive) is invisible + deterministic.
   `flywheelSpin` seeds at the spawn-distance target so there's no phantom first-tick
   spin-up.
2. **The shooter NEVER misses**: no dispersion; `solveShot` uses the MINIMUM-SPEED
   trajectory to the goal opening — the adaptive hood angle sweeps ~89° (near-vertical
   lob at point-blank) down to ~45° far out, so an exact, finite solution exists at
   EVERY distance incl. point-blank and the required launch speed is a SMOOTH function
   of distance (`v²=g·(dh+√(d²+dh²))` — the old fixed-hood 55°→80° solve had no solution
   inside ~5in and spiked 96→316 in/s across d=4..6). Turret is always exactly on the
   lead-compensated solution (no slew limit); opening accepts ascending entries.
   No aim ray / no dashed goal-tracking line drawn.
3. **Assists are menu-only**: field/robot-centric, aim assist, auto intake, auto fire
   are configured in the main menu — NO in-game toggle keybinds.
4. Auto-fire/intake must respect match phases (no firing during `pre`/`transition`).
5. **No popup toasts over the field** (they found them distracting) — events go to the
   muted left-edge log; zone status lives in the top-right chips.
6. HUD mimics the FTC live scoring display: red|timer|blue bar at the BOTTOM.
   Breakdown chips show artifact COUNTS, not points. PATTERN shows only BANKED
   points (assessed end-of-AUTO and end-of-match — never a live matched count).
7. **Drivetrain feel — REAL-MOTOR model (retuned 2026-07, `BALANCE_VERSION` 2).**
   ALL drivetrain/motor knobs live in ONE documented `DRIVETRAIN & MOTOR BALANCE`
   block in `config.ts` (edit there; `npm test` prints the `driveSummary` table so a
   tweak's effect is visible). Grounded in real hardware: `SPEED_PER_RPM` is DERIVED
   from a **104 mm goBILDA wheel** (`WHEEL_DIAMETER_MM`) free-speed geometry ×
   `DRIVE_EFFICIENCY` 0.95 (gearbox/bearing loss) → **~89 in/s at 435 wheel-rpm (7.4
   ft/s)**. The modeled motor is the **MATRIX / goBILDA 5000-series 12VDC** brushed
   motor (5800 rpm free, 20.45 oz-in stall) — its LINEAR torque–speed curve IS the
   motorStep model. **PEAK accel is TRACTION-limited (μ·g), NOT motor-limited** — the
   stall torque could give ~460 in/s² but the wheels slip first, so `BASE_DRIVE_ACCEL`
   240 × accelMult lands each drivetrain at its μ·g ceiling (tank μ≈0.9 → 348 …
   x-drive omni μ≈0.45 → 175). Each `DRIVETRAIN_PRESETS` entry applies REAL efficiency
   factors on the ideal-traction datum. **MOTORS follow a
   torque–speed curve** (`motorStep` in drivetrain.ts, used by robot.ts for fwd/strafe/turn): full stall
   accel off the line, falling ~linearly to `MOTOR_MIN_TORQUE_FRAC` at the free speed
   (`MOTOR_TORQUE_CURVE` 1.0 = physically real, 0 = old constant accel), so speed
   approaches the top asymptotically (~0.5–0.8 s to 95%); braking pulls harder
   (`MOTOR_BRAKE_MULT`). **Mecanum is now realistically LOSSY** (per GM0 rollers): speed
   0.87 / strafe 0.80 / accel 0.88 / **push 0.65** — it loses straight-line speed AND
   gets shoved by tank (no longer the pushMult=1.0 anchor). Realistic orders: speed
   tank>swerve>mecanum>xdrive · push tank>swerve≫mecanum>xdrive · accel
   tank>swerve>mecanum>xdrive (@435rpm: speed tank 89 / swerve 84 / mecanum 77 / xdrive
   74 in/s; peak accel tank 348 / swerve 312 / mecanum 211 / xdrive 175 in/s²). Mecanum
   beats the X-drive compromise on forward. Four wheel-saturation models: mecanum/xdrive
   `|f|+|s|+|ω|`, tank `|f|+|ω|` (strafe DEAD — traditional tank drive: left stick/W-S
   left side, right stick/Up-Down right side), swerve `hypot(f,s)+|ω|`. `maxTurn =
   wheelSpeed / halfDiagonal` (smaller/faster bots turn quicker, capped at
   `TURN_MAX_SPEED`). mass↑→accel↓, rpm↑→(accel↓, topspeed↑). **SWERVE has STEERING PODS**
   (`RobotState.moduleAngle`, robot frame): robot.ts steers them to the commanded direction
   with WPILib-style MODULE OPTIMIZATION — target set immediately, and a >90° change FLIPS the
   pod + REVERSES the drive (pod flip) so pods never rotate >90° and a 180° reversal is instant
   (`MODULE_SLEW_RATE` 7). **Swerve = FOUR INDEPENDENT modules** (`RobotState.moduleAngles[4]`,
   FL/FR/BL/BR): robot.ts does real per-module INVERSE kinematics (target vel = translation + ω×r),
   per-module pod-flip + slew, and FORWARD kinematics of the pods for the achieved chassis motion.
   **Balancing WEAKNESS is WOBBLE, not weight** (user decision — a heavy-swerve nerf was tried +
   reverted): each module's control loop is imperfect (`SWERVE_WOBBLE_AMP`/`_FREQ`, INDEPENDENT
   phase per pod), so the mispointed pods don't cancel → real path DRIFT + a net YAW wobble driving
   straight (mecanum tracks perfectly). Rendered as 4 independently swiveling/wobbling pods
   (`drawRobot` reads `moduleAngles[i]`; `RobotPreview` static-forward, on top of the chassis); X-DRIVE renders as a
   proper X (omnis at ±45°). NICHES: tank raw power/no-strafe · swerve strongest-but-imprecise
   (wobble + reorient lag) · mecanum light/instant/precise but weaker · x-drive deliberately-weak
   novelty. **PUSHING POWER = effective Rapier shove mass**
   (session 7) at `physicsEngine.ts` `setMass`: `massLb · pushMult · rpmPush · (1−powerDraw)`,
   `rpmPush = clamp(REF_DRIVE_RPM/driveRpm, 0.6, 1.8)` — geared-for-speed ⇒ less torque.
   So push scales with drivetrain (tank 1.7 … xdrive 0.45), mass↑, rpm↓, power-draw↓.
   `driveParams.accel` uses REAL mass, so inflating the shove mass never touches linear
   accel; the mass-weighted-shove smoke checks divide out the mults so they hold.
   **Per-drivetrain CLAMPS** live in `DRIVETRAIN_LIMITS` ({min/maxMass, min/maxRpm}, replacing
   the old `SWERVE_*` consts); the mass FLOOR is raised by flywheel inertia
   (`INERTIA_MASS_FLOOR 14`, a heavier flywheel) via `massLimits(dt, inertia)` / `rpmLimits(dt)`
   in `drivetrain.ts` — consumed by the Menu sliders (the inertia slider bumps mass to the new
   floor; drivetrain-switch re-clamps) and `settings.ts` `coerceSettings` (reads inertia first).
   The mecanum wheel-saturation model is correct physics — keep it. Wall/structure contacts apply
   TORQUE (summed over touching corners) so a tilted robot squares up flush.
   Contact torque is PRESSURE-SCALED (`CONTACT_PRESS_GAIN`): pushing into the wall
   turns faster, and a fast angled hit also injects spin (`CONTACT_IMPACT_SPIN`,
   scaled by torque×speed — MUST scale with torque, a sign()-only kick once caused
   a numerical-noise spin-up on dead-center contacts). Flat-face alignment is
   capped at the REMAINING TILT (flushErr in `pushRobotAt`) so the heading never
   steps past flush and buzzes; ball-pin contacts pass `squareTo=false` and pivot
   freely (capping them killed corner scatter). Classifier corner eviction must
   never push a wheel TOWARD the field wall (wall-vs-structure fight = stuck robot).
   Balls have "mass" feel: robot→ball contact is near-inelastic
   (`BALL_ROBOT_RESTITUTION`), and a ball PINNED between chassis and wall transmits
   the refused push back onto the robot (`pushRobotAt`) — the robot stalls on a
   dead-center pinned ball while off-center balls squirt out sideways. The pin only
   transmits when the ROBOT drives into it (`BALL_PIN_PUSH_MIN_SPEED`): balls
   arriving under their own momentum (gate outflow into a parked robot) stop
   against the chassis instead of shoving it.
8. Audio: real FIRST field sounds (public/sounds, from Team254/cheesy-arena) + an
   announcer VOICE via speechSynthesis ("Match begins in… 3, 2, 1", "Drivers, pick up
   your controllers") — the user flip-flopped once and settled on KEEPING the voice.
   Countdown digits must interrupt in-flight speech to stay on the visual beat. Menu
   has Sounds ON/OFF (master) and Voice lines ON/OFF (falls back to beeps) toggles.
   Shoot/intake/gate SFX are SYNTHESIZED (WebAudio, `sfx*` in audio.ts) and triggered
   by edge-detection on world state in `GameController.handleActionAudio` — the sim
   core stays event-free for these. If the user ever supplies real FTC Live audio
   files, wire those in instead.
9. Stray balls must never enter goal wedges or classifier channels (solid to balls),
   and no collision may ever push a ball outside the field (final wall clamp pass).
10. The intake is physical: the collision OBB extends forward by intake reach
    (`robotExtents` in physics.ts) — it cannot clip walls/goals. THREE presets
    (user-named — keep these names): **Sloped** (ramp, trapezoid mouth in the
    frame, devours clumps), **Vector wheel** (VERTICAL compliant wheels drawn
    as a row of small rects — never circles; chassis 11.5–14.5"; steady pace),
    **Triangle** (named for its TRIANGULAR internal ball storage — hopper pips
    draw in a triangle; longest reach, devours clumps, slower transfer).
    Internal keys: sloped/vector/triangle ('compact'/'extended' in old saves
    migrate in settings.ts). **CAPTURE MODEL (session-7 physical rewrite):** each
    preset carries a `mouth` sub-object (`INTAKE_PRESETS[*].mouth`): `mouthHalf`
    (opening at the tip), `wheelHalf` (compliant-wheel capture line), `wedge`/
    `wedgeWidth`/`funnel`, `capMin`/`capMax`, `clumpInterval`, `dual`. A ball is
    captured on the wheel line at the tip of reach (width `wheelHalf`); non-overhang
    presets clamp the mouth inside the frame so a full-width chassis geometrically
    forbids side intake (unchanged). **Timing depends on WHERE the ball enters:**
    `single = capMin + (capMax−capMin)·(|localY|/wheelHalf)` — vector CENTER fast,
    its vectoring SIDES slow. **Wedges FUNNEL** off-center balls toward the
    centerline (sloped/triangle): a lateral VELOCITY nudge only (`approach(vLocal.y,
    −sign·funnel, funnel)`), never a position write — it runs before the ball solve so
    Rapier/`collideBallRobot` own penetration (no OBB fight, no explosion). **Triangle
    takes TWO per cycle** from a clump (`dual`); hopper stays a flat color array. Flank
    capture (`sideTouch`) still exists only where the vector's wheel span overhangs a
    narrower chassis, comparing SPANS not penetration (the robot moves before the ball
    pass each tick, so depth tests see phantom overlap). A clump of 2+ feeds at
    `clumpInterval`. NOTE: `halfWidth`/`perBall`/`clumpPerBall` were REMOVED (grep before
    reintroducing); top-level `reach`/`overhang`/`min/maxLength`/`fireInterval` stayed so
    `robotExtents`/the Rapier collider/length clamps are unchanged.
    Per-preset length ranges live in the preset (`minLength`/`maxLength`).
    The chassis may be NARROWER than the intake (`ROBOT_MIN_WIDTH` 10 < vector's
    17). BASE PARKING counts only the four WHEEL ground-contact points
    (`wheelContacts`, inset `WHEEL_INSET` inside the chassis — wheels are inside
    the frame, per high-level FTC builds): intake/turret overhang neither earns
    nor spoils credit. The turret never protrudes: its offset scales with length
    (`TURRET_OFFSET_FRAC`) and the drawn ring/barrel fit within the chassis.
11. Gate: a TAP drains the column — the flow physically holds the gate open until a
    gap appears at the gateway.
12. Visible MENU/RESET buttons on the game screen (don't rely on Esc/R knowledge);
    "MATCH BEGINS IN" text lead-in before the 3-2-1 digits.
13. **Controls are fully rebindable in the menu** (`src/input/bindings.ts`,
    `src/ui/ControlsSection.tsx`): every keyboard action, gamepad buttons, AND the
    drive/turn stick assignment. Escape is reserved (menu/cancel — never bindable).
    Conflict policy: a rebound key is STOLEN from its old action (may show UNBOUND).
    "Flip front" (default F / pad Y) reverses robot-centric drive so the shooter side
    leads — applied at input level in GameController, sim untouched; REVERSED chip in
    the HUD. All GameSettings persist to `localStorage['decodesim.settings.v1']`
    via `src/settings.ts` (validated field-by-field on load — corrupt/stale data
    falls back per field).
14. **Robot is fully specced + the field is multi-robot** (Phase B, "Road to
    Multiplayer"). `RobotSpec` v2 carries name/team/number, `massLb` (20–42),
    `drivetrain`, `driveRpm` (200–600), `flywheelInertia` (0–1), `canSort`, plus
    the existing length/width/intake. The menu offers 5 named `ROBOT_PRESETS`
    (cards) AND a custom builder (sliders/selects); editing flips to Custom.
    `createWorld(mode, seed, setups: RobotSetup[])` — a `RobotSetup` is
    `{id, alliance, spec, assists, startIndex}`, and ONLY filled slots spawn a
    robot (the multiplayer seam: the sim already steps N robots from the command
    map keyed by id). `START_POSES` = 3 named mirrored poses (GOAL SIDE / CENTER /
    WALL SIDE); a 2-robot alliance splits the 6 preload balls (slot A `PRELOAD`,
    slot B `HP_INITIAL_STOCK`) and starts that alliance's HP stock empty.
    Robot-robot collisions are `collideRobots` (SAT, MASS-WEIGHTED split
    `wa=mb/(ma+mb)`, restitution 0, contact torque on both — bumpers square up);
    the `step()` solver runs 2 passes of {all id-ascending pairs → `constrainRobot`
    all} so walls always win a squeeze, and records `world.rrContacts` per tick for
    the coming penalty engine. `canSort` robots fire the hopper color matching the
    next unfilled motif slot (else FIFO). Free-Drive has a "practice dummies"
    toggle (3 idle default robots as obstacles). `game.ts` uses `localRobotId`
    (not `robots[0]`); non-local robots get name/team labels + per-robot SFX.

## Gotchas

- **THEMING (dark mode).** Pref lives in `localStorage['decodesim.theme']` (`src/theme.ts`),
  never in `GameSettings` (that syncs to Postgres per account). First paint is stamped by a
  blocking inline script in `index.html`; `system` is resolved in JS so CSS sees only
  `data-theme="light|dark"`. **EVERYTHING THEMES, INCLUDING THE IN-MATCH HUD** — the old
  `:root[data-theme='dark'] .game-root` "light island" is GONE, and so is the pinning of the
  legacy bridge (`--bg`/`--panel`/`--panel-2`/`--border`/`--text`/`--muted`/`--amber`), which
  now simply ALIASES the matching `--ds-*` tokens. Three categories decide how a token behaves:
  (1) *readable against the surface* ⇒ INVERTS (`--ds-ink`, `--ds-mut`, `--ds-accent`,
  `--ds-warn`, the `-ink` siblings); (2) *a fill with fixed ink* ⇒ does NOT (`--ds-red`,
  `--ds-*-chip`, `--ds-gold`); (3) *its ground is the CANVAS* ⇒ does NOT, because the field is
  hardcoded dark — that is `--ds-on-field` / `-dim` / `-accent`, deliberately absent from the
  dark block. Use category 3 for anything drawn straight on the field or on the dark overlay
  scrims (countdown digits, mobile joystick, ranked-intro eyebrow/VS).
  A dark HUD card is only ~1.4:1 on the dark field by FILL, so its EDGE identifies it:
  floating surfaces take **`--ds-hud-line`** (readable against card *and* field), never
  `--ds-line`, which is tuned against the card behind it. `--ds-line-strong` is likewise tuned
  against `--ds-panel` and drops to 2.73:1 on the translucent HUD card — rings that must read
  there (`.hopper-pip`, `.pg-bar`) use `--ds-mut`. To detect the theme in JS read
  `document.documentElement.dataset.theme` (as `renderer.ts` does for the letterbox), not
  `getComputedStyle`. `npm run contrast` (`scripts/contrast.mjs`) asserts 135 pairs in BOTH
  themes — including the HUD, the canvas grounds, and the server-gated screens — and exits 1
  on a regression; run it after any palette edit. **A colour that is both a fill and a text
  colour will fail one of the two** — split it (`--ds-ok`/`--ds-ok-ink`).
  The letterbox themes (`COLORS.backdropDark`) but the field mat does NOT; the board is
  separated from the dark floor by its outline alone (mat vs dark bg is 1.03:1), so keep it.
- Camera/screen math: `worldToScreen` = rotate by `viewAngle`, then y-flip. Driver
  stick → field frame uses `rot(stick, -viewAngle)` (the INVERSE — sign matters since
  view angles are ±90°).
- The basin containment normal points INTO the field; push balls back inside with `-n`
  (a sign inversion here once caused positions to explode to 1e250).
- `robotIntersectsRect` (SAT) exists because thin zones (gate tape) can be covered by
  the robot body with no corner inside.
- Windows PowerShell 5.1: no `&&` in npm-adjacent commands; use `;` or `if ($?)`.
- The manual PDFs' text is extractable with the stdlib scripts pattern (see memory);
  figures are embedded images — extract and Read them as images when geometry questions
  come up. `manual09/10` text dumps live in the old session scratchpad (regenerate if needed).

## State of play / roadmap

Done: full solo match + free drive, scoring per manual (classified 3 / overflow 1 /
pattern 2/slot / leave 3 / depot 1 / base 5/10+10), motif randomization, human-player
restock, gamepad + keyboard, physical basin/rail/gate classifier, contact-torque robot
physics, driver assists (menu), audio (field sounds + announcer + menu toggles),
pre-match countdown, favicon, on-screen MENU/RESET, Electron packaging, robot
size/intake presets in menu, rebindable keyboard+gamepad controls with localStorage
persistence, flip-front toggle, pinned-ball resistance physics, contact-time
overflow decision, synthesized shoot/intake/gate SFX, pressure-scaled wall torque,
END GAME at 20s left (`ENDGAME_START`: warning cue + HUD label/tint), vector-intake
side capture, wheel-contact base parking + narrow chassis, three named intake
presets (sloped / vector wheel / triangle) with per-preset length + fire cadence,
trapezoid mouths + geometric side-intake rules + clump feeding, **session-7 physical
intake rewrite** (per-preset `mouth` geometry, position-dependent swallow timing, wedge
funneling, triangle dual-capture), **power draw** (spun-up flywheel + intake slow the
drive and weaken the shove), **drivetrain push/accel retune + per-drivetrain clamps +
inertia→mass-floor coupling** (`BALANCE_VERSION` 2).
**Phase A (field markings), Phase B (RobotSpec v2, four drivetrains, flywheel
recovery, canSort, robot presets + custom builder, start positions, practice
dummies, mass-weighted robot-robot collisions, multi-robot spawn/step), and
Phase C (penalty engine) are DONE and green.** The netcode/physics roadmap now lives
at `docs/netcodeplan.md` (supersedes the old "Road to Multiplayer" plan + the Phase D
notes). **Netcode Phase 0 (server-authoritative + client prediction) is DONE and
build/smoke-green** (see below); the old P2P lockstep is deleted.
`scripts/smoke.ts` has ~205 checks — keep adding one per behavior change.

**Phase C — penalty engine** (`src/sim/penalties.ts`, `updatePenalties` called in
`world.ts` after the robot-robot solver). **MINOR = 5 pts, MAJOR = 15 pts** (user-set,
NOT the manual's 10/30), awarded to the OPPOSING (victim) alliance via `awardFoul` in
scoring.ts → the victim's `ScoreBreakdown.foulPoints`; `match.fouls[offender]` tallies
committed counts for the HUD. Rules (numbers/severities per Section 11 — corrected
July 2026 to follow the manual): **GATE/RAMP rules** (`updateGateFouls`) — **G417**
TOUCHING an OPPONENT's gate is an immediate **MAJOR** (edge-triggered; fires when the
opponent's bumper contacts the gate ARM — `robotIntersectsRect(r, gateArmRect(a))` —
**even if it never opens the gate**: contact with the arm is the violation, no push
required. This is deliberately DIFFERENT from `updateGates`' physical push-to-open
condition (`pushingGate`, which additionally needs an active shove). Touching your OWN
gate is legal), and **G418.B** each classified artifact
INSIDE the opponent's RAMP at the moment the gate is opened is a **MAJOR per
artifact**. The engine remembers which opponent opened each gate (`penalties.
gateCulprit`) and bills every ball that then drains off that ramp (`penalties.
rampBallIds` tracks the committed, non-overflow rail balls) to them even after they
leave — matching manual Example 3 (open the opponent gate → 1 G417 + N G418). Then the
**protected-zone** rules use one uniform model —
each zone is OWNED by an alliance and a cross-alliance CONTACT while either robot is
in it fouls the NON-owner ("regardless of who initiates"): **G424 gate zone** (MINOR
— protects the OWNER's access to their own gate; contact-based, NOT the old homebrew
"presence in the opponent gate = MAJOR", which is gone. The gate is still physically
openable by ANYONE via `updateGates`; opening it is legal, only in-zone *contact*
fouls), **G425 tunnel** (MINOR — `tunnelStrip(a)` sits under a's goal but is OWNED by
`other(a)`, so the intruder/offender is `a`; G425 fires only when the INTRUDER itself
is in the strip — an owner defending inside its OWN tunnel is not a foul). **G424.A
gate↔tunnel exception**: a side wall holds one alliance's gate zone AND the other's
secret tunnel (they overlap in the classifier corner), and the two rules are MUTUALLY
EXCLUSIVE — if the gate robot is ALSO in the opponent's tunnel it's G425 only (on the
gate robot); if it's clear of the tunnel it's G424 only (on the opponent). **G426
loading** (MINOR), **G427 base**
(MAJOR in endgame + sets `RobotState.baseAwarded` → full base at match end). **G402
auto interference** (MAJOR): an alliance BELONGS on its **goalSide** (robots stage
near their cross-court goal: blue −x, red +x — NOT driverSide, which was inverted and
fouled the alliance sitting on its OWN side); fires when fully on the opponent's side
+ contact during AUTO, on the CROSSER. **G422 pinning** (MINOR, →MAJOR on a repeat by
the same pinner: 3 s of contact while the pinned robot commands motion, stays < 8
in/s, and hasn't escaped 24"). Pinner-vs-pinned is disambiguated by
`pinnedAgainstWall` — the VICTIM must be trapped against a field boundary with the
pinner on the open-field side (`PIN_WALL_SLOP`); without it a wall shove satisfied
BOTH orderings and wrongly fouled the victim's alliance too. **Fouls are
EDGE-triggered — NO cooldown/timer** (user was
emphatic): a violation fires on the false→true edge, once while held, and AGAIN
immediately on re-entry (leave the opponent gate and re-enter ⇒ instant new foul).
`fire()` is idempotent within a tick (a duplicated `rrContacts` pair, or two rules on
one key, awards once). All penalty state (`world.penalties`: episodes/pins/pinFouls) is
plain JSON so determinism/lockstep hold. HUD: FOULS chip (committed counts) + a
PENALTIES score-table row (`foulPoints`).

**Netcode Phase 0 — server-authoritative + client-side prediction** (DONE, build +
smoke + live-2-client green). The old P2P lockstep/mesh/TURN/Supabase-lobby is DELETED
(`mesh.ts`, `lockstep.ts`, `lobby.ts` gone); see `docs/netcodeplan.md` for the full
roadmap (Phases 1–3 + UI redesign). Architecture:
- **`server/`** (Node + `ws`, run via `tsx`) — imports the SHARED `src/sim` (no fork)
  and runs a fixed-`SIM_DT` authoritative loop per room: ingest each client's latest
  `RobotCommand` by robot id, `step(world, SIM_DT, inputs)`, broadcast a full-world
  `snapshot` every 3 ticks (~20 Hz). `server/room.ts` = lobby + match + host lifecycle +
  deterministic drop (a client leaving → its robot runs ZERO from the current tick,
  broadcast). `server/index.ts` = WS accept + room registry. `tsconfig.server.json` +
  `npm run server` / `server:start` / `server:check`.
- **`src/net/protocol.ts`** — kept the quantize helpers (`quantize/dequantize/localize`);
  replaced lockstep packets with JSON `ClientMsg` (join/update/start/restart/**input**)
  and `ServerMsg` (welcome/roster/**matchStart**/**snapshot**/drop). Determinism rule is
  now NARROWER: no cross-machine float determinism needed (server is authority) — only
  that the client PREDICTS on `localizeCommand(cmd)` (what the server decodes).
- **`src/net/session.ts`** is now the `NetSession` INTERFACE (reconcile contract:
  `sendInput`, `takeSnapshot`, `isHost`, `requestRestart`, `onRestart`, `seed`, `setups`,
  `localRobotId`, `status`, `dispose`). `transport.ts` (`WebSocketTransport`, Phase-1 seam
  for WebTransport), `lobbyClient.ts` (thin lobby over the socket), `serverSession.ts`
  (`ServerSession implements NetSession` — takes over the transport at matchStart).
- **`game.ts`**: `stepNetworked` → **`stepServer` (predict + reconcile)**. Each tick it
  applies its OWN command locally + `sendInput`, buffering it; on a snapshot it snaps
  `this.world` to the authoritative world and REPLAYS buffered inputs past `serverTick`
  (`reconcile`). Only the local robot is predicted; remote robots default to ZERO in
  `step()` and get corrected each snapshot. **`session: null` ⇒ solo path bit-identical.**
- **UI**: `App.tsx` gates MULTIPLAYER on `gameServerConfigured()` (`VITE_GAME_SERVER_URL`,
  `.env.example`); `Lobby.tsx` runs on the game-server socket (no mesh/presence/ready-mesh
  gating). HUD `net` chip shape unchanged.
- **Why this fixes disconnects**: no head-of-line blocking (one laggy/dropped client never
  freezes others — prediction + authoritative correction), central drop/liveness authority.
  The old cross-browser-desync trig discipline (`dsin/dcos/datan2`) is NO LONGER a
  correctness requirement here, but is **still in `src/sim`** and stays until Phase 2
  removes it — do not rip it out yet.

**Phase 1 DONE + DEPLOYED** (Fly app `dohun-sim-decode`, `VITE_GAME_SERVER_URL` on
Vercel). Per-tick server input buffering (`frameCommands`, hold-last). **SNAPSHOT RATE
is 30 Hz** (`room.ts` `SNAPSHOT_INTERVAL = 2`) — dropped from 60 after network profiling
(user was emphatic the lag was NETWORK, not CPU; halving snapshot bandwidth + TCP frames
was part of the fix, alongside `setNoDelay(true)` to kill Nagle on the server sockets).
**SMOOTHING is Minecraft-style entity INTERPOLATION, not extrapolation** (`game.ts`
`displayWorld`/`snapBuf`/`renderTick`, `INTERP_DELAY_TICKS`/`INTERP_BUFFER`): the render
clock runs a few ticks behind the newest snapshot and REMOTE ROBOTS lerp between the two
bracketing authoritative snapshots, so they glide at any snapshot rate. The LOCAL robot
stays predicted with a decaying `localSmooth` error offset (cosmetic only — never touches
`this.world`, so determinism/anti-cheat hold). **BALLS are NOT interpolated** — they spawn/
despawn (launches) and collide, and lerping them ghost-cloned fresh balls + blended
colliding balls THROUGH each other; they render straight from the predicted sim.
**CONNECTION-QUALITY HUD** (`ServerSession` + `NetQuality` chip, top-right): a `ping`/`pong`
probe (once/sec, echoed at the server socket level) → smoothed RTT; snapshot arrival rate
(Hz) + inter-arrival JITTER (mean-abs-dev) measured client-side; a SMOOTH/OK/CHOPPY
coloured dot from rtt+jitter. Jitter is the real choppiness signal — surface it when
diagnosing lag reports. **RECONNECTION (transient drops)**: server holds a dropped slot
`RECONNECT_GRACE_MS` (`room.ts` `detach`/`reattach`/`checkGrace`), transport auto-reconnects
(`onReopen`/`onDown`/`onFail`), session re-sends `rejoin`. **DELTA SNAPSHOTS**:
`slimWorld`/`unslimWorld` (`protocol.ts`) strip static robot `spec` (client re-injects from
setups) + delta the balls (send the id ORDER every frame — determinism — but only CHANGED
ball data); reconnect re-primes with a keyframe. **DEPLOY**: `Dockerfile`+`fly.toml`+
`docs/deploy.md`, `GET /health`; `ws`+`tsx` are runtime `dependencies`. Deploy protocol
(SIM/server change): commit on alpha → **`./scripts/fly-deploy.sh`** → verify `/health` →
Vercel auto-deploys clients. **NEVER deploy with a bare `flyctl deploy`** — fly.toml can
only express ONE `[[vm]]` size, so a bare deploy re-applies `shared-cpu-4x` (iad's size) to
EVERY machine and silently UPSIZES the cheap satellites (sjc/lhr/syd/nrt, `shared-cpu-1x`/1024MB)
to shared-cpu-4x. The wrapper deploys and then re-shrinks them; verify with
`fly machine list -a dohun-sim-decode`. **The one Fly app serves EVERY client version** (alpha/beta/
main all bake the same `VITE_GAME_SERVER_URL`), so protocol changes MUST stay
backward-compatible — new clients advertise `caps` (`CLIENT_CAPS` in `protocol.ts`) on
`join`/`queue` and the server feature-gates on them (e.g. the pre-match strategy window
only opens when every client supports `'strategy'`, else `startRankedImmediate`). With
that discipline you no longer have to merge/sync alpha→main before deploying the server —
old branch clients keep working. Still open: **WebTransport**
(deferred — needs TLS-deploy validation, and the delta must switch to ACK-keyed for
unreliable datagrams); full-reload reconnect (localStorage session restore). Deferred:
obelisk AprilTag visuals, mobile/touch, deferred fouls (G408 possession>3 / plowing).

**Phase 3 — accounts / ranked / leaderboards / records (LIVE).** Neon Postgres via
`server/db/` (`repo.ts` + `migrations/`, `0003_glicko.sql` adds rd/vol), written at match
end OFF the hot path. **Ranked is Glicko-2** (`server/ranked.ts`: rating + RD + volatility,
`SCALE 173.7178`, `CENTER 1500`, provisional RD shown with a "?"), decided AFTER the score
SETTLES (`room.ts` `MATCH_SETTLE_S` — late-draining balls finish scoring before finalize);
an opponent who LEAVES mid-match is retained (`departed`) so the match still rates (chess.com
forfeit). `EloDelta` drives the results-screen reveal animation. **SOLO RECORD RUNS**
(score-attack, no PvP): the results screen shows NET score (earned − own penalties, `−`
sign), NO opponent/winner, and PB / WR / global-rank (`RecordRankInfo`, per mode×drivetrain×
season); the DB save + reveal are synced to the whoosh so late points aren't cut off.
**ADMIN MENU** (`src/ui/Admin.tsx`, `/admin`): gated on the signed-in UUID (`ADMIN_USER_IDS`
env; server enforces every action independently) — schedule a server restart with a countdown
notice broadcast to all clients (`serverNotice` banner). **VERSION GATE**: a new client build
is detected (`__BUILD_ID__` from git sha → `/version.json` poll, `useNewVersion`) and, when a
player STARTS a run (never mid-run), forces a refresh — NO "play anyway" (everyone must be on
the same version for multiplayer). Still open (Phase 3): matchmaking polish, replay UI,
leaderboard tiers, the full UI redesign (`docs/netcodeplan.md`).

**Phase 2 — Rapier 2D physics: ROBOTS slice DONE + green (~205 smoke checks).** Robot
collision is Rapier (`physicsEngine.ts` — see the architecture bullet above); balls are
still bespoke (slice 2, deferred — the trickiest port per `docs/netcodeplan.md`). Slice
2 = balls → Rapier bodies/sensors while KEEPING basin/rail/gate scripted (contact-time
classified-vs-overflow commit must stay exact); ONLY after that, delete the dead
`collideRobots`/`constrainRobot` and remove the `dsin/dcos/datan2` discipline.
**Ball containment invariant** (added when a ground ball could mesh under the classifier
and become ungrabbable): ground balls get a HARD geometric eviction pass in `world.ts`
(walls + goal faces via `clampBallPosToStatics`, AND `collideBallRect` against both
classifier rects) because Rapier's soft contacts can't clear a DEEPLY embedded body. Any
new solid a ball can tunnel into needs the same geometric clamp, not just a Rapier collider.

## Next up (roadmap — not yet started)

1. **Penalty hitbox audit** — the foul rules are correct (Phase C), but re-verify the
   ZONE GEOMETRY / contact hitboxes each rule tests against the manual figures:
   `gateZone`/`gateTapeSegments`, `tunnelStrip`, `allianceArea` (loading/base), the
   `pinnedAgainstWall` slop, and the SAT contact test (`rrContacts`) — make sure the
   trigger volumes match the real field markings and robot bumper extents, not just the
   rule logic. Tighten with smoke cases per zone.
2. **Major intake revamp — DONE (session 7).** Rewrote the intake to a physical `mouth`
   model (per-preset geometry, position-dependent swallow timing, wedge funneling, triangle
   dual-capture) alongside power draw + the drivetrain push/clamp/inertia-coupling work. See
   product decision #10 (updated) + HANDOFF. Preserved the user-named presets and the "no side
   intake except where the vector wheel overhangs a narrower chassis" feel. Further tuning is
   welcome — #10 is the new baseline, not a frozen spec.
