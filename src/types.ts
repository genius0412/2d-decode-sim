import type { ControlBindings } from './input/bindings';
import type { GameId } from './games/types';
import type { ChainState } from './games/chain/state';
export type { GameId } from './games/types';

export type Alliance = 'red' | 'blue';
export type ArtifactColor = 'purple' | 'green';
export type Motif = readonly [ArtifactColor, ArtifactColor, ArtifactColor];

export type GameMode = 'match' | 'free';

export interface Vec2 {
  x: number;
  y: number;
}

/** Per-tick, per-robot, serializable driver command. Translation is in the
 * DRIVER frame (screen frame): +y = away from the driver, +x = driver's right.
 * Robot configuration (drive style, assists) is menu-only, not keybinds. */
export interface RobotCommand {
  driveX: number; // -1..1
  driveY: number; // -1..1
  rotate: number; // -1..1, CCW positive in driver frame
  leftDrive: number; // -1..1, for tank drive (left side)
  rightDrive: number; // -1..1, for tank drive (right side)
  intake: boolean;
  fire: boolean;
  /** Chain Reaction: pick up a nearby ring / place a carried ring on a hook. Edge-
   * triggered in the sim (acts once per press). Optional (DECODE omits it). */
  catalyst?: boolean;
  /** Chain Reaction, LAUNCHER catalyst: THROW the carried ring downfield from the catapult.
   * Its own button so it is never ambiguous with the claw's grab/place. Edge-triggered in
   * the sim. Optional (old clients/replays omit it). */
  fling?: boolean;
  /** BUTTERFLY drivetrain: drop the other wheel set (tank ⇄ mecanum). Edge-triggered
   * in the sim like `catalyst`, so a held button flips once. Ignored by every other
   * drivetrain. Optional (old clients/replays omit it). */
  driveMode?: boolean;
}

/** menu-configured driver assists */
export interface AssistConfig {
  fieldCentric: boolean;
  aimAssist: boolean;
  autoIntake: boolean;
  autoFire: boolean;
}

export type IntakeStyle = 'sloped' | 'vector' | 'triangle';
export type DrivetrainType = 'mecanum' | 'tank' | 'swerve' | 'xdrive' | 'butterfly';

