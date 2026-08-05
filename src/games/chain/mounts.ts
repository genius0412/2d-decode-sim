import type {
  ChainCatalystMount,
  ChainIntakeMount,
  ChainMountPos,
  ChainScoreMode,
  ChainShooterMount,
  RobotSpec,
} from '../../types';

/**
 * Chain Reaction MECHANISM MOUNTS — which chassis edge(s) the intake rollers ride on and which
 * edge the turretless launcher fires over.
 *
 * This is a LEAF module (it imports only `types`) on purpose: the mount decides the collision
 * FOOTPRINT, so `src/sim/field.ts` (`footprintExtents`) has to read it, and a chain→sim import
 * of anything heavier would be a cycle.
 *
 * Robot frame throughout: +x = forward, +y = the robot's LEFT, heading 0 = +x, CCW positive.
 *
 * MIGRATION: the mounts replace the old `intakeSide`/`shooterRear` booleans. `coerceSpec` is the
 * single chokepoint that resolves the new field (falling back to the legacy flag) and then keeps
 * the legacy flag MIRRORED, so a spec round-tripped through an older peer/server — which drops
 * fields it doesn't know — comes back as the nearest legal mount instead of silently resetting.
 * Every read site goes through `intakeMountOf`/`shooterMountOf`, never the raw fields.
 */

export const CHAIN_INTAKE_MOUNTS = ['front', 'back', 'side', 'frontback'] as const;
/** TURRETLESS firing edges. A drum/catapult launches along a LINE spanning one side, so a
 * corner or the centre is not a thing it can be built as — `coerceSpec` folds those away. */
export const CHAIN_SHOOTER_MOUNTS = ['front', 'back', 'left', 'right'] as const;
/** TURRET positions. A turret aims itself, so every point on the chassis is buildable —
 * including the middle, which is where most robots actually put one.
 * ORDER IS THE 3x3 CHASSIS MAP the builder renders (front row, middle row, back row), so the
 * picker reads as a top-down diagram of the robot rather than a list. */
export const CHAIN_TURRET_POSITIONS = [
  'frontleft', 'front', 'frontright',
  'left', 'center', 'right',
  'backleft', 'back', 'backright',
] as const;
/** CATALYST mounts, in the same 3x3 map order. The centre cell is the FRONTBACK swing rather
 * than a centre mount: a claw cannot reach from the middle of the chassis, and the swing is
 * the option that belongs in the middle of a front/back pair. */
export const CHAIN_CATALYST_MOUNTS = [
  'frontleft', 'front', 'frontright',
  'left', 'frontback', 'right',
  'backleft', 'back', 'backright',
] as const;
export const CHAIN_DEFAULT_INTAKE_MOUNT: ChainIntakeMount = 'front';
/** default FIRING EDGE for a turretless launcher */
export const CHAIN_DEFAULT_SHOOTER_MOUNT: ChainShooterMount = 'front';
/** default TURRET position. CENTRE, because that is where a turret was hard-drawn and
 * hard-launched from before the mount became a position — so an existing turret build keeps
 * shooting from exactly where it always did rather than silently jumping to the front edge. */
export const CHAIN_DEFAULT_TURRET_POS: ChainShooterMount = 'center';

/** which chassis edge a mechanism sits on, in the robot frame */
export type ChainEdge = 'front' | 'back' | 'left' | 'right';

const EDGES: readonly string[] = ['front', 'back', 'left', 'right'];
/** is this position one of the four EDGES (as opposed to a corner or the centre)? */
export function isEdgePos(pos: string): pos is ChainEdge {
  return EDGES.includes(pos);
}

/** the resolved intake mount: the explicit field when legal, else the migrated legacy
 * `intakeSide` flag, else the default. Pure — safe on an un-coerced (raw) spec. */
export function intakeMountOf(spec: Pick<RobotSpec, 'intakeMount' | 'intakeSide'>): ChainIntakeMount {
  const m = spec.intakeMount;
  if (m && (CHAIN_INTAKE_MOUNTS as readonly string[]).includes(m)) return m;
  return spec.intakeSide ? 'side' : CHAIN_DEFAULT_INTAKE_MOUNT;
}

