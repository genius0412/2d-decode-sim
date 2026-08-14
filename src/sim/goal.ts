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
import { pointDepthInRobot, robotIntersectsRect } from './physics';

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
 * So the mouth is checked before anything leaves:
 *   `taker`  — a robot over the mouth WITH room in its hopper. The artifact drops straight
 *              into it, which is what happens on the real field: you park under the gate to
 *              collect the drain.
 *   `blocked`— a FULL robot is over the mouth. Nothing leaves; the column backs up behind
 *              the gate exactly as it does behind a closed one.
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
function exitMouth(world: World, a: Alliance): { taker: RobotState | null; blocked: boolean } {
  const p = railPos(a, C.RAIL_EXIT_S);
  for (const r of world.robots) {
    // the mouth counts as occupied once the robot's body reaches within an artifact radius
    if (pointDepthInRobot(r, p) < -C.BALL_RADIUS) continue;
    return r.hopper.length < C.HOPPER_CAPACITY ? { taker: r, blocked: false } : { taker: null, blocked: true };
  }
  return { taker: null, blocked: false };
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

    // stacked balls flow together as a packed column: a ball resting on the one
    // below inherits ITS velocity (floorV) rather than stopping, so when the
    // gate opens the whole column drains as a unit instead of each ball
    // re-accelerating from rest and spreading apart.
    const stack = railStack(world, a);
    // A BLOCKED MOUTH IS A CLOSED GATE, as far as the column is concerned — it queues at the
    // exit instead of flowing through whatever is parked there.
    const mouth = exitMouth(world, a);
    const canLeave = goal.gateOpen && (!mouth.blocked || mouth.taker !== null);
    let floor = canLeave ? -Infinity : goal.gateOpen ? C.RAIL_EXIT_S : C.GATE_STOP_S;
    let floorV = 0; // velocity of the constraint below (the gate is stationary)
    let below = 0; // column balls ahead of (below) the current one
    for (const b of stack) {
      const st = b.state as { s: number; v: number; overflow: boolean; pending?: boolean };
      st.v = Math.max(st.v - C.RAIL_ACCEL * dt, -C.RAIL_TERMINAL);
      st.s += st.v * dt;
      if (st.s < floor) {
        // first contact with the gate stop or the ball ahead: a pending ball
        // decides HERE — meeting a full column (9 below) diverts it over the
        // top as OVERFLOW; otherwise it settles into the column CLASSIFIED
        if (st.pending && below >= C.RAMP_SLOTS) {
          st.pending = false;
          st.overflow = true;
          st.v = -C.OVERFLOW_FLOW_SPEED;
          goal.overflowCount++;
          addOverflow(world, a);
          continue; // rides over from here on — handled by the overflow pass
        }
        st.s = floor;
        // move WITH the ball below (0 against the closed gate) — the column
        // stays packed and drains together instead of stopping/re-accelerating
        st.v = Math.max(st.v, floorV);
        if (st.pending) {
          st.pending = false;
          goal.classifiedCount++;
          addClassified(world, a);
        }
      }
      floor = st.s + C.RAIL_PITCH;
      floorV = st.v;
      below++;
      // glide smoothly onto the rail line — no positional snapping
      b.pos.y = C.CLASSIFIER_Y0 + st.s;
      b.pos.x = approach(b.pos.x, railX, C.RAIL_BLEND_SPEED * dt);
      b.z = approach(b.z, C.RAMP_SURFACE_Z, C.RAIL_BLEND_SPEED * dt);
    }

    // Overflow balls ride OVER the stack at constant flow — the manual's "OVERFLOW ARTIFACTS
    // can pass over the top of the GATE to exit the RAMP" — but they still STOP AT THE EXIT.
    // This used to run with no floor at all, which was invisible while every artifact was
    // released the instant it reached RAIL_EXIT_S: now that the release waits for a clear
    // doorway, an ungated overflow artifact kept decrementing `s` and marched off down the
    // tunnel and out of the field, still in `rail` state, never stopping.
    const overflow = world.balls
      .filter((b) => b.state.kind === 'rail' && b.state.goal === a && b.state.overflow)
      .sort((p, q) => (p.state as { s: number }).s - (q.state as { s: number }).s || p.id - q.id);
    // flow first...
    for (const b of overflow) {
      const st = b.state as { s: number };
      st.s = Math.max(C.RAIL_EXIT_S, st.s - C.OVERFLOW_FLOW_SPEED * dt);
    }
    // ...then QUEUE them, nose to tail from the exit upward. Without this they all clamp to
    // RAIL_EXIT_S and sit inside one another: rail artifacts are positioned by `s` alone, so
    // the ground solver's separation pass never sees them and a blocked exit stacks the lot
    // on a single point.
    let queue = C.RAIL_EXIT_S;
    for (const b of overflow) {
      const st = b.state as { s: number };
      if (st.s < queue) st.s = queue;
      queue = st.s + C.RAIL_PITCH;
      b.pos.y = C.CLASSIFIER_Y0 + st.s;
      b.pos.x = approach(b.pos.x, railX, C.RAIL_BLEND_SPEED * dt);
      b.z = approach(b.z, C.OVERFLOW_Z, C.RAIL_BLEND_SPEED * dt);
    }

    // balls past the gate roll out onto the floor from where they are
    const out = exitMouth(world, a);
    for (const b of world.balls) {
      if (b.state.kind !== 'rail' || b.state.goal !== a) continue;
      if (b.state.s > C.RAIL_EXIT_S) continue;
      // NOTHING LEAVES INTO AN OCCUPIED MOUTH. Without a taker to hand it to, the artifact
      // stays on the rail and the column queues behind it (see `exitMouth`).
      if (out.blocked && !out.taker) continue;
      // ...and if the LAST artifact out is still in the doorway, shove it clear and wait a
      // tick rather than materialising this one on top of it.
      if (!out.taker) {
        const ahead = doorwayArtifact(world, a);
        if (ahead) {
          const push = tunnelExitVel(a);
          ahead.vel.x += push.x * C.EXIT_NUDGE;
          ahead.vel.y += push.y * C.EXIT_NUDGE;
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
      let r1 = nextRandom(world.rngState);
      let r2 = nextRandom(r1.state);
      world.rngState = r2.state;
      b.state = { kind: 'ground' };
      b.z = 0;
      b.vz = 0;
      // gentle release, SAME treatment the overflow balls get: low forward
      // momentum (friction + ball↔ball contact spread the drain instead of it
      // plowing out) with an INDEPENDENT x/y jitter that fans the exit directions
      // into a cone. A symmetric perpendicular kick was tried and split the tight
      // drain column into TWO diverging branches — the independent jitter keeps
      // every ball moving in the same quadrant, so they fan out instead.
      b.vel = { x: vel.x * (0.6 + r1.value * 0.8), y: vel.y * (0.6 + r2.value * 0.8) };
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
