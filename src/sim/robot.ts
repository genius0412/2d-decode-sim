import type { Artifact, ArtifactColor, RobotCommand, RobotSpec, RobotState, World } from '../types';
import * as C from '../config';
import { approach, rot, wrapAngle, hyp, dsin, dcos, datan2, clamp } from '../math';
import { classifierRect, flywheelSpinTarget, footprintExtents, goalCenter, launchTriangles, viewAngleOf } from './field';
import { activeDrive, driveParams, motorStep, motorStepVec, shoveMass } from './drivetrain';
import { clampBallPosToStatics, robotIntersectsConvex } from './physics';
import { robotsEnabled } from './match';

/** launch is legal when ANY part of the robot is inside a launch zone. Uses a
 * true OBB-vs-triangle overlap (not just corner containment): the launch wedge
 * narrows to a point at the field center, so a robot straddling that apex covers
 * the zone even when all four corners sit outside both diagonals — a corner-only
 * test read OUT there (the robot had to bury its center in before it would fire). */
export function robotInLaunchZone(r: RobotState): boolean {
  return launchTriangles().some((t) => robotIntersectsConvex(r, t));
}

export function turretWorldPos(r: RobotState): { x: number; y: number } {
  const o = rot({ x: r.spec.length * C.TURRET_OFFSET_FRAC, y: 0 }, r.heading);
  return { x: r.pos.x + o.x, y: r.pos.y + o.y };
}

/** exact ballistic solution through the goal opening. The hood angle
 * steepens at close range so a solution exists at every distance. */
function solveShot(d: number): { speed: number; angle: number } {
  const dh = C.GOAL_OPENING_Z - C.LAUNCH_HEIGHT;
  const dd = Math.max(d, 0.5);
  // Minimum-speed trajectory that reaches the goal opening at (dd, dh). Unlike a
  // fixed-hood solve, it ALWAYS exists, is finite, and varies SMOOTHLY with
  // distance — no clamp singularity and no point-blank fallback (the old solve
  // jumped 96→316→178 in/s across d=4..6 and had NO solution inside ~5in). The
  // launch angle is the adaptive hood: it sweeps from ~89° at point-blank (a
  // near-vertical lob into the elevated goal) down toward ~45° far out.
  //   v_min² = g·(dh + √(d²+dh²)),  angle = atan2(dh + √(d²+dh²), d)
  const reach = hyp(dd, dh);
  const angle = datan2(dh + reach, dd);
  const speed = Math.min(Math.sqrt(C.GRAVITY * (dh + reach)), C.LAUNCH_MAX_SPEED);
  return { speed, angle };
}

/** aim solution that lead-compensates the chassis velocity the ball will
 * inherit, so shooting on the move stays accurate */
export function aimSolution(r: RobotState): { yaw: number; speed: number; angle: number } {
  const tp = turretWorldPos(r);
  const g = goalCenter(r.alliance);
  const wv = { x: r.vel.x * C.SHOT_ROBOT_VEL_INHERIT, y: r.vel.y * C.SHOT_ROBOT_VEL_INHERIT };
  let dx = g.x - tp.x;
  let dy = g.y - tp.y;

  // console.log(`[Robot ${r.id} - ${r.alliance}] Aiming:`);
  // console.log(`  Robot Pos: (${r.pos.x.toFixed(2)}, ${r.pos.y.toFixed(2)}), Heading: ${(r.heading * 180 / Math.PI).toFixed(2)} deg`);
  // console.log(`  Turret Pos: (${tp.x.toFixed(2)}, ${tp.y.toFixed(2)})`);
  // console.log(`  Target Goal Center: (${g.x.toFixed(2)}, ${g.y.toFixed(2)})`);
  // console.log(`  Vector to Goal (dx, dy): (${dx.toFixed(2)}, ${dy.toFixed(2)})`);

  let sol = solveShot(hyp(dx, dy));
  for (let i = 0; i < 3; i++) {
    const t = hyp(dx, dy) / Math.max(sol.speed * dcos(sol.angle), 1);
    dx = g.x - tp.x - wv.x * t;
    dy = g.y - tp.y - wv.y * t;
    sol = solveShot(hyp(dx, dy));
  }
  const yaw = datan2(dy, dx);
  // console.log(`  Calculated Yaw: ${(yaw * 180 / Math.PI).toFixed(2)} deg`);
  return { yaw: yaw, speed: sol.speed, angle: sol.angle };
}

/**
 * Updates the robot's drive physics (position, velocity, angular velocity, heading).
 * This function is for movement only.
 */
/** what the drivetrain asks the solver for this tick: a world-frame force and a torque
 *  about the chassis centre. See the note at the bottom of `updateRobot`. */
export interface DriveWrench {
  fx: number;
  fy: number;
  tau: number;
  /** the velocity and spin the motor model asked for. `solveRobots` diffs its own answer
   *  against these to record what the CONTACTS did — see `RobotState.slipX`. */
  wantX: number;
  wantY: number;
  wantW: number;
}

