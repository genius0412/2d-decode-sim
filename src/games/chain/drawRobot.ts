import type { Artifact, RobotState } from '../../types';
import * as C from '../../config';
import { drawWheels, roundRect } from '../../render/drawRobot';
import {
  CHAIN_DEFAULT_SCORE_MODE,
  chainHopperCap,
  CHAIN_LAUNCH_LINE_FRAC,
} from './config';
import { chainIntakeBand } from './state';

/**
 * Chain Reaction robot sprite (top-down). Shares the chassis + drivetrain wheels with
 * DECODE (drawWheels/roundRect) but draws the CR-specific mechanisms so the build reads
 * at a glance: the full-width sweeper INTAKE at the front and the SCORING
 * ARCHETYPE launcher (turret on top · chassis-wide drum · chassis-wide catapult). A slim
 * hopper-fill bar shows how full it is. Front = robot +x (heading).
 */
const GREEN = '#22c55e';
const GREEN_DK = '#166534';
const STEEL = '#3a4150';
const STEEL_DK = '#2a3140';
const IDLE = '#4b5563';


export function drawChainRobot(
  ctx: CanvasRenderingContext2D,
  r: RobotState,
  intakeOn: boolean,
  _held: Artifact[] = [],
): void {
  const hl = r.spec.length / 2;
  const hw = r.spec.width / 2;
  const color = r.alliance === 'blue' ? C.COLORS.blue : C.COLORS.red;
  const loaded = r.hopper.length > 0;
  const mode = r.spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE;
  // the intake reads ACTIVE (green) whenever it can still collect — i.e. it's on (auto or the
  // held command) AND the hopper isn't full — not just when nearly empty.
  const intaking = (intakeOn || r.autoIntake) && r.hopper.length < chainHopperCap(r.spec);

  ctx.save();
  ctx.translate(r.pos.x, r.pos.y);
  ctx.rotate(r.heading);

  // chassis
  ctx.fillStyle = C.chassisFill(r.spec.chassisColor);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  roundRect(ctx, -hl, -hw, r.spec.length, r.spec.width, 1.6);
  ctx.fill();
  ctx.stroke();

  drawWheels(ctx, r, color);

  drawChainIntake(ctx, r, intaking, hl);

  // scoring-archetype launcher (chassis-fixed part). Drum + catapult sit just inside the
  // front — or the REAR for a rear-shooter build. The turret is drawn last, in the world
  // frame, so it rotates independently.
  const sSign = r.spec.shooterRear ? -1 : 1;
  if (mode === 'drum') drawDrum(ctx, hl, hw, loaded, sSign);
  else if (mode === 'dumper') drawCatapult(ctx, hl, hw, loaded, sSign);

  drawHopperFill(ctx, r, hw);

  // heading chevron (near the rear so it doesn't fight the front mechanisms)
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-hl + 4.6, 0);
  ctx.lineTo(-hl + 1.8, 1.9);
  ctx.lineTo(-hl + 1.8, -1.9);
  ctx.closePath();
  ctx.fill();

  ctx.restore();

  if (mode === 'turret') drawTurret(ctx, r, loaded);
}

/** CR intake — the full-width sweeper roller. Mounts on the FRONT (a bar across the chassis
 * front) or the LEFT+RIGHT edges (two bars along the sides). Greens while intaking. The drawn
 * bars ARE the grab area (`chainIntakeBand`, shared with `interact`). */
function drawChainIntake(
  ctx: CanvasRenderingContext2D,
  r: RobotState,
  on: boolean,
  hl: number,
): void {
  const m = chainIntakeBand(r.spec);
  const barFill = on ? GREEN_DK : '#333a45';
  const tickFill = on ? GREEN : '#6b7280';

  if (m.side) {
    // SIDE rollers along each side edge (±y), spanning the chassis length
    const n = Math.max(2, Math.round(m.halfLen / 2.4));
    for (const s of [1, -1] as const) {
      const y0 = s * m.inner;
      const y1 = s * m.outer;
      ctx.fillStyle = barFill;
      ctx.fillRect(-m.halfLen, Math.min(y0, y1), m.halfLen * 2, Math.abs(y1 - y0));
      ctx.fillStyle = tickFill;
      for (let i = -n; i <= n; i++) {
        ctx.fillRect((i * m.halfLen) / (n + 0.5) - 0.65, s * m.outer - s * 1.2 - (s > 0 ? 0 : 1.1), 1.3, 1.1);
      }
    }
    return;
  }

  // FRONT: full-width roller bar across the chassis front, ticks at the tip
  const half = m.half;
  const x1 = m.front; // the intake tip (collision front)
  ctx.fillStyle = barFill;
  ctx.fillRect(hl, -half, x1 - hl, half * 2);
  const n = Math.max(2, Math.round(half / 2.4));
  ctx.fillStyle = tickFill;
  for (let i = -n; i <= n; i++) ctx.fillRect(x1 - 1.2, (i * half) / (n + 0.5) - 0.65, 1.1, 1.3);
}

