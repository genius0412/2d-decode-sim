import type { Alliance, Artifact, RobotCommand, RobotState, Vec2, World } from '../types';
import * as C from '../config';
import { classifierRect, footprintExtents, goalFaceNormal, goalLineValue, viewAngleOf, type Rect } from './field';
import { dot, rot, clamp, hyp, datan2 } from '../math';
import { activeDrive, driveParams } from './drivetrain';

const ALLIANCES: Alliance[] = ['red', 'blue'];

// ------------------------------------------------------------------ OBB ----

/** collision extents in the robot frame: the intake is a physical part of
 * the robot, so the footprint extends forward by its reach */
export function robotExtents(r: RobotState): { front: number; rear: number; half: number } {
  return footprintExtents(r.spec);
}

/**
 * World-space corners of the robot's FOOTPRINT — the chassis plus whatever the intake sticks
 * out front. `robotCorners` is the CHASSIS only, which is right for anything about the body
 * and wrong for asking what the robot is touching: Rapier collides on the footprint, so a
 * robot pressing a structure with its intake is in contact with it while no chassis corner is
 * anywhere near. Measured against the gate handle: the chassis's front-most corner stopped
 * 0.5in short of the stub the robot was leaning on, so every chassis-corner contact test said
 * "not touching" and no torque was ever applied — "if I push on the gate all the way and keep
 * holding, it should apply torque to the robot but it doesn't".
 */
export function footprintCornersOf(r: RobotState): Vec2[] {
  const e = robotExtents(r);
  return [
    { x: e.front, y: e.half },
    { x: e.front, y: -e.half },
    { x: -e.rear, y: -e.half },
    { x: -e.rear, y: e.half },
  ].map((c) => {
    const w = rot(c, r.heading);
    return { x: r.pos.x + w.x, y: r.pos.y + w.y };
  });
}

/** local (robot-frame) storage position of the held ball at `slot` (slot 0 = oldest,
 * fired first) given how many balls (`count`) the robot currently holds. Sloped/
 * vector queue them in a line near the mouth; triangle stores 1 deep + 2 near the
 * mouth — and with only 2 balls the front one CENTERS in the 2-wide space, then
 * slides aside when the 3rd arrives (positionHeldBalls tweens between these). */
export function heldSlotPos(spec: RobotState['spec'], slot: number, side: number): Vec2 {
  const hl = spec.length / 2;
  if (spec.intake === 'triangle') {
    // 1 deep + a 2-wide front row; a front ball sits on `side` (never dead center,
    // which would block a 3rd) — a 3rd entering that side pushes it to the other
    if (slot <= 0) return { x: hl - 4, y: 0 }; // deep (loaded first)
    return { x: hl + 2, y: (side || -1) * 2.7 };
  }
  const xs = [hl - 8, hl - 3, hl + 2];
  return { x: xs[Math.min(Math.max(slot, 0), 2)], y: 0 };
}

export function robotCorners(r: RobotState): Vec2[] {
  const e = robotExtents(r);
  const local = [
    { x: e.front, y: e.half },
    { x: e.front, y: -e.half },
    { x: -e.rear, y: -e.half },
    { x: -e.rear, y: e.half },
  ];
  return local.map((p) => {
    const w = rot(p, r.heading);
    return { x: w.x + r.pos.x, y: w.y + r.pos.y };
  });
}

/** the four wheel ground-contact points (wheel centers), inset INSIDE the
 * chassis — no intake or turret overhang. Base parking counts ONLY these:
 * what touches the floor is what's "in" the zone. */
export function wheelContacts(r: RobotState): Vec2[] {
  const ix = Math.max(r.spec.length / 2 - C.WHEEL_INSET, 1);
  const iy = Math.max(r.spec.width / 2 - C.WHEEL_INSET, 1);
  const local = [
    { x: ix, y: iy },
    { x: ix, y: -iy },
    { x: -ix, y: -iy },
    { x: -ix, y: iy },
  ];
  return local.map((p) => {
    const w = rot(p, r.heading);
    return { x: w.x + r.pos.x, y: w.y + r.pos.y };
  });
}

/** closest point on the robot's OBB (incl. intake) to a world point */
export function closestPointOnRobot(r: RobotState, p: Vec2): Vec2 {
  const e = robotExtents(r);
  const local = rot({ x: p.x - r.pos.x, y: p.y - r.pos.y }, -r.heading);
  const cx = clamp(local.x, -e.rear, e.front);
  const cy = clamp(local.y, -e.half, e.half);
  const w = rot({ x: cx, y: cy }, r.heading);
  return { x: w.x + r.pos.x, y: w.y + r.pos.y };
}

/** SAT intersection test between the robot's OBB and an axis-aligned rect */
export function robotIntersectsRect(r: RobotState, rect: Rect): boolean {
  const rc = robotCorners(r);
  const rectC = [
    { x: rect.x0, y: rect.y0 },
    { x: rect.x1, y: rect.y0 },
    { x: rect.x1, y: rect.y1 },
    { x: rect.x0, y: rect.y1 },
  ];
  const axes = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    rot({ x: 1, y: 0 }, r.heading),
    rot({ x: 0, y: 1 }, r.heading),
  ];
  for (const ax of axes) {
    let aMin = Infinity;
    let aMax = -Infinity;
    for (const c of rc) {
      const p = c.x * ax.x + c.y * ax.y;
      aMin = Math.min(aMin, p);
      aMax = Math.max(aMax, p);
    }
    let bMin = Infinity;
    let bMax = -Infinity;
    for (const c of rectC) {
      const p = c.x * ax.x + c.y * ax.y;
      bMin = Math.min(bMin, p);
      bMax = Math.max(bMax, p);
    }
    if (aMax < bMin || bMax < aMin) return false;
  }
  return true;
}

/** SAT overlap test between the robot's OBB (intake included) and an arbitrary
 * CONVEX polygon (e.g. a launch-zone triangle). Unlike a corner-in-polygon test,
 * this catches the robot covering a polygon vertex (the launch wedge's apex) with
 * every corner outside. Axes = the robot's two edge normals + each polygon edge
 * normal. */
export function robotIntersectsConvex(r: RobotState, poly: Vec2[]): boolean {
  const rc = robotCorners(r);
  const axes: Vec2[] = [rot({ x: 1, y: 0 }, r.heading), rot({ x: 0, y: 1 }, r.heading)];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    axes.push({ x: -(b.y - a.y), y: b.x - a.x }); // edge normal
  }
  for (const ax of axes) {
    let aMin = Infinity;
    let aMax = -Infinity;
    for (const c of rc) {
      const p = c.x * ax.x + c.y * ax.y;
      if (p < aMin) aMin = p;
      if (p > aMax) aMax = p;
    }
    let bMin = Infinity;
    let bMax = -Infinity;
    for (const c of poly) {
      const p = c.x * ax.x + c.y * ax.y;
      if (p < bMin) bMin = p;
      if (p > bMax) bMax = p;
    }
    if (aMax < bMin || bMax < aMin) return false; // separating axis ⇒ no overlap
  }
  return true;
}

/** velocity of a point rigidly attached to the robot */
export function robotPointVelocity(r: RobotState, p: Vec2): Vec2 {
  const rx = p.x - r.pos.x;
  const ry = p.y - r.pos.y;
  return { x: r.vel.x - r.angVel * ry, y: r.vel.y + r.angVel * rx };
}

// ------------------------------------------------- robot vs static field ----

/** rigid-contact response: push the robot out along the normal AND apply the
 * summed contact torque, so driving tilted into a wall squares the chassis
 * up flush against it. Torque sums over all touching corners — a flush face
 * has symmetric contacts that cancel, so it is stable. */
function pushRobotAt(
  r: RobotState,
  nx: number,
  ny: number,
  depth: number,
  contacts: { c: Vec2; d: number }[],
  // squaring against a flat face caps rotation at the remaining tilt; point
  // contacts (a pinned ball) instead pivot the chassis freely
  squareTo = true,
): void {
  r.pos.x += nx * depth;
  r.pos.y += ny * depth;
  const vn = r.vel.x * nx + r.vel.y * ny;
  // how hard the robot is driving into the contact (in/s), before the kill
  const press = vn < 0 ? -vn : 0;
  if (vn < 0) {
    r.vel.x -= nx * vn;
    r.vel.y -= ny * vn;
  }
  applyContactTorque(r, nx, ny, press, contacts, squareTo);
}

/** the contact-torque response shared by wall and robot-robot contacts:
 * pushing harder squares up faster (pressure-scaled), the correction never
 * steps past flush, and fast off-axis hits convert speed into visible spin */
/**
 * ONE SURFACE'S CONTRIBUTION, computed and returned rather than written.
 *
 * Surfaces used to each write the heading as they were processed, which makes the result
 * PATH-DEPENDENT: the classifier would rotate the chassis and the gate arm would then work out
 * its own contact geometry against a robot the classifier had already turned. In the corner
 * where the two meet — which is exactly where a driver works the gate — that reads as the
 * collision being erratic, because it is: sweeping the approach across the arm in 1.5in steps
 * gave turns of 2, 0, -9, 0, -7, -17 degrees on the side the classifier is on, against a
 * smooth -6..-8 on the side where the arm answers alone.
 *
 * So each surface returns what it wants, `squareUpStatics` sums them, and the chassis is
 * turned once. Same physics, one answer.
 */