export interface RobotSpec {
  /** robot display name, team name, team number (0 = unset) */
  name: string;
  teamName: string;
  teamNumber: number;
  /** chassis length (front-back) and width, inches; chassis + intake reach must fit 18in */
  length: number;
  width: number;
  intake: IntakeStyle;
  /** mass in lb (20–42): heavier shoves harder, accelerates slower */
  massLb: number;
  drivetrain: DrivetrainType;
  /** wheel RPM abstraction (200–600): top speed up, acceleration down.
   * For BUTTERFLY this is the MECANUM-mode gearing; `tankRpm` is the other set. */
  driveRpm: number;
  /** BUTTERFLY only: the TANK-mode wheel RPM. A butterfly carries two independently
   * geared wheel sets, so it gets its own slider — teams routinely gear the traction
   * set for torque and the mecanum set for speed. Range is the TANK envelope
   * (`butterflyTankRpmLimits`), which is torque-biased and tops out lower than the
   * mecanum one. Optional so every non-butterfly spec omits it (defaulted in
   * `coerceSpec`, which also clamps it). */
  tankRpm?: number;
  /** 0–1: high inertia keeps rapid fire fast on long (high-speed) shots;
   * low inertia is quick up close but recovers slowly after far shots */
  flywheelInertia: number;
  /** robot can pick which hopper color to fire (chases the motif) */
  canSort: boolean;
  /** DRIVER ASSISTS saved WITH THE ROBOT — BOTH games. Drive frame (field/robot-centric)
   * plus the aim/intake/fire automation. They live on the spec so they travel with
   * everything a spec travels with: saved robot slots, the per-game loadout `switchGame`
   * swaps, presets, and account sync — rather than being a separate global preference.
   * EVERY assist DEFAULTS ON (`PLAYER_ASSISTS` in sim/spawn.ts).
   * This is the STORED preference. The sim still reads the resolved `RobotSetup.assists`
   * (which the UI fills from here), so the spawn seam and the wire are unchanged.
   * Optional so old saves omit it (defaulted in `coerceSpec`). */
  assists?: AssistConfig;
  /** SUPPORTER COSMETIC: a `CHASSIS_COLORS` key for the chassis fill. Purely
   * decorative — the alliance is carried by the OUTLINE, never this — and
   * optional, so every existing spec, save, and replay stays valid. */
  chassisColor?: string;
  /** Chain Reaction: how many Particles the robot's hopper holds (1–30 slider).
   * Optional so DECODE specs/old saves omit it (defaulted in coerceSpec). */
  ballStorage?: number;
  /** Chain Reaction: ground clearance in inches (slider). Must be ≥ a beam's height
   * to drive over it, but more clearance RAISES the center of gravity → sluggish
   * handling. Optional (defaulted in coerceSpec). */
  groundClearance?: number;
  /** Chain Reaction: the SCORING archetype (the robot's expansion mechanism).
   *  • 'turret' — a dye-rotor + turreted single-shooter: indexes Particles ONE at a
   *    time and launches them into the Accelerator from ANYWHERE (auto-aimed arc).
   *  • 'dumper' — no shooter: drive up to the Accelerator mouth and DUMP the whole
   *    hopper at once (huge burst, but zero range — you must cycle to the wall).
   * Optional (defaulted in coerceSpec). */
  scoreMode?: ChainScoreMode;
  /** Chain Reaction: the intake DESIGN. For now the only option is the full-width sweeper
   *  ('sweeper') — a roller spanning the whole chassis width that gulps Particles on contact.
   * Optional (defaulted in coerceSpec). */
  chainIntake?: ChainIntakeStyle;
  /** Chain Reaction: which chassis edge(s) the sweeper rollers ride on. Same roller, different
   * position — it moves the CAPTURE band AND the collision footprint together. Open edges cost
   * hopper volume ⇒ lower storage cap (see `chainStorageMax`). Optional (defaulted in
   * coerceSpec, which also migrates the legacy `intakeSide` flag). */
  intakeMount?: ChainIntakeMount;
  /** Chain Reaction: which chassis edge the drum/dumper launcher fires over. The robot turns
   * THAT edge to the goal to shoot. No effect on a turret (top-mounted). Optional (defaulted in
   * coerceSpec, which also migrates the legacy `shooterRear` flag). */
  shooterMount?: ChainShooterMount;
  /** Chain Reaction: the CATALYST mechanism archetype (arm / launcher / turret). Optional
   * (defaulted in coerceSpec). */
  catalystType?: ChainCatalystType;
  /** Chain Reaction: where on the chassis the catalyst mechanism is BOLTED. Optional
   * (defaulted in coerceSpec). */
  catalystMount?: ChainCatalystMount;
  /**
   * Chain Reaction: the mechanism is on a SWING — one arm on a pivot that rotates between
   * two working ends, so it serves both without turning the chassis — and WHICH WAY it
   * swings. Absent ⇒ it does not swing.
   *
   *   'fb' — front↔back: the classic swing, reaching over both ends
   *   'lr' — left↔right: the same arm turned 90°, reaching over both flanks
   *
   * SEPARATE from the mount on purpose. The swing used to BE a mount (`'frontback'`, welded
   * to the centre cell), which made "a swing" and "on the right" mutually exclusive choices
   * in one picker — so a fore-aft swing arm bolted to the right rail, a real build, could not
   * be expressed at all. The mount now says where the pivot IS and this says how it MOVES,
   * which is also what makes the two axes possible: which positions a pivot can use follows
   * from the direction it swings (see `SWING_MOUNTS`). Legacy `true` reads as 'fb'. */
  catalystSwing?: ChainSwingAxis;
  /** Chain Reaction, LAUNCHER archetype only: the fixed YAW the catapult is bolted at,
   * in DEGREES relative to chassis forward (−180..180, 15° steps). The catapult is NOT on
   * a turret — it throws wherever the chassis is pointed plus this offset — so which way
   * you mount it is a real build decision, and it is INDEPENDENT of the claw's mount edge.
   * Optional (defaulted in coerceSpec). */
  catapultYaw?: number;
  /** Chain Reaction, LAUNCHER archetype only: how far the catapult is built to throw, in
   * INCHES (the nominal range; the actual landing scatters around it). A longer throw
   * needs more stored energy, so it costs weight and takes longer to re-cock. Optional
   * (defaulted in coerceSpec). */
  catapultRange?: number;
  /** @deprecated superseded by `intakeMount`. Kept so older saves migrate and older peers/
   * servers (which only know this flag) still see the closest equivalent — `coerceSpec`
   * MIRRORS it from `intakeMount`. Never read it directly; use `intakeMountOf`. */
  intakeSide?: boolean;
  /** @deprecated superseded by `shooterMount` (same mirroring contract as `intakeSide`).
   * Never read it directly; use `shooterMountOf`. */
  shooterRear?: boolean;
}

/** Chain Reaction scoring archetype (see `RobotSpec.scoreMode`).
 *  • turret — turreted single-shooter, indexes one at a time, aims itself, any range.
 *  • twinturret — TWO shooters on one turret, fired alternately from two barrels: far more
 *    throughput than a single turret but well short of double (they share one indexer and
 *    one aim solution), and the second assembly costs hopper volume and weight.
 *  • drum   — a chassis-wide flywheel drum (no turret): the robot turns to face the goal,
 *    then fires up to 6 at once in a parallel line from ANY range (uniform velocity).
 *  • dumper — a chassis-wide catapult (no turret): turns to face the goal, then flings the
 *    WHOLE hopper at once from LIMITED range (side-to-side velocity variance ⇒ scatter). */
export type ChainScoreMode = 'turret' | 'twinturret' | 'drum' | 'dumper';
/** Chain Reaction intake design (see `RobotSpec.chainIntake`). Only the full-width sweeper
 * exists for now; the type is kept open for future designs. */