export function updateRobot(
  world: World,
  r: RobotState,
  cmd: RobotCommand,
  dt: number,
): DriveWrench {
  // ---- BUTTERFLY: drop the other wheel set (edge-triggered, so holding swaps once) ----
  // Lives here rather than in either game's step because it is a DRIVETRAIN behaviour and
  // both games route their drive through updateRobot. The swap is instantaneous in the
  // model: the real lift takes a moment, but at 60 Hz that is a couple of ticks and the
  // interesting decision is WHEN to swap, not the servo travel.
  if (r.spec.drivetrain === 'butterfly') {
    const wants = cmd.driveMode ?? false;
    if (wants && !r.driveModeHeld) r.butterflyTank = !r.butterflyTank;
    r.driveModeHeld = wants;
  }
  // ---- drive: driver frame -> robot frame -------------------------------
  const dp = driveParams(r.spec, r.butterflyTank);
  // ---- power draw: a spun-up flywheel (inertia × spin, set last tick in
  // updateRobotActions) plus a running intake pull current off the drive
  // motors — slow the LOCAL dp copy (driveParams() itself is untouched so the
  // 75/7/280 calibration holds) and record it for the Rapier shove.
  const intakeDraw =
    (cmd.intake || r.autoIntake) && r.hopper.length < C.HOPPER_CAPACITY;
  // flywheel: a small steady HOLD cost (being far barely matters) plus the
  // DOMINANT SPIN-UP cost of accelerating the wheel while driving away from the
  // goal — both scale with the wheel's inertia (heavy = expensive to spin up).
  const flywheelDraw =
    r.spec.flywheelInertia *
    (C.POWER_DRAW_FLYWHEEL_HOLD * r.flywheelSpin +
      C.POWER_DRAW_FLYWHEEL_SPINUP * r.flywheelSpinRate);
  // swerve: the four steering (pivot) motors pull steady current just to hold +
  // correct the pod angles, on top of the drive motors — always a bit slower.
  const swerveDraw = dp.saturation === 'vec' ? C.POWER_DRAW_SWERVE : 0;
  // drive current rises with RPM: a drivetrain geared for more speed pulls more
  // current from the pack (only above the reference rpm, so base calibration holds)
  // → diminishing top-speed returns on cranking rpm + more sag under load.
  const driveDraw =
    C.POWER_DRAW_DRIVE *
    clamp(
      // the rpm ACTUALLY turning the wheels — a butterfly in tank mode draws on its
      // traction gearing, not the mecanum slider it isn't using
      (activeDrive(r.spec, r.butterflyTank).rpm - C.REF_DRIVE_RPM) /
        (C.POWER_DRAW_DRIVE_TOP_RPM - C.REF_DRIVE_RPM),
      0,
      1,
    );
  const draw = Math.min(
    flywheelDraw + (intakeDraw ? C.POWER_DRAW_INTAKE : 0) + swerveDraw + driveDraw,
    C.POWER_DRAW_MAX,
  );
  r.powerDraw = draw;
  const slow = 1 - draw;
  /**
   * ...BUT NOT THE TYRES. Power draw is current the flywheel and intake are taking away from
   * the drive MOTORS, and the traction model below is `LATERAL_GRIP` times this drivetrain's
   * traction ceiling — which is mu*g, a property of rubber and weight. A spun-up flywheel does
   * not make the wheels slippery.
   *
   * Taken from the scaled copy it did exactly that, and worst on the builds that carry the
   * most flywheel: the reported gate surge came from a mecanum at `flywheelInertia` 1, whose
   * tyres were reclaiming a contact's sideways shove at two thirds of the rate they should.
   */
  const tractionAccel = dp.accel;
  dp.maxSpeed *= slow;
  dp.accel *= slow;
  dp.maxTurn *= slow;
  dp.turnAccel *= slow;
  const viewAngle = viewAngleOf(r.alliance);
  // driver stick vector: +y = away from driver (screen up), +x = driver right.
  // screen -> world undoes the camera rotation
  const stick = { x: cmd.driveX, y: cmd.driveY };
  let robotVec: { x: number; y: number };
  if (r.fieldCentric) {
    const fieldVec = rot(stick, -viewAngle);
    robotVec = rot(fieldVec, -r.heading);
  } else {
    // robot-centric: stick up = robot forward (+x robot), stick right = strafe right (-y robot)
    robotVec = { x: stick.y, y: -stick.x };
  }
  if (dp.strafeMult === 0) robotVec.y = 0; // tank: strafe input is dead
  // wheel power budget: combined demands share the same wheels, and the
  // shape of the budget depends on the drivetrain (see DRIVETRAIN_PRESETS)
  let targetFwd = 0;
  let targetStrafe = 0;
  let targetOmega = 0;

  if (dp.saturation === 'tank') {
    // Tank drive is always commanded as independent side-drive (leftDrive/rightDrive).
    // The control-STYLE preference (Traditional separate-sticks vs Normal arcade) is a
    // per-driver INPUT concern resolved in GameController, so the sim stays pure and
    // the choice applies the same in solo and multiplayer.
    const ld = cmd.leftDrive ?? 0;
    const rd = cmd.rightDrive ?? 0;
    targetFwd = ((ld + rd) / 2) * dp.maxSpeed;
    targetOmega = (rd - ld) * (dp.maxTurn / 2);
    targetStrafe = 0;
  } else {
    const demand =
      dp.saturation === 'vec'
        ? hyp(robotVec.x, robotVec.y) + Math.abs(cmd.rotate)
        : Math.abs(robotVec.x) + Math.abs(robotVec.y) + Math.abs(cmd.rotate);
    const div = Math.max(1, demand);
    targetFwd = (robotVec.x / div) * dp.maxSpeed;
    targetStrafe = (robotVec.y / div) * dp.maxSpeed * dp.strafeMult;
    targetOmega = (cmd.rotate / div) * dp.maxTurn;
  }

  // SWERVE: modeled as FOUR independent steered modules at the wheel corners.
  // Inverse kinematics gives each pod its own target (velocity = translation +
  // ω×r), it steers there with MODULE OPTIMIZATION (pod flip: a >90° change aims
  // the pod opposite + reverses drive, so it never rotates >90° and a 180° reversal
  // is instant), and — crucially — each pod's control loop is IMPERFECT, adding a
  // small INDEPENDENT oscillating error it can't null out. Because the four errors
  // don't cancel, the FORWARD kinematics of the mis-pointed pods yields real drift
  // AND a net yaw wobble when driving straight. `moduleAngles` are the actual pod
  // directions (also rendered).
  if (dp.saturation === 'vec') {
    const cvx = targetFwd; // commanded chassis velocity (robot frame) + rotation
    const cvy = targetStrafe;
    const cw = targetOmega;
    const hx = Math.max(r.spec.length / 2 - C.WHEEL_INSET, 1);
    const hy = Math.max(r.spec.width / 2 - C.WHEEL_INSET, 1);
    const pos: [number, number][] = [
      [hx, hy],
      [hx, -hy],
      [-hx, hy],
      [-hx, -hy],
    ]; // FL, FR, BL, BR — matches drawRobot's wheel order
    const maxStep = C.MODULE_SLEW_RATE * dt;
    const speedFrac = clamp(hyp(r.vel.x, r.vel.y) / dp.maxSpeed, 0, 1);
    let sumX = 0;
    let sumY = 0;
    let sumT = 0;
    for (let i = 0; i < 4; i++) {
      // inverse kinematics: this module's desired velocity vector
      const dvx = cvx - cw * pos[i][1];
      const dvy = cvy + cw * pos[i][0];
      const spd = hyp(dvx, dvy);
      let driveSpd = 0;
      if (spd > 0.02 * dp.maxSpeed) {
        // there IS a command → set this module's TARGET from it (with pod flip)
        driveSpd = spd;
        let tgt = datan2(dvy, dvx);
        if (Math.abs(wrapAngle(tgt - r.moduleAngles[i])) > Math.PI / 2) {
          tgt = wrapAngle(tgt + Math.PI); // pod flip + reverse this module
          driveSpd = -spd;
        }
        r.moduleTargets[i] = tgt;
      }
      // else: HOLD the last commanded target (r.moduleTargets[i]) — the pods keep
      // slewing to the direction you set even after you let go of the stick, so a
      // brief tap still finishes the turn (they don't freeze partway or snap forward).
      const target = r.moduleTargets[i];
      // the steering loop runs EVERY tick (control loops are always applied): it
      // chases a DISTURBED setpoint (target + an independent, speed-scaled error it
      // can't null). One imperfect loop, two visible symptoms: FAST hunt (the buzz you
      // see) rides on a slowly-varying steady-state MISPOINT the loop can't trim. The
      // slow mispoint is what actually carries the robot off line (fast zero-mean hunt
      // integrates to nothing) — but it is DETUNED per pod (each its own slow rate), so
      // the four biases beat in and out of phase and the net offset MEANDERS/REVERSES
      // across a drive instead of a clean constant crab. Same wobble, emergent drift.
      // ∝ actual speed → at rest it's zero and every pod shares `target` → CONVERGE.
      const t = world.time;
      const f = C.SWERVE_WOBBLE_FREQ;
      const ph = i * 1.87 + r.id * 0.7;
      // per-pod detune of the SLOW mispoint — a wide spread so the 4 de-cohere within
      // one wall-to-wall drive (→ the drift direction rotates as you cross the field)
      const drift = C.SWERVE_DRIFT_FREQ * (1 + i * 0.19 + r.id * 0.05);
      const noise =
        0.34 * dsin(t * f * (1 + i * 0.11) + ph) + // fast visible hunt
        0.2 * dsin(t * f * 2.17 + ph * 1.7 + 1.3) + // fast visible hunt
        0.5 * dsin(t * drift + ph * 2.3); // slow steady-state MISPOINT (detuned) → the drift
      const err = C.SWERVE_WOBBLE_AMP * speedFrac * noise;
      const setpoint = wrapAngle(target + err);
      let d = wrapAngle(setpoint - r.moduleAngles[i]);
      if (Math.abs(d) > maxStep) d = Math.sign(d) * maxStep;
      r.moduleAngles[i] = wrapAngle(r.moduleAngles[i] + d);
      // this module actually pushes at driveSpd along its (mis-pointed) direction
      const fx = driveSpd * dcos(r.moduleAngles[i]);
      const fy = driveSpd * dsin(r.moduleAngles[i]);
      sumX += fx;
      sumY += fy;
      sumT += pos[i][0] * fy - pos[i][1] * fx; // moment about center
    }
    // forward kinematics of the four modules → the ACHIEVED chassis motion (equals
    // the command when perfect; the pod errors make it drift + yaw)
    targetFwd = sumX / 4;
    targetStrafe = sumY / 4;
    targetOmega = sumT / (4 * (hx * hx + hy * hy));
  }

  // motor torque–speed integration in the robot frame: accel falls off toward the
  // free speed (dp.maxSpeed / dp.maxTurn) like a real DC motor (see motorStep).
  const velRobot = rot(r.vel, -r.heading);
  /**
   * BEING SHOVED IS NOT THE SAME AS STOPPING YOURSELF.
   *
   * A robot commanding nothing while an opponent is leaning on it is not braking, it is being
   * back-driven: the wheels roll and what resists is back-EMF plus rolling drag, not the full
   * 1.4x stopping authority `MOTOR_BRAKE_MULT` gives a driver hauling their own momentum down.
   * Applied to the shove, that number said an idle chassis resists harder than any opponent
   * can drive, and pushing one was nearly impossible (see `MOTOR_SHOVE_BRAKE`).
   *
   * The contact test reads LAST tick's `rrContacts` — this runs before the solve that records
   * them, and `world.ts` clears them just before that solve for exactly this reason. One tick
   * of latency on "am I being leaned on" is nothing next to the 0.2s a push takes to build.
   */
  const unpowered = targetFwd === 0 && targetStrafe === 0;
  const shoved =
    unpowered && world.rrContacts.some((c) => c.a === r.id || c.b === r.id);
  // translation steps as a VECTOR so the accel budget is isotropic — driving diagonally
  // accelerates at the same rate as straight (no √2 diagonal-speed advantage).
  const stepped = motorStepVec(
    velRobot.x,
    velRobot.y,
    targetFwd,
    targetStrafe,
    dp.accel,
    dp.maxSpeed,
    dt,
    shoved ? C.MOTOR_SHOVE_BRAKE : C.MOTOR_BRAKE_MULT,
  );
  /**
   * ...AND THE WHEELS HAND THE SOLVER A FORCE, NOT A VELOCITY.
   *
   * This is the whole of slice A. The motor model is UNCHANGED — `motorStepVec` above still
   * decides the velocity the drivetrain wants this tick, from the same torque–speed curve and
   * the same traction-limited `dp.accel` — but that answer is now converted into the force
   * that would produce it (`F = m·Δv/dt`) and handed to Rapier, instead of being written
   * straight onto `r.vel` behind the solver's back.
   *
   * In FREE SPACE the two are identical: `a = F/m` is the accel the motor model asked for, so
   * top speed, the accel curve, the turn rate and stopping distance do not move (the balance
   * contract). In CONTACT they are completely different, and that is the point — a velocity
   * that is imposed forces the solver to invent whatever normal impulse it takes to satisfy
   * it, so friction (µ·N) was a fraction of an unbounded number and a bumper gripped like a
   * clamp. A force is a force: the contact can only ever resolve what the wheels actually
   * supply, and a pushing contest settles at the ratio of the two `pushForce`s by itself.
   *
   * `shoveMass` STAYS the mass, and staying is what keeps the balance intact — it is defined
   * as `pushForce / accel`, so `m·a_cmd` in free space reproduces the old accel exactly while
   * the sustained force at the stops is exactly `pushForce`. See drivetrain.ts; the note there
   * about the sim "pushing by SETTING VELOCITY" is what this replaces.
   */
  const wantRobot = { x: stepped.x - velRobot.x, y: stepped.y - velRobot.y };
  const want = rot(wantRobot, r.heading);
  const m = shoveMass(r.spec, r.butterflyTank, r.powerDraw);
  let fx = (m * want.x) / dt;
  let fy = (m * want.y) / dt;

  /**
   * The turn, as a TORQUE about the chassis centre. Same `motorStep` the heading integration
   * used to consume; `solveRobots` gives the body the matching inertia, so in free space the
   * resulting dω is exactly the one the motor model asked for.
   *
   * ...AND THE TYRES REFUSE A SPIN THEY ARE NOT MAKING, which is the angular twin of the
   * cornering force below and the thing a rotation-locked body never needed. Being spun by a
   * contact is resisted by the wheels' LATERAL grip at their moment arm, not by the drive
   * motors' torque — that is the whole difference between treads and rollers, and without it
   * a tank leaning on a robot strafing out from under it was yawed 17.7° by the friction and
   * then drove off along its own new heading. `LATERAL_GRIP` is already that quantity (the
   * drivetrain's sideways traction as a fraction of its drive ceiling), so this introduces no
   * new dial: four wheels at the half-diagonal can refuse `grip · accel · m · d` of torque,
   * against the motors' `I · turnAccel`, and whichever is larger is what the chassis has.
   *
   * IT ONLY EVER BRAKES, and only while ROBOT-ROBOT CONTACT is on the books — so free-space
   * driving is untouched to the digit (the balance contract) and a commanded turn is never
   * slowed, since `motorStep` reads the boost only on the braking branch and `approach` still
   * stops dead at the target. Same gate, and same reasoning, as `MOTOR_SHOVE_BRAKE`.
   */
  const inertia = chassisInertia(m, r.spec);
  const wNext = motorStep(r.angVel, targetOmega, dp.turnAccel, dp.maxTurn, dt);
  let tau = (inertia * (wNext - r.angVel)) / dt;

  /**
   * ...AND THE TYRES ARE FOUR WHEELS, EACH WITH ITS OWN GRIP — slice B.
   *
   * A wheel makes force in two ways and they are not the same thing. Along its roll axis the
   * motor drives it, and that is the chassis-level model above, unchanged. ACROSS that axis it
   * makes no force of its own at all: it either grips and the chassis goes where the wheels
   * point, or it breaks traction and scrubs. That second half is what a chassis-level model
   * cannot express, and it is the whole of robot-on-robot feel — treads refusing to be dragged
   * sideways or spun, rollers giving way.
   *
   * SLICE A APPROXIMATED IT AFTER THE FACT: `solveRobots` compared the solver's answer against
   * what the drive asked for and trimmed the difference (`holdLat`/`yawHold`), Coulomb-style.
   * That works for a steady lean and fails for an impact, because trimming happens AFTER the
   * solve and cannot tell a 40 in/s hit from a 2 in/s drag except by magnitude — so a scale
   * factor (`CONTACT_YAW_HOLD`) had to split the difference, and near-centred rams stopped
   * spinning anybody.
   *
   * Now it is a FORCE, computed per wheel and handed to the solver, which resolves it
   * SIMULTANEOUSLY with the contact. The discrimination falls out for free: a lean asks for
   * less than the tyre can supply and is refused outright, while an impact asks for more than
   * `LATERAL_GRIP · accel / 4` and the excess goes through as real motion. Nothing decides
   * which case it is — the traction limit does.
   *
   * PER WHEEL AND NOT PER CHASSIS, because that is what produces the yaw. Four lateral forces
   * at their own moment arms resist a spin exactly as far as their grip allows, so the same
   * expression that stops a tank being dragged sideways stops it being twisted, and neither
   * needs a term of its own.
   *
   * THE SLIP IS MEASURED AGAINST THE COMMANDED MOTION, not against zero — that is what keeps
   * this out of the balance. A robot turning at the rate it asked for is scrubbing its wheels
   * exactly as much as the drive model already accounts for, so the deviation is zero and
   * nothing is applied; in free space the term does not exist. What it sees is the difference
   * between where the chassis is going and where the wheels are pointed, which only a contact
   * (or a wall) can produce.
   *
   * SWERVE READS ITS PODS. `moduleAngles` is where each wheel is actually pointed, wobble and
   * all, so a mis-steered pod resists along the wrong axis by itself.
   */
  const grip = C.LATERAL_GRIP[r.spec.drivetrain] ?? 0.5;
  /**
   * ...AND THE SAME WHEELS CARRY THE VELOCITY ROUND A CORNER.
   *
   * Turning while moving needs a lateral force of `m·v·ω` — that is what holds the velocity's
   * angle to the chassis while the nose comes round. Without it the world-frame velocity simply
   * stays where it was and every drivetrain side-slips through every corner, which is "I drive
   * straight and turn with tank and feel shifted sideways in a weird way".
   *
   * IT IS THE CENTRIPETAL DEMAND, NOT A CORRECTION OF THE ERROR AFTERWARDS. Correcting the
   * lateral velocity once it has appeared is a first-order lag and leaves a permanent residual:
   * measured, a tank through the smoke suite's own turn carried 3.0% of its velocity sideways
   * that way, against 0.4% here and a 1.0% ceiling. The tyres do this BEFORE the slip exists,
   * which is exactly what the old velocity-carve was doing when it rotated `r.vel` by the
   * heading change — the same quantity, stated as the force it always was.
   *
   * The cap is unchanged: `LATERAL_GRIP` as a fraction of the drivetrain's own traction
   * ceiling. Past what the tyres can supply — fast enough, turning hard enough — the robot
   * slides through the corner exactly as it did before, and it slides sooner on omnis than on
   * treads.
   */
  const speed = hyp(r.vel.x, r.vel.y);
  if (speed > 0.01 && r.angVel !== 0) {
    const a = Math.min(speed * Math.abs(r.angVel), grip * tractionAccel);
    const sgn = Math.sign(r.angVel);
    fx += (m * a * -r.vel.y * sgn) / speed;
    fy += (m * a * r.vel.x * sgn) / speed;
  }
  const wheels = wheelLocals(r.spec);
  // the budget ONE wheel has across its roll axis, as a force
  const wheelCap = (grip * tractionAccel * m) / wheels.length;
  const swerve = dp.saturation === 'vec';
  // the chassis slip a contact left last tick, in the ROBOT frame (see RobotState.slipX)
  const slipW = r.slipW ?? 0;
  const sl = rot({ x: r.slipX ?? 0, y: r.slipY ?? 0 }, -r.heading);
  if (sl.x !== 0 || sl.y !== 0 || slipW !== 0) {
    for (let i = 0; i < wheels.length; i++) {
      const wl = wheels[i];
      // how fast THIS wheel is being dragged across itself, rotation included
      const sx = sl.x - slipW * wl.y;
      const sy = sl.y + slipW * wl.x;
      // ...across the axis it rolls on. A pod steers; everything else is chassis-aligned.
      const ang = swerve ? (r.moduleAngles?.[i] ?? 0) : 0;
      const lx = -dsin(ang);
      const ly = dcos(ang);
      const slip = sx * lx + sy * ly;
      if (slip === 0) continue;
      /**
       * A TYRE OPPOSES MOTION. IT NEVER CREATES IT.
       *
       * `slip` is the difference between what the solver did and what the wrench asked for,
       * which reads both ways: a contact that DRAGS the chassis sideways shows up with one
       * sign and is correctly refused, and a contact that BLOCKS it shows up with the other —
       * at which point nulling the difference means shoving the chassis in the direction the
       * wall just prevented. Reported from a match file as a surge of strafing speed while
       * barely moving and already against the gate: measured at three separate moments in that
       * run, a robot at a DEAD STOP with no rotation and nothing else touching it accelerated
       * sideways from 0.0 to 6.6 to 10.9 in/s, roughly 400 in/s^2, which is more than its
       * drivetrain can produce in the first place.
       *
       * So the force is admitted only when it opposes how this wheel is ACTUALLY sliding
       * across itself. Nothing else about the model changes: a drag is still refused up to
       * grip, an impact still gets through, and a blocked robot simply stays blocked.
       */
      const across = (velRobot.x - r.angVel * wl.y) * lx + (velRobot.y + r.angVel * wl.x) * ly;
      if (slip * across <= 0) continue;
      // the force that would null it this tick, and what this one tyre can actually hold
      // EXACTLY what was seen, no more. The tyres answer a tick late, so answering HARDER to
      // close that gap is tempting and it oscillates: at a gain of 1.5 an 8in off-centre ram
      // came out at 0.34 degrees against 11.7 at unity, because the over-correction cancels
      // the spin it is chasing. Unity is the only stable answer.
      const want = (-slip * m) / wheels.length / dt;
      const f = clamp(want, -wheelCap, wheelCap);
      const world = rot({ x: f * lx, y: f * ly }, r.heading);
      fx += world.x;
      fy += world.y;
      tau += wl.x * f * ly - wl.y * f * lx;
    }
  }
  /**
   * ...AND AN ARTIFACT THAT CANNOT GET OUT OF THE WAY STALLS THE DRIVE.
   *
   * The chassis collides with artifacts in the solve now, so a robot pushing one into a wall is
   * stopped by the contact chain — but ONLY while the artifact is in front of the chassis. The
   * INTAKE MOUTH is deliberately not a collider (it is open by design, and its funnel geometry
   * is per-preset), so an artifact that ends up in the mouth is invisible to that chain: the
   * robot keeps driving until its own intake tip reaches the wall, which leaves less clearance
   * than an artifact's diameter, and the artifact has nowhere to be except inside the chassis.
   * Reported as "balls are not colliding with the robot and instead go on top", and measured on
   * a five-artifact row rammed into the far wall: one buried 2.66in of its 5in diameter into the
   * front face, at a dead stop, for 219 consecutive ticks.
   *
   * This is the rule the sim has always had — "stall the robot first and there is no squeeze
   * left to answer wrongly" — but as a FORCE rather than a write to `r.vel` behind the solver's
   * back, which is what made the old version fight a force-based drive. Only the component
   * pushing INTO the blocked artifact is removed, so the robot can still back off or drive
   * along the wall, exactly as before.
   *
   * An artifact the INTAKE is drawing in is exempt: it is on its way into the hopper, not in
   * the way. Once the hopper is full there is nothing being acquired and the stall applies.
   */
  const push = hyp(fx, fy);
  if (push > 0) {
    const px = fx / push;
    const py = fy / push;
    const eating = (cmd.intake || r.autoIntake) && r.hopper.length < C.HOPPER_CAPACITY;
    const ext = footprintExtents(r.spec);
    for (const b of world.balls) {
      if (b.state.kind !== 'ground') continue;
      const rel = { x: b.pos.x - r.pos.x, y: b.pos.y - r.pos.y };
      if (rel.x * px + rel.y * py <= 0) continue; // behind the push; not in the way
      const l = rot(rel, -r.heading);
      if (l.x > ext.front + C.BALL_RADIUS || l.x < -ext.rear - C.BALL_RADIUS) continue;
      if (Math.abs(l.y) > ext.half + C.BALL_RADIUS) continue;
      if (eating && l.x > 0) continue; // in the mouth and being swallowed
      // where this tick's push would put it, and whether the field refuses that
      const probe = { x: b.pos.x + px * C.BALL_RADIUS, y: b.pos.y + py * C.BALL_RADIUS };
      const clamped = clampBallPosToStatics(probe);
      const bx = probe.x - clamped.x;
      const by = probe.y - clamped.y;
      const blocked = hyp(bx, by);
      if (blocked <= C.BALL_PIN_SLOP) continue;
      const nx = bx / blocked;
      const ny = by / blocked;
      const into = fx * nx + fy * ny;
      if (into > 0) {
        fx -= nx * into;
        fy -= ny * into;
      }
      break;
    }
  }

  /**
   * WHAT THIS WRENCH ITSELF WILL PRODUCE, in free space — the whole of it, traction included,
   * not just the motor's target. `solveRobots` diffs the solver's answer against these to find
   * what the CONTACTS did, so anything we apply on purpose has to be in here or the model
   * reads its own work as fresh slip and fights it: measured, that was a ±2.07 in/s limit
   * cycle running forever with nothing touching the robot.
   */
  return {
    fx,
    fy,
    tau,
    wantX: r.vel.x + (fx / m) * dt,
    wantY: r.vel.y + (fy / m) * dt,
    wantW: r.angVel + (tau / inertia) * dt,
  };
}

