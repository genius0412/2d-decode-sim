import type { Vec2, World } from '../../types';
import * as C from '../../config';
import type { Alliance } from '../../types';
import {
  CHAIN_ACCEL_DEPTH,
  CHAIN_ACCEL_HALF_Y,
  CHAIN_BEAM_RENDER_H,
  CHAIN_DIAMOND_R,
  CHAIN_HALF_X,
  CHAIN_HALF_Y,
  CHAIN_RINGSTAND_BOX,
} from './config';
import { labAreas, ringStandBoxes, ringStands } from './state';
import { CHAIN_BEAMS, BEAM_HALF_W } from './beams';

/**
 * Chain Reaction field renderer (manual §2–4 terminology).
 *
 * A standard FTC tile field with: the two ACCELERATORS protruding OUT of the side
 * walls (red left, blue right, centered in y); the four HOOKS on the accelerator
 * walls (hold Catalysts); the central PARTICLE ZONE diamond (red-left/blue-right);
 * and the four RING STAND climb posts near the corners. Accelerator + hook geometry, the
 * PARTICLE-ZONE diamond (48" outer sides), and the BEAMS (56" long, 1" wide) are all EXACT
 * manual values; Ring-Stand + Lab-Area positions are still approximate (see config.ts).
 * Reuses DECODE's `COLORS` so it themes/reads identically on the dark field.
 */