export type ChainIntakeStyle = 'sweeper';

/** Chain Reaction intake MOUNT (see `RobotSpec.intakeMount`) — which chassis edge(s) carry the
 * sweeper rollers. The mount moves the capture band AND the collision footprint together.
 *  • front     — one bar across the chassis front (the default).
 *  • back      — the same bar across the REAR: a mirror of front, so it costs nothing.
 *  • side      — rollers on BOTH flanks: collect a stream you drive alongside, but the open
 *    flanks eat into the hopper ⇒ the smallest storage cap.
 *  • frontback — rollers on BOTH ends: collect driving either way (no turning around), at a
 *    milder storage cost than `side`. */
export type ChainIntakeMount = 'front' | 'back' | 'side' | 'frontback';

/** Where a Chain Reaction mechanism sits on the chassis, in the robot frame (+x forward,
 * +y the robot's LEFT). The four EDGE positions are the mid-points of each side; the four
 * CORNERS are the actual corner points; `center` is the chassis middle — a turret only,
 * since anything that has to reach outward cannot live there. */
export type ChainMountPos =
  | 'front' | 'back' | 'left' | 'right'
  | 'frontleft' | 'frontright' | 'backleft' | 'backright'
  | 'center';

/** Chain Reaction shooter MOUNT (see `RobotSpec.shooterMount`). It means two related but
 * distinct things, resolved by `isTurreted`:
 *  • TURRETLESS (drum / dumper) — the chassis EDGE the launcher fires over, i.e. the edge the
 *    robot turns to the goal. Only the four edges are legal; `coerceSpec` folds a corner or
 *    centre to the nearest edge, because a launch LINE has to span a side.
 *  • TURRETED (turret / twin turret) — where the turret is BOLTED. A turret aims itself, so
 *    this is not a facing; it is the point the Particle is actually born at, which is why a
 *    back-mounted turret visibly shoots from the back of the robot. Any `ChainMountPos`. */
export type ChainShooterMount = ChainMountPos;

/** Chain Reaction CATALYST mechanism (see `RobotSpec.catalystType`) — how the robot handles
 * the 6" rings. Three real archetypes, each with a genuinely different reach envelope:
 *  • arm      — a claw on a LONG arm out the mounted edge. The longest reach of the three,
 *    but it must roughly FACE what it is grabbing and the arm is slow to cycle.
 *  • launcher — a short ground-intake CLAW plus a CATAPULT. The claw grabs and places as
 *    normal (shortest reach of the three); the catapult is a separate trick that FLINGS a
 *    carried ring far downfield to reposition it, deliberately inaccurately. Transport,
 *    not scoring.
 *  • turret   — a claw on a rail + turret that auto-tracks the nearest hook. Reaches in
 *    ANY direction (no need to point the chassis) and cycles fastest, but is the heaviest
 *    and its reach is middling. */
/**
 * How the catalyst mechanism is built.
 *  - `arm`      — a fixed arm + claw at one mount
 *  - `launcher` — a low scoop that flings a ring onto a hook
 *  - `turret`   — a claw on a rotating turret: aims anywhere, stays put
 *  - `rail`     — a turret claw on a linear TRACK that also traverses the chassis side,
 *                 so the claw can be positioned as well as aimed. The track spans a whole
 *                 side, which is why `CHAIN_RAIL_MOUNTS` allows only the four edges.
 */
export type ChainCatalystType = 'arm' | 'launcher' | 'turret' | 'rail';

/**
 * Where the catalyst mechanism is BOLTED. Sets where it reaches from and which way its reach
 * cone points (the `turret` type is omnidirectional, so the mount only moves the pivot).
 *
 * Any `ChainMountPos`, including `center` — which is only meaningful together with
 * `RobotSpec.catalystSwing`, since a claw cannot reach anything from the middle of a chassis
 * unless it is on an arm that swings out to an end.
 *
 * `'frontback'` is the LEGACY value for what is now `{ mount: 'center', swing: true }`. It is
 * still accepted on the wire and from old saves; `coerceSpec` migrates it. */
export type ChainCatalystMount = ChainMountPos | 'frontback';

/** which way a swing arm rotates: front↔back, or left↔right */
export type ChainSwingAxis = 'fb' | 'lr';

