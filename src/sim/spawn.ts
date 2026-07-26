import type {
  Alliance,
  Artifact,
  ArtifactColor,
  AssistConfig,
  DrivetrainType,
  GameId,
  GameMode,
  GoalState,
  Motif,
  RobotSpec,
  RobotState,
  World,
  AutoPathData, // Import AutoPathData
  GameSettings, // Import GameSettings
  PathPoint, // Import PathPoint
  PathLine,
  PathShape,
  SequenceItem,
  ControlPoint, // Import ControlPoint
  Vec2, // Import Vec2
  StartPose,
} from '../types';
import * as C from '../config';
import {
  CHAIN_CLEARANCE_DEFAULT,
  CHAIN_CLEARANCE_MAX,
  CHAIN_CLEARANCE_MIN,
  CHAIN_STORAGE_DEFAULT,
  CHAIN_STORAGE_MIN,
  chainStorageMax,
  CHAIN_DEFAULT_SCORE_MODE,
  CHAIN_DEFAULT_INTAKE,
  CHAIN_SCORE_MODES,
  CHAIN_INTAKE_STYLES,
  CHAIN_MIN_LENGTH,
  CHAIN_MAX_LENGTH,
} from '../games/chain/config';
import {
  CHAIN_DEFAULT_INTAKE_MOUNT,
  CHAIN_DEFAULT_SHOOTER_MOUNT,
  intakeMountOf,
  shooterMountOf,
} from '../games/chain/mounts';
import { nextRandom, wrapAngle, rot, clamp } from '../math'; // Import wrapAngle
import { lengthLimits, massLimits, rpmLimits, widthLimits } from './drivetrain';
import { heldSlotPos } from './physics';
import { flywheelSpinTarget, loadPreStage, mirrorStartPose, snapStartToLegal, spikeMarkBalls, startPose } from './field';
import { emptyScore } from './scoring';

export const MOTIFS: Motif[] = [
  ['green', 'purple', 'purple'], // obelisk AprilTag 21: GPP
  ['purple', 'green', 'purple'], // 22: PGP
  ['purple', 'purple', 'green'], // 23: PPG
];

// A new player starts on the TW BUILD (Turtle Walkers' archetype) but with a
// generic identity they fill in themselves — a preset is a build, not a name.
export const DEFAULT_SPEC: RobotSpec = {
  name: 'My Robot',
  teamName: '',
  teamNumber: 0,
  length: 14.5,
  width: 16.5,
  intake: 'sloped',
  massLb: 23.5,
  drivetrain: 'mecanum',
  driveRpm: 500,
  flywheelInertia: 0.4,
  canSort: false,
  ballStorage: CHAIN_STORAGE_DEFAULT,
  groundClearance: CHAIN_CLEARANCE_DEFAULT,
  scoreMode: CHAIN_DEFAULT_SCORE_MODE,
  chainIntake: CHAIN_DEFAULT_INTAKE,
  intakeMount: CHAIN_DEFAULT_INTAKE_MOUNT,
  shooterMount: CHAIN_DEFAULT_SHOOTER_MOUNT,
  // deprecated mirrors of the two mounts above (kept in sync by coerceSpec)
  intakeSide: false,
  shooterRear: false,
  // driver assists ride the ROBOT (both games) — all ON by default. See PLAYER_ASSISTS.
  assists: { fieldCentric: true, aimAssist: true, autoIntake: true, autoFire: true },
};

// Neutral sim/wire FALLBACK for assists (used by coercion bases, replay, server
// fill-robots, dummies, and smoke). Deliberately NOT the same as the player's
// menu default (`defaultAssistsFor` below): tests + fallbacks want auto OFF.
export const DEFAULT_ASSISTS: AssistConfig = {
  fieldCentric: true,
  aimAssist: true,
  autoIntake: false,
  autoFire: false,
};

/**
 * The player-facing DEFAULT assists, and the default for `RobotSpec.assists` — EVERY assist
 * is ON, including field-centric drive, for every drivetrain and BOTH games.
 *
 * Assists used to be remembered per DRIVETRAIN (with swerve alone defaulting field-centric);
 * they are now saved ON THE ROBOT (`RobotSpec.assists`), so the memory is per-build and the
 * per-drivetrain library is gone. Distinct from `DEFAULT_ASSISTS` above, which stays auto-OFF
 * as the neutral sim/wire fallback for replay, dummies, and smoke.
 */
