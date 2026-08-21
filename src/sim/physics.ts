import type { Alliance, Artifact, RobotState, Vec2, World } from '../types';
import * as C from '../config';
import { classifierRect, footprintExtents, gateHandleRect, goalFaceNormal, goalLineValue, type Rect } from './field';
import { dot, rot, clamp, hyp, datan2 } from '../math';
import { driveParams } from './drivetrain';

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
function applyContactTorque(
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
): void {
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
  const gain = 1 + press * C.CONTACT_PRESS_GAIN;
  const rate = Math.min(C.CONTACT_ALIGN_RATE * gain, C.CONTACT_ALIGN_RATE_MAX) * rateMult;
  // never step PAST flush: cap the correction at the remaining tilt (the
  // chassis is square, so flush poses repeat every 90°). Without this cap the
  // torque bias overshoots each tick and the heading buzzes at the wall.
  let flushErr = Infinity;
  if (squareTo) {
    const q = Math.PI / 2;
    let rel = r.heading - datan2(ny, nx);
    rel -= Math.round(rel / q) * q;
    flushErr = Math.abs(rel);
  }
  const cap = Math.min(rate, flushErr);
  const align = clamp(torque * 0.1 * gain * rateMult, -cap, cap);
  if (align !== 0) {
    const maxTurn = driveParams(r.spec).maxTurn;
    r.heading += align;
    if (r.angVel * align < 0) {
      // bleed angular velocity that fights the contact
      r.angVel *= 0.9;
    } else if (flushErr > 0.05) {
      /**
       * a fast off-axis impact converts speed into visible spin — scaled by the actual torque
       * so a dead-centre (torque≈0) contact adds nothing, and gated near flush so it cannot
       * re-excite a settled robot.
       *
       * ...AND ONLY THE WAY THE ALIGNMENT IS ALREADY GOING. `align` is capped at the remaining
       * tilt so it can never step past flush, but this is not, and fed against the alignment
       * it carries the chassis straight through flush and round again: measured driving BACK
       * into the classifier at ten angles, the robot turned a full 360 at every one of them,
       * and at a few angles the two cancelled and it did not turn at all. "Even when I ram
       * with the back of the chassis where there is no intake, the robot only turns if I
       * impact it at certain specific angles, weird."
       */
      /**
       * ...AND THIS IS SCALED BY THE SURFACE'S RATE TOO. It is angular VELOCITY, so unlike
       * `align` it is not capped at the remaining tilt — it keeps spinning the chassis after
       * the contact has done its work. Leaving it at full strength on the gate arm is what
       * "it spins me around like 90 degrees instantly" is: the alignment was slowed to the
       * arm's pace and the flick was not, so the flick was all that was left.
       */
      r.angVel = clamp(r.angVel + torque * press * C.CONTACT_IMPACT_SPIN * rateMult, -maxTurn, maxTurn);
    }
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

/** OBB-vs-OBB robot collision (SAT over both robots' axes). Near-inelastic
 * shoving with MASS-weighted resolution: the heavier robot yields less, both
 * chassis get the contact-torque response (bumpers square up against each
 * other). Registers the contact pair into `out` (for the penalty engine). */
export function collideRobots(
  a: RobotState,
  b: RobotState,
  out: { a: number; b: number }[] | null,
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
  let minAxis: Vec2 | null = null;
  for (const ax of axes) {
    let aMin = Infinity;
    let aMax = -Infinity;
    for (const c of ca) {
      const p = c.x * ax.x + c.y * ax.y;
      aMin = Math.min(aMin, p);
      aMax = Math.max(aMax, p);
    }
    let bMin = Infinity;
    let bMax = -Infinity;
    for (const c of cb) {
      const p = c.x * ax.x + c.y * ax.y;
      bMin = Math.min(bMin, p);
      bMax = Math.max(bMax, p);
    }
    const overlap = Math.min(aMax, bMax) - Math.max(aMin, bMin);
    if (overlap <= 0) return; // separated
    if (overlap < minPen) {
      minPen = overlap;
      minAxis = ax;
    }
  }
  if (!minAxis) return;
  // normal oriented a -> b
  let nx = minAxis.x;
  let ny = minAxis.y;
  if ((b.pos.x - a.pos.x) * nx + (b.pos.y - a.pos.y) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  if (out) out.push(a.id < b.id ? { a: a.id, b: b.id } : { a: b.id, b: a.id });

  // mass-weighted positional split: the heavier robot yields less
  const ma = a.spec.massLb;
  const mb = b.spec.massLb;
  const wa = mb / (ma + mb);
  const wb = ma / (ma + mb);
  a.pos.x -= nx * minPen * wa;
  a.pos.y -= ny * minPen * wa;
  b.pos.x += nx * minPen * wb;
  b.pos.y += ny * minPen * wb;

  // per-robot pressure into the contact (for the torque response), then a
  // near-inelastic normal impulse: closing velocity dies, masses decide who
  // gets moved
  const pressA = Math.max(0, a.vel.x * nx + a.vel.y * ny);
  const pressB = Math.max(0, -(b.vel.x * nx + b.vel.y * ny));
  const rvn = (b.vel.x - a.vel.x) * nx + (b.vel.y - a.vel.y) * ny;
  if (rvn < 0) {
    // impulse for restitution 0 split by mass
    a.vel.x += nx * rvn * wa;
    a.vel.y += ny * rvn * wa;
    b.vel.x -= nx * rvn * wb;
    b.vel.y -= ny * rvn * wb;
  }

  // contact manifold: every corner of one chassis inside the other
  const contacts: { c: Vec2; d: number }[] = [];
  for (const c of cb) {
    const d = pointDepthInRobot(a, c);
    if (d > -0.05) contacts.push({ c, d: Math.max(d, 0) });
  }
  for (const c of ca) {
    const d = pointDepthInRobot(b, c);
    if (d > -0.05) contacts.push({ c, d: Math.max(d, 0) });
  }
  applyContactTorque(a, -nx, -ny, pressA, contacts, true);
  applyContactTorque(b, nx, ny, pressB, contacts, true);
}

/** push the robot out of walls, goal faces and classifier structures */
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
    if (ov < minOv) {
      minOv = ov;
      ax = axis;
    }
  }
  // orient the normal away from the rect (toward the robot center)
  const cx = (rect.x0 + rect.x1) / 2;
  const cy = (rect.y0 + rect.y1) / 2;
  let nx = ax.x;
  let ny = ax.y;
  if ((centre.x - cx) * nx + (centre.y - cy) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  return { nx, ny, depth: minOv };
}

/** the same SAT overlap, against the robot's FOOTPRINT (chassis + intake) — what Rapier
 * collides with, and what the gate is pressed with. See `footprintCornersOf`. */
function footprintMTV(r: RobotState, rect: Rect): { nx: number; ny: number; depth: number } | null {
  return mtvOf(footprintCornersOf(r), r.heading, rect, r.pos);
}

/** SAT overlap of the robot's CHASSIS with a rect */
function classifierMTV(r: RobotState, rect: Rect): { nx: number; ny: number; depth: number } | null {
  return mtvOf(robotCorners(r), r.heading, rect, r.pos);
}

export function constrainRobot(r: RobotState): void {
  const f = C.FIELD_HALF;
  for (let pass = 0; pass < 3; pass++) {
    let corners = robotCorners(r);

    // perimeter walls: all touching corners contribute contact torque
    const walls: [number, number, (c: Vec2) => number][] = [
      [-1, 0, (c) => c.x - f],
      [1, 0, (c) => -f - c.x],
      [0, -1, (c) => c.y - f],
      [0, 1, (c) => -f - c.y],
    ];
    for (const [nx, ny, depthOf] of walls) {
      let depth = 0;
      const contacts: { c: Vec2; d: number }[] = [];
      for (const c of corners) {
        const d = depthOf(c);
        if (d > -0.05) contacts.push({ c, d: Math.max(d, 0) });
        if (d > depth) depth = d;
      }
      if (depth > 0) pushRobotAt(r, nx, ny, depth, contacts);
    }

    // goal front faces (diagonal walls in the far corners)
    for (const a of ALLIANCES) {
      let worst = 0;
      const contacts: { c: Vec2; d: number }[] = [];
      for (const c of robotCorners(r)) {
        const d = goalLineValue(c, a); // perpendicular distance behind the face
        if (d > -0.05) contacts.push({ c, d: Math.max(d, 0) });
        if (d > worst) worst = d;
      }
      if (worst > 0) {
        const n = goalFaceNormal(a);
        pushRobotAt(r, n.x, n.y, worst, contacts);
      }
    }

    // classifier ramp structures along the side walls. Evict via the true
    // minimum-translation-vector of the robot OBB (intake INCLUDED) vs the
    // channel rect, so ramming a CORNER pushes out the right way and the intake
    // never stays clipped — with contact torque so a ram squares the chassis up.
    // The channel's outer edge IS the field wall, so a push whose normal points
    // (predominantly) toward that wall is skipped — the wall constraint handles
    // it — to avoid a wall-vs-structure fight.
    for (const a of ALLIANCES) {
      const rect = classifierRect(a);
      const mtv = classifierMTV(r, rect);
      if (!mtv) continue;
      const wallDir = rect.x0 <= -C.FIELD_HALF + 0.01 ? -1 : 1; // toward the side wall
      if (mtv.nx * wallDir > 0.5) continue; // predominantly wall-ward — let the wall win
      const contacts = robotCorners(r)
        .filter((c) => c.x > rect.x0 && c.x < rect.x1 && c.y > rect.y0 && c.y < rect.y1)
        .map((c) => ({ c, d: mtv.depth }));
      pushRobotAt(r, mtv.nx, mtv.ny, mtv.depth, contacts, contacts.length > 1);
    }
  }
}

// ------------------------------------------- square-up (Rapier robot slice) --
// Rapier (physicsEngine.ts) now owns robot translation + velocity: wall/robot
// pushout, velocity-kill, mass-weighted shoving. These run AFTER the Rapier
// solve and add ONLY the bespoke pieces Rapier isn't: the contact-torque "square
// up flush" nudge (rotation) and the robot-robot contact record for penalties.

/** how hard the robot was driving INTO a contact (in/s), from its PRE-solve
 * velocity — scales the square-up torque (a fast hit swings hard; a settled
 * chassis barely turns) */
function pressAlong(preVel: Vec2 | undefined, nx: number, ny: number): number {
  if (!preVel) return 0;
  const vn = preVel.x * nx + preVel.y * ny; // >0 = moving along the push (outward)
  return vn < 0 ? -vn : 0; // driving IN
}

/** torque-only static square-up: Rapier already resolved translation, so this
 * only rotates a tilted chassis flush against walls / goal faces / classifier
 * structures it is resting on. Detection mirrors constrainRobot; `preVel` gives
 * the drive-in pressure the torque scales with. */
/** square a tilted chassis flush against the four perimeter walls at ±halfX / ±halfY.
 * Shared by DECODE (`squareUpStatics`) and Chain Reaction (`squareUpRobotsWalls`) — the
 * wall-alignment torque that makes a robot driving into a wall settle parallel to it. */
function squareUpWalls(r: RobotState, preVel: Vec2 | undefined, halfX: number, halfY: number): void {
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
    if (contacts.length > 0) applyContactTorque(r, nx, ny, pressAlong(preVel, nx, ny), contacts, true);
  }
}

function squareUpStatics(r: RobotState, preVel: Vec2 | undefined, world?: World): void {
  const eps = C.CONTACT_TOUCH_EPS;
  squareUpWalls(r, preVel, C.FIELD_HALF, C.FIELD_HALF);
  const corners = robotCorners(r);

  for (const a of ALLIANCES) {
    const contacts: { c: Vec2; d: number }[] = [];
    for (const c of corners) {
      const d = goalLineValue(c, a);
      if (d > -eps) contacts.push({ c, d: Math.max(d, 0) });
    }
    if (contacts.length > 0) {
      const n = goalFaceNormal(a);
      applyContactTorque(r, n.x, n.y, pressAlong(preVel, n.x, n.y), contacts, true);
    }
  }

  /**
   * THE GATE HANDLE IS STRUCTURE, AND THE INTAKE IS PART OF THE CONTACT AREA.
   *
   * "If I push on the gate all the way and keep holding, it should apply torque to the robot
   * but it doesn't. Remember that if the gate is fully open, then that part acts like a wall
   * essentially for collisions." The arm already stopped a robot — measured, a robot pressing
   * a fully-open gate ends with its intake tip at x=-65.7 against a pivot at -66.0 — but a
   * stop with no torque leaves the robot at whatever angle it arrived at.
   *
   * The reason nothing fired is that every contact test in this pass is built from
   * `robotCorners`, the CHASSIS, and the gate is pressed with the INTAKE: the chassis's
   * front-most corner stops half an inch short of the stub the robot is leaning on. The
   * footprint is what Rapier collides with and it is what this reads now.
   *
   * GROWN BY THE TOUCH EPSILON, because Rapier leaves a hair of separation and a strict
   * overlap test would fire never. Damped by GATE_ARM_TORQUE_MULT: a 2.5in hinged bar is not
   * a wall.
   */
  if (world) {
    for (const a of ALLIANCES) {
      const raw = gateHandleRect(a, world.goals[a].gatePos);
      if (!raw) continue;
      const arm = { x0: raw.x0 - eps, x1: raw.x1 + eps, y0: raw.y0 - eps, y1: raw.y1 + eps };
      const mtv = footprintMTV(r, arm);
      if (!mtv) continue;
      /**
       * THE NORMAL HAS TO BE THE STUB'S, NOT THE SAT'S MINIMUM-OVERLAP AXIS.
       *
       * SAT returns whichever of the four candidate axes overlaps least, and two of those are
       * the ROBOT'S OWN. When it picks one of those the normal comes back aligned with the
       * chassis — and `applyContactTorque` measures "how far from flush" against that normal,
       * so the answer is zero by construction and no torque is ever applied. Measured on a
       * robot leaning 6 degrees on the gate: contacts found, torque 0.26, press 5.9, and the
       * heading did not move a hundredth of a degree for four seconds. "Still no torque being
       * applied at gate."
       *
       * The stub is axis-aligned, so its face normal is the axis from its centre to the
       * robot's, snapped to whichever component dominates — the face the robot is actually on.
       */
      const cx = (arm.x0 + arm.x1) / 2;
      const cy = (arm.y0 + arm.y1) / 2;
      const ax = r.pos.x - cx;
      const ay = r.pos.y - cy;
      const nx = Math.abs(ax) >= Math.abs(ay) ? Math.sign(ax) : 0;
      const ny = nx === 0 ? Math.sign(ay) : 0;
      let contacts = footprintCornersOf(r)
        .filter((c) => c.x > arm.x0 && c.x < arm.x1 && c.y > arm.y0 && c.y < arm.y1)
        .map((c) => ({ c, d: mtv.depth }));
      if (contacts.length === 0) {
        /**
         * ...AND FROM THE STUB'S SIDE WHEN THE ROBOT HAS NO CORNER IN IT. A robot pressing a
         * 2.5in stub with its front EDGE has no footprint corner inside it, and the obvious
         * fallback — the nearest point ON the stub — puts the contact dead ahead of the
         * robot's centre, where the lever arm is zero and the torque with it. The contact a
         * tilted robot actually makes is the stub's own CORNER digging into its front edge.
         */
        for (const c of [
          { x: arm.x0, y: arm.y0 },
          { x: arm.x1, y: arm.y0 },
          { x: arm.x1, y: arm.y1 },
          { x: arm.x0, y: arm.y1 },
        ]) {
          /**
           * ...EACH WITH ITS OWN DEPTH, which is the whole reason this produces a torque.
           *
           * Handing both corners the same `mtv.depth` makes them symmetric about a robot
           * pressing square-on, the two cross products cancel, and the torque is ZERO — which
           * is exactly what "still no torque being applied at gate" looks like: it only turned
           * at big tilts, where one corner falls outside the contact band and stops cancelling
           * the other. The corner that is deeper into the chassis is the one bearing the load,
           * and that asymmetry is what squares the robot up. The wall path has always worked
           * this way (per-corner depth from the wall plane).
           */
          const depth = pointDepthInRobot(r, c);
          if (depth > -eps) contacts.push({ c, d: Math.max(depth, 0) });
        }
      }
      if (contacts.length === 0) {
        contacts = [{ c: { x: clamp(r.pos.x, arm.x0, arm.x1), y: clamp(r.pos.y, arm.y0, arm.y1) }, d: mtv.depth }];
      }
      // ...and squared to, like every other flat face here — see the classifier note below
      // the press is the robot's own — only the RATE is the arm's (see GATE_ARM_TORQUE_MULT)
      applyContactTorque(r, nx, ny, pressAlong(preVel, nx, ny), contacts, true, C.GATE_ARM_TORQUE_MULT);
    }
  }

  for (const a of ALLIANCES) {
    const rect = classifierRect(a);
    const mtv = classifierMTV(r, rect);
    if (!mtv) continue;
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
      applyContactTorque(r, mtv.nx, mtv.ny, pressAlong(preVel, mtv.nx, mtv.ny), contacts, true);
  }
}

/** torque + rrContacts for a robot pair. Rapier resolved the shove; this only
 * squares the two chassis against each other and records the contact for the
 * penalty engine. Detection mirrors collideRobots' SAT (touch within EPS). */
function squareUpPair(
  a: RobotState,
  b: RobotState,
  preVels: Map<number, Vec2>,
  out: { a: number; b: number }[],
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
  let minAxis: Vec2 | null = null;
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
    if (overlap < minPen) {
      minPen = overlap;
      minAxis = ax;
    }
  }
  if (!minAxis) return;
  let nx = minAxis.x;
  let ny = minAxis.y;
  if ((b.pos.x - a.pos.x) * nx + (b.pos.y - a.pos.y) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  out.push(a.id < b.id ? { a: a.id, b: b.id } : { a: b.id, b: a.id });

  const contacts: { c: Vec2; d: number }[] = [];
  for (const c of cb) {
    const d = pointDepthInRobot(a, c);
    if (d > -C.CONTACT_TOUCH_EPS) contacts.push({ c, d: Math.max(d, 0) });
  }
  for (const c of ca) {
    const d = pointDepthInRobot(b, c);
    if (d > -C.CONTACT_TOUCH_EPS) contacts.push({ c, d: Math.max(d, 0) });
  }
  const pva = preVels.get(a.id);
  const pvb = preVels.get(b.id);
  const pressA = pva ? Math.max(0, pva.x * nx + pva.y * ny) : 0;
  const pressB = pvb ? Math.max(0, -(pvb.x * nx + pvb.y * ny)) : 0;
  applyContactTorque(a, -nx, -ny, pressA, contacts, true);
  applyContactTorque(b, nx, ny, pressB, contacts, true);
}

/** post-Rapier bespoke pass: square tilted chassis flush and record robot-robot
 * contacts (rrContacts) for the penalty engine. `preVels` are the pre-solve
 * velocities from solveRobots (drive-in pressure the torque scales with). */
export function squareUpRobots(world: World, preVels: Map<number, Vec2>): void {
  for (let i = 0; i < world.robots.length; i++) {
    for (let j = i + 1; j < world.robots.length; j++) {
      squareUpPair(world.robots[i], world.robots[j], preVels, world.rrContacts);
    }
  }
  for (const r of world.robots) squareUpStatics(r, preVels.get(r.id), world);
}

/** post-Rapier square-up for a game whose only statics are perimeter WALLS (Chain
 * Reaction). Same robot-robot squaring + `rrContacts` as DECODE, but the static pass
 * aligns to the four walls at ±halfX/±halfY only — no DECODE goal-face / classifier
 * geometry. This is what makes a CR robot settle flush when it drives into a wall. */
export function squareUpRobotsWalls(
  world: World,
  preVels: Map<number, Vec2>,
  halfX: number,
  halfY: number,
): void {
  for (let i = 0; i < world.robots.length; i++) {
    for (let j = i + 1; j < world.robots.length; j++) {
      squareUpPair(world.robots[i], world.robots[j], preVels, world.rrContacts);
    }
  }
  for (const r of world.robots) squareUpWalls(r, preVels.get(r.id), halfX, halfY);
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
export function separateBalls(a: Artifact, b: Artifact): void {
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
  // a FRACTION of the overlap per pass — see BALL_SEPARATION_RELAX
  const push = ((minD - d) / 2) * C.BALL_SEPARATION_RELAX;
  const nx = (dx / d) * push;
  const ny = (dy / d) * push;
  a.pos.x -= nx;
  a.pos.y -= ny;
  b.pos.x += nx;
  b.pos.y += ny;
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
  return null; // beyond the frame width, forward → open (overhang region)
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
  const c = clampBallPosToStatics({ x: b.pos.x + nx * pen, y: b.pos.y + ny * pen });
  b.pos.x = c.x;
  b.pos.y = c.y;
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
  const approach = r.vel.x * nx + r.vel.y * ny; // robot speed INTO the artifact
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
    const drivingIn = r.vel.x * inx + r.vel.y * iny;
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