export type BallState =
  | { kind: 'ground' }
  /** in the air. `target` = the accelerator it was launched at. Chain Reaction:
   * once it enters that accelerator it is `scored`, then FUNNELS down inside the goal
   * for `funnelT` seconds before the wall-side launcher flings it back onto the field
   * (same ball, still 'flight' until it lands). `staged` = pre-match: HELD inside the goal
   * (inert) until the launcher ejects it during field randomization (see prematchRandomize). */
  | { kind: 'flight'; target: Alliance; scored?: boolean; funnelT?: number; staged?: boolean }
  /** jumbling inside the goal's triangular basin, funnelling toward the
   * classifier entrance under gravity */
  | { kind: 'basin'; goal: Alliance }
  /** on the classifier rail: 1D coordinate s from the gate (s=0), flowing
   * down under gravity and stacking by contact. overflow balls ride over the
   * stack and always continue out over the gate. pending balls have boarded
   * but not yet met the stack — classified vs overflow is decided at first
   * contact (9 retained below at that moment ⇒ overflow). */
  | { kind: 'rail'; goal: Alliance; s: number; v: number; overflow: boolean; pending?: boolean }
  /** captured and PHYSICALLY stored in a robot's intake: parked at storage slot
   * `slot` of robot `robot`. `lx`/`ly` are the ball's CURRENT offset in the robot
   * frame — it tracks the robot rigidly (no lag) and slides these toward the slot
   * target. `side` (−1/+1/0) is which side of the triangle front row it sits on
   * (a 3rd ball entering a side pushes the resident ball to the other side). The
   * robot's `hopper` color array mirrors these (count + colors synced). */
  | { kind: 'held'; robot: number; slot: number; lx: number; ly: number; side: number }
  | { kind: 'stock'; alliance: Alliance }; // held by the human player, off-field

export interface Artifact {
  id: number;
  color: ArtifactColor;
  state: BallState;
  pos: Vec2;
  vel: Vec2;
  z: number;
  vz: number;
}

export interface RobotState {
  id: number;
  alliance: Alliance;
  spec: RobotSpec;
  pos: Vec2;
  heading: number; // field frame, radians, 0 = +x, CCW positive
  vel: Vec2; // field frame, in/s
  /**
   * WHAT A CONTACT DID TO THIS CHASSIS LAST TICK — the velocity (and spin) the solver produced
   * that the drivetrain did not ask for. Written by `solveRobots`, read one tick later by the
   * per-wheel traction model in `updateRobot`, which is what a tyre resists.
   *
   * It has to be carried, because a force handed to the solver is computed BEFORE the solve
   * and a contact happens DURING it. One tick of lag is not a fudge here: a real tyre has a
   * relaxation length for exactly this reason, and the lag is what lets an IMPACT through (its
   * first tick meets no resisting force) while a sustained lean is refused every tick after
   * the first. Plain numbers, so snapshots and replays carry them like everything else.
   */
  slipX?: number;
  slipY?: number;
  slipW?: number;
  angVel: number;
  turretHeading: number; // field frame
  /** SWERVE per-module steer angles (robot frame, rad), one per wheel in the
   * corner order [FL, FR, BL, BR] (matching drawRobot's wheels). Each module has
   * its OWN imperfect steering loop, so their small INDEPENDENT angle errors don't
   * cancel — producing the real drift + yaw wobble when driving straight. The net
   * chassis motion is the forward-kinematics of the four modules. Unused by other
   * drivetrains (all stay 0). Drives the per-pod wheel rendering. */
  moduleAngles: number[];
  /** SWERVE per-module TARGET steer angles (robot frame, rad) — the last COMMANDED
   * direction the pods are slewing to. Updated from the drive command; HELD when the
   * stick is released so the pods finish turning to (and keep) the commanded angle
   * even after a brief tap, instead of freezing partway. `moduleAngles` chases these
   * (plus the wobble). */
  moduleTargets: number[];
  /** CHAIN REACTION, `rail` catalyst only: where the claw's CARRIAGE sits along its track,
   * −1 .. +1 across the mounted side (0 = centred). Runtime state, not a build choice — the
   * carriage traverses toward whatever the claw is working at, at a finite rate
   * (`CHAIN_RAIL_RATE`), which is the point of buying a rail instead of a fixed turret.
   * Every other catalyst type leaves it at 0. */
  catalystRail: number;
  /** BUTTERFLY drivetrain: is the TRACTION (tank) set the one on the ground right now?
   * false ⇒ the mecanum set is down (the spawn default). RUNTIME state, not a build
   * choice — the driver drops the other set mid-match with the `driveMode` command, and
   * it selects BOTH the mode's handling multipliers and which RPM slider applies (see
   * `driveParams`). Always present so snapshots/replays carry it; every other drivetrain
   * ignores it. */
  butterflyTank: boolean;
  /** TWIN TURRET: which of the two barrels fires NEXT (they alternate). Plain bool so
   * snapshots/replays reproduce the same muzzle; unused by every other archetype. */
  twinBarrel: boolean;
  /** was the `driveMode` button held last tick? The sim edge-triggers the butterfly swap
   * off this, so holding the button swaps once (not every tick). Plain bool ⇒ snapshot-safe. */
  driveModeHeld: boolean;
  hopper: ArtifactColor[]; // FIFO, max 3
  fieldCentric: boolean;
  aimAssist: boolean;
  autoIntake: boolean; // intake runs whenever the hopper has room
  autoFire: boolean; // fire automatically when in the zone and on target
  lastFireAt: number;
  lastIntakeAt: number;
  /** earliest world.time the shooter may fire again (transfer cadence +
   * flywheel recovery after energetic shots) */
  fireReadyAt: number;
  /** 0..1 flywheel spin level, ramped by distance to this robot's own goal
   * (set in updateRobotActions; feeds power draw one tick later) */
  flywheelSpin: number;
  /** positive rate of change of flywheelSpin (1/s) — how fast the wheel is
   * SPINNING UP as the robot drives away from its goal (0 when idle or spinning
   * down; set in updateRobotActions; feeds power draw one tick later) */
  flywheelSpinRate: number;
  /** 0..POWER_DRAW_MAX current drawn from the drive motors by the flywheel +
   * intake (set in updateRobot); slows the robot and weakens its shove */
  powerDraw: number;
  /** G427: an opponent contacted this robot in its BASE during endgame — it
   * counts as fully returned at match end regardless of where it ends up */
  baseAwarded?: boolean;