export const PLAYER_ASSISTS: AssistConfig = {
  fieldCentric: true,
  aimAssist: true,
  autoIntake: true,
  autoFire: true,
};

/** the player default (kept as a function for call sites; no longer drivetrain-dependent) */
export function defaultAssistsFor(_d?: DrivetrainType): AssistConfig {
  return { ...PLAYER_ASSISTS };
}

// ---- untrusted-input sanitization -------------------------------------------
// A player's robot config arrives from localStorage (hand-editable) AND, in
// multiplayer, straight off the wire from an untrusted client (people have
// spoofed it via devtools to spawn oversized / NaN-dimensioned robots). These
// coercers are the SINGLE SOURCE OF TRUTH for "what is a legal config": every
// numeric field is forced finite and clamped to its per-drivetrain / per-preset
// range, every enum is checked, and anything missing falls back to a default.
// They are IDEMPOTENT, so it is safe to run them at multiple layers (client
// settings load, server ingress, AND createWorld) — belt and suspenders.

/** clamp `n` to [lo,hi], substituting `fallback` when it is not a finite number
 * (guards against NaN/Infinity: bare `clamp(NaN,...)` returns NaN unchanged) */
function clampFinite(n: unknown, lo: number, hi: number, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? clamp(n, lo, hi) : clamp(fallback, lo, hi);
}

/** Coerce an arbitrary value into a fully-legal RobotSpec. Unknown/missing/
 * corrupt fields fall back to `base` (default: DEFAULT_SPEC); all numeric fields
 * are clamped to their legal ranges (length per intake preset, mass per
 * drivetrain×inertia, rpm per drivetrain). Never throws; always returns a spec
 * safe to spawn. */
