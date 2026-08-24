import type { FieldColliders, StaticSpec } from '../types';
import { CHAIN_HALF_X, CHAIN_HALF_Y, CHAIN_RINGSTAND_BOX, CHAIN_WALL_T } from './config';
import { ringStandBoxes } from './state';

/**
 * Chain Reaction static field geometry: just the four perimeter walls (inner
 * faces exactly at ±CHAIN_HALF). No goals/structures yet — the shell is an empty
 * rectangle. `solveRobots` consumes this exactly like DECODE's colliders, so the
 * robot is wall-contained on the CR field. No `dynamic` colliders (no gates).
 */
const WALL_LX = CHAIN_HALF_X + 20; // overlap the corners
const WALL_LY = CHAIN_HALF_Y + 20;

const walls: StaticSpec[] = [
  { hx: CHAIN_WALL_T, hy: WALL_LY, tx: CHAIN_HALF_X + CHAIN_WALL_T, ty: 0, rot: 0 },
  { hx: CHAIN_WALL_T, hy: WALL_LY, tx: -CHAIN_HALF_X - CHAIN_WALL_T, ty: 0, rot: 0 },
  { hx: WALL_LX, hy: CHAIN_WALL_T, tx: 0, ty: CHAIN_HALF_Y + CHAIN_WALL_T, rot: 0 },
  { hx: WALL_LX, hy: CHAIN_WALL_T, tx: 0, ty: -CHAIN_HALF_Y - CHAIN_WALL_T, rot: 0 },
];

// RING STANDS are solid posts, not decoration — you cannot drive through one. Squared
// colliders (the spec is cuboids) sized to the post radius; a robot ASCENDS by parking its
// bumper against one, which `onRingStand`'s radius is tuned to accept.
// one solid SQUARE per corner, flush with both walls (post + its mounting plate).
// `ringStandBoxes` is the single source shared with the ascend test.
const stands: StaticSpec[] = ringStandBoxes().map((c) => ({
  hx: CHAIN_RINGSTAND_BOX / 2,
  hy: CHAIN_RINGSTAND_BOX / 2,
  tx: c.x,
  ty: c.y,
  rot: 0,
}));

export const chainColliders: FieldColliders = {
  statics: [...walls, ...stands],
  bounds: { halfX: CHAIN_HALF_X, halfY: CHAIN_HALF_Y },
};
