import type { Alliance, Artifact, RobotCommand, RobotState, World } from '../types';
import * as C from '../config';
import {
  basinFunnelTarget,
  gateArmRect,
  goalCenter,
  goalFaceNormal,
  goalLineValue,
  goalSide,
  classifierRect,
  convexOverlap,
  railPos,
  railWander,
  rectCorners,
  tunnelExitVel,
  viewAngleOf,
} from './field';
import { addClassified, addOverflow } from './scoring';
import { approach, nextRandom, hyp, rot } from '../math';
import {
  chassisCorners,
  pointDepthInChassis,
  pointDepthInRobot,
  robotExtents,
  robotIntersectsRect,
} from './physics';

export const ZERO_CMD: RobotCommand = {
  driveX: 0,
  driveY: 0,
  rotate: 0,
  leftDrive: 0,
  rightDrive: 0,
  intake: false,
  fire: false,
};

/** the field-frame direction a robot is COMMANDING its drive (0 if idle). Mirrors
 * the stick→chassis transform in robot.ts so "pressing toward the gate" reads the
 * same intent the drivetrain acts on — needed because a robot stalled against the
 * classifier reports ~0 velocity yet is plainly leaning on the gate arm. */
function commandFieldDir(r: RobotState, cmd: RobotCommand): { x: number; y: number } {
  if (r.spec.drivetrain === 'tank') {
    const fwd = (cmd.leftDrive + cmd.rightDrive) / 2; // tank is commanded via its two sides
    return rot({ x: fwd, y: 0 }, r.heading);
  }
  const stick = { x: cmd.driveX, y: cmd.driveY };
  if (r.fieldCentric) return rot(stick, -viewAngleOf(r.alliance));
  return rot({ x: stick.y, y: -stick.x }, r.heading);
}

/** how HARD robot r is ramming gate a's arm this tick (in/s toward the wall), or 0 if
 * it isn't pushing at all. The gate is a push-to-open mechanism (manual 9.8.3): the
 * robot must be TOUCHING the arm (gateArmRect, at the channel mouth) AND driving INTO it
 * — merely being at the gate no longer opens it. The lever actuates along X only: it
 * opens on a STRAIGHT drive into the handle (toward the classifier/wall); driving
 * SIDEWAYS along the wall (Y) past it does NOT open it. `goalSide` is +1 for red (wall at
 * +x) / −1 for blue (−x), so `g` is the unit push direction into the handle. The returned
 * magnitude scales the lift rate (harder ram ⇒ opens faster — see gateLiftRate). */
export function gateRamSpeed(r: RobotState, cmd: RobotCommand, a: Alliance): number {
  if (!robotIntersectsRect(r, gateArmRect(a))) return 0; // must be against the arm
  const g = goalSide(a);
  const velToward = r.vel.x * g; // ramming the handle toward the wall
  if (velToward >= C.GATE_PUSH_MIN_SPEED) return velToward; // real ram speed
  const cd = commandFieldDir(r, cmd); // leaning on it while stalled (velocity ~0)
  if (cd.x * g >= C.GATE_PUSH_MIN_CMD) return C.GATE_PUSH_MIN_SPEED; // gentle lean floor
  return 0;
}

/** is robot r actively PUSHING gate a's arm this tick? (Touching alone, without a push,
 * does NOT open — but it IS a G417 foul when done to an opponent's gate; see
 * penalties.ts.) */
export function pushingGate(r: RobotState, cmd: RobotCommand, a: Alliance): boolean {
  return gateRamSpeed(r, cmd, a) > 0;
}

/** how fast the arm lifts given how hard it's being rammed. A gentle push eases it open
 * at the base rate; a hard ram approaches the cap (~fully open in a single tick). */
export function gateLiftRate(ramSpeed: number): number {
  return Math.min(C.GATE_OPEN_RATE + C.GATE_OPEN_RATE_SPEED * ramSpeed, C.GATE_OPEN_RATE_MAX);
}

/**
 * HOW HIGH AN ARTIFACT HOLDS THE PADDLE, from where the paddle actually lands on it.
 *
 * `d` is the artifact's centre minus GATE_LINE_S: positive = it has not reached the gate
 * line yet, negative = it is already through. The paddle's edge comes down the vertical at
 * the gate line and meets the artifact's surface at height `R + sqrt(R² − d²)` — a full
 * diameter dead on top, one radius at the equator, nothing at all beyond.
 *
 * The full-diameter case maps to GATE_SEAT_FRAC, which is BELOW GATE_PASS_FRAC on purpose:
 * a paddle resting on a ball is the marginal contact, clearance exactly the ball and no
 * more, so being seated under the arm is NOT being past it. Lifting the rest of the way
 * takes momentum. Equating the two is what made a tap empty the whole ramp — see
 * GATE_SEAT_FRAC.
 */
export function gateRestOn(d: number): number {
  const R = C.BALL_RADIUS;
  if (Math.abs(d) >= R) return 0; // the paddle misses it entirely and falls past
  return (C.GATE_SEAT_FRAC * (R + Math.sqrt(R * R - d * d))) / (2 * R);
}

/**
 * Is the paddle actually RESTING ON the artifact at offset `d` — bearing its weight on it,
 * as opposed to merely being somewhere near it?
 *
 * Three conditions, and the FIRST one is load-bearing in a way that is easy to miss:
 * `gateRestOn` returns 0 both for "the arm is flat on the ramp" and for "this artifact is
 * nowhere near the gate", so testing `gatePos <= gateRestOn(d)` alone says every artifact
 * on the rail is in contact whenever the gate is shut. That froze the ENTIRE rail the
 * moment the gate closed: artifacts never reached the stack, nothing classified, and a
 * dozen unrelated shot/scoring checks went red at once. The paddle has to physically reach
 * it (|d| < R) before any of the rest means anything.
 */
function paddleBearsOn(goal: World['goals'][Alliance], d: number): boolean {
  const rest = gateRestOn(d);
  if (rest <= 0) return false; // out of the paddle's reach — it falls past, touching nothing
  if (goal.gateLatch > 0) return false; // a robot is holding the arm up, clear of everything
  return goal.gatePos <= rest + 1e-9; // settled onto it, not riding above it
}

/** is the artifact at offset `d` inside the paddle's swept region at all — i.e. close
 * enough that the arm coming down would meet it? This is ONE ball diameter wide, and it is
 * the window every "what is under the arm" question has to use. The gateway used to be
 * asked with GATE_CLOSE_CLEAR (8.5in, d from −3.5 to +5.0), which counts an artifact a
 * FULL DIAMETER up-ramp of the gate — one that has not reached it and cannot be touching
 * it — as propping the arm open. That is "no balls below the gate yet it still flows". */
function underPaddle(d: number): boolean {
  return Math.abs(d) < C.BALL_RADIUS;
}

/**
 * HOW FAR DOWN-RAMP AN ARTIFACT CAN GET, given how far open the arm is. The inverse of
 * `gateRestOn`, and the reason the arm stopped landing on anything.
 *
 * The solver used to snap the column's floor to the constant GATE_STOP_S the instant
 * `gateOpen` went false. GATE_STOP_S is one radius from the gate line — exactly the paddle's
 * tangent point — and RAIL_PITCH (5.1in) is one ball diameter, so the artifact behind it
 * lands exactly at the OTHER tangent. The paddle therefore threaded precisely between two
 * artifacts every single time, touching neither. That is not a coincidence to be tuned away;
 * it is forced by those three constants, and no amount of adjusting the ride height moved it.
 *
 * The block is not a constant — it is where the paddle physically is. Reading the paddle's
 * lower edge as `u = 2R · gatePos / GATE_SEAT_FRAC` (0 at shut, a full artifact height when
 * seated on one):
 *  · u ≤ R — the edge is below the artifact's centre, so it meets the paddle's FACE and
 *    stops one radius out: d = R, i.e. exactly GATE_STOP_S. The shut case is unchanged.
 *  · R < u < 2R — the artifact noses UNDER the rising edge until its surface meets it, at
 *    d = sqrt(R² − (u−R)²), which shrinks to nothing as the arm approaches a full diameter.
 *
 * So an arm descending onto a moving column no longer lets the artifact escape into the gap
 * ahead of it: the block follows the paddle down, the artifact is caught where it is, and
 * the arm comes to rest ON it — which is the case the user says should be common and was
 * impossible.
 */
export function gateStopS(gatePos: number): number {
  const R = C.BALL_RADIUS;
  const u = Math.min(2 * R, (2 * R * gatePos) / C.GATE_SEAT_FRAC); // paddle's lower edge
  if (u <= R) return C.GATE_LINE_S + R; // against the face — the classic GATE_STOP_S
  return C.GATE_LINE_S + Math.sqrt(Math.max(0, R * R - (u - R) * (u - R)));
}

