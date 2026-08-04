import RAPIER from '@dimforge/rapier2d-compat';
import type { Alliance, Artifact, RobotState, Vec2, World } from '../types';
import * as C from '../config';
import { robotExtents } from './physics';
import { clamp } from '../math';
import { activeDrive } from './drivetrain';
import type { FieldColliders } from '../games/types';

/**
 * Rapier 2D physics bridge (netcodeplan Phase 2, robots-first slice).
 *
 * The sim's `World` stays the single canonical, JSON-serializable source of
 * truth. Each `step()` builds a FRESH Rapier world from the robots' current
 * poses, steps it once, and writes the resolved translation + velocity back —
 * then frees it. Statelessness is deliberate: `game.ts` reconcile swaps
 * `this.world` for a fresh snapshot up to 60×/s, so a Rapier world keyed to
 * object identity would rebuild-and-leak WASM every frame. Rebuild-per-step
 * makes reconcile and bit-for-bit determinism trivially correct, and building
 * a handful of colliders + N bodies is microseconds.
 *
 * Rapier OWNS robot translation + velocity (→ wall/robot velocity-kill,
 * mass-weighted shoving, restitution-0 inelastic contact, and — because
 * RobotState is canonical and rebuilt each tick — pinned-ball feedback, all for
 * free). Rotation is LOCKED on the bodies; the bespoke contact-torque "square
 * up flush" nudge stays in physics.ts (`squareUpRobots`), the one piece the
 * plan calls out as not a Rapier primitive.
 *
 * Slice 2 adds GROUND balls to the SAME unified solve (circle bodies, tiny
 * mass), so ball↔ball / ball↔robot / ball↔wall / ball↔goal-face /
 * ball↔classifier resolve together — and the pinned-ball → robot feedback falls
 * out of a real mass ratio. Rolling friction + rest-snap + the hard field clamp
 * stay bespoke around the solve (top-down plane has no floor to rub on, and
 * Rapier's soft contacts allow ~0.2in penetration the containment invariant
 * won't tolerate). Restitution combines with `Min` across every collider so the
 * per-pair coefficients fall straight out of the BALL_* constants. FLIGHT balls
 * (ballistic + rare low collisions) stay bespoke in world.ts / physics.ts.
 */


let ready = false;

/** Load + init the Rapier WASM (async). MUST resolve before any `step()` runs;
 * awaited at every entry point (smoke, server, browser). Idempotent. */
export async function initPhysics(): Promise<void> {
  if (ready) return;
  await RAPIER.init();
  ready = true;
}

export function physicsReady(): boolean {
  return ready;
}

/** give a static field collider a ball-bounce restitution combined with Min, so
 * a ground ball caroms off it at BALL_WALL_RESTITUTION while a robot (restitution
 * 0) still resolves fully inelastically against it — slice-1 robot feel intact. */
function statics(desc: RAPIER.ColliderDesc): RAPIER.ColliderDesc {
  return desc
    .setRestitution(C.BALL_WALL_RESTITUTION)
    .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min);
}

/** build a game's static field colliders (perimeter walls + structures) onto the
 * fresh world, in the module's stable spec order (determinism). The geometry math
 * is memoized in the game module (`FieldColliders.statics`). */
function buildStatics(rw: RAPIER.World, colliders: FieldColliders): void {
  for (const s of colliders.statics) {
    rw.createCollider(
      statics(RAPIER.ColliderDesc.cuboid(s.hx, s.hy).setTranslation(s.tx, s.ty).setRotation(s.rot)),
    );
  }
}

/** a fresh Rapier world with our inch-scale tolerances + the static field
 * colliders. Shared by the robot and ball solves. Robots use SOFT contacts
 * (a robot can start a step deep inside a wall via its intake reach — a stiff
 * contact would eject it explosively); balls are small and slow and never start
 * deeply embedded, so they use STIFF contacts (`freq`/`allowedError`) that push
 * an overlapping pair fully apart in one step instead of leaving them visibly
 * interpenetrating for several ticks. */
function makeWorld(
  dt: number,
  colliders: FieldColliders,
  freq: number = C.PHYS_CONTACT_FREQ,
  allowedError: number = C.PHYS_ALLOWED_ERROR,
): RAPIER.World {
  const rw = new RAPIER.World({ x: 0, y: 0 }); // top-down plane: no gravity
  rw.timestep = dt;
  // Rapier's tolerances default to METERS; our world is in INCHES (~40× bigger),
  // so tell it the typical object scale. Without this the penetration-error and
  // corrective-velocity caps are mis-scaled and a robot driven full-speed into a
  // wall-pinned robot out-runs the solver — penetration grows until the min-axis
  // flips and the pair is ejected sideways. Extra iterations keep deep contacts
  // (a full-speed pin) fully projected out each step, like the old solver did.
  rw.integrationParameters.lengthUnit = C.PHYS_LENGTH_UNIT;
  rw.integrationParameters.numSolverIterations = C.PHYS_SOLVER_ITERS;
  rw.integrationParameters.contact_natural_frequency = freq;
  rw.integrationParameters.normalizedAllowedLinearError = allowedError;
  buildStatics(rw, colliders);
  return rw;
}

