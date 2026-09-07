/**
 * ACCEPTANCE TABLE for the force-model slice (netcodeplan "A").
 *
 * The rule for this slice is that NOTHING here may move: the drive feel, the push ordering
 * and the contact outcomes are the contract, and only the way the drive reaches Rapier
 * changes. Run it on the old model, keep the output, run it on the new one, diff.
 *
 * Throwaway once A lands (or promote the interesting rows into smoke).
 */
import { createWorld, DEFAULT_SPEC, DEFAULT_ASSISTS } from '../src/sim/spawn';
import { step } from '../src/sim/world';
import { initPhysics } from '../src/sim/physicsEngine';
import { SIM_DT } from '../src/config';
import { driveParams, pushForce, shoveMass } from '../src/sim/drivetrain';
import type { DrivetrainType, RobotCommand, RobotSpec, World } from '../src/types';

await initPhysics();

const DTS: DrivetrainType[] = ['tank', 'mecanum', 'swerve', 'xdrive', 'butterfly'];

const cmd = (p: Partial<RobotCommand>): RobotCommand => ({
  driveX: 0, driveY: 0, rotate: 0, intake: false, fire: false, ...p,
});
const setup = (id: number, alliance: 'red' | 'blue', spec: Partial<RobotSpec>, startIndex = 0) => ({
  id, alliance, spec: { ...DEFAULT_SPEC, ...spec }, assists: { ...DEFAULT_ASSISTS }, startIndex,
});
/** TRULY remove every artifact: the 'held by robot 99' trick leaves 32 of them on the
 *  ground within a tick (nothing owns them, so they are dropped), and `pair()` parks its
 *  robots at x=-64,y=0 — which is the red gate outflow. Measured: an artifact within 8.0in
 *  of a robot centre on 144 of 240 ticks. Sections 3 and 5 were reading artifact contacts. */
const stripBalls = (w: World) => {
  w.balls.length = 0;
  for (const a of ['red', 'blue'] as const) w.humanPlayers[a].box.length = 0;
};
const fwd = (v: number) => cmd({ driveY: v, leftDrive: v, rightDrive: v } as Partial<RobotCommand>);
const spin = (v: number) => cmd({ rotate: v, leftDrive: -v, rightDrive: v } as Partial<RobotCommand>);
const deg = (r: number) => (r * 180) / Math.PI;
/** tilt of a SQUARE chassis, mod 90 degrees */
const offFlush = (h: number) => {
  const q = Math.PI / 2;
  const rel = h - Math.round(h / q) * q;
  return Math.abs(deg(rel));
};
const n = (v: number, w = 6, d = 2) => v.toFixed(d).padStart(w);

/** one robot alone in the middle of the field, robot-centric, nothing else running */
function solo(dt: DrivetrainType, spec: Partial<RobotSpec> = {}) {
  const w = createWorld('free', 7, [setup(0, 'blue', { drivetrain: dt, ...spec }, 0)] as never);
  stripBalls(w);
  const r = w.robots[0];
  r.pos = { x: 0, y: -40 };
  r.heading = Math.PI / 2; // drive up the long axis, away from the walls
  r.vel = { x: 0, y: 0 };
  r.angVel = 0;
  r.fieldCentric = false;
  r.passive = false;
  return { w, r };
}

/** A behind B, both facing +x, one chassis apart. Far enough back to never reach the wall. */
function pair(aDt: DrivetrainType, bDt: DrivetrainType, gap = 0.5) {
  const w = createWorld('free', 7, [
    setup(0, 'blue', { drivetrain: aDt }, 0),
    setup(1, 'red', { drivetrain: bDt }, 1),
  ] as never);
  stripBalls(w);
  const [a, b] = w.robots;
  for (const x of w.robots) {
    x.heading = 0; x.vel = { x: 0, y: 0 }; x.angVel = 0; x.fieldCentric = false;
  }
  a.pos = { x: -64, y: 0 };
  b.pos = { x: -64 + a.spec.length / 2 + b.spec.length / 2 + gap, y: 0 };
  return { w, a, b };
}

