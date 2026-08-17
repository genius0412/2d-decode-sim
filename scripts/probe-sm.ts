import { createWorld, DEFAULT_ASSISTS, DEFAULT_SPEC } from '../src/sim/spawn';
import { step } from '../src/sim/world';
import { startMatch } from '../src/sim/match';
import { initPhysics } from '../src/sim/physicsEngine';
import { railPos } from '../src/sim/field';
import { SIM_DT, GATE_STOP_S, RAIL_PITCH, RAMP_SURFACE_Z, FIELD_HALF, RAIL_TERMINAL } from '../src/config';
import type { RobotCommand } from '../src/types';
await initPhysics();
const cmd = (p: Partial<RobotCommand>): RobotCommand => ({ driveX: 0, driveY: 0, rotate: 0, intake: false, fire: false, ...p });
const w = createWorld('match', 42, [{ id: 0, alliance: 'red', spec: { ...DEFAULT_SPEC, intake: 'vector', width: 17.5, length: 14.5 }, assists: { ...DEFAULT_ASSISTS }, startIndex: 0 }]);
startMatch(w); w.match.phase = 'teleop'; const r = w.robots[0];
for (const b of w.balls) if (b.state.kind === 'held') { b.state = { kind: 'ground' }; b.pos = { x: -FIELD_HALF+6, y: -FIELD_HALF+6 }; b.vel={x:0,y:0}; b.z=0; b.vz=0; }
r.hopper = []; r.pos = { x: 0, y: -40 };
for (const b of w.balls) if (b.state.kind === 'ground') b.pos = { x: -FIELD_HALF+6, y: -FIELD_HALF+6 };
for (let i = 0; i < 9; i++) { const b = w.balls[i]; const s = GATE_STOP_S + i * RAIL_PITCH;
  b.state = { kind: 'rail', goal: 'red', s, v: 0, overflow: false, pending: false };
  b.pos = railPos('red', s); b.vel={x:0,y:0}; b.z=RAMP_SURFACE_Z; b.vz=0; }
const left = () => w.balls.filter((b) => b.state.kind === 'rail' && b.state.goal === 'red').length;
let prev = left(); const t: number[] = [];
for (let i = 0; i < Math.round(20 / SIM_DT); i++) {
  w.goals.red.gatePos = 1; w.goals.red.gateOpen = true; w.goals.red.gateLatch = 1;
  step(w, SIM_DT, new Map([[0, cmd({})]]));
  const n = left(); if (n < prev) { for (let j = 0; j < prev-n; j++) t.push(i*SIM_DT); prev = n; }
}
const g = t.slice(1).map((x,i)=>x-t[i]);
const m = g.length?g.reduce((a,b)=>a+b,0)/g.length:0;
const mad = g.length?g.reduce((a,b)=>a+Math.abs(b-m),0)/g.length:0;
console.log(`TERMINAL ${RAIL_TERMINAL}: first release ${t[0].toFixed(2)}s, all out by ${t[t.length-1].toFixed(2)}s, mean ${m.toFixed(3)}s mad ${mad.toFixed(3)} | gaps ${g.map((x)=>x.toFixed(2)).join(' ')}`);
