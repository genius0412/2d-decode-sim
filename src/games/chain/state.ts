import type { Alliance, RobotSpec, Vec2 } from '../../types';
import type { Rect } from '../../sim/field';
import { INTAKE_PRESETS } from '../../config';
import {
  CHAIN_HALF_X,
  CHAIN_HALF_Y,
  CHAIN_HOOK_Y,
  CHAIN_LAB,
  CHAIN_RINGSTAND_XY,
  CHAIN_ASCEND_R,
  CHAIN_INTAKES,
  CHAIN_DEFAULT_INTAKE,
} from './config';

/**
 * The CR intake MOUTH in the robot-local frame — the ONE source of truth shared by the capture
 * logic (`interact`) and the renderer (`drawChainIntake`) so the grab area IS the drawn intake.
 * A discriminated union by geometry (all inches, robot-local, +x = forward):
 *  • FRONT (sweeper): a box at the front. `front` = the collision/OBB tip (`robotExtents().front`,
 *    so particles are grabbed before being plowed); `back` a shallow bite behind the front edge;
 *    `half` the mouth half-width (widthFrac·chassis +overhang).
 *  • SIDE: rollers on BOTH side edges. `halfLen` the fore-aft span (chassis length); `inner` the
 *    inside capture edge (into the frame) and `outer` how far out past each side (±y) it grabs.
 */
export type ChainIntakeBand =
  | { side: false; back: number; front: number; half: number }
  | { side: true; halfLen: number; inner: number; outer: number };

export function chainIntakeBand(spec: RobotSpec): ChainIntakeBand {
  const it = CHAIN_INTAKES[spec.chainIntake ?? CHAIN_DEFAULT_INTAKE];
  const hl = spec.length / 2;
  const hw = spec.width / 2;
  // SIDE mount: the sweeper sits on the left+right edges instead of the front. `outer` uses the
  // SAME intake reach as the front tip, so the capture band == the collision hitbox side extent
  // (footprintExtents) — the intake is part of the non-ball collision footprint.
  if (spec.intakeSide) {
    return { side: true, halfLen: hl, inner: Math.max(0.5, hw - it.depth), outer: hw + INTAKE_PRESETS[spec.intake].reach };
  }
  return {
    side: false,
    back: hl - it.depth,
    front: hl + INTAKE_PRESETS[spec.intake].reach, // = robotExtents().front (the intake tip)
    half: hw * it.widthFrac + it.overhang,
  };
}

/**
 * Chain Reaction runtime state — everything CR-specific lives here on `world.chain`
 * so the shared `World` type needs only one optional field. Plain JSON (catalysts /
 * counters / per-robot endgame), so determinism, snapshots, and replays hold.
 */

export type EndgameState = 'none' | 'parked' | 'ascended';

export interface ChainCatalyst {
  id: number;
  pos: Vec2;
  /** robot id currently carrying it (max 1 per robot), else null */
  carriedBy: number | null;
  /** the hook it is seated on (scored ⇒ contributes a multiplier), else null */
  hook: { alliance: Alliance; index: number } | null;
}

export interface ChainState {
  catalysts: ChainCatalyst[];
  /** particles scored per alliance (count) */
  scored: Record<Alliance, number>;
  /** points earned from particles (multiplier folded in AT score time) */
  particlePoints: Record<Alliance, number>;
  /** endgame status per robot id (park 5 / ascend 100) */
  endgame: Record<number, EndgameState>;
  /** robot ids that STARTED perched on a Ring Stand — eligible for the AUTO descent
   * award (they earn it by coming down off the stand during auto). Set once at spawn. */
  descentArmed: Record<number, boolean>;
  /** robot ids that have EARNED the auto descent (came down off their Ring Stand during
   * auto = 100 pt). Latched, so the recomputed alliance total keeps the points all match. */
  descended: Record<number, boolean>;
  /** last catalyst-button state per robot id (for edge-triggered pick/place) */
  catalystHeld: Record<number, boolean>;
  /** monotonic ball-id allocator (deterministic — no module global). Set past the
   * initial particle ids at spawn; `updateChain` increments it for reject/flight balls. */
  nextBallId: number;
  /** penalty EDGE state: `${rule}-${offender}-${victim}` keys that were VIOLATING last tick
   * (so a foul fires once on the false→true edge, and again on re-entry). Plain JSON. */
  foulEdge: Record<string, boolean>;
}

