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
 *  • drum   — a chassis-wide flywheel drum (no turret): the robot turns to face the goal,
 *    then fires up to 6 at once in a parallel line from ANY range (uniform velocity).
 *  • dumper — a chassis-wide catapult (no turret): turns to face the goal, then flings the
 *    WHOLE hopper at once from LIMITED range (side-to-side velocity variance ⇒ scatter). */
export type ChainScoreMode = 'turret' | 'drum' | 'dumper';
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

/** Chain Reaction turretless-launcher MOUNT (see `RobotSpec.shooterMount`) — which chassis edge
 * the drum/catapult fires over, i.e. the edge the robot turns to the goal. Robot frame: +x is
 * forward, +y is the robot's LEFT, so 'left'/'right' fire along ±y and span the chassis LENGTH
 * (not its width). No effect on a turret. */
export type ChainShooterMount = 'front' | 'back' | 'left' | 'right';

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
  /** BUTTERFLY drivetrain: is the TRACTION (tank) set the one on the ground right now?
   * false ⇒ the mecanum set is down (the spawn default). RUNTIME state, not a build
   * choice — the driver drops the other set mid-match with the `driveMode` command, and
   * it selects BOTH the mode's handling multipliers and which RPM slider applies (see
   * `driveParams`). Always present so snapshots/replays carry it; every other drivetrain
   * ignores it. */
  butterflyTank: boolean;
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
  total: number;
}

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
  /** seconds the pin condition has held continuously */
  seconds: number;
  /** where the pinned robot was when the pin began (escape = 24" from here) */
  ox: number;
  oy: number;
  /** pinned robot pos last tick, to measure actual (post-solver) speed */
  px: number;
  py: number;
  /** this pin already drew a foul — don't re-fire until the pair separates
   * (a genuine repeat pin), so a sustained push isn't a foul every 3 s */
  fired?: boolean;
}

/** deterministic penalty-engine state (all plain JSON — serializable) */
export interface PenaltyState {
  /** episode debounce: `${rule}:${key}` -> last world.time the rule was active
   * for that subject; a rule re-arms only after PENALTY_CLEAR s of no activity */
  episodes: Record<string, number>;
  /** pinning accumulators, keyed `${pinnerId}-${pinnedId}` */
  pins: Record<string, PinState>;
  /** how many pin fouls a given pinner (by id) has already committed, for the
   * MINOR -> MAJOR escalation on a repeat pin */
  pinFouls: Record<number, number>;
  /** G408 over-possession: seconds a robot (by id) has continuously CONTROLLED
   * more than POSSESSION_LIMIT artifacts. Fires once past POSSESSION_GRACE;
   * resets to 0 the moment control drops back to the limit. */
  possession: Record<number, number>;
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
/** editable positions for the two joysticks + the three action buttons. */
export interface MobileLayout {
  drive: MobilePos;
  turn: MobilePos;
  shoot: MobilePos;
  intake: MobilePos;
  catalyst: MobilePos;
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