/**
 * Resolve robot translation + velocity for one tick via Rapier: build bodies at
 * the robots' current poses (rotation locked, linvel = r.vel, mass = massLb),
 * step once, and write the resolved translation + velocity back into RobotState.
 * Returns each robot's PRE-solve velocity (keyed by id) so the bespoke square-up
 * pass can scale contact torque by how hard the robot was driving in.
 *
 * Robots only — BALLS are a SEPARATE solve (`solveBalls`) followed by the bespoke
 * `collideBallRobot`. Ball↔robot is NOT a Rapier contact on purpose: the "gate
 * outflow can't shove a parked robot" rule (product decision #7) is deliberately
 * NON-physical, and a light ball can't stall a force-set-velocity robot in a
 * single solve. Keeping ball↔robot bespoke preserves both the pin stall and the
 * outflow-no-shove feel. Robots therefore never see ball bodies here (slice-1
 * robot behavior is byte-for-byte unchanged).
 */
export function solveRobots(
  world: World,
  dt: number,
  colliders: FieldColliders,
  gateCol?: Record<Alliance, number>,
): Map<number, Vec2> {
  const preVels = new Map<number, Vec2>();
  const robots = world.robots;
  if (robots.length === 0) return preVels;

  const rw = makeWorld(dt, colliders);
  const bodies: { r: RobotState; body: RAPIER.RigidBody }[] = [];
  for (const r of robots) {
    // Always record preVels for all robots, even if not simulated by Rapier
    preVels.set(r.id, { x: r.vel.x, y: r.vel.y });

    // Only create physics bodies for robots NOT on an auto path
    if (!r.autoPathActive) {
      const e = robotExtents(r);
      const hx = (e.front + e.rear) / 2;
      const forward = (e.front - e.rear) / 2; // intake reach shifts the box forward
      const body = rw.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(r.pos.x, r.pos.y)
          .setRotation(r.heading)
          .lockRotations()
          .setLinvel(r.vel.x, r.vel.y),
      );
      // PUSHING POWER (effective shove mass): real mass × drivetrain traction
      // × wheel torque (geared for speed ⇒ less push, inverse RPM) × available
      // current (1 − power draw). driveParams.accel uses the REAL massLb, so
      // inflating the shove mass here never touches linear accel. At the DEFAULT
      // reference (mecanum, 435 rpm, at rest) all factors = 1 ⇒ shove unchanged.
      // BUTTERFLY: the set that is DOWN decides both the traction factor and the
      // gearing, so dropping the traction wheels really does turn it into a pusher
      // mid-match (and back). `activeDrive` is the same resolver driveParams uses.
      const { p, rpm } = activeDrive(r.spec, r.butterflyTank);
      const rpmPush = clamp(C.REF_DRIVE_RPM / rpm, 0.6, 1.8);
      const shoveMass = r.spec.massLb * p.pushMult * rpmPush * (1 - r.powerDraw);
      rw.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, e.half)
          .setTranslation(forward, 0) // body-local (rotated by heading)
          .setMass(shoveMass)
          .setRestitution(0)
          .setFriction(C.PHYS_FRICTION),
        body,
      );
      bodies.push({ r, body });
    }
  }

  // the physical gate handles (one-way doors) — after the robot bodies, before
  // the step, in the module's stable order (matches the old buildGateArms call site)
  for (const s of colliders.dynamic?.(world, dt, gateCol) ?? []) {
    rw.createCollider(
      statics(RAPIER.ColliderDesc.cuboid(s.hx, s.hy).setTranslation(s.tx, s.ty).setRotation(s.rot)),
    );
  }

  rw.step();

  for (const { r, body } of bodies) {
    const p = body.translation();
    const v = body.linvel();
    r.pos.x = p.x;
    r.pos.y = p.y;
    r.vel.x = v.x;
    r.vel.y = v.y;
  }

  rw.free();
  return preVels;
}

/**
 * Resolve GROUND-ball translation + velocity for one tick via a separate Rapier
 * solve: light circle bodies (linvel = b.vel, mass = BALL_MASS) against the
 * static field only — ball↔ball and ball↔wall / ball↔goal-face / ball↔classifier
 * contact. Robots are ABSENT (ball↔robot is the bespoke `collideBallRobot` pass,
 * run after this, for the reasons in `solveRobots`). Friction/rest-snap (velocity
 * pre-pass) and the hard field clamp are applied around this call in world.ts.
 * Bodies are built in stable `world.balls` id order so the solve is deterministic.
 */
export function solveBalls(world: World, dt: number, colliders: FieldColliders): void {
  const groundBalls = world.balls.filter((b) => b.state.kind === 'ground');
  if (groundBalls.length === 0) return;

  const rw = makeWorld(dt, colliders, C.PHYS_BALL_CONTACT_FREQ, C.PHYS_BALL_ALLOWED_ERROR);
  const ballBodies: { b: Artifact; body: RAPIER.RigidBody }[] = [];
  for (const b of groundBalls) {
    const body = rw.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(b.pos.x, b.pos.y)
        .lockRotations()
        .setLinvel(b.vel.x, b.vel.y),
    );
    rw.createCollider(
      RAPIER.ColliderDesc.ball(C.BALL_RADIUS)
        .setMass(C.BALL_MASS)
        .setRestitution(C.BALL_BALL_RESTITUTION)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setFriction(C.PHYS_FRICTION),
      body,
    );
    ballBodies.push({ b, body });
  }

  rw.step();

  for (const { b, body } of ballBodies) {
    const p = body.translation();
    const v = body.linvel();
    b.pos.x = p.x;
    b.pos.y = p.y;
    b.vel.x = v.x;
    b.vel.y = v.y;
  }

  rw.free();
}
