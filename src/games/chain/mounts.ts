import type { ChainIntakeMount, ChainShooterMount, RobotSpec } from '../../types';

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
export const CHAIN_SHOOTER_MOUNTS = ['front', 'back', 'left', 'right'] as const;
export const CHAIN_DEFAULT_INTAKE_MOUNT: ChainIntakeMount = 'front';
export const CHAIN_DEFAULT_SHOOTER_MOUNT: ChainShooterMount = 'front';

/** which chassis edge a mechanism sits on, in the robot frame */
export type ChainEdge = 'front' | 'back' | 'left' | 'right';

/** the resolved intake mount: the explicit field when legal, else the migrated legacy
 * `intakeSide` flag, else the default. Pure — safe on an un-coerced (raw) spec. */
export function intakeMountOf(spec: Pick<RobotSpec, 'intakeMount' | 'intakeSide'>): ChainIntakeMount {
  const m = spec.intakeMount;
  if (m && (CHAIN_INTAKE_MOUNTS as readonly string[]).includes(m)) return m;
  return spec.intakeSide ? 'side' : CHAIN_DEFAULT_INTAKE_MOUNT;
}

/** the resolved shooter mount (same contract as `intakeMountOf`, migrating `shooterRear`). */
export function shooterMountOf(spec: Pick<RobotSpec, 'shooterMount' | 'shooterRear'>): ChainShooterMount {
  const m = spec.shooterMount;
  if (m && (CHAIN_SHOOTER_MOUNTS as readonly string[]).includes(m)) return m;
  return spec.shooterRear ? 'back' : CHAIN_DEFAULT_SHOOTER_MOUNT;
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
