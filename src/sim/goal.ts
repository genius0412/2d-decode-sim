import type { Alliance, Artifact, RobotCommand, RobotState, World } from '../types';
import * as C from '../config';
import {
  basinFunnelTarget,
  gateArmRect,
  goalCenter,
  goalFaceNormal,
  goalLineValue,
  goalSide,
  railPos,
  tunnelExitVel,
  viewAngleOf,
} from './field';
import { addClassified, addOverflow } from './scoring';
import { approach, nextRandom, hyp, rot } from '../math';
import { pointDepthInRobot, robotExtents, robotIntersectsRect } from './physics';

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
 *   `taker` — a robot reaching the channel WITH room in its hopper. The artifact drops
 *             straight into it, which is what happens on the real field: you park under the
 *             gate to collect the drain.
 *   `s`     — how far up the rail a FULL robot's body reaches. That becomes the column's
 *             floor, so it backs up against the bumper wherever the bumper actually is.
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
    const top = C.RAIL_EXIT_S + hyp(e.front + e.rear, e.half * 2) + C.BALL_RADIUS;
    // Walk UP and keep the LAST position an artifact could not occupy — `pointDepthInRobot`
    // is a signed distance, so `> -BALL_RADIUS` means the artifact's skin would be in the
    // bumper. The floor is one step above that, which this walk has already tested and found
    // clear. Deriving it instead as "deepest blocked sample plus a radius" left up to 0.75in
    // of overlap, because a radius along the rail is not a radius along the surface normal of
    // a robot sitting at an angle to it.
    // Fixed step, deterministic, and well under an artifact radius so nothing slips through.
    let reach = -Infinity;
    for (let s = C.RAIL_EXIT_S; s <= top; s += C.RAIL_BLOCK_STEP) {
      if (pointDepthInRobot(r, railPos(a, s)) > -C.BALL_RADIUS) reach = s + C.RAIL_BLOCK_STEP;
    }
    if (reach > best) {
      best = reach;
      who = r;
    }
  }
  if (who === null) return { s: -Infinity, taker: null, takeAt: C.RAIL_EXIT_S };
  // A ROBOT WITH ROOM COLLECTS RATHER THAN BLOCKS (unchanged): it is standing under the
  // gate intaking the drain, so the artifact goes into its hopper instead of piling on it.
  // ...and it collects WHERE ITS BODY IS (`takeAt`), not at the fixed exit point. Handing the
  // artifact over at RAIL_EXIT_S meant it first travelled the length of the robot's own
  // footprint to get there — through the chassis — which is the same point-vs-body mistake as
  // the block, just on the friendly branch of it.
  if (who.hopper.length < C.HOPPER_CAPACITY) return { s: -Infinity, taker: who, takeAt: best };
  return { s: best, taker: null, takeAt: C.RAIL_EXIT_S };
}

/** the artifact still sitting in the gate's doorway, if any — the one the column has to
 * push out of the way before the next can leave. */
function doorwayArtifact(world: World, a: Alliance): Artifact | null {
  const p = railPos(a, C.RAIL_EXIT_S);
  for (const b of world.balls) {
    if (b.state.kind !== 'ground') continue;
    if (hyp(b.pos.x - p.x, b.pos.y - p.y) < C.BALL_RADIUS * 2 + C.EXIT_CLEARANCE) return b;
  }
  return null;
}

/** 1D flow down the classifier rail with contact stacking against the gate
 * (or the ball ahead). Overflow balls ride over everything and always exit. */