/**
 * The chassis's angular inertia about its own centre, for `m` = `shoveMass`.
 *
 * A rectangle's `m(L² + W²)/12`, over the CHASSIS rather than the footprint, and about the
 * chassis centre rather than the footprint's — the same expression `squareUpPair`'s two-body
 * impulse already used, so the two agree about how hard this robot is to spin, and the drive
 * model's `maxTurn` (derived from the half-diagonal about that centre) stays the free-space
 * answer. `solveRobots` states the same mass properties on the body.
 */
/**
 * The four wheel ground-contact points in the ROBOT frame — the same layout `wheelContacts`
 * puts in world space for BASE parking, kept here as locals because the traction model needs
 * the moment arms rather than the world positions. FL/FR/BR/BL, matching `moduleAngles`.
 */
export function wheelLocals(spec: RobotSpec): { x: number; y: number }[] {
  const ix = Math.max(spec.length / 2 - C.WHEEL_INSET, 1);
  const iy = Math.max(spec.width / 2 - C.WHEEL_INSET, 1);
  return [
    { x: ix, y: iy },
    { x: ix, y: -iy },
    { x: -ix, y: -iy },
    { x: -ix, y: iy },
  ];
}

export function chassisInertia(m: number, spec: RobotSpec): number {
  return (m * (spec.length * spec.length + spec.width * spec.width)) / 12;
}

