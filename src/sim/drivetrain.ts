import type { DrivetrainType, IntakeStyle, RobotSpec } from '../types';
import * as C from '../config';
import { clamp, approach, hyp } from '../math';

/** derived per-robot drive parameters. Everything the drivetrain influences
 * comes from the spec: type multipliers × RPM (speed up / accel down) × mass
 * (accel down, shove up — shove lives in the collision code). The BASE calibration
 * (SPEED_PER_RPM / BASE_DRIVE_ACCEL) is 75 in/s, 7 rad/s, 280 in/s² at mult=1; each
 * drivetrain rides above/below it (e.g. mecanum ×1.02 speed / ×1.06 accel). */
export interface DriveParams {
  maxSpeed: number; // in/s forward
  strafeMult: number;
  maxTurn: number; // rad/s
  accel: number; // in/s^2
  turnAccel: number; // rad/s^2
  saturation: 'sum' | 'tank' | 'vec';
}

const REF_SPEED = C.SPEED_PER_RPM * C.REF_DRIVE_RPM; // 75
const REF_TURN = 8.5; // rad/s of the reference (DEFAULT 15×18) chassis
// anchored to the DEFAULT chassis (15 long incl. intake budget × 18 wide) so the
// default robot still turns at 8.5 rad/s; smaller footprints turn quicker
const REF_HALF_DIAG = Math.sqrt(15 * 15 + 18 * 18) / 2;

/**
 * The multipliers + wheel RPM actually in force for a robot right now.
 *
 * Every drivetrain but BUTTERFLY has exactly one answer. A butterfly carries two wheel
 * sets with their own gearing and their own handling, so the ACTIVE half is chosen by
 * `tankMode` (the runtime `RobotState.butterflyTank`) — that one flag swaps the
 * multipliers, the saturation model (holonomic ⇄ tank side-drive), AND which of the two
 * rpm sliders applies. Split out so the sim, the builder preview, and the balance table
 * all resolve a butterfly identically.
 */
export function activeDrive(
  spec: RobotSpec,
  tankMode = false,
): { p: (typeof C.DRIVETRAIN_PRESETS)[DrivetrainType]; rpm: number } {
  if (spec.drivetrain === 'butterfly') {
    const half = tankMode ? C.BUTTERFLY_MODES.tank : C.BUTTERFLY_MODES.mecanum;
    const rpm = tankMode ? butterflyTankRpm(spec) : spec.driveRpm;
    return { p: half as (typeof C.DRIVETRAIN_PRESETS)[DrivetrainType], rpm };
  }
  return { p: C.DRIVETRAIN_PRESETS[spec.drivetrain], rpm: spec.driveRpm };
}

/** a butterfly's TANK-set rpm, clamped to the traction envelope. Defaults to the
 * mecanum slider's value (clamped) when a spec predates the second slider. */
export function butterflyTankRpm(spec: RobotSpec): number {
  const L = C.BUTTERFLY_TANK_RPM;
  const raw = typeof spec.tankRpm === 'number' && Number.isFinite(spec.tankRpm) ? spec.tankRpm : spec.driveRpm;
  return clamp(raw, L.min, L.max);
}

export function driveParams(spec: RobotSpec, tankMode = false): DriveParams {
  const { p, rpm } = activeDrive(spec, tankMode);
  const maxSpeed = C.SPEED_PER_RPM * rpm * p.speedMult;
  const accel =
    C.BASE_DRIVE_ACCEL *
    (C.REF_DRIVE_RPM / rpm) *
    (C.REF_MASS_LB / spec.massLb) *
    p.accelMult;
  // rotation tops out at wheel speed / half track diagonal, like a real
  // chassis: faster wheels or a smaller footprint turn quicker
  const halfDiag = Math.sqrt(spec.length * spec.length + spec.width * spec.width) / 2;
  const maxTurn = Math.min(
    REF_TURN * (maxSpeed / REF_SPEED) * (REF_HALF_DIAG / halfDiag) * p.turnMult,
    C.TURN_MAX_SPEED,
  );
  return {
    maxSpeed,
    strafeMult: p.strafeMult,
    maxTurn,
    accel,
    turnAccel: accel * C.TURN_ACCEL_PER_ACCEL,
    saturation: p.saturation,
  };
}

/** advance a velocity toward `target` for one tick using a DC-motor torque–speed
 * curve: available (stall) accel falls ~linearly from full at rest to
 * MOTOR_MIN_TORQUE_FRAC near the free speed `vFree`, so speed approaches the top
 * asymptotically instead of a constant ramp. Braking (target opposes v) pulls
 * harder (MOTOR_BRAKE_MULT). `MOTOR_TORQUE_CURVE` 0 ⇒ the old constant accel.
 * Deterministic (pure arithmetic); shared by fwd / strafe / turn. */
export function motorStep(v: number, target: number, aStall: number, vFree: number, dt: number): number {
  const err = target - v;
  if (err === 0) return v;
  const braking = v !== 0 && Math.sign(err) !== Math.sign(v);
  let frac: number;
  if (braking) {
    frac = C.MOTOR_BRAKE_MULT;
  } else {
    const s = vFree > 0 ? Math.min(Math.abs(v) / vFree, 1) : 0;
    frac = Math.max(1 - C.MOTOR_TORQUE_CURVE * s, C.MOTOR_MIN_TORQUE_FRAC);
  }
  return approach(v, target, aStall * frac * dt);
}