export function coerceSpec(raw: unknown, base: RobotSpec = DEFAULT_SPEC, game?: GameId): RobotSpec {
  const out: RobotSpec = { ...base };
  const sp = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  // The clamp order is DELIBERATE — it mirrors the builder UI's dependency graph
  // exactly, so a hand-edited / spoofed / stale spec is bounded the same way the
  // sliders bound a live one. Each numeric range is resolved from ONLY the
  // field(s) it depends on, in this order:
  //   1. INTAKE + DRIVETRAIN → length range (intake) + width range (drivetrain floor)
  //   2. DRIVETRAIN         → rpm range                     (rpmLimits)
  //   3. INERTIA            → 0..1
  //   4. DRIVETRAIN×INERTIA → mass range                   (massLimits: floor ↑ inertia)

  // resolve INTAKE + DRIVETRAIN first (width's floor depends on the drivetrain —
  // swerve needs a wider base). Legacy preset names from older saves migrate.
  if (sp.intake === 'sloped' || sp.intake === 'vector' || sp.intake === 'triangle') out.intake = sp.intake;
  else if (sp.intake === 'compact') out.intake = 'sloped';
  else if (sp.intake === 'extended') out.intake = 'vector';
  if (
    sp.drivetrain === 'mecanum' ||
    sp.drivetrain === 'tank' ||
    sp.drivetrain === 'swerve' ||
    sp.drivetrain === 'xdrive'
  ) {
    out.drivetrain = sp.drivetrain;
  }

  // 1) SIZE: length from the intake preset, width floored per drivetrain. Chain Reaction runs
  // its own length range (its sweeper doesn't eat into an 18" cube — see CHAIN_MAX_LENGTH).
  const len =
    game === 'chain'
      ? { min: CHAIN_MIN_LENGTH, max: CHAIN_MAX_LENGTH }
      : lengthLimits(out.intake);
  const wid = widthLimits(out.intake, out.drivetrain);
  out.length = clampFinite(sp.length, len.min, len.max, base.length);
  out.width = clampFinite(sp.width, wid.min, wid.max, base.width);

  // 2) DRIVETRAIN → rpm range
  const rpm = rpmLimits(out.drivetrain);
  out.driveRpm = clampFinite(sp.driveRpm, rpm.min, rpm.max, base.driveRpm);

  // 3) INERTIA in 0..1
  out.flywheelInertia = clampFinite(sp.flywheelInertia, 0, 1, base.flywheelInertia);

  // 4) MASS range from DRIVETRAIN × INERTIA (the floor rises with inertia)
  const mass = massLimits(out.drivetrain, out.flywheelInertia);
  out.massLb = clampFinite(sp.massLb, mass.min, mass.max, base.massLb);

  // Chain Reaction scoring archetype + intake design (enum checks, defaulted). Resolved
  // BEFORE ball storage: the storage MAX depends on the archetype (+ the size above).
  out.scoreMode = (CHAIN_SCORE_MODES as readonly string[]).includes(sp.scoreMode as string)
    ? (sp.scoreMode as RobotSpec['scoreMode'])
    : (base.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE);
  out.chainIntake = (CHAIN_INTAKE_STYLES as readonly string[]).includes(sp.chainIntake as string)
    ? (sp.chainIntake as RobotSpec['chainIntake'])
    : (base.chainIntake ?? CHAIN_DEFAULT_INTAKE);
  // SUPPORTER COSMETIC: an allowlisted key, never a free colour string, so a
  // spoofed spec can only ever select one of the vetted fills (or the default).
  out.chassisColor = (C.CHASSIS_COLOR_KEYS as readonly string[]).includes(sp.chassisColor as string)
    ? (sp.chassisColor as string)
    : base.chassisColor;
  // MECHANISM MOUNTS. Enum-checked, with the legacy `intakeSide`/`shooterRear` booleans as the
  // fallback so old saves + older peers migrate (see games/chain/mounts.ts). `intakeMountOf`/
  // `shooterMountOf` do exactly that resolution, so run them on the RAW input first, then fall
  // back to the base spec's resolved mount when the raw value carried nothing at all.
  const rawMounts = sp as Pick<RobotSpec, 'intakeMount' | 'intakeSide' | 'shooterMount' | 'shooterRear'>;
  const hasIntakeMount = sp.intakeMount !== undefined || sp.intakeSide !== undefined;
  const hasShooterMount = sp.shooterMount !== undefined || sp.shooterRear !== undefined;
  out.intakeMount = hasIntakeMount ? intakeMountOf(rawMounts) : intakeMountOf(base);
  out.shooterMount = hasShooterMount ? shooterMountOf(rawMounts) : shooterMountOf(base);
  // MOUNTS ARE CHAIN-ONLY. They are the one CR field with a SHARED physics effect — the intake
  // mount moves the collision footprint (`footprintExtents`), so a CR build's side sweeper
  // leaking into DECODE would widen its flanks and delete its front intake reach. The builder
  // only offers mounts for CR and `switchGame` keeps a per-game spec, but a spec can still
  // arrive from a hand-edited store, a pre-loadouts save, or an untrusted client whose build
  // doesn't match the room's game — so normalize here, the chokepoint every one of those passes.
  // Only when the game is EXPLICITLY known and non-chain: `game` is optional on several call
  // paths, and treating "unspecified" as DECODE would silently wipe a real CR build.
  if (game !== undefined && game !== 'chain') {
    out.intakeMount = CHAIN_DEFAULT_INTAKE_MOUNT;
    out.shooterMount = CHAIN_DEFAULT_SHOOTER_MOUNT;
  }
  // MIRROR the deprecated booleans so a spec routed through an older peer/server (which drops
  // the fields it doesn't know) round-trips to the nearest legal mount instead of resetting.
  out.intakeSide = out.intakeMount === 'side';
  out.shooterRear = out.shooterMount === 'back';
  // Chain Reaction ball storage — clamped to the archetype+size max (chainStorageMax). NOTE: the
  // intake-mount storage penalty depends on out.intakeMount, so it's resolved BEFORE this clamp.
  out.ballStorage = Math.round(
    clampFinite(
      sp.ballStorage,
      CHAIN_STORAGE_MIN,
      chainStorageMax(out),
      base.ballStorage ?? CHAIN_STORAGE_DEFAULT,
    ),
  );
  // Chain Reaction ground clearance (inches) — over-a-beam capability vs raised CoG
  out.groundClearance = clampFinite(
    sp.groundClearance,
    CHAIN_CLEARANCE_MIN,
    CHAIN_CLEARANCE_MAX,
    base.groundClearance ?? CHAIN_CLEARANCE_DEFAULT,
  );

  // DRIVER ASSISTS ride the robot (both games), every flag defaulting ON. Each flag is
  // validated independently, so an old spec with no `assists` (or a partial one off the
  // wire) fills from the base rather than being dropped.
  out.assists = coerceAssists(sp.assists, base.assists ?? PLAYER_ASSISTS);

  // identity + flags (no cross-field dependency)
  if (typeof sp.canSort === 'boolean') out.canSort = sp.canSort;
  if (typeof sp.name === 'string' && sp.name.trim()) out.name = sp.name.slice(0, 24);
  if (typeof sp.teamName === 'string') out.teamName = sp.teamName.slice(0, 48);
  out.teamNumber = Math.round(clampFinite(sp.teamNumber, 0, 99999, base.teamNumber));
  return out;
}

