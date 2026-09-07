/**
 * THROWAWAY probe for the artifact-force slice: the two things `ballRobotFeedback` was
 * carrying by hand — the STALL on a wall-pinned artifact and the DRAG of shoving a clump —
 * plus the one thing a DYNAMIC chassis in the artifact solve can newly do, which is be
 * turned by what it is pushing.
 *
 * Run before and after, and diff.
 */
import { createWorld, DEFAULT_SPEC, DEFAULT_ASSISTS } from '../src/sim/spawn';
import { step } from '../src/sim/world';
import { initPhysics } from '../src/sim/physicsEngine';
import { SIM_DT, FIELD_HALF, BALL_RADIUS } from '../src/config';
import type { IntakeStyle, RobotCommand, RobotSpec, World } from '../src/types';

await initPhysics();

const cmd = (p: Partial<RobotCommand>): RobotCommand => ({
  driveX: 0, driveY: 0, rotate: 0, intake: false, fire: false, ...p,
});
const setup = (id: number, alliance: 'red' | 'blue', spec: Partial<RobotSpec> = {}, startIndex = 0) => ({
  id, alliance, spec: { ...DEFAULT_SPEC, ...spec }, assists: { ...DEFAULT_ASSISTS }, startIndex,
});
const n = (v: number, w = 7, d = 2) => v.toFixed(d).padStart(w);
const deg = (r: number) => (r * 180) / Math.PI;
/** how far the heading is off the commanded one, in degrees */
const off = (h: number, want: number) => deg(Math.abs(((h - want + Math.PI) % (2 * Math.PI)) - Math.PI));

const mk = (intake: IntakeStyle = 'sloped'): World =>
  createWorld('free', 21, [setup(0, 'blue', { intake })] as never);

/** the artifacts that are not preloaded in the hopper, parked out of the way in a corner */
function loosePark(w: World): typeof w.balls {
  const loose = w.balls.filter((b) => b.state.kind !== 'held');
  for (const b of loose) {
    b.state = { kind: 'ground' };
    b.z = 0;
    b.vz = 0;
    b.vel = { x: 0, y: 0 };
    b.pos = { x: -FIELD_HALF + 8, y: -FIELD_HALF + 8 };
  }
  return loose;
}

// ============================================================ 1. THE WALL PIN ============
/**
 * Smoke's scene 21, verbatim: a robot facing the far wall grinds into one artifact resting
 * against it. The artifact cannot go anywhere, so the robot must not either. Smoke's bound
 * is `robot v < 5` and `|artifact x| < 6`.
 */
console.log('=== 1. WALL-PINNED ARTIFACT (grind straight in, 2.5s) ===');
console.log(`intake     |  robot v | chassis front y | headingOff | artifact pos      | artifact v   (wall face y=${(FIELD_HALF - BALL_RADIUS).toFixed(1)})`);
for (const intake of ['sloped', 'vector', 'triangle'] as IntakeStyle[]) {
  const w = mk(intake);
  const r = w.robots[0];
  r.pos = { x: 0, y: 45 };
  r.heading = Math.PI / 2;
  r.fieldCentric = false;
  const ball = w.balls[0];
  ball.state = { kind: 'ground' };
  ball.pos = { x: 0, y: FIELD_HALF - BALL_RADIUS };
  ball.vel = { x: 0, y: 0 };
  ball.z = 0;
  ball.vz = 0;
  for (let i = 0; i < Math.round(2.5 / SIM_DT); i++) step(w, SIM_DT, new Map([[0, cmd({ driveY: 1 })]]));
  console.log(
    `${intake.padEnd(10)} | ${n(Math.hypot(r.vel.x, r.vel.y), 8)} | ${n(r.pos.y + r.spec.length / 2, 15)} | ` +
      `${n(off(r.heading, Math.PI / 2), 10)} | (${n(ball.pos.x, 6)},${n(ball.pos.y, 6)}) | ` +
      `${n(Math.hypot(ball.vel.x, ball.vel.y), 8)}`,
  );
}

// ============================================================ 2. CLUMP DRAG ==============
/**
 * How much a robot is SLOWED by shoving artifacts across open floor — the whole job of
 * `BALL_PUSH_DRAG`. Hopper FULL so nothing is swallowed and this is pure collision, and the
 * run is short enough (1.1s from y = -62) that nothing reaches the far wall.
 *
 * `mean` is over the whole run and `settled` over the last third, where the drive force and
 * the drag have balanced — settled is the number that says how heavy the clump FEELS.
 */
