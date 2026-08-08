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
/**
 * CATALYST mounts — where the mechanism is BOLTED, in the same 3x3 map order.
 *
 * The centre cell used to be the value `'frontback'` (the swing itself), which quietly made
 * the swing a PLACE rather than a mechanism: picking it meant picking the middle, so "a
 * swing, mounted on the right" was unsayable even though it is an ordinary build. The swing
 * is now its own flag (`RobotSpec.catalystSwing`) and this list is purely positional. The
 * legacy `'frontback'` value is still ACCEPTED on input and migrated by `coerceSpec`.
 */
export const CHAIN_CATALYST_MOUNTS = [
  'frontleft', 'front', 'frontright',
  'left', 'center', 'right',
  'backleft', 'back', 'backright',
] as const;

/**
 * Where a SWING's pivot can be bolted.
 *
 * A swing rotates FORE AND AFT, so the pivot has to sit somewhere that has a front and a back
 * to reach: the chassis centre line, or either flank. Bolting one to the front edge would be
 * a front mount with extra steps — there is no second end for it to swing to.
 */
export const CHAIN_SWING_MOUNTS = ['center', 'left', 'right'] as const;
export type ChainSwingMount = (typeof CHAIN_SWING_MOUNTS)[number];
export const isSwingMount = (m: string): m is ChainSwingMount =>
  (CHAIN_SWING_MOUNTS as readonly string[]).includes(m);
export const CHAIN_DEFAULT_INTAKE_MOUNT: ChainIntakeMount = 'front';
/** default FIRING EDGE for a turretless launcher */
export const CHAIN_DEFAULT_SHOOTER_MOUNT: ChainShooterMount = 'front';
/** default TURRET position. CENTRE, because that is where a turret was hard-drawn and
 * hard-launched from before the mount became a position — so an existing turret build keeps
 * shooting from exactly where it always did rather than silently jumping to the front edge. */
export const CHAIN_DEFAULT_TURRET_POS: ChainShooterMount = 'center';

/** RAIL-turret catalyst mounts. The carriage traverses a track spanning a whole chassis
 * SIDE, so the mechanism occupies that side end to end — a corner has no span to run along
 * and the centre has no edge to bolt a track to. `coerceSpec` folds the others away, the
 * same way it folds a turretless launcher onto an edge. */
export const CHAIN_RAIL_MOUNTS = ['front', 'back', 'left', 'right'] as const;

/** which chassis edge a mechanism sits on, in the robot frame */
export type ChainEdge = 'front' | 'back' | 'left' | 'right';

const EDGES: readonly string[] = ['front', 'back', 'left', 'right'];
/** is this position one of the four EDGES (as opposed to a corner or the centre)? */
export function isEdgePos(pos: string): pos is ChainEdge {
  return EDGES.includes(pos);
}

/**
 * Which cells of the 3×3 chassis map a mechanism physically OCCUPIES.
 *
 * Two mechanisms cannot share a cell — there is one piece of frame there and only one of
 * them can be bolted to it. Occupancy is not always a single cell, which is the whole
 * reason this exists:
 *
 *  - an EDGE-spanning mechanism (a rail track, a drum's launch line, a sweeper) runs the
 *    full side, so it takes the edge AND both corners of that side — "the whole row";
 *  - a `frontback` mechanism is one part serving both ends, so it takes both;
 *  - a corner or centre mount takes just its own cell.
 *
 * `center` is deliberately included for a turret bolted mid-chassis: it blocks a catalyst
 * that wanted the middle, and nothing else.
 */
export function occupiedCells(pos: string, spansEdge: boolean, swing = false): ChainMountPos[] {
  if (pos === 'frontback') return ['front', 'frontleft', 'frontright', 'back', 'backleft', 'backright'];
  /**
   * A SWING claims the two ENDS it sweeps over, NOT the cell its pivot is bolted to.
   *
   * The pivot is a post; what actually occupies frame is the arm passing over each end. This
   * matters most for the centre pivot: claiming the literal centre cell would make it clash
   * with a centre-mounted turret, which is the single most common CR build there is (and is
   * what two shipped presets are). The old `'frontback'` value had exactly this behaviour —
   * it is preserved here rather than re-derived.
   */
  if (swing && isSwingMount(pos)) {
    return catalystMountPositions(pos as ChainCatalystMount, true) as ChainMountPos[];
  }
  if (pos === 'side') return ['left', 'frontleft', 'backleft', 'right', 'frontright', 'backright'];
  if (spansEdge && isEdgePos(pos)) {
    if (pos === 'front') return ['front', 'frontleft', 'frontright'];
    if (pos === 'back') return ['back', 'backleft', 'backright'];
    if (pos === 'left') return ['left', 'frontleft', 'backleft'];
    return ['right', 'frontright', 'backright'];
  }
  return [pos as ChainMountPos];
}

/** The EDGE a rail track is bolted to, for a mount that is not already one. A corner falls
 *  to the END it shares (front/back are the sides a claw most wants to work over) and the
 *  frontback swing — which is a pivot, not a track — falls to the front. Mirrors
 *  `shooterEdgeOf`, which does the same job for a turretless launcher. */
export function railEdgeOf(pos: string): ChainEdge {
  if (isEdgePos(pos)) return pos;
  if (pos === 'frontleft' || pos === 'frontright') return 'front';
  if (pos === 'backleft' || pos === 'backright') return 'back';
  return 'front'; // frontback swing / centre
}

