import type { Alliance, RobotSpec, StartPose, Vec2 } from '../types';
import * as C from '../config';
import { rot, hyp } from '../math';
import { intakeMountOf } from '../games/chain/mounts';

export type { StartPose } from '../types';

/**
 * DECODE field geometry (verified against Competition Manual Section 9 figures
 * and the official ftc-docs field diagrams):
 *
 * World frame: origin at field center, +x = audience's right, +y = away from
 * the audience. Red Wall (red ALLIANCE AREA) is the LEFT wall (x = -72),
 * Blue Wall is the RIGHT wall (x = +72). Goals are CROSS-COURT from their
 * drive teams: BLUE GOAL in the far-LEFT corner (tag 20), RED GOAL in the
 * far-RIGHT corner (tag 24). The obelisk is centered outside the far wall.
 * Each goal's classifier ramp descends along the adjacent side wall to its
 * GATE near mid-wall; released/overflow artifacts roll out beneath it through
 * the (opposing) SECRET TUNNEL strip toward the audience corner.
 * The two LAUNCH ZONES are shared: a large triangle from the far corners to
 * the field center, and a small triangle centered on the audience wall.
 */

/** the opposing alliance */
export const other = (a: Alliance): Alliance => (a === 'blue' ? 'red' : 'blue');

/** which side wall the alliance's GOAL corner is on: blue -1 (left), red +1 */
export const goalSide = (a: Alliance): number => (a === 'blue' ? -1 : 1);
/** which side wall the alliance's DRIVE TEAM / loading zone is on */
export const driverSide = (a: Alliance): number => -goalSide(a);

/** camera/world rotation so the driver views the field from their wall:
 * screen-up points from the driver's wall into the field */
export const viewAngleOf = (a: Alliance): number =>
  driverSide(a) === 1 ? -Math.PI / 2 : Math.PI / 2;

export interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export const inRect = (p: Vec2, r: Rect): boolean =>
  p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;

const sideRect = (side: number, x0: number, x1: number, y0: number, y1: number): Rect => ({
  x0: Math.min(side * x0, side * x1),
  x1: Math.max(side * x0, side * x1),
  y0,
  y1,
});

// ------------------------------------------------------------------ goal ----

/** the two endpoints of the goal FACE (hypotenuse): one on the far wall,
 * one on the side wall. The right-angle corner is the field corner between
 * them. Legs: GOAL_FACE_WIDTH along the far wall, GOAL_DEPTH down the side. */
export function goalFacePoints(a: Alliance): [Vec2, Vec2] {
  const g = goalSide(a);
  const f = C.FIELD_HALF;
  return [
    { x: g * (f - C.GOAL_FACE_WIDTH), y: f }, // far-wall endpoint
    { x: g * f, y: f - C.GOAL_DEPTH }, // side-wall endpoint
  ];
}

/** unit normal of the goal face pointing out into the field (not 45° — the
 * face is the hypotenuse of the 26.5x18.3 corner triangle) */
export function goalFaceNormal(a: Alliance): Vec2 {
  return {
    x: -goalSide(a) * (C.GOAL_DEPTH / C.GOAL_FACE_LEN),
    y: -(C.GOAL_FACE_WIDTH / C.GOAL_FACE_LEN),
  };
}

/** signed PERPENDICULAR distance (in) from the goal face; > 0 = behind the
 * face (inside the goal footprint), < 0 = in front (field side) */
export function goalLineValue(p: Vec2, a: Alliance): number {
  const [far] = goalFacePoints(a);
  const n = goalFaceNormal(a);
  return n.x * (far.x - p.x) + n.y * (far.y - p.y);
}

/** aim target: centroid of the triangular goal opening */
export function goalCenter(a: Alliance): Vec2 {
  const g = goalSide(a);
  const f = C.FIELD_HALF;
  return {
    x: (g * (f - C.GOAL_FACE_WIDTH) + 2 * g * f) / 3,
    y: (2 * f + (f - C.GOAL_DEPTH)) / 3,
  };
}

/** flywheel spin TARGET (0..1) for a robot at `pos`: a far shot needs a faster
 * wheel, so this ramps with distance to the robot's OWN goal
 * (FLY_SPIN_NEAR→FLY_SPIN_FAR). Shared by spawn init and the per-tick update so
 * the ramp can't drift between them. */