/** Coerce an arbitrary value into a legal AssistConfig (each flag defaults to
 * `base` when absent / non-boolean). */
export function coerceAssists(raw: unknown, base: AssistConfig = DEFAULT_ASSISTS): AssistConfig {
  const out: AssistConfig = { ...base };
  if (typeof raw === 'object' && raw !== null) {
    const a = raw as Record<string, unknown>;
    for (const k of ['fieldCentric', 'aimAssist', 'autoIntake', 'autoFire'] as const) {
      if (typeof a[k] === 'boolean') out[k] = a[k];
    }
  }
  return out;
}

/** clamp a single path point's coordinates to the field (finite, in-bounds) so a
 * spoofed auto path can never teleport a robot out of the world or to NaN */
function coercePathPoint(p: PathPoint): PathPoint {
  const out: PathPoint = { ...p };
  out.x = clampFinite(p.x, -C.FIELD_HALF, C.FIELD_HALF, 0);
  out.y = clampFinite(p.y, -C.FIELD_HALF, C.FIELD_HALF, 0);
  for (const k of ['startDeg', 'endDeg', 'degrees'] as const) {
    if (out[k] !== undefined) out[k] = clampFinite(out[k], -720, 720, 0);
  }
  return out;
}

/** Structurally validate + bound-clamp an auto path from untrusted input. Returns
 * null when the shape is not a usable AutoPathData (the caller then disables auto
 * pathing). Coordinates are clamped to the field so `pathTraversal` cannot be
 * driven to spawn a robot at an absurd / NaN position. */
export function coerceAutoPath(raw: unknown): AutoPathData | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.fileName !== 'string') return null;
  if (typeof d.startPoint !== 'object' || d.startPoint === null) return null;
  if (!Array.isArray(d.lines)) return null;
  try {
    const out: AutoPathData = {
      fileName: d.fileName.slice(0, 120),
      startPoint: coercePathPoint(d.startPoint as PathPoint),
      lines: (d.lines as PathLine[]).slice(0, 200).map((line) => {
        const l: PathLine = { ...line };
        l.endPoint = coercePathPoint(line.endPoint);
        if (Array.isArray(line.controlPoints)) {
          l.controlPoints = line.controlPoints.map((c) => ({
            x: clampFinite(c.x, -C.FIELD_HALF, C.FIELD_HALF, 0),
            y: clampFinite(c.y, -C.FIELD_HALF, C.FIELD_HALF, 0),
          }));
        }
        return l;
      }),
      shapes: Array.isArray(d.shapes) ? (d.shapes as PathShape[]) : undefined,
      sequence: Array.isArray(d.sequence) ? (d.sequence as SequenceItem[]) : undefined,
      version: typeof d.version === 'string' ? d.version : undefined,
      timestamp: typeof d.timestamp === 'string' ? d.timestamp : undefined,
    };
    return out;
  } catch {
    return null;
  }
}

/** Coerce a whole RobotSetup from untrusted input into a spawn-safe one: legal
 * spec/assists, valid alliance, in-range startIndex, sanitized auto path. The
 * `id` is preserved (it keys the command map). This is the LAST line of defense —
 * `createWorld` runs it on every setup, so no spawn path can produce a bad robot
 * regardless of how the setup was assembled. */
/** structural + bounds coercion for a custom start pose (canonical goalSide=+1
 * frame). Returns null for anything non-finite. Field-clamps x/y and normalizes
 * the heading to [0,360). G304 LEGALITY (over a launch line, touching a surface,
 * own half) is NOT enforced here — that needs the alliance+spec and is applied by
 * `coerceSetup` via `snapStartToLegal`, the spawn chokepoint. */