/** the open fraction the PHYSICAL handle collider should use THIS tick. buildGateArms
 * (in physicsEngine solveRobots) runs one step BEFORE updateGates mutates gatePos, so
 * without this it would build the handle from last tick's (still-closed) gatePos and
 * hard-stop a robot that is, this very tick, ramming the gate open — the "1-tick jolt".
 * We ANTICIPATE the lift updateGates is about to apply (same ram-scaled rate), so the
 * handle retracts on the SAME tick the push lands: ram harder ⇒ bigger first-tick retract
 * ⇒ you glide through instead of bouncing off. A non-pushing robot (strafing along the
 * wall) gets the raw gatePos, so the closed handle still blocks sneaking past. */
export function gateColliderPos(
  world: World,
  dt: number,
  commands: Map<number, RobotCommand>,
  a: Alliance,
): number {
  const goal = world.goals[a];
  let ram = 0;
  for (const r of world.robots) {
    const s = gateRamSpeed(r, commands.get(r.id) ?? ZERO_CMD, a);
    if (s > ram) ram = s;
  }
  if (ram <= 0) return goal.gatePos;
  return Math.min(1, goal.gatePos + gateLiftRate(ram) * dt);
}

/** balls of a goal's rail stack (non-overflow), sorted from the gate up */
export function railStack(world: World, a: Alliance): Artifact[] {
  return world.balls
    .filter((b) => b.state.kind === 'rail' && b.state.goal === a && !b.state.overflow)
    .sort((p, q) => (p.state as { s: number }).s - (q.state as { s: number }).s);
}

/** flight ball crossing the opening plane drops into the goal basin. Entry
 * counts in EITHER direction — close, flat shots that cross the plane still
 * ascending are caught by the goal's funnel/canopy and drop in. */
export function checkGoalEntry(_world: World, b: Artifact, prevZ: number): boolean {
  if (b.state.kind !== 'flight') return false;
  const P = C.GOAL_OPENING_Z;
  if (!((prevZ - P) * (b.z - P) <= 0 && prevZ !== b.z)) return false;
  for (const a of ['red', 'blue'] as Alliance[]) {
    const g = goalCenter(a);
    if (hyp(b.pos.x - g.x, b.pos.y - g.y) > C.GOAL_OPENING_RADIUS) continue;
    b.state = { kind: 'basin', goal: a };
    // keep entry velocity so the ball splashes around the whole basin
    b.vel.x *= C.BASIN_ENTRY_KEEP_V;
    b.vel.y *= C.BASIN_ENTRY_KEEP_V;
    b.vz *= 0.3;
    return true;
  }
  return false;
}

/** physics inside the triangular goal basin: gravity onto the funnel floor,
 * containment by the goal walls, pull toward the classifier entrance, and
 * ball-ball jumbling. Hand off to the rail when the entrance is clear. */
export function updateBasins(world: World, dt: number): void {
  const basins: Record<Alliance, Artifact[]> = { red: [], blue: [] };
  for (const b of world.balls) {
    if (b.state.kind === 'basin') basins[b.state.goal].push(b);
  }
  for (const a of ['red', 'blue'] as Alliance[]) {
    const balls = basins[a];
    if (balls.length === 0) continue;
    const entry = basinFunnelTarget(a);
    const g = goalSide(a);
    const f = C.FIELD_HALF;
    const sideWall = g * f; // the goal footprint now reaches the side wall

    for (const b of balls) {
      // vertical: fall onto the funnel floor
      b.z += b.vz * dt;
      b.vz -= C.GRAVITY * dt;
      if (b.z <= C.BASIN_FLOOR_Z) {
        b.z = C.BASIN_FLOOR_Z;
        if (b.vz < 0) b.vz = -b.vz * C.BASIN_RESTITUTION;
        if (Math.abs(b.vz) < 15) b.vz = 0;
      }
      // horizontal: funnel pull toward the classifier entrance + damping.
      // fast balls mostly carom around the basin; the funnel grips them
      // once they slow down
      const dx = entry.x - b.pos.x;
      const dy = entry.y - b.pos.y;
      const d = hyp(dx, dy) || 1;
      const nx = dx / d; // unit direction toward the classifier throat
      const ny = dy / d;
      const onFloor = b.z <= C.BASIN_FLOOR_Z + 1;
      const speed = hyp(b.vel.x, b.vel.y);
      let pull = onFloor ? C.BASIN_FUNNEL_ACCEL : C.BASIN_FUNNEL_ACCEL * 0.25;
      if (speed > C.BASIN_FUNNEL_GRIP_SPEED) pull *= 0.3;
      b.vel.x += nx * pull * dt;
      b.vel.y += ny * pull * dt;
      const damp = Math.max(0, 1 - C.BASIN_DAMPING * dt);
      b.vel.x *= damp;
      b.vel.y *= damp;
      // split velocity into radial (toward the throat) + tangential (orbital)
      // and damp the tangential part hard: the goal is a right triangle, not a
      // round bowl, so balls should stream STRAIGHT into the classifier rather
      // than swirl in a circle around the throat. Radial pull is left intact so
      // funneling stays brisk.
      const vr = b.vel.x * nx + b.vel.y * ny;
      const vtx = b.vel.x - vr * nx;
      const vty = b.vel.y - vr * ny;
      const tdamp = Math.max(0, 1 - C.BASIN_TANGENT_DAMPING * dt);
      b.vel.x = vr * nx + vtx * tdamp;
      b.vel.y = vr * ny + vty * tdamp;
      b.pos.x += b.vel.x * dt;
      b.pos.y += b.vel.y * dt;

      // containment: side wall + far wall + the goal face from the inside
      const rr = C.BALL_RADIUS;
      if (g > 0 ? b.pos.x > sideWall - rr : b.pos.x < sideWall + rr) {
        b.pos.x = sideWall - g * rr;
        b.vel.x = -b.vel.x * C.BASIN_WALL_RESTITUTION;
      }
      if (b.pos.y > f - rr) {
        b.pos.y = f - rr;
        b.vel.y = -b.vel.y * C.BASIN_WALL_RESTITUTION;
      }
      const gv = goalLineValue(b.pos, a); // > 0 inside the goal footprint
      const pen = rr - gv; // how far the ball pokes out the face (perp distance)
      if (pen > 0) {
        const n = goalFaceNormal(a); // points out into the field
        b.pos.x -= n.x * pen; // push back INSIDE (against -n)
        b.pos.y -= n.y * pen;
        const vn = b.vel.x * n.x + b.vel.y * n.y;
        if (vn > 0) {
          b.vel.x -= n.x * vn * 1.4;
          b.vel.y -= n.y * vn * 1.4;
        }
      }
    }

    // jumbling: ball-ball collisions within the basin
    for (let i = 0; i < balls.length; i++) {
      for (let j = i + 1; j < balls.length; j++) {
        const p = balls[i];
        const q = balls[j];
        if (Math.abs(p.z - q.z) > C.BALL_RADIUS * 1.6) continue;
        const dx = q.pos.x - p.pos.x;
        const dy = q.pos.y - p.pos.y;
        const d2 = dx * dx + dy * dy;
        const minD = C.BALL_RADIUS * 2;
        if (d2 >= minD * minD || d2 < 1e-9) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d;
        const ny = dy / d;
        const ov = (minD - d) / 2;
        p.pos.x -= nx * ov;
        p.pos.y -= ny * ov;
        q.pos.x += nx * ov;
        q.pos.y += ny * ov;
        const rvx = q.vel.x - p.vel.x;
        const rvy = q.vel.y - p.vel.y;
        const vn = rvx * nx + rvy * ny;
        if (vn < 0) {
          const imp = -vn * 0.55;
          p.vel.x -= imp * nx;
          p.vel.y -= imp * ny;
          q.vel.x += imp * nx;
          q.vel.y += imp * ny;
        }
      }
    }

    // hand-off to the rail: one at a time, when near the entrance and the
    // top of the rail is clear. The ball boards UNDECIDED — classified vs
    // overflow is settled in updateRails at the moment it first meets the
    // stack (or the gate floor), so a drain in progress can still save it.
    const entryBlocked = world.balls.some(
      (b) =>
        b.state.kind === 'rail' &&
        b.state.goal === a &&
        !b.state.overflow &&
        b.state.s > C.RAIL_ENTRY_BLOCK_S,
    );
    if (!entryBlocked) {
      for (const b of balls) {
        const d = hyp(b.pos.x - entry.x, b.pos.y - entry.y);
        if (d > C.BASIN_ENTRY_RADIUS || b.z > C.BASIN_FLOOR_Z + 2) continue;
        // hand-off keeps the ball's position: it glides onto the rail while
        // descending (x/z blend happens in updateRails) — no snapping
        const s = b.pos.y - C.CLASSIFIER_Y0;
        const v = Math.min(b.vel.y, -8);
        b.state = { kind: 'rail', goal: a, s, v, overflow: false, pending: true };
        b.vel = { x: 0, y: 0 };
        b.vz = 0;
        break; // one hand-off per goal per tick keeps the flow orderly
      }
    }
  }
}