function contactTorqueDelta(
  r: RobotState,
  nx: number,
  ny: number,
  press: number,
  contacts: { c: Vec2; d: number }[],
  squareTo: boolean,
  /**
   * How fast this surface is allowed to turn the robot, against a wall's rate.
   *
   * A wall is the field and squares you at its own pace. The GATE ARM is a hinged bar with a
   * spring's worth of authority, and at the wall's rate it whipped a robot from 20 degrees to
   * flush in 167ms — "the gate applies way too much torque way too fast". Scaling the rate is
   * the honest dial: the direction and the flush cap are geometry and stay exactly as they
   * are, only how quickly it gets there changes.
   */
  rateMult = 1,
  /**
   * Whether this surface's heuristic `spin` flick applies at all.
   *
   * ROBOT-ROBOT passes 0, because a robot pair now takes its rotation from the real two-body
   * point impulse in `squareUpPair` instead — moment arm, both shove masses, both rotational
   * inertias, and a Coulomb friction term. Running both would count one collision twice, and
   * the flick is the half that cannot describe a VICTIM: it scales with the robot's OWN
   * press, so a robot that is not driving gets nothing, which is exactly the case that
   * matters when somebody corners you.
   *
   * Every STATIC surface keeps it at 1. The flick is tuned against the walls, the goal faces
   * and the classifier, its ceilings are pinned by smoke checks, and a full physical rewrite
   * of the static path was tried once and reverted (small angles rocked ±9 degrees).
   */
  spinMult = 1,
): { align: number; spin: number; bleed: boolean; flushErr: number } {
  /**
   * LOAD IS SHARED BY COMPRESSION, and a corner that is not bearing carries none of it.
   *
   * The weight used to be `depth + CONTACT_BIAS`, and that floor is a vote for corners that
   * are not touching: the contact list is everything within CONTACT_TOUCH_EPS of the surface,
   * so a corner half an inch clear still counted. Because the two front corners have
   * different lever arms once the chassis is tilted (the intake extends the front, so they
   * are not mirror images), a floor-weighted vote from the corner that is NOT touching can
   * outweigh the one that is — and the torque comes out the wrong way round. "It's turning me
   * the other way sometimes."
   *
   * Bumpers are compliant, so the honest share is how far each corner is compressed relative
   * to the deepest one: full load at the deepest, nothing beyond CONTACT_COMPLIANCE of it.
   * Square on, all the bearing corners compress equally, their moments cancel, and the robot
   * settles — which is the same equilibrium as before, reached for a reason.
   */
  let dMax = -Infinity;
  for (const { d } of contacts) dMax = Math.max(dMax, d);
  let torque = 0;
  for (const { c, d } of contacts) {
    const load = Math.max(0, Math.min(d, 2) - (Math.min(dMax, 2) - C.CONTACT_COMPLIANCE));
    if (load <= 0) continue;
    const lx = c.x - r.pos.x;
    const ly = c.y - r.pos.y;
    const lever = hyp(lx, ly);
    if (lever < 1e-6) continue;
    torque += ((lx * ny - ly * nx) / lever) * load;
  }
  /**
   * NO LOAD, NO TORQUE. A surface turns a robot because the robot is pressing on it; a robot
   * that is merely TOUCHING one has nothing pushing it round.
   *
   * The gain used to be `1 + press * CONTACT_PRESS_GAIN` — a floor of 1, which means a
   * geometric `torque` alone rotates the chassis at zero press. Against a face it hides,
   * because the flush cap stops it as soon as the robot is square; against the gate handle,
   * which is a point and has no flush to stop at, a robot parked beside it turned 359.6
   * degrees on its own: "torque is being applied with me not doing anything."
   */
  const gain = press * C.CONTACT_PRESS_GAIN;
  const none = { align: 0, spin: 0, bleed: false, flushErr: Infinity };
  if (gain <= 0) return none;
  const rate = Math.min(C.CONTACT_ALIGN_RATE * gain, C.CONTACT_ALIGN_RATE_MAX) * rateMult;
  // never step PAST flush: cap the correction at the remaining tilt (the
  // chassis is square, so flush poses repeat every 90°). Without this cap the
  // torque bias overshoots each tick and the heading buzzes at the wall.
  let flushErr = Infinity;
  let relSigned = 0;
  if (squareTo) {
    const q = Math.PI / 2;
    let rel = r.heading - datan2(ny, nx);
    rel -= Math.round(rel / q) * q;
    relSigned = rel;
    flushErr = Math.abs(rel);
  }
  const cap = Math.min(rate, flushErr);
  let align = clamp(torque * 0.1 * gain * rateMult, -cap, cap);
  /**
   * A SETTLING RESPONSE SETTLES. It may reduce the tilt against a FACE and may not add to it —
   * adding to it is what a collision does, and that is the impulse, which is free to.
   *
   * Near flush the contact levers nearly cancel and what is left is small and noisy. When the
   * noise came out the wrong way the alignment ran with it, and because the cap is the
   * remaining tilt, every wrong step licensed a bigger one: measured, 3 degrees off square
   * into a wall at speed ended 13 degrees off, the wrong side.
   */
  if (squareTo && align * relSigned > 0) align = 0;
  /**
   * The impulse a collision hands the chassis. Unlike the alignment it is angular VELOCITY, so
   * it is not capped at the remaining tilt — a hard hit keeps turning you after the contact
   * has done its work, which is what "even if I hit it with a large impact it doesn't turn me"
   * was asking for. It is guarded against the TILT and not against `align`, because comparing
   * it to `align` passes trivially whenever `align` has been zeroed for pointing the wrong way
   * — exactly when the guard is needed.
   */
  const spinRaw = torque * press * C.CONTACT_IMPACT_SPIN * rateMult * spinMult;
  const spin = !squareTo || spinRaw * relSigned <= 0 ? spinRaw : 0;
  return { align, spin, bleed: r.angVel * align < 0, flushErr };
}

/**
 * ...and the writer for surfaces that answer alone (robot-robot, and the pre-solve constrain
 * path). Multi-surface cases go through `squareUpStatics`, which sums first — see
 * `contactTorqueDelta`.
 */
function applyContactTorque(
  r: RobotState,
  nx: number,
  ny: number,
  press: number,
  contacts: { c: Vec2; d: number }[],
  squareTo: boolean,
  rateMult = 1,
): void {
  const d = contactTorqueDelta(r, nx, ny, press, contacts, squareTo, rateMult);
  applyTurn(r, d);
}

/** turn the chassis by a summed contact response */
function applyTurn(
  r: RobotState,
  d: { align: number; spin: number; bleed: boolean; flushErr: number },
): void {
  if (d.align === 0 && d.spin === 0) return;
  const maxTurn = driveParams(r.spec).maxTurn;
  r.heading += d.align;
  if (d.bleed) {
    // bleed angular velocity that fights the contact — a surface being pressed does not let
    // the chassis keep spinning into it
    r.angVel *= 0.9;
  } else if (d.spin !== 0) {
    r.angVel = clamp(r.angVel + d.spin, -maxTurn, maxTurn);
  }
}

/** how deep a world point sits inside the robot's OBB (incl. intake);
 * negative = outside */
/**
 * Signed depth of a point inside the robot's CHASSIS only — the intake reach excluded.
 *
 * `pointDepthInRobot` uses `robotExtents`, which grows the box forward by the intake's
 * reach. That is the right box for robot-vs-world collision, and the wrong one for asking
 * "is an artifact inside this robot": the mouth is open to artifacts by design (product
 * decision #10) and the artifact solve already builds its chassis collider from
 * length/width for the same reason. Matches that collider exactly.
 */
export function pointDepthInChassis(r: RobotState, p: Vec2): number {
  const local = rot({ x: p.x - r.pos.x, y: p.y - r.pos.y }, -r.heading);
  const hl = r.spec.length / 2;
  const hw = r.spec.width / 2;
  return Math.min(Math.min(local.x + hl, hl - local.x), Math.min(local.y + hw, hw - local.y));
}

/** the four corners of the CHASSIS box (no intake reach) — see `pointDepthInChassis` */
export function chassisCorners(r: RobotState): Vec2[] {
  const hl = r.spec.length / 2;
  const hw = r.spec.width / 2;
  return [
    { x: hl, y: hw },
    { x: hl, y: -hw },
    { x: -hl, y: -hw },
    { x: -hl, y: hw },
  ].map((p) => {
    const w = rot(p, r.heading);
    return { x: r.pos.x + w.x, y: r.pos.y + w.y };
  });
}

export function pointDepthInRobot(r: RobotState, p: Vec2): number {
  const e = robotExtents(r);
  const local = rot({ x: p.x - r.pos.x, y: p.y - r.pos.y }, -r.heading);
  const dx = Math.min(local.x + e.rear, e.front - local.x);
  const dy = Math.min(local.y + e.half, e.half - local.y);
  return Math.min(dx, dy);
}

/** minimum-translation-vector to separate the robot OBB (intake included) from
 * an axis-aligned rect, oriented to push the robot AWAY from the rect. null if
 * already separated. SAT over the rect's axes + the robot's two axes. */

function mtvOf(
  corners: Vec2[],
  heading: number,
  rect: Rect,
  centre: Vec2,
): { nx: number; ny: number; depth: number } | null {
  const rc = [
    { x: rect.x0, y: rect.y0 },
    { x: rect.x1, y: rect.y0 },
    { x: rect.x1, y: rect.y1 },
    { x: rect.x0, y: rect.y1 },
  ];
  const axes = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    rot({ x: 1, y: 0 }, heading),
    rot({ x: 0, y: 1 }, heading),
  ];
  let minOv = Infinity;
  let ax = { x: 0, y: 0 };
  const found: { axis: Vec2; ov: number }[] = [];
  for (const axis of axes) {
    let aMin = Infinity;
    let aMax = -Infinity;
    for (const c of corners) {
      const p = c.x * axis.x + c.y * axis.y;
      if (p < aMin) aMin = p;
      if (p > aMax) aMax = p;
    }
    let bMin = Infinity;
    let bMax = -Infinity;
    for (const c of rc) {
      const p = c.x * axis.x + c.y * axis.y;
      if (p < bMin) bMin = p;
      if (p > bMax) bMax = p;
    }
    const ov = Math.min(aMax, bMax) - Math.max(aMin, bMin);
    if (ov <= 0) return null; // a separating axis exists ⇒ no overlap
    found.push({ axis, ov });
    if (ov < minOv) {
      minOv = ov;
      ax = axis;
    }
  }
  /**
   * ...AND AT A CORNER, TWO AXES ARE THE ANSWER AT ONCE.
   *
   * SAT picks the single least-overlapping axis, which is exactly right in the middle of a
   * face and ill-conditioned at a corner: there the two candidates are within numerical noise
   * of each other, so the normal — and with it which way a contact pushes and turns you —
   * flips between them as the shapes slide a fraction of an inch. That is a real property of
   * the algorithm, not of the geometry: the true contact normal at a corner is between the
   * two faces that meet there.
   *
   * So axes within CONTACT_NORMAL_BLEND of the minimum are summed, each weighted by how close
   * it is to being the answer. Away from a corner the second axis carries no weight and this
   * is plain SAT; at one it hands back the diagonal, continuously, which is what a corner
   * actually pushes along.
   */
  const cx = (rect.x0 + rect.x1) / 2;
  const cy = (rect.y0 + rect.y1) / 2;
  const out = (a: Vec2) =>
    (centre.x - cx) * a.x + (centre.y - cy) * a.y < 0 ? { x: -a.x, y: -a.y } : a;
  let bx = 0;
  let by = 0;
  for (const { axis, ov } of found) {
    const w = 1 - (ov - minOv) / C.CONTACT_NORMAL_BLEND;
    if (w <= 0) continue;
    const o = out(axis);
    bx += o.x * w;
    by += o.y * w;
  }
  const bl = hyp(bx, by);
  if (bl > 1e-9) return { nx: bx / bl, ny: by / bl, depth: minOv };
  const o = out(ax);
  return { nx: o.x, ny: o.y, depth: minOv };
}


/** SAT overlap of the robot's CHASSIS with a rect */
function classifierMTV(r: RobotState, rect: Rect): { nx: number; ny: number; depth: number } | null {
  return mtvOf(robotCorners(r), r.heading, rect, r.pos);
}

// ------------------------------------------- square-up (Rapier robot slice) --
// Rapier (physicsEngine.ts) now owns robot translation + velocity: wall/robot
// pushout, velocity-kill, mass-weighted shoving. These run AFTER the Rapier
// solve and add ONLY the bespoke pieces Rapier isn't: the contact-torque "square
// up flush" nudge (rotation) and the robot-robot contact record for penalties.

/** how hard the robot was driving INTO a contact (in/s), from its PRE-solve
 * velocity — scales the square-up torque (a fast hit swings hard; a settled
 * chassis barely turns) */
/**
 * How hard the robot is driving INTO the surface, in in/s of refused approach.
 *
 * Deliberately the pre-solve APPROACH, not the momentum the solve took out. The delivered-push
 * reading was tried and it is zero exactly when it is needed: once a robot is resting on a
 * wall its velocity into the wall is already gone before this pass runs, so the settling
 * torque vanishes and a robot leaning at an angle stays there. What this measures is the load
 * the drive is holding against the surface, which is what presses a chassis flat.
 */
function pressAlong(preVel: Vec2 | undefined, nx: number, ny: number): number {
  if (!preVel) return 0;
  const vn = preVel.x * nx + preVel.y * ny; // >0 = moving along the push (outward)
  return vn < 0 ? -vn : 0; // driving IN
}

/**
 * ...AND THE LOAD SOMEBODY ELSE IS PUTTING THROUGH YOU INTO IT.
 *
 * `pressAlong` reads the robot's OWN drive, which is the whole story for a robot leaning on a
 * wall of its own accord and none of it for one held there by an opponent. Measured: a 42 lb
 * tank rams an idle robot into the field corner and the victim sits at the 22.9-degree tilt it
 * arrived with for four seconds — it never squares up, because by its own reckoning nothing is
 * pressing on it.
 *
 * `ext` is the push a robot is receiving from robot-robot contacts this tick, summed as a
 * vector in the same units `pressAlong` returns (in/s of refused approach per tick). Its
 * component pointing INTO this surface (the −n direction; `n` is the way the surface pushes
 * the robot out) is load the surface must hold, and the chassis flattens against it just as it
 * would under its own drive.
 *
 * MAX, not sum. Physically the two loads add, but the alignment rate saturates at roughly
 * 4.2 in/s of press and a robot driving into something re-injects about that much every tick,
 * so summing changes nothing there — while the uncapped `spin` flick would double on a robot
 * that is both driving and being shoved. Taking the larger of the two sources is the honest
 * reading of "what is holding this chassis against the surface" without that risk.
 */