export function drawChainField(ctx: CanvasRenderingContext2D, _world: World, screenUp: Vec2 = { x: 0, y: 1 }): void {
  const hx = CHAIN_HALF_X;
  const hy = CHAIN_HALF_Y;

  // mat
  ctx.fillStyle = C.COLORS.mat;
  ctx.fillRect(-hx, -hy, 2 * hx, 2 * hy);

  // tile grid (every 24" tile)
  ctx.strokeStyle = C.COLORS.tile;
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  for (let x = -hx; x <= hx + 0.01; x += C.TILE) {
    ctx.moveTo(x, -hy);
    ctx.lineTo(x, hy);
  }
  for (let y = -hy; y <= hy + 0.01; y += C.TILE) {
    ctx.moveTo(-hx, y);
    ctx.lineTo(hx, y);
  }
  ctx.stroke();

  // BEAMS — four 1"-tall tubes (difficult terrain) on the x/y axes, wall→diamond. The LIT TOP FACE
  // is drawn at the tube's TRUE footprint (it reads exactly where it physically is); a thin dark
  // near-wall dropped a hair TOWARD the camera (−screenUp) hints the z-thickness. No drop shadow —
  // the tape runs right alongside, and a shadow just muddied it. Drawn FIRST so the tape reads over.
  const dx = -screenUp.x * CHAIN_BEAM_RENDER_H; // the near (camera-facing) wall drops this way
  const dy = -screenUp.y * CHAIN_BEAM_RENDER_H;
  for (const beam of CHAIN_BEAMS) {
    const r = beam.rect;
    const top: [number, number][] = [
      [r.x0, r.y0],
      [r.x1, r.y0],
      [r.x1, r.y1],
      [r.x0, r.y1],
    ];
    // near-side walls: each top edge dropped a touch toward the camera — the visible thickness
    ctx.fillStyle = '#05070b';
    for (let i = 0; i < 4; i++) {
      const a = top[i];
      const b = top[(i + 1) % 4];
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.lineTo(b[0] + dx, b[1] + dy);
      ctx.lineTo(a[0] + dx, a[1] + dy);
      ctx.closePath();
      ctx.fill();
    }
    // top face AT THE TRUE FOOTPRINT — a lit plane above the dark mat, bright edge, so the tube
    // reads as raised terrain sitting exactly where it is
    ctx.fillStyle = '#2c333d';
    ctx.strokeStyle = 'rgba(176,186,198,0.95)';
    ctx.lineWidth = 0.5;
    ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  }

  // ALLIANCE TAPE — red (red half, x<0) / blue (blue half, x>0) 1" tape running ALONGSIDE
  // every black beam, and a second diamond just OUTSIDE the white one (red on its two left
  // edges, blue on its two right edges). Marks the red/blue zones against the neutral beams
  // + particle zone. `d` = tape centre just beyond the 1"-wide beam edge; tape runs from the
  // wall to the diamond-vertex distance `Rc` (the diamond takes over inside).
  const R = CHAIN_DIAMOND_R;
  const Rc = R + Math.SQRT2 * C.TAPE_W; // colored diamond: 1" perpendicular OUTSIDE the white
  const d = BEAM_HALF_W + C.TAPE_W / 2;
  ctx.lineWidth = C.TAPE_W;
  const seg = (color: string, x0: number, y0: number, x1: number, y1: number): void => {
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  };
  const red = C.COLORS.red;
  const blue = C.COLORS.blue;
  // vertical (y-axis) beams sit ON the x=0 boundary: red on the left, blue on the right
  seg(red, -d, Rc, -d, hy);
  seg(blue, d, Rc, d, hy);
  seg(red, -d, -hy, -d, -Rc);
  seg(blue, d, -hy, d, -Rc);
  // horizontal (x-axis) beams: the −x beam is in the red half, the +x beam in the blue half
  // (tape on BOTH long sides), from the wall to the diamond's side vertex
  seg(red, -hx, d, -Rc, d);
  seg(red, -hx, -d, -Rc, -d);
  seg(blue, hx, d, Rc, d);
  seg(blue, hx, -d, Rc, -d);
  // red/blue diamond just OUTSIDE the white — left two edges red, right two edges blue
  ctx.strokeStyle = red;
  ctx.beginPath();
  ctx.moveTo(0, Rc);
  ctx.lineTo(-Rc, 0);
  ctx.lineTo(0, -Rc);
  ctx.stroke();
  ctx.strokeStyle = blue;
  ctx.beginPath();
  ctx.moveTo(0, Rc);
  ctx.lineTo(Rc, 0);
  ctx.lineTo(0, -Rc);
  ctx.stroke();

  // PARTICLE ZONE — the central WHITE diamond (tape), 48" outer sides.
  ctx.strokeStyle = C.COLORS.white;
  ctx.lineWidth = C.TAPE_W;
  ctx.beginPath();
  ctx.moveTo(0, R);
  ctx.lineTo(-R, 0);
  ctx.lineTo(0, -R);
  ctx.lineTo(R, 0);
  ctx.closePath();
  ctx.stroke();

  // ACCELERATORS — protrude OUT of each alliance side wall (red left, blue right),
  // centered in y. Filled box + outline, matching the manual.
  const accelerator = (side: -1 | 1, fill: string, stroke: string): void => {
    const xInner = side * hx;
    const xOuter = side * (hx + CHAIN_ACCEL_DEPTH);
    const x0 = Math.min(xInner, xOuter);
    ctx.fillStyle = fill;
    ctx.fillRect(x0, -CHAIN_ACCEL_HALF_Y, CHAIN_ACCEL_DEPTH, 2 * CHAIN_ACCEL_HALF_Y);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = C.TAPE_W;
    ctx.strokeRect(x0, -CHAIN_ACCEL_HALF_Y, CHAIN_ACCEL_DEPTH, 2 * CHAIN_ACCEL_HALF_Y);
  };
  accelerator(-1, C.COLORS.redDim, C.COLORS.red);
  accelerator(1, C.COLORS.blueDim, C.COLORS.blue);

  // (HOOKS + seated rings are drawn dynamically in drawChainBalls so each hook
  // slot's occupancy is visible — see draw.ts.)

  // LAB AREAS / corners — WHITE tape corner squares (start + park zones).
  ctx.strokeStyle = C.COLORS.white;
  ctx.lineWidth = C.TAPE_W;
  for (const a of ['red', 'blue'] as Alliance[]) {
    for (const lab of labAreas(a)) {
      ctx.strokeRect(lab.x0, lab.y0, lab.x1 - lab.x0, lab.y1 - lab.y0);
    }
  }

  // RING STANDS — the corner ASSEMBLY: a solid square filling the field corner (post plus
  // its mounting plate), with the post drawn on top. Drawn from the SAME `ringStandBoxes`
  // the colliders are built from, so the shape you see is exactly the shape you collide
  // with — it used to be drawn as a big triangular plate with a thin post, which matched
  // neither the hitbox nor the real part.
  const POST = 1.4; // post half-size (top-down square cross-section)
  const H = CHAIN_RINGSTAND_BOX / 2;
  for (const b of ringStandBoxes()) {
    // the solid corner block
    ctx.fillStyle = '#33383e';
    ctx.fillRect(b.x - H, b.y - H, 2 * H, 2 * H);
    ctx.strokeStyle = 'rgba(120,130,140,0.7)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(b.x - H, b.y - H, 2 * H, 2 * H);
  }
  // the POSTS — at each block's INNER corner (opposite the field corner), not centred on it.
  // `ringStands()` is the single source, shared with the ascend/descent logic.
  ctx.fillStyle = '#0a0c0f';
  for (const p of ringStands()) {
    ctx.fillRect(p.x - POST, p.y - POST, 2 * POST, 2 * POST);
    ctx.strokeRect(p.x - POST, p.y - POST, 2 * POST, 2 * POST);
  }

  // perimeter outline (drawn last so the accelerators read as attached to the wall)
  ctx.strokeStyle = C.COLORS.white;
  ctx.lineWidth = C.TAPE_W;
  ctx.strokeRect(-hx, -hy, 2 * hx, 2 * hy);
}