/**
 * Updates the robot's actions (turret, fire, intake).
 * This function is called for all robots regardless of movement type.
 */
/**
 * ARTIFACTS THE INTAKE HAS ENGAGED — the ones its funnel is actively drawing in.
 *
 * The intake pulls an artifact toward the throat at `local.x = hl`, which IS the chassis
 * front face, so the funnel and the chassis collider in `solveBalls` are reaching for the
 * same artifact and pulling opposite ways. Measured against main on an artifact 7in
 * off-centre: the funnel draws it 7.0 -> 4.4 -> 3.9, then the chassis shoves it back out
 * 4.2 -> 4.7 -> 5.3 -> 6.1 -> 6.9 -> 7.8 -> 8.8 before it is finally swallowed. 1.45s
 * against main's 0.33s, and that oscillation is what reads as the intake not gripping.
 *
 * The capture ENVELOPE is unchanged either way — the same offsets hit and the same ones
 * miss — so this is not about reach, only about the two passes fighting. An artifact under
 * the wheels belongs to the intake (product decision #10: the mouth is open by design and
 * its funnel geometry is per-preset), so it is excluded from the chassis collider for as
 * long as the intake has hold of it. It still collides with the field and other artifacts.
 *
 * Mirrors the `underWheels` test in updateRobotActions — keep the two in step.
 */
