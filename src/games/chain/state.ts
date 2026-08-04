import type { Alliance, RobotSpec, RobotState, StartPose, Vec2 } from '../../types';
import type { Rect } from '../../sim/field';
import { INTAKE_PRESETS } from '../../config';
import {
  CHAIN_HALF_X,
  CHAIN_HALF_Y,
  CHAIN_HOOK_Y,
  CHAIN_LAB,
  CHAIN_RINGSTAND_POST,
  CHAIN_RINGSTAND_GAP,
  CHAIN_ASCEND_R,
  CHAIN_RINGSTAND_BOX,
  CHAIN_INTAKES,
  CHAIN_DEFAULT_INTAKE,
} from './config';
import { type ChainEdge, EDGE_ANGLE, EDGE_DIR, catalystMountOf, edgeGeom, intakeMountEdges, intakeMountOf } from './mounts';
import { CHAIN_CATALYST_NEAR, chainCatalystGeom } from './config';
import { datan2, hyp, rot, wrapAngle } from '../../math';

/**
 * The CR intake MOUTHS in the robot-local frame — the ONE source of truth shared by the capture
 * logic (`interact`) and the renderers (`drawChainIntake`, `RobotPreview`) so the grab area IS
 * the drawn intake. One entry per mounted edge (`intakeMountEdges`), each an axis-aligned rect
 * in inches, robot-local (+x forward, +y left), so `frontback` and `side` are simply two rects.
 *
 * Each mouth reaches OUT to the collision extent of its edge (`footprintExtents`, which the same
 * mount drives) and takes a shallow `depth` bite back inside the frame — so a particle at the
 * roller is captured BEFORE the frame would plow it, on whichever edge is mounted.
 *  • END edges (front/back) span the chassis WIDTH: `widthFrac`·chassis +`overhang`.
 *  • FLANK edges (left/right) span the chassis LENGTH.
 */
