import { COLORS, ENDGAME_START } from '../config';
import type { Camera } from '../render/camera';
import type { FieldBounds } from '../games/types';
import type { Alliance, World } from '../types';

/**
 * THE SCOREBOARD, BURNED INTO A REPLAY VIDEO.
 *
 * The viewer's scoreboard is React DOM sitting ABOVE the canvas (`.ds-replay-score`), and the
 * video is a capture of the canvas — so the export had no score in it at all, and no sign of
 * when the match started or what it finished. On screen that split is invisible, because the
 * page supplies the half the canvas does not; in a file that leaves a match nobody can read.
 * A video is also the one export that outlives the sim (`replayRefusal` retires the container,
 * never the recording), so it is exactly the artifact that has to stand on its own.
 *
 * IT NEVER COVERS THE FIELD, and the camera's reserved bands are not enough to promise that.
 * `HUD_BOTTOM` shrinks to 4px on a compact or short layout, and the field is centred in what
 * is left, so how much clear space sits under it depends on the viewer's aspect ratio — on
 * some it is generous and on others the field runs straight into the bar. So the caller asks
 * `fieldScreenBottom` where the field actually ENDS and gives the frame `HUD_RESERVE` more
 * height when there is not already room. Extra letterbox costs nothing; a scoreboard sitting
 * on top of the match costs the match.
 *
 * ⚠️ IT SETS ITS OWN TRANSFORM, and must. `Renderer.render` leaves the context in FIELD
 * INCHES — translated, scaled and rotated by the driver's view angle — so an overlay that
 * assumed CSS pixels drew its scoreboard somewhere off in the field's coordinate space and
 * produced a video with nothing on it at all. Working in CSS units (`Camera.w`/`Camera.h`
 * scaled by `dpr`) is also what keeps the bar the same SIZE relative to the field at every
 * encode resolution, instead of shrinking as the pixels go up.
 */

const BAR_H = 64;
const PAD = 18;
/** CSS pixels the bar needs BELOW the field: its own height plus breathing room */
export const HUD_RESERVE = BAR_H + 20;

/**
 * How far down the screen the field reaches, in CSS pixels.
 *
 * The camera maps world inches to the screen through the driver's view angle, so this is the
 * only honest way to ask: the answer depends on the alliance, the game's bounds (CR's goals
 * protrude), and how the fit landed. Taking the max over the four corners covers every
 * rotation without caring which one is which.
 */
export function fieldScreenBottom(camera: Camera, bounds: FieldBounds): number {
  const { halfX: hx, halfY: hy } = bounds;
  const corners = [
    { x: -hx, y: -hy },
    { x: hx, y: -hy },
    { x: hx, y: hy },
    { x: -hx, y: hy },
  ];
  return Math.max(...corners.map((c) => camera.worldToScreen(c).y));
}
/**
 * The bar is CENTRED and capped, not stretched edge to edge.
 *
 * The field is square and the frame is not, so a wide layout letterboxes it with a lot of
 * empty backdrop — and a full-width bar puts the two scores out at the far corners of the
 * video with the clock marooned between them, reading as three unrelated things rather than
 * as one scoreboard. Capped, it sits under the field at about the field's own width.
 */
const BAR_MAX_W = 760;