export function coerceStartPose(raw: unknown): StartPose | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.headingDeg)) return null;
  let h = (p.headingDeg as number) % 360;
  if (h < 0) h += 360;
  return {
    x: clamp(p.x as number, -C.FIELD_HALF, C.FIELD_HALF),
    y: clamp(p.y as number, -C.FIELD_HALF, C.FIELD_HALF),
    headingDeg: h,
  };
}

export function coerceSetup(s: RobotSetup): RobotSetup {
  const autoPath = s.autoPath !== undefined ? coerceAutoPath(s.autoPath) : null;
  const alliance = s.alliance === 'red' || s.alliance === 'blue' ? s.alliance : 'blue';
  const spec = coerceSpec(s.spec);
  // a custom pose overrides the preset; snap it G304-legal for THIS spec+alliance
  // so no spawn path (localStorage, wire, staged match) can place an illegal robot.
  let startPose: StartPose | undefined;
  const raw = coerceStartPose(s.startPose);
  if (raw) {
    const actual = snapStartToLegal(spec, mirrorStartPose(raw, alliance), alliance);
    startPose = mirrorStartPose(actual, alliance); // store back canonical
  }
  return {
    id: s.id,
    alliance,
    spec,
    assists: coerceAssists(s.assists),
    startIndex: Number.isFinite(s.startIndex)
      ? clamp(Math.round(s.startIndex), 0, C.START_POSES.length - 1)
      : 0,
    startPose,
    autoPath: autoPath ?? undefined,
    autoPathEnabled: autoPath ? s.autoPathEnabled === true : false,
    passive: s.passive,
  };
}

/** one robot slot in a match: only filled slots spawn robots */
export interface RobotSetup {
  id: number; // slot index, fixed for the whole match (command-map key)
  alliance: Alliance;
  spec: RobotSpec;
  assists: AssistConfig;
  /** index into START_POSES (mirrored per alliance) — the quick-pick fallback */
  startIndex: number;
  /** a fully-placed CUSTOM start pose (canonical goalSide=+1 frame). Overrides
   * startIndex when present; `coerceSetup` snaps it G304-legal at spawn. */
  startPose?: StartPose;
  // New fields for auto pathing
  autoPath?: AutoPathData;
  autoPathEnabled?: boolean;
  /** an inert obstacle (practice dummy): skips all per-tick action compute (see
   * `RobotState.passive`). */
  passive?: boolean;
}

/** the off-field human-player box holds ONLY the alliance-area preload set(s) no
 * present robot claimed (each present robot consumes one 3-ball set): 2 robots ->
 * 0 (empty), 1 -> 3 (PPG), 0 -> 6 (PGP+PPG). The 3 pre-staged loading-zone
 * artifacts are NOT in here — they sit on the field in the loading-zone corner. */
function hpBox(present: number): ArtifactColor[] {
  return [[...C.PRELOAD], [...C.HP_INITIAL_STOCK]].slice(present).flat();
}

function goalState(alliance: Alliance): GoalState {
  return {
    alliance,
    gateOpen: false,
    gatePos: 0,
    gateVel: 0,
    gateHoldTime: 0,
    gateLatch: 0,
    classifiedCount: 0,
    overflowCount: 0,
  };
}

// Helper function to mirror a Vec2 point across the x=0 axis
function mirrorPoint(point: Vec2): Vec2 {
  return { x: -point.x, y: point.y };
}

// Helper function to mirror a PathPoint across the x=0 axis
function mirrorPathPoint(pathPoint: PathPoint): PathPoint {
  const mirrored: PathPoint = { ...pathPoint, x: -pathPoint.x };
  if (mirrored.degrees !== undefined) {
    // Mirror angle: new_angle = 180 - old_angle (in degrees)
    mirrored.degrees = wrapAngle((180 - mirrored.degrees) * Math.PI / 180) * 180 / Math.PI;
  }
  if (mirrored.startDeg !== undefined) {
    mirrored.startDeg = wrapAngle((180 - mirrored.startDeg) * Math.PI / 180) * 180 / Math.PI;
  }
  if (mirrored.endDeg !== undefined) {
    mirrored.endDeg = wrapAngle((180 - mirrored.endDeg) * Math.PI / 180) * 180 / Math.PI;
  }
  // The 'reverse' property should logically remain the same, as it indicates
  // whether to drive the segment in reverse, not a direction relative to the field.
  return mirrored;
}