/** the resolved shooter mount (same contract as `intakeMountOf`, migrating `shooterRear`).
 * Accepts any position — a TURRET may sit anywhere. `coerceSpec` is what narrows a turretless
 * launcher back to an edge; this resolver stays permissive so a raw/older spec still reads. */
export function shooterMountOf(spec: Pick<RobotSpec, 'shooterMount' | 'shooterRear'>): ChainShooterMount {
  const m = spec.shooterMount;
  if (m && (CHAIN_TURRET_POSITIONS as readonly string[]).includes(m)) return m;
  return spec.shooterRear ? 'back' : CHAIN_DEFAULT_SHOOTER_MOUNT;
}

/** the TURRETLESS firing edge — `shooterMountOf` narrowed to a side. A corner falls to the
 * end it shares (a launch line spans a side, and the ends are the ones that matter for a
 * drum/catapult); the centre falls to the front. */
export function shooterEdgeOf(spec: Pick<RobotSpec, 'shooterMount' | 'shooterRear'>): ChainEdge {
  const m = shooterMountOf(spec);
  if (isEdgePos(m)) return m;
  if (m === 'frontleft' || m === 'frontright') return 'front';
  if (m === 'backleft' || m === 'backright') return 'back';
  return 'front'; // center
}

/** the resolved catalyst mount (same contract as the others). */
export function catalystMountOf(spec: Pick<RobotSpec, 'catalystMount'>): ChainCatalystMount {
  const m = spec.catalystMount;
  if (m && (CHAIN_CATALYST_MOUNTS as readonly string[]).includes(m)) return m;
  return 'front';
}

/** The positions a catalyst mount can actually REACH FROM. One for every mount except the
 * FRONTBACK swing, which is a single arm on a pivot that rotates between both ends — so it
 * works from whichever end is nearer the target, covering two cones instead of one. */
export function catalystMountPositions(mount: ChainCatalystMount): Exclude<ChainMountPos, 'center'>[] {
  return mount === 'frontback' ? ['front', 'back'] : [mount];
}

/** the chassis edges an intake mount puts rollers on (order is stable: ends before flanks). */
export function intakeMountEdges(mount: ChainIntakeMount): ChainEdge[] {
  switch (mount) {
    case 'front':
      return ['front'];
    case 'back':
      return ['back'];
    case 'frontback':
      return ['front', 'back'];
    case 'side':
      return ['left', 'right'];
  }
}

/** the robot-local angle (radians) a mechanism on `edge` points OUTWARD along: the direction a
 * launcher on that edge fires, and the outward normal of that edge's intake mouth. */
export const EDGE_ANGLE: Record<ChainEdge, number> = {
  front: 0,
  back: Math.PI,
  left: Math.PI / 2,
  right: -Math.PI / 2,
};

/** the robot-local OUTWARD UNIT NORMAL of each edge, as exact integer components (the
 * `EDGE_ANGLE` direction, without a trig round-trip that would leave a ~1e-17 residue on the
 * ±π/2 flanks). `perp` is its left-hand perpendicular = the direction a launch line spreads
 * across that edge. */