const FONT = 'system-ui, sans-serif';
const mmss = (sec: number): string => {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** everything the bar says in words — pulled out of the drawing so it can be tested without
 *  a canvas, since this is where the decisions are (endgame, a tie, a solo run) */
export interface HudLabels {
  /** the phase, in the words the bar shows */
  phase: string;
  /** time left in the phase, or null once the match is over */
  clock: string | null;
  /** who won, or null while it is still being played — and for a solo run, which has no
   *  opponent to have beaten */
  result: string | null;
}

/**
 * What the middle of the bar says.
 *
 * ENDGAME is split out of teleop the way the live HUD splits it — it is a different thing to
 * be watching, and a recording that never marked it would lose the moment the match changes
 * character. A TIE says so rather than leaving two equal numbers to be compared by eye.
 */
export function hudLabels(world: World, solo: Alliance | null): HudLabels {
  const m = world.match;
  if (m.phase === 'post') {
    const r = m.scores.red.total;
    const b = m.scores.blue.total;
    return {
      phase: 'FINAL',
      clock: null,
      result: solo ? null : r === b ? 'TIE' : r > b ? 'RED WINS' : 'BLUE WINS',
    };
  }
  const phase =
    m.phase === 'pre'
      ? 'PRE-MATCH'
      : m.phase === 'auto'
        ? 'AUTONOMOUS'
        : m.phase === 'transition'
          ? 'TRANSITION'
          : m.phase === 'teleop'
            ? m.phaseTimeLeft <= ENDGAME_START
              ? 'END GAME'
              : 'TELEOP'
            : 'PRACTICE';
  return { phase, clock: mmss(m.phaseTimeLeft), result: null };
}

/** a rounded rect, because the score blocks read as chips rather than as bare fills */
function chip(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

/**
 * The pre-match lead-in, over the middle of the field.
 *
 * "MATCH BEGINS IN" before the digits is the same product rule the live HUD follows — a number
 * counting down on its own does not say what it is counting down to. `preCountdown` is the
 * sim's own field, so a replay reproduces the lead-in exactly rather than approximating it.
 */
function drawCountdown(ctx: CanvasRenderingContext2D, world: World, w: number, fieldH: number): void {
  const left = world.match.preCountdown;
  if (left == null || left <= 0) return;
  const cx = w / 2;
  // centred on the FIELD, not on the frame: the frame can be taller than the field to make
  // room for the bar, and a countdown drifting toward the scoreboard reads as misaligned
  const cy = fieldH / 2;
  const h = fieldH;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COLORS.white;
  ctx.globalAlpha = 0.85;
  ctx.font = `700 ${Math.round(h * 0.035)}px ${FONT}`;
  ctx.fillText('MATCH BEGINS IN', cx, cy - h * 0.09);
  ctx.globalAlpha = 1;
  ctx.font = `700 ${Math.round(h * 0.18)}px ${FONT}`;
  ctx.fillText(String(Math.ceil(left)), cx, cy + h * 0.02);
}

/**
 * Draw the live scoreboard (and, at the end, the final one) for `world`.
 *
 * `solo` names the single alliance of a RECORD run, whose opponent never existed — printing a
 * "0" for it would read as a shutout, which is the same reason the viewer collapses to one
 * score. Null means an ordinary two-alliance match.
 */
export function drawReplayHud(
  ctx: CanvasRenderingContext2D,
  world: World,
  view: {
    width: number;
    height: number;
    dpr: number;
    /** where the field ends, so the countdown stays centred on it */
    fieldHeight: number;
    solo: Alliance | null;
  },
): void {
  const { width: w, height: h, solo } = view;
  const m = world.match;
  const labels = hudLabels(world, solo);
  const done = m.phase === 'post';
  const y = h - BAR_H - 10;
  const barW = Math.min(w - PAD * 2, BAR_MAX_W);
  const barX = (w - barW) / 2;

  ctx.save();
  // back to CSS pixels — `render` left this in field inches (see the note above)
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

  // a dark plate so the type reads over whatever the field happens to be behind it. The field
  // is hardcoded dark (see the THEME note in CLAUDE.md), so this never themes either.
  ctx.fillStyle = 'rgba(18,21,26,0.86)';
  chip(ctx, barX, y, barW, BAR_H, 10);

  ctx.textBaseline = 'middle';
  const midY = y + BAR_H / 2;
  const scoreFont = `700 ${Math.round(BAR_H * 0.46)}px ${FONT}`;
  const labelFont = `700 ${Math.round(BAR_H * 0.19)}px ${FONT}`;

  const side = (alliance: Alliance, x: number, align: 'left' | 'right'): void => {
    const dir = align === 'left' ? 1 : -1;
    ctx.textAlign = align;
    ctx.fillStyle = alliance === 'red' ? COLORS.red : COLORS.blue;
    ctx.font = labelFont;
    ctx.fillText(alliance.toUpperCase(), x, midY - BAR_H * 0.19);
    ctx.font = scoreFont;
    ctx.fillStyle = COLORS.white;
    ctx.fillText(String(m.scores[alliance].total), x + dir * 2, midY + BAR_H * 0.12);
  };

  if (solo) {
    side(solo, barX + 26, 'left');
  } else {
    side('red', barX + 26, 'left');
    side('blue', barX + barW - 26, 'right');
  }

  // the middle: what phase it is and how long is left in it — or the result, once there is one
  ctx.textAlign = 'center';
  ctx.fillStyle = done ? COLORS.white : 'rgba(229,231,235,0.62)';
  ctx.font = labelFont;
  ctx.fillText(labels.phase, w / 2, midY - BAR_H * 0.19);
  if (labels.clock) {
    ctx.font = `700 ${Math.round(BAR_H * 0.34)}px ${FONT}`;
    ctx.fillStyle = COLORS.white;
    ctx.fillText(labels.clock, w / 2, midY + BAR_H * 0.14);
  } else if (labels.result) {
    ctx.font = `700 ${Math.round(BAR_H * 0.24)}px ${FONT}`;
    const r = m.scores.red.total;
    const b = m.scores.blue.total;
    ctx.fillStyle = r === b ? COLORS.white : r > b ? COLORS.red : COLORS.blue;
    ctx.fillText(labels.result, w / 2, midY + BAR_H * 0.16);
  }

  drawCountdown(ctx, world, w, view.fieldHeight);
  ctx.restore();
}
