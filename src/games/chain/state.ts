import type { Alliance, ChainMountPos, RobotSpec, RobotState, StartPose, Vec2, World } from '../../types';
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
  CHAIN_RAIL_MARGIN,
  CHAIN_INTAKES,
  CHAIN_DEFAULT_INTAKE,
} from './config';
import { type ChainEdge, MOUNT_ANGLE, RAIL_DIR, catalystMountOf, catalystMountPositions, catalystSwingOf, intakeMountEdges, intakeMountOf, isEdgePos, mountOrigin } from './mounts';
import { CHAIN_CATALYST_NEAR, CHAIN_DEFAULT_CATALYST, CHAIN_TRACK_APPROACH, chainCatalystGeom } from './config';
import { datan2, dcos, dsin, hyp, rot, wrapAngle } from '../../math';

/**
 * LEGACY, for the frozen DECODE preview only.
 *
 * `src/ui/RobotPreview.tsx` is held byte-identical to what `main` ships (the DECODE robot's
 * look is not ours to change), and that file still carries a Chain Reaction branch which
 * calls this. The branch never runs — CR renders `ChainRobotPreview` instead — but the file
 * has to compile. CR's real intake geometry is `chainIntakeMouths` below.
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
 * Half the travel a RAIL carriage has along its mounted side, in inches.
 *
 * The track spans the side it is bolted to, less a margin for the carriage body and the end
 * stops — so a front/back rail runs across the chassis WIDTH and a flank rail along its
 * LENGTH. Zero for every other catalyst type, which is what makes the offset below a no-op
 * for them rather than needing a branch at each call site.
 */
export function catalystRailHalf(spec: RobotSpec): number {
  if ((spec.catalystType ?? CHAIN_DEFAULT_CATALYST) !== 'rail') return 0;
  const pos = catalystMountOf(spec);
  if (!isEdgePos(pos)) return 0; // coerceSpec folds a rail onto an edge; belt and braces
  const span = pos === 'front' || pos === 'back' ? spec.width : spec.length;
  return Math.max(0, span / 2 - CHAIN_RAIL_MARGIN);
}

/** the catalyst mechanism's mouth in WORLD space for ONE mount position. */
function mouthAt(rob: RobotState, pos: Exclude<ChainMountPos, 'center'>): Vec2 {
  const o = mountOrigin(rob.spec, pos);
  // a RAIL carriage slides ALONG the mounted side, so its mouth is offset from the mount
  // point by wherever the carriage currently is. This is the whole mechanism: without it
  // the rail was drawn but the claw still worked from one fixed spot.
  const half = catalystRailHalf(rob.spec);
  const local = half > 0 ? railOffset(o, pos, rob.catalystRail * half) : o;
  // deterministic rotate (`rot` → dcos/dsin) — this is SIM code, so an engine-defined
  // cosine here would be a cross-engine desync, not just different pixels
  const w = rot(local, rob.heading);
  return { x: rob.pos.x + w.x, y: rob.pos.y + w.y };
}

/**
 * Slide a mount origin along its own edge by `d` inches, in the ROBOT frame.
 *
 * The axis comes from `RAIL_DIR` — the mount's own local +y — which is the SAME axis
 * `drawChainRobot` slides the drawn carriage along. This used to be derived here instead
 * ("front/back run across y, the flanks along x"), which is inverted from the mount frame on
 * `back` and `left`: the sprite slid one way while the claw worked from the other.
 */
function railOffset(o: Vec2, pos: ChainMountPos, d: number): Vec2 {
  const dir = RAIL_DIR[pos];
  return { x: o.x + dir.x * d, y: o.y + dir.y * d };
}

/**
 * Where the carriage WANTS to be for a given world target: the target projected onto the
 * track and clamped to its ends, as a −1..1 fraction. Pure, so the sim can rate-limit toward
 * it and the renderer can draw wherever the carriage actually got to.
 */
export function catalystRailTarget(rob: RobotState, target: Vec2 | null): number {
  const half = catalystRailHalf(rob.spec);
  if (half <= 0 || !target) return 0;
  // `catalystRailHalf` already returned 0 for anything that is not a single EDGE, so by
  // here the mount is one of front/back/left/right
  const pos = catalystMountOf(rob.spec) as Exclude<ChainMountPos, 'center'>;
  // the target in the ROBOT frame — the rail is a chassis axis, so the projection has to
  // happen there rather than in world space
  const d = rot({ x: target.x - rob.pos.x, y: target.y - rob.pos.y }, -rob.heading);
  const o = mountOrigin(rob.spec, pos);
  // project onto the SAME axis the carriage actually slides along (see `railOffset`)
  const dir = RAIL_DIR[pos];
  const along = (d.x - o.x) * dir.x + (d.y - o.y) * dir.y;
  return Math.max(-1, Math.min(1, along / half));
}