/** do two mounted mechanisms want the same piece of frame? */
export function mountsClash(
  a: { pos: string; spansEdge: boolean; swing?: boolean },
  b: { pos: string; spansEdge: boolean; swing?: boolean },
): boolean {
  const cells = new Set(occupiedCells(a.pos, a.spansEdge, a.swing));
  return occupiedCells(b.pos, b.spansEdge, b.swing).some((c) => cells.has(c));
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

/** is this build's catalyst on a fore-aft swing? Pure — safe on a raw (un-coerced) spec, and
 *  it still reads the legacy `'frontback'` mount as the swing it used to mean. */
export function catalystSwingOf(
  spec: Pick<RobotSpec, 'catalystSwing' | 'catalystMount' | 'catalystType'>,
): boolean {
  if ((spec.catalystType ?? 'turret') === 'rail') return false; // a track is not a pivot
  if (spec.catalystMount === 'frontback') return true; // legacy value, pre-migration
  return !!spec.catalystSwing && isSwingMount(catalystMountOf(spec));
}

/**
 * The positions a catalyst can actually REACH FROM.
 *
 * A fixed mount reaches from where it is bolted — one cone. A SWING is one arm on a pivot
 * that rotates fore and aft, so it works from whichever END of its side is nearer the
 * target: two cones, on the side the pivot is bolted to. A centre pivot swings over the
 * front and back edges; a pivot on the right rail swings over the front-right and back-right
 * corners, which is exactly the "swing arm mounted on the right" build.
 */
export function catalystMountPositions(
  mount: ChainCatalystMount,
  swing = false,
): Exclude<ChainMountPos, 'center'>[] {
  if (mount === 'frontback') return ['front', 'back']; // legacy value
  if (!swing) return mount === 'center' ? ['front'] : [mount as Exclude<ChainMountPos, 'center'>];
  if (mount === 'left') return ['frontleft', 'backleft'];
  if (mount === 'right') return ['frontright', 'backright'];
  return ['front', 'back']; // centre pivot
}

/**
 * Turning the swing ON from a mount a pivot cannot use: where the pivot goes instead.
 *
 * A flank mount keeps its flank (a right-side claw becomes a right-side swing, which is the
 * whole point); anything else — an end, a corner — falls to the CENTRE, the one pivot that
 * covers both ends equally. Moving the choice is better than refusing the click here: the
 * player asked for a swing, and there is always a sensible place to put one.
 */
export function swingHomeFor(mount: ChainCatalystMount): ChainSwingMount {
  if (mount === 'left' || mount === 'frontleft' || mount === 'backleft') return 'left';
  if (mount === 'right' || mount === 'frontright' || mount === 'backright') return 'right';
  return 'center';
}

/**
 * Where the mechanism's BODY is drawn: the pivot for a swing, the mount itself otherwise.
 *
 * A swing is one arm on a pivot, so the pivot is the thing bolted to the frame — drawing it
 * at a working END instead would read as two arms for a centre swing, and would float a side
 * swing's body off the corner it merely reaches.
 */
export function catalystDrawPos(mount: ChainCatalystMount, swing = false): ChainMountPos {
  if (mount === 'frontback') return 'front'; // legacy: the swing stows at the front
  if (swing && mount === 'center') return 'front'; // ...as does a centre pivot
  return mount;
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

/**
 * The RAIL AXIS of a mount: the direction a carriage slides along that side, in the ROBOT
 * frame. It is `MOUNT_DIR` turned 90° left, which is precisely the mount's own local +y —
 * the axis `drawChainRobot` slides the carriage along after `ctx.rotate(MOUNT_ANGLE[pos])`.
 *
 * IT EXISTS SO THE SIM AND THE SPRITE CANNOT DISAGREE. They used to derive the slide
 * independently: the renderer from the rotated mount frame, the sim from the raw robot frame
 * (+y for front/back, +x for the flanks). Those happen to agree for `front` and `right` and
 * are exactly INVERTED for `back` and `left`, so on half the mounts the carriage was drawn
 * sliding one way while the claw actually worked from the other. One table, read by both.
 */
export const RAIL_DIR: Record<ChainMountPos, { x: number; y: number }> = Object.fromEntries(
  (Object.keys(MOUNT_DIR) as ChainMountPos[]).map((k) => [k, { x: -MOUNT_DIR[k].y, y: MOUNT_DIR[k].x }]),
) as Record<ChainMountPos, { x: number; y: number }>;


/** The turret ring's radius, scaled to the chassis. Shared by the sim's inboard pull
 * (`turretLocal`) and BOTH renderers, which used to disagree — the in-game sprite drew ~4.4"
 * while the builder preview drew `min(w,len) * 0.2`. 0.24 capped at 3.8 lands between the two,
 * because at 0.28 the ring covered more than half the width of a mid-size chassis and swamped
 * the drawing it is supposed to annotate. */
export function turretRadius(spec: RobotSpec): number {
  return Math.min(3.8, Math.min(spec.length, spec.width) * 0.24);
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
  // Pull inboard by the ring radius on EACH AXIS the mount touches, NOT by r along the mount
  // direction. At a CORNER the direction is diagonal, so moving r along it clears each rail by
  // only r/sqrt2 and leaves the ring hanging ~0.29r past both — visibly off the chassis.
  // `sign` makes an edge mount degenerate to the same single-axis pull it always had.
  return { x: o.x - Math.sign(d.x) * r, y: o.y - Math.sign(d.y) * r };
}

/** is this archetype TURRETED (top-mounted, aims itself)? Turreted launchers ignore
 * `shooterMount` entirely — the turret rotates, so there is no chassis edge to pick — and
 * they must NOT be steered by the fire button the way a turretless drum/dumper is. One
 * predicate so every UI + sim site agrees, including any future turret variant. */
export function isTurreted(mode: ChainScoreMode | undefined): boolean {
  return mode === undefined || mode === 'turret' || mode === 'twinturret';
}