  /** an INERT obstacle (a free-drive practice dummy): still collides + drive-brakes
   * like any robot, but skips ALL per-tick action compute — aim/shot-solve, flywheel
   * spin, fire, intake, and the CR turret slew — since it never acts. Keeps idle bots
   * from burning CPU on work they'll never use. Optional (real robots omit it). */
  passive?: boolean;

  // --- Auto Pathing State ---
  autoPathActive: boolean;
  currentPathSegmentIndex: number;
  pathSegmentProgress: number; // 0.0 to 1.0 along the current segment
  pathWaitTimer: number; // countdown for waitBeforeMs/waitAfterMs
  pathSequenceIndex: number; // index in the overall sequence
  pathTargetPoint: Vec2 | null;
  pathTargetHeading: number | null;
  autoPath?: AutoPathData; // Add autoPath to RobotState
  isAligningHeading: boolean; // New state for heading alignment
  targetAlignmentHeading: number | null; // The heading to align to
  // --- End Auto Pathing State ---
}

export interface GoalState {
  alliance: Alliance;
  gateOpen: boolean; // DERIVED: an artifact can pass (gatePos >= GATE_PASS_FRAC)
  gatePos: number; // physical arm open fraction 0 (closed) .. 1 (fully lifted)
  gateVel: number; // arm swing rate (1/s) — gravity accelerates it shut
  gateHoldTime: number; // accumulated time a robot has been pushing the gate arm
  gateLatch: number; // s remaining the arm stays latched open after a tap (no need to hold)
  classifiedCount: number; // cumulative, for stats
  overflowCount: number;
}

export type MatchPhase = 'pre' | 'auto' | 'transition' | 'teleop' | 'post' | 'freeplay';

export interface ScoreBreakdown {
  leave: number;
  autoClassified: number;
  autoOverflow: number;
  autoPattern: number;
  teleClassified: number;
  teleOverflow: number;
  telePattern: number;
  depot: number;
  base: number;
  /** points awarded to THIS alliance from the opponent's fouls */
  foulPoints: number;
  /** a RED CARD was issued to one of this alliance's ROBOTS, so its MATCH points are
   * VOIDED — `total` reads 0 however much was earned. Optional so old snapshots and
   * replays (which have no card model) stay valid. */
  voided?: boolean;
  total: number;
}

/** A card issued by the Head REFEREE — per the DECODE glossary, "a warning issued by the
 * Head REFEREE for egregious ROBOT or team member behavior or rule violations". Cards
 * attach to a TEAM (a ROBOT here); a second yellow becomes a RED, and a RED voids that
 * robot's ALLIANCE score for the MATCH. */
export type CardColor = 'yellow' | 'red';

export interface MatchState {
  phase: MatchPhase;
  /** seconds remaining in the current phase (match mode) */
  phaseTimeLeft: number;
  scores: Record<Alliance, ScoreBreakdown>;
  /** live provisional pattern points for the current ramp arrangement */
  provisionalPattern: Record<Alliance, number>;
  /** fouls COMMITTED BY each alliance (counts, for the HUD); the resulting
   * points land on the OTHER alliance's ScoreBreakdown.foulPoints */
  fouls: Record<Alliance, { minor: number; major: number }>;
  /** how many of each alliance's ROBOTS are carded (for the HUD and the results screen).
   * A red is not also counted as a yellow — a carded robot appears once, at its current
   * colour. Optional for back-compat with snapshots/replays predating cards. */
  cards?: Record<Alliance, { yellow: number; red: number }>;
  /** seconds left in a sim-driven pre-match countdown (multiplayer: the
   * pre→auto transition runs INSIDE step() so every peer fires it on the same
   * tick). undefined ⇒ no auto-countdown (solo waits for a keypress instead). */
  preCountdown?: number;
}

export interface HumanPlayerState {
  /** out-of-play artifacts in the off-field 2x3 loading-zone box (capacity 6).
   * At setup it holds the 3 pre-staged loading-zone artifacts (PGP, manual setup)
   * plus any unclaimed alliance-area preload set. The HP does nothing until
   * teleop; then it stages the grab row from here one at a time and recycles
   * returned balls back in. */
  box: ArtifactColor[];
  nextPlaceAt: number;
}

/** accumulator for one ordered pinner→pinned pair (G422). Plain numbers so
 * the whole World stays JSON-serializable / lockstep-safe. */