// ---------------------------------------------------------------- 1. drive feel
console.log('=== 1. DRIVE FEEL (solo, full stick, 5s) — the balance contract ===');
console.log('drivetrain  |  top   t95   peakA |  turn  t95   peakT | stop  | model: speed accel  push');
for (const dt of DTS) {
  const { w, r } = solo(dt);
  const cmds = new Map([[0, fwd(1)]]);
  let peakA = 0;
  let prev = 0;
  const speeds: number[] = [];
  for (let i = 0; i < 300; i++) {
    step(w, SIM_DT, cmds);
    // PINNED at the origin, velocity untouched: this is a FEEL measurement and a robot that
    // reaches the far wall inside the window measures the wall instead (every row read 0.00).
    r.pos = { x: 0, y: 0 };
    const s = Math.hypot(r.vel.x, r.vel.y);
    peakA = Math.max(peakA, (s - prev) / SIM_DT);
    prev = s;
    speeds.push(s);
  }
  const top = speeds[speeds.length - 1];
  const t95 = speeds.findIndex((s) => s >= 0.95 * top) * SIM_DT;

  // …and how long it takes to STOP from there (stick released)
  const zero = new Map([[0, cmd({})]]);
  let stop = 0;
  for (let i = 0; i < 300; i++) {
    step(w, SIM_DT, zero);
    r.pos = { x: 0, y: 0 };
    if (Math.hypot(r.vel.x, r.vel.y) < 1) { stop = i * SIM_DT; break; }
  }

  const { w: w2, r: r2 } = solo(dt);
  const sc = new Map([[0, spin(1)]]);
  let peakT = 0;
  let pw = 0;
  const turns: number[] = [];
  for (let i = 0; i < 240; i++) {
    step(w2, SIM_DT, sc);
    r2.pos = { x: 0, y: 0 };
    peakT = Math.max(peakT, (Math.abs(r2.angVel) - pw) / SIM_DT);
    pw = Math.abs(r2.angVel);
    turns.push(Math.abs(r2.angVel));
  }
  const turn = turns[turns.length - 1];
  const tt95 = turns.findIndex((s) => s >= 0.95 * turn) * SIM_DT;

  const dp = driveParams(r.spec, false);
  console.log(
    `${dt.padEnd(11)} | ${n(top)} ${n(t95, 5)} ${n(peakA, 6, 0)} | ${n(turn, 5)} ${n(tt95, 5)} ${n(peakT, 5, 1)} |` +
    ` ${n(stop, 5)} | ${n(dp.maxSpeed)} ${n(dp.accel, 6, 0)} ${n(pushForce(r.spec), 6, 0)}`,
  );
}

// ------------------------------------------------------- 2. straight-line honesty
console.log('\n=== 2. DOES IT DRIVE STRAIGHT (3s full forward, robot-centric) ===');
console.log('drivetrain  | lateral drift | heading drift');
for (const dt of DTS) {
  const { w, r } = solo(dt);
  r.pos = { x: 0, y: -60 };
  const cmds = new Map([[0, fwd(1)]]);
  const x0 = r.pos.x;
  for (let i = 0; i < 90; i++) step(w, SIM_DT, cmds);
  console.log(`${dt.padEnd(11)} | ${n(r.pos.x - x0, 13)} | ${n(deg(r.heading) - 90, 13, 1)}°`);
}

// ------------------------------------------------------------- 3. pushing contest
console.log('\n=== 3. PUSHING AN IDLE ROBOT (3s full throttle) — B moved / mean pusher speed ===');
console.log('pusher   victim   |  moved   speed | force ratio');
for (const aDt of DTS) {
  for (const bDt of ['tank', 'mecanum'] as DrivetrainType[]) {
    const { w, a, b } = pair(aDt, bDt);
    const cmds = new Map([[0, fwd(1)], [1, cmd({})]]);
    for (let i = 0; i < 30; i++) step(w, SIM_DT, cmds);
    const b0 = b.pos.x;
    let sum = 0;
    for (let i = 0; i < 180; i++) { step(w, SIM_DT, cmds); sum += Math.hypot(a.vel.x, a.vel.y); }
    console.log(
      `${aDt.padEnd(8)} ${bDt.padEnd(8)} | ${n(b.pos.x - b0)} ${n(sum / 180)} |` +
      ` ${n(pushForce(a.spec) / pushForce(b.spec), 6, 2)}`,
    );
  }
}

