import { createWorld, DEFAULT_ASSISTS, DEFAULT_SPEC } from '../src/sim/spawn';
import { step } from '../src/sim/world';
import { startMatch } from '../src/sim/match';
import { initPhysics } from '../src/sim/physicsEngine';
import { gateZone, railPos } from '../src/sim/field';
import { SIM_DT, GATE_STOP_S, RAIL_PITCH, RAMP_SURFACE_Z, GATE_PASS_FRAC, GATE_SHOULDER_LIFT } from '../src/config';
import type { RobotCommand } from '../src/types';
await initPhysics();
const cmd = (p: Partial<RobotCommand>): RobotCommand => ({ driveX: 0, driveY: 0, rotate: 0, intake: false, fire: false, ...p });
function tap(spread: number, tapS: number, standoff: number) {
  const w = createWorld('match', 42, [{ id: 0, alliance: 'blue', spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS }, startIndex: 0 }]);
  startMatch(w);
  for (const b of w.balls) if (b.state.kind === 'ground') b.pos = { x: 900, y: 900 };
  for (let i = 0; i < 9; i++) { const b = w.balls[i]; const s = GATE_STOP_S + i * (RAIL_PITCH + spread);
    b.state = { kind: 'rail', goal: 'blue', s, v: 0, overflow: false, pending: false };
    b.pos = railPos('blue', s); b.vel={x:0,y:0}; b.z=RAMP_SURFACE_Z; b.vz=0; }
  const r = w.robots[0]; const z = gateZone('blue');
  r.pos = { x: z.x1 + standoff, y: (z.y0+z.y1)/2 }; r.heading = Math.PI; r.fieldCentric = false; r.vel={x:0,y:0};
  let drove = false;
  for (let i = 0; i < Math.round(14 / SIM_DT); i++) {
    const t = i * SIM_DT; let c = cmd({});
    if (t < tapS) c = cmd({ driveY: 1 }); else if (!drove) { r.pos = { x: 0, y: -30 }; drove = true; }
    step(w, SIM_DT, new Map([[0, c]]));
  }
  return 9 - w.balls.filter((b) => b.state.kind === 'rail' && b.state.goal === 'blue').length;
}
const res: number[] = [];
for (const sp of [0,1,2,3,5]) for (const ts of [0.15,0.3,0.5]) for (const so of [4,7,11]) res.push(tap(sp, ts, so));
console.log(`SHOULDER ${GATE_SHOULDER_LIFT} (${(GATE_PASS_FRAC/GATE_SHOULDER_LIFT).toFixed(0)} in/s) -> min ${Math.min(...res)} max ${Math.max(...res)} distinct ${[...new Set(res)].sort((a,b)=>a-b).join(',')}`);