export interface ChainIntakeMouth {
  edge: ChainEdge;
  /** robot-local axis-aligned bounds, x0 < x1 and y0 < y1 */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export function chainIntakeMouths(spec: RobotSpec): ChainIntakeMouth[] {
  const it = CHAIN_INTAKES[spec.chainIntake ?? CHAIN_DEFAULT_INTAKE];
  const reach = INTAKE_PRESETS[spec.intake].reach;
  const hl = spec.length / 2;
  const hw = spec.width / 2;
  const endHalf = hw * it.widthFrac + it.overhang; // mouth half-width across an END edge
  // a flank roller bites `depth` into the frame; never past the centerline on a narrow chassis
  const flankInner = Math.max(0.5, hw - it.depth);

  return intakeMountEdges(intakeMountOf(spec)).map((edge): ChainIntakeMouth => {
    switch (edge) {
      case 'front':
        return { edge, x0: hl - it.depth, x1: hl + reach, y0: -endHalf, y1: endHalf };
      case 'back':
        return { edge, x0: -hl - reach, x1: -hl + it.depth, y0: -endHalf, y1: endHalf };
      case 'left':
        return { edge, x0: -hl, x1: hl, y0: flankInner, y1: hw + reach };
      case 'right':
        return { edge, x0: -hl, x1: hl, y0: -hw - reach, y1: -flankInner };
    }
  });
}

/** is robot-local point (`lx`,`ly`) inside `mouth`? `pad` (a particle radius) grows ONLY the
 * OUTWARD edge — a ball just touching the roller tip is in, but the inner/lateral bounds stay
 * exact, so the mouth never silently swallows through the chassis. */
export function mouthContains(mouth: ChainIntakeMouth, lx: number, ly: number, pad = 0): boolean {
  const x0 = mouth.edge === 'back' ? mouth.x0 - pad : mouth.x0;
  const x1 = mouth.edge === 'front' ? mouth.x1 + pad : mouth.x1;
  const y0 = mouth.edge === 'right' ? mouth.y0 - pad : mouth.y0;
  const y1 = mouth.edge === 'left' ? mouth.y1 + pad : mouth.y1;
  return lx > x0 && lx < x1 && ly > y0 && ly < y1;
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
  /** IN-FLIGHT / SLIDING motion after a catapult fling. A flung ring flies a real arc and
   * then slides to rest — it is never teleported to a landing spot (same no-teleporting
   * rule the Particles follow). All three are 0 for a ring at rest, carried, or hooked. */
  vel: Vec2;
  z: number;
  vz: number;
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
  /** world.time each robot's catalyst mechanism may next act — the per-archetype CYCLE
   * cooldown (an arm extends/retracts, a catapult re-cocks, a rail turret just indexes).
   * Plain numbers keyed by robot id, so snapshots/replays carry it. */
  catalystReadyAt: Record<number, number>;
  /** was the CATAPULT throw button held last tick, per robot (its own edge). */
  flingHeld: Record<number, boolean>;
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
    catalystReadyAt: {},
    flingHeld: {},
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
  // The POST does not sit in the middle of its assembly block — it stands at the block's
  // INNER corner, the one diagonally opposite the field corner (that is where the plate
  // carries it, so the rings hang out over the field rather than into the wall). Derived
  // from `ringStandBoxes` so the post can never drift away from the block it stands on.
  const h = CHAIN_RINGSTAND_BOX / 2;
  const inset = h - CHAIN_RINGSTAND_POST - CHAIN_RINGSTAND_GAP; // leaves GAP at the inner faces
  return ringStandBoxes().map((b) => ({
    x: b.x - Math.sign(b.x) * inset,
    y: b.y - Math.sign(b.y) * inset,
  }));
}

/** is `pos` on (within the ascend radius of) any Ring Stand? Shared by the endgame
 * ascend check and the auto-descent "came down off the stand" check. Position-only
 * (no speed gate) — leaving the radius is what counts as descending. */
export function onRingStand(pos: Vec2): boolean {
  const h = CHAIN_RINGSTAND_BOX / 2;
  for (const rs of ringStandBoxes()) {
    // distance from `pos` to the corner SQUARE (0 inside it), not to the post
    const dx = Math.max(0, Math.abs(pos.x - rs.x) - h);
    const dy = Math.max(0, Math.abs(pos.y - rs.y) - h);
    if (dx * dx + dy * dy < CHAIN_ASCEND_R * CHAIN_ASCEND_R) return true;
  }
  return false;
}

/** centres of the four solid CORNER ASSEMBLIES (post + mounting plate), flush with the
 * walls. The single source both the colliders and the ascend test read. */
export function ringStandBoxes(): Vec2[] {
  const c = CHAIN_HALF_X - CHAIN_RINGSTAND_BOX / 2;
  return [
    { x: c, y: c },
    { x: c, y: -c },
    { x: -c, y: c },
    { x: -c, y: -c },
  ];
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


// ─────────────────────────────────────────────────────────── catalyst mechanism ──

/**
 * The catalyst mechanism's MOUTH in WORLD space — the point on the mounted chassis edge
 * that its reach is measured from. Bolting the mechanism to a different edge really does
 * move where it can work from, which is the whole point of making the mount configurable.
 */
export function catalystMouth(rob: RobotState): Vec2 {
  const edge = catalystMountOf(rob.spec);
  const { dist } = edgeGeom(rob.spec, edge);
  const d = EDGE_DIR[edge];
  // deterministic rotate (`rot` → dcos/dsin) — this is SIM code, so an engine-defined
  // cosine here would be a cross-engine desync, not just different pixels
  const w = rot({ x: d.x * dist, y: d.y * dist }, rob.heading);
  return { x: rob.pos.x + w.x, y: rob.pos.y + w.y };
}

/**
 * Can this robot's catalyst mechanism work on `target` right now, within `radius`?
 *
 * Two gates, and BOTH matter to how each archetype plays:
 *  • DISTANCE from the mechanism's mouth (not the robot centre), and
 *  • the reach CONE — the target must lie within `cone` of the mounted edge's outward
 *    normal. A `turret` has cone = π and so ignores facing entirely (that IS its perk);
 *    an `arm` or a `launcher` has to be pointed roughly the right way.
 *
 * ONE function so the action and the HUD prompt can never disagree about what is in
 * reach — the prompt saying "place" while the action refuses would be maddening.
 */
export function catalystCanReach(rob: RobotState, target: Vec2, radius: number): boolean {
  const mouth = catalystMouth(rob);
  const dx = target.x - mouth.x;
  const dy = target.y - mouth.y;
  if (hyp(dx, dy) >= radius) return false;
  const cone = chainCatalystGeom(rob.spec).cone;
  if (cone >= Math.PI) return true; // omnidirectional (turret)
  // already in the claw's grasp ⇒ the angle doesn't matter (see CHAIN_CATALYST_NEAR)
  if (hyp(dx, dy) <= CHAIN_CATALYST_NEAR) return true;
  const edge = catalystMountOf(rob.spec);
  const facing = wrapAngle(rob.heading + EDGE_ANGLE[edge]);
  return Math.abs(wrapAngle(datan2(dy, dx) - facing)) <= cone;
}

/** distance from the mechanism mouth to `target` (for nearest-target selection). */
export function catalystDist(rob: RobotState, target: Vec2): number {
  const m = catalystMouth(rob);
  return hyp(target.x - m.x, target.y - m.y);
}


/**
 * Snap a CUSTOM Chain Reaction start pose to something legal and spawnable.
 *
 * Two hard constraints fight each other in every corner: G04 wants the robot COMPLETELY
 * inside its Lab-Area square, and the Ring-Stand assembly occupies that square's outer
 * corner as a SOLID collider. A pose that violates either would spawn the robot inside a
 * wall or outside its zone, so this clamps into the Lab (allowing for the chassis extent)
 * and then, if the result still overlaps a corner assembly, pushes it out along whichever
 * axis needs the least movement.
 *
 * `pos` is in the CANONICAL (blue, +x) frame, matching `CHAIN_START_POSES`.
 */
export function chainSnapStart(spec: RobotSpec, pos: Vec2): Vec2 {
  const e = Math.max(spec.length, spec.width) / 2 + 0.5; // generous, rotation-agnostic
  const lo = CHAIN_HALF_X - CHAIN_LAB + e;
  const hi = CHAIN_HALF_X - e;
  const clamp1 = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
  // into the Lab square: x always positive-side, y into whichever corner it is nearer
  const x = clamp1(pos.x, lo, hi);
  const sy = pos.y >= 0 ? 1 : -1;
  const y = sy * clamp1(Math.abs(pos.y), lo, hi);
  // out of the corner assembly, along the cheaper axis
  const h = CHAIN_RINGSTAND_BOX / 2;
  let out = { x, y };
  for (const b of ringStandBoxes()) {
    const dx = h + e - Math.abs(out.x - b.x);
    const dy = h + e - Math.abs(out.y - b.y);
    if (dx <= 0 || dy <= 0) continue; // clear of this one
    if (dx < dy) out = { x: b.x - Math.sign(b.x || 1) * (h + e), y: out.y };
    else out = { x: out.x, y: b.y - Math.sign(b.y || 1) * (h + e) };
    out.x = clamp1(out.x, lo, hi);
    out.y = sy * clamp1(Math.abs(out.y), lo, hi);
  }
  return out;
}


/** Is a CANONICAL (blue-frame) start position legal? G04 wants the robot COMPLETELY inside
 * a Lab-Area corner square, and the solid corner assembly must not be overlapped. This is
 * the predicate the editor colours its footprint with; `chainSnapStart` is the repair. */
export function chainStartLegal(spec: RobotSpec, pos: Vec2): boolean {
  const snapped = chainSnapStart(spec, pos);
  return Math.abs(snapped.x - pos.x) < 0.01 && Math.abs(snapped.y - pos.y) < 0.01;
}

/** why a start pose is (il)legal, for the editor's status line and its footprint ring. */
export interface ChainStartLegality {
  /** the conservative, rotation-agnostic half-extent the rules are checked against — the
   * robot may sit at ANY heading, so the tests use its largest dimension */
  extent: number;
  /** fully inside one of the Lab-Area corner squares (G04) */
  inLab: boolean;
  /** clear of the SOLID Ring-Stand corner assembly */
  clearOfStand: boolean;
  /** the authoritative verdict — the snap round-trip the spawn actually applies */
  legal: boolean;
}

/** Break `chainStartLegal` down into the two rules it enforces, so the editor can say
 * WHICH one a pose breaks. `legal` stays the snap round-trip (the spawn's own answer), not
 * a re-derivation, so the ring can never disagree with where the robot really starts. */
export function chainEvalStart(spec: RobotSpec, pos: Vec2): ChainStartLegality {
  const e = Math.max(spec.length, spec.width) / 2 + 0.5; // same extent chainSnapStart uses
  const lo = CHAIN_HALF_X - CHAIN_LAB + e;
  const hi = CHAIN_HALF_X - e;
  const EPS = 0.01;
  const inLab =
    lo <= hi &&
    pos.x >= lo - EPS &&
    pos.x <= hi + EPS &&
    Math.abs(pos.y) >= lo - EPS &&
    Math.abs(pos.y) <= hi + EPS;
  const h = CHAIN_RINGSTAND_BOX / 2;
  let clearOfStand = true;
  for (const b of ringStandBoxes()) {
    if (Math.abs(pos.x - b.x) < h + e - EPS && Math.abs(pos.y - b.y) < h + e - EPS) {
      clearOfStand = false;
    }
  }
  return { extent: e, inLab, clearOfStand, legal: chainStartLegal(spec, pos) };
}

/** CANONICAL (blue, +x) start pose <-> the alliance's ACTUAL one. Mirrors `chainStartPose`
 * in spawn.ts: red is the x-mirror, heading reflected about the y axis. SELF-INVERSE, so
 * the editor can display in the actual frame and store canonical with the same call, and a
 * pose keeps its spot when the alliance changes. */
export function chainMirrorStart(pose: StartPose, alliance: Alliance): StartPose {
  if (alliance === 'blue') return { x: pose.x, y: pose.y, headingDeg: pose.headingDeg };
  let deg = (180 - pose.headingDeg) % 360;
  if (deg > 180) deg -= 360;
  if (deg <= -180) deg += 360;
  return { x: -pose.x, y: pose.y, headingDeg: deg };
}