function pressOn(preVel: Vec2 | undefined, ext: Vec2 | undefined, nx: number, ny: number): number {
  const own = pressAlong(preVel, nx, ny);
  if (!ext) return own;
  const into = -(ext.x * nx + ext.y * ny);
  return into > own ? into : own;
}

/**
 * ONE TICK'S CONTACT RESPONSE FOR THE WHOLE FIELD, collected before any of it is written.
 *
 * `deltas` are the settling contributions (`sumTurn` folds them), `dw` is angular velocity
 * from real collision impulses, and `ext` is the robot-robot push each chassis is carrying,
 * which the static surfaces then read through `pressOn`.
 *
 * IT EXISTS BECAUSE THE PAIRS USED TO WRITE FIRST. `squareUpRobots` ran every robot-robot pair
 * to completion — rotating both chassis — and only then asked the walls, the goal faces, the
 * classifier and the gate arm what they thought, so those surfaces worked out their contact
 * geometry against a robot an opponent had already turned. That is exactly the path-dependence
 * `sumTurn` was written to kill for the statics, with the robot-robot half left outside it; in
 * a three-robot pile it also meant the answer depended on which robot held which id (measured:
 * the same geometry with the ids permuted landed ~1in and ~1.2 degrees apart).
 *
 * Now every surface and every pair reads the SAME pose — the one the Rapier solve left — and
 * the writes happen once per robot at the end.
 */
type ContactAcc = {
  deltas: Map<number, TurnDelta[]>;
  ext: Map<number, Vec2>;
};

function newAcc(): ContactAcc {
  return { deltas: new Map(), ext: new Map() };
}

/** this robot's delta list, created on demand — the static pass appends to the same array
 * the pair pass filled, so one `sumTurn` sees every surface touching this chassis. */
function accList(acc: ContactAcc, id: number): TurnDelta[] {
  let list = acc.deltas.get(id);
  if (!list) {
    list = [];
    acc.deltas.set(id, list);
  }
  return list;
}

function accPush(acc: ContactAcc, id: number, nx: number, ny: number, press: number): void {
  const v = acc.ext.get(id);
  if (v) {
    v.x += nx * press;
    v.y += ny * press;
  } else {
    acc.ext.set(id, { x: nx * press, y: ny * press });
  }
}

/**
 * Write one robot's accumulated contact response: the collision impulses first, then the
 * settling nudge, mirroring the order `squareUpStatics` already uses for the gate handle.
 *
 * The impulse turns the CHASSIS by `dw · dt` as well as adding to `angVel`, because the
 * drivetrain owns `angVel` and `motorStep` pulls it back toward the commanded turn at
 * turnAccel — hundreds of rad/s² — which erases anything a contact injects before the next
 * tick's heading integration ever sees it. Setting `angVel` alone is a rotation that never
 * happens. So the hit turns you now and the wheels fight what is left, which is the real pair.
 *
 * `angVel` stays clamped to the robot's own `maxTurn`: it is a generous ceiling (≈487°/s on
 * the default chassis) that only a violent hit reaches, and the wall checks pin the peak a
 * contact may produce.
 */
function applyAcc(world: World, acc: ContactAcc): void {
  for (const r of world.robots) {
    // a robot on an auto path has its pose written by the path, not by contact
    if (!r.autoPathActive) {
      const deltas = acc.deltas.get(r.id);
      if (deltas) sumTurn(r, deltas);
    }
    /**
     * ...AND THE STEP ENDS WITH NOBODY MOVING FASTER THAN A ROBOT CAN.
     *
     * The same solver-explosion guard `solveRobots` applies on write-back, repeated here so it
     * holds for the WHOLE robot phase rather than for one pass of it. The bespoke passes add
     * velocity too — the gate handle resolves a point impulse straight onto `r.vel` — so a
     * robot crushed against structure could still leave this function at 812 in/s after the
     * solve had been bounded. Dead code in ordinary play; if it ever binds there, something
     * upstream is wrong.
     */
    const speed = hyp(r.vel.x, r.vel.y);
    if (speed > C.PHYS_MAX_ROBOT_SPEED) {
      r.vel.x *= C.PHYS_MAX_ROBOT_SPEED / speed;
      r.vel.y *= C.PHYS_MAX_ROBOT_SPEED / speed;
    }
  }
}

/** torque-only static square-up: Rapier already resolved translation, so this
 * only rotates a tilted chassis flush against walls / goal faces / classifier
 * structures it is resting on. Detection mirrors constrainRobot; `preVel` gives
 * the drive-in pressure the torque scales with. */
/** square a tilted chassis flush against the four perimeter walls at ±halfX / ±halfY.
 * Shared by DECODE (`squareUpStatics`) and Chain Reaction (`squareUpRobotsWalls`) — the
 * wall-alignment torque that makes a robot driving into a wall settle parallel to it. */
type TurnDelta = { align: number; spin: number; bleed: boolean; flushErr: number };

/**
 * SUM THE SURFACES, THEN TURN ONCE.
 *
 * Every surface a robot is touching this tick contributes its own answer, and they are added
 * before anything is written. Writing them one at a time makes the result path-dependent — the
 * classifier turns the chassis and the gate arm then works out its contact geometry against a
 * robot the classifier has already moved — and in the corner where the two meet, which is
 * exactly where a driver works the gate, that reads as the collision being erratic. It was:
 * sweeping the approach across the arm in 1.5in steps gave 2, 0, -9, 0, -7, -17 degrees on the
 * side the classifier is on, against a smooth -6..-8 where the arm answers alone.
 *
 * The alignment sums (two surfaces both squaring you agree, and a face fighting a stub nets
 * out), and the flush cap that survives is the TIGHTEST one any FACE in the set imposes —
 * because rotating past any of them would be rotating into it.
 */
function sumTurn(r: RobotState, deltas: TurnDelta[]): void {
  if (deltas.length === 0) return;
  let align = 0;
  let spin = 0;
  let bleed = false;
  let cap = Infinity;
  for (const d of deltas) {
    align += d.align;
    spin += d.spin;
    if (d.bleed) bleed = true;
    if (d.flushErr < cap) cap = d.flushErr;
  }
  applyTurn(r, { align: clamp(align, -cap, cap), spin, bleed, flushErr: cap });
}

function squareUpWalls(
  r: RobotState,
  preVel: Vec2 | undefined,
  halfX: number,
  halfY: number,
  out: TurnDelta[],
  ext: Vec2 | undefined,
): void {
  const eps = C.CONTACT_TOUCH_EPS;
  const corners = robotCorners(r);
  const walls: [number, number, (c: Vec2) => number][] = [
    [-1, 0, (c) => c.x - halfX],
    [1, 0, (c) => -halfX - c.x],
    [0, -1, (c) => c.y - halfY],
    [0, 1, (c) => -halfY - c.y],
  ];
  for (const [nx, ny, depthOf] of walls) {
    const contacts: { c: Vec2; d: number }[] = [];
    for (const c of corners) {
      const d = depthOf(c);
      if (d > -eps) contacts.push({ c, d: Math.max(d, 0) });
    }
    if (contacts.length > 0) out.push(contactTorqueDelta(r, nx, ny, pressOn(preVel, ext, nx, ny), contacts, true));
  }
}

function squareUpStatics(
  r: RobotState,
  preVel: Vec2 | undefined,
  out: TurnDelta[],
  ext: Vec2 | undefined,
): void {
  const eps = C.CONTACT_TOUCH_EPS;
  squareUpWalls(r, preVel, C.FIELD_HALF, C.FIELD_HALF, out, ext);
  const corners = robotCorners(r);

  for (const a of ALLIANCES) {
    const contacts: { c: Vec2; d: number }[] = [];
    for (const c of corners) {
      const d = goalLineValue(c, a);
      if (d > -eps) contacts.push({ c, d: Math.max(d, 0) });
    }
    if (contacts.length > 0) {
      const n = goalFaceNormal(a);
      out.push(contactTorqueDelta(r, n.x, n.y, pressOn(preVel, ext, n.x, n.y), contacts, true));
    }
  }

  /**
   * THE GATE HANDLE IS RAPIER'S NOW — slice A.
   *
   * A hand-rolled point contact used to live here: the arm is a 2.5in hinged bar with no
   * flush to settle to, so the square-up model could not describe it and it was solved as a
   * textbook single-point impulse instead, writing `vel`, `heading` and `angVel` straight onto
   * the chassis. Every word of that reasoning still holds — it just is not ours to do. The arm
   * is a real collider in the solve (`buildGateArms`), the bodies rotate, and the same normal
   * and friction impulses now come out of the solver, including the J_t term that makes
   * catching the stub with your flank turn you INTO it.
   *
   * Leaving both in place was not subtle: a robot resting on the arm with the driver doing
   * nothing was spun a full 360°, because the bespoke half wrote the heading behind the
   * solver's back where the tyres' refusal could not see it.
   */

  for (const a of ALLIANCES) {
    const rect = classifierRect(a);
    const mtv = classifierMTV(r, rect);
    if (!mtv) continue;
      /**
       * THE NORMAL IS THE CLOSEST FEATURE'S, corner included — the same correction the gate
       * handle needed, for the same reason and in the same place.
       *
       * SAT hands back whichever of its candidate axes overlaps least, and near the END of the
       * channel that flips as the robot slides past the diagonal: the push direction, and with
       * it which way the chassis is turned, changes discontinuously over a fraction of an inch.
       * The gate is at that end, so this is the classifier half of "collision with the gate,
       * and the corner of the gate, is still very weird".
       */
      const cpx = clamp(r.pos.x, rect.x0, rect.x1);
      const cpy = clamp(r.pos.y, rect.y0, rect.y1);
      const dxo = r.pos.x - cpx;
      const dyo = r.pos.y - cpy;
      const offLen = hyp(dxo, dyo);
      const cn = offLen > 1e-6 ? { x: dxo / offLen, y: dyo / offLen } : { x: mtv.nx, y: mtv.ny };

    const wallDir = rect.x0 <= -C.FIELD_HALF + 0.01 ? -1 : 1;
    if (mtv.nx * wallDir > 0.5) continue;
    const contacts = robotCorners(r)
      .filter((c) => c.x > rect.x0 && c.x < rect.x1 && c.y > rect.y0 && c.y < rect.y1)
      .map((c) => ({ c, d: mtv.depth }));
    /**
     * SQUARE TO IT, always. A flat face aligns a chassis whether one corner is on it or two —
     * the alternative is `applyContactTorque`'s pivot mode, which has no flush cap, and a
     * robot pressing a corner on the classifier SPUN: measured across ten approach angles,
     * a full 360 at most of them and nothing at all at a few. "Even when I ram with the back
     * of the chassis where there is no intake, the robot only turns if I impact it at certain
     * specific angles, weird." The walls have always passed `true` here for the same reason.
     */
    if (contacts.length > 0)
      out.push(contactTorqueDelta(r, cn.x, cn.y, pressOn(preVel, ext, cn.x, cn.y), contacts, true));
  }
}

/**
 * ROBOT-ROBOT CONTACT: the record the penalty engine reads, the settling nudge, and the
 * rotation Rapier cannot produce.
 *
 * Rapier resolved the shove (translation + velocity) with rotations LOCKED, so a chassis
 * carries no angular response out of the solve at all. This supplies it, and it supplies the
 * ONE number both robots' responses are scaled by: the CLOSING velocity along the contact
 * normal.
 *
 * THE PRESS IS RELATIVE, AND IT USED NOT TO BE. Each robot's press was its own ABSOLUTE
 * velocity projected on the normal — a load reading that does not need the other robot to be
 * there at all. Two robots cruising side by side in contact, no relative motion and nothing
 * compressed, squared each other up at 0.45 rad/s; a pair actively SEPARATING (gap 14.7in to
 * 19.5in over half a second) still had the trailing one snapped from 11.46 degrees to flush.
 * A contact that is opening cannot carry a load, and `contactTorqueDelta`'s own rule is "no
 * load, no torque" — the rule was right, the input was wrong.
 *
 * `out` (rrContacts) is recorded BEFORE any of that, on geometric overlap alone. Every
 * protected-zone rule in both games reads it — G424/G425/G426/G427/G402/G422/G408 and CR's
 * G05/G06 — and touching an opponent in their loading zone is a foul whether or not either of
 * you is pressing.
 */