/**
 * EVERY mouth this robot's catalyst can work from, in WORLD space. One entry for a normal
 * mount; TWO for the FRONTBACK swing arm, whose pivot rotates between the two ends.
 *
 * Bolting the mechanism somewhere else really does move where it can work from — that is the
 * whole point of making the mount configurable — and the swing is the one build that gets a
 * choice of where to work from at any instant.
 */
export function catalystMouths(rob: RobotState): Vec2[] {
  return catalystMountPositions(catalystMountOf(rob.spec), catalystSwingOf(rob.spec)).map((p) => mouthAt(rob, p));
}

/**
 * The catalyst mechanism's ACTIVE mouth — the one point the ring is held at and reaches from.
 * For a single mount that is simply where it is bolted; for the FRONTBACK swing it is the end
 * nearer `target` (the arm swings to face the work), or the FRONT when nothing is specified,
 * which is where a swing arm stows.
 */
export function catalystMouth(rob: RobotState, target?: Vec2): Vec2 {
  const ms = catalystMouths(rob);
  if (ms.length === 1 || !target) return ms[0];
  let best = ms[0];
  let bestD = Infinity;
  for (const m of ms) {
    const d = hyp(target.x - m.x, target.y - m.y);
    if (d < bestD) { bestD = d; best = m; }
  }
  return best;
}

/**
 * Can this robot's catalyst mechanism work on `target` right now, within `radius`?
 *
 * Two gates, and BOTH matter to how each archetype plays:
 *  • DISTANCE from the mechanism's mouth (not the robot centre), and
 *  • the reach CONE — the target must lie within `cone` of that mount's outward direction.
 *    A `turret` has cone = π and so ignores facing entirely (that IS its perk); an `arm` or
 *    a `launcher` has to be pointed roughly the right way. A CORNER mount points along the
 *    diagonal, so it covers two half-sides rather than one full side.
 *
 * A FRONTBACK swing passes if EITHER end can do the job — that is exactly what the extra
 * pivot buys, and it is why the check loops over `catalystMountPositions` rather than
 * resolving a single edge.
 *
 * ONE function so the action and the HUD prompt can never disagree about what is in
 * reach — the prompt saying "place" while the action refuses would be maddening.
 */
export function catalystCanReach(rob: RobotState, target: Vec2, radius: number): boolean {
  const cone = chainCatalystGeom(rob.spec).cone;
  for (const pos of catalystMountPositions(catalystMountOf(rob.spec), catalystSwingOf(rob.spec))) {
    const mouth = mouthAt(rob, pos);
    const dx = target.x - mouth.x;
    const dy = target.y - mouth.y;
    const d = hyp(dx, dy);
    if (d >= radius) continue;
    if (cone >= Math.PI) return true; // omnidirectional (turret)
    // already in the claw's grasp ⇒ the angle doesn't matter (see CHAIN_CATALYST_NEAR)
    if (d <= CHAIN_CATALYST_NEAR) return true;
    const facing = wrapAngle(rob.heading + MOUNT_ANGLE[pos]);
    if (Math.abs(wrapAngle(datan2(dy, dx) - facing)) <= cone) return true;
  }
  return false;
}

/**
 * What the claw is tracking: the thing it would ACTUALLY act on if the button were pressed
 * right now, measured from its mouth. Drives both the drawn aim and the rail carriage, so
 * the mechanism is always visibly working toward the job it is about to do.
 *
 * IT HAS TO MIRROR `catalystAction`, and the first version did not — which is what made a
 * rail carriage look broken:
 *
 *  • CARRYING a ring, the only useful target is an EMPTY HOOK to place it on. The old code
 *    stowed the carriage centred while carrying, so the one moment the claw needs to reach
 *    along its track — lining up a hook — was the one moment the track refused to move.
 *  • EMPTY-HANDED, the targets are the rings it can pick up: LOOSE ones on the floor and
 *    SEATED ones (taking a ring off a hook is a legal de-score). The old code had this
 *    exactly inverted — it offered every hook whether or not anything was on it, and
 *    skipped seated rings entirely.
 *  • OUT OF RANGE IS NOT A TARGET. Every hook on the field was a candidate at any distance,
 *    and the rail projection clamps to its end stops, so a robot with nothing to do parked
 *    its carriage hard against one end and slid it side to side as the chassis turned.
 *    Nothing within working distance ⇒ null ⇒ the carriage stows centred, which is what an
 *    idle machine does.
 *
 * Pure and world-reading, so the renderer can draw the tracking without owning the decision —
 * and so the decision is testable, which a `ctx`-only helper would not be.
 */