/**
 * 2D (translation) version of `motorStep`: advance the velocity VECTOR (vx, vy) toward
 * (tx, ty) with the accel budget limited in VECTOR MAGNITUDE, not per-axis. Stepping fwd
 * and strafe independently (two `motorStep` calls) lets the velocity vector grow at √2·accel
 * on a diagonal — the classic "diagonal is faster" bug (real speed cap is fine, but the
 * ACCELERATION phase covers more ground diagonally). Capping the isotropic change per tick
 * fixes it: diagonal accelerates at the same rate as straight. Torque-curve falloff uses the
 * combined SPEED; braking (the pull opposes current motion) pulls harder. Deterministic. */
export function motorStepVec(
  vx: number,
  vy: number,
  tx: number,
  ty: number,
  aStall: number,
  vFree: number,
  dt: number,
): { x: number; y: number } {
  const ex = tx - vx;
  const ey = ty - vy;
  const eMag = hyp(ex, ey);
  if (eMag === 0) return { x: vx, y: vy };
  const speed = hyp(vx, vy);
  const braking = ex * vx + ey * vy < 0; // the demanded change opposes current motion
  let frac: number;
  if (braking) {
    frac = C.MOTOR_BRAKE_MULT;
  } else {
    const s = vFree > 0 ? Math.min(speed / vFree, 1) : 0;
    frac = Math.max(1 - C.MOTOR_TORQUE_CURVE * s, C.MOTOR_MIN_TORQUE_FRAC);
  }
  const budget = aStall * frac * dt;
  if (eMag <= budget) return { x: tx, y: ty };
  return { x: vx + (ex / eMag) * budget, y: vy + (ey / eMag) * budget };
}

/** dev/tuning table: the resulting free speed / strafe / stall accel / push for
 * each drivetrain at the reference RPM+mass. Printed by the smoke suite so a
 * balance edit's effect is visible at a glance. */
export function driveSummary(): { dt: string; fwd: number; strafe: number; accel: number; push: number }[] {
  const row = (dt: string, p: { speedMult: number; strafeMult: number; accelMult: number; pushMult: number }) => {
    const fwd = C.SPEED_PER_RPM * C.REF_DRIVE_RPM * p.speedMult;
    return { dt, fwd, strafe: fwd * p.strafeMult, accel: C.BASE_DRIVE_ACCEL * p.accelMult, push: p.pushMult };
  };
  const out = (Object.keys(C.DRIVETRAIN_PRESETS) as DrivetrainType[])
    // butterfly is listed as its two HALVES instead — a single row would imply one
    // set of numbers, which is exactly the thing this drivetrain doesn't have
    .filter((dt) => dt !== 'butterfly')
    .map((dt) => row(dt, C.DRIVETRAIN_PRESETS[dt]));
  out.push(row('butterfly·mec', C.BUTTERFLY_MODES.mecanum), row('butterfly·tank', C.BUTTERFLY_MODES.tank));
  return out;
}

/** the wheel-RPM range this drivetrain allows (torque-biased drivetrains cap
 * lower). Consumed by the builder sliders + settings validation. */
// ---- the loadout limit functions (SINGLE SOURCE shared by coerceSpec + the UI
// sliders). Each range is derived ONLY from the field(s) it depends on, so the
// builder's dependency order is explicit: intake → length/width, drivetrain →
// rpm, inertia → 0..1, then drivetrain×inertia → mass. ------------------------

/** chassis LENGTH range (in) — determined by the intake preset (its reach counts
 * toward the 18" cube, so each preset bakes in maxLength = 18 − reach). */
export function lengthLimits(intake: IntakeStyle): { min: number; max: number } {
  const p = C.INTAKE_PRESETS[intake];
  return { min: p.minLength, max: p.maxLength };
}

/** chassis WIDTH range (in). The ceiling is the 18" cube for every intake. The
 * FLOOR is the widest of two constraints: (1) the DRIVETRAIN floor — swerve needs
 * a wider base (corner steering modules) → SWERVE_MIN_WIDTH, others ROBOT_MIN_WIDTH;
 * and (2) the INTAKE floor — the funnel presets (sloped/triangle) need a wider frame
 * to house their side slopes (per-preset `minWidth`). This is the one place width
 * policy lives. */
export function widthLimits(
  intake: IntakeStyle,
  drivetrain: DrivetrainType,
): { min: number; max: number } {
  const dtFloor = drivetrain === 'swerve' ? C.SWERVE_MIN_WIDTH : C.ROBOT_MIN_WIDTH;
  const min = Math.max(dtFloor, C.INTAKE_PRESETS[intake].minWidth);
  return { min, max: C.ROBOT_MAX_SIZE };
}

export function rpmLimits(dt: DrivetrainType): { min: number; max: number } {
  const L = C.DRIVETRAIN_LIMITS[dt];
  return { min: L.minRpm, max: L.maxRpm };
}

/** BUTTERFLY's SECOND rpm range — the traction set. `rpmLimits` covers its mecanum
 * set; this is the torque-biased envelope the tank half runs in. Same single-source
 * contract: the builder's second slider and `coerceSpec` both read it. */
export function butterflyTankRpmLimits(): { min: number; max: number } {
  return { min: C.BUTTERFLY_TANK_RPM.min, max: C.BUTTERFLY_TANK_RPM.max };
}

/** the mass range this drivetrain allows, with the floor RAISED by flywheel
 * inertia (a bigger flywheel weighs more). At inertia 1 the floor climbs by
 * INERTIA_MASS_FLOOR, clamped to the drivetrain's max. */
export function massLimits(
  dt: DrivetrainType,
  flywheelInertia: number,
): { min: number; max: number } {
  const L = C.DRIVETRAIN_LIMITS[dt];
  const min = clamp(L.minMass + C.INERTIA_MASS_FLOOR * flywheelInertia, L.minMass, L.maxMass);
  return { min, max: L.maxMass };
}