/**
 * WHAT IS SITTING IN THE GATE'S MOUTH.
 *
 * The exit is a real place with a real volume, and until now the drain ignored that: a ball
 * reaching RAIL_EXIT_S became a ground artifact at a fixed point below the gate no matter
 * what already occupied it. Park a robot over the outflow and artifacts materialised inside
 * it and piled up — teleporting into an occupied space, which is the one thing the ball
 * lifecycle is not allowed to do.
 *
 * So the mouth is checked before anything leaves (`railBlock`):
 *   `s`     — how far up the rail a robot's body reaches. That becomes the column's floor, so
 *             it backs up against the bumper wherever the bumper actually is. A robot NEVER
 *             takes an artifact off the rail: it has to come out of the gate first.
 *
 * ONLY A ROBOT BLOCKS OUTRIGHT. An artifact lying in the doorway is a different case and
 * must not be treated as one: making it block deadlocked the whole classifier, because a
 * drained artifact rolls a couple of inches, friction stops it dead in the mouth, and the
 * column behind it can then never leave — and since the flow never completes, the gate is
 * held open forever and never falls closed. Letting it through instead is no better: the
 * new artifact lands on top of the old one, which is the pop-and-stack that started all
 * this (measured at 4.3in of overlap on a 5in artifact).
 *
 * So the column PUSHES it (see `doorwayArtifact`): the artifact in the way is shoved along
 * with the same exit velocity and the release waits a tick for it to clear. That is what
 * the artifacts behind it do on a real ramp, it cannot deadlock (the shove is applied every
 * tick), and if something genuinely immovable is pinning it — a robot parked down the
 * tunnel — then the column stalling IS the right answer.
 */
/**
 * WHERE A ROBOT STOPS THE COLUMN — an `s` on the rail, not a yes/no at one point.
 *
 * This used to test the single point `railPos(a, RAIL_EXIT_S)` and return a boolean. Both
 * halves of that were wrong, and measurably so. A robot sitting ON the mouth stopped the
 * flow but the floor stayed at RAIL_EXIT_S, so the column stacked up to 7.3in INSIDE the
 * chassis and sat there — the artifacts visibly inside the robot. And a robot 9in to the
 * side, touching nothing, still blocked the whole ramp, because the one point it tested was
 * the only geometry the rail knew about.
 *
 * So walk the rail line instead and find the highest `s` the robot's body actually reaches.
 * That `s` (plus an artifact radius, so it rests AGAINST the bumper rather than in it) is the
 * column's floor. Partial coverage now does the partial thing: the column stops where the
 * robot is, wherever that happens to be, and stops nothing when the robot is clear.
 *
 * Only the stretch below the classifier's gate end is walked — above it the channel has
 * walls and a robot cannot be in it at all.
 */
function railBlock(
  world: World,
  a: Alliance,
): { s: number; taker: RobotState | null; takeAt: number } {
  let best = -Infinity;
  let who: RobotState | null = null;
  for (const r of world.robots) {
    // HOW FAR UP TO LOOK COMES FROM THE ROBOT, not from the channel. Bounding the walk at the
    // classifier's gate end (s = 1) looked reasonable and was badly wrong: a robot parked on
    // the mouth reaches s = 6.5, so the walk began ALREADY INSIDE the chassis, stopped there,
    // and put the floor 5in inside the robot. Its own collision extents can't lie about this.
    const e = robotExtents(r);
    // The ceiling comes from the ROBOT's own extents and is NOT clamped to the channel mouth
    // (RAIL_OPEN_S). Clamping it looks right — the classifier is solid, so a robot cannot be
    // in there anyway — but the walk is what keeps an artifact from resting INSIDE a chassis,
    // and capping it makes the block underestimate whenever a robot does overlap the rail
    // above the mouth: measured 4.99in of an artifact inside the bumper, a full diameter.
    // Keeping a robot out of the channel is the collider's job, not this walk's.
    const top = C.RAIL_EXIT_S + hyp(e.front + e.rear, e.half * 2) + C.BALL_RADIUS;
    // Walk UP and keep the LAST position an artifact could not occupy — `pointDepthInRobot`
    // is a signed distance, so `> -BALL_RADIUS` means the artifact's skin would be in the
    // bumper. The floor is one step above that, which this walk has already tested and found
    // clear. Deriving it instead as "deepest blocked sample plus a radius" left up to 0.75in
    // of overlap, because a radius along the rail is not a radius along the surface normal of
    // a robot sitting at an angle to it.
    // Fixed step, deterministic, and well under an artifact radius so nothing slips through.
    /**
     * THE WALK CANNOT SEE THE CLASSIFIER WALL, so it must be told where the wall is.
     *
     * It measures distance from a chassis to a point on the rail centreline and nothing else.
     * That centreline sits RAMP_RAIL_INSET in from the wall, which is less than an artifact
     * radius — so a chassis merely LEANING on the outside of the classifier came within a
     * radius of centreline points it was completely walled off from, read as a block, and
     * shoved the column up-ramp: measured a robot at y=1, never in the channel, driving
     * artifacts up at RAIL_PUSH_RATE as far as s=22.4.
     *
     * Above the mouth an artifact is behind a wall, so the only robot that can touch it is one
     * that is itself inside the channel. That is not a depth threshold on the sample (a
     * chassis face resting exactly on the centreline is a real block at any depth) — it is a
     * question about the ROBOT, asked once: does its CHASSIS actually overlap the channel.
     * If not, its reach stops at the mouth no matter how close the centreline looks. (An x
     * reach past the channel's field-side face is not enough on its own — the gateway BELOW
     * the mouth is open field at the same x, so a robot legally working the doorway has
     * corners in there and would fail an x-only test.) A robot squeezed bodily into the channel still walks the full length, which is
     * what keeps the pinned-pose case from stacking the column inside a chassis.
     */
    const chan = classifierRect(a);
    // How far INTO the channel a chassis has to be before it can touch anything: the rail
    // centreline sits RAMP_RAIL_INSET from the wall and an artifact is a radius wide, so this
    // is the exact reach at which contact becomes possible. It matters because a robot leaning
    // hard on the outside of the classifier does sink slightly into it — measured 0.46in at
    // worst, just under the 0.50in it would need — and without the inset that touch read as
    // being inside the channel.
    const bite = C.RAMP_RAIL_INSET - C.BALL_RADIUS;
    const g = goalSide(a);
    const inner = {
      x0: g > 0 ? chan.x0 + bite : chan.x0,
      x1: g > 0 ? chan.x1 : chan.x1 - bite,
      y0: chan.y0 + bite,
      y1: chan.y1,
    };
    const inChannel = convexOverlap(chassisCorners(r), rectCorners(inner));
    const ceiling = inChannel ? top : Math.min(top, C.RAIL_OPEN_S);
    let reach = -Infinity;
    for (let s = C.RAIL_EXIT_S; s <= ceiling; s += C.RAIL_BLOCK_STEP) {
      // CHASSIS, not the intake-extended footprint. `robotExtents` grows the box forward by
      // the intake's reach — that box is what the ROBOT collides with, but to an artifact
      // the mouth is open (product decision #10), and the artifact solve already excludes it
      // for exactly this reason. Using it here meant a robot holding the gate open by
      // pressing its INTAKE at the classifier read as its BODY lying across the outflow, so
      // it blocked the drain it was opening.
      if (pointDepthInChassis(r, railPos(a, s)) > -C.BALL_RADIUS) reach = s + C.RAIL_BLOCK_STEP;
    }
    if (reach > best) {
      best = reach;
      who = r;
    }
  }
  if (who === null) return { s: -Infinity, taker: null, takeAt: C.RAIL_EXIT_S };
  /**
   * A ROBOT BLOCKS. IT DOES NOT COLLECT.
   *
   * A robot with hopper room used to have artifacts handed to it straight off the rail — it
   * "stood under the gate intaking the drain". That is reaching into the classifier, and the
   * artifacts it took had never left the ramp. Artifacts must come OUT of the gate first
   * (`ground`), and then the ordinary intake picks them up off the floor like anything else,
   * which is both the physical truth and the only way the intake's own geometry gets a say.
   *
   * A robot sitting on the outflow now simply blocks it, at its own bumper — it is parked on
   * the hole. Back off, let them out, then intake them.
   */
  return { s: best, taker: null, takeAt: C.RAIL_EXIT_S };
}

/** the artifact still sitting in the gate's doorway, if any — the one the column has to
 * push out of the way before the next can leave. */