export function catalystTrackTarget(rob: RobotState, world?: World): Vec2 | null {
  const chain = world?.chain;
  if (!chain) return null;
  const mouth = catalystMouth(rob);
  // WORKING RANGE: the claw's reach, plus the span the carriage can cover, plus an approach
  // margin so the mechanism pre-positions while the robot is still driving up rather than
  // waiting until the target is already grabbable.
  const range = chainCatalystGeom(rob.spec).reach + catalystRailHalf(rob.spec) + CHAIN_TRACK_APPROACH;
  let best: Vec2 | null = null;
  let bestD = range;
  const consider = (p: Vec2) => {
    const d = hyp(p.x - mouth.x, p.y - mouth.y);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  };

  const carrying = chain.catalysts.some((c) => c.carriedBy === rob.id);
  if (carrying) {
    // placing: only hooks with nothing already on them
    for (const a of ['red', 'blue'] as Alliance[]) {
      for (let i = 0; i < CHAIN_HOOKS_PER_GOAL; i++) {
        if (chain.catalysts.some((o) => o.hook && o.hook.alliance === a && o.hook.index === i)) continue;
        consider(hookPos(a, i));
      }
    }
    return best;
  }
  // grabbing: any ring nobody is holding — on the floor, or seated on a hook (de-score)
  for (const c of chain.catalysts) {
    if (c.carriedBy !== null) continue;
    consider(c.hook ? hookPos(c.hook.alliance, c.hook.index) : c.pos);
  }
  return best;
}

/** distance from the NEAREST usable mouth to `target` (for nearest-target selection). */
export function catalystDist(rob: RobotState, target: Vec2): number {
  let best = Infinity;
  for (const m of catalystMouths(rob)) best = Math.min(best, hyp(target.x - m.x, target.y - m.y));
  return best;
}


/**
 * Half-extents of the AXIS-ALIGNED box the robot's footprint occupies at `headingDeg`,
 * plus a small clearance margin. The single source both the legality test and the
 * editor's outline read.
 *
 * HEADING MATTERS, and the previous model said it did not. It used one scalar,
 * `max(length, width)/2 + 0.5`, described as "generous, rotation-agnostic" — but that
 * is not a bound over all headings at all: a square chassis turned 45° sweeps
 * `(|cos|+|sin|)·s/2 ≈ 0.707s`, well past the `0.5s` that bound allowed. So a robot
 * placed diagonally could be called legal and still overlap the solid corner assembly.
 * Computing the real rotated extents fixes that AND is what lets the editor draw an
 * outline that turns with the robot instead of a square that visibly does not.
 *
 * At 0°/90° this is exactly the chassis, so an axis-aligned robot now gets the room its
 * true footprint deserves rather than being measured by its longer side.
 */
export function chainStartExtents(
  spec: RobotSpec,
  headingDeg: number,
): { ex: number; ey: number } {
  // dcos/dsin, not Math.cos/sin — this is sim source, and the trig discipline is what
  // keeps two engines agreeing on a spawn position (see CLAUDE.md)
  const rad = (headingDeg * Math.PI) / 180;
  const c = Math.abs(dcos(rad));
  const s = Math.abs(dsin(rad));
  const hl = spec.length / 2;
  const hw = spec.width / 2;
  return { ex: c * hl + s * hw + 0.5, ey: s * hl + c * hw + 0.5 };
}

/**
 * Does ANY legal position exist at this heading?
 *
 * The Lab Area is a 24" square, so a robot only fits inside it while its footprint's
 * axis-aligned bound stays under 24" on both axes — and that bound GROWS as the robot
 * turns off-axis, peaking at 45°. A maximum-size 18×18 robot sweeps ~25.5" diagonally
 * and therefore has NO legal diagonal start at all, which is a true fact about the
 * field rather than a limitation of the editor.
 *
 * Worth asking separately from `chainStartLegal`, because the two failures need
 * different repairs: a bad POSITION is fixed by moving, a bad HEADING can only be
 * fixed by turning, and a snap that only ever moves would hunt forever.
 */