export function updateRails(world: World, dt: number): void {
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
    const doorway = mouth.taker ? null : doorwayArtifact(world, a);
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
    const gateBase = canLeave ? -Infinity : goal.gateOpen ? C.RAIL_EXIT_S : C.GATE_STOP_S;
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
    let rampAhead = -Infinity;
    let rampFloorV = 0;
    // ...and the same pair for an ELEVATED artifact: never stopped by the gate, only by the exit
    // being physically occupied or by another elevated artifact ahead of it
    let overAhead = -Infinity;
    let overFloorV = 0;
    let retainedBelow = 0;

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
      // clambering over artifacts is lossy in a way a ramp is not — this is what makes
      // overflow slower, rather than a speed handed to it. Terminal speed while riding is
      // RAIL_ACCEL / OVERFLOW_DRAG.
      if (elevated) st.v *= Math.max(0, 1 - C.OVERFLOW_DRAG * dt);
      st.s += st.v * dt;

      const ahead = elevated ? overAhead : rampAhead;
      const base = elevated ? overBase : rampBase;
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
      // glide smoothly onto the rail line — no positional snapping
      b.pos.y = C.CLASSIFIER_Y0 + st.s;
      b.pos.x = approach(b.pos.x, railX, C.RAIL_BLEND_SPEED * dt);
      b.z = approach(b.z, elevated ? C.OVERFLOW_Z : C.RAMP_SURFACE_Z, C.RAIL_BLEND_SPEED * dt);
    }

    // Balls past the exit roll out onto the floor from where they are — the LOWEST first, and
    // AT MOST ONE per tick, because the artifact just released becomes the doorway for the
    // next. `mouthClear` above already accounts for the doorway, so the solver has held
    // everything else above the exit rather than letting it descend into a refusal.
    const out = mouth;
    const leaving = rail.filter((b) => (b.state as { s: number }).s <= out.takeAt);
    for (const b of leaving.slice(0, 1)) {
      if (b.state.kind !== 'rail') continue; // narrowing; `rail` is pre-filtered by goal
      // NOTHING LEAVES INTO AN OCCUPIED MOUTH. Without a taker to hand it to, the artifact
      // stays on the rail and the column queues behind it (see `railBlock`).
      if (out.s !== -Infinity) continue;
      // ...and if the LAST artifact out is still in the doorway, shove it clear and wait a
      // tick rather than materialising this one on top of it.
      if (!out.taker) {
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
          const push = tunnelExitVel(a);
          const mag = hyp(push.x, push.y);
          const ux = push.x / mag;
          const uy = push.y / mag;
          const target = mag * C.EXIT_NUDGE;
          const along = ahead.vel.x * ux + ahead.vel.y * uy;
          if (along < target) {
            ahead.vel.x += ux * (target - along);
            ahead.vel.y += uy * (target - along);
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
      // A ROBOT PARKED UNDER THE GATE COLLECTS THE DRAIN — the artifact goes straight into
      // its hopper rather than through it onto the floor. It stays a physical world object
      // (`held`), seeded from where it actually is, so it slides in from the mouth like any
      // other intake instead of appearing in a slot.
      if (out.taker && out.taker.hopper.length < C.HOPPER_CAPACITY) {
        const r = out.taker;
        const loc = rot({ x: b.pos.x - r.pos.x, y: b.pos.y - r.pos.y }, -r.heading);
        b.state = { kind: 'held', robot: r.id, slot: r.hopper.length, lx: loc.x, ly: loc.y, side: 0 };
        b.vel = { x: 0, y: 0 };
        b.z = 0;
        b.vz = 0;
        r.hopper.push(b.color);
        continue;
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
    // a robot merely TOUCHING the (already-open) arm keeps it up — see the latch below
    const touching = world.robots.some((r) => robotIntersectsRect(r, gateArmRect(a)));
    const wasOpen = goal.gateOpen;

    if (pushing) {
      // a push (past the tiny debounce) COMMITS the arm open and re-arms a latch — the
      // driver does NOT have to keep pressing: a tap lifts it fully and it stays up.
      goal.gateHoldTime += dt;
      if (goal.gateHoldTime >= C.GATE_OPEN_HOLD) goal.gateLatch = C.GATE_OPEN_LATCH_S;
    } else if (touching && goal.gateOpen) {
      // resting against an already-OPEN gate holds it open without re-pushing (the light
      // arm doesn't shove the robot off). NOT a way to OPEN a closed gate — that needs a
      // push — so loitering against a shut gate still does nothing.
      goal.gateHoldTime = 0;
      goal.gateLatch = C.GATE_OPEN_LATCH_S;
    } else {
      goal.gateHoldTime = 0;
      goal.gateLatch = Math.max(0, goal.gateLatch - dt);
    }

    // a ball occupying the gateway props the OPEN arm up: gravity can't swing it shut
    // while artifacts stream underneath. It only HOLDS an already-open arm — a ball
    // reaching an almost-closed gate must NOT lift it back open (only a robot push does).
    const ballInGateway = world.balls.some(
      (b) =>
        b.state.kind === 'rail' &&
        b.state.goal === a &&
        b.state.s > C.GATE_CLOSE_CLEAR_LO &&
        b.state.s < C.GATE_CLOSE_CLEAR_HI,
    );

    if (goal.gateLatch > 0) {
      // latched open (a push, or resting against the open arm): lift toward fully open at
      // the ram-scaled rate (a harder push swings it up faster — matches gateColliderPos)
      goal.gatePos = Math.min(1, goal.gatePos + gateLiftRate(ram) * dt);
      goal.gateVel = 0;
    } else if (goal.gateOpen && ballInGateway) {
      // an artifact is streaming under the OPEN arm — HOLD its position (gravity
      // suspended) but do NOT lift it, so a new ball can't reopen a near-closed gate
      goal.gateVel = 0;
    } else if (goal.gatePos > 0) {
      // released and unheld: the arm falls closed under gravity, starting slow and
      // accelerating (variable, non-instant close — manual 9.8.3)
      goal.gateVel = Math.max(goal.gateVel - C.GATE_GRAVITY * dt, -C.GATE_CLOSE_MAX);
      goal.gatePos = Math.max(0, goal.gatePos + goal.gateVel * dt);
      if (goal.gatePos === 0) goal.gateVel = 0;
    }

    // an artifact can pass once the arm has lifted past the pass fraction
    goal.gateOpen = goal.gatePos >= C.GATE_PASS_FRAC;
    if (goal.gateOpen && !wasOpen) world.events.push('GATE OPEN');
  }
}