function squareUpPair(
  a: RobotState,
  b: RobotState,
  preVels: Map<number, Vec2>,
  out: { a: number; b: number }[],
  acc: ContactAcc,
): void {
  const ca = robotCorners(a);
  const cb = robotCorners(b);
  const axes = [
    rot({ x: 1, y: 0 }, a.heading),
    rot({ x: 0, y: 1 }, a.heading),
    rot({ x: 1, y: 0 }, b.heading),
    rot({ x: 0, y: 1 }, b.heading),
  ];
  let minPen = Infinity;
  const found: { axis: Vec2; ov: number }[] = [];
  for (const ax of axes) {
    let aMin = Infinity;
    let aMax = -Infinity;
    for (const c of ca) {
      const p = c.x * ax.x + c.y * ax.y;
      if (p < aMin) aMin = p;
      if (p > aMax) aMax = p;
    }
    let bMin = Infinity;
    let bMax = -Infinity;
    for (const c of cb) {
      const p = c.x * ax.x + c.y * ax.y;
      if (p < bMin) bMin = p;
      if (p > bMax) bMax = p;
    }
    const overlap = Math.min(aMax, bMax) - Math.max(aMin, bMin);
    if (overlap <= -C.CONTACT_TOUCH_EPS) return; // clearly separated
    found.push({ axis: ax, ov: overlap });
    if (overlap < minPen) minPen = overlap;
  }

  /**
   * THE NORMAL AT A CORNER IS BETWEEN THE TWO FACES THAT MEET THERE — the same correction
   * `mtvOf` already makes for the gate handle and the classifier, for the same reason.
   *
   * Plain SAT returns the single least-overlapping axis, which is right in the middle of a
   * face and ill-conditioned at a corner: two of the four candidates sit within numerical
   * noise of each other and the normal flips between them as the chassis slide a hair past
   * the diagonal. Corner-on-corner is most of what robot-robot contact IS, so axes within
   * CONTACT_NORMAL_BLEND of the minimum are summed, weighted by how close each is to being
   * the answer. Away from a corner the second axis carries no weight and this is plain SAT.
   */
  let bx = 0;
  let by = 0;
  for (const { axis, ov } of found) {
    const w = 1 - (ov - minPen) / C.CONTACT_NORMAL_BLEND;
    if (w <= 0) continue;
    const flip = (b.pos.x - a.pos.x) * axis.x + (b.pos.y - a.pos.y) * axis.y < 0 ? -1 : 1;
    bx += axis.x * flip * w;
    by += axis.y * flip * w;
  }
  const bl = hyp(bx, by);
  if (bl < 1e-9) return;
  const nx = bx / bl; // a -> b: the way the contact pushes b, and pushes a back along
  const ny = by / bl;

  out.push(a.id < b.id ? { a: a.id, b: b.id } : { a: b.id, b: a.id });

  /**
   * ...AND THAT IS NEARLY ALL THIS PASS DOES NOW — slice A.
   *
   * Everything else that used to live here was standing in for an angular response Rapier was
   * not allowed to give: the bodies were rotation-LOCKED, so an off-centre hit produced no yaw
   * at all and a two-body point impulse had to be hand-rolled, scaled by `CONTACT_PAIR_SPIN`
   * because taking only its rotation left out everything that relieves a sustained contact; a
   * settling nudge flattened a held pair toward flush; `CONTACT_SLIP_RELIEF` stopped that
   * settling term steering a pusher after its victim; and `capDrag` bounded a friction that an
   * imposed velocity had made unbounded in the first place.
   *
   * The bodies rotate now and the drive arrives as a force, so the solver produces all of it
   * out of the same normal and friction impulses — off-centre hits, flank drags, a held pair
   * bearing itself flush. Keeping the heuristics on top would double it, and measurably did:
   * with both running, an off-centre ram spun its victim 26.3 degrees where the old model gave
   * 12.6.
   *
   * TWO THINGS SURVIVE, because neither of them is a rotation:
   *   · `rrContacts`, recorded above on geometric overlap alone — every protected-zone rule in
   *     both games reads it, and touching an opponent in their zone is a foul whether or not
   *     anybody is pressing.
   *   · the transmitted PUSH below, which is how a robot held against a wall by an opponent
   *     feels that opponent's load in the STATIC pass (`pressOn`). Rapier resolves the contact
   *     but does not tell the bespoke wall aligner who is leaning on whom.
   */
  const pva = preVels.get(a.id) ?? a.vel;
  const pvb = preVels.get(b.id) ?? b.vel;
  const press = (pva.x - pvb.x) * nx + (pva.y - pvb.y) * ny; // > 0 = closing
  if (press <= 0) return; // touching but unloaded — nothing transmitted

  accPush(acc, a.id, -nx, -ny, press);
  accPush(acc, b.id, nx, ny, press);
}

/**
 * WHERE A ROBOT IS ASKING TO GO, in the WORLD frame, as a fraction of full stick.
 *
 * The same decode `updateRobot` does - tank reads its two side-drives, everything else the
 * stick, and a field-centric stick only has the camera undone - kept in ONE place because two
 * consumers now ask the question and a second copy would drift from the drive model. G422's
 * "attempting to move" normalizes this; `capDrag` uses its magnitude.
 */
export function driveIntent(r: RobotState, cmd: RobotCommand | undefined): Vec2 {
  if (!cmd) return { x: 0, y: 0 };
  const tank = activeDrive(r.spec, r.butterflyTank).p.saturation === 'tank';
  return !tank && r.fieldCentric
    ? rot({ x: cmd.driveX, y: cmd.driveY }, -viewAngleOf(r.alliance))
    : rot(
        tank
          ? { x: ((cmd.leftDrive ?? 0) + (cmd.rightDrive ?? 0)) / 2, y: 0 }
          : { x: cmd.driveY, y: -cmd.driveX },
        r.heading,
      );
}

/** every robot-robot pair, in a stable id order (determinism). Shared by both games. */
function squareUpPairs(world: World, preVels: Map<number, Vec2>, acc: ContactAcc): void {
  for (let i = 0; i < world.robots.length; i++) {
    for (let j = i + 1; j < world.robots.length; j++) {
      squareUpPair(world.robots[i], world.robots[j], preVels, world.rrContacts, acc);
    }
  }
}

/** post-Rapier pass: square a tilted chassis flush against the STATIC field (walls, goal
 * faces, the classifier), record robot-robot contacts (`rrContacts`) for the penalty engine,
 * and carry an opponent's push into the surface a robot is being held against. The angular
 * response to a COLLISION is the solver's now — see `squareUpPair`. `preVels` are the
 * pre-solve velocities, which is what says how hard each robot is driving in. */
export function squareUpRobots(world: World, preVels: Map<number, Vec2>): void {
  const acc = newAcc();
  squareUpPairs(world, preVels, acc);
  for (const r of world.robots) {
    // a robot on an AUTO PATH is posed by the path; the static pass has nothing to say
    if (r.autoPathActive) continue;
    squareUpStatics(r, preVels.get(r.id), accList(acc, r.id), acc.ext.get(r.id));
  }
  applyAcc(world, acc);
}

/** post-Rapier square-up for a game whose only statics are perimeter WALLS (Chain
 * Reaction). Same robot-robot pass as DECODE, but the static half aligns to the four walls
 * at ±halfX/±halfY only — no DECODE goal-face / classifier geometry. This is what makes a CR
 * robot settle flush when it drives into a wall. */
export function squareUpRobotsWalls(
  world: World,
  preVels: Map<number, Vec2>,
  halfX: number,
  halfY: number,
): void {
  const acc = newAcc();
  squareUpPairs(world, preVels, acc);
  for (const r of world.robots) {
    if (r.autoPathActive) continue; // the path owns the pose — see squareUpRobots
    squareUpWalls(r, preVels.get(r.id), halfX, halfY, accList(acc, r.id), acc.ext.get(r.id));
  }
  applyAcc(world, acc);
}

// ------------------------------------------------------------ ball steps ----

/** rolling friction + rest-snap for a ground ball, velocity ONLY. Rapier owns
 * the position integration + all contact now (unified solve), so this no longer
 * advances position — it just decays speed each tick before the solve reads the
 * ball's linvel (mirrors how updateRobot stopped integrating robot position). */
export function stepGroundBall(b: Artifact, dt: number): void {
  const speed = hyp(b.vel.x, b.vel.y);
  if (speed > 0) {
    const ns = speed - C.BALL_ROLL_FRICTION * dt;
    if (ns <= 0 || ns < C.BALL_REST_SPEED) {
      b.vel.x = 0;
      b.vel.y = 0;
    } else {
      const k = ns / speed;
      b.vel.x *= k;
      b.vel.y *= k;
    }
  }
}

/** hard field clamp for a ground ball after the Rapier solve: Rapier's soft
 * contacts allow ~0.2in penetration, but the containment invariant (a ball never
 * leaves the field / pokes through a goal face) is tolerance-tight, so snap the
 * position back onto the walls + goal faces. Position only — velocity was already
 * resolved by the solve. */
export function clampGroundBall(b: Artifact): void {
  const c = clampBallPosToStatics(b.pos);
  b.pos.x = c.x;
  b.pos.y = c.y;
}

export function stepFlightBall(b: Artifact, dt: number): void {
  b.pos.x += b.vel.x * dt;
  b.pos.y += b.vel.y * dt;
  b.z += b.vz * dt;
  b.vz -= C.GRAVITY * dt;
}

/** walls + goal faces for balls (ground and low flight) */
export function collideBallStatic(b: Artifact): void {
  const f = C.FIELD_HALF;
  const rr = C.BALL_RADIUS;
  if (b.pos.x > f - rr) {
    b.pos.x = f - rr;
    if (b.vel.x > 0) b.vel.x = -b.vel.x * C.BALL_WALL_RESTITUTION;
  } else if (b.pos.x < -f + rr) {
    b.pos.x = -f + rr;
    if (b.vel.x < 0) b.vel.x = -b.vel.x * C.BALL_WALL_RESTITUTION;
  }
  if (b.pos.y > f - rr) {
    b.pos.y = f - rr;
    if (b.vel.y > 0) b.vel.y = -b.vel.y * C.BALL_WALL_RESTITUTION;
  } else if (b.pos.y < -f + rr) {
    b.pos.y = -f + rr;
    if (b.vel.y < 0) b.vel.y = -b.vel.y * C.BALL_WALL_RESTITUTION;
  }
  // goal faces: solid below the opening lip
  if (b.z < C.GOAL_WALL_TOP) {
    for (const a of ALLIANCES) {
      const gv = goalLineValue(b.pos, a);
      const dist = gv; // perpendicular distance behind the face
      const pen = dist + rr;
      if (pen > 0 && dist < rr * 3) {
        const n = goalFaceNormal(a);
        b.pos.x += n.x * pen;
        b.pos.y += n.y * pen;
        const vn = dot(b.vel, n);
        if (vn < 0) {
          b.vel.x -= n.x * vn * (1 + C.BALL_WALL_RESTITUTION);
          b.vel.y -= n.y * vn * (1 + C.BALL_WALL_RESTITUTION);
        }
      }
    }
  }
}