export function intakeClaims(world: World, commands: Map<number, RobotCommand>): Set<number> {
  const claimed = new Set<number>();
  for (const r of world.robots) {
    const running = (commands.get(r.id)?.intake ?? false) || r.autoIntake;
    if (!running || r.hopper.length >= C.HOPPER_CAPACITY) continue;
    const preset = C.INTAKE_PRESETS[r.spec.intake];
    const m = C.intakeMouth(r.spec);
    if (m.drawIn <= 0) continue;
    const hl = r.spec.length / 2;
    const tip = hl + preset.reach;
    // The WHOLE mouth opening, not just the wheel span: on a wedge preset the wheels only
    // span the narrow throat, but the wedge funnels artifacts in from the full width of the
    // opening (product decision #10), and it is those outermost ones the chassis was
    // fighting hardest — sloped at 7in off-centre took 1.45s against main's 0.33s.
    const own = Math.max(m.wedge ? m.throatHalf : m.mouthHalf, m.mouthHalf);
    for (const b of world.balls) {
      if (b.state.kind !== 'ground' || b.z > 6) continue;
      const local = rot({ x: b.pos.x - r.pos.x, y: b.pos.y - r.pos.y }, -r.heading);
      if (
        local.x > hl - C.BALL_RADIUS &&
        local.x < tip + C.BALL_RADIUS &&
        Math.abs(local.y) < own
      ) {
        claimed.add(b.id);
      }
    }
  }
  return claimed;
}