/** chassis-wide flywheel DRUM: a FULL-WIDTH row of compliant rollers (the flywheels) across
 * the front — NOT a channelled drum. The rollers spin to intake AND launch. Greens when loaded. */
function drawDrum(ctx: CanvasRenderingContext2D, hl: number, hw: number, loaded: boolean, sSign = 1): void {
  const half = hw * 0.96; // spans (nearly) the whole chassis width
  const th = 3.4; // roller-bar depth (along x)
  const cx = sSign * (hl - th / 2 - 0.5); // front (+1) or rear (−1) for a rear-shooter
  // roller housing bar across the full width
  ctx.fillStyle = STEEL_DK;
  ctx.strokeStyle = loaded ? GREEN : IDLE;
  ctx.lineWidth = 0.7;
  roundRect(ctx, cx - th / 2, -half, th, half * 2, 0.8);
  ctx.fill();
  ctx.stroke();
  // the compliant flywheel rollers — a row of wheels across the entire width
  const n = Math.max(5, Math.round((half * 2) / 2.6));
  ctx.fillStyle = loaded ? GREEN : '#7c8593';
  for (let i = 0; i < n; i++) {
    const y = -half + ((i + 0.5) * (half * 2)) / n;
    ctx.fillRect(cx - th / 2 + 0.5, y - 0.75, th - 1, 1.5);
  }
}

/** chassis-wide CATAPULT: a wide bucket/paddle across the front the whole hopper is
 * flung from. Reads as a curved throwing lip. Greens when loaded. */
function drawCatapult(ctx: CanvasRenderingContext2D, hl: number, hw: number, loaded: boolean, sSign = 1): void {
  const half = hw * CHAIN_LAUNCH_LINE_FRAC;
  const back = sSign * (hl - 6); // bucket floor (front, or rear for a rear-shooter)
  const lip = sSign * (hl - 1); // throwing lip near the shooter edge
  ctx.fillStyle = STEEL_DK;
  ctx.strokeStyle = loaded ? GREEN : IDLE;
  ctx.lineWidth = 0.8;
  // bucket: a wide trapezoid opening toward the front, with a raised lip
  ctx.beginPath();
  ctx.moveTo(back, -half * 0.7);
  ctx.lineTo(lip, -half);
  ctx.lineTo(lip, half);
  ctx.lineTo(back, half * 0.7);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // throwing lip
  ctx.strokeStyle = loaded ? GREEN : STEEL;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(lip, -half);
  ctx.lineTo(lip, half);
  ctx.stroke();
}

/** turret on top (world orientation), ring + barrel toward the aim heading. */
function drawTurret(ctx: CanvasRenderingContext2D, r: RobotState, loaded: boolean): void {
  const hl = r.spec.length / 2;
  const hw = r.spec.width / 2;
  const off = Math.abs(r.spec.length * C.TURRET_OFFSET_FRAC);
  const reach = Math.min(hl - off, hw) - 0.5;
  const ring = Math.min(4.4, reach);
  // turret sits at the chassis center offset (rear of center), in the robot frame
  const localX = -off;
  const cx = r.pos.x + Math.cos(r.heading) * localX;
  const cy = r.pos.y + Math.sin(r.heading) * localX;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(r.turretHeading);
  ctx.strokeStyle = loaded ? GREEN : '#6b7280';
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.arc(0, 0, ring, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = STEEL;
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(ring - 1, 1.5), 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#525b6b';
  ctx.fillRect(0, -1.2, reach, 2.4);
  ctx.restore();
}

/** a slim hopper-fill bar (stored particles ÷ capacity) near the rear of the chassis. */
function drawHopperFill(ctx: CanvasRenderingContext2D, r: RobotState, hw: number): void {
  const cap = chainHopperCap(r.spec);
  const frac = Math.max(0, Math.min(1, r.hopper.length / cap));
  const w = hw * 1.1; // bar width
  const x = -w / 2;
  const y = hw - 2.6;
  ctx.fillStyle = 'rgba(10,14,20,0.75)';
  roundRect(ctx, x, y, w, 1.7, 0.6);
  ctx.fill();
  if (frac > 0) {
    ctx.fillStyle = GREEN;
    roundRect(ctx, x, y, Math.max(0.8, w * frac), 1.7, 0.6);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(150,163,180,0.5)';
  ctx.lineWidth = 0.35;
  roundRect(ctx, x, y, w, 1.7, 0.6);
  ctx.stroke();
}
