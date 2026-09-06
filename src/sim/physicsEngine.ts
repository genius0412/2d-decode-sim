import RAPIER from '@dimforge/rapier2d-compat';
import type { Alliance, Artifact, RobotState, Vec2, World } from '../types';
import * as C from '../config';
import { robotExtents } from './physics';
import { shoveMass } from './drivetrain';
import { dcos, dsin, hyp } from '../math';
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
    // stated, not inherited — this used to fall through to Rapier's own default and so was
    // never a number anyone had chosen. Same value, so nothing moves. See PHYS_WALL_FRICTION.
    .setFriction(C.PHYS_WALL_FRICTION)
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
 * How much of `now`'s overhang has to be given back: whatever takes it past the larger of what
 * the robot already had and the resting slop. Signed — + is past the high wall, − the low.
 *
 * THE SLOP IS LOAD-BEARING. Ordinary soft contact leaves a chassis resting a little into a wall
 * (0.57in at the worst measured shove), and a containment pass that fought that every tick is
 * precisely the two-passes-taking-turns failure the artifact solve had to be rebuilt to avoid —
 * tried without it, and the wall square-up lost flush by 1.4 degrees while artifacts started
 * jittering against the classifier again. Above the worst honest penetration, far below
 * "outside the field", so it only ever acts once the solver has already given up.
 */
function grewOut(now: number, was: number): number {
  const allowed = Math.max(Math.abs(was), C.PHYS_CONTAIN_SLOP);
  const over = Math.abs(now) - allowed;
  return over > 0 ? (now > 0 ? over : -over) : 0;
}

/**
 * How far a robot's footprint sticks out past the perimeter, as an outward vector (0 inside).
 *
 * Used by `solveRobots` to hold a containment invariant the colliders alone cannot: a robot
 * that began a tick INSIDE the field may not be pushed out of it. That was true for free while
 * every body in the solve was dynamic and would yield, and stopped being true the moment one
 * of them could not — a chassis crushed between the far wall and a robot on an AUTO PATH
 * (kinematic; it does not give) was driven 15.2in past the wall, and with a longer path left
 * the field entirely. No speed guard can see that: Rapier's positional correction does not feed
 * velocity, so the victim's `r.vel` read 0.00 for every tick it was being pushed through. The
 * violation is positional, so the answer has to be.
 *
 * IT CLAMPS THE GROWTH, NOT THE VALUE. A robot may legitimately be outside already — DECODE's
 * outflow mouth sits at x = -69 inside the classifier channel, and a probe parked on it has its
 * whole chassis past the wall plane — and a pass that hauled such a robot back in would be
 * overriding a pose nothing put it in. Containment keeps you in; it does not teleport you in.
 */
function outsideBy(r: RobotState, bounds: { halfX: number; halfY: number }): Vec2 {
  const e = robotExtents(r);
  const c = dcos(r.heading);
  const s = dsin(r.heading);
  // the footprint's axis-aligned half-extents, which is all an axis-aligned wall can see
  const hx = (e.front + e.rear) / 2;
  const cx = r.pos.x + ((e.front - e.rear) / 2) * c;
  const cy = r.pos.y + ((e.front - e.rear) / 2) * s;
  const ax = Math.abs(hx * c) + Math.abs(e.half * s);
  const ay = Math.abs(hx * s) + Math.abs(e.half * c);
  return {
    x: Math.max(0, cx + ax - bounds.halfX) + Math.min(0, cx - ax + bounds.halfX),
    y: Math.max(0, cy + ay - bounds.halfY) + Math.min(0, cy - ay + bounds.halfY),
  };
}