export function emptyChainState(): ChainState {
  return {
    catalysts: [],
    scored: { red: 0, blue: 0 },
    particlePoints: { red: 0, blue: 0 },
    endgame: {},
    descentArmed: {},
    descended: {},
    catalystHeld: {},
    nextBallId: 1,
    foulEdge: {},
  };
}

// ── geometry ────────────────────────────────────────────────────────────────

/** the x sign of an alliance's accelerator/side wall: red LEFT (−1), blue RIGHT (+1) */
export function accelSide(a: Alliance): -1 | 1 {
  return a === 'red' ? -1 : 1;
}

/** the accelerator mouth CENTER (on the side wall) an alliance launches into */
export function accelMouth(a: Alliance): Vec2 {
  return { x: accelSide(a) * CHAIN_HALF_X, y: 0 };
}

/** FOUR hooks per goal. They sit at TWO top-down positions on the accelerator wall
 * (y = ±CHAIN_HOOK_Y, the manual's ±688mm); each position has two stacked hooks
 * (top + bottom) that read as ONE from above. `hookPos` is the shared placement point
 * (hooks 0,1 at +y ; 2,3 at −y). */
export const CHAIN_HOOKS_PER_GOAL = 4;

export function hookPos(a: Alliance, index: number): Vec2 {
  const y = index < 2 ? CHAIN_HOOK_Y : -CHAIN_HOOK_Y;
  return { x: accelSide(a) * CHAIN_HALF_X, y };
}

/** RENDER position of hook `index` — nudged just INSIDE the accelerator mouth and the
 * two stacked hooks at a position spread apart, so all four hooks stay individually
 * visible + countable in the top-down view (they'd overlap into one otherwise). */
export function hookSlotPos(a: Alliance, index: number): Vec2 {
  const base = hookPos(a, index);
  return { x: base.x - accelSide(a) * 4, y: base.y + (index % 2 === 0 ? -3.4 : 3.4) };
}

/** all four Ring-Stand corner positions */
export function ringStands(): Vec2[] {
  return [
    { x: -CHAIN_RINGSTAND_XY, y: CHAIN_RINGSTAND_XY },
    { x: CHAIN_RINGSTAND_XY, y: CHAIN_RINGSTAND_XY },
    { x: -CHAIN_RINGSTAND_XY, y: -CHAIN_RINGSTAND_XY },
    { x: CHAIN_RINGSTAND_XY, y: -CHAIN_RINGSTAND_XY },
  ];
}

/** is `pos` on (within the ascend radius of) any Ring Stand? Shared by the endgame
 * ascend check and the auto-descent "came down off the stand" check. Position-only
 * (no speed gate) — leaving the radius is what counts as descending. */
export function onRingStand(pos: Vec2): boolean {
  for (const rs of ringStands()) {
    const dx = rs.x - pos.x;
    const dy = rs.y - pos.y;
    if (dx * dx + dy * dy < CHAIN_ASCEND_R * CHAIN_ASCEND_R) return true;
  }
  return false;
}

/** the Lab-Area corner squares OWNED by an alliance (its two side corners). APPROX. */
export function labAreas(a: Alliance): Rect[] {
  const s = accelSide(a); // red squares on x<0, blue on x>0
  const x0 = s < 0 ? -CHAIN_HALF_X : CHAIN_HALF_X - CHAIN_LAB;
  const x1 = s < 0 ? -CHAIN_HALF_X + CHAIN_LAB : CHAIN_HALF_X;
  return [
    { x0, y0: CHAIN_HALF_Y - CHAIN_LAB, x1, y1: CHAIN_HALF_Y },
    { x0, y0: -CHAIN_HALF_Y, x1, y1: -CHAIN_HALF_Y + CHAIN_LAB },
  ];
}

/** points-per-particle for an alliance = 1 + (# catalysts seated on its hooks) */
export function accelMultiplier(state: ChainState, a: Alliance): number {
  let mult = 1;
  for (const c of state.catalysts) if (c.hook && c.hook.alliance === a) mult++;
  return mult;
}
