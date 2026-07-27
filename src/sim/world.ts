import type { Alliance, RobotCommand, World } from '../types';
import * as C from '../config';
import {
  clampGroundBall,
  collideBallBall,
  collideBallHeld,
  collideBallRect,
  collideBallRobot,
  collideBallStatic,
  squareUpRobots,
  stepFlightBall,
  stepGroundBall,
  heldSlotPos,
} from './physics';
import { rot, approach } from '../math';
import { solveBalls, solveRobots } from './physicsEngine';
import { decodeColliders } from '../games/decode/colliders';
import { classifierRect } from './field';
import { updateRobot, updateRobotActions } from './robot';
import { checkGoalEntry, gateColliderPos, updateBasins, updateGates, updateRails } from './goal';
import { updateHumanPlayers } from './humanPlayer';
import { robotsEnabled, stepMatch } from './match';
import { updateProvisionalPattern } from './scoring';
import { updatePenalties } from './penalties';
import { initializePathTraversal, updatePathTraversal } from './pathTraversal';

const ZERO_CMD: RobotCommand = {
  driveX: 0,
  driveY: 0,
  rotate: 0,
  leftDrive: 0,
  rightDrive: 0,
  intake: false,
  fire: false,
};

/** advance the world by one fixed timestep. Deterministic: consumes only the
 * given commands and the world's own seeded PRNG. */