/**
 * Resolve robot translation + velocity for one tick via Rapier: build bodies at
 * the robots' current poses (rotation locked, linvel = r.vel, mass = `shoveMass` — push
 * AUTHORITY, not weight; see drivetrain.ts),
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
  const bodies: { r: RobotState; body: RAPIER.RigidBody; wasOut: Vec2 }[] = [];
  for (const r of robots) {
    // Always record preVels for all robots, even if Rapier will not move this one
    preVels.set(r.id, { x: r.vel.x, y: r.vel.y });

    const e = robotExtents(r);
    const hx = (e.front + e.rear) / 2;
    const forward = (e.front - e.rear) / 2; // intake reach shifts the box forward
    /**
     * A ROBOT ON AN AUTO PATH IS STILL A SOLID OBJECT.
     *
     * It used to get no body at all, so for the whole 30 s of AUTO it was a GHOST: an
     * opponent drove clean through it (measured — the pusher crossed it end to end and the
     * path robot never moved a thousandth of an inch) and it passed through walls too. The
     * path is authoritative over where it goes, which is a reason not to let physics MOVE it
     * — not a reason to let the world reach through it.
     *
     * KINEMATIC is exactly that distinction, and it is the same call `solveBalls` makes for
     * the chassis: everyone collides with it, nothing pushes it. Its pose for this tick was
     * already written by `updatePathTraversal` before this pass runs, so the body is built
     * where the path put it.
     *
     * IT GETS THE SWEEP VELOCITY TOO, and that is not cosmetic. A path robot TELEPORTS
     * (1.56 in/tick at the default spec); a kinematic body the solver believes is stationary
     * leaves nothing but the soft positional correction acting on whatever is in the way, and
     * that cannot keep up. Measured with a zero linvel: overlap grew monotonically to 15.2 in
     * on a 17.5 in pair until the SAT min axis flipped, the bystander was ejected 4 in sideways
     * and 3 in backwards, and the path robot then passed clean through it — the same
     * min-axis-flip failure `makeWorld` above warns about. With the velocity set, peak
     * penetration is 0.00 in. `world.ts` writes it from the pose delta.
     *
     * Chain Reaction never sets the flag (`makeChainRobot` hard-codes false and CR has no
     * path system), so this branch is DECODE-only in practice.
     */
    const body = rw.createRigidBody(
      r.autoPathActive
        ? RAPIER.RigidBodyDesc.kinematicVelocityBased()
            .setTranslation(r.pos.x, r.pos.y)
            .setRotation(r.heading)
            .setLinvel(r.vel.x, r.vel.y)
        : RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(r.pos.x, r.pos.y)
            .setRotation(r.heading)
            .lockRotations()
            .setLinvel(r.vel.x, r.vel.y),
    );
    // PUSHING POWER. `shoveMass` is the collider mass that DELIVERS this robot's
    // `pushForce` given the accel the motor model used — see drivetrain.ts, which owns
    // the whole model and documents why the force cannot simply be written here as a
    // mass. BUTTERFLY: the set that is DOWN decides both the traction factor and the
    // gearing, so dropping the traction wheels really does turn it into a pusher
    // mid-match (and back) — `r.butterflyTank` carries that into both terms.
    rw.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, e.half)
        .setTranslation(forward, 0) // body-local (rotated by heading)
        .setMass(shoveMass(r.spec, r.butterflyTank, r.powerDraw))
        .setRestitution(0)
        .setFriction(C.PHYS_FRICTION),
      body,
    );
    // ...and only a DYNAMIC body has a result worth reading back.
    if (!r.autoPathActive) bodies.push({ r, body, wasOut: outsideBy(r, colliders.bounds) });
  }

  // the physical gate handles (one-way doors) — after the robot bodies, before
  // the step, in the module's stable order (matches the old buildGateArms call site)
  for (const s of colliders.dynamic?.(world, dt, gateCol) ?? []) {
    rw.createCollider(
      statics(RAPIER.ColliderDesc.cuboid(s.hx, s.hy).setTranslation(s.tx, s.ty).setRotation(s.rot)),
    );
  }

  rw.step();

  for (const { r, body, wasOut } of bodies) {
    const p = body.translation();
    const v = body.linvel();
    r.pos.x = p.x;
    r.pos.y = p.y;
    // ...and it may not have been pushed FURTHER out than it already was (see `outsideBy`).
    const nowOut = outsideBy(r, colliders.bounds);
    r.pos.x -= grewOut(nowOut.x, wasOut.x);
    r.pos.y -= grewOut(nowOut.y, wasOut.y);
    /**
     * A SOLVER-EXPLOSION GUARD, not a gameplay lever.
     *
     * Nothing on this field can legitimately carry a robot past a couple of times its own top
     * speed: the hardest thing that can happen to it is being rammed by another robot, and no
     * robot goes faster than ~94 in/s. A larger number is the solver failing to satisfy an
     * over-constrained contact, and there is exactly one way to over-constrain it — squeeze a
     * dynamic chassis between something immovable and something that will not yield.
     *
     * That case now exists: a robot on an AUTO PATH is kinematic, so it advances regardless of
     * what is in front of it, and when the bystander it has been carrying reaches a wall the
     * two demands cannot both be met. Measured, the pair squirted out at 959 in/s — six field
     * widths a second. The squeeze itself is inherent (the path is authoritative over where it
     * goes, which is the whole design), so the answer is to make it a bounded shove rather than
     * a launch. Everywhere else this is dead code, and it should stay that way: if it starts
     * binding in ordinary play, something upstream is wrong — which is why the ceiling is an
     * ABSOLUTE speed and not a multiple of this robot's own (see `PHYS_MAX_ROBOT_SPEED`; the
     * per-robot version fired on ordinary shoves of a slow chassis by a fast one).
     */
    const speed = hyp(v.x, v.y);
    const scale = speed > C.PHYS_MAX_ROBOT_SPEED ? C.PHYS_MAX_ROBOT_SPEED / speed : 1;
    r.vel.x = v.x * scale;
    r.vel.y = v.y * scale;
  }

  rw.free();
  return preVels;
}