export function chainHeadingFits(spec: RobotSpec, headingDeg: number): boolean {
  const { ex, ey } = chainStartExtents(spec, headingDeg);
  const lo = CHAIN_HALF_X - CHAIN_LAB; // inner Lab edge
  const hi = CHAIN_HALF_X; // wall
  // (a) the Lab band exists on both axes
  if (lo + ex > hi - ex || lo + ey > hi - ey) return false;
  // (b) AND some point in it also clears the corner assembly, which occupies the Lab's
  // OUTER corner — `[hi - BOX, hi]` on both axes. Escaping it means retreating inward on
  // one axis or the other, so at least one axis must have room for that retreat while
  // staying inside the Lab. Checking (a) alone was not enough: at 45° a mid-size chassis
  // fits the square and still has nowhere in it that misses the post.
  const inner = hi - CHAIN_RINGSTAND_BOX;
  return lo + ex <= inner - ex || lo + ey <= inner - ey;
}

/** the nearest heading (in whole degrees) at which the robot fits the Lab at all —
 *  the repair for a pose turned too far to be placeable. Returns `headingDeg`
 *  unchanged when it already fits; searches both ways so it turns the short way. */
export function chainNearestFittingHeading(spec: RobotSpec, headingDeg: number): number {
  if (chainHeadingFits(spec, headingDeg)) return headingDeg;
  for (let d = 1; d <= 90; d++) {
    if (chainHeadingFits(spec, headingDeg + d)) return headingDeg + d;
    if (chainHeadingFits(spec, headingDeg - d)) return headingDeg - d;
  }
  return headingDeg; // a robot too big for the Lab at ANY heading — caller reports it
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
 * The Lab square is axis-aligned, so clamping the footprint's AABB into it is EXACT —
 * an AABB sits inside an axis-aligned box iff the rotated rect it bounds does. The
 * corner-assembly push is conservative (AABB vs box can report an overlap two rotated
 * rects would not have), which is the right way to be wrong next to a solid post.
 *
 * `pos` is in the CANONICAL (blue, +x) frame, matching `CHAIN_START_POSES`.
 */
export function chainSnapStart(spec: RobotSpec, pos: Vec2, headingDeg: number): Vec2 {
  const { ex, ey } = chainStartExtents(spec, headingDeg);
  const clamp1 = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
  const lo = CHAIN_HALF_X - CHAIN_LAB;
  // into the Lab square: x always positive-side, y into whichever corner it is nearer
  const x = clamp1(pos.x, lo + ex, CHAIN_HALF_X - ex);
  const sy = pos.y >= 0 ? 1 : -1;
  const y = sy * clamp1(Math.abs(pos.y), lo + ey, CHAIN_HALF_X - ey);

  /**
   * OUT OF THE CORNER ASSEMBLY.
   *
   * The assembly sits in the Lab's OUTER corner, so escaping it means retreating INWARD
   * on one axis or the other — there is no outward room, the wall is there. Both
   * retreats are computed to their exact target, the infeasible ones (those that would
   * leave the Lab) are discarded, and the nearest survivor wins.
   *
   * This replaces a "push along the cheaper axis, then re-clamp into the Lab" step that
   * could leave the robot still overlapping: the re-clamp would undo the push it had
   * just made, one pass per box, with nothing re-checking the result. `chainStartLegal`
   * was defined as this function's own fixed point, so such a position round-tripped and
   * was reported LEGAL while sitting inside a solid post.
   */
  const h = CHAIN_RINGSTAND_BOX / 2;
  let out = { x, y };
  for (const b of ringStandBoxes()) {
    if (Math.abs(out.x - b.x) >= h + ex || Math.abs(out.y - b.y) >= h + ey) continue; // clear
    const cands: Vec2[] = [];
    const rx = Math.sign(b.x || 1) * (Math.abs(b.x) - h - ex); // inward past its inner face
    const ry = Math.sign(b.y || 1) * (Math.abs(b.y) - h - ey);
    if (Math.abs(rx) >= lo + ex) cands.push({ x: rx, y: out.y });
    if (Math.abs(ry) >= lo + ey) cands.push({ x: out.x, y: ry });
    if (cands.length === 0) continue; // no escape at this heading — chainHeadingFits says so
    let best = cands[0];
    let bestD = Infinity;
    for (const c of cands) {
      const d = hyp(c.x - out.x, c.y - out.y);
      if (d < bestD) { bestD = d; best = c; }
    }
    out = best;
  }
  return out;
}


/**
 * Repair a whole CANONICAL start POSE — heading first, then position.
 *
 * The order is forced: a heading no Lab corner can accept has no legal position to snap
 * to, so clamping the position first would return a spot that is still illegal and the
 * robot would spawn inside the corner assembly and get flung on tick one. Squaring up
 * first guarantees the position clamp has somewhere to land.
 *
 * This is the chokepoint the SPAWN uses, so a hand-edited or spoofed pose — including a
 * deliberately diagonal one — cannot get a robot into a collider.
 */
export function chainSnapStartPose(spec: RobotSpec, pose: StartPose): StartPose {
  const headingDeg = chainNearestFittingHeading(spec, pose.headingDeg);
  const p = chainSnapStart(spec, { x: pose.x, y: pose.y }, headingDeg);
  return { x: p.x, y: p.y, headingDeg };
}

/** Is a CANONICAL (blue-frame) start pose legal? G04 wants the robot COMPLETELY inside
 * a Lab-Area corner square, and the solid corner assembly must not be overlapped. This is
 * the predicate the editor colours its footprint with; `chainSnapStart` is the repair. */
export function chainStartLegal(spec: RobotSpec, pos: Vec2, headingDeg: number): boolean {
  // The RULES themselves, not "the snap left it alone". Defining legality as the snap's
  // own fixed point made the two agree by construction — including when they were both
  // wrong, which is exactly how a position inside the corner assembly got reported legal.
  // Smoke asserts the direction that actually matters instead: whatever the snap returns
  // satisfies this predicate.
  const { ex, ey } = chainStartExtents(spec, headingDeg);
  const lo = CHAIN_HALF_X - CHAIN_LAB;
  const EPS = 0.01;
  const within = (v: number, e: number): boolean =>
    Math.abs(v) >= lo + e - EPS && Math.abs(v) <= CHAIN_HALF_X - e + EPS;
  if (!within(pos.x, ex) || !within(pos.y, ey)) return false;
  if (pos.x < 0) return false; // canonical poses live on the +x (blue) side
  const h = CHAIN_RINGSTAND_BOX / 2;
  for (const b of ringStandBoxes()) {
    if (Math.abs(pos.x - b.x) < h + ex - EPS && Math.abs(pos.y - b.y) < h + ey - EPS) return false;
  }
  return true;
}

/** why a start pose is (il)legal, for the editor's status line and its footprint ring. */
export interface ChainStartLegality {
  /** half-extents of the footprint AT THIS HEADING (see `chainStartExtents`) — what the
   * rules are checked against, and what the editor outlines */
  ex: number;
  ey: number;
  /** fully inside one of the Lab-Area corner squares (G04) */
  inLab: boolean;
  /** clear of the SOLID Ring-Stand corner assembly */
  clearOfStand: boolean;
  /** within ascend range of a Ring Stand — a legal place to start that is NOT the same
   * as starting on the open Lab floor, so the editor names which one it is */
  onStand: boolean;
  /** a legal position exists at this HEADING at all (see `chainHeadingFits`). False
   * means no amount of moving will help — the robot has to turn. */
  headingFits: boolean;
  /** the authoritative verdict — the snap round-trip the spawn actually applies */
  legal: boolean;
}

/** Break `chainStartLegal` down into the rules it enforces, so the editor can say
 * WHICH one a pose breaks. `legal` stays the snap round-trip (the spawn's own answer), not
 * a re-derivation, so the ring can never disagree with where the robot really starts. */
export function chainEvalStart(
  spec: RobotSpec,
  pos: Vec2,
  headingDeg: number,
): ChainStartLegality {
  const { ex, ey } = chainStartExtents(spec, headingDeg);
  const EPS = 0.01;
  const inRange = (v: number, e: number): boolean =>
    CHAIN_HALF_X - CHAIN_LAB + e <= CHAIN_HALF_X - e &&
    v >= CHAIN_HALF_X - CHAIN_LAB + e - EPS &&
    v <= CHAIN_HALF_X - e + EPS;
  const inLab = inRange(pos.x, ex) && inRange(Math.abs(pos.y), ey);
  const h = CHAIN_RINGSTAND_BOX / 2;
  let clearOfStand = true;
  for (const b of ringStandBoxes()) {
    if (Math.abs(pos.x - b.x) < h + ex - EPS && Math.abs(pos.y - b.y) < h + ey - EPS) {
      clearOfStand = false;
    }
  }
  return {
    ex,
    ey,
    inLab,
    clearOfStand,
    onStand: onRingStand(pos),
    headingFits: chainHeadingFits(spec, headingDeg),
    legal: chainStartLegal(spec, pos, headingDeg),
  };
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