export function step(world: World, dt: number, commands: Map<number, RobotCommand>): void {
  world.time += dt;
  world.tick++;

  const enabled = robotsEnabled(world);
  world.rrContacts.length = 0;

  // Create a map for the actual commands being executed by each robot this tick
  const actualCommands = new Map<number, RobotCommand>();

  for (const r of world.robots) {
    let currentCmd = enabled ? (commands.get(r.id) ?? ZERO_CMD) : ZERO_CMD;

    // Auto pathing logic: if active, override driver commands
    if (world.match.phase === 'auto' && r.autoPathActive) {
      // Use r.autoPath directly, which is already mirrored if necessary
      if (r.autoPath) {
        // Initialize auto path once at the very beginning of the auto phase
        if (
          r.pathSequenceIndex === 0 &&
          r.pathSegmentProgress === 0 &&
          r.pathWaitTimer === 0
        ) {
          initializePathTraversal(r);
        }
        // Update robot's position and heading directly via path traversal
        // Capture the command returned by updatePathTraversal, which now includes intake/fire states.
        currentCmd = updatePathTraversal(r, world, dt);
        // Zero out velocity and angular velocity for path-following robots
        // so physics engine doesn't try to move them based on old velocities.
        r.vel = { x: 0, y: 0 };
        r.angVel = 0;
      } else {
        // If autoPathActive was true but no path data found in robot, deactivate
        r.autoPathActive = false;
      }
    }
    actualCommands.set(r.id, currentCmd);
  }

  // ---- robots (movement) -------------------------------------------------
  for (const r of world.robots) {
    // Only call updateRobot for robots NOT on an auto path.
    // Robots on auto path have their pos/heading set by updatePathTraversal
    // and their velocities zeroed out.
    if (!r.autoPathActive) {
      updateRobot(world, r, actualCommands.get(r.id) ?? ZERO_CMD, dt);
    }
  }

  // robot translation + velocity: resolved by Rapier (walls, goal faces,
  // classifier channels, mass-weighted robot-robot shoving, velocity-kill). The
  // bespoke square-up pass then rotates tilted chassis flush and records the
  // robot-robot contacts (rrContacts) the penalty engine consumes.
  // This will run for all robots. For autoPathActive robots, since their velocities
  // were zeroed, they should ideally not move much due to physics, unless pushed.
  // anticipate this tick's gate-arm lift so the handle collider retracts on the SAME
  // tick a robot rams it open (no 1-tick jolt) — updateGates applies the matching lift.
  const gateCol: Record<Alliance, number> = {
    red: gateColliderPos(world, dt, actualCommands, 'red'),
    blue: gateColliderPos(world, dt, actualCommands, 'blue'),
  };
  const preVels = solveRobots(world, dt, decodeColliders, gateCol);
  squareUpRobots(world, preVels);

  // ---- robots (actions: intake/fire/turret) ------------------------------
  // passive dummies never act — skip the aim solve / flywheel / fire / intake work
  for (const r of world.robots) {
    if (r.passive) continue;
    updateRobotActions(world, r, actualCommands.get(r.id) ?? ZERO_CMD, dt);
  }

  // ---- penalties: rrContacts + final robot poses are settled for this tick -
  updatePenalties(world, dt, actualCommands);

  // ---- balls ---------------------------------------------------------------
  // GROUND balls: rolling friction (velocity only) → Rapier solve (ball↔ball,
  // ball↔wall, ball↔goal-face, ball↔classifier) → bespoke ball↔robot (pin
  // feedback / outflow-no-shove, kept scripted for feel) → hard field clamp.
  for (const b of world.balls) {
    if (b.state.kind === 'ground') stepGroundBall(b, dt);
  }
  solveBalls(world, dt, decodeColliders);
  // ball↔robot stays bespoke (see solveRobots): the pin stall + outflow-no-shove
  // are deliberately non-physical. Iterated so a robot→ball→(wall/ball) chain
  // converges instead of tunnelling in a single pass.
  const heldBalls = world.balls.filter((b) => b.state.kind === 'held');
  for (let pass = 0; pass < C.BALL_SOLVER_ITERATIONS; pass++) {
    for (const b of world.balls) {
      if (b.state.kind !== 'ground') continue;
      for (const r of world.robots) collideBallRobot(b, r);
      // held balls physically occupy the intake — incoming balls pile up on them
      for (const h of heldBalls) collideBallHeld(b, h);
    }
  }
  // hard field clamp: Rapier's soft contacts (and the bespoke ball↔robot push)
  // can leave a ~0.2in penetration, so snap ground balls back inside the walls /
  // goal faces (containment is tolerance-tight). ALSO geometrically evict from the
  // classifier channel: Rapier's contact solver can't clear a DEEPLY embedded ball
  // (a flight ball that landed inside the channel becomes 'ground' before the
  // flight-phase eviction runs, then stays meshed + ungrabbable — the robot's OBB
  // can't reach into the channel). collideBallRect pushes it out the field side,
  // the only valid exit, exactly like the wall/goal clamp. Tunnel-exit balls become
  // 'ground' at the channel's bottom edge already moving out, so they're unaffected.
  for (const b of world.balls) {
    if (b.state.kind !== 'ground') continue;
    collideBallRect(b, classifierRect('red'));
    collideBallRect(b, classifierRect('blue'));
    clampGroundBall(b);
  }

  // ---- balls: FLIGHT (ground balls resolved above) -------------------------
  // Flight stays bespoke: ballistic arc + z axis (Rapier 2D has no z), goal-face
  // bounce below the lip, and the ground-bounce landing transition. A ball that
  // lands becomes 'ground' and joins the ground solve next tick.
  for (const b of world.balls) {
    if (b.state.kind !== 'flight') continue;
    const prevZ = b.z;
    stepFlightBall(b, dt);
    if (checkGoalEntry(world, b, prevZ)) continue;
    if (b.z < C.GOAL_WALL_TOP) collideBallStatic(b);
    if (b.z <= 0 && b.vz < 0) {
      b.z = 0;
      b.vz = -b.vz * C.BALL_GROUND_RESTITUTION;
      b.vel.x *= C.BALL_BOUNCE_H_RETAIN;
      b.vel.y *= C.BALL_BOUNCE_H_RETAIN;
      if (b.vz < 20) {
        b.vz = 0;
        b.state = { kind: 'ground' };
      }
    }
  }

  // low flight balls collide bespoke with robots + other low flight balls (rare
  // — the shooter never misses, so a shot is almost never near a robot in the
  // plane). Ground balls are Rapier bodies and handled there; a flight↔ground
  // cross-collision is the accepted deferral of the ground-only slice.
  const activeFlight = world.balls.filter(
    (b) => b.state.kind === 'flight' && b.z < C.BALL_RADIUS * 4,
  );
  for (let pass = 0; pass < C.BALL_SOLVER_ITERATIONS; pass++) {
    for (let i = 0; i < activeFlight.length; i++) {
      for (let j = i + 1; j < activeFlight.length; j++) {
        collideBallBall(activeFlight[i], activeFlight[j]);
      }
    }
    for (const b of activeFlight) {
      if (b.z > 14) continue;
      for (const r of world.robots) collideBallRobot(b, r);
    }
  }
  for (const b of activeFlight) {
    if (b.z > 16) continue;
    collideBallRect(b, classifierRect('red'));
    collideBallRect(b, classifierRect('blue'));
  }
  for (const b of activeFlight) collideBallStatic(b);

  // ---- goals: basin jumble, rail flow, gate ---------------------------------
  updateGates(world, dt, actualCommands);
  updateBasins(world, dt);
  updateRails(world, dt);
  updateHumanPlayers(world);

  // ---- match flow ----------------------------------------------------------
  stepMatch(world, dt);
  updateProvisionalPattern(world);

  // ---- held balls: slide each captured ball toward its storage slot ----------
  positionHeldBalls(world, dt);
}

/** Park each HELD ball at its robot's storage slot, moving rigidly WITH the robot
 * but SLIDING (in the robot frame) toward its slot — so the triangle's front ball
 * slides aside when a 3rd arrives. A held ball whose robot is gone drops to the floor. */
function positionHeldBalls(world: World, dt: number): void {
  for (const b of world.balls) {
    if (b.state.kind !== 'held') continue;
    const st = b.state;
    const r = world.robots.find((rr) => rr.id === st.robot);
    if (!r) {
      b.state = { kind: 'ground' };
      continue;
    }
    // slide the STORED local offset toward the slot (no world round-trip, so the
    // ball tracks the robot rigidly — no lag when it drives)
    const target = heldSlotPos(r.spec, st.slot, st.side);
    st.lx = approach(st.lx, target.x, C.HELD_SLIDE_SPEED * dt);
    st.ly = approach(st.ly, target.y, C.HELD_SLIDE_SPEED * dt);
    const wp = rot({ x: st.lx, y: st.ly }, r.heading);
    b.pos = { x: r.pos.x + wp.x, y: r.pos.y + wp.y };
    b.vel = { x: r.vel.x, y: r.vel.y };
    b.z = 0;
    b.vz = 0;
  }
}