export function doorwayArtifact(world: World, a: Alliance): Artifact | null {
  const p = railPos(a, C.RAIL_EXIT_S);
  for (const b of world.balls) {
    if (b.state.kind !== 'ground') continue;
    if (hyp(b.pos.x - p.x, b.pos.y - p.y) < C.BALL_RADIUS * 2 + C.EXIT_CLEARANCE) return b;
  }
  return null;
}

/** 1D flow down the classifier rail with contact stacking against the gate
 * (or the ball ahead). Overflow balls ride over everything and always exit. */
export function updateRails(
  world: World,
  dt: number,
  commands: Map<number, RobotCommand>,
): void {
  for (const a of ['red', 'blue'] as Alliance[]) {
    const goal = world.goals[a];

    const railX = railPos(a, 0).x;

    /**
     * ONE PHYSICS FOR EVERY ARTIFACT ON THE RAMP.
     *
     * `overflow` used to be a permanent MODE: an artifact that met a full column was moved
     * to a separate pass and slid at a fixed OVERFLOW_FLOW_SPEED for the rest of its life,
     * regardless of what happened underneath it. That is why it could not rejoin the column
     * when the gate opened, and why its speed was a number to be tuned rather than a
     * consequence of anything.
     *
     * What `overflow` actually means is two things, and only two:
     *   1. SCORING — it is worth 1 rather than 3, decided at contact (which is unchanged:
     *      the decision still happens the moment it first meets the column).
     *   2. HEIGHT — while the column is underneath it, it is riding on TOP of the retained
     *      artifacts rather than sitting on the ramp.
     *
     * Everything else follows from height. An ELEVATED artifact rolls over the bumpy tops of
     * other artifacts, so it carries a rolling resistance the ramp does not impose, and it is
     * blocked only by other elevated artifacts — not by the retained column it is riding over,
     * and not by the GATE, which it passes over ("OVERFLOW ARTIFACTS can pass over the top of
     * the GATE to exit the RAMP", 9.8.3). The moment the column below drains away it SINKS
     * onto the ramp, and from then on it is an ordinary rolling artifact: gravity, the gate,
     * the artifact ahead. Open the gate while one is coming down and it follows the rest out,
     * because there is nothing left for it to ride on.
     */
    const rail = world.balls
      .filter((b) => b.state.kind === 'rail' && b.state.goal === a)
      .sort((p, q) => (p.state as { s: number }).s - (q.state as { s: number }).s || p.id - q.id);
    const mouth = railBlock(world, a);
    /**
     * THE SOLVER AND THE RELEASE MUST AGREE ABOUT WHETHER AN ARTIFACT CAN LEAVE, and this is
     * the ONE place that decides it. They used to disagree, and the disagreement let an
     * artifact walk off the end of the world:
     *
     *   the solver saw an open gate, dropped the floor to -Infinity, and let the artifact
     *   descend past the exit — while the release loop refused it, because an artifact was
     *   still sitting in the doorway. Nothing then stopped it: the `wasS >= base` exemption
     *   (which exists so a shut gate cannot reach back UP for something already past it) also
     *   exempts an artifact that has slipped below the exit, permanently. Measured: an
     *   artifact in `rail` state marching from y=-64.9 to y=-75.6 — SIX INCHES OUTSIDE the
     *   audience wall — where it was finally released and the ground clamp snapped it back
     *   in, a 394 in/s teleport. The rail is a scripted 1D flow with no wall awareness, so
     *   nothing about being off the field stops it; it simply must never be down there.
     *
     * The doorway is therefore part of "can it leave", not a late veto — and the release lets
     * at most ONE artifact out per tick, since the artifact it just released IS the new
     * doorway. RAIL_PITCH is wider than a tick of travel, so no two can cross together.
     */
    const doorway = doorwayArtifact(world, a);
    const mouthClear = mouth.s === -Infinity && !doorway;
    // the gate holds the RAMP lane only; OVERFLOW rides over the top of it (manual 9.8.3),
    // so a shut gate is not what stops an elevated artifact — only the mouth is.
    const canLeave = goal.gateOpen && mouthClear;
    // where the RAMP-level column is stopped: the exit if it can leave, the gate if it is
    // shut — and in either case never past a robot's body, which is a floor of its own at
    // whatever `s` it actually reaches.
    // THE GATE IS A FLOOR UNDER THE FLOOR. Whatever the artifact ahead does, the column can
    // never pass this: without it, an overflow artifact that had ridden over the top and
    // dropped in BELOW the gate line became the reference for everything behind it, its
    // `s + RAIL_PITCH` sat under GATE_STOP_S, and the entire retained column cascaded out
    // through a shut gate.
    // ...and where a SHUT (or part-shut) gate stops it is WHERE THE PADDLE IS, not a
    // constant. GATE_STOP_S is the paddle's tangent point and RAIL_PITCH is one diameter,
    // so snapping to it put the whole column exactly between the paddle's two tangents —
    // see gateStopS.
    const gateBase = canLeave ? -Infinity : goal.gateOpen ? C.RAIL_EXIT_S : gateStopS(goal.gatePos);
    // A ROBOT BLOCKS THE ELEVATED LANE TOO. Overflow rides over the retained column, not over
    // a robot: an artifact on top of the stack still runs into the bumper of anything parked
    // across the channel, so the same floor applies to both lanes.
    const rampBase = gateBase;
    const overBase = mouthClear ? -Infinity : C.RAIL_EXIT_S;
    // TWO CONSTRAINTS, and they are NOT the same kind of thing:
    //  · the artifact AHEAD — unconditional, artifacts cannot pass through one another;
    //  · the BASE (the gate, or an occupied mouth) — a floor only for artifacts still ABOVE it.
    // Conflating them is what broke this twice. Making both unconditional let a base that MOVES
    // (`canLeave` flips as a robot turns near the mouth) drag artifacts back UP the ramp; making
    // both conditional on "was it above this last tick" let an artifact that dipped below its
    // neighbour by a hair free-fall through the entire column (measured: id 906 passing s=2.5 at
    // 46 in/s with its floor at 7.1, straight out through a shut gate).
    /**
     * THE FLOOR AT THE EXIT IS MOVING, and seeding this at zero is what made the drain a
     * metronome — 0.60s between releases whether the gate was held wide open or merely
     * tapped, which is the same thing twice and neither of them is flow.
     *
     * The frontmost artifact rests on whatever is in the doorway. That is not a wall: it is
     * another artifact, rolling away down the tunnel at ~30 in/s. Handing it `floorV = 0`
     * said otherwise, and the consequences cascaded exactly once per artifact, forever:
     *
     *   the front artifact reaches the exit at 27 in/s → clamped to a DEAD STOP → released
     *   on a later tick with `speed = |v| = 0` → sits motionless in the doorway → blocks the
     *   next one, which is now also stopped dead and also leaves at zero → and the only
     *   thing that ever moves any of them is the EXIT_NUDGE creep at 22 in/s.
     *
     * So every artifact after the first restarted from rest and re-ran the same 0.33s of
     * gravity down one RAIL_PITCH, then waited ~0.28s for the creep to clear the doorway.
     * Measured: the doorway distance sat pinned at 0.02in for the whole of each cycle.
     *
     * The floor moves at the speed of what is on it. A packed column then follows the
     * artifact ahead out at ramp speed, and the "cadence" of a wide-open gate becomes what
     * it should always have been — the rate at which artifacts one RAIL_PITCH apart pass a
     * point, i.e. a stream. Only while the gate is OPEN: against a shut gate the floor is
     * the paddle, which is not going anywhere.
     */
    /**
     * THE COLUMN PUSHES THE QUEUE, NOT THE OTHER WAY ROUND.
     *
     * Seeding the floor velocity from the doorway artifact capped the whole column at
     * whatever the QUEUE outside was doing — and that queue is nudged at a fixed 22.4 in/s,
     * so the ramp could never discharge faster than that no matter how far the artifacts
     * had fallen. Worse, it is a feedback loop: a slower column exits slower, so the
     * artifacts travel less, so the queue packs tighter against the mouth, so the column is
     * capped lower again. Measured across one drain, the ramp fell from 23 in/s to 13
     * against a free-flow speed of 46.
     *
     * With the gate fully OPEN the artifacts are not forcing anything — nothing is taking
     * their momentum, so they should arrive at the exit with the speed the ramp gave them.
     * -Infinity is "no cap": `Math.max(st.v, floorV)` leaves the artifact's own gravity-
     * driven speed alone. The artifact AHEAD still constrains it (that is `rampAhead`, and
     * it is what stops them overlapping); only the exit stops dictating the pace.
     *
     * A SHUT gate is different and still caps at 0 — the column is resting on the paddle.
     */
    const exitFloorV = goal.gateOpen ? -Infinity : 0;
    let rampAhead = -Infinity;
    let rampFloorV = exitFloorV;
    // ...and the same pair for an ELEVATED artifact: never stopped by the gate, only by the exit
    // being physically occupied or by another elevated artifact ahead of it
    let overAhead = -Infinity;
    let overFloorV = exitFloorV;
    let retainedBelow = 0;
    // set when the paddle shoves an artifact back UP the ramp — see the relaxation pass
    let pushedUp = false;

    // the ramp-level artifacts, for deciding what is riding on what
    const retainedS = rail
      .filter((b) => !(b.state as { overflow: boolean }).overflow)
      .map((b) => (b.state as { s: number }).s);

    for (const b of rail) {
      const st = b.state as { s: number; v: number; overflow: boolean; pending?: boolean };
      const wasS = st.s; // an artifact never travels back UP the ramp (see the clamp below)
      const wasV = st.v; // its speed BEFORE this tick's gravity — see the exit lip below

      // RIDING ON THE COLUMN? Whenever there is anything retained BELOW it — not merely
      // directly underneath. An artifact approaching the column from above is already going
      // to ride over it; treating it as ramp-level until it is exactly on top meant the
      // column's own top blocked it and it never got up there at all. It sinks when there is
      // nothing left below to ride on, which is precisely when the ramp has drained.
      const elevated = st.overflow && retainedS.some((rs) => rs < st.s + C.RAIL_PITCH * 0.5);

      st.v = Math.max(st.v - C.RAIL_ACCEL * dt, -C.RAIL_TERMINAL);
      /**
       * WHAT AN ELEVATED ARTIFACT IS ACTUALLY ROLLING ON — the scalloped tops of the
       * retained column, not a smooth incline.
       *
       * `surfaceZ` is where its centre sits: resting on a sphere of the same size means its
       * centre is one DIAMETER from that sphere's centre, so at horizontal offset `dx` it
       * rides at RAMP_SURFACE_Z + sqrt(D² − dx²) — a full diameter up when dead on top of
       * one, dipping into the hollow between two. The old model pinned it at a flat
       * OVERFLOW_Z for the entire ride: measured dead level at 13.50 across nine spheres,
       * and 13.5 is less than a diameter above the ramp, i.e. sunk INTO the column it is
       * supposed to be riding over.
       *
       * The slope of that surface is the interesting half. Rolling down-ramp, the artifact
       * drops into each hollow (gravity with it) and has to climb the next crest (gravity
       * against it), so it lurches rather than gliding — which is what "should not be
       * flowing down that smoothly" is asking for, and it also breaks up the tidy second
       * row the overflow lane used to hold at exactly RAIL_PITCH.
       */
      let surfaceZ = C.OVERFLOW_Z;
      if (elevated) {
        const D = 2 * C.BALL_RADIUS;
        let slope = 0;
        // seeded BELOW every possible scallop, not at OVERFLOW_Z: the fallback is exactly the
        // dead-on-top height (RAMP_SURFACE_Z + D), so seeding there made `h > surfaceZ` false
        // for every sphere and the slope never got set at all — the ride stayed dead level.
        let best = -Infinity;
        for (const rs of retainedS) {
          const dx = st.s - rs;
          if (Math.abs(dx) >= D) continue;
          const lift = Math.sqrt(D * D - dx * dx);
          const h = C.RAMP_SURFACE_Z + lift;
          if (h <= best) continue;
          best = h;
          // dh/ds of that sphere's surface; it diverges at the hand-over between spheres,
          // so it is capped (an unbounded kick there would fling artifacts off the ramp)
          slope = Math.max(-C.OVERFLOW_SLOPE_MAX, Math.min(C.OVERFLOW_SLOPE_MAX, -dx / Math.max(lift, 1e-3)));
        }
        if (best > -Infinity) surfaceZ = best; // else it is over nothing — keep the fallback
        // gravity along the LOCAL slope: descending into a hollow speeds it up, cresting
        // the next artifact slows it down
        st.v -= C.OVERFLOW_BUMP * slope * dt;
        // ...and clambering is still lossy in a way a ramp is not
        st.v *= Math.max(0, 1 - C.OVERFLOW_DRAG * dt);
        st.v = Math.max(st.v, -C.RAIL_TERMINAL);
      } else if (st.overflow && b.z > C.RAMP_SURFACE_Z + 0.05) {
        /**
         * IT HAS RUN OUT OF COLUMN AND IS DROPPING OFF THE END, and landing costs it speed.
         *
         * This is where the variety in the overflow lane comes from, and it needs no
         * randomising: the scallop means artifacts leave the pile anywhere between a hollow
         * and a crest, so they begin the drop from different heights and are still falling
         * for different lengths of time. One rule, a different outcome each.
         *
         * Without it every overflow artifact converged on the drag terminal and left at the
         * same speed — 34.2..35.4 in/s across six, a spread of 1.2 against the classified
         * lane's 17.1 — which is what made them file out in a line.
         */
        st.v *= Math.max(0, 1 - C.OVERFLOW_LAND_LOSS * dt);
      }
      // THE PADDLE HAS WEIGHT, and an artifact passing under an arm that is resting on it
      // carries that weight. The bear is (1 − gatePos): a robot holding the arm fully
      // lifted is touching nothing and costs the flow nothing — which is precisely why a
      // HELD gate streams and a merely-tapped one, with the paddle settled onto the flow
      // at GATE_RIDE_FRAC, meters it. Overflow rides over the top of the gate (9.8.3) and
      // never meets the paddle at all.
      const dGate = st.s - C.GATE_LINE_S;
      // <0 = the paddle is squeezing this artifact OUT from under itself, >0 = shoving it
      // back up into the classifier. Hoisted because the gate's own floor has to know: an
      // artifact the paddle is EXPELLING is not an artifact the paddle is blocking.
      let paddleLean = 0;
      let paddleOn = false;
      if (!elevated && underPaddle(dGate) && goal.gatePos < 1) {
        st.v *= Math.max(0, 1 - C.GATE_PADDLE_DRAG * (1 - goal.gatePos) * dt);
        /**
         * THE GATE NEVER COMES TO REST ON AN ARTIFACT. It pushes it off, one way or the other.
         *
         * The paddle bearing down off-centre does not only press, it pushes sideways, and the
         * direction falls straight out of the contact normal. The contact sits at horizontal
         * offset −d from the artifact's centre, so the normal is (−d, +sqrt(R²−d²))/R and the
         * paddle presses along −normal: the horizontal component is `+d`. One expression,
         * both outcomes:
         *   · d < 0 — the arm landed on the artifact's UPHILL face, behind it. The push is
         *     down-ramp: it squeezes the artifact OUT from under itself and falls shut behind
         *     it, no robot involved.
         *   · d > 0 — the arm landed on its DOWNHILL face, in front of it. The push is
         *     up-ramp: it shoves the artifact back INTO the classifier and then closes.
         *
         * The up-ramp half used to be suppressed and replaced with a WEDGE that froze the
         * artifact where it was — which is precisely "the gate closed on top of a ball and
         * stayed there". A hinged arm with weight on it does not do that; it resolves.
         *
         * Shoving up-ramp has to carry the column above it, which the descent solver will not
         * do (its constraints only ever stop an artifact, never raise it), so `pushedUp`
         * flags it for the relaxation pass at the end of the tick.
         *
         * Gated on the arm actually being IN CONTACT: it bears on this artifact only if it
         * has settled to the height this artifact holds it at, not merely passed nearby.
         */
        if (paddleBearsOn(goal, dGate)) {
          // ...offset by GATE_APEX_BIAS, because the ramp is tilted and the apex is therefore
          // not a resting place. Without it d = 0 is a zero push AND exactly where gateStopS
          // blocks the artifact when the arm is seated — a perfect equilibrium, and the gate
          // parked on the apex in 18 of 48 stalls.
          paddleOn = true;
          // direction from which side of neutral it landed; magnitude never below
          // GATE_SHOVE_MIN, so it is always decisive enough to actually move the artifact
          const raw = dGate / C.BALL_RADIUS - C.GATE_APEX_BIAS;
          paddleLean = Math.sign(raw) * Math.max(Math.abs(raw), C.GATE_SHOVE_MIN);
          st.v += C.GATE_PADDLE_SHOVE * paddleLean * dt;
          if (paddleLean > 0) pushedUp = true;
        }
      }
      st.s += st.v * dt;

      const ahead = elevated ? overAhead : rampAhead;
      /**
       * ...EXCEPT FOR THE ARTIFACT THE PADDLE IS ON. The paddle cannot be both the thing
       * moving an artifact and the floor underneath it.
       *
       * `gateStopS` (where the arm blocks) and `gateRestOn` (how high an artifact holds it)
       * are exact INVERSES, so the pair is neutrally stable at EVERY offset: wherever the
       * artifact happens to stop, the arm settles to exactly the height that blocks it right
       * there, and it stays forever. Measured, the gate parked on an artifact in 19 of 48
       * stalls; adding the apex bias only moved where the shove is zero and left the block
       * pinning it anyway — still 6, all at the gateStopS/gateRestOn fixed point (d = 1.30,
       * v = 0.0, rest = 0.315 = gatePos, tick after tick after tick).
       *
       * So while the paddle bears on it, the gate is no floor for it — its motion is decided
       * by the shove and by gravity, and it resolves one way or the other. gateStopS still
       * governs every OTHER artifact, which is what stops the column at the gate.
       */
      // The paddle is no floor for an artifact it is EXPELLING (down-ramp) — it is the thing
      // moving it. It very much is one for an artifact it is shoving back UP into the
      // classifier: that artifact is arriving into a closing gate, and blocking it is the
      // gate doing its job. Dropping the floor in both directions let every arriving artifact
      // nose under the arm and squirt out, and the gate stopped stopping anything at all
      // (GATE_SHOULDER_LIFT swept 0.016 -> 0.007 changed the drain by literally nothing).
      const base = elevated ? overBase : paddleOn && paddleLean < 0 ? -Infinity : rampBase;
      // THE BASE CANNOT REACH BACK UP FOR SOMETHING ALREADY PAST IT. An overflow artifact that
      // rode over the column and dropped in below the gate line is BELOW the gate stop; without
      // this the gate reached up and froze it there (measured: stranded at s=-1.1, velocity
      // zeroed, two inches short of an exit it had already earned). The artifact ahead has no
      // such exemption — it is solid from both sides.
      const floor = Math.max(ahead, wasS >= base ? base : -Infinity);
      const floorV = elevated ? overFloorV : rampFloorV;
      if (st.s < floor) {
        // FIRST CONTACT decides the score: meeting a full column (RAMP_SLOTS below) diverts
        // it over the top as OVERFLOW, otherwise it settles in as CLASSIFIED. Unchanged —
        // the decision is made at contact, not at hand-off.
        if (st.pending && retainedBelow >= C.RAMP_SLOTS) {
          st.pending = false;
          st.overflow = true;
          goal.overflowCount++;
          addOverflow(world, a);
          // it is now riding the column; it keeps whatever speed it arrived with
          continue;
        }
        // NEVER PUSH IT BACK UP. `floor` moves — -Infinity while the exit is clear,
        // RAIL_EXIT_S the moment something occupies the mouth — so an artifact already past
        // it would be snapped upward when the exit state changed. Turning a robot by the
        // gate flips that check, and the column visibly jumped up and down the classifier in
        // time with the steering. Clamping to min(floor, wasS) lets a constraint STOP an
        // artifact, never reverse it.
        st.s = Math.min(floor, wasS);
        st.v = Math.max(st.v, floorV); // move WITH whatever is ahead, so the column drains packed
        if (st.pending) {
          st.pending = false;
          goal.classifiedCount++;
          addClassified(world, a);
        }
      }

      /**
       * SOLID FLOORS, WHICH ARE NEVER EXEMPTED — a robot's bumper and the edge of the rail.
       *
       * The `wasS >= base` exemption above exists for ONE case: a shut GATE must not reach
       * back up for an overflow artifact that legitimately dropped in below the gate line.
       * Neither of these floors has a legitimate "already past it":
       *
       *  · BELOW THE EXIT the rail line runs on past the audience wall, position-written and
       *    wall-blind, so an artifact that slips under and is not released rides it straight
       *    off the field — measured six inches out, then snapped back by the ground clamp as
       *    a 394 in/s teleport. Two lanes make this reachable even when the solver and the
       *    release agree, since ramp and elevated can each deliver an artifact to the exit on
       *    one tick while only one fits through the doorway.
       *  · INSIDE A ROBOT is not a place either. Exempting the robot floor let a column that
       *    started below it stay there, 7.2in inside the chassis — the same artifacts-in-the-
       *    robot the body floor was added to prevent.
       *
       * Correcting these means moving an artifact UP, which the clamp above refuses to do on
       * purpose (a floor that moves must never yank the column). So it is rate-limited to
       * RAIL_PUSH_RATE: a robot leaning into the channel SHOVES the column up its ramp,
       * visibly, rather than teleporting it. Resting on a bumper kills the roll; queued at
       * the exit lip an artifact keeps `wasV`, neither accelerating under a gravity it cannot
       * act on nor losing the momentum it arrived with.
       */
      const exitFloor = (elevated ? mouthClear : canLeave) ? -Infinity : C.RAIL_EXIT_S;
      const solid = Math.max(mouth.s, exitFloor);
      if (st.s < solid) {
        st.s = Math.min(solid, wasS + C.RAIL_PUSH_RATE * dt);
        st.v = mouth.s > exitFloor ? 0 : wasV;
      }

      if (elevated) {
        overAhead = st.s + C.RAIL_PITCH;
        overFloorV = st.v;
      } else {
        rampAhead = st.s + C.RAIL_PITCH;
        rampFloorV = st.v;
        retainedBelow++;
      }
      // glide smoothly onto the rail line — no positional snapping. The target is the
      // centreline plus this artifact's own path across the channel's slop (`railWander`),
      // so the column is single file without being a ruled line.
      b.pos.y = C.CLASSIFIER_Y0 + st.s;
      const lane = railX + goalSide(a) * railWander(st.s, b.id, elevated);
      b.pos.x = approach(b.pos.x, lane, C.RAIL_BLEND_SPEED * dt);
      // Height follows the STRUCTURE, not the state: on the ramp it rides at the ramp's
      // surface, and past the channel mouth there is no ramp under it any more, so it comes
      // down to the floor over RAIL_DROP_S of travel — reaching 0 right where the release
      // already lands it. Without this it crossed the open apron at full ramp height and
      // sailed over any robot standing on the outflow.
      const rideZ = elevated ? surfaceZ : C.RAMP_SURFACE_Z;
      if (st.s >= C.RAIL_OPEN_S) {
        // still on the ramp: ease onto the ride height, so joining the rail never snaps
        b.z = approach(b.z, rideZ, C.RAIL_BLEND_SPEED * dt);
      } else {
        // past the wall the height is pure geometry, so it is ASSIGNED, not eased toward.
        // Easing cannot keep up: the artifact crosses this stretch in about 0.08s and
        // RAIL_BLEND_SPEED only buys 2.5in of fall in that time, so it left the wall at 10in,
        // arrived at the exit still 4.5in up, and snapped the rest — which is the sail-over
        // this is meant to remove. `min` keeps it monotonic so it can never bob back up.
        const fall = Math.min(1, Math.max(0, (C.RAIL_OPEN_S - st.s) / C.RAIL_DROP_S));
        b.z = Math.min(b.z, rideZ * (1 - fall));
      }
    }

    /**
     * THE SHOVE CARRIES THE COLUMN, or it is not a shove.
     *
     * The descent solver's constraints only ever STOP an artifact — `st.s = Math.min(floor,
     * wasS)` deliberately refuses to raise one, because a floor that moves must never yank
     * the column (that bug dragged the whole ramp up and down in time with a robot's
     * steering). So an artifact the paddle pushes back up-ramp would simply be driven into
     * the one behind it and overlap.
     *
     * When the paddle has actually pushed, relax the retained column UPWARD from the bottom:
     * nobody may sit closer than RAIL_PITCH to the artifact below. Rate-limited to
     * RAIL_PUSH_RATE, the same ceiling a robot leaning into the channel gets, so the column
     * visibly shifts up its ramp rather than teleporting.
     */
    if (pushedUp) {
      const packed = rail
        .filter((b) => !(b.state as { overflow: boolean }).overflow)
        .sort((p, q) => (p.state as { s: number }).s - (q.state as { s: number }).s);
      for (let i = 1; i < packed.length; i++) {
        const below = packed[i - 1].state as { s: number };
        const me = packed[i].state as { s: number; v: number };
        const min = below.s + C.RAIL_PITCH;
        if (me.s >= min) continue;
        me.s = Math.min(min, me.s + C.RAIL_PUSH_RATE * dt);
        if (me.v < 0) me.v = 0; // it has been stopped and lifted, not rolled
        packed[i].pos.y = C.CLASSIFIER_Y0 + me.s;
      }
    }

    // Balls past the exit roll out onto the floor from where they are — the LOWEST first, and
    // AT MOST ONE per tick, because the artifact just released becomes the doorway for the
    // next. `mouthClear` above already accounts for the doorway, so the solver has held
    // everything else above the exit rather than letting it descend into a refusal.
    const out = mouth;
    const leaving = rail.filter((b) => (b.state as { s: number }).s <= out.takeAt);
    for (const b of leaving.slice(0, 1)) {
      if (b.state.kind !== 'rail') continue; // narrowing; `rail` is pre-filtered by goal
      // NOTHING LEAVES INTO AN OCCUPIED MOUTH — the artifact stays on the rail and the
      // column queues behind it (see `railBlock`).
      if (out.s !== -Infinity) continue;
      // ...and if the LAST artifact out is still in the doorway, shove it clear and wait a
      // tick rather than materialising this one on top of it.
      {
        const ahead = doorway;
        if (ahead) {
          /**
           * TOP UP TO A CREEP — never ADD.
           *
           * This used to add a fraction of the exit velocity every tick the doorway was
           * occupied, which compounds: an artifact resting in the mouth was shoved again
           * and again and left at 91 in/s, far faster than anything the ramp could produce
           * and fast enough to travel the length of the field. The column is nudging a
           * stationary artifact out of the way, not firing it.
           *
           * So it sets a FLOOR on the outward component and leaves anything already faster
           * alone: the artifact creeps clear and nothing accumulates.
           */
          /**
           * ...BUT NOT INTO SOMETHING SOLID. The nudge is a FLOOR re-applied every tick the
           * doorway is occupied, and if the artifact cannot go anywhere — pinned between the
           * gate and a robot parked down the tunnel — the floor and the chassis take turns:
           * measured 60 direction reversals in two seconds, one every other tick, peaking at
           * 67.6 in/s. That is the artifact "moving back and forth" in front of the gate.
           *
           * A robot on the outflow means the mouth is blocked, and a blocked mouth is
           * supposed to STALL the column (railBlock already says so). So the column stops
           * shoving and simply waits, which is what it does behind any other obstruction.
           */
          const push = tunnelExitVel(a);
          const mag = hyp(push.x, push.y);
          const ux = push.x / mag;
          const uy = push.y / mag;
          /**
           * PINNED MEANS "CANNOT GO WHERE IT IS BEING PUSHED", not "is near a robot".
           *
           * This asked whether the artifact was inside a robot's footprint at all, which is
           * true of every artifact a robot is intaking off the gate — GATE INTAKING, holding
           * the lever with a front corner while the mouth eats the outflow, is a standard
           * technique and the guard throttled it to a crawl. Measured, holding the gate with
           * the drain running: 5 of 9 artifacts in 14s with the guard, 9 of 9 at a 0.323s
           * mean gap without it, which is the no-robot rate.
           *
           * So probe the position it is being nudged TOWARD. If that is still buried in a
           * robot the artifact genuinely has nowhere to go and shoving it just fights the
           * chassis (the doorway buzz: 60 reversals in two seconds). If the way out is
           * clear — a robot beside the gate, or its open mouth ahead of the artifact — the
           * nudge does what it is for.
           */
          /**
           * DO NOT SHOVE AN ARTIFACT INTO SOMETHING THAT WILL NOT TAKE IT.
           *
           * Two different situations look identical to a proximity test, and neither a
           * footprint test nor a chassis test separates them on its own — both were tried:
           *
           *  · the CHASSIS is about to shove it back. `solveBalls` gives a robot exactly one
           *    collider and it is the chassis, so this is the only thing that can fight the
           *    nudge. Re-flooring the velocity against it every tick is the doorway buzz:
           *    60 reversals in two seconds, peaking at 67 in/s.
           *  · it is sitting in an IDLE intake mouth. Nothing will move it, and shoving it
           *    deeper only starts the same fight against the eviction pass.
           *
           * A RUNNING intake is the case that must not be suppressed, and it is the common
           * one: GATE INTAKING — holding the lever with a front corner while the mouth eats
           * the outflow — puts an artifact in the mouth on every single release. Treating
           * that as pinned throttled it to 5 of 9 artifacts in 14s, against 9 of 9 at a
           * 0.32s mean gap (the no-robot rate) once the nudge is allowed to do its job.
           */
          const pinned = world.robots.some((rb) => {
            if (pointDepthInChassis(rb, ahead.pos) > -C.BALL_RADIUS * C.EXIT_PIN_FRAC) return true;
            const taking = (commands.get(rb.id)?.intake ?? false) || rb.autoIntake;
            return !taking && pointDepthInRobot(rb, ahead.pos) > -C.BALL_RADIUS * C.EXIT_PIN_FRAC;
          });
          if (!pinned) {
            // ...and it is shoved at the speed of the artifact arriving behind it, not at a
            // constant. `EXIT_NUDGE`'s own note says "the queue moves at the speed of the
            // flow that is pushing it"; a fixed 22.4 in/s is only that speed by coincidence,
            // and it becomes the ceiling for the whole drain. The constant stays as a FLOOR
            // for a column that has stalled and has no speed to lend.
            const flow = Math.abs((b.state as { v: number }).v);
            const target = Math.max(mag * C.EXIT_NUDGE, flow);
            const along = ahead.vel.x * ux + ahead.vel.y * uy;
            if (along < target) {
              ahead.vel.x += ux * (target - along);
              ahead.vel.y += uy * (target - along);
            }
          }
          continue;
        }
      }
      if (b.state.pending) {
        // flowed down the whole channel and out an open gate without ever
        // meeting the column: it was sorted, then released — CLASSIFIED
        b.state.pending = false;
        goal.classifiedCount++;
        addClassified(world, a);
      }
      const vel = tunnelExitVel(a);
      const r1 = nextRandom(world.rngState);
      world.rngState = r1.state;
      /**
       * MOMENTUM IS CARRIED OFF THE RAMP, not replaced at the bottom of it.
       *
       * This used to ASSIGN `tunnelExitVel` scaled by an independent 0.6-1.4 roll per axis,
       * throwing away whatever the artifact was actually doing. An artifact that had spent
       * the whole ramp accelerating under RAIL_ACCEL arrived at the exit and was handed a
       * different speed on the tick it touched the floor — sometimes slower, sometimes a
       * jump to 33 in/s, always a step change with no cause. Speed down a ramp comes from
       * gravity, and it should still be that speed at the bottom.
       *
       * So the ALONG-ramp component is the artifact's own: `v` for a classified artifact
       * (which RAIL_ACCEL has been building the whole way down) and the constant flow speed
       * for overflow, which rides over the column rather than rolling. Only the small
       * OFF-THE-WALL component is synthesised, and the jitter now fans DIRECTION rather than
       * scaling magnitude — the drain still spreads into a cone instead of a single file,
       * without anything changing pace as it lands.
       */
      // every artifact now carries its OWN speed off the ramp, overflow included — there is
      // no separate flow constant to substitute in
      const st0 = b.state as { v: number };
      const speed = Math.abs(st0.v);
      // The fan is a DIRECTION, not a speed: the exit heads down-tunnel with a little
      // off-the-wall lean, varied per artifact so a drain spreads into a cone instead of
      // single file. Normalised, so `speed` is the exact magnitude that comes out — the
      // artifact leaves the ramp at precisely the speed the ramp gave it.
      /**
       * IT ROLLS OFF A LIP AND FALLS. The ramp discharges above the floor (manual 9.8.3:
       * the gate's contact area is 3.75-5.5in up), so an artifact leaving it drops, lands,
       * and bounces — and THAT is what takes the speed out of it. Handing it a flat floor
       * velocity instead sent every artifact off on the same diagonal at ramp speed,
       * arriving halfway across the field when they should be settling in front of the
       * gate, along the tunnel, or in the human player zone.
       *
       * Released as a FLIGHT artifact at lip height with its ramp momentum, so the existing
       * ballistic + landing code does the work: gravity, a bounce that keeps
       * BALL_BOUNCE_H_RETAIN of the horizontal each time, then rolling friction. Nothing
       * scripted, and the scatter comes from where each one happens to land rather than
       * from a fan applied to all of them.
       */
      const lean = (C.TUNNEL_EXIT_VEL.inward / C.TUNNEL_EXIT_VEL.along) * (0.5 + r1.value);
      const norm = Math.sqrt(1 + lean * lean);
      /**
       * IT IS ON THE FLOOR THE TICK IT LEAVES, AT THE SPEED THE RAMP GAVE IT.
       *
       * Two things were tried here and both were wrong in ways worth remembering. Releasing
       * it as a FLIGHT artifact off a 3.75in lip is the honest geometry — it really does drop
       * — but 3.75in takes 0.14s and the bounces another 0.2s, and at this scale that does not
       * read as a ramp discharging, it reads as artifacts floating out of the wall. Charging
       * the drop's cost up front instead (multiply the horizontal by what a bounce keeps) puts
       * them on the floor but makes them change speed by 16in/s on the tick they arrive, which
       * is precisely the sudden step this release was rebuilt to get rid of.
       *
       * So neither: it lands immediately and keeps its speed, and BALL_ROLL_FRICTION takes it
       * out over the tunnel the way a ball rolling on foam tile actually stops. The exit is not
       * an event that does something to the artifact — it is just where the ramp ends.
       */
      b.state = { kind: 'ground' };
      b.z = 0;
      b.vz = 0;
      b.vel = { x: (Math.sign(vel.x) * lean * speed) / norm, y: (-speed) / norm };
    }
  }
}

