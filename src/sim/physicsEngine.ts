import RAPIER from '@dimforge/rapier2d-compat';
import type { Alliance, Artifact, RobotState, Vec2, World } from '../types';
import * as C from '../config';
import { robotExtents } from './physics';
import { shoveMass } from './drivetrain';
import type { DriveWrench } from './robot';
import { chassisInertia } from './robot';
import { clamp, dcos, dsin, hyp, rot, wrapAngle } from '../math';
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
 * Rapier OWNS robot translation, velocity AND rotation (→ wall/robot velocity-kill,
 * mass-weighted shoving, restitution-0 inelastic contact). The drive reaches it as a
 * FORCE + TORQUE (`DriveWrench`), so the angular half of a contact is the solver's own
 * answer rather than a heuristic; the bespoke contact-torque "square up flush" nudge stays
 * in physics.ts (`squareUpRobots`), the one piece the plan calls out as not a Rapier
 * primitive.
 *
 * GROUND balls are a second solve (`solveBalls`): circle bodies at BALL_MASS against the
 * field, each other, and the robots' CHASSIS — so ball↔ball / ball↔robot / ball↔wall /
 * ball↔goal-face / ball↔classifier resolve together, and the pin stall a robot feels when it
 * grinds an artifact into a wall falls out of the real mass ratio instead of being written
 * by hand. Rolling friction + rest-snap + the hard field clamp stay bespoke around the solve
 * (top-down plane has no floor to rub on, and Rapier's soft contacts allow ~0.2in penetration
 * the containment invariant won't tolerate). Restitution combines with `Min` across every
 * collider so the per-pair coefficients fall straight out of the BALL_* constants. FLIGHT
 * balls (ballistic + rare low collisions) stay bespoke in world.ts / physics.ts.
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
function statics(desc: RAPIER.ColliderDesc, groups?: number): RAPIER.ColliderDesc {
  const d = desc
    // stated, not inherited — this used to fall through to Rapier's own default and so was
    // never a number anyone had chosen. Same value, so nothing moves. See PHYS_WALL_FRICTION.
    .setFriction(C.PHYS_WALL_FRICTION)
    .setRestitution(C.BALL_WALL_RESTITUTION)
    .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min);
  // Only the ARTIFACT solve names a group here (see FIELD_GROUP). Left unset everywhere else,
  // so the robot solve gets Rapier's default membership and is untouched to the digit.
  return groups === undefined ? d : d.setCollisionGroups(groups);
}

/** build a game's static field colliders (perimeter walls + structures) onto the
 * fresh world, in the module's stable spec order (determinism). The geometry math
 * is memoized in the game module (`FieldColliders.statics`). */