export interface PinState {
  /** seconds the PIN has counted. Not wall-clock: it pauses (see below) and never resets, so
   * it is the total the rule bills against — a MINOR at 3 s and another every 3 s after. */
  seconds: number;
  /** where each robot was when the PIN initiated — criterion B measures both against these */
  ox: number;
  oy: number;
  pox: number;
  poy: number;
  /** pinned robot pos last tick, to measure actual (post-solver) progress away */
  px: number;
  py: number;
  /** how many MINOR FOULs this PIN has already drawn. G422 bills one at 3 s "and an additional
   * MINOR FOUL for every 3 seconds in which the situation is not corrected", so a pin held for
   * nine seconds is three fouls, not one — and not a MAJOR, which the rule never mentions. */
  billed: number;
  /** seconds criterion A has held (the pair at least PIN_ESCAPE_DIST apart) */
  sepFor: number;
  /** seconds criterion B has held (EITHER robot that far from where the pin initiated) */
  awayFor: number;
}


/** deterministic penalty-engine state (all plain JSON — serializable) */
export interface PenaltyState {
  /** episode debounce: `${rule}:${key}` -> last world.time the rule was active
   * for that subject; a rule re-arms only after PENALTY_CLEAR s of no activity */
  episodes: Record<string, number>;
  /** pinning accumulators, keyed `${pinnerId}-${pinnedId}` */
  pins: Record<string, PinState>;
  /** how many G422 fouls a given pinner (by id) has committed this match. Bookkeeping only —
   * the rule has no escalation, every PIN foul is a MINOR — but a per-robot tally is what the
   * HUD and a post-match breakdown want. */
  pinFouls: Record<number, number>;
  /** G408 over-possession: an ACCUMULATED, leaky clock of seconds a robot (by id) has
   * controlled more than POSSESSION_LIMIT artifacts. It fills while over the limit and
   * drains at POSSESSION_LEAK while under, so a violation broken into repeated flicks still
   * reaches POSSESSION_GRACE. It is NOT reset when the foul fires — the continuing tariff is
   * measured against this same reading, so it has to keep running for as long as the
   * violation does. Cleared outside auto/teleop. */
  possession: Record<number, number>;
  /** how many artifacts OVER the limit have already been billed in the current G408
   * episode, so a pile that grows while the violation is held tops the tariff up rather
   * than riding free on the first assessment */
  possessionBilled: Record<number, number>;
  /** the `possession` reading at which the CONTINUING tariff was last charged. Anchored to
   * the clock on the opening tick and clamped to it, so the first continuing charge lands one
   * POSSESSION_REBILL_S after the violation opens rather than two, and a partial drain cannot
   * leave the cursor ahead of the clock. */
  possessionRebill: Record<number, number>;
  /** G408 clause-B bookkeeping: seconds a robot has continuously controlled
   * CARD_CONTROL_FREQUENT or more artifacts. Drains rather than resetting, so a pile that
   * dips under four for a tick does not wipe a nearly-complete instance. */
  controlHeld: Record<number, number>;
  /** PER-ARTIFACT hold: `"<robotId>:<ballId>"` -> seconds this robot has been HERDING this
   * artifact (touching a non-corner face and moving it, per CONTROL clause B), draining at
   * POSSESSION_LEAK when contact is lost. An artifact counts toward the limit once its own
   * clock passes POSSESSION_CONFIRM, and KEEPS counting while contact holds — which is what
   * separates herding (the same artifacts, over and over) from crossing a littered field (a
   * different artifact each moment). Entries are deleted at 0, and swept when the artifact
   * stops being a loose ground ball. */
  ballHold: Record<string, number>;
  /** ...and WHERE that artifact sat, in the ROBOT'S OWN FRAME, when the hold began:
   * `"<robotId>:<ballId>"` -> {x,y}. Being in the robot frame is the point — a rigid rotation
   * does not move it, so turning with an artifact held in front of you keeps its station,
   * while one you slide past sweeps the chassis and re-anchors. Re-seeded when an artifact
   * moves to a new station, deleted with the hold. */
  ballAnchor: Record<string, Vec2>;
  /** ...and how far it has actually been CARRIED, in inches, in the direction the robot has
   * been taking it: `"<robotId>:<ballId>"` -> distance. This is how "the ROBOT is MOVING the
   * SCORING ELEMENT in a preferred direction" is measured, and it has to be a projected
   * DISTANCE rather than a speed. Contact in this sim is a train of micro-impacts, so a pile
   * jammed on the perimeter reads as moving fast while going nowhere — it squirts sideways out
   * of the squeeze, which earns nothing here. Unlike `ballAnchor` it survives a re-station, so
   * a pile that rattles along a bumper still shows the ground it has covered. OPTIONAL, and
   * read through `??=`: `world.penalties` has no `unslimWorld` backfill, so a snapshot from an
   * older server would otherwise arrive without it and the first index would throw. */
  ballCarry?: Record<string, number>;
  /** how many clause-B stretches have run longer than MOMENTARY this match */
  controlInstances: Record<number, number>;
  carded: Record<number, CardColor>;
  /** which OPPONENT alliance (if any) is responsible for each goal's gate being
   * open — set when an opponent operates the gate, held through the drain, and
   * cleared once the gate shuts. Artifacts leaving that ramp meanwhile are billed
   * to them (G418.B). null = closed, or opened legally by the owner. */
  gateCulprit: Record<Alliance, Alliance | null>;
  /** ids of the classified (committed, non-overflow) artifacts resting on each
   * goal's ramp last tick, to detect ones that leave (G418.B) */
  rampBallIds: Record<Alliance, number[]>;
}