export const EDGE_DIR: Record<ChainEdge, { x: number; y: number }> = {
  front: { x: 1, y: 0 },
  back: { x: -1, y: 0 },
  left: { x: 0, y: 1 },
  right: { x: 0, y: -1 },
};
export const EDGE_PERP: Record<ChainEdge, { x: number; y: number }> = {
  front: { x: 0, y: 1 },
  back: { x: 0, y: -1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/** true when the edge is an END (front/back — spans the chassis WIDTH) rather than a FLANK
 * (left/right — spans the chassis LENGTH). Callers use it to pick which half-extent is the
 * edge's stand-off distance and which is its span. */
export function isEndEdge(edge: ChainEdge): boolean {
  return edge === 'front' || edge === 'back';
}

/** the mounting geometry of `edge` on `spec`: `dist` = how far the edge is from the robot
 * center along its outward normal, `span` = the edge's half-length across that normal. */
export function edgeGeom(spec: RobotSpec, edge: ChainEdge): { dist: number; span: number } {
  const hl = spec.length / 2;
  const hw = spec.width / 2;
  return isEndEdge(edge) ? { dist: hl, span: hw } : { dist: hw, span: hl };
}

/** the ROBOT-LOCAL point a mechanism at `pos` sits at (+x forward, +y left). Edges are the
 * mid-point of that side, corners the actual corner, centre the origin. This is the ONE
 * source for "where is it bolted" — the launch origin, the claw pivot and both renderers all
 * read it, so a mount can never be drawn somewhere it doesn't act from. */
export function mountOrigin(spec: RobotSpec, pos: ChainMountPos): { x: number; y: number } {
  const hl = spec.length / 2;
  const hw = spec.width / 2;
  switch (pos) {
    case 'center': return { x: 0, y: 0 };
    case 'front': return { x: hl, y: 0 };
    case 'back': return { x: -hl, y: 0 };
    case 'left': return { x: 0, y: hw };
    case 'right': return { x: 0, y: -hw };
    case 'frontleft': return { x: hl, y: hw };
    case 'frontright': return { x: hl, y: -hw };
    case 'backleft': return { x: -hl, y: hw };
    case 'backright': return { x: -hl, y: -hw };
    default: return { x: 0, y: 0 }; // unreachable for a coerced spec; JSON safety
  }
}

const Q = Math.PI / 4;
/** the robot-local angle a mechanism at `pos` points OUTWARD along. Corners point along the
 * DIAGONAL at a flat 45°, not at the true corner normal of a non-square chassis: the arm is a
 * physical linkage bolted at an angle, not something that re-aims itself with the frame, and a
 * fixed 45° keeps the four corners exact mirror images of each other. `center` has no outward
 * direction — it reports forward, and only a turret (which aims itself) can be mounted there. */
export const MOUNT_ANGLE: Record<ChainMountPos, number> = {
  front: 0,
  back: Math.PI,
  left: Math.PI / 2,
  right: -Math.PI / 2,
  frontleft: Q,
  frontright: -Q,
  backleft: Math.PI - Q,
  backright: -(Math.PI - Q),
  center: 0,
};

const S = Math.SQRT1_2; // exact-enough diagonal unit component; a CONSTANT, not a trig call
/** the robot-local outward UNIT vector for each position — `MOUNT_ANGLE` without a trig
 * round-trip, so the axis-aligned ones stay exactly integer (see `EDGE_DIR`). */
export const MOUNT_DIR: Record<ChainMountPos, { x: number; y: number }> = {
  front: { x: 1, y: 0 },
  back: { x: -1, y: 0 },
  left: { x: 0, y: 1 },
  right: { x: 0, y: -1 },
  frontleft: { x: S, y: S },
  frontright: { x: S, y: -S },
  backleft: { x: -S, y: S },
  backright: { x: -S, y: -S },
  center: { x: 1, y: 0 },
};

/** the drawn/modelled radius of the turret ring, scaled to the chassis */
export function turretRadius(spec: RobotSpec): number {
  return Math.min(4.4, Math.min(spec.length, spec.width) * 0.28);
}

/**
 * The turret's CENTRE OF ROTATION in the robot frame — the ONE point the sim launches from
 * and both renderers draw at, so the sprite can never sit somewhere the Particle doesn't
 * actually leave from.
 *
 * An EDGE or CORNER mount is pulled INBOARD by the ring radius: a turret bolted "at the back"
 * has its ring a few inches inside the rear rail, not hanging off it. `center` is dead centre.
 * (Contrast the CATALYST, whose mouth stays exactly ON the frame line — that is where its
 * reach is measured from, so pulling it inboard would quietly shorten every claw.)
 */
export function turretLocal(spec: RobotSpec): { x: number; y: number } {
  const pos = shooterMountOf(spec);
  if (pos === 'center') return { x: 0, y: 0 };
  const o = mountOrigin(spec, pos);
  const d = MOUNT_DIR[pos];
  const r = turretRadius(spec);
  return { x: o.x - d.x * r, y: o.y - d.y * r };
}

/** is this archetype TURRETED (top-mounted, aims itself)? Turreted launchers ignore
 * `shooterMount` entirely — the turret rotates, so there is no chassis edge to pick — and
 * they must NOT be steered by the fire button the way a turretless drum/dumper is. One
 * predicate so every UI + sim site agrees, including any future turret variant. */
export function isTurreted(mode: ChainScoreMode | undefined): boolean {
  return mode === undefined || mode === 'turret' || mode === 'twinturret';
}