export function updateRobotActions(world: World, r: RobotState, cmd: RobotCommand, dt: number): void {
  // If autoPathActive, force aimAssist, autoIntake, and autoFire to true
  if (r.autoPathActive) {
    r.aimAssist = true;
    r.autoIntake = true;
    r.autoFire = true;
  }

  // ---- turret: aim assist tracks the firing solution exactly -------------
  // Apply aim assist if enabled (now forced true during autoPathActive)
  if (r.aimAssist) {
    r.turretHeading = aimSolution(r).yaw;
  } else {
    // MANUAL AIM: the turret is bolted to the chassis and the driver aims by turning.
    // `fire()` launches along `r.turretHeading`, and this branch used to leave it
    // untouched — so with aim assist off it kept the value `spawn` wrote and the robot
    // shot along one FROZEN world-frame direction for the whole match, no matter which
    // way it was facing. Reported and fixed by @shlok-k720 (PR #37).
    r.turretHeading = r.heading;
  }

  // ---- flywheel spin: ramps with distance to this robot's OWN goal (a far
  // shot needs a faster wheel), and its positive RATE of change tracks how fast
  // the wheel is spinning up as the robot drives away. Both are read one tick
  // later by updateRobot's power draw — the lag is invisible and deterministic.
  {
    const target = flywheelSpinTarget(r.alliance, r.pos);
    // spin-UP only: driving toward the goal (spin falling) draws no drive power
    r.flywheelSpinRate = dt > 0 ? Math.max(0, (target - r.flywheelSpin) / dt) : 0;
    r.flywheelSpin = target;
  }

  // ---- fire: no spin-up before the FIRST shot; between shots the cadence
  // is the intake transfer interval plus flywheel recovery after energetic
  // (long-range) shots — see fireReadyAt set in fire() -----------------------
  const canFire = robotsEnabled(world) && r.hopper.length > 0 && world.time >= r.fireReadyAt;
  const zoneOk = world.mode === 'free' || robotInLaunchZone(r);
  // cmd.fire is true if pathTraversal returns it, or if driver presses it.
  // r.autoFire is true if forced by autoPathActive or set in settings.
  const fireCommanded = cmd.fire || r.autoFire;

  // console.log(`[Robot ${r.id}] Fire check: enabled=${robotsEnabled(world)}, hopper=${r.hopper.length}, time=${world.time.toFixed(2)}, fireReadyAt=${r.fireReadyAt.toFixed(2)}, zoneOk=${zoneOk}, cmd.fire=${cmd.fire}, r.autoFire=${r.autoFire}, autoPathActive=${r.autoPathActive}`);

  if (canFire && zoneOk && fireCommanded) {
    fire(world, r);
  }

  // ---- intake ------------------------------------------------------------
  updateIntake(world, r, cmd);
}


/** a robot's PHYSICAL held balls, in slot order (slot 0 = oldest / fired first) */
function heldSlot(b: Artifact): number {
  return b.state.kind === 'held' ? b.state.slot : 0;
}
function heldBallsOf(world: World, robotId: number): Artifact[] {
  return world.balls
    .filter((b) => b.state.kind === 'held' && b.state.robot === robotId)
    .sort((a, b) => heldSlot(a) - heldSlot(b));
}