export function flywheelSpinTarget(a: Alliance, pos: Vec2): number {
  const g = goalCenter(a);
  const d = hyp(g.x - pos.x, g.y - pos.y);
  const t = (d - C.FLY_SPIN_NEAR) / (C.FLY_SPIN_FAR - C.FLY_SPIN_NEAR);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** corners of the goal footprint: a right triangle tucked into the far
 * corner, legs flush along the far wall (GOAL_FACE_WIDTH) and side wall
 * (GOAL_DEPTH); the hypotenuse is the FACE. Order: far-wall face pt,
 * side-wall face pt, corner. */
export function goalTriangle(a: Alliance): [Vec2, Vec2, Vec2] {
  const g = goalSide(a);
  const f = C.FIELD_HALF;
  const [far, side] = goalFacePoints(a);
  return [far, side, { x: g * f, y: f }];
}

/** the classifier channel along the side wall, running from the GATE up into the far corner
 * — an obstacle for ROBOTS. It stops AT the gate (`CLASSIFIER_GATE_Y`): past that is the
 * SECRET TUNNEL ZONE, which is floor, and the only thing protruding into it is the gate arm
 * (a separate collider). Released artifacts exit beneath the gate into that floor. */
export function classifierRect(a: Alliance): Rect {
  const g = goalSide(a);
  return sideRect(g, C.FIELD_HALF, C.FIELD_HALF - C.CLASSIFIER_W, C.CLASSIFIER_GATE_Y, C.CLASSIFIER_Y1);
}

export function gateZone(a: Alliance): Rect {
  const g = goalSide(a);
  return sideRect(g, C.GATE_ZONE.xNear, C.GATE_ZONE.xFar, C.GATE_ZONE.y0, C.GATE_ZONE.y1);
}

/** the physical GATE ARM's contact footprint at the channel mouth: the classifier
 * face plus a short field-side approach band (GATE_ARM_REACH). A robot whose bumper
 * overlaps this is TOUCHING the gate — used by G417 (touching an opponent's gate,
 * even without opening it, is a MAJOR) and as the contact half of the push-to-open
 * test. Tighter than gateZone: the robot must be against the arm, not loitering. */
export function gateArmRect(a: Alliance): Rect {
  const g = goalSide(a);
  return sideRect(
    g,
    C.FIELD_HALF,
    C.FIELD_HALF - C.CLASSIFIER_W - C.GATE_ARM_REACH,
    C.GATE_ARM_Y0,
    C.GATE_ARM_Y1,
  );
}

/** the official GATE ZONE marking: two parallel alliance-colored tape LINES,
 * 10in long, running from the side wall into the field, spaced GATE_TAPE_W
 * (2.75in) apart and centered on the gate. The zone is the 2.75x10 strip
 * between them; the interaction rect gateZone() is larger and undrawn. */
export function gateTapeSegments(a: Alliance): [[Vec2, Vec2], [Vec2, Vec2]] {
  const g = goalSide(a);
  // the lines start at the CLASSIFIER edge (not the field wall) and run
  // GATE_TAPE_LEN further into the field
  const xOut = g * (C.FIELD_HALF - C.CLASSIFIER_W);
  const xIn = g * (C.FIELD_HALF - C.CLASSIFIER_W - C.GATE_TAPE_LEN);
  const yc = C.GATE_TAPE_Y;
  const h = C.GATE_TAPE_W / 2;
  return [
    [{ x: xOut, y: yc - h }, { x: xIn, y: yc - h }],
    [{ x: xOut, y: yc + h }, { x: xIn, y: yc + h }],
  ];
}

export function tunnelExit(a: Alliance): Vec2 {
  const g = goalSide(a);
  return { x: g * C.TUNNEL_EXIT.x, y: C.TUNNEL_EXIT.y };
}

export function tunnelExitVel(a: Alliance): Vec2 {
  const g = goalSide(a);
  return { x: -g * C.TUNNEL_EXIT_VEL.inward, y: -C.TUNNEL_EXIT_VEL.along };
}

/** the SECRET TUNNEL floor strip beneath a goal's classifier (belongs to the
 * OPPOSING alliance — it is on their wall) */
export function tunnelStrip(a: Alliance): Rect {
  const g = goalSide(a);
  return sideRect(
    g,
    C.FIELD_HALF,
    C.FIELD_HALF - C.TUNNEL_W,
    C.GATE_ZONE.y0 - C.TUNNEL_STRIP_LEN,
    C.GATE_ZONE.y0,
  );
}

/** ALLIANCE AREA: the taped drive-team rectangle OUTSIDE the alliance's own
 * wall (red left, blue right), running from the audience wall toward the far
 * wall — not wall-centered (per the Section 9 figures) */
export function allianceArea(a: Alliance): Rect {
  const d = driverSide(a);
  return sideRect(
    d,
    C.FIELD_HALF,
    C.FIELD_HALF + C.ALLIANCE_AREA_DEEP,
    -C.FIELD_HALF,
    -C.FIELD_HALF + C.ALLIANCE_AREA_ALONG,
  );
}

// ----------------------------------------------------------------- zones ----

/** shared launch zones: big far triangle (apex at field center) + small
 * audience triangle. Both alliances launch from the same zones. */
export function inLaunchZone(p: Vec2, _a: Alliance): boolean {
  if (Math.abs(p.x) > C.FIELD_HALF || Math.abs(p.y) > C.FIELD_HALF) return false;
  const main = p.y >= Math.abs(p.x); // triangle (0,0) (-72,72) (72,72)
  const aud = p.y <= -C.AUD_ZONE_APEX_Y - Math.abs(p.x) * (C.TILE / C.AUD_ZONE_HALF_W); // small triangle at audience wall
  return main || aud;
}

/** the two shared launch zones AS POLYGONS (the same triangles drawn by
 * launchSegments / inLaunchZone). Used for a proper robot-OBB overlap test:
 * because the main wedge's boundary is the 45° diagonal converging at the field
 * center, a robot straddling the APEX can cover the wedge while all four corners
 * fall outside both diagonals — a corner-only test wrongly reads OUT. */
export function launchTriangles(): Vec2[][] {
  const f = C.FIELD_HALF;
  return [
    [{ x: 0, y: 0 }, { x: -f, y: f }, { x: f, y: f }],
    [
      { x: 0, y: -C.AUD_ZONE_APEX_Y },
      { x: -C.AUD_ZONE_HALF_W, y: -f },
      { x: C.AUD_ZONE_HALF_W, y: -f },
    ],
  ];
}

/** the DEPOT tape line: white tape running flush ALONG the goal face (the
 * hypotenuse), from the far-wall corner up to the CLASSIFIER edge (it stops
 * at the classifier — it does not run through the channel to the side wall).
 * It is a LAUNCH LINE. */
export function depotSegment(a: Alliance): [Vec2, Vec2] {
  const [far, side] = goalFacePoints(a);
  // clip the side end where the face crosses the classifier's inner edge
  const t = (C.GOAL_FACE_WIDTH - C.CLASSIFIER_W) / C.GOAL_FACE_WIDTH;
  return [far, { x: far.x + t * (side.x - far.x), y: far.y + t * (side.y - far.y) }];
}

/** clip a segment running from the field toward a goal corner so it stops at
 * the goal FACE instead of continuing into the goal footprint */
function clipToGoalFace(apex: Vec2, corner: Vec2, a: Alliance): Vec2 {
  const g0 = goalLineValue(apex, a); // < 0 in front of the face
  const g1 = goalLineValue(corner, a); // > 0 inside the goal
  if (g1 <= 0) return corner;
  const t = g0 / (g0 - g1);
  return { x: apex.x + t * (corner.x - apex.x), y: apex.y + t * (corner.y - apex.y) };
}

/** all white launch-line tape segments (incl. depot lines) for LEAVE checks.
 * The big-triangle diagonals stop at the goal face (they don't run into the
 * goal). */
export function launchSegments(): [Vec2, Vec2][] {
  const f = C.FIELD_HALF;
  const apex = { x: 0, y: 0 };
  return [
    [apex, clipToGoalFace(apex, { x: f, y: f }, 'red')],
    [apex, clipToGoalFace(apex, { x: -f, y: f }, 'blue')],
    [{ x: 0, y: -C.AUD_ZONE_APEX_Y }, { x: C.AUD_ZONE_HALF_W, y: -f }],
    [{ x: 0, y: -C.AUD_ZONE_APEX_Y }, { x: -C.AUD_ZONE_HALF_W, y: -f }],
    // depot lines (they are launch lines too), flush along each goal face
    depotSegment('red'),
    depotSegment('blue'),
  ];
}

export function baseZone(a: Alliance): Rect {
  const d = driverSide(a);
  const c = { x: d * C.BASE_CENTER.x, y: C.BASE_CENTER.y };
  return { x0: c.x - 9, x1: c.x + 9, y0: c.y - 9, y1: c.y + 9 };
}

// ---------------------------------------------------- start position (G304) --

/** why a start pose is / isn't a legal G304 setup (each flag = one clause). */
export interface StartLegality {
  legal: boolean;
  overLaunchLine: boolean; // A. footprint is over a white LAUNCH LINE
  touching: boolean; // B. footprint touches the GOAL or the FIELD perimeter
  contained: boolean; // C. footprint fully inside the FIELD perimeter
  ownHalf: boolean; // C. footprint fully within the alliance's own half (columns)
  clear: boolean; // collision box does not PENETRATE a solid structure (goal / classifier)
}

/** footprint extents in the robot frame (chassis + intake reach). Single source
 * of truth reused by physics.robotExtents and the G304 start validator. */
export function footprintExtents(spec: RobotSpec): { front: number; rear: number; half: number } {
  const reach = C.INTAKE_PRESETS[spec.intake].reach;
  // The intake is a PHYSICAL part of the robot, so it extends the collision hitbox on whichever
  // edge(s) it is mounted on (Chain Reaction lets it move; DECODE intakes are always front, and
  // `intakeMountOf` defaults there — so DECODE geometry is unchanged). A `frontback` sweeper is
  // deeper fore-and-aft on BOTH ends; a `side` sweeper is wider instead.
  const mount = intakeMountOf(spec);
  const ends = mount === 'front' || mount === 'frontback';
  const rear = mount === 'back' || mount === 'frontback';
  return {
    front: spec.length / 2 + (ends ? reach : 0),
    rear: spec.length / 2 + (rear ? reach : 0),
    half: spec.width / 2 + (mount === 'side' ? reach : 0),
  };
}

/** world-frame corners of a robot footprint (chassis + intake) at an arbitrary
 * pose, optionally grown outward by `pad` inches (a "touching" slack). */
export function footprintCorners(
  spec: RobotSpec,
  pos: Vec2,
  heading: number,
  pad = 0,
): Vec2[] {
  const e = footprintExtents(spec);
  const local = [
    { x: e.front + pad, y: e.half + pad },
    { x: e.front + pad, y: -e.half - pad },
    { x: -e.rear - pad, y: -e.half - pad },
    { x: -e.rear - pad, y: e.half + pad },
  ];
  return local.map((p) => {
    const w = rot(p, heading);
    return { x: w.x + pos.x, y: w.y + pos.y };
  });
}

const SAT_EPS = 1e-6;

function projRange(pts: Vec2[], ax: Vec2): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) {
    const d = p.x * ax.x + p.y * ax.y;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return [lo, hi];
}