// --- Auto Pathing Types ---
export type HeadingType = 'linear' | 'constant' | 'tangential';

export interface PathPoint extends Vec2 {
  heading: HeadingType;
  startDeg?: number; // For 'linear'
  endDeg?: number;   // For 'linear'
  degrees?: number;  // For 'constant'
  reverse?: boolean; // For 'tangential'
}

export interface ControlPoint extends Vec2 {}

export interface PathLine {
  id: string;
  endPoint: PathPoint;
  controlPoints?: ControlPoint[]; // For Bezier curves
  waitBeforeMs?: number;
  waitAfterMs?: number;
  waitBeforeName?: string;
  waitAfterName?: string;
}

export interface PathShape {
  // Define properties for shapes if needed, based on your .pp file structure
  // For now, a minimal definition
  id: string;
  type: string; // e.g., 'rectangle', 'circle'
  // ... other properties like position, size, color
}

export type SequenceItemKind = 'path' | 'wait' | 'action'; // 'action' is a placeholder

export interface SequenceItem {
  kind: SequenceItemKind;
  id?: string; // For 'wait' kind
  durationMs?: number; // For 'wait' kind
  lineId?: string; // For 'path' kind
  // Add other properties for 'action' if needed
}

export interface AutoPathData {
  fileName: string; // To store the name of the imported file
  startPoint: PathPoint;
  lines: PathLine[];
  shapes?: PathShape[];
  sequence?: SequenceItem[];
  version?: string;
  timestamp?: string;
}
// --- End Auto Pathing Types ---

/** a robot start pose (field frame, heading in degrees). Custom poses are stored
 * in the CANONICAL goalSide=+1 (red) frame like START_POSES and mirrored per
 * alliance at spawn. Defined here (not sim/field) so settings can reference it
 * without a circular import. */
export interface StartPose {
  x: number;
  y: number;
  headingDeg: number;
}

/** start positions are grouped by proximity to the goal: 'close' (goal-side) vs
 * 'far' (audience side). In a 2v2 an alliance fills one Close and one Far slot. */
export type StartCat = 'close' | 'far';

/** a remembered start selection within a category: a preset (by index) OR a
 * custom/saved pose (`pose` set, `index` = -1). */
export interface StartSel {
  index: number;
  pose: StartPose | null;
}

/** the PER-GAME loadout: robot build + saved-robot library + start position state. DECODE and
 * Chain Reaction each keep their own — switching games swaps the active fields to that game's
 * copy so nothing bleeds across (a CR 18"-long build never clamps under DECODE, and each game's
 * saved robots / start positions stay separate). Archived in `GameSettings.loadouts`. */
export interface GameLoadout {
  spec: RobotSpec;
  savedRobots: RobotSpec[];
  startIndex: number;
  startPose?: StartPose | null;
  startCat: StartCat;
  savedStartPoses: { close: StartPose[]; far: StartPose[] };
  startMemory: { close: StartSel; far: StartSel };
}