function fire(world: World, r: RobotState): void {
  // pick the PHYSICAL held ball to fire; canSort picks the color that fills the
  // next unfilled motif slot on this alliance's ramp, everyone else fires FIFO
  const held = heldBallsOf(world, r.id);
  let fireBall: Artifact | undefined;
  if (r.spec.canSort) {
    const retained = world.balls.filter(
      (b) =>
        b.state.kind === 'rail' &&
        b.state.goal === r.alliance &&
        !b.state.overflow &&
        !b.state.pending,
    ).length;
    const want = world.motif[retained % 3];
    fireBall = held.find((b) => b.color === want) ?? held[0];
  } else {
    fireBall = held[0];
  }
  // keep the color hopper in sync
  const color: ArtifactColor = fireBall ? fireBall.color : r.hopper[0]!;
  const hIdx = r.hopper.indexOf(color);
  if (hIdx >= 0) r.hopper.splice(hIdx, 1);
  r.lastFireAt = world.time;

  const tp = turretWorldPos(r);
  // exact solution, no dispersion — the shooter never misses. The ball
  // leaves along the turret's CURRENT heading (aim assist keeps it on the
  // lead-compensated solution).
  const { speed, angle } = aimSolution(r);
  const yaw = r.turretHeading;
  const cos = dcos(angle);

  // flywheel recovery: an energetic shot drains the wheel; a LOW-inertia
  // flywheel needs extra time to spin back up before the next shot. Close
  // shots (below FLYWHEEL_CLOSE_SPEED) recover within the transfer cadence.
  const shotNorm = Math.max(
    0,
    Math.min(1, (speed - C.FLYWHEEL_CLOSE_SPEED) / (C.LAUNCH_MAX_SPEED - C.FLYWHEEL_CLOSE_SPEED)),
  );
  // CLOSE floor: even a close shot leaves a near-zero-inertia wheel needing a brief
  // respin — fades out by FLYWHEEL_CLOSE_INERTIA_KNEE, so close-zone cyclers want a
  // little inertia (~0.1–0.2) rather than 0. Distance recovery is the shotNorm² term.
  const closeRecovery =
    C.FLYWHEEL_CLOSE_RECOVERY *
    Math.max(0, 1 - r.spec.flywheelInertia / C.FLYWHEEL_CLOSE_INERTIA_KNEE);
  const recovery =
    closeRecovery + C.FLYWHEEL_RECOVERY_MAX * shotNorm * shotNorm * (1 - r.spec.flywheelInertia);
  const sortPenalty = r.spec.canSort ? C.SORT_FIRE_PENALTY : 0;
  const ip = C.INTAKE_PRESETS[r.spec.intake];
  // triangle transfer isn't generally slower — it's the same cadence with a MAX-RATE
  // cap (fireCap): it can't fire faster than the cap, but a slower shot (recovery >
  // cap) fires at the same rate as everyone else.
  const interval = Math.max(ip.fireInterval + recovery + sortPenalty, ip.fireCap);
  r.fireReadyAt = world.time + interval;

  const vel = {
    x: dcos(yaw) * speed * cos + r.vel.x * C.SHOT_ROBOT_VEL_INHERIT,
    y: dsin(yaw) * speed * cos + r.vel.y * C.SHOT_ROBOT_VEL_INHERIT,
  };
  if (fireBall) {
    // reuse the held ball as the shot (physical ball leaves the intake)
    fireBall.state = { kind: 'flight', target: r.alliance };
    fireBall.pos = { x: tp.x, y: tp.y };
    fireBall.vel = vel;
    fireBall.z = C.LAUNCH_HEIGHT;
    fireBall.vz = speed * dsin(angle);
  } else {
    // fallback: no physical held ball (shouldn't happen once preloads are held)
    world.balls.push({
      id: world.balls.reduce((m, b) => Math.max(m, b.id), 0) + 1,
      color,
      state: { kind: 'flight', target: r.alliance },
      pos: { x: tp.x, y: tp.y },
      vel,
      z: C.LAUNCH_HEIGHT,
      vz: speed * dsin(angle),
    });
  }
  // re-slot the remaining held balls so slot stays == hopper index
  heldBallsOf(world, r.id).forEach((b, i) => {
    if (b.state.kind === 'held') b.state.slot = i;
  });
}

/** Capture ground balls into the hopper via a PHYSICAL mouth model.
 * WEDGE presets (sloped/triangle): the running intake SUCKS balls sitting in the
 * mouth toward the throat — the compliant wheels at the chassis front center —
 * and only swallows them once they arrive there. Off-center balls visibly funnel
 * in (the side slopes deflect them in `collideBallRobot`, and this suction pulls
 * them to center) before capture — nothing swallows instantly from the flank or
 * the tip. FLAT presets (vector): the wheels span the whole mouth and grab at the
 * tip; capture TIMING depends on WHERE across the mouth the ball sits (compliant
 * center fast, vectoring sides slow), and the overhang enables the strafe-in flank
 * grab. A clump feeds faster, and the triangle takes two at a time. */