export function collideBallBall(a: Artifact, b: Artifact): void {
  const dx = b.pos.x - a.pos.x;
  const dy = b.pos.y - a.pos.y;
  const d2 = dx * dx + dy * dy;
  const minD = C.BALL_RADIUS * 2;
  if (d2 >= minD * minD || d2 < 1e-9) return;
  const d = Math.sqrt(d2);
  const nx = dx / d;
  const ny = dy / d;
  const overlap = minD - d;
  a.pos.x -= (nx * overlap) / 2;
  a.pos.y -= (ny * overlap) / 2;
  b.pos.x += (nx * overlap) / 2;
  b.pos.y += (ny * overlap) / 2;
  const rvx = b.vel.x - a.vel.x;
  const rvy = b.vel.y - a.vel.y;
  const vn = rvx * nx + rvy * ny;
  if (vn < 0) {
    const j = (-(1 + C.BALL_BALL_RESTITUTION) * vn) / 2; // equal masses
    a.vel.x -= j * nx;
    a.vel.y -= j * ny;
    b.vel.x += j * nx;
    b.vel.y += j * ny;
  }
}

/**
 * POSITION-ONLY de-overlap of two ground artifacts — a constraint pass, not a collision.
 *
 * `collideBallBall` also applies an impulse, which is right when two artifacts MEET but
 * wrong as a cleanup pass: by then the overlap was created by something else moving a ball
 * (a robot's bumper, a wall clamp, the channel eviction), and answering that with an
 * impulse injects energy and makes a pinned clump jitter. Here the ONLY job is that no two
 * artifacts occupy the same space.
 */
export function separateBalls(a: Artifact, b: Artifact, tick = 0, scatter = false): void {
  const dx = b.pos.x - a.pos.x;
  const dy = b.pos.y - a.pos.y;
  const d2 = dx * dx + dy * dy;
  const minD = C.BALL_RADIUS * 2;
  if (d2 >= minD * minD) return;
  // EXACTLY coincident: two artifacts stacked dead centre have no separating direction to
  // read off their positions, and returning here is what lets a stack persist forever.
  // Push them apart along a deterministic axis instead (ids are stable and unique).
  if (d2 < 1e-9) {
    const s = a.id < b.id ? 1 : -1;
    a.pos.x -= s * C.BALL_RADIUS * 0.5;
    b.pos.x += s * C.BALL_RADIUS * 0.5;
    return;
  }
  const d = Math.sqrt(d2);
  /**
   * A CONTACT BETWEEN TWO SPHERES IS NEVER PERFECTLY CENTRAL.
   *
   * Two artifacts meeting on a foam tile touch at a point that is a little off the line
   * between their centres — the seams, the tile, the spin each is carrying — so real ones
   * scatter where these slid past each other in a tidy line. It matters most at the gate,
   * where the drain now leaves straight (no synthesised fan at the exit) and the spread has
   * to come from what the artifacts hit: measured, nine draining artifacts finished 3in apart
   * across the tunnel. "Add slightly more randomness to each collision between balls to make
   * them spread out more."
   *
   * Equal and opposite, so momentum is conserved, and DETERMINISTIC — a hash of the two ids
   * and the tick, not Math.random, because this runs inside the lockstep sim.
   */
   // ...ONCE PER TICK, not once per relaxation pass. The pass runs six times, and six kicks a
   // tick is not a contact, it is a vibration: measured, two overlapping artifacts flew 13.6in
   // apart and the pinned-artifact squeeze went from 15 reversals a second to 32.
  const t = Math.floor(tick * 60);
  if (!scatter) return separate();
  let h = (a.id * 73856093) ^ (b.id * 19349663) ^ (t * 83492791);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  /**
   * ...AND IN PROPORTION TO THE HIT. A flat kick applies the same shove to an artifact being
   * crept onto as to one arriving at 40 in/s, which is not an off-centre contact, it is a
   * vibration: it shoved artifacts through a 4.6in gap they do not fit through and set the
   * pinned-artifact squeeze ringing again. The offset scales with how hard the two actually
   * meet, so a pile being leaned on barely scatters and a drain hitting the pile in front of
   * the gate scatters properly.
   */
  const rvn = ((b.vel.x - a.vel.x) * dx + (b.vel.y - a.vel.y) * dy) / d;
  const closing = Math.min(Math.abs(rvn), C.BALL_CONTACT_SCATTER / C.BALL_CONTACT_SCATTER_FRAC);
  const jitter =
    (((h ^ (h >>> 16)) >>> 0) / 4294967296 - 0.5) * closing * C.BALL_CONTACT_SCATTER_FRAC;
  const tanx = -(dy / d) * jitter;
  const tany = (dx / d) * jitter;
  a.vel.x -= tanx;
  a.vel.y -= tany;
  b.vel.x += tanx;
  b.vel.y += tany;
  separate();
  return;
  function separate(): void {
  // a FRACTION of the overlap per pass — see BALL_SEPARATION_RELAX
  const push = ((minD - d) / 2) * C.BALL_SEPARATION_RELAX;
  const nx = (dx / d) * push;
  const ny = (dy / d) * push;
  a.pos.x -= nx;
  a.pos.y -= ny;
  b.pos.x += nx;
  b.pos.y += ny;
}
}

/** a HELD ball (stored in a robot's intake) is a solid immovable obstacle to an
 * incoming GROUND ball — so a full intake physically blocks the mouth: no more
 * can be funneled in past the balls already occupying it. Pushes the ground ball
 * only (the held ball is kinematic). */
export function collideBallHeld(b: Artifact, held: Artifact): void {
  const dx = b.pos.x - held.pos.x;
  const dy = b.pos.y - held.pos.y;
  const d2 = dx * dx + dy * dy;
  const minD = C.BALL_RADIUS * 2;
  if (d2 >= minD * minD || d2 < 1e-9) return;
  const d = Math.sqrt(d2);
  const nx = dx / d;
  const ny = dy / d;
  b.pos.x += nx * (minD - d);
  b.pos.y += ny * (minD - d);
  const vn = b.vel.x * nx + b.vel.y * ny;
  if (vn < 0) {
    b.vel.x -= nx * vn;
    b.vel.y -= ny * vn;
  }
}

/** push a point out of `rect` inflated by an artifact radius, the shallowest way that does
 * not put it outside the field (the classifier's outer edge IS the side wall, so the only
 * valid exits are into the field). Returns the point unchanged if it is already clear. */
function clampOutOfRect(p: Vec2, rect: Rect): Vec2 {
  const R = C.BALL_RADIUS;
  if (!(p.x > rect.x0 - R && p.x < rect.x1 + R && p.y > rect.y0 - R && p.y < rect.y1 + R)) {
    return p;
  }
  const lim = C.FIELD_HALF - R;
  const exits: [number, number, number][] = [
    [-1, 0, p.x - (rect.x0 - R)],
    [1, 0, rect.x1 + R - p.x],
    [0, -1, p.y - (rect.y0 - R)],
    [0, 1, rect.y1 + R - p.y],
  ];
  let best: [number, number, number] | null = null;
  for (const e of exits) {
    const qx = p.x + e[0] * e[2];
    const qy = p.y + e[1] * e[2];
    if (Math.abs(qx) > lim || Math.abs(qy) > lim) continue; // would leave the field
    if (!best || e[2] < best[2]) best = e;
  }
  if (!best) return p;
  return { x: p.x + best[0] * best[2], y: p.y + best[1] * best[2] };
}

/**
 * Position-only clamp against the solid field: where a pushed artifact is actually allowed
 * to end up. The difference between the requested and the clamped position is the part of a
 * push the field refused — which is how `ballRobotFeedback` decides an artifact is PINNED.
 *
 * THE CLASSIFIER CHANNEL BELONGS IN HERE, and its absence was a real bug. This knew only
 * the perimeter walls and the goal faces, so an artifact pressed against the classifier was
 * never seen as trapped: the robot never stalled on it, drove it into the channel, and the
 * separate `collideBallRect` eviction shoved it back out — 4.5in of oscillation per tick on
 * an artifact whose velocity was zero, for as long as the robot leaned on it. Disabling the
 * eviction proved it (the artifact simply stayed 0.8in inside the channel and the jitter
 * fell to 0.64in), and disabling the ball-ball separation changed nothing.
 *
 * With the channel here, the robot stalls on it exactly as it does on a wall, so nothing is
 * being driven in for the eviction to argue with. It also makes `clampGroundBall` enforce
 * the "artifacts never enter the classifier" invariant directly rather than leaving it all
 * to the eviction pass.
 */
export function clampBallPosToStatics(p: Vec2): Vec2 {
  const f = C.FIELD_HALF - C.BALL_RADIUS;
  let out = { x: clamp(p.x, -f, f), y: clamp(p.y, -f, f) };
  for (const a of ALLIANCES) {
    const dist = goalLineValue(out, a); // perpendicular distance behind the face
    const pen = dist + C.BALL_RADIUS;
    if (pen > 0 && dist < C.BALL_RADIUS * 3) {
      const n = goalFaceNormal(a);
      out.x += n.x * pen;
      out.y += n.y * pen;
    }
  }
  for (const a of ALLIANCES) out = clampOutOfRect(out, classifierRect(a));
  return out;
}

/** Ball↔robot contact (world frame) or null if not touching. FLAT-front intakes
 * (vector) + the chassis are a plain OBB. WEDGE intakes (sloped/triangle) have a
 * FUNNEL front — two side slopes from the front corners in to the throat, with an
 * OPEN mouth between them and NO flat front wall — so a ball is deflected toward
 * the center compliant wheels (at the chassis front) instead of stopping flat. */
