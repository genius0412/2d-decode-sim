/** Can a drained artifact pass THROUGH a robot parked on the outflow? */
import { createWorld, DEFAULT_ASSISTS, DEFAULT_SPEC } from '../src/sim/spawn';
import { step } from '../src/sim/world';
import { startMatch } from '../src/sim/match';
import { initPhysics } from '../src/sim/physicsEngine';
import { railPos } from '../src/sim/field';
import { pointDepthInChassis } from '../src/sim/physics';
import { SIM_DT, GATE_STOP_S, RAIL_PITCH, RAMP_SURFACE_Z, FIELD_HALF, RAIL_EXIT_S } from '../src/config';
import type { RobotCommand } from '../src/types';
await initPhysics();
const cmd = (p: Partial<RobotCommand>): RobotCommand => ({ driveX: 0, driveY: 0, rotate: 0, intake: false, fire: false, ...p });
function run(ry: number, hopper: number) {
  const w = createWorld('match', 42, [{ id: 0, alliance: 'red', spec: { ...DEFAULT_SPEC, intake: 'vector', width: 17.5, length: 14.5 }, assists: { ...DEFAULT_ASSISTS }, startIndex: 0 }]);
  startMatch(w); w.match.phase = 'teleop'; const r = w.robots[0];
  for (const b of w.balls) if (b.state.kind === 'held') { b.state = { kind: 'ground' }; b.pos = { x: -FIELD_HALF+6, y: -FIELD_HALF+6 }; b.vel={x:0,y:0}; b.z=0; b.vz=0; }
  r.hopper = Array.from({ length: hopper }, () => 'green' as const);
  for (const b of w.balls) if (b.state.kind === 'ground') b.pos = { x: -FIELD_HALF+6, y: -FIELD_HALF+6 };
  for (let i = 0; i < 9; i++) { const b = w.balls[i]; const s = GATE_STOP_S + i * RAIL_PITCH;
    b.state = { kind: 'rail', goal: 'red', s, v: 0, overflow: false, pending: false };
    b.pos = railPos('red', s); b.vel={x:0,y:0}; b.z=RAMP_SURFACE_Z; b.vz=0; }
  // park the robot squarely across the outflow, below the exit
  r.pos = { x: railPos('red', RAIL_EXIT_S).x, y: ry }; r.heading = Math.PI/2; r.fieldCentric = false; r.vel={x:0,y:0};
  let worst = 0;
  for (let i = 0; i < Math.round(10 / SIM_DT); i++) {
    w.goals.red.gatePos = 1; w.goals.red.gateOpen = true; w.goals.red.gateLatch = 1;
    step(w, SIM_DT, new Map([[0, cmd({})]]));
    for (const b of w.balls) {
      if (b.state.kind !== 'ground' || b.pos.x < 0) continue;
      worst = Math.max(worst, pointDepthInChassis(r, b.pos)); // >0 = inside the chassis box
    }
  }
  console.log(`robot across the outflow at y=${ry}, hopper ${hopper}: deepest artifact INSIDE the chassis = ${worst.toFixed(2)}in ${worst > 0.6 ? '<< PASSING THROUGH' : 'ok'}`);
}
for (const y of [-8, -10, -12]) for (const h of [0, 3]) run(y, h);