/** the gate is a PHYSICAL push-to-open arm (manual 9.8.3): a robot shoves it the
 * ~2in open, and it is "closed by gravity" — released, it does NOT snap shut but
 * SWINGS closed, starting slow and accelerating as a hinged arm falls. A ball
 * streaming under the lifted arm physically holds it up (gravity suspended), so a
 * tap usually drains the whole column and the gate "may or may not stay open" a
 * moment after the last ball, matching "the GATE not closing immediately... is not
 * a FAULT". `gatePos` is the arm's continuous open fraction; `gateOpen` (a ball can
 * pass) is derived from it. */
export function updateGates(
  world: World,
  dt: number,
  commands: Map<number, RobotCommand>,
): void {
  for (const a of ['red', 'blue'] as Alliance[]) {
    const goal = world.goals[a];
    // The gate arm only lifts while a robot actively PRESSES it (push-to-open): a
    // robot merely loitering in the gate zone no longer opens it. Any robot can work
    // it (an opponent doing so is a MAJOR foul, penalties.ts). `ram` is how hard the
    // hardest pusher is driving into the handle — it scales the lift rate (ram harder ⇒
    // opens faster), and gateColliderPos anticipated this exact lift for the collider.
    let ram = 0;
    for (const r of world.robots) {
      const s = gateRamSpeed(r, commands.get(r.id) ?? ZERO_CMD, a);
      if (s > ram) ram = s;
    }
    const pushing = ram > 0;
    // A robot merely TOUCHING the (already-open) arm keeps it up — see the latch below.
    //
    // The CHASSIS touches it, not the intake-extended footprint. `robotIntersectsRect` grows
    // the box forward by the intake reach, and gate intaking parks exactly that reach across
    // the arm — so the mouth alone re-armed the latch every tick and pinned the arm at fully
    // open no matter what was under it. Measured: 10 of 12 gate-intaking poses held the arm
    // with the INTAKE only, gatePos stuck at 1.00 for four seconds over a completely stalled
    // column. The technique is holding the arm with a front CORNER, which is the bumper; the
    // mouth is an open frame and the lifted arm sits over it.
    const touching = world.robots.some((r) =>
      convexOverlap(chassisCorners(r), rectCorners(gateArmRect(a))),
    );
    const wasOpen = goal.gateOpen;

    /**
     * THE ARM IS PINNED UP ONLY WHILE A ROBOT IS ACTUALLY ON IT.
     *
     * A tap used to LATCH it at fully open for GATE_OPEN_LATCH_S — half a second of the
     * paddle hovering at maximum lift, clear of everything, with nobody touching it. A
     * hinged arm cannot do that, and it is why a tap emptied the whole ramp: measured, a
     * tap drained EVERY column up to six artifacts, two of them during the latch alone,
     * and the arm never got the chance to come down onto the flow at all.
     *
     * What a tap really does is throw the arm up and let go. `GATE_OPEN_LATCH_S` is now the
     * arm's mechanical OVERSWING — the moment of its own momentum carrying past the release
     * — and the rest of "it stays open a beat without holding" comes from where it actually
     * comes from: the FALL. Gravity takes ~0.23s to bring it from full lift back to the pass
     * line, artifacts flow the whole way down, and then it lands on the column and meters.
     * The product decision (a tap opens it; the driver does not keep pressing) is intact —
     * a tap still commits it fully open and still drains. It just no longer drains all of it.
     *
     * TOUCH-HOLD is unchanged and is the case that legitimately pins the arm: a robot
     * resting against an already-open arm really does hold it up, indefinitely, and that is
     * what makes a HELD gate stream.
     */
    const onArm = pushing || (touching && goal.gateOpen);
    if (pushing) goal.gateHoldTime += dt;
    else goal.gateHoldTime = 0;
    // the latch now tracks CONTACT (plus the overswing tail), not a free-floating timer
    goal.gateLatch =
      onArm && goal.gateHoldTime >= C.GATE_OPEN_HOLD
        ? C.GATE_OPEN_LATCH_S
        : Math.max(0, goal.gateLatch - dt);

    // HOW HARD THE FLOW IS SHOULDERING THE ARM. An artifact in the gateway props the OPEN
    // arm up — but a paddle resting on a ball is held up by the BALL, so what matters is
    // not merely that one is there, it is how fast it is going. `gatewaySpeed` is the
    // briskest down-ramp speed under the arm right now (0 if the gateway is empty or
    // whatever is in it has stalled). It only ever HOLDS an already-open arm — a ball
    // reaching an almost-closed gate must NOT lift it back open (only a robot push does).
    // (LOCALS, deliberately — GoalState rides the network snapshot, and both are
    // recomputed from world state every tick anyway)
    let gatewaySpeed = 0;
    // ...and how high the artifacts physically sitting under the arm hold it, which is a
    // question about GEOMETRY and not about speed: the paddle's edge lands where the
    // vertical at the gate line meets an artifact's surface (gateRestOn). Without this the
    // arm fell through a stalled artifact to fully shut, so it only ever came to rest in
    // the gap BETWEEN two of them.
    let gatewayRest = 0;
    for (const b of world.balls) {
      if (b.state.kind !== 'rail' || b.state.goal !== a) continue;
      if (b.state.overflow) continue; // rides OVER the gate (9.8.3) — never under the paddle
      // ONLY WHAT IS ACTUALLY UNDER THE PADDLE. Nothing else can be holding it up.
      if (!underPaddle(b.state.s - C.GATE_LINE_S)) continue;
      const down = -b.state.v; // v is negative down-ramp
      if (down > gatewaySpeed) gatewaySpeed = down;
      const rest = gateRestOn(b.state.s - C.GATE_LINE_S);
      if (rest > gatewayRest) gatewayRest = rest; // whichever holds it highest is the one bearing it
    }

    if (goal.gateLatch > 0) {
      // latched open (a push, or resting against the open arm): lift toward fully open at
      // the ram-scaled rate (a harder push swings it up faster — matches gateColliderPos).
      // A robot holds the paddle CLEAR of the flow, which is why a held gate has no cadence.
      goal.gatePos = Math.min(1, goal.gatePos + gateLiftRate(ram) * dt);
      goal.gateVel = 0;
    } else if (goal.gatePos > 0) {
      // Released and unheld, the arm falls closed under gravity, starting slow and
      // accelerating (variable, non-instant close — manual 9.8.3) — and it falls onto
      // WHATEVER IS UNDER IT. It used to be frozen in place by the mere presence of an
      // artifact in the gateway, so a tapped gate hovered at 1.0 with the flow passing
      // beneath it untouched and drained exactly as fast as a held one. It cannot hover:
      // an artifact is a ball's worth of lift (GATE_RIDE_FRAC) and no more, and it can
      // only hold the paddle that high if it is actually moving (GATE_SHOULDER_LIFT) —
      // a faltering artifact lets the arm settle onto it and the drain stops there.
      const wasPos = goal.gatePos;
      // FLOW MOMENTUM CUSHIONS THE FALL. Artifacts streaming under the paddle knock it back
      // up as fast as gravity brings it down, so a brisk stream nearly suspends the descent
      // and an empty gateway lets it fall at full gravity. Separate from the height floor
      // below: that says how LOW it may go, this says how FAST it gets there.
      const cushion = Math.max(0, 1 - gatewaySpeed / C.GATE_FLOW_CUSHION);
      goal.gateVel = Math.max(
        goal.gateVel - C.GATE_GRAVITY * cushion * dt,
        -C.GATE_CLOSE_MAX * cushion,
      );
      goal.gatePos = Math.max(0, goal.gatePos + goal.gateVel * dt);
      // What is under the arm holds it up two ways, and it comes to rest on the higher:
      // a MOVING artifact keeps knocking it up (speed), and one that has STOPPED simply
      // holds it at whatever height the paddle landed on it (geometry).
      const rest = Math.max(
        Math.min(C.GATE_RIDE_FRAC, gatewaySpeed * C.GATE_SHOULDER_LIFT),
        gatewayRest,
      );
      // IT CAN COME TO REST ON SOMETHING; IT CANNOT BE LIFTED BY IT. Same shape as the rail
      // solver's `wasS >= base`: a floor may stop the arm where it already is, never reach
      // up and raise it. This is what keeps "a ball reaching an almost-closed gate must not
      // reopen it" true now that the floor is geometric rather than gated on `gateOpen` —
      // an artifact rolling under a shut arm finds it below its own rest height and is
      // simply blocked, while one the arm descends ONTO stops it dead.
      if (wasPos >= rest && goal.gatePos < rest) {
        goal.gatePos = rest;
        goal.gateVel = 0;
      }
      if (goal.gatePos === 0) goal.gateVel = 0;
    }

    // an artifact can pass once the arm has lifted past the pass fraction
    goal.gateOpen = goal.gatePos >= C.GATE_PASS_FRAC;
    if (goal.gateOpen && !wasOpen) world.events.push('GATE OPEN');
  }
}