function ballRobotContact(
  r: RobotState,
  p: Vec2,
): { nx: number; ny: number; pen: number; cp: Vec2 } | null {
  const R = C.BALL_RADIUS;
  const preset = C.INTAKE_PRESETS[r.spec.intake];
  const local = rot({ x: p.x - r.pos.x, y: p.y - r.pos.y }, -r.heading);
  const hl = r.spec.length / 2;
  const half = r.spec.width / 2;
  const toWorld = (nlx: number, nly: number, pen: number, clx: number, cly: number) => {
    const n = rot({ x: nlx, y: nly }, r.heading);
    const c = rot({ x: clx, y: cly }, r.heading);
    return { nx: n.x, ny: n.y, pen, cp: { x: c.x + r.pos.x, y: c.y + r.pos.y } };
  };

  const mouth = C.intakeMouth(r.spec); // vector's mouth spans the chassis width
  const mh = mouth.mouthHalf;
  const th = mouth.throatHalf;
  // The side structure (slopes / rails) is solid at ball height out to the full
  // reach — that's what stops a wide frame being entered off its flank. The CENTER
  // (under the wheels) is OPEN: the wheels ride high in z, so balls pass under them
  // (never pushed by a plate) and funnel/vector to the throat at the chassis front.
  const tip = hl + preset.reach;

  // ---- 1) chassis body [-hl, hl] × [-half, half] (shared) ----
  if (local.x <= hl) {
    const cx = clamp(local.x, -hl, hl);
    const cy = clamp(local.y, -half, half);
    const dx = local.x - cx;
    const dy = local.y - cy;
    if (dx !== 0 || dy !== 0) {
      const d2 = dx * dx + dy * dy;
      if (d2 >= R * R) return null;
      const d = Math.sqrt(d2);
      return toWorld(dx / d, dy / d, R - d, cx, cy);
    }
    // inside the chassis: eject through the nearest face
    const dl = local.x + hl, dr = hl - local.x, dt = half - local.y, db = half + local.y;
    const mm = Math.min(dl, dr, dt, db);
    if (mm === dr) return toWorld(1, 0, R + dr, hl, local.y);
    if (mm === dl) return toWorld(-1, 0, R + dl, -hl, local.y);
    if (mm === dt) return toWorld(0, 1, R + dt, local.x, half);
    return toWorld(0, -1, R + db, local.x, -half);
  }

  if (local.x > tip) return null; // past the roller front — nothing there at all


  /**
   * THE ROLLER BAND RIDES ABOVE THE BALLS. The floor-level structure of a funnel intake is
   * the WEDGE, and it ends at the roller's axle; forward of that there is only the roller
   * itself and the GATE OPENER blocks on its beam ends, both of which sit high in z. Balls
   * pass underneath, so this band is open to them — it is solid to walls, robots and the
   * gate lever (that is `footprintExtents`, unchanged), just not to artifacts.
   *
   * This only became visible when the roller grew to 72mm. At 1in deep the wedge covered
   * essentially the whole reach and the two agreed; now the wedge stops a roller-radius
   * short, and without this a ball sitting dead centre of the opener block was ejected
   * 4.2in by a plate that is not there at ball height.
   */
  const wedgeFront = tip - C.intakeRollerDia(r.spec) / 2;
  if (mouth.wedge && local.x > wedgeFront && Math.abs(local.y) > mh) return null;

  // ---- intake region hl < x <= tip ----
  const ay = Math.abs(local.y);
  const s = local.y >= 0 ? 1 : -1;

  if (mouth.wedge) {
    // FUNNEL (sloped/triangle): open mouth in the center, solid side SLOPES that
    // deflect balls in to the throat. No flat front.
    if (ay > half) {
      const pen = R - (ay - half); // flank side wall — no side intake
      return pen > 0 ? toWorld(0, s, pen, local.x, s * half) : null;
    }
    // The FUNNEL runs the full reach — narrowing it to the wedge's own depth is not needed
    // and costs guidance: it slowed the outermost sloped capture from 0.33s to 0.43s against
    // main. Only the OPENER's own footprint (beyond the wedge, outboard of the mouth) opens.
    const reach = tip - hl;
    const L = hyp(reach, mh - th);
    const nsx = (mh - th) / L;
    const nsy = (-s * reach) / L;
    const sd = (local.x - hl) * nsx + (local.y - s * th) * nsy;
    const penSlope = R - sd;
    const penFront = hl + R - local.x;
    let best: { nlx: number; nly: number; pen: number; clx: number; cly: number } | null = null;
    const consider = (nlx: number, nly: number, pen: number, clx: number, cly: number) => {
      if (pen > 0 && (!best || pen > best.pen)) best = { nlx, nly, pen, clx, cly };
    };
    consider(nsx, nsy, penSlope, local.x - nsx * sd, local.y - nsy * sd);
    consider(1, 0, penFront, hl, local.y);
    if (!best) return null;
    const bb = best as { nlx: number; nly: number; pen: number; clx: number; cly: number };
    return toWorld(bb.nlx, bb.nly, bb.pen, bb.clx, bb.cly);
  }

  // FLAT (vector): OPEN center notch |y| < mouthHalf — the wheels ride above it, so
  // balls pass UNDER and are never pushed by a plate. Where the frame is wider than
  // the wheels, solid side RAILS keep the notch from being entered off the flank.
  if (ay < mh) {
    const penFront = hl + R - local.x; // only the chassis front (throat) stops it
    return penFront > 0 ? toWorld(1, 0, penFront, hl, local.y) : null;
  }
  if (ay <= half) {
    // rail: an inner wall at the notch edge pushes balls back OUT (no flank entry)
    const penWall = R - (ay - mh);
    if (penWall > 0) return toWorld(0, s, penWall, local.x, s * mh);
    const dOuter = half - ay, dFront = tip - local.x, dBack = local.x - hl;
    const mm = Math.min(dOuter, dFront, dBack);
    if (mm === dOuter) return toWorld(0, s, R + dOuter, local.x, s * half);
    if (mm === dFront) return toWorld(1, 0, R + dFront, tip, local.y);
    return toWorld(-1, 0, R + dBack, hl, local.y);
  }
  /**
   * OUTBOARD OF THE FRAME, FORWARD: the flank does not stop at the chassis.
   *
   * This returned null — "beyond the frame width, forward → open" — and that left a gap
   * exactly one feature wide. The rail branch above treats |y| <= half as solid all the way
   * out to the roller line, so the union of chassis and intake has a straight SIDE running
   * from the back of the robot to the tip. An artifact just outboard of that side, and even
   * slightly ahead of the front face plane, met nothing at all: measured, driving through
   * loose artifacts, 2.33in of a 2.5in radius inside the front corner, and every worst case
   * in the sweep sat within a tenth of an inch of x = hl. "Balls go thru the chassis still."
   *
   * The answer is the SIDE, not the corner. Pushing off the chassis's corner is what a body
   * that ENDED at hl would do; this one continues, so the closest feature is the flank line
   * and the push is sideways — the same answer the funnel presets give one branch up, and
   * continuous with the chassis's own side face behind it. (Corner-first was tried and it
   * jitters: near hl the correction flips between a diagonal and the rail's sideways push
   * from tick to tick, 4.3in of hop in the pile-grinding case against 1.8 here.)
   */
  const penFlank = R - (ay - half);
  return penFlank > 0 ? toWorld(0, s, penFlank, local.x, s * half) : null;
}

/**
 * IS AN ARTIFACT WEDGED IN A ROBOT — the test the jam rule asks, over the whole of the robot
 * that is SOLID to artifacts.
 *
 * The jam rule ("nothing squeezes through a gap it does not fit in") asked
 * `pointDepthInChassis`, on the grounds that the intake's mouth is open by design and an
 * artifact being swallowed is deep inside that box on purpose. The mouth is; the intake is
 * not. Its side rails are solid out to the roller line, and when you are GATE INTAKING the
 * thing nearest the wall is exactly those rails — so artifacts squeezed between an intake
 * and the wall were never covered by the rule and walked straight through: measured, 5in
 * artifacts through gaps of 3.0, 3.5, 4.0 and 4.6in, at every heading. "I'm gate intaking and
 * they get thru the gap."
 *
 * So: the chassis, plus the intake's FLANK, and nothing in between the rollers. Outboard of
 * the frame is not somewhere an artifact can be, whatever else the mouth allows.
 */
export function ballWedgedInRobot(r: RobotState, p: Vec2): boolean {
  if (pointDepthInChassis(r, p) + C.BALL_RADIUS > C.BALL_JAM_SLOP) return true;
  const local = rot({ x: p.x - r.pos.x, y: p.y - r.pos.y }, -r.heading);
  const hl = r.spec.length / 2;
  const half = r.spec.width / 2;
  const tip = hl + C.INTAKE_PRESETS[r.spec.intake].reach;
  if (local.x <= hl || local.x > tip) return false;
  // ...and the MOUTH is not the intake. An artifact within the roller span is where an
  // artifact is supposed to be — freezing those froze every capture, and the drain with them.
  if (Math.abs(local.y) <= C.intakeMouth(r.spec).mouthHalf) return false;
  return C.BALL_RADIUS - (Math.abs(local.y) - half) > C.BALL_JAM_SLOP;
}

/** is `p` inside `rect` grown by `pad` — the test an artifact centre needs, since it is the
 * artifact's SKIN that has to clear a solid, not its centre. */
function inflatedRect(rect: Rect, pad: number, p: Vec2): boolean {
  return p.x > rect.x0 - pad && p.x < rect.x1 + pad && p.y > rect.y0 - pad && p.y < rect.y1 + pad;
}

/** push a ground ball out of a robot chassis, inheriting surface velocity.
 * A ball squeezed between the chassis and a wall is incompressible: the part
 * of the push the wall refuses transmits back onto the ROBOT (positional
 * pushback + normal velocity kill + contact torque), so the robot stalls
 * against a pinned ball instead of grinding it through. Off-center balls keep
 * the tangential part of the push and squirt out sideways. */
/**
 * POSITION-ONLY eviction of an artifact from a robot — the constraint half of
 * `collideBallRobot`, with none of its impulse, pin-feedback or push-drag work.
 *
 * That work is correct once per contact and wrong four times per tick, which is what the
 * final relaxation pass needs: it moves artifacts AFTER the robot solve has run, so it has
 * to be able to answer "is this artifact inside a chassis" without re-running the whole
 * collision response and double-charging the robot for the same shove.
 */
export function evictBallFromRobot(b: Artifact, r: RobotState): void {
  const contact = ballRobotContact(r, b.pos);
  if (!contact) return;
  const { nx, ny, pen } = contact;
  const want = { x: b.pos.x + nx * pen, y: b.pos.y + ny * pen };
  const c = clampBallPosToStatics(want);
  const rx0 = want.x - c.x;
  const ry0 = want.y - c.y;
  /**
   * A REFUSED PUSH IS REFUSED WHOLE — the leftover tangent is not a consolation prize.
   *
   * Taking the part the statics allowed looks like the conservative thing and it is how an
   * artifact gets WALKED along a wall: the chassis is at an angle, so the push into it has a
   * component along the wall, the wall keeps refusing the rest, and every tick moves the
   * artifact a little further down — through gaps it does not fit through. Measured: 4 of a
   * drain squeezed past a corner with 4.6in of clearance, on 5in artifacts.
   *
   * So either the artifact can be separated, or it cannot and stays where it is. When it
   * cannot, the only real way out is sideways, and that is the search below — which has to
   * find an actual exit before anything moves.
   */
  if (hyp(rx0, ry0) <= C.BALL_SETTLE_SLOP) {
    b.pos.x = c.x;
    b.pos.y = c.y;
  }
  /**
   * ...AND WHEN THE PUSH IS REFUSED, IT GOES OUT SIDEWAYS. An artifact between a chassis and
   * a wall is incompressible: something has to give, and the only direction left is ALONG the
   * wall.
   *
   * Without this the eviction simply loses: the wall clamp puts back whatever the normal push
   * gained and the artifact ends the tick still buried. Measured, a robot sliding along the
   * red wall past an artifact resting on it — 2.32in of a 2.5in radius inside the chassis,
   * with the artifact tracking the robot's own velocity, which is a robot driving THROUGH an
   * artifact. "Balls go thru the chassis still."
   *
   * The robot-stall path does not answer this one and should not: `ballRobotFeedback` stalls
   * a robot DRIVING INTO a pinned artifact, and a robot sliding PAST one is not driving into
   * anything — it would have to be stopped by an artifact it is only brushing. A real ball
   * squirts out of the gap instead, and that is what this does: the step is the part of the
   * push the statics refused, in whichever direction along the wall clears the chassis sooner,
   * so it is self-limiting (no refusal, no slide) and it converges over the relaxation passes
   * rather than teleporting anything.
   *
   * DAMPED by the same fraction the artifact-artifact separation uses, and for the same
   * reason: this runs once per relaxation pass, so a full correction per pass rings where a
   * partial one converges. A ceiling tied to the robot's own speed was tried on top of that —
   * the gap does close at the robot's speed, so it reads as the honest bound — and it is
   * simply too tight to matter: at 0.03in a pass an artifact 2in inside a chassis is still
   * inside it when the robot has driven away. The damping alone is what keeps this smooth,
   * and the pile-grinding jitter case is quieter with the ceiling gone than it was before any
   * of this (3 jump-frames, worst 1.56in, against 16 and 1.84 at the start of the session).
   */
  if ((globalThis as any).__noslide) return;
  const rx = rx0;
  const ry = ry0;
  const rl = hyp(rx, ry);
  if (rl < 1e-6) return; // the statics allowed the whole push — it is out
  const still = ballRobotContact(r, b.pos);
  if (!still || still.pen <= C.BALL_SETTLE_SLOP) return;
  /**
   * ONLY A CLOSING GAP SQUEEZES ANYTHING OUT.
   *
   * The slide is what a wedge does to what is caught in it, and a wedge that is not closing
   * does nothing at all. Without this the same code walks an artifact THROUGH a standing gap:
   * artifacts draining down the wall met a parked robot's corner, overlapped it by a hair
   * under their own momentum, and were then helpfully squirted past it — 4 of them through a
   * 4.6in opening, which a 5in artifact does not fit through however long it is pushed.
   *
   * So the question is whether the CHASSIS is moving into the artifact at this contact, which
   * is the surface velocity there and not the chassis's translation: the case this exists for
   * is a robot swinging a corner onto an artifact resting on a wall, and that closes the gap
   * with no translation whatsoever.
   */
  const pv = robotPointVelocity(r, b.pos);
  if (pv.x * nx + pv.y * ny <= 0) return;
  const tx = -ry / rl;
  const ty = rx / rl;
  /**
   * WHICH WAY OUT, AND IS THERE ONE AT ALL.
   *
   * An artifact squirts out of a wedge it is CAUGHT IN — a corner, a shallow pocket — and the
   * exit is a couple of inches away. It does not travel the length of a robot's flank: that
   * is not escaping a gap, it is being carried THROUGH one, and a 5in artifact does not pass
   * a 4.6in opening no matter how long you push it. So the exit is looked for within
   * BALL_ESCAPE_REACH and the slide only happens if one is found — which is the difference
   * between the two cases, since a mid-flank artifact's nearest clear spot is half a robot
   * away.
   */
  let exit = 0;
  let dirOut = 0;
  for (let d = C.BALL_ESCAPE_STEP; d <= C.BALL_ESCAPE_REACH && dirOut === 0; d += C.BALL_ESCAPE_STEP) {
    for (const dir of [1, -1]) {
      const q = { x: b.pos.x + tx * d * dir, y: b.pos.y + ty * d * dir };
      const p = clampBallPosToStatics(q);
      if (hyp(p.x - q.x, p.y - q.y) > C.BALL_SETTLE_SLOP) continue; // the statics refuse it too
      if (ALLIANCES.some((al) => inflatedRect(classifierRect(al), C.BALL_RADIUS, p))) continue;
      const hit = ballRobotContact(r, p);
      if (!hit || hit.pen <= C.BALL_SETTLE_SLOP) {
        exit = d;
        dirOut = dir;
        break;
      }
    }
  }
  if (dirOut === 0) return; // wedged with nowhere to go — it stays put and stays overlapping
  const step = Math.min(rl * C.BALL_SEPARATION_RELAX, exit) * dirOut;
  const q = { x: b.pos.x + tx * step, y: b.pos.y + ty * step };
  const p = clampBallPosToStatics(q);
  if (hyp(p.x - q.x, p.y - q.y) > C.BALL_SETTLE_SLOP) return;
  b.pos.x = p.x;
  b.pos.y = p.y;
}