function disjointOnAxis(a: Vec2[], b: Vec2[], ax: Vec2): boolean {
  if (Math.abs(ax.x) < SAT_EPS && Math.abs(ax.y) < SAT_EPS) return false; // degenerate axis
  const [a0, a1] = projRange(a, ax);
  const [b0, b1] = projRange(b, ax);
  return a1 < b0 - SAT_EPS || b1 < a0 - SAT_EPS;
}

function edgeNormals(poly: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    out.push({ x: -(q.y - p.y), y: q.x - p.x });
  }
  return out;
}

/** SAT overlap between two convex polygons (CCW/CW both fine). */
function convexOverlap(a: Vec2[], b: Vec2[]): boolean {
  for (const ax of [...edgeNormals(a), ...edgeNormals(b)]) {
    if (disjointOnAxis(a, b, ax)) return false;
  }
  return true;
}

/** does a convex quad overlap the segment a→b? (segment = degenerate convex) */
function quadCrossesSegment(quad: Vec2[], a: Vec2, b: Vec2): boolean {
  const seg = [a, b];
  const axes = [
    ...edgeNormals(quad),
    { x: -(b.y - a.y), y: b.x - a.x }, // segment normal
    { x: b.x - a.x, y: b.y - a.y }, // segment direction
  ];
  for (const ax of axes) if (disjointOnAxis(quad, seg, ax)) return false;
  return true;
}