// Helper function to mirror a ControlPoint across the x=0 axis
function mirrorControlPoint(controlPoint: ControlPoint): ControlPoint {
  return { ...controlPoint, x: -controlPoint.x };
}

// Helper function to deep copy and mirror AutoPathData
function mirrorAutoPathData(autoPath: AutoPathData): AutoPathData {
  const mirroredAutoPath: AutoPathData = JSON.parse(JSON.stringify(autoPath)); // Deep copy

  mirroredAutoPath.startPoint = mirrorPathPoint(mirroredAutoPath.startPoint);

  mirroredAutoPath.lines = mirroredAutoPath.lines.map((line) => {
    const mirroredLine = { ...line };
    mirroredLine.endPoint = mirrorPathPoint(mirroredLine.endPoint);
    if (mirroredLine.controlPoints) {
      mirroredLine.controlPoints = mirroredLine.controlPoints.map(mirrorControlPoint);
    }
    return mirroredLine;
  });

  // Mirror shapes if they exist and have position data
  if (mirroredAutoPath.shapes) {
    mirroredAutoPath.shapes = mirroredAutoPath.shapes.map((shape) => {
      const mirroredShape = { ...shape };
      // Assuming shapes have 'x' and 'y' properties directly or within a 'pos' object
      // This part might need adjustment based on the actual structure of PathShape
      if ('x' in mirroredShape && 'y' in mirroredShape) {
        (mirroredShape as any).x = -(mirroredShape as any).x;
      }
      if ('pos' in mirroredShape && (mirroredShape.pos as Vec2)) {
        (mirroredShape.pos as Vec2) = mirrorPoint(mirroredShape.pos as Vec2);
      }
      return mirroredShape;
    });
  }

  return mirroredAutoPath;
}


