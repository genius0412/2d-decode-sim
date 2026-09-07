import type { Alliance, RobotCommand, Vec2, World } from '../types';
import * as C from '../config';
import {
  clampGroundBall,
  collideBallBall,
  collideBallHeld,
  collideBallRect,
  ballRobotFeedback,
  collideBallRobot,
  landOnIntakeLid,
  ballWedgedInRobot,
  pointDepthInRobot,
  collideBallStatic,
  separateBalls,
  evictBallFromRobot,
  squareUpRobots,
  stepFlightBall,
  stepGroundBall,
  heldSlotPos,
} from './physics';
import { rot, approach, hyp } from '../math';
import { solveBalls, solveRobots } from './physicsEngine';
import { decodeColliders } from '../games/decode/colliders';
import { classifierRect } from './field';
import { intakeClaims, updateRobot, updateRobotActions, type DriveWrench } from './robot';
import { driveParams } from './drivetrain';
import { checkGoalEntry, doorwayArtifact, gateColliderPos, updateBasins, updateGates, updateRails } from './goal';
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
        const wasAt = { x: r.pos.x, y: r.pos.y };
        currentCmd = updatePathTraversal(r, world, dt);
        /**
         * ...AND `vel` IS THE SWEEP IT JUST MADE, not zero.
         *
         * The path TELEPORTS the chassis (1.56 in/tick at the default spec), and the velocity
         * used to be zeroed here on the reasoning that physics must not move a path robot from
         * its old velocity. Physics no longer can — the body is KINEMATIC now — but the solver
         * still needs to know it is moving, or the only thing acting on whatever is in its way
         * is the soft positional correction, which cannot keep up with a teleport. Measured
         * with the velocity zeroed: overlap grew monotonically to 15.2 in on an 17.5 in pair
         * until the SAT min axis flipped and the bystander was squirted 4 in sideways and 3 in
         * backwards, after which the path robot passed straight through it. With the sweep
         * velocity set, peak penetration is 0.00 in and the bystander is pushed along.
         *
         * `solveBalls` has always given its kinematic chassis body `r.vel` for the same reason;
         * the robot solve was the inconsistent one. It is also simply the truth — this robot IS
         * travelling at that speed, and everything else that reads `vel` (the HUD, shot lead
         * compensation, the G422 pin test's speed gate) was being told otherwise.
         *
         * A JUMP IS NOT A SWEEP. `initializePathTraversal` places the chassis on the path's
         * start point, and a sequence can step between segments that do not touch — both are
         * teleports of arbitrary size, and dividing one by `dt` gives thousands of in/s that
         * would fire everything nearby across the field (measured: the initial placement alone
         * blasted a bystander 60 in). A displacement the robot could not have driven is not
         * motion this model can represent, so it reports none. The margin is slack for a path
         * whose nominal speed sits a hair above the drivetrain's own.
         */
        const swept = { x: (r.pos.x - wasAt.x) / dt, y: (r.pos.y - wasAt.y) / dt };
        const walkable = driveParams(r.spec, r.butterflyTank).maxSpeed * 1.5;
        r.vel = hyp(swept.x, swept.y) <= walkable ? swept : { x: 0, y: 0 };
        r.angVel = 0;
      } else {
        // If autoPathActive was true but no path data found in robot, deactivate
        r.autoPathActive = false;
      }
    }
    actualCommands.set(r.id, currentCmd);
  }

  // ---- robots (movement) -------------------------------------------------
  // The drive model no longer writes velocity: it returns the FORCE the wheels are asking
  // for and the solve below applies it (see `updateRobot`). A robot on an auto path is
  // posed by the path and asks for nothing.
  const drive = new Map<number, DriveWrench>();
  for (const r of world.robots) {
    if (!r.autoPathActive) {
      drive.set(r.id, updateRobot(world, r, actualCommands.get(r.id) ?? ZERO_CMD, dt));
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
  // CLEARED HERE, NOT AT THE TOP OF THE TICK. The drive phase above reads `rrContacts` to
  // tell a robot being LEANED ON from one stopping itself (see `MOTOR_SHOVE_BRAKE`), and it
  // runs before the pass that records them — so the list has to survive the drive phase and
  // carry last tick's contacts into it. Nothing between the top of `step` and here reads it.
  world.rrContacts.length = 0;
  const preVels = solveRobots(world, dt, decodeColliders, gateCol, drive);
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
  // WHERE EACH GROUND ARTIFACT STARTED THE TICK — the classifier eviction needs it, so it
  // can walk an artifact back along the path it took instead of shoving it out the nearest
  // face by depth+radius. One Vec2 per ground artifact.
  const ballFrom = new Map<number, Vec2>();
  // ...and where EVERY artifact started, whatever state it was in. The jam rule below needs a
  // previous position for an artifact the ramp releases mid-tick too: that artifact is not yet
  // `ground` here, so it would have no entry in `ballFrom` and would spend its first ground
  // tick — the one where it is right on top of a robot working the gate — unprotected.
  const wasPos = new Map<number, Vec2>();
  for (const b of world.balls) {
    wasPos.set(b.id, { x: b.pos.x, y: b.pos.y });
    if (b.state.kind !== 'ground') continue;
    ballFrom.set(b.id, { x: b.pos.x, y: b.pos.y });
    stepGroundBall(b, dt);
  }
  // ROBOT-SIDE FEEDBACK FIRST — the stall on a pinned artifact, the drag of a clump. It
  // touches only `r.vel`, and it must land BEFORE the solve: the chassis body in there is
  // kinematic and cannot be told it is blocked, so a robot still driving at a trapped
  // artifact makes the solver squirt it out sideways instead. See `ballRobotFeedback`.
  for (const b of world.balls) {
    if (b.state.kind !== 'ground') continue;
    for (const r of world.robots) ballRobotFeedback(b, r, dt);
  }
  solveBalls(world, dt, decodeColliders, intakeClaims(world, actualCommands));
  // ball↔robot stays bespoke (see solveRobots): the pin stall + outflow-no-shove
  // are deliberately non-physical. Iterated so a robot→ball→(wall/ball) chain
  // converges instead of tunnelling in a single pass.
  /**
   * THE ARTIFACT IN A GATE'S DOORWAY IS BEING EXPELLED — the artifacts a robot is CARRYING
   * step aside for it. The CHASSIS never does: excluding an expelled artifact from the robot
   * passes as well as the held ones let it travel straight THROUGH a robot.
   *
   * `updateRails` floors its outward velocity at the end of the tick; the bespoke robot
   * passes undo that at the start of the next, to the third decimal. The stalemate only
   * bites once the hopper FILLS: while the intake is swallowing, the doorway clears itself,
   * but a full robot has three held artifacts physically sitting in its mouth and
   * `collideBallHeld` shoves the doorway artifact straight back into the gate.
   *
   * Measured gate-intaking a full ramp at the reported pose: 9/9 out with the hopper kept
   * clear, 4/9 and a dead stop once it fills — "the release rate is slower than normal when
   * gate intaking". At the stall the gate is open, the robot is NOT blocking the mouth
   * (mouth.s = -Infinity) and an artifact is sitting ready at s = -4.00; the only false
   * condition is the doorway.
   *
   * Scoped to the ONE artifact per goal actually in the doorway, so the intake's slopes and
   * the held-artifact stack keep working normally for everything else.
   */
  const expelling = new Set<number>();
  for (const a of ['red', 'blue'] as const) {
    const d = doorwayArtifact(world, a);
    if (d) expelling.add(d.id);
  }
  const heldBalls = world.balls.filter((b) => b.state.kind === 'held');
  for (let pass = 0; pass < C.BALL_SOLVER_ITERATIONS; pass++) {
    for (const b of world.balls) {
      if (b.state.kind !== 'ground') continue;
      // The CHASSIS is always solid — excluding an expelled artifact from this let it pass
      // straight through a robot. Only the artifacts a robot is CARRYING step aside for it.
      for (const r of world.robots) collideBallRobot(b, r);
      // held balls physically occupy the intake — incoming balls pile up on them
      if (!expelling.has(b.id)) for (const h of heldBalls) collideBallHeld(b, h);
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
  const ground = world.balls.filter((b) => b.state.kind === 'ground');
  for (const b of ground) {
    const from = ballFrom.get(b.id);
    collideBallRect(b, classifierRect('red'), C.BALL_WALL_RESTITUTION, from);
    collideBallRect(b, classifierRect('blue'), C.BALL_WALL_RESTITUTION, from);
    clampGroundBall(b);
  }

  /**
   * FINAL RELAXATION — de-overlap the artifacts LAST, after everything that can move them.
   *
   * Rapier separates artifacts early in the tick, but FOUR things move them afterwards: the
   * bespoke robot push, the held-ball block, the classifier eviction and the wall clamp.
   * Nothing separated them again, so a robot ramming a clump drove one artifact into another
   * and the overlap survived the tick — and while the robot keeps pushing, the next tick
   * never wins either. That is the stacking, both when ramming a pile and when a robot parks
   * over the gate outflow: in both the artifacts are held in overlap by something that acts
   * after the solver that was supposed to keep them apart.
   *
   * Position-only, and INTERLEAVED with the static clamps: separating two artifacts can push
   * one into a wall or back into the channel, so each pass re-clamps rather than trusting a
   * single ordering. The pair loop is over a stable array in id order, so it stays
   * deterministic for lockstep/replays.
   */
  for (let pass = 0; pass < C.BALL_RELAX_PASSES; pass++) {
    for (let i = 0; i < ground.length; i++) {
      for (let j = i + 1; j < ground.length; j++) separateBalls(ground[i], ground[j], world.time, pass === 0);
    }
    for (const b of ground) {
      // ROBOTS ARE PART OF THE WORLD THIS PASS HAS TO RESPECT. Separation moves artifacts
      // after `collideBallRobot` has already run, so without re-evicting here the pass can
      // push one INTO a robot and nothing takes it back out — and since the next tick's
      // robot pass runs BEFORE this one, a pressed clump walks artifacts straight through a
      // chassis. Measured before this line: 2.77in of penetration on a 2.5in radius.
      for (const r of world.robots) evictBallFromRobot(b, r);
      if (!expelling.has(b.id)) for (const h of heldBalls) collideBallHeld(b, h);
      const from = ballFrom.get(b.id);
      collideBallRect(b, classifierRect('red'), C.BALL_WALL_RESTITUTION, from);
      collideBallRect(b, classifierRect('blue'), C.BALL_WALL_RESTITUTION, from);
      clampGroundBall(b);
    }
  }

  /**
   * NOTHING SQUEEZES THROUGH A GAP IT DOES NOT FIT IN.
   *
   * Every mover in this tick resolves ONE constraint and hands the result to the next, and the
   * last word belongs to the wall clamp. So for an artifact pinched between a chassis and the
   * field wall the sequence is: eviction pushes it out of the robot, the clamp refuses that
   * push and puts it straight back, and it ends the tick still overlapping — not stopped, just
   * overlapping — and the flow carries it on through. Measured: a 5in artifact passing a 4.0in
   * gap between a robot's corner and the wall while gate intaking.
   *
   * Neither constraint can fix this alone, because each one is individually satisfied; what is
   * wrong is that the artifact MOVED while it was unable to fit. So that is what is checked,
   * and the rule is the honest one for a jam: a wall pinch has no valid resolution, so the
   * artifact does not advance. It stays where it began the tick — still stuck, still touching,
   * and `ballRobotFeedback` still stalls the robot against it — so a jam reads as a jam rather
   * than as a squeeze. Reverting rather than inventing a position keeps it deterministic, and
   * it can never appear anywhere it has not already been.
   *
   * This does NOT stop a robot shoving an artifact around in the open, because out there the
   * artifact separates and ends the tick under BALL_JAM_SLOP, so it never reaches this rule at
   * all. The rule only bites when separation is impossible.
   *
   * Two narrower versions were tried and neither held. Refusing the move only when the artifact
   * had been CLEAR at the start of the tick disabled itself exactly when it was needed: in real
   * play the robot is driving, so it advances onto the artifact and the artifact is already
   * overlapping when the next tick begins. Keeping the separating (normal) part of the motion
   * and dropping only the tangential slide failed too — the wall clamp immediately puts the
   * tangential motion back, because sliding along the wall is precisely how the clamp resolves
   * being pushed into it.
   *
   * The chassis AND the intake's solid FLANK — see `ballWedgedInRobot`. The MOUTH is open to
   * artifacts by design and an artifact being swallowed is deep inside that box on purpose,
   * but the rails beside it are structure, and they are what is next to the wall when someone
   * is gate intaking. Asking only about the chassis let artifacts walk between an intake and
   * the wall through gaps they do not fit in.
   */
  for (const b of ground) {
    const was = wasPos.get(b.id);
    if (!was) continue;
    let jammed = false;
    for (const r of world.robots) {
      if (ballWedgedInRobot(r, b.pos)) jammed = true;
    }
    if (!jammed) continue;
    b.pos.x = was.x;
    b.pos.y = was.y;
    clampGroundBall(b);
  }


  /**
   * A RESTING ARTIFACT DOES NOT SHUFFLE.
   *
   * The passes above each resolve one constraint and hand the result on, and where they
   * genuinely cannot all be satisfied — artifacts packed into a corner, which cannot fit
   * without overlap — the last two take turns: separation pushes a pair apart, the wall clamp
   * puts them back, and they trade positions for the rest of the match. Measured in the
   * loading-zone corner: 33 direction reversals per second, 1.8in of net movement over four
   * seconds. That is the jitter.
   *
   * The rule is the one the wall-pinch jam already uses: an overlap with no valid resolution
   * is not a reason to move anything. So an artifact that is at REST, is not being pushed by
   * a robot, and ends the tick within BALL_SETTLE_SLOP of where it started, ends it exactly
   * where it started. Reverting rather than inventing a position keeps it deterministic and it
   * can never appear anywhere it has not already been.
   *
   * The robot exclusion is load-bearing: an artifact being evicted by an arriving chassis is
   * at rest too, and refusing THAT would let a robot drive through it.
   */
  for (const b of ground) {
    const was = wasPos.get(b.id);
    if (!was) continue;
    if (hyp(b.vel.x, b.vel.y) > C.BALL_REST_SPEED) continue; // actually rolling — leave it alone
    const moved = hyp(b.pos.x - was.x, b.pos.y - was.y);
    if (moved === 0 || moved > C.BALL_SETTLE_SLOP) continue;
    let nearRobot = false;
    for (const r of world.robots) {
      if (pointDepthInRobot(r, b.pos) > -C.BALL_RADIUS) nearRobot = true;
    }
    if (nearRobot) continue;
    b.pos.x = was.x;
    b.pos.y = was.y;
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
    // ...and it does not fall THROUGH an intake on the way down. The mouth is open at ball
    // height so an artifact can roll in under the rollers; from above, the rollers are in
    // the way. Without this an artifact dropped on the intake landed inside the throat and
    // was swallowed — which is not a thing an intake can do.
    for (const r of world.robots) if (landOnIntakeLid(b, r, prevZ)) break;
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
      if (b.z > C.ROBOT_HEIGHT) continue;
      for (const r of world.robots) collideBallRobot(b, r);
    }
  }
  for (const b of activeFlight) {
    if (b.z > C.CLASSIFIER_HEIGHT) continue;
    collideBallRect(b, classifierRect('red'));
    collideBallRect(b, classifierRect('blue'));
  }
  for (const b of activeFlight) collideBallStatic(b);

  // ---- goals: basin jumble, rail flow, gate ---------------------------------
  updateGates(world, dt, actualCommands);
  updateBasins(world, dt);
  updateRails(world, dt, actualCommands);
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