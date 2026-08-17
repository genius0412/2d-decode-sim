import { createWorld, DEFAULT_ASSISTS, DEFAULT_SPEC } from '../src/sim/spawn';
import { step } from '../src/sim/world';
import { startMatch } from '../src/sim/match';
import { initPhysics } from '../src/sim/physicsEngine';
import { railPos, gateArmRect } from '../src/sim/field';
import { robotIntersectsRect, chassisCorners } from '../src/sim/physics';
import * as C from '../src/config';
import type { RobotCommand } from '../src/types';
await initPhysics();
const cmd = (p: Partial<RobotCommand>): RobotCommand => ({ driveX: 0, driveY: 0, rotate: 0, intake: false, fire: false, ...p });
// chassis-only version of robotIntersectsRect, via SAT on the chassis corners
function chassisTouches(r: any, rect: any) {
  const cs = chassisCorners(r);
  const rc = [{x:rect.x0,y:rect.y0},{x:rect.x1,y:rect.y0},{x:rect.x1,y:rect.y1},{x:rect.x0,y:rect.y1}];
  const axes = [{x:1,y:0},{x:0,y:1},
    {x:cs[1].x-cs[0].x,y:cs[1].y-cs[0].y},{x:cs[3].x-cs[0].x,y:cs[3].y-cs[0].y}];
  for (const ax of axes) {
    const L = Math.hypot(ax.x, ax.y); if (!L) continue; const n = {x:ax.x/L,y:ax.y/L};
    let a0=Infinity,a1=-Infinity,b0=Infinity,b1=-Infinity;
    for (const p of cs) { const d=p.x*n.x+p.y*n.y; a0=Math.min(a0,d); a1=Math.max(a1,d); }
    for (const p of rc) { const d=p.x*n.x+p.y*n.y; b0=Math.min(b0,d); b1=Math.max(b1,d); }
    if (a1 < b0 || b1 < a0) return false;
  }
  return true;
}
for (const y0 of [-12, -10, -8, -6]) {
for (const headDeg of [19, 45, 70]) {
  const w = createWorld('match', 5, [{ id: 0, alliance: 'red', spec: { ...DEFAULT_SPEC, width: 17.5, length: 14.5, intake: 'vector' }, assists: { ...DEFAULT_ASSISTS }, startIndex: 0 }]);
  startMatch(w); w.match.phase = 'teleop';
  for (const b of w.balls) { b.state = { kind: 'ground' }; b.pos = { x: -40, y: -60 }; b.vel={x:0,y:0}; b.z=0; b.vz=0; }
  // a STALLED column: artifacts parked, none moving, gate sitting in the gap between two
  for (let i = 0; i < 9; i++) { const b = w.balls[i]; const s = C.GATE_LINE_S + C.BALL_RADIUS + 0.6 + i * C.RAIL_PITCH;
    b.state = { kind: 'rail', goal: 'red', s, v: 0, overflow: false, pending: false };
    b.pos = railPos('red', s); b.vel={x:0,y:0}; b.z=C.RAMP_SURFACE_Z; b.vz=0; }
  const r = w.robots[0];
  r.pos = { x: 57.3, y: y0 }; r.heading = headDeg*Math.PI/180; r.hopper = ['green','green','green']; r.fieldCentric = false; r.vel={x:0,y:0};
  const g = w.goals.red; g.gatePos = 1; g.gateOpen = true; g.gateLatch = C.GATE_OPEN_LATCH_S;
  for (let i = 0; i < Math.round(4 / C.SIM_DT); i++) step(w, C.SIM_DT, new Map([[0, cmd({ intake: true })]]));
  const rect = gateArmRect('red');
  const ext = robotIntersectsRect(r, rect), ch = chassisTouches(r, rect);
  console.log(`y${y0} h${headDeg}deg -> gatePos after 4s STALLED: ${g.gatePos.toFixed(2)}  | arm touched by: extended=${ext} chassis=${ch}${ext && !ch ? '  *** held by the INTAKE only' : ''}`);
}}