/**
 * COLLISION GROUPS for the artifact solve. Rapier packs these as
 * `(membership << 16) | filter`, and two colliders interact only if each one's membership
 * is in the other's filter. Static field colliders keep the default (member of everything,
 * filter everything), so they are unaffected and need no changes.
 *
 * The point is one exclusion: the chassis must not fight the intake over an artifact the
 * intake is actively drawing in. The funnel pulls toward the throat at the chassis front
 * face while the chassis collider pushes off it, and the artifact oscillates — measured
 * 1.45s to swallow one 7in off-centre against main's 0.33s. See `intakeClaims`.
 */
const LOOSE_GROUP = 0x0001ffff; // ordinary artifact: everything sees it
const CLAIMED_GROUP = 0x0002ffff; // artifact the intake has hold of
const CHASSIS_GROUP = 0x0004fffd; // chassis: filters OUT the claimed bit (0x0002)

/**
 * Resolve GROUND-ball translation + velocity for one tick via a separate Rapier
 * solve: light circle bodies (linvel = b.vel, mass = BALL_MASS) against the
 * static field — ball↔ball and ball↔wall / ball↔goal-face / ball↔classifier — AND
 * against each robot's CHASSIS. Friction/rest-snap (velocity pre-pass) and the hard
 * field clamp are applied around this call in world.ts. Bodies are built in stable id
 * order (artifacts, then robots) so the solve is deterministic.
 *
 * THE CHASSIS IS HERE BECAUSE A SQUEEZE HAS NO ONE-CONTACT-AT-A-TIME ANSWER.
 * It used to be resolved bespoke AFTER this solve, so an artifact caught between a
 * bumper and the classifier was handled by two position writes taking turns — measured
 * 3.13in in from the robot pass and 3.70in back out from the static eviction, on an
 * artifact whose velocity was ZERO. Neither pass was wrong alone; they could not see
 * each other. Reordering and interleaving them were both tried and both bought under
 * 0.2in.
 *
 * KINEMATIC: the robot pushes artifacts and is never pushed back, which IS product
 * decision #7's "gate outflow can't shove a parked robot". The robot-side feel that
 * cannot fall out of a kinematic body — the stall on a pinned artifact and the drag of
 * a clump — is `ballRobotFeedback`, which runs BEFORE this solve for the reason
 * documented there. (A heavy DYNAMIC body was tried so the stall would be emergent; it
 * is not, because an artifact is ~0.3lb against 20-42lb and the drivetrain restores the
 * loss the same tick.)
 *
 * The INTAKE is deliberately absent: its mouth is open to artifacts by design (product
 * decision #10) and its funnel geometry is per-preset. That region stays bespoke, in
 * `collideBallRobot`, which now handles ONLY it.
 */
export function solveBalls(
  world: World,
  dt: number,
  colliders: FieldColliders,
  claimed: Set<number> = new Set(),
): void {
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
        // An artifact the intake has hold of goes in its own membership group so the
        // chassis can filter it out — see CLAIMED_GROUP. Everything else (field, other
        // artifacts) still sees it, because those groups accept all comers.
        .setCollisionGroups(claimed.has(b.id) ? CLAIMED_GROUP : LOOSE_GROUP)
        .setFriction(C.PHYS_FRICTION),
      body,
    );
    ballBodies.push({ b, body });
  }

  // ...then the robot CHASSIS bodies, AFTER the artifacts so the artifact collider
  // creation order is untouched (Rapier resolution depends on it, and replays re-sim
  // through this). Chassis only — NOT robotExtents, which includes the intake reach:
  // that box is what the robot collides with, but to an artifact the mouth is open.
  for (const r of world.robots) {
    const body = rw.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicVelocityBased()
        .setTranslation(r.pos.x, r.pos.y)
        .setRotation(r.heading)
        .setLinvel(r.vel.x, r.vel.y)
        .setAngvel(r.angVel),
    );
    rw.createCollider(
      RAPIER.ColliderDesc.cuboid(r.spec.length / 2, r.spec.width / 2)
        .setRestitution(C.BALL_ROBOT_RESTITUTION)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
        // ...and the chassis does NOT see artifacts the intake is drawing in.
        .setCollisionGroups(CHASSIS_GROUP)
        .setFriction(C.PHYS_FRICTION),
      body,
    );
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