/** rect → corner quad */
function rectCorners(r: Rect): Vec2[] {
  return [
    { x: r.x0, y: r.y0 },
    { x: r.x1, y: r.y0 },
    { x: r.x1, y: r.y1 },
    { x: r.x0, y: r.y1 },
  ];
}

/** evaluate a start pose against G304 (§11). `pose` is in `a`'s ACTUAL field
 * frame. Clauses: (A) over a LAUNCH LINE, (B) touching the GOAL or the FIELD
 * perimeter, (C) fully contained within the alliance's own half — PLUS the robot's
 * collision box may only REST AGAINST a solid structure, never penetrate it (the
 * goal footprint / classifier channel), so a placement is physically valid. The
 * footprint includes the intake reach (a physical part of the robot). */
export function evalStartPose(spec: RobotSpec, pose: StartPose, a: Alliance): StartLegality {
  const pos = { x: pose.x, y: pose.y };
  const heading = (pose.headingDeg * Math.PI) / 180;
  const f = C.FIELD_HALF;
  const corners = footprintCorners(spec, pos, heading);
  const g = goalSide(a);

  const contained = corners.every((c) => Math.abs(c.x) <= f + SAT_EPS && Math.abs(c.y) <= f + SAT_EPS);
  const ownHalf = corners.every((c) => g * c.x >= -SAT_EPS);
  const overLaunchLine = launchSegments().some(([p, q]) => quadCrossesSegment(corners, p, q));

  // grown footprint tests "touching" (within START_TOUCH_TOL of a surface)
  const grown = footprintCorners(spec, pos, heading, C.START_TOUCH_TOL);
  const touchingWall = grown.some((c) => Math.abs(c.x) >= f || Math.abs(c.y) >= f);
  const touchingGoal = convexOverlap(grown, goalTriangle(a));
  const touching = touchingWall || touchingGoal;

  // collision box must not sink into a solid: shrink the footprint by the
  // penetration slack — if it STILL overlaps the goal wedge or classifier
  // channel, the robot is inside the structure (not merely resting against it).
  const core = footprintCorners(spec, pos, heading, -C.START_PEN_SLOP);
  const clear = !convexOverlap(core, goalTriangle(a)) && !convexOverlap(core, rectCorners(classifierRect(a)));

  return {
    legal: contained && ownHalf && overLaunchLine && touching && clear,
    overLaunchLine,
    touching,
    contained,
    ownHalf,
    clear,
  };
}