function buildStatics(rw: RAPIER.World, colliders: FieldColliders, groups?: number): void {
  for (const s of colliders.statics) {
    rw.createCollider(
      statics(
        RAPIER.ColliderDesc.cuboid(s.hx, s.hy).setTranslation(s.tx, s.ty).setRotation(s.rot),
        groups,
      ),
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
  staticGroups?: number,
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
  buildStatics(rw, colliders, staticGroups);
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
 * Robots only — ARTIFACTS are a SEPARATE solve (`solveBalls`), which builds its own chassis
 * bodies and is where ball↔robot momentum is exchanged in BOTH directions. Two solves rather
 * than one because they want different contact stiffness (a robot can start a step deep
 * inside a wall via its intake reach; an artifact never does) and because the artifact solve
 * must see the CHASSIS where this one sees the whole footprint, intake included.
 */
export function solveRobots(
  world: World,
  dt: number,
  colliders: FieldColliders,
  gateCol?: Record<Alliance, number>,
  /** the DRIVE, as a force + torque per robot id (`updateRobot`). Absent ⇒ this robot is
   *  coasting: the solver still owns its motion, nothing is being asked of the wheels. */
  drive?: Map<number, DriveWrench>,
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
        : /**
           * ROTATION IS NOT LOCKED ANY MORE — slice A.
           *
           * It was, and everything angular had to be hand-built around that: the two-body
           * impulse in `squareUpPair`, the settling nudge, `CONTACT_PAIR_SPIN`, the slip
           * relief. A locked body cannot yaw from a contact, so an off-centre hit produced
           * nothing at all and the bespoke pass existed to put it back.
           *
           * With the drive arriving as a force (see `updateRobot`), the solver can answer the
           * angular half itself, from the same normal and friction impulses it already
           * computes — a flank drag yaws you because the friction acts off the centre of mass,
           * not because a heuristic says so.
           */
          RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(r.pos.x, r.pos.y)
            .setRotation(r.heading)
            .setLinvel(r.vel.x, r.vel.y)
            .setAngvel(r.angVel),
    );
    // PUSHING POWER. `shoveMass` is the collider mass that DELIVERS this robot's
    // `pushForce` given the accel the motor model used — see drivetrain.ts, which owns
    // the whole model and documents why the force cannot simply be written here as a
    // mass. BUTTERFLY: the set that is DOWN decides both the traction factor and the
    // gearing, so dropping the traction wheels really does turn it into a pusher
    // mid-match (and back) — `r.butterflyTank` carries that into both terms.
    /**
     * ...AND THE MASS PROPERTIES ARE STATED, not derived from the box.
     *
     * `setMass` alone would put the centre of mass at the FOOTPRINT's centre, which sits
     * forward of the chassis by half the intake reach — so a robot would pivot about a point
     * out in front of itself and the drive model's `maxTurn` (worked out about the chassis
     * centre, from its half-diagonal) would no longer be the free-space answer. The COM is
     * pinned back to the body origin and the inertia is the chassis rectangle's, which is the
     * same expression `squareUpPair`'s impulse already used — so nothing in the sim disagrees
     * about how hard this robot is to spin.
     */
    const m = shoveMass(r.spec, r.butterflyTank, r.powerDraw);
    rw.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, e.half)
        .setTranslation(forward, 0) // body-local (rotated by heading)
        .setMassProperties(m, { x: -forward, y: 0 }, chassisInertia(m, r.spec))
        .setRestitution(0)
        .setFriction(C.PHYS_FRICTION),
      body,
    );
    // the DRIVE, for this tick. A pure force acts at the centre of mass and a pure torque
    // about it, so the two are independent: driving forward never yaws you by itself.
    const w = drive?.get(r.id);
    if (w && !r.autoPathActive) {
      if (w.fx !== 0 || w.fy !== 0) body.addForce({ x: w.fx, y: w.fy }, true);
      if (w.tau !== 0) body.addTorque(w.tau, true);
    }
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
    /**
     * A CONTACT MAY NOT SLING YOU SIDEWAYS PAST WHAT THE TYRES HOLD — IN THE SAME TICK.
     *
     * The per-wheel traction answers a tick late, which is right for a sustained drag and
     * wrong for an impact: driving into the gate structure at 30 in/s came out at 10.7 in/s
     * pointing somewhere else, and the wheels then spent a tenth of a second clawing the
     * sideways half back. Reported as a surge of strafing speed at the gate, and the old model
     * never showed it because it re-imposed the commanded velocity every tick, so no impact
     * could redirect anybody.
     *
     * ONLY THE SIDEWAYS HALF, and that is the whole point. The normal component still stops
     * you, the ROTATION an off-centre hit produces is untouched — "the turning should honestly
     * happen" — and what goes is the part a real tyre would simply refuse: a wall cannot
     * accelerate a chassis along itself harder than friction allows.
     */
    let vx = v.x;
    let vy = v.y;
    const w = drive?.get(r.id);
    if (w) {
      const rc = dcos(r.heading);
      const rs = dsin(r.heading);
      const lat = -(vx - w.wantX) * rs + (vy - w.wantY) * rc;
      const over = Math.abs(lat) - w.latCap;
      if (over > 0) {
        const back = Math.sign(lat) * over;
        vx += rs * back;
        vy -= rc * back;
      }
    }
    const speed = hyp(vx, vy);
    const scale = speed > C.PHYS_MAX_ROBOT_SPEED ? C.PHYS_MAX_ROBOT_SPEED / speed : 1;
    r.vel.x = vx * scale;
    r.vel.y = vy * scale;
    /**
     * THE SOLVER OWNS THE HEADING NOW. `updateRobot` used to integrate it, because a
     * rotation-locked body had no rotation to report; the drive arrives as a torque instead
     * and this reads back what the wheels and every contact did between them.
     *
     * The spin guard is the angular twin of `PHYS_MAX_ROBOT_SPEED` and is dead code in
     * ordinary play for the same reason: nothing on this field can legitimately spin a robot
     * past a few times its own top rate, so a larger number is the solver failing an
     * over-constrained contact rather than a hit anybody felt.
     */
    /**
     * The spin the solver worked out, guarded only against its own explosions. The tyres have
     * already had their say — four lateral traction forces went INTO this solve (see the wheel
     * loop in `updateRobot`), so a contact that spun the chassis anyway did it against grip
     * that was resisting at the time, which is the whole point of slice B.
     */
    const av = body.angvel();
    /**
     * ...AND WHAT THE CONTACTS DID, kept for the wheels to resist next tick.
     *
     * The drive asked for `wantX/wantY/wantW`; anything else in the solver's answer arrived
     * through a contact. The per-wheel traction model in `updateRobot` turns this into four
     * lateral forces, each clipped to one tyre's grip — which is why a sustained lean is
     * refused outright and an impact is not.
     */
    r.slipX = w ? vx - w.wantX : 0;
    r.slipY = w ? vy - w.wantY : 0;
    r.slipW = w ? av - w.wantW : 0;
    r.angVel = clamp(av, -C.PHYS_MAX_ROBOT_SPIN, C.PHYS_MAX_ROBOT_SPIN);
    /**
     * THE HEADING IS INTEGRATED FROM THAT, NOT READ OFF THE BODY.
     *
     * `body.rotation()` carries Rapier's positional PENETRATION CORRECTION as well as the
     * motion — a bias applied straight to the pose, with no angular velocity behind it — and
     * that is not a rotation anything did. A robot placed a hair inside the gate stub, idle,
     * with `angvel` reading 0.0000 the whole time, was quietly turned 7.2° by it. The tyres'
     * refusal above governs the rotation, so the heading follows the rotation it governs.
     */
    r.heading = wrapAngle(r.heading + r.angVel * dt);
  }

  rw.free();
  return preVels;
}