export interface GameSettings {
  /** which game the player has selected (DECODE / Chain Reaction). Drives spawn,
   * step, render, HUD, the builder, and the room/queue game key. Persists + syncs. */
  game: GameId;
  mode: GameMode;
  alliance: Alliance;
  spec: RobotSpec;
  /** the player's saved robot library (up to MAX_SAVED_ROBOTS). `spec` is the
   * ACTIVE robot; loading a slot copies it into `spec`, saving copies `spec` in. */
  savedRobots: RobotSpec[];
  /** the player's saved auto library (up to MAX_SAVED_AUTOS). `autoPath` is the
   * ACTIVE auto; selecting a slot copies it into `autoPath`. */
  savedAutos: AutoPathData[];
  startIndex: number;
  /** a fully-placed CUSTOM start pose (canonical goalSide=+1 frame). When set it
   * OVERRIDES startIndex; validated against G304 and snapped legal at spawn.
   * `startIndex`/`startPose` are the ACTIVE start (what spawns / goes on the wire);
   * the fields below are the client-side library + per-category memory. */
  startPose?: StartPose | null;
  /** which category the ACTIVE start belongs to (solo picks it; a 2v2 role locks it) */
  startCat: StartCat;
  /** the player's own saved start positions, up to MAX_SAVED_STARTS per category */
  savedStartPoses: { close: StartPose[]; far: StartPose[] };
  /** last-used selection in each category, so switching tabs restores your choice */
  startMemory: { close: StartSel; far: StartSel };
  /** the NON-active games' loadouts (robot + saved robots + start positions), archived so
   * switching games restores that game's own build/library instead of bleeding across. The
   * flat fields above are always the ACTIVE game's copy; `switchGame` swaps them. */
  loadouts?: Partial<Record<GameId, GameLoadout>>;
  practiceDummies: boolean;
  /** the ACTIVE resolved driver assists (what spawns + goes on the wire).
   * MIRRORED from `spec.assists`, which is where the preference is actually STORED — the
   * robot owns its assists, so loading a saved robot / preset / the other game's loadout
   * brings its own. Kept as a flat field because spawn, the lobby, matchmaking and record
   * runs all read it, so the wire and the spawn seam never had to change. */
  assists: AssistConfig;
  bindings: ControlBindings;
  audio: {
    /** per-category levels, 0–1 — the source of truth. `master` scales the other
     * the rest. ONE PER EMITTER — `game` = the FIRST field-recording WAV cues;
     * `shoot`/`intake`/`gate` = the three synthesized mechanism effects; `beep` =
     * the countdown beep; `voice` = announcer speech (at 0 the countdown falls back
     * to beeps, exactly as the old toggle did).
     *
     * `shoot`/`intake`/`gate`/`beep` replaced a single `sfx` level whose slider was
     * labelled "Beeping" — one control for four unrelated sounds, named after the
     * least frequent of them. `coerceSettings` migrates an old `sfx` value onto all
     * four so nobody's existing choice is lost. */
    volume: {
      master: number;
      game: number;
      shoot: number;
      intake: number;
      gate: number;
      beep: number;
      alert: number;
      voice: number;
    };
    /** LEGACY mirrors, re-derived from `volume` on every coerce — never read these
     * on the new path. Settings sync per ACCOUNT and one account is shared across
     * client versions (an old browser tab, an old Electron install), and those
     * builds only understand these two booleans. Without the mirrors, muting on a
     * new build would silently un-mute on an old one. */
    sounds: boolean;
    voice: boolean;
  };
  /** show the in-match EVENT LOG — the stack of messages in the field's top-left
   *  corner (scoring, gate, penalty notices). Off hides it entirely; it is a
   *  read-out, never a control, so nothing is lost but the reading. */
  showEventLog: boolean;
  // New fields for auto pathing
  autoPath: AutoPathData | null;
  autoPathEnabled: boolean;
  /** park mode's speed cap, 0-100 (% of normal max speed); activation is
   * gated to endgame / free drive regardless of this value */
  parkSpeedPct: number;
  /** preferred game server id (multi-region). Remembered across sessions and,
   * for signed-in players, synced to the account. Undefined ⇒ auto-pick fastest. */
  preferredServerId?: string;
  /** tank drive control: 'traditional' (separate sticks) or 'normal' (Arcade-style) */
  tankControlMode: 'traditional' | 'normal';
  /** on-screen touch-control layout (mobile). Positions are the CENTRE of each
   * control as a FRACTION of the viewport (x,y in 0..1), so a layout scales across
   * screen sizes/orientations. LOCAL setting (persists + account-syncs). */
  mobileLayout: MobileLayout;
}

/** one on-screen control's centre, as a fraction (0..1) of the viewport. */
export interface MobilePos {
  x: number;
  y: number;
}
/** editable positions for the two joysticks + the action buttons. */
export interface MobileLayout {
  drive: MobilePos;
  turn: MobilePos;
  shoot: MobilePos;
  intake: MobilePos;
  catalyst: MobilePos;
  /** Chain Reaction, LAUNCHER catalyst only: the CATAPULT throw. Its own button for the
   * same reason it has its own keybind — a throw is not the claw's grab/place, and a
   * driver must never have to guess which one a press means. */
  fling: MobilePos;
  /** overall control size multiplier (0.7..1.5). */
  scale: number;
}

export interface World {
  /** which game this world simulates. Optional for back-compat: an absent value
   * (old snapshots/replays) resolves to `'decode'` via `gameOf`/`moduleFor`. */
  game?: GameId;
  /** Chain Reaction runtime state (catalysts / scoring / endgame). Present only
   * when `game === 'chain'`; DECODE worlds omit it. */
  chain?: ChainState;
  mode: GameMode;
  time: number;
  tick: number;
  rngState: number;
  motif: Motif;
  robots: RobotState[];
  balls: Artifact[];
  goals: Record<Alliance, GoalState>;
  humanPlayers: Record<Alliance, HumanPlayerState>;
  match: MatchState;
  /** transient UI events emitted by the sim this tick (toasts) */
  events: string[];
  /** robot-robot contact pairs registered THIS tick (transient, by robot id,
   * a < b) — consumed by the penalty engine */
  rrContacts: { a: number; b: number }[];
  /** persistent penalty-engine state (Section 11 fouls) */
  penalties: PenaltyState;
  // Add gameSettings to World interface
  gameSettings?: GameSettings;
}