/** the loci where a legal G304 setup can sit: along the goal FACE (which is also
 * the depot LAUNCH LINE), and along the shared audience LAUNCH LINE on this
 * alliance's own half. Returns [segment endpoint A, B] pairs in `a`'s frame. */
function startLoci(a: Alliance): [Vec2, Vec2][] {
  const g = goalSide(a);
  const f = C.FIELD_HALF;
  return [
    goalFacePoints(a), // goal face / depot launch line
    // this alliance's audience launch line (apex → own-side back corner)
    [{ x: 0, y: -C.AUD_ZONE_APEX_Y }, { x: g * C.AUD_ZONE_HALF_W, y: -f }],
  ];
}

/** snap a start pose to the NEAREST legal G304 pose for this spec/alliance. If
 * the pose is already legal it is returned unchanged. Otherwise candidates are
 * generated along the legal loci (goal face + audience line), each pushed out to
 * just touch its surface, and the closest legal one (position, then heading) to
 * the input is returned. Used by `coerceSetup` (spawn-safe for ANY spec) and by
 * the drag editor's "snap" assist. Deterministic (fixed sample grid). */
export function snapStartToLegal(spec: RobotSpec, pose: StartPose, a: Alliance): StartPose {
  if (evalStartPose(spec, pose, a).legal) return pose;
  const e = footprintExtents(spec);
  const reach = hyp(Math.max(e.front, e.rear), e.half); // max center→corner
  const headings = [pose.headingDeg];
  for (let dh = 15; dh <= 180; dh += 15) headings.push(pose.headingDeg + dh, pose.headingDeg - dh);

  let best: StartPose | null = null;
  let bestCost = Infinity;
  for (const [p, q] of startLoci(a)) {
    const nx = -(q.y - p.y);
    const ny = q.x - p.x;
    const nlen = hyp(nx, ny) || 1;
    // inward normal points toward the field interior (away from the surface)
    let inx = nx / nlen;
    let iny = ny / nlen;
    if (inx * (0 - (p.x + q.x) / 2) + iny * (0 - (p.y + q.y) / 2) < 0) {
      inx = -inx;
      iny = -iny;
    }
    for (let t = 0; t <= 1; t += 1 / 24) {
      const bx = p.x + t * (q.x - p.x);
      const by = p.y + t * (q.y - p.y);
      for (let push = 0; push <= reach + 2; push += 1) {
        const cx = bx + inx * push;
        const cy = by + iny * push;
        for (const h of headings) {
          const cand = { x: cx, y: cy, headingDeg: h };
          if (!evalStartPose(spec, cand, a).legal) continue;
          let dh = Math.abs(((h - pose.headingDeg) % 360) + 360) % 360;
          if (dh > 180) dh = 360 - dh;
          const cost = (cx - pose.x) ** 2 + (cy - pose.y) ** 2 + (dh / 30) ** 2;
          if (cost < bestCost) {
            bestCost = cost;
            best = cand;
          }
        }
      }
    }
  }
  // last resort: the alliance's default preset in its actual frame
  const d = C.START_POSES[0];
  return best ?? mirrorStartPose({ x: d.x, y: d.y, headingDeg: d.headingDeg }, a);
}

