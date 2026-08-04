import type { Alliance, Vec2 } from '../types';
import { FIELD_HALF, VIEW_MARGIN } from '../config';
import type { FieldBounds } from '../games/types';
import { viewAngleOf } from '../sim/field';
import { rot } from '../math';

/** DECODE's square field is the default when no game bounds are supplied. */
const DECODE_BOUNDS: FieldBounds = { halfX: FIELD_HALF, halfY: FIELD_HALF, viewMargin: VIEW_MARGIN };

/** field-frame <-> screen transform, including the alliance 180° rotation so
 * each driver sees their own goal at the top */
/** CSS-px bands reserved for the HUD chrome so the field never renders under
 * it (top status chips; bottom score bar + breakdown row) */
const HUD_TOP = 56;
const HUD_BOTTOM = 96;

export class Camera {
  w = 0; // CSS pixels
  h = 0;
  dpr = 1;
  scale = 1; // px per inch
  viewAngle = 0;
  cx = 0; // screen center the field is drawn about (CSS px)
  cy = 0;

  configure(canvas: HTMLCanvasElement, alliance: Alliance, bounds: FieldBounds = DECODE_BOUNDS): void {
    this.dpr = window.devicePixelRatio || 1;
    this.w = canvas.clientWidth;
    this.h = canvas.clientHeight;
    canvas.width = Math.round(this.w * this.dpr);
    canvas.height = Math.round(this.h * this.dpr);
    // view from the driver's alliance wall (blue = right wall, red = left)
    this.viewAngle = viewAngleOf(alliance);
    // fit the field to the viewport, accounting for the driver's ±90° rotation:
    // after rotating by viewAngle the field's x/y half-extents map onto screen
    // width/height by |cos|/|sin|. For a SQUARE field this reduces to the old
    // single-span fit exactly; a non-square game field fits correctly either way.
    const ex = bounds.halfX + bounds.viewMargin;
    const ey = bounds.halfY + bounds.viewMargin;
    const c = Math.abs(Math.cos(this.viewAngle));
    const s = Math.abs(Math.sin(this.viewAngle));
    const spanW = 2 * (c * ex + s * ey);
    const spanH = 2 * (s * ex + c * ey);
    // fit within the viewport MINUS the HUD bands, and center in that band so the
    // score bar / chips never cover the field. On a TOUCH device the top status chips
    // are hidden and (in landscape) the scorebar is compact, so reserve much less —
    // this is what gives the field its room back in landscape (the CSS scorebar shrink
    // in styles.css is kept in sync with the bottom band here).
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    const landscape = this.w >= this.h;
    // compact chrome on touch devices OR any short viewport (mobile landscape) — tiny
    // top band (the compact MENU/RESET just overlaps the field corner) + a small bottom
    // band matching the compact scorebar. This hands the map its top/vertical space back.
    // Kept in sync with the CSS media condition in styles.css.
    const compact = coarse || this.h < 520;
    // LANDSCAPE on a phone is height-starved and gutter-rich: the field is square,
    // so fitting it to the height leaves ~250px of dead space on each side. The HUD
    // moves into those gutters (see the landscape block in styles.css) and the field
    // takes the full height — worth ~15% more field per side, ~30% more area.
    const topBand = compact ? (landscape ? 4 : 6) : HUD_TOP;
    const bottomBand = compact ? (landscape ? 4 : 72) : HUD_BOTTOM;
    const usableH = Math.max(this.h - topBand - bottomBand, 100);
    this.scale = Math.min(this.w / spanW, usableH / spanH);
    this.cx = this.w / 2;
    this.cy = topBand + usableH / 2;
  }

  /** set the canvas transform so draw calls use field inches */
  apply(ctx: CanvasRenderingContext2D): void {
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(this.cx, this.cy);
    ctx.scale(this.scale, -this.scale);
    ctx.rotate(this.viewAngle);
  }

  worldToScreen(p: Vec2): Vec2 {
    const r = rot(p, this.viewAngle);
    return { x: this.cx + r.x * this.scale, y: this.cy - r.y * this.scale };
  }

  /** world-space direction that points "up" on the driver's screen */
  screenUpWorld(): Vec2 {
    return rot({ x: 0, y: 1 }, -this.viewAngle);
  }
}
