import type { Alliance, Artifact, RobotState, Vec2, World } from '../types';
import * as C from '../config';
import { classifierRect, footprintExtents, goalFaceNormal, goalLineValue, type Rect } from './field';
import { dot, rot, clamp, hyp, datan2 } from '../math';
import { driveParams } from './drivetrain';

const ALLIANCES: Alliance[] = ['red', 'blue'];

// ------------------------------------------------------------------ OBB ----

/** collision extents in the robot frame: the intake is a physical part of
 * the robot, so the footprint extends forward by its reach */
export function robotExtents(r: RobotState): { front: number; rear: number; half: number } {
  return footprintExtents(r.spec);
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
): void {
  let torque = 0;
  for (const { c, d } of contacts) {
    const lx = c.x - r.pos.x;
    const ly = c.y - r.pos.y;
    const lever = hyp(lx, ly);
    if (lever < 1e-6) continue;
    torque += ((lx * ny - ly * nx) / lever) * (Math.min(d, 2) + C.CONTACT_BIAS);
  }
  const gain = 1 + press * C.CONTACT_PRESS_GAIN;
  const rate = Math.min(C.CONTACT_ALIGN_RATE * gain, C.CONTACT_ALIGN_RATE_MAX);
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
  const align = clamp(torque * 0.1 * gain, -cap, cap);
  if (align !== 0) {
    const maxTurn = driveParams(r.spec).maxTurn;
    r.heading += align;
    if (r.angVel * align < 0) {
      // bleed angular velocity that fights the contact
      r.angVel *= 0.9;
    } else if (flushErr > 0.05) {
      // a fast off-axis impact converts speed into visible spin — scaled by
      // the actual torque so a dead-center (torque≈0) contact adds nothing,
      // and gated near flush so it can't re-excite a settled robot
      r.angVel = clamp(r.angVel + torque * press * C.CONTACT_IMPACT_SPIN, -maxTurn, maxTurn);
    }
  }
}

/** how deep a world point sits inside the robot's OBB (incl. intake);
 * negative = outside */
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
function classifierMTV(r: RobotState, rect: Rect): { nx: number; ny: number; depth: number } | null {
  const corners = robotCorners(r);
  const rc = [
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
  if ((r.pos.x - cx) * nx + (r.pos.y - cy) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  return { nx, ny, depth: minOv };
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

function squareUpStatics(r: RobotState, preVel: Vec2 | undefined): void {
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

  for (const a of ALLIANCES) {
    const rect = classifierRect(a);
    const mtv = classifierMTV(r, rect);
    if (!mtv) continue;
    const wallDir = rect.x0 <= -C.FIELD_HALF + 0.01 ? -1 : 1;
    if (mtv.nx * wallDir > 0.5) continue;
    const contacts = robotCorners(r)
      .filter((c) => c.x > rect.x0 && c.x < rect.x1 && c.y > rect.y0 && c.y < rect.y1)
      .map((c) => ({ c, d: mtv.depth }));
    if (contacts.length > 0)
      applyContactTorque(r, mtv.nx, mtv.ny, pressAlong(preVel, mtv.nx, mtv.ny), contacts, contacts.length > 1);
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
  for (const r of world.robots) squareUpStatics(r, preVels.get(r.id));
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
  const push = (minD - d) / 2;
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

/** position-only clamp against walls and goal faces: where a pushed ball is
 * actually allowed to end up. The difference between the requested and the
 * clamped position is the part of a push the field refused. */
function clampBallPosToStatics(p: Vec2): Vec2 {
  const f = C.FIELD_HALF - C.BALL_RADIUS;
  const out = { x: clamp(p.x, -f, f), y: clamp(p.y, -f, f) };
  for (const a of ALLIANCES) {
    const dist = goalLineValue(out, a); // perpendicular distance behind the face
    const pen = dist + C.BALL_RADIUS;
    if (pen > 0 && dist < C.BALL_RADIUS * 3) {
      const n = goalFaceNormal(a);
      out.x += n.x * pen;
      out.y += n.y * pen;
    }
  }
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

  if (local.x > tip) return null; // under the roller front (high in z) — open to balls

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

export function collideBallRobot(b: Artifact, r: RobotState): void {
  const contact = ballRobotContact(r, b.pos);
  if (!contact) return;
  const { nx, ny, pen, cp } = contact;
  const tx = b.pos.x + nx * pen;
  const ty = b.pos.y + ny * pen;
  const c = clampBallPosToStatics({ x: tx, y: ty });
  b.pos.x = c.x;
  b.pos.y = c.y;
  const bx = tx - c.x; // push refused by the field, pointing into the wall
  const by = ty - c.y;
  const blocked = hyp(bx, by);
  if (blocked > C.BALL_PIN_SLOP) {
    const inx = bx / blocked; // direction of the refused push (into the wall)
    const iny = by / blocked;
    // only the robot's OWN drive transmits through a pinned ball — a foam
    // ball arriving under its own momentum (e.g. gate outflow) can't shove
    // the chassis; it just stops against it and the flow stacks up behind
    const drivingIn = r.vel.x * inx + r.vel.y * iny;
    if (drivingIn > C.BALL_PIN_PUSH_MIN_SPEED) {
      pushRobotAt(r, -inx, -iny, blocked, [{ c: cp, d: blocked }], false);
    }
  } else {
    // open field: balls have MASS — shoving one bleeds a little robot momentum,
    // so a large CLUMP is cumulatively heavy to push (pinned balls use the stall
    // path above; this would fight it)
    const into = r.vel.x * nx + r.vel.y * ny; // robot speed INTO the ball
    if (into > 0) {
      r.vel.x -= nx * into * C.BALL_PUSH_DRAG;
      r.vel.y -= ny * into * C.BALL_PUSH_DRAG;
    }
  }
  const sv = robotPointVelocity(r, cp);
  const rvx = b.vel.x - sv.x;
  const rvy = b.vel.y - sv.y;
  const vn = rvx * nx + rvy * ny;
  if (vn < 0) {
    b.vel.x -= nx * vn * (1 + C.BALL_ROBOT_RESTITUTION);
    b.vel.y -= ny * vn * (1 + C.BALL_ROBOT_RESTITUTION);
  }
  // balls have MASS: shoving one costs the robot a little momentum, so a large
  // CLUMP is cumulatively heavy to push (each contact drags the robot a bit)
  const into = r.vel.x * nx + r.vel.y * ny; // robot speed INTO the ball (>0 = pushing)
  if (into > 0) {
    r.vel.x -= nx * into * C.BALL_PUSH_DRAG;
    r.vel.y -= ny * into * C.BALL_PUSH_DRAG;
  }
}

/** solid rect for balls: bounces approaching balls off the faces, and evicts
 * a ball that ends up inside through the nearest edge */
export function collideBallRect(b: Artifact, rect: Rect, restitution = C.BALL_WALL_RESTITUTION): void {
  const inside =
    b.pos.x > rect.x0 && b.pos.x < rect.x1 && b.pos.y > rect.y0 && b.pos.y < rect.y1;
  if (inside) {
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