/** mirror a start pose between the canonical goalSide=+1 (red) frame and an
 * alliance's actual frame. Self-inverse: `mirror(mirror(p,a),a) === p`. Red is a
 * no-op; blue reflects across x=0 (x→−x, heading→180−heading). */
export function mirrorStartPose(p: StartPose, a: Alliance): StartPose {
  if (goalSide(a) > 0) return { x: p.x, y: p.y, headingDeg: p.headingDeg };
  let h = (180 - p.headingDeg) % 360;
  if (h < 0) h += 360;
  return { x: -p.x, y: p.y, headingDeg: h };
}

/** Is the ACTIVE start selection legal for this chassis + alliance? A `null` pose
 * means "use the preset" (`presetPose` resolves it legal for ANY size — always ok);
 * a custom pose (canonical frame, like `settings`/`LobbyPlayer.startPose`) is checked
 * in the actual frame. A pose authored for one chassis can be illegal for a
 * different-sized one — callers use this to REFUSE ready-up / game-start rather than
 * let `createWorld` silently relocate the robot at spawn. Alliance-symmetric (a
 * canonical pose legal for one alliance is legal for the other), so the settings
 * alliance is safe even if the server later reassigns. */
export function activeStartLegal(
  spec: RobotSpec,
  a: Alliance,
  startPose: StartPose | null | undefined,
): boolean {
  if (!startPose) return true;
  return evalStartPose(spec, mirrorStartPose(startPose, a), a).legal;
}

export function loadZone(a: Alliance): Rect {
  const d = driverSide(a);
  return sideRect(d, C.FIELD_HALF, C.FIELD_HALF - C.LOAD_ZONE_SIZE, -C.FIELD_HALF, -C.FIELD_HALF + C.LOAD_ZONE_SIZE);
}

/** grab row: the 3 pre-staged artifacts, laid out in a row along field-x
 * (vertical on the driver's rotated screen) so a robot sweeps all 3 driving
 * along x. PGP order reading from the field-interior side inward. */
export function loadSlots(a: Alliance): Vec2[] {
  const d = driverSide(a);
  return C.LOAD_COL_XS.map((x) => ({ x: d * x, y: C.LOAD_ROW_Y }));
}

/** the 3 pre-staged loading-zone artifacts at match setup (manual): PGP, touching
 * each other, flush against the alliance (side) wall, stacked up from the very
 * corner of the loading zone. Distinct from the grab row — the HP moves them into
 * the grab row once teleop starts. */
export function loadPreStage(a: Alliance): { pos: Vec2; color: 'purple' | 'green' }[] {
  const d = driverSide(a);
  const x = d * (C.FIELD_HALF - C.BALL_RADIUS); // flush against the side wall
  const colors: ('purple' | 'green')[] = ['purple', 'green', 'purple'];
  return colors.map((color, i) => ({
    pos: { x, y: -C.FIELD_HALF + C.BALL_RADIUS + i * 2 * C.BALL_RADIUS }, // touching, from the corner up
    color,
  }));
}