console.log('\n=== 4. HEAD-TO-HEAD (both drive in, 3s) — B displacement (0 = stalemate) ===');
for (const [aDt, bDt] of [
  ['tank', 'tank'], ['tank', 'mecanum'], ['tank', 'xdrive'], ['mecanum', 'mecanum'], ['swerve', 'mecanum'],
] as [DrivetrainType, DrivetrainType][]) {
  const { w, a, b } = pair(aDt, bDt);
  const cmds = new Map([[0, fwd(1)], [1, fwd(-1)]]);
  for (let i = 0; i < 30; i++) step(w, SIM_DT, cmds);
  const b0 = b.pos.x;
  for (let i = 0; i < 180; i++) step(w, SIM_DT, cmds);
  console.log(`${aDt.padEnd(8)} vs ${bDt.padEnd(8)} | ${n(b.pos.x - b0)} in | a=${n(a.pos.x, 7)}`);
}

// -------------------------------------------------------------- 5. contact scenes
console.log('\n=== 5. LATERAL DRAG (pusher straight ahead, victim strafes out) ===');
console.log('pusher   | A dy    B dy   track | A heading');
for (const aDt of DTS) {
  const { w, a, b } = pair(aDt, 'mecanum');
  for (let i = 0; i < 60; i++) step(w, SIM_DT, new Map([[0, fwd(0.5)], [1, cmd({})]]));
  const aS = a.pos.y, bS = b.pos.y;
  const cmds = new Map([[0, fwd(0.5)], [1, cmd({ driveX: 1 })]]);
  for (let i = 0; i < 180; i++) step(w, SIM_DT, cmds);
  const ady = a.pos.y - aS, bdy = b.pos.y - bS;
  console.log(
    `${aDt.padEnd(8)} | ${n(ady)} ${n(bdy)} ${n(bdy === 0 ? 0 : (ady / bdy) * 100, 5, 0)}% | ${n(deg(a.heading), 6, 1)}°`,
  );
}

console.log('\n=== 6. OFF-CENTRE RAM (1.5s) — victim heading / peak omega ===');
for (const off of [0, 2, 4, 8, 12]) {
  const w = createWorld('free', 7, [setup(0, 'blue', {}, 0), setup(1, 'red', {}, 1)] as never);
  stripBalls(w);
  const [a, b] = w.robots;
  a.pos = { x: -30, y: off }; a.heading = 0; a.vel = { x: 0, y: 0 }; a.angVel = 0; a.fieldCentric = false;
  b.pos = { x: 0, y: 0 }; b.heading = 0; b.vel = { x: 0, y: 0 }; b.angVel = 0; b.fieldCentric = false;
  const cmds = new Map([[0, fwd(1)], [1, cmd({})]]);
  let peakW = 0;
  for (let i = 0; i < 90; i++) { step(w, SIM_DT, cmds); peakW = Math.max(peakW, Math.abs(b.angVel)); }
  console.log(`offset ${String(off).padStart(2)}in | victim ${n(deg(b.heading), 7, 2)}° peak|w| ${n(peakW, 5)} | aggressor ${n(deg(a.heading), 6, 2)}°`);
}

console.log('\n=== 7. WALL SQUARE-UP (tilted into the far wall, 2s) — residual tilt ===');
for (const tilt of [10, 20, -20, 35]) {
  const { w, r } = solo('mecanum');
  r.pos = { x: 0, y: 60 };
  r.heading = Math.PI / 2 + (tilt * Math.PI) / 180;
  const cmds = new Map([[0, fwd(1)]]);
  for (let i = 0; i < 120; i++) step(w, SIM_DT, cmds);
  console.log(`tilt ${String(tilt).padStart(3)}° | residual ${n(offFlush(r.heading), 6, 3)}°`);
}

console.log('\n=== 8. MODEL CONSTANTS (what the solver is handed) ===');
for (const dt of DTS) {
  const s = { ...DEFAULT_SPEC, drivetrain: dt };
  const dp = driveParams(s, false);
  console.log(
    `${dt.padEnd(11)} | shoveMass ${n(shoveMass(s), 8, 1)} | pushForce ${n(pushForce(s), 8, 0)}` +
    ` | m*accel ${n(shoveMass(s) * dp.accel, 9, 0)} | realMass ${n(s.massLb, 5, 1)}`,
  );
}