export function createWorld(mode: GameMode, seed: number, setups: RobotSetup[], gameSettings?: GameSettings): World {
  const rng = nextRandom(seed || 1);
  const motif = MOTIFS[Math.floor(rng.value * 3) % 3];

  const balls: Artifact[] = [];
  let id = 1;
  const addBall = (pos: { x: number; y: number }, color: ArtifactColor): void => {
    balls.push({
      id: id++,
      color,
      state: { kind: 'ground' },
      pos: { x: pos.x, y: pos.y },
      vel: { x: 0, y: 0 },
      z: 0,
      vz: 0,
    });
  };

  for (const a of ['red', 'blue'] as Alliance[]) {
    for (const s of spikeMarkBalls(a)) addBall(s.pos, s.color);
    // the 3 pre-staged loading-zone artifacts (manual setup), in the corner
    // against the alliance wall — on the field from the start; the human player
    // arranges them into the grab row once teleop begins.
    for (const s of loadPreStage(a)) addBall(s.pos, s.color);
  }

  // preloads come from the alliance area's 6 balls (4P+2G): the first robot
  // takes PRELOAD (PGP), the second takes HP_INITIAL_STOCK (PPG). Any set no
  // present robot claims seeds the human-player box instead (see hpBox).
  const robots: RobotState[] = [];
  const allianceCount: Record<Alliance, number> = { red: 0, blue: 0 };
  // FINAL sanitization pass: no matter how these setups were assembled (client
  // localStorage, wire message, DB-staged ranked match), force every robot to a
  // legal, spawn-safe config here. Deterministic + idempotent, so live play and
  // replay re-runs agree. See coerceSetup / coerceSpec above.
  for (const s of [...setups].map(coerceSetup).sort((p, q) => p.id - q.id)) {
    const pose = startPose(s.alliance, s.startIndex, s.startPose, s.spec);
    const nth = allianceCount[s.alliance]++;

    let robotAutoPath = s.autoPath;
    if (s.alliance === 'red' && s.autoPathEnabled && s.autoPath) {
      robotAutoPath = mirrorAutoPathData(s.autoPath);
    }

    robots.push({
      id: s.id,
      alliance: s.alliance,
      spec: s.spec,
      pos: pose.pos,
      heading: pose.heading,
      vel: { x: 0, y: 0 },
      angVel: 0,
      turretHeading: pose.heading,
      moduleAngles: [0, 0, 0, 0], // swerve pods (FL,FR,BL,BR) start pointing forward
      moduleTargets: [0, 0, 0, 0], // and their commanded targets
      hopper: nth === 0 ? [...C.PRELOAD] : [...C.HP_INITIAL_STOCK],
      fieldCentric: s.assists.fieldCentric,
      aimAssist: s.assists.aimAssist,
      autoIntake: s.assists.autoIntake,
      autoFire: s.assists.autoFire,
      passive: s.passive,
      lastFireAt: -10,
      lastIntakeAt: -10,
      fireReadyAt: 0,
      // seed at the spawn-distance target so the first tick sees no phantom spin-up
      flywheelSpin: flywheelSpinTarget(s.alliance, pose.pos),
      flywheelSpinRate: 0,
      powerDraw: 0,
      // Initialize new auto pathing fields
      autoPathActive: !!(s.autoPathEnabled && robotAutoPath !== undefined),
      currentPathSegmentIndex: 0,
      pathSegmentProgress: 0,
      pathWaitTimer: 0,
      pathSequenceIndex: 0,
      pathTargetPoint: null,
      pathTargetHeading: null,
      isAligningHeading: false, // Initialize new state
      targetAlignmentHeading: null, // Initialize new state
      autoPath: robotAutoPath, // Assign the (potentially mirrored) autoPath
    });

    // If auto path is enabled, override initial position and heading
    if (s.autoPathEnabled && robotAutoPath) {
      const robot = robots[robots.length - 1]; // Get the newly added robot
      robot.pos = { x: robotAutoPath.startPoint.x, y: robotAutoPath.startPoint.y };
      // Convert degrees to radians for initial heading
      if (robotAutoPath.startPoint.heading === 'constant' && robotAutoPath.startPoint.degrees !== undefined) {
        robot.heading = robotAutoPath.startPoint.degrees * Math.PI / 180;
        robot.turretHeading = robot.heading;
      } else if (robotAutoPath.startPoint.heading === 'linear' && robotAutoPath.startPoint.startDeg !== undefined) {
        robot.heading = robotAutoPath.startPoint.startDeg * Math.PI / 180;
        robot.turretHeading = robot.heading;
      }
      // For tangential, initial heading will be determined by the first path segment.
      // The path follower will handle this dynamically.
    }

    // preloaded artifacts are PHYSICAL held balls (the hopper mirrors their colors);
    // step()'s positionHeldBalls parks them at the storage slots
    const created = robots[robots.length - 1];
    created.hopper.forEach((color, slot) => {
      const side = slot >= 1 ? (slot === 1 ? -1 : 1) : 0; // triangle front row: opposite sides
      const lp = heldSlotPos(created.spec, slot, side);
      const wp = rot(lp, created.heading);
      balls.push({
        id: id++,
        color,
        state: { kind: 'held', robot: created.id, slot, lx: lp.x, ly: lp.y, side },
        pos: { x: created.pos.x + wp.x, y: created.pos.y + wp.y },
        vel: { x: 0, y: 0 },
        z: 0,
        vz: 0,
      });
    });
  }

  return {
    mode,
    time: 0,
    tick: 0,
    rngState: rng.state,
    motif,
    robots,
    balls,
    goals: { red: goalState('red'), blue: goalState('blue') },
    humanPlayers: {
      red: { box: hpBox(allianceCount.red), nextPlaceAt: 0 },
      blue: { box: hpBox(allianceCount.blue), nextPlaceAt: 0 },
    },
    match: {
      phase: mode === 'match' ? 'pre' : 'freeplay',
      phaseTimeLeft: mode === 'match' ? C.AUTO_DURATION : 0,
      scores: { red: emptyScore(), blue: emptyScore() },
      provisionalPattern: { red: 0, blue: 0 },
      fouls: { red: { minor: 0, major: 0 }, blue: { minor: 0, major: 0 } },
    },
    events: [],
    rrContacts: [],
    penalties: {
      episodes: {},
      pins: {},
      pinFouls: {},
      possession: {},
      gateCulprit: { red: null, blue: null },
      rampBallIds: { red: [], blue: [] },
    },
    gameSettings: gameSettings, // Pass gameSettings to the world
  };
}