console.log('');
console.log('=== 2. CLUMP DRAG (hopper full, push N artifacts across open floor, 1.1s from y=-62) ===');
console.log('  N | mean v | settled v | robot dy | slowed (mean) | slowed (settled)');
const clumpRun = (count: number) => {
  const w = mk('sloped');
  const r = w.robots[0];
  r.pos = { x: 0, y: -62 };
  r.heading = Math.PI / 2;
  r.fieldCentric = false;
  r.hopper = ['green', 'green', 'green']; // full: collision only, no capture
  const loose = loosePark(w);
  const park = (b: (typeof loose)[number]) => {
    b.pos = { x: -FIELD_HALF + 8, y: -FIELD_HALF + 8 };
    b.vel = { x: 0, y: 0 };
  };
  // a block of `count` artifacts, 3 across, directly ahead of the robot
  for (let i = 0; i < count; i++) {
    loose[i].pos = { x: -5 + (i % 3) * 5, y: -62 + r.spec.length / 2 + 3 + Math.floor(i / 3) * 5.2 };
  }
  const y0 = r.pos.y;
  const ticks = Math.round(1.1 / SIM_DT);
  let sum = 0;
  let tail = 0;
  let tailN = 0;
  for (let i = 0; i < ticks; i++) {
    step(w, SIM_DT, new Map([[0, cmd({ driveY: 1 })]]));
    for (let k = count; k < loose.length; k++) if (loose[k].state.kind === 'ground') park(loose[k]);
    const v = Math.hypot(r.vel.x, r.vel.y);
    sum += v;
    if (i >= Math.round(ticks * (2 / 3))) {
      tail += v;
      tailN++;
    }
  }
  return { mean: sum / ticks, settled: tail / tailN, dy: r.pos.y - y0 };
};
const free = clumpRun(0);
for (const count of [0, 1, 3, 6, 9]) {
  const x = clumpRun(count);
  console.log(
    `${String(count).padStart(3)} | ${n(x.mean, 6)} | ${n(x.settled, 9)} | ${n(x.dy, 8)} | ` +
      `${n(100 * (1 - x.mean / free.mean), 12)}% | ${n(100 * (1 - x.settled / free.settled), 15)}%`,
  );
}

// ============================================================ 3. YAW FROM ARTIFACTS ======
/**
 * A DYNAMIC chassis in the artifact solve can be turned by what it is pushing, which a
 * kinematic one could not — so this is the number that says whether the tyres have to be
 * allowed to refuse it (the `yawHold` question). Drive dead straight into a clump sitting
 * to one side and read how far off the commanded heading the robot ends up.
 */
console.log('');
console.log('=== 3. YAW FROM AN OFF-CENTRE CLUMP (1.1s straight from y=-62, 6 artifacts to one side) ===');
console.log('offset |  headingOff | peak |w| | lateral drift');
for (const offset of [0, 4, 8, 12]) {
  const w = mk('sloped');
  const r = w.robots[0];
  r.pos = { x: 0, y: -62 };
  r.heading = Math.PI / 2;
  r.fieldCentric = false;
  r.hopper = ['green', 'green', 'green'];
  const loose = loosePark(w);
  for (let i = 0; i < 6; i++) {
    loose[i].pos = { x: offset + (i % 2) * 5, y: -62 + r.spec.length / 2 + 3 + Math.floor(i / 2) * 5.2 };
  }
  let peak = 0;
  for (let i = 0; i < Math.round(1.1 / SIM_DT); i++) {
    step(w, SIM_DT, new Map([[0, cmd({ driveY: 1 })]]));
    for (let k = 6; k < loose.length; k++) {
      if (loose[k].state.kind === 'ground') {
        loose[k].pos = { x: -FIELD_HALF + 8, y: -FIELD_HALF + 8 };
        loose[k].vel = { x: 0, y: 0 };
      }
    }
    peak = Math.max(peak, Math.abs(r.angVel));
  }
  console.log(
    `${String(offset).padStart(4)}in | ${n(off(r.heading, Math.PI / 2), 11)} | ${n(peak, 8, 3)} | ${n(r.pos.x, 13)}`,
  );
}