/**
 * COLLISION GROUPS for the artifact solve. Rapier packs these as
 * `(membership << 16) | filter`, and two colliders interact only if each one's membership
 * is in the other's filter — BOTH directions have to agree, which is why the field needs a
 * membership of its own rather than the default "member of everything".
 *
 * TWO exclusions, and the chassis's filter states them by naming the only thing it may touch:
 *
 * 1. IT MUST NOT FIGHT THE INTAKE over an artifact the intake is actively drawing in. The
 *    funnel pulls toward the throat at the chassis front face while the chassis collider
 *    pushes off it, and the artifact oscillates — measured 1.45s to swallow one 7in
 *    off-centre against main's 0.33s. See `intakeClaims`.
 *
 * 2. IT MUST NOT RE-RESOLVE ANYTHING `solveRobots` ALREADY OWNS, which became a live concern
 *    the moment the chassis stopped being kinematic. A dynamic body would meet the walls, the
 *    goal faces, the classifier and every other chassis a SECOND time in this solve, and the
 *    velocity written back would carry both answers — the wall's normal impulse counted twice,
 *    robot-robot shoving counted twice. This solve exists to exchange momentum between robots
 *    and ARTIFACTS and it is scoped to exactly that.
 */
const LOOSE_GROUP = 0x0001ffff; // ordinary artifact: everything sees it
const CLAIMED_GROUP = 0x0002ffff; // artifact the intake has hold of
const CHASSIS_GROUP = 0x00040001; // chassis: ordinary artifacts and NOTHING else
const FIELD_GROUP = 0x0008ffff; // walls/goal faces/classifier, in THIS solve only

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
 * THE CHASSIS IS DYNAMIC, AND THAT IS WHAT MAKES THE PUSH MUTUAL.
 *
 * It was kinematic — the robot pushed artifacts and was never pushed back — and the
 * robot-side feel was faked afterwards by a bespoke pass (`ballRobotFeedback`) that wrote
 * `r.vel` directly: a "stall" branch when the artifact was pinned against a static, and a
 * momentum bleed in open field. That worked while the drive model WROTE `r.vel` every tick,
 * because whatever the fake wrote was overwritten the next tick and could not accumulate.
 * With the drive arriving as a FORCE the write persists, and it went wrong exactly the way
 * an un-overwritten velocity write does: grinding into a wall-pinned artifact, the chassis
 * wedged 8.2 degrees off its commanded heading and slid diagonally at 24.0 in/s, driving the
 * artifact 26.5in sideways along the wall it was supposed to be stuck against.
 *
 * A dynamic body needs none of it. The artifact is a real body between the chassis and the
 * wall, the solver enforces both contacts at once, and the stall is the constraint being
 * satisfied rather than a velocity somebody wrote. Measured on the same scene: 24.00 -> 0.03
 * in/s, heading 8.21 -> 0.00 degrees off, and the artifact stays where it was pinned
 * (x 26.50 -> -0.00) instead of being squirted along the wall.
 *
 * The old note said a heavy dynamic body had been tried and did not stall "because an
 * artifact is ~0.3lb against 20-42lb and the drivetrain restores the loss the same tick".
 * The mass ratio is unchanged and is not the point: a non-penetration constraint does not
 * care how light the thing in the middle is, only that it cannot move. What changed is that
 * the drivetrain no longer restores the loss, because it no longer writes the velocity at all.
 *
 * ...AND PRODUCT DECISION #7 STILL HOLDS, for a physical reason rather than by construction:
 * `BALL_MASS` is 0.2lb against a `shoveMass` of 15-25, so an artifact arriving under its own
 * momentum out of the gate moves a parked robot by a thousandth of an inch. Outflow does not
 * shove because it cannot, not because it is forbidden.
 *
 * A robot on an AUTO PATH stays KINEMATIC: the path owns where it goes, so artifacts must
 * collide with it and must not move it — the same call `solveRobots` makes, for the same reason.
 *
 * The INTAKE is deliberately absent: its mouth is open to artifacts by design (product
 * decision #10) and its funnel geometry is per-preset. That region stays bespoke, in
 * `collideBallRobot`, which now handles ONLY it.
 */
/**
 * THE MOMENTUM THE ARTIFACTS IN REACH ACTUALLY CARRY — the ceiling on what they may hand a
 * chassis in one tick.
 *
 * `BALL_MASS · Σ|v|` over the ground artifacts close enough to touch, so the bound is the real
 * conservation statement rather than a constant: an artifact cannot give away momentum it does
 * not have, and three of them squeezing past a corner can give away exactly three artifacts'
 * worth. It sums rather than takes the maximum because a STREAM is the reported case, and a
 * bound that only ever admitted one artifact would be a different, tighter lie.
 *
 * This used to be `BALL_MASS · PHYS_MAX_ROBOT_SPEED`, which is 300 in/s — a solver-explosion
 * guard standing in for "however fast an artifact might conceivably be", and 5-8x looser than
 * any artifact on this field ever moves. Measured on a real match replay, the artifact channel
 * asked to move a chassis sideways by up to 14.9 in/s in a SINGLE TICK, 78 ticks a match over
 * 0.5 in/s; the constant bound admitted 4.5 of that, and the momentum bound admits what the
 * artifacts brought with them.
 *
 * The radius is generous (half-diagonal + a diameter): it is a bound, not a contact test, and
 * counting an artifact that turns out not to touch only makes the ceiling slightly higher —
 * whereas missing one that does touch would clip a real collision.
 *
 * ⚠️ IT MUST BE MEASURED BEFORE THE STEP, and that is not a detail. Read afterwards it includes
 * the speed the ROBOT ITSELF just gave the artifacts, so a chassis driving a row of them along
 * a wall keeps their momentum high, which keeps its own ceiling high, and momentum it handed
 * out comes straight back as sideways push — measured at 20 degrees into five artifacts resting
 * on a wall, the chassis squared up and then travelled 29.83in ALONG the wall while commanding
 * nothing but forward, against 0.98in on the bare wall. A bound that the bounded party can
 * inflate is not a bound. Taken before the solve it is what the artifacts BROUGHT with them.
 */
function artifactMomentum(world: World, r: RobotState): number {
  const reach = hyp(r.spec.length, r.spec.width) / 2 + 2 * C.BALL_RADIUS;
  let sum = 0;
  for (const b of world.balls) {
    if (b.state.kind !== 'ground') continue;
    const dx = b.pos.x - r.pos.x;
    const dy = b.pos.y - r.pos.y;
    if (dx * dx + dy * dy > reach * reach) continue;
    sum += hyp(b.vel.x, b.vel.y);
  }
  return sum;
}

export function solveBalls(
  world: World,
  dt: number,
  colliders: FieldColliders,
  claimed: Set<number> = new Set(),
): void {
  const groundBalls = world.balls.filter((b) => b.state.kind === 'ground');
  if (groundBalls.length === 0) return;

  // ...measured NOW, on the velocities the artifacts arrived with — see `artifactMomentum`
  const brought = new Map<number, number>();
  for (const r of world.robots) brought.set(r.id, artifactMomentum(world, r));

  const rw = makeWorld(
    dt,
    colliders,
    C.PHYS_BALL_CONTACT_FREQ,
    C.PHYS_BALL_ALLOWED_ERROR,
    FIELD_GROUP,
  );
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
  const chassis: { r: RobotState; body: RAPIER.RigidBody }[] = [];
  for (const r of world.robots) {
    const body = rw.createRigidBody(
      (r.autoPathActive
        ? RAPIER.RigidBodyDesc.kinematicVelocityBased()
        : RAPIER.RigidBodyDesc.dynamic()
      )
        .setTranslation(r.pos.x, r.pos.y)
        .setRotation(r.heading)
        .setLinvel(r.vel.x, r.vel.y)
        .setAngvel(r.angVel),
    );
    /**
     * THE SAME MASS PROPERTIES `solveRobots` STATES, so the two solves agree about how hard
     * this robot is to shove and to spin. `shoveMass` is push AUTHORITY rather than weight
     * (see drivetrain.ts) and `chassisInertia` is the chassis rectangle's about its own
     * centre — and here the centre of mass needs no offset at all, because unlike the robot
     * solve's footprint box (shifted forward by half the intake reach) this collider IS the
     * chassis, centred on the body origin.
     *
     * NO DRIVE FORCE IS APPLIED HERE. The wheels already acted, in `solveRobots`, earlier in
     * this same tick; adding the wrench again would drive the robot twice.
     */
    const m = shoveMass(r.spec, r.butterflyTank, r.powerDraw);
    rw.createCollider(
      RAPIER.ColliderDesc.cuboid(r.spec.length / 2, r.spec.width / 2)
        .setMassProperties(m, { x: 0, y: 0 }, chassisInertia(m, r.spec))
        .setRestitution(C.BALL_ROBOT_RESTITUTION)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
        // artifacts only — not the field, not each other, not what the intake has hold of.
        // See CHASSIS_GROUP: everything else in that list belongs to `solveRobots`.
        .setCollisionGroups(CHASSIS_GROUP)
        .setFriction(C.PHYS_FRICTION),
      body,
    );
    if (!r.autoPathActive) chassis.push({ r, body });
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

  /**
   * VELOCITY ONLY, NEVER THE POSE. `solveRobots` owns where a robot is and which way it
   * faces — it is the pass that has the walls, the other robots and the gate arms in it, and
   * it holds the perimeter invariant. Taking a pose from here would let a solve that cannot
   * see any of that write one. So this reports what the ARTIFACTS did to the robot's motion
   * and the next tick's drive answers it, which is exactly the shape the bespoke pass this
   * replaces had (it only ever touched `r.vel` either).
   *
   * The guards are the same solver-explosion ceilings `solveRobots` applies and are dead code
   * for the same reason: nothing an 0.2lb artifact does to a 15-25lb chassis approaches them.
   */
  for (const { r, body } of chassis) {
    const v = body.linvel();
    const speed = hyp(v.x, v.y);
    const scale = speed > C.PHYS_MAX_ROBOT_SPEED ? C.PHYS_MAX_ROBOT_SPEED / speed : 1;
    /**
     * ...AND AN ARTIFACT MAY ONLY MOVE A ROBOT BY WHAT AN ARTIFACT WEIGHS — decision #7.
     *
     * The body stays dynamic at its real collision mass, because anything heavier stops
     * separating properly and artifacts sink into the chassis: measured with it immovable,
     * 5.26in of a 5in diameter buried and 87 ticks with an artifact CENTRE inside the robot,
     * which is the "balls go on top of the robot" report. But its POSE is never taken from
     * this solve — only its velocity — so separation stays honest while the MOTION handed back
     * is bounded by the momentum the artifacts in reach ACTUALLY carry (`artifactMomentum`),
     * which against a 15-25lb chassis is well under an inch per second.
     *
     * Past that it is not artifact momentum, it is the SCRIPTED half of the model leaking
     * authority — the rail decides when and where artifacts arrive, and a robot parked on the
     * outflow is exactly where that shows: "as the balls flow out and try to squeeze past the
     * small gap between the intake corner and the field wall, they actually push the robot
     * away to the side and let the balls go."
     */
    const cap =
      (C.BALL_MASS * (brought.get(r.id) ?? 0)) /
      Math.max(shoveMass(r.spec, r.butterflyTank, r.powerDraw), 1e-6);
    let dvx = v.x * scale - r.vel.x;
    let dvy = v.y * scale - r.vel.y;
    /**
     * ACROSS THE ROBOT ONLY. Along its wheels an artifact must be able to stop it — that is
     * the pin stall, and bounding it there means a robot simply grinds through a jammed
     * artifact instead (measured: 5.34in of a 5in diameter buried). Across the wheels there is
     * nothing to negotiate: a stream squeezing past a corner cannot walk a robot sideways.
     */
    const rc = dcos(r.heading);
    const rs = dsin(r.heading);
    const lat = -dvx * rs + dvy * rc;
    const over = Math.abs(lat) - cap;
    if (over > 0) {
      const back = Math.sign(lat) * over;
      dvx += rs * back;
      dvy -= rc * back;
    }
    r.vel.x += dvx;
    r.vel.y += dvy;
    const dw = clamp(body.angvel(), -C.PHYS_MAX_ROBOT_SPIN, C.PHYS_MAX_ROBOT_SPIN) - r.angVel;
    const wCap = cap / Math.max(hyp(r.spec.length, r.spec.width) / 2, 1);
    r.angVel += Math.abs(dw) > wCap ? Math.sign(dw) * wCap : dw;
  }

  /**
   * ...AND A ROBOT MAY NOT STAND WHERE AN ARTIFACT IS.
   *
   * THE ORDERING IS THE WHOLE TRICK, and it is what lets this be stated without predicting
   * anything. The solve above has just moved every artifact that COULD move; anything still
   * deep inside a chassis is, by definition, one that could not. So there is no pin test here,
   * no probe against the statics, and no guess about which way the robot meant to push — the
   * artifacts sort themselves, and what is left over is simply wrong and gets undone.
   *
   * The ROBOT is backed out, along the shortest way out of its own chassis box. That is the
   * same shape of rule as the perimeter invariant in `solveRobots`: a hard geometric statement
   * applied after the solver has had its say, not a force smuggled into the drive. Which
   * matters twice — `wantX/wantY` stay exactly what the wheels asked for, so the tyres still
   * read every contact as slip and resist it, and nothing here can rotate a drive force into
   * strafe the way subtracting from the wrench did.
   *
   * IT IS NOT A SHOVE and does not reopen product decision #7. An artifact gains no ground by
   * it: the robot is only ever put back where it would have been had it not driven through
   * something, only while it is actually inside, and it cannot accumulate because it is
   * applied every tick and bounded by the overlap it removes. Velocity is untouched — a robot
   * still driving in simply does it again next tick and is evicted again, which is what a
   * stall looks like from outside, and one driving away is not held.
   *
   * COMPONENTWISE MAX, NOT A SUM: several artifacts along one face each demand their own
   * clearance, and adding those demands together would fling the chassis off them.
   */
  for (const { r } of chassis) {
    const hl = r.spec.length / 2;
    const hw = r.spec.width / 2;
    let px = 0; // the deepest eviction any artifact demands, in the ROBOT frame
    let py = 0;
    for (const { b } of ballBodies) {
      const local = rot({ x: b.pos.x - r.pos.x, y: b.pos.y - r.pos.y }, -r.heading);
      /**
       * TRUE BOX-VS-CIRCLE, not the Minkowski box.
       *
       * Testing `|x| < half + R` on both axes calls a circle "overlapping" anywhere inside the
       * rounded rectangle's bounding box, which near a CORNER is a region the circle does not
       * actually reach. Evicting on that shoves robots that are squishing nothing: it nudged a
       * ball the intake was funnelling (9.8 -> 10.2) and put a turning tank over its sideways
       * budget at exactly the threshold. The honest test is the distance to the nearest point
       * of the box.
       */
      let nx: number;
      let ny: number;
      let pen: number;
      const cx = clamp(local.x, -hl, hl);
      const cy = clamp(local.y, -hw, hw);
      const dx = local.x - cx;
      const dy = local.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > 1e-12) {
        // centre OUTSIDE the box: the nearest feature is that clamped point
        const d = Math.sqrt(d2);
        pen = C.BALL_RADIUS - d;
        nx = dx / d;
        ny = dy / d;
      } else {
        // centre INSIDE it — a closest-point test degenerates here, so leave by the nearest
        // FACE. This is the case the whole pass exists for: 5.09in of a 5in artifact buried in
        // a flank, its centre inside the chassis for 290 consecutive ticks.
        const ox = hl - Math.abs(local.x);
        const oy = hw - Math.abs(local.y);
        if (ox < oy) {
          nx = Math.sign(local.x || 1);
          ny = 0;
          pen = ox + C.BALL_RADIUS;
        } else {
          nx = 0;
          ny = Math.sign(local.y || 1);
          pen = oy + C.BALL_RADIUS;
        }
      }
      const need = pen - C.BALL_SQUISH_SLOP;
      if (need <= 0) continue; // a resting contact, which is what contact looks like
      // the robot leaves along -n, away from the artifact
      if (Math.abs(nx * need) > Math.abs(px)) px = -nx * need;
      if (Math.abs(ny * need) > Math.abs(py)) py = -ny * need;
    }
    if (px !== 0 || py !== 0) {
      const world = rot({ x: px, y: py }, r.heading);
      r.pos.x += world.x;
      r.pos.y += world.y;
    }
  }

  rw.free();
}