/**
 * ROBOT-SIDE feedback from one artifact — the stall on a pinned artifact and the drag of
 * shoving a clump. Moves NOTHING; only `r.vel` changes.
 *
 * RUNS BEFORE `solveBalls`, and the order carries the whole design. Rapier's chassis body
 * is kinematic, so it cannot be told it is blocked: handed a robot still driving at a
 * dead-centre artifact trapped on a wall, the solver's only available answer is to squirt
 * the artifact out sideways — 34in along the wall with the robot sailing through at
 * 30 in/s. Stalling the robot FIRST means the solver is handed a robot that has already
 * stopped, and there is no squeeze left for it to answer wrongly.
 *
 * IS THE ARTIFACT ACTUALLY TRAPPED? — probed against THIS TICK'S PUSH, which is the whole
 * trick. Asking "could it move a full radius" calls an artifact pinned whenever a wall is
 * within 2.5in of it, so robots stalled on anything near a wall and stopped driving into
 * things at all: intake capture never fired, the gate drain stalled, foul counts collapsed
 * — nine checks, all from one over-wide probe. The physical question is narrower and it is
 * this: *can it move as far as I am about to push it?* That distance is the robot's own
 * approach in one tick, so a robot creeping up on a wall artifact is not stalled by it,
 * and a robot driving hard into a trapped one is.
 */
export function ballRobotFeedback(b: Artifact, r: RobotState, dt: number): void {
  const contact = ballRobotContact(r, b.pos);
  if (!contact) return;
  const { nx, ny, pen, cp } = contact;
  /**
   * THE SPEED THAT MATTERS IS THE SURFACE'S AT THE CONTACT, NOT THE CENTRE'S.
   *
   * This read `r.vel`, which is the chassis's translation and says nothing about the corner
   * that is actually arriving. A robot TURNING closes a gap with no translation at all, so a
   * chassis swinging its rear corner onto an artifact resting on a wall was neither stalled
   * nor drag-loaded by it — measured, an artifact left 2.19in inside the chassis, tracking
   * the robot's own velocity, wedged into a 2.81in gap it does not fit in. `pointVelocity`
   * is the same quantity the possession test and the lid carry already use.
   */
  const pv = robotPointVelocity(r, cp);
  const approach = pv.x * nx + pv.y * ny; // robot SURFACE speed INTO the artifact
  const probe = Math.max(pen, Math.max(0, approach) * dt);
  const px = b.pos.x + nx * probe;
  const py = b.pos.y + ny * probe;
  const pc = clampBallPosToStatics({ x: px, y: py });
  const bx = px - pc.x; // push refused by the field, pointing into the wall
  const by = py - pc.y;
  const blocked = hyp(bx, by);
  if (blocked > C.BALL_PIN_SLOP) {
    const inx = bx / blocked;
    const iny = by / blocked;
    // only the robot's OWN drive transmits through a pinned artifact — one arriving under
    // its own momentum (gate outflow) just stops against the chassis
    const drivingIn = pv.x * inx + pv.y * iny;
    if (drivingIn > C.BALL_PIN_PUSH_MIN_SPEED) {
      // depth is SEPARATION and stays the real overlap; the STALL is the velocity kill
      // inside pushRobotAt, which is what this call is actually for.
      pushRobotAt(r, -inx, -iny, Math.min(blocked, pen), [{ c: cp, d: blocked }], false);
    }
    return;
  }
  // open field: artifacts have MASS — shoving one bleeds a little robot momentum, so a
  // large CLUMP is cumulatively heavy to push (pinned artifacts take the stall above)
  if (approach > 0) {
    r.vel.x -= nx * approach * C.BALL_PUSH_DRAG;
    r.vel.y -= ny * approach * C.BALL_PUSH_DRAG;
  }
}

/**
 * AN ARTIFACT COMING DOWN ONTO THE INTAKE LANDS ON IT — it does not fall through into the
 * throat. The mouth is open at BALL HEIGHT (that is what lets an artifact roll in under the
 * rollers, and it is why `ballRobotContact` returns nothing there); from ABOVE, the rollers
 * and the structure carrying them are in the way. See `intakeLidZ`.
 *
 * Returns true while the artifact is on the lid, so the caller keeps it there and lets it
 * roll off the front rather than dropping it in from above.
 */
/**
 * The height of the intake roof under a point, or 0 if there is no intake under it.
 *
 * Used by the classifier outflow, which does not FALL — an artifact leaving the ramp is
 * lowered from ramp height to the floor over the last couple of inches of rail and then
 * released as a ground artifact. With a robot parked on the outflow that lowering ran
 * straight through its intake and put the artifact on the floor INSIDE the mouth, which is
 * "once I stand in front of where the balls come out they still get intaken". There is no
 * floor there: there is an intake, and its roof is where the artifact ends up.
 */
export function intakeRoofAt(
  world: World,
  p: Vec2,
  pad = C.BALL_RADIUS,
  frontPad = pad,
): { z: number; robot: RobotState } | null {
  let best: { z: number; robot: RobotState } | null = null;
  for (const r of world.robots) {
    if (!overIntakeRoof(r, p, pad, frontPad)) continue;
    const z = C.intakeLidZ(r.spec);
    if (!best || z > best.z) best = { z, robot: r };
  }
  return best;
}

/**
 * is `p` (an artifact centre) within the intake's roof — see `landOnIntakeLid`.
 *
 * `pad` is how far past the roof's own edges an artifact still counts as ON it. A radius is
 * right for LANDING (an artifact perched on the lip overlaps the roof), and ZERO is right for
 * asking whether the roof is in the way of something else, where a radius of slop is the
 * difference between a robot whose mouth is over the outflow and one merely reaching near it.
 */
function overIntakeRoof(
  r: RobotState,
  p: Vec2,
  pad = C.BALL_RADIUS,
  frontPad = pad,
): boolean {
  const local = rot({ x: p.x - r.pos.x, y: p.y - r.pos.y }, -r.heading);
  const hl = r.spec.length / 2;
  const tip = hl + C.INTAKE_PRESETS[r.spec.intake].reach;
  const mh = C.intakeMouth(r.spec).mouthHalf;
  return local.x > hl - pad && local.x <= tip + frontPad && Math.abs(local.y) <= mh + pad;
}

/**
 * A ROBOT HAS A TOP, and an artifact that comes down on it lands there.
 *
 * Over the INTAKE that top is the roller structure (`intakeLidZ`); over the CHASSIS it is the
 * robot's own height. Without the chassis half, an artifact that landed on a robot was ejected
 * out of the nearest FACE by `ballRobotContact` — measured, dropped on the middle of an 18in
 * chassis it teleported 9.8in sideways in one tick and was then shovelled along by the robot
 * to 76 in/s. "If an artifact lands on top of the robot and I move away, they jolt."
 *
 * Returns the height of the top under `p`, or null if `p` is not over the robot at all.
 */
function robotTopZ(r: RobotState, p: Vec2): { z: number; overIntake: boolean } | null {
  if (overIntakeRoof(r, p)) return { z: C.intakeLidZ(r.spec), overIntake: true };
  const local = rot({ x: p.x - r.pos.x, y: p.y - r.pos.y }, -r.heading);
  const hl = r.spec.length / 2;
  const half = r.spec.width / 2;
  // the chassis top, out to where an artifact's own edge still overlaps it
  const pad = C.BALL_RADIUS;
  if (Math.abs(local.x) <= hl + pad && Math.abs(local.y) <= half + pad) {
    return { z: C.ROBOT_HEIGHT, overIntake: false };
  }
  return null;
}

export function landOnIntakeLid(b: Artifact, r: RobotState, prevZ: number): boolean {
  if (b.state.kind !== 'flight') return false;
  const top = robotTopZ(r, b.pos);
  if (!top) return false;
  const lid = top.z;
  // ON it (rolling off), or arriving onto it this tick — never a rising artifact, and never
  // one already UNDER it, which is an artifact that came in the way it is supposed to.
  const arriving = prevZ >= lid && b.z < lid;
  const riding = Math.abs(b.z - lid) < 1e-6 && b.vz <= 0;
  if (!arriving && !riding) return false;

  /**
   * The roof covers exactly what the intake can CAPTURE from — `updateIntake`'s window is
   * `local.x > hl - BALL_RADIUS` out to the roller line, so the roof runs from the chassis
   * front edge (less a radius, where an artifact straddling the edge already overlaps it)
   * to a radius past the rollers.
   *
   * The back edge matters and is not padding. An artifact dropped on the CHASSIS is ejected
   * out of its nearest face by `ballRobotContact`, and for anything near the front that face
   * is the front — which puts it in the throat, a radius forward, still falling. Measured:
   * dropped on the chassis front, every funnel preset still swallowed it. Reaching back a
   * radius means it meets the roof on the way instead.
   */
  b.z = lid;
  b.vz = 0;
  /**
   * IT IS SITTING ON A THING THAT MOVES, so its speed is the ROOF'S speed plus whatever it is
   * doing relative to the roof.
   *
   * The throw used to be floored against the artifact's WORLD velocity, which quietly says the
   * roof is the field. Drive away and the artifact was left behind in mid-air, then re-floored
   * along the robot's new heading every tick it stayed over the roof — a shove that changed
   * direction with the steering, and a step in its velocity the moment the roof left from
   * under it: "if an artifact lands on top of the robot and I move away, they jolt."
   *
   * Flooring the RELATIVE velocity instead makes it an artifact resting on a moving surface
   * and rolling off the front of it. A stationary robot behaves exactly as before. A robot
   * that drives off carries it until the roof runs out, and it leaves with the speed it
   * already had — nothing steps.
   */
  const carry = robotPointVelocity(r, b.pos);
  const relX = b.vel.x - carry.x;
  const relY = b.vel.y - carry.y;
  if (top.overIntake) {
    // the ROLLER throws it: its axis runs across the robot, so forward or back is all there is,
    // and back is the chassis
    const fwd = rot({ x: 1, y: 0 }, r.heading);
    const along = relX * fwd.x + relY * fwd.y;
    const push = along < C.INTAKE_LID_THROW ? C.INTAKE_LID_THROW - along : 0;
    b.vel.x = carry.x + relX + fwd.x * push;
    b.vel.y = carry.y + relY + fwd.y * push;
    return true;
  }
  /**
   * ...AND A ROBOT'S TOP IS NOT A SHELF. It is a lid over a mess of mechanism, so an artifact
   * that lands on one rolls off it rather than parking there for the rest of the match. The
   * push is OUTWARD from the robot's centre — the direction is where it happens to have
   * landed, so nothing is synthesised — and it is an ACCELERATION, not a speed, so nothing
   * steps: the artifact eases off the side it is nearest and falls where it falls.
   */
  const local = rot({ x: b.pos.x - r.pos.x, y: b.pos.y - r.pos.y }, -r.heading);
  const d = hyp(local.x, local.y);
  const ox = d > 1e-6 ? local.x / d : 1;
  const oy = d > 1e-6 ? local.y / d : 0;
  const out = rot({ x: ox, y: oy }, r.heading);
  // a FLOOR on the outward relative speed, never an addition — adding it every tick is an
  // acceleration of 360 in/s^2 dressed up as a nudge, and it had the artifact off the roof at
  // 42 in/s within two ticks.
  const outward = relX * out.x + relY * out.y;
  const shed = outward < C.ROBOT_TOP_SHED ? C.ROBOT_TOP_SHED - outward : 0;
  b.vel.x = carry.x + relX + out.x * shed;
  b.vel.y = carry.y + relY + out.y * shed;
  return true;
}