export function updateIntake(world: World, r: RobotState, cmd: RobotCommand): void {
  if (!robotsEnabled(world)) return;
  const running = cmd.intake || r.autoIntake;
  if (!running || r.hopper.length >= C.HOPPER_CAPACITY) return;

  const preset = C.INTAKE_PRESETS[r.spec.intake];
  const m = C.intakeMouth(r.spec); // vector's mouth spans the chassis width
  const hl = r.spec.length / 2;
  const half = r.spec.width / 2;
  const tip = hl + preset.reach; // the roller line (balls pass UNDER it)
  const velRobot = rot(r.vel, -r.heading);
  // ALL intakes capture at the CENTER, directly under the compliant wheels
  // (funnel throat for sloped/triangle; the vectored-to center for vector)
  const captureHalf = m.throatHalf;

  // the intake can't reach INTO the classifier: no vacuuming through the ramp wall
  const capWx = r.pos.x + dcos(r.heading) * (hl + C.BALL_RADIUS);
  const capWy = r.pos.y + dsin(r.heading) * (hl + C.BALL_RADIUS);
  for (const a of ['red', 'blue'] as const) {
    const rect = classifierRect(a);
    if (capWx > rect.x0 - 0.5 && capWx < rect.x1 + 0.5 && capWy > rect.y0 && capWy < rect.y1) {
      return;
    }
  }

  // the compliant wheels grab a ball DIRECTLY UNDER them (in z): the funnel throat
  // is narrow (throatHalf), the vector wheel row spans the whole mouth (mouthHalf).
  // A ball under the wheels is pulled to the throat (hl, 0) — vector VECTORS an
  // off-center ball to center; the funnel just seats a ball the slopes delivered.
  const wheelSpan = m.wedge ? m.throatHalf : m.mouthHalf;

  const candidates: { b: Artifact; y: number }[] = [];
  for (const b of world.balls) {
    if (b.state.kind !== 'ground' || b.z > 6) continue;
    const local = rot({ x: b.pos.x - r.pos.x, y: b.pos.y - r.pos.y }, -r.heading);

    const underWheels =
      local.x > hl - C.BALL_RADIUS &&
      local.x < tip + C.BALL_RADIUS &&
      Math.abs(local.y) < wheelSpan;
    if (underWheels && m.drawIn > 0) {
      const vLocal = rot(b.vel, -r.heading);
      // FLAT (vector) intake, OFF-CENTER ball struck at high CLOSING speed: the
      // non-compliant side wheels can't grip a fast impact — so DON'T vector it.
      // With no suction the ball just bounces off the flat front as an ordinary
      // impact collision (collideBallRobot), scattering it. This is IMPACT-only:
      // `closing` is the ball's approach speed RELATIVE to the robot, so once the
      // ball rides along with the chassis (low closing speed) it vectors in as
      // normal even while the bot keeps pushing at speed. The CENTER compliant
      // wheels always vector; wedge funnels never scatter.
      const closing = velRobot.x - vLocal.x; // >0: ball closing on the front faster than the bot
      const sideImpact =
        !m.wedge &&
        Math.abs(local.y) > captureHalf &&
        velRobot.x > 0 &&
        closing > C.INTAKE_RAM_SPEED;
      if (!sideImpact) {
        const dxT = hl - local.x;
        const dyT = -local.y;
        const dl = hyp(dxT, dyT);
        if (dl > 0.3) {
          vLocal.x = approach(vLocal.x, (dxT / dl) * m.drawIn, m.drawIn);
          vLocal.y = approach(vLocal.y, (dyT / dl) * m.drawIn, m.drawIn);
          b.vel = rot(vLocal, r.heading);
        }
      }
    }
    // capture once the ball reaches the throat, centered under the wheels
    const atThroat =
      local.x > hl - 1 &&
      local.x < hl + C.BALL_RADIUS + C.INTAKE_CAPTURE_BAND &&
      Math.abs(local.y) < captureHalf + C.BALL_RADIUS * 0.25;
    /**
     * ...OR IT IS AGAINST THE FIELD AND THE FUNNEL CANNOT CENTRE IT.
     *
     * A wedge preset (sloped / triangle) only ever swallows at the THROAT, and the suction
     * walks the ball there — which works in open field and cannot work in a CORNER. Putting
     * the throat on a corner artifact means putting the chassis through two walls: an 18in
     * robot at 45 degrees has a 12.7in half-diagonal against the 2.5in the artifact's centre
     * sits off each wall. So the artifact stayed in the mouth, off-centre, and was never
     * taken — "I can't intake a ball in the corner anymore, please fix this for sloped and
     * triangle".
     *
     * A real funnel intake pressed into a corner does collect it: the slopes hold it against
     * the wall and the compliant rollers take it from wherever it is. The artifact cannot run
     * away, which is the whole reason the throat requirement exists. So an artifact under the
     * wheels AND pinned against the field boundary is taken where it lies — at the SLOW end of
     * the timing, since it is entering off-centre.
     */
    const wallClear = C.FIELD_HALF - Math.max(Math.abs(b.pos.x), Math.abs(b.pos.y));
    const cornered =
      m.wedge &&
      wallClear <= C.BALL_RADIUS + C.INTAKE_WALL_GRAB &&
      local.x > hl - 1 &&
      local.x < tip + C.BALL_RADIUS &&
      // the MOUTH, not the throat: a wedge's "wheels" span only throatHalf (3in), and a
      // corner artifact sits 6.5in off centre because the chassis half-width is what stops
      // the robot getting any closer to the wall. Inside the mouth is inside the funnel.
      Math.abs(local.y) < m.mouthHalf + C.BALL_RADIUS * 0.25;
    // flank grab: only where the wheels OVERHANG a narrower chassis (vector)
    const sideTouch =
      m.mouthHalf > half + 0.5 &&
      local.x > hl - 2 &&
      local.x < tip + C.BALL_RADIUS &&
      Math.abs(local.y) > half - 0.5 &&
      Math.abs(local.y) < half + C.BALL_RADIUS + 0.6 &&
      velRobot.y * Math.sign(local.y) > C.INTAKE_SIDE_MIN_STRAFE;
    // a cornered grab reports its true off-centre distance, so the timing lands at capMax
    if (atThroat || sideTouch || cornered) candidates.push({ b, y: Math.abs(local.y) });
  }
  if (candidates.length === 0) return;

  // most-central ball first (deterministic tie-break by id)
  candidates.sort((p, q) => p.y - q.y || p.b.id - q.b.id);

  // timing: center of the capture zone is fast, the edges slow (vector vectoring);
  // a clump of 2+ feeds at the faster clumpInterval
  const t = clamp(candidates[0].y / captureHalf, 0, 1);
  const single = m.capMin + (m.capMax - m.capMin) * t;
  // the clump SPEED bonus is a WEDGE (funnel) trait — the slopes gather a pile and
  // feed it fast. A FLAT vector intake gets NO clump bonus: it can't devour a pile,
  // so a clump feeds at the normal per-ball (vectoring) rate, not faster.
  const interval = candidates.length >= 2 && m.wedge ? m.clumpInterval : single;
  if (world.time - r.lastIntakeAt < interval) return;

  // triangle devours TWO from a clump per cycle (its two front storage slots)
  const room = C.HOPPER_CAPACITY - r.hopper.length;
  const take = m.dual && candidates.length >= 2 && room >= 2 ? 2 : 1;
  for (let i = 0; i < take; i++) {
    const b = candidates[i].b;
    // the ball stays a PHYSICAL world object, now HELD at the next storage slot
    // (the color hopper mirrors it); positionHeldBalls slides it in each tick.
    // Seed lx/ly from where it currently sits so it slides IN from the mouth.
    const loc = rot({ x: b.pos.x - r.pos.x, y: b.pos.y - r.pos.y }, -r.heading);
    const slot = r.hopper.length;
    // triangle FRONT row (slot ≥ 1): the ball takes the side it entered from; any
    // resident front ball on that side slides to the other side to make room
    let side = 0;
    if (r.spec.intake === 'triangle' && slot >= 1) {
      side = loc.y >= 0 ? 1 : -1;
      for (const o of world.balls) {
        if (o.state.kind === 'held' && o.state.robot === r.id && o.state.slot >= 1 && o.state.side === side) {
          o.state.side = -side;
        }
      }
    }
    b.state = { kind: 'held', robot: r.id, slot, lx: loc.x, ly: loc.y, side };
    b.vel = { x: 0, y: 0 };
    b.z = 0;
    b.vz = 0;
    r.hopper.push(b.color);
  }
  r.lastIntakeAt = world.time;
}