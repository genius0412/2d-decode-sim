import type { Alliance, Vec2, World } from '../../types';
import * as C from '../../config';
import { CHAIN_CATALYST_OD, CHAIN_PARTICLE_R } from './config';
import { hookPos } from './state';
import { chainCatalystPrompt } from './play';

/**
 * Chain Reaction scoring-elements renderer (drawn after the robots).
 *
 * PARTICLES (white wiffle balls) — ground flat, flight lifted with a shadow;
 * CATALYSTS (purple rings) — on the field, carried, or seated on a hook; a clear
 * per-accelerator COUNT so it's unambiguous how many rings are on the hooks (the two
 * hooks read as one top-down); and endgame badges over ascended/parked robots.
 */
const PARTICLE_FILL = '#e8eaed';
const PARTICLE_LINE = 'rgba(20,22,26,0.55)';
const CATALYST = '#7c3aed';
const CATALYST_SEATED = '#c4b5fd';

export function drawChainBalls(ctx: CanvasRenderingContext2D, world: World, screenUp: Vec2): void {
  // shadows for airborne particles
  for (const b of world.balls) {
    if (b.state.kind !== 'flight') continue;
    const k = Math.max(0.3, 1 - b.z / 100);
    ctx.fillStyle = `rgba(0,0,0,${0.3 * k})`;
    ctx.beginPath();
    ctx.arc(b.pos.x, b.pos.y, CHAIN_PARTICLE_R * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }

  // particles — all one colour, so batch every circle into a SINGLE path and fill +
  // stroke ONCE (not ~600 draw calls for 300 particles). `moveTo` before each arc keeps
  // the subpaths disjoint. Same pixels; a big per-frame win at CR's particle counts.
  ctx.fillStyle = PARTICLE_FILL;
  ctx.strokeStyle = PARTICLE_LINE;
  ctx.lineWidth = 0.35;
  ctx.beginPath();
  for (const b of world.balls) {
    const lift = b.state.kind === 'flight' ? b.z * 0.12 : 0;
    const x = b.pos.x + screenUp.x * lift;
    const y = b.pos.y + screenUp.y * lift;
    ctx.moveTo(x + CHAIN_PARTICLE_R, y);
    ctx.arc(x, y, CHAIN_PARTICLE_R, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.stroke();

  const rOuter = CHAIN_CATALYST_OD / 2;
  const rMid = rOuter - 0.9;
  const up = Math.atan2(screenUp.x, screenUp.y);

  // HOOK indicators — FOUR hooks per goal at TWO positions (the manual's ±688mm on
  // the wall). Each position stacks two hooks that read as one top-down, so draw ONE
  // ring AT the real position and show how many of its two hooks hold a ring by
  // filling HALVES of the ring: empty half = thin dim arc, seated = thick bright arc.
  // ⇒ 0 rings = a faint hollow ring, 1 = one bright half, 2 = a full bright ring.
  const rRing = CHAIN_CATALYST_OD / 2;
  const seated = (a: Alliance, index: number): boolean =>
    (world.chain?.catalysts ?? []).some((c) => c.hook?.alliance === a && c.hook.index === index);
  const halfArc = (cx: number, cy: number, a0: number, a1: number, on: boolean): void => {
    ctx.beginPath();
    ctx.arc(cx, cy, rRing, a0 + 0.16, a1 - 0.16);
    ctx.lineWidth = on ? 2.4 : 0.7;
    ctx.strokeStyle = on ? CATALYST_SEATED : 'rgba(167,139,250,0.4)';
    ctx.stroke();
  };
  for (const a of ['red', 'blue'] as Alliance[]) {
    for (let pos = 0; pos < 2; pos++) {
      const c = hookPos(a, pos * 2); // the position center (on the wall, ±688mm)
      halfArc(c.x, c.y, 0, Math.PI, seated(a, pos * 2)); // one stacked hook
      halfArc(c.x, c.y, Math.PI, 2 * Math.PI, seated(a, pos * 2 + 1)); // the other
    }
  }

  // free / carried catalysts (not yet seated) render at their world position
  for (const c of world.chain?.catalysts ?? []) {
    if (c.hook) continue;
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = CATALYST;
    ctx.beginPath();
    ctx.arc(c.pos.x, c.pos.y, rMid, 0, Math.PI * 2);
    ctx.stroke();
  }

  // RING ACTION HINT: if a robot can pick up / place a ring right now, draw a bright
  // highlight on the TARGET (the free ring, seated ring, or empty hook) + a link line, so
  // it's clear an action is available and where.
  if (world.chain) {
    for (const r of world.robots) {
      const p = chainCatalystPrompt(world.chain, r);
      if (!p) continue;
      const gold = '#f5c518';
      // link line from the robot to the target
      ctx.strokeStyle = 'rgba(245,197,24,0.5)';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(r.pos.x, r.pos.y);
      ctx.lineTo(p.target.x, p.target.y);
      ctx.stroke();
      // a bright double ring on the target
      ctx.strokeStyle = gold;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(p.target.x, p.target.y, rOuter + 1.6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.arc(p.target.x, p.target.y, rOuter + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // endgame badges over robots (ascended = ring stand, parked = lab)
  const eg = world.chain?.endgame ?? {};
  for (const r of world.robots) {
    const st = eg[r.id];
    if (st !== 'ascended' && st !== 'parked') continue;
    ctx.save();
    ctx.translate(r.pos.x, r.pos.y);
    // undo the camera rotation (+viewAngle) + y-flip so the badge reads upright;
    // `up` is +viewAngle, so counter-rotate by -up (matches the DECODE label path).
    ctx.rotate(-up);
    ctx.scale(1, -1);
    ctx.fillStyle = st === 'ascended' ? '#f5c518' : C.COLORS.white;
    ctx.font = '700 5px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(st === 'ascended' ? '▲ ASCENDED' : '■ PARKED', 0, -10);
    ctx.restore();
  }
}