/**
 * ARTIFACT-side resolution against the INTAKE only. Its mouth is open by design (product
 * decision #10) and its funnel/slope geometry is per-preset, so Rapier has no collider
 * there. The CHASSIS belongs to Rapier now (see `solveBalls`); resolving it here as well
 * was the bug — two position writes per tick, one driving an artifact into the classifier
 * and the next shoving it back out, 4.5in of jitter at zero velocity.
 */
/**
 * OBB contact against the robot's WHOLE front — chassis plus the intake, no open notch.
 *
 * The notch in `ballRobotContact` exists because the rollers ride high in z and artifacts pass
 * UNDER them. That is only true of an artifact at ball height. One riding the intake's ROOF is
 * above the opening, where the roller and the structure carrying it are solid — and it has to
 * be, because a roof-riding artifact is in FLIGHT and flight artifacts are not in the ground
 * solve, so an open notch up there let one drift sideways through a robot-corner gap it could
 * never fit through (smoke measures exactly that).
 */
function ballRobotFrontContact(
  r: RobotState,
  p: Vec2,
): { nx: number; ny: number; pen: number; cp: Vec2 } | null {
  const R = C.BALL_RADIUS;
  const local = rot({ x: p.x - r.pos.x, y: p.y - r.pos.y }, -r.heading);
  const hl = r.spec.length / 2;
  const half = r.spec.width / 2;
  const front = hl + C.INTAKE_PRESETS[r.spec.intake].reach;
  const cx = clamp(local.x, -hl, front);
  const cy = clamp(local.y, -half, half);
  const dx = local.x - cx;
  const dy = local.y - cy;
  const toWorld = (nlx: number, nly: number, pen: number, clx: number, cly: number) => {
    const n = rot({ x: nlx, y: nly }, r.heading);
    const c = rot({ x: clx, y: cly }, r.heading);
    return { nx: n.x, ny: n.y, pen, cp: { x: c.x + r.pos.x, y: c.y + r.pos.y } };
  };
  if (dx !== 0 || dy !== 0) {
    const d2 = dx * dx + dy * dy;
    if (d2 >= R * R) return null;
    const d = Math.sqrt(d2);
    return toWorld(dx / d, dy / d, R - d, cx, cy);
  }
  const dl = local.x + hl;
  const dr = front - local.x;
  const dt = half - local.y;
  const db = half + local.y;
  const mm = Math.min(dl, dr, dt, db);
  if (mm === dr) return toWorld(1, 0, R + dr, front, local.y);
  if (mm === dl) return toWorld(-1, 0, R + dl, -hl, local.y);
  if (mm === dt) return toWorld(0, 1, R + dt, local.x, half);
  return toWorld(0, -1, R + db, local.x, -half);
}

/**
 * How deep an artifact centred at `p` is inside anything SOLID on the robot — chassis or the
 * intake's own structure — and zero where the mouth is open to it. This is `ballRobotContact`'s
 * own answer, exposed for the jam rule, which has to know "is this artifact against something
 * that will not let it through" and must not count the open notch, where an artifact being
 * swallowed sits several inches deep on purpose.
 */
export function ballRobotPenetration(r: RobotState, p: Vec2): number {
  const c = ballRobotContact(r, p);
  return c ? c.pen : 0;
}

export function collideBallRobot(b: Artifact, r: RobotState): void {
  // above the mouth's opening the intake is not open — see ballRobotFrontContact
  const overMouth = b.z >= 2 * C.BALL_RADIUS;
  const contact = overMouth ? ballRobotFrontContact(r, b.pos) : ballRobotContact(r, b.pos);
  if (!contact) return;
  const { nx, ny, pen, cp } = contact;
  const localX = rot({ x: b.pos.x - r.pos.x, y: b.pos.y - r.pos.y }, -r.heading).x;
  // The chassis is skipped ONLY for artifacts Rapier actually solved, which is ground
  // artifacts and nothing else. Skipping it unconditionally made the chassis transparent to
  // anything in FLIGHT — and "flight" is not just a shot in the air: an artifact that lands
  // keeps bouncing in that state until its vz falls below the settle threshold. So an
  // artifact rolling and hopping across the floor sailed straight through a robot, which is
  // what "artifacts sometimes jump over the chassis" looks like. Measured 12 of 15 low
  // approaches crossing, 7.3in deep, including one at z = 0.
  if (!overMouth && b.state.kind === 'ground' && localX <= r.spec.length / 2) return;
  const c = clampBallPosToStatics({ x: b.pos.x + nx * pen, y: b.pos.y + ny * pen });
  b.pos.x = c.x;
  b.pos.y = c.y;
  const sv = robotPointVelocity(r, cp);
  const rvx = b.vel.x - sv.x;
  const rvy = b.vel.y - sv.y;
  const vn = rvx * nx + rvy * ny;
  if (vn < 0) {
    b.vel.x -= nx * vn * (1 + C.BALL_ROBOT_RESTITUTION);
    b.vel.y -= ny * vn * (1 + C.BALL_ROBOT_RESTITUTION);
  }
}

/** solid rect for balls: bounces approaching balls off the faces, and evicts
 * a ball that ends up inside through the nearest edge */
/**
 * `from` — where the artifact was at the START of the tick, when the caller knows it.
 *
 * Without it, an artifact whose CENTRE has crossed inside can only be pushed out the
 * nearest FACE, by depth+radius. For the 6in classifier channel that is up to 5.5in in one
 * tick, and it was measured at 3.70in on an artifact at REST — pushed 1.2in into the
 * channel by the ball-ball separation pass (which knows nothing about statics) and
 * teleported back out by this one. That trade is what "they keep teleporting up and down
 * the classifier depending on how I turn the robot" looks like from the driver's seat.
 *
 * With `from`, an artifact that entered THIS TICK is walked back along the path it took,
 * so the correction is bounded by how far it actually travelled and points the way it came
 * instead of sideways. The face push stays for anything already inside at the start of the
 * tick (a flight artifact that landed in the channel) — there is no path to undo there.
 *
 * NOTE both ground call sites must pass it. Passing it only to the pre-relaxation one
 * changed nothing measurable, because the eviction that actually fires here is the one
 * INSIDE the relaxation loop, right after the separation pass that caused the overlap.
 */
export function collideBallRect(
  b: Artifact,
  rect: Rect,
  restitution = C.BALL_WALL_RESTITUTION,
  from?: Vec2,
): void {
  const inside =
    b.pos.x > rect.x0 && b.pos.x < rect.x1 && b.pos.y > rect.y0 && b.pos.y < rect.y1;
  if (inside) {
    const cameFromOutside =
      from && !(from.x > rect.x0 && from.x < rect.x1 && from.y > rect.y0 && from.y < rect.y1);
    if (cameFromOutside) {
      // bisect the chord back toward `from` for the last point outside the rect
      let lo = 0; // 0 = `from` (outside), 1 = here (inside)
      let hi = 1;
      for (let i = 0; i < 14; i++) {
        const m = (lo + hi) / 2;
        const px = from.x + (b.pos.x - from.x) * m;
        const py = from.y + (b.pos.y - from.y) * m;
        if (px > rect.x0 && px < rect.x1 && py > rect.y0 && py < rect.y1) hi = m;
        else lo = m;
      }
      const ex = from.x + (b.pos.x - from.x) * lo;
      const ey = from.y + (b.pos.y - from.y) * lo;
      // ...then hold it a radius off the face it crossed, using the shallowest exit from
      // that entry point (a corner entry crosses two faces; the nearest is the right one)
      const dxs: [number, number, number][] = [
        [-1, 0, ex - rect.x0],
        [1, 0, rect.x1 - ex],
        [0, -1, ey - rect.y0],
        [0, 1, rect.y1 - ey],
      ];
      const [nx, ny] = dxs.reduce((p, q2) => (Math.abs(q2[2]) < Math.abs(p[2]) ? q2 : p));
      b.pos.x = ex + nx * C.BALL_RADIUS;
      b.pos.y = ey + ny * C.BALL_RADIUS;
      const vn = b.vel.x * nx + b.vel.y * ny;
      if (vn < 0) {
        b.vel.x -= nx * vn * (1 + restitution);
        b.vel.y -= ny * vn * (1 + restitution);
      }
      return;
    }
    // never evict through a field wall (e.g. the classifier channel's outer
    // edge IS the wall — a squeezed ball must exit into the field)
    const lim = C.FIELD_HALF - C.BALL_RADIUS;
    const exits: [number, number, number][] = (
      [
        [-1, 0, b.pos.x - rect.x0],
        [1, 0, rect.x1 - b.pos.x],
        [0, -1, b.pos.y - rect.y0],
        [0, 1, rect.y1 - b.pos.y],
      ] as [number, number, number][]
    ).filter(([nx, ny, d]) => {
      const px = b.pos.x + nx * (d + C.BALL_RADIUS);
      const py = b.pos.y + ny * (d + C.BALL_RADIUS);
      return Math.abs(px) <= lim && Math.abs(py) <= lim;
    });
    if (exits.length === 0) return;
    const [nx, ny, d] = exits.reduce((p, q) => (q[2] < p[2] ? q : p));
    b.pos.x += nx * (d + C.BALL_RADIUS);
    b.pos.y += ny * (d + C.BALL_RADIUS);
    const vn = b.vel.x * nx + b.vel.y * ny;
    if (vn < 0) {
      b.vel.x -= nx * vn * (1 + restitution);
      b.vel.y -= ny * vn * (1 + restitution);
    }
    return;
  }
  const cx = clamp(b.pos.x, rect.x0, rect.x1);
  const cy = clamp(b.pos.y, rect.y0, rect.y1);
  const dx = b.pos.x - cx;
  const dy = b.pos.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= C.BALL_RADIUS * C.BALL_RADIUS || d2 < 1e-9) return;
  const d = Math.sqrt(d2);
  const nx = dx / d;
  const ny = dy / d;
  const pen = C.BALL_RADIUS - d;
  b.pos.x += nx * pen;
  b.pos.y += ny * pen;
  const vn = b.vel.x * nx + b.vel.y * ny;
  if (vn < 0) {
    b.vel.x -= nx * vn * (1 + restitution);
    b.vel.y -= ny * vn * (1 + restitution);
  }
}
