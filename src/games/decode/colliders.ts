import type { Alliance, World } from '../../types';
import * as C from '../../config';
import { classifierRect, gateHandleRect, goalFaceNormal, goalFacePoints, goalSide } from '../../sim/field';
import { datan2, hyp } from '../../math';
import type { FieldColliders, StaticSpec } from '../types';

/**
 * DECODE's field colliders — the EXACT geometry formerly inline in
 * physicsEngine.ts (`computeStaticSpecs` + `buildGateArms`), moved here verbatim
 * so `solveRobots` can be parameterized on a per-game `FieldColliders`.
 *
 * DETERMINISM: the collider build ORDER and numbers must stay byte-identical to
 * the old code — Rapier contact resolution depends on collider creation order, and
 * every stored replay re-sims through this. The `statics` order is: 4 perimeter
 * walls, then per alliance (red, then blue) goal-face slab + classifier channel.
 * `dynamic` (gate arms) is built AFTER the robot bodies, red then blue — matching
 * the old `buildGateArms` call site. A DECODE-parity smoke check guards this.
 *
 * This file imports ONLY config + field (no world.ts / spawn.ts / Rapier), so
 * `src/sim/world.ts` can import `decodeColliders` without a cycle.
 */

const ALLIANCES = ['red', 'blue'] as const;
const WALL_T = 10; // perimeter wall half-thickness (well outside the field)
const WALL_L = C.FIELD_HALF + 20; // wall half-length (overlaps corners)
const GOAL_FACE_T = 4; // goal-face slab half-thickness (behind the hypotenuse)

function computeStaticSpecs(): StaticSpec[] {
  const f = C.FIELD_HALF;
  const specs: StaticSpec[] = [
    // 4 perimeter walls: inner faces exactly at ±FIELD_HALF
    { hx: WALL_T, hy: WALL_L, tx: f + WALL_T, ty: 0, rot: 0 },
    { hx: WALL_T, hy: WALL_L, tx: -f - WALL_T, ty: 0, rot: 0 },
    { hx: WALL_L, hy: WALL_T, tx: 0, ty: f + WALL_T, rot: 0 },
    { hx: WALL_L, hy: WALL_T, tx: 0, ty: -f - WALL_T, rot: 0 },
  ];
  for (const a of ALLIANCES) {
    // goal FACE: a thin slab lying along the hypotenuse, offset toward the
    // corner so its field-side face IS the hypotenuse (robots pushed out)
    const [far, side] = goalFacePoints(a);
    const mx = (far.x + side.x) / 2;
    const my = (far.y + side.y) / 2;
    const len = hyp(side.x - far.x, side.y - far.y);
    const ang = datan2(side.y - far.y, side.x - far.x);
    const n = goalFaceNormal(a); // unit, points into the field
    specs.push({ hx: len / 2, hy: GOAL_FACE_T, tx: mx - n.x * GOAL_FACE_T, ty: my - n.y * GOAL_FACE_T, rot: ang });

    // classifier channel (axis-aligned rect along the side wall)
    const r = classifierRect(a);
    specs.push({
      hx: (r.x1 - r.x0) / 2,
      hy: (r.y1 - r.y0) / 2,
      tx: (r.x0 + r.x1) / 2,
      ty: (r.y0 + r.y1) / 2,
      rot: 0,
    });
  }
  return specs;
}

/** the physical GATE handles as one-way doors, as plain specs. See the long note
 * on the old `buildGateArms` (physicsEngine.ts) for the physics; this returns the
 * cuboids and lets physicsEngine build the Rapier colliders (in the same order). */
function decodeGateArms(
  world: World,
  _dt: number,
  gateCol?: Record<Alliance, number>,
): StaticSpec[] {
  const out: StaticSpec[] = [];
  for (const a of ALLIANCES) {
    const g = goalSide(a);
    // use the ANTICIPATED open fraction (this tick's lift already folded in by
    // gateColliderPos) when provided, so a robot ramming the gate open glides
    // through on the same tick instead of hard-stopping against last tick's stub.
    const pos = gateCol ? gateCol[a] : world.goals[a].gatePos;
    const rect = gateHandleRect(a, pos); // ONE source of truth — the torque pass reads it too
    if (!rect) continue;
    out.push({
      hx: (rect.x1 - rect.x0) / 2,
      hy: (rect.y1 - rect.y0) / 2,
      tx: (rect.x0 + rect.x1) / 2,
      ty: (rect.y0 + rect.y1) / 2,
      rot: 0,
    });
    void g;
  }
  return out;
}

/** The static geometry is CONSTANT; compute once (identical numbers ⇒ identical
 * colliders ⇒ determinism), matching the old module-global `STATIC_SPECS` cache. */
export const decodeColliders: FieldColliders = {
  statics: computeStaticSpecs(),
  dynamic: decodeGateArms,
};
