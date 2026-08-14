import type { Alliance, World } from '../types';
import * as C from '../config';
import {
  baseZone,
  classifierRect,
  gateTapeSegments,
  goalTriangle,
  launchSegments,
  loadZone,
  loadBoxSlots,
  driverSide,
  tunnelStrip,
  type Rect,
} from '../sim/field';
// (gateZone itself is the invisible interaction rect — intentionally not drawn)

const F = C.FIELD_HALF;

function allianceColor(a: Alliance, dim = false): string {
  if (dim) return a === 'blue' ? C.COLORS.blueDim : C.COLORS.redDim;
  return a === 'blue' ? C.COLORS.blue : C.COLORS.red;
}

function other(a: Alliance): Alliance {
  return a === 'blue' ? 'red' : 'blue';
}

function fillRect(ctx: CanvasRenderingContext2D, r: Rect, fill: string): void {
  ctx.fillStyle = fill;
  ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
}

function strokeRect(ctx: CanvasRenderingContext2D, r: Rect, stroke: string): void {
  ctx.strokeStyle = stroke;
  ctx.lineWidth = C.TAPE_W;
  ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
}

export function drawField(ctx: CanvasRenderingContext2D, world: World): void {
  // mat + tiles
  ctx.fillStyle = C.COLORS.mat;
  ctx.fillRect(-F, -F, 2 * F, 2 * F);
  ctx.strokeStyle = C.COLORS.tile;
  ctx.lineWidth = 0.6;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(i * C.TILE, -F);
    ctx.lineTo(i * C.TILE, F);
    ctx.moveTo(-F, i * C.TILE);
    ctx.lineTo(F, i * C.TILE);
    ctx.stroke();
  }

  // shared launch zones (large far triangle + audience triangle)
  ctx.fillStyle = C.COLORS.launchTint;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-F, F);
  ctx.lineTo(F, F);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, -C.AUD_ZONE_APEX_Y);
  ctx.lineTo(-C.AUD_ZONE_HALF_W, -F);
  ctx.lineTo(C.AUD_ZONE_HALF_W, -F);
  ctx.closePath();
  ctx.fill();

  for (const a of ['red', 'blue'] as Alliance[]) {
    // base zone (alliance tape, translucent fill)
    const bz = baseZone(a);
    fillRect(ctx, bz, allianceColor(a, true));
    strokeRect(ctx, bz, allianceColor(a));

    // loading zone (white tape corner) — only the two INTERIOR edges (facing the
    // field) are stroked; the other two lie on the perimeter walls (side + audience)
    // and would overdraw them
    const lz = loadZone(a);
    fillRect(ctx, lz, 'rgba(229,231,235,0.05)');
    const lzInX = Math.abs(lz.x0) === C.FIELD_HALF ? lz.x1 : lz.x0; // interior vertical edge
    const lzInY = Math.abs(lz.y0) === C.FIELD_HALF ? lz.y1 : lz.y0; // interior horizontal edge (audience wall is y0)
    const lzWallX = lzInX === lz.x0 ? lz.x1 : lz.x0; // side-wall end of the horizontal edge
    // one connected L so the interior corner joins cleanly (the other two edges lie on
    // the perimeter walls and are dropped)
    ctx.strokeStyle = C.COLORS.white;
    ctx.lineWidth = C.TAPE_W;
    ctx.lineJoin = 'miter';
    ctx.beginPath();
    ctx.moveTo(lzInX, lz.y0);
    ctx.lineTo(lzInX, lzInY);
    ctx.lineTo(lzWallX, lzInY);
    ctx.stroke();

    // human-player 2x3 box: OFF-FIELD out-of-play storage (a station just beyond
    // the audience wall). A backing + frame around the cells plus the balls
    // stored in it (not world.balls — they stay off physics).
    const cells = loadBoxSlots(a);
    const pad = C.BALL_RADIUS + 1;
    const xs = cells.map((c) => c.x);
    const ys = cells.map((c) => c.y);
    const boxRect = {
      x0: Math.min(...xs) - pad,
      x1: Math.max(...xs) + pad,
      y0: Math.min(...ys) - pad,
      y1: Math.max(...ys) + pad,
    };
    fillRect(ctx, boxRect, '#191d24');
    strokeRect(ctx, boxRect, C.COLORS.white);
    world.humanPlayers[a].box.forEach((color, i) => {
      const c = cells[i];
      if (!c) return;
      ctx.fillStyle = color === 'green' ? C.COLORS.green : C.COLORS.purple;
      ctx.beginPath();
      ctx.arc(c.x, c.y, C.BALL_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    });

    // SECRET TUNNEL floor strip beneath the OTHER alliance's classifier —
    // it belongs to THIS alliance (its drive team is on that wall). Only the
    // FIELD-SIDE long edge is stroked: the SHORT edges sit on the classifier
    // box's border (which must take priority) and the other long edge sits on
    // the field perimeter wall — both are dropped so nothing overdraws them.
    const ts = tunnelStrip(other(a));
    fillRect(ctx, ts, allianceColor(a, true));
    const tunnelFieldX = Math.abs(ts.x0) === C.FIELD_HALF ? ts.x1 : ts.x0;
    ctx.strokeStyle = allianceColor(a);
    ctx.lineWidth = C.TAPE_W;
    ctx.beginPath();
    ctx.moveTo(tunnelFieldX, ts.y0);
    ctx.lineTo(tunnelFieldX, ts.y1);
    ctx.stroke();

    /**
     * Classifier RAMP structure (a robot obstacle) next to this alliance's goal — a neutral
     * grey STRUCTURE, not an alliance tape line.
     *
     * Outlined on THREE sides, never four. The short end at the gate is the RAMP'S EXIT, not
     * a wall: "The GATE ... prevents CLASSIFIED ARTIFACTS from exiting the RAMP into the
     * opposing ALLIANCE'S SECRET TUNNEL ZONE. OVERFLOW ARTIFACTS can pass over the top of the
     * GATE to exit the RAMP into the opposing ALLIANCE'S SECRET TUNNEL ZONE" (manual 9.8.3).
     * Stroking the full rect capped that opening with a wall line, and it read as one — the
     * one thing at that end is the gate arm, which draws itself.
     */
    const cr = classifierRect(a);
    fillRect(ctx, cr, '#191d24');
    // the gate end is whichever short edge faces the AUDIENCE (away from the goal, which
    // sits in the far corner at +y)
    const gateEndY = cr.y0;
    const farEndY = cr.y1;
    ctx.strokeStyle = C.COLORS.wall;
    ctx.lineWidth = C.TAPE_W;
    ctx.beginPath();
    ctx.moveTo(cr.x0, gateEndY); // up the FIELD-side rail from the gate...
    ctx.lineTo(cr.x0, farEndY); // ...to the goal end,
    ctx.lineTo(cr.x1, farEndY); // across the far end,
    ctx.lineTo(cr.x1, gateEndY); // and back down the wall side. The gate end stays OPEN.
    ctx.stroke();

    // GATE ZONE marking: two parallel alliance-colored tape lines, 10in long,
    // 2.75in apart (the larger invisible interaction rect works the gate)
    ctx.strokeStyle = allianceColor(a);
    ctx.lineWidth = C.TAPE_W;
    for (const [p0, p1] of gateTapeSegments(a)) {
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }

    // spike marks: 10in horizontal white tape rows on the drive-team side
    const d = driverSide(a);
    ctx.strokeStyle = C.COLORS.white;
    ctx.lineWidth = C.TAPE_W;
    for (const y of C.SPIKE_ROW_YS) {
      const cx = d * C.SPIKE_COL_X;
      ctx.beginPath();
      ctx.moveTo(cx - C.SPIKE_MARK_LEN / 2, y);
      ctx.lineTo(cx + C.SPIKE_MARK_LEN / 2, y);
      ctx.stroke();
    }

    // goal structure in the far corner (full 26.5x18.3 corner triangle)
    const tri = goalTriangle(a);
    ctx.fillStyle = a === 'blue' ? '#14235a' : '#4f1414';
    ctx.beginPath();
    ctx.moveTo(tri[0].x, tri[0].y);
    ctx.lineTo(tri[1].x, tri[1].y);
    ctx.lineTo(tri[2].x, tri[2].y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = allianceColor(a);
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  // white launch-line tape (incl. the DEPOT lines flush on each goal face) —
  // drawn LAST so the goal outline never covers the depot tape
  ctx.strokeStyle = C.COLORS.white;
  ctx.lineWidth = 1.4;
  ctx.lineCap = 'round';
  for (const [a, b] of launchSegments()) {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.lineCap = 'butt';

  // field perimeter
  ctx.strokeStyle = C.COLORS.wall;
  ctx.lineWidth = 2;
  ctx.strokeRect(-F - 1, -F - 1, 2 * F + 2, 2 * F + 2);

  // obelisk (outside the far wall, centered) with the motif
  ctx.save();
  ctx.translate(0, F + 8);
  ctx.fillStyle = '#30343c';
  ctx.beginPath();
  ctx.moveTo(0, 5.5);
  ctx.lineTo(-5.5, -3.5);
  ctx.lineTo(5.5, -3.5);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = C.COLORS.wall;
  ctx.lineWidth = 0.7;
  ctx.stroke();
  world.motif.forEach((color, i) => {
    ctx.fillStyle = color === 'purple' ? C.COLORS.purple : C.COLORS.green;
    ctx.beginPath();
    ctx.arc((i - 1) * 3.4, -1, 1.3, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}