/** the 6 cell centers of the human player's 2x3 out-of-play box, which sits OFF
 * the field just beyond the audience wall, row-major (nearer row first),
 * side-wall-inward within each row. */
export function loadBoxSlots(a: Alliance): Vec2[] {
  const d = driverSide(a);
  const out: Vec2[] = [];
  for (const y of C.LOAD_BOX_YS) for (const x of C.LOAD_COL_XS) out.push({ x: d * x, y });
  return out;
}

/** ground ball resting in the depot band in front of the alliance's goal */
export function inDepot(p: Vec2, a: Alliance): boolean {
  const gv = goalLineValue(p, a); // signed perpendicular distance from the face
  return gv < 0 && gv > -C.DEPOT_DEPTH;
}

/** spike marks: three 3-ball rows per side (balls in a horizontal row on the
 * 10in tape). near (audience) = GPP, middle = PGP, far = PPG, read from the
 * side wall inward. */
export function spikeMarkBalls(a: Alliance): { pos: Vec2; color: 'purple' | 'green' }[] {
  const d = driverSide(a);
  const rows: ('purple' | 'green')[][] = [
    ['green', 'purple', 'purple'], // near
    ['purple', 'green', 'purple'], // middle
    ['purple', 'purple', 'green'], // far
  ];
  const out: { pos: Vec2; color: 'purple' | 'green' }[] = [];
  C.SPIKE_ROW_YS.forEach((y, i) => {
    const cx = d * C.SPIKE_COL_X;
    rows[i].forEach((color, j) => {
      // j=0 nearest the side wall, reading inward
      out.push({ pos: { x: cx - d * (j - 1) * C.SPIKE_BALL_SPACING, y }, color });
    });
  });
  return out;
}

/** resolve a named preset to a concrete LEGAL pose (actual `a` frame) for THIS
 * chassis: the `START_POSES` entry is a semantic ANCHOR (goal-far / audience /
 * goal-gate), snapped G304-legal for the given spec — so a preset is legal no
 * matter the robot's size. Without a spec it returns the raw anchor (legal for
 * default sizes; the spawn chokepoint still snaps). */
export function presetPose(index: number, a: Alliance, spec?: RobotSpec): StartPose {
  const i = Math.min(Math.max(index, 0), C.START_POSES.length - 1);
  const anchor = C.START_POSES[i];
  const actual = mirrorStartPose({ x: anchor.x, y: anchor.y, headingDeg: anchor.headingDeg }, a);
  return spec ? snapStartToLegal(spec, actual, a) : actual;
}

export function startPose(
  a: Alliance,
  index = 0,
  custom?: StartPose | null,
  spec?: RobotSpec,
): { pos: Vec2; heading: number } {
  // robots stage per G304. `custom` (a fully-placed pose) overrides the named
  // START_POSES quick-pick; a preset is resolved DYNAMICALLY against the chassis
  // (`presetPose`) so it is legal at any size. Poses are authored canonical
  // (goalSide=+1) and mirrored for blue.
  const p = custom
    ? mirrorStartPose(custom, a) // canonical → actual
    : presetPose(index, a, spec);
  return { pos: { x: p.x, y: p.y }, heading: (p.headingDeg * Math.PI) / 180 };
}

/** the classifier SQUARE (rail entrance) — top of the ramp, below the goal */
export function railEntrance(a: Alliance): Vec2 {
  return { x: goalSide(a) * (C.FIELD_HALF - C.RAMP_RAIL_INSET), y: C.CLASSIFIER_Y0 + C.RAIL_S_MAX };
}

/** the archway inside the goal where basin balls funnel toward the SQUARE
 * (top of the rail). Must sit just INSIDE the goal footprint (behind the
 * face) so the basin's face-containment doesn't fence balls off from it. */
export function basinFunnelTarget(a: Alliance): Vec2 {
  return { x: goalSide(a) * (C.FIELD_HALF - C.RAMP_RAIL_INSET), y: C.CLASSIFIER_Y0 + C.RAIL_S_MAX };
}

/** rail coordinate s -> world position along the classifier */
export function railPos(a: Alliance, s: number): Vec2 {
  return { x: goalSide(a) * (C.FIELD_HALF - C.RAMP_RAIL_INSET), y: C.CLASSIFIER_Y0 + s };
}
