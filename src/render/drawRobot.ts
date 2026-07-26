import type { Artifact, RobotState } from '../types';
import * as C from '../config';
import { turretWorldPos } from '../sim/robot';
import { rot } from '../math';

export function drawRobot(
  ctx: CanvasRenderingContext2D,
  r: RobotState,
  intakeOn: boolean,
  held: Artifact[] = [],
  _screenUp?: { x: number; y: number }, // DECODE has no raised terrain — ignored (interface parity)
): void {
  const hl = r.spec.length / 2;
  const hw = r.spec.width / 2;
  const color = r.alliance === 'blue' ? C.COLORS.blue : C.COLORS.red;
  // The alliance lives in `color` (the OUTLINE). `fill` is the supporter cosmetic
  // and can never change which alliance a robot reads as.
  const fill = C.chassisFill(r.spec.chassisColor);

  ctx.save();
  ctx.translate(r.pos.x, r.pos.y);
  ctx.rotate(r.heading);

  // chassis
  ctx.fillStyle = fill;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  roundRect(ctx, -hl, -hw, r.spec.length, r.spec.width, 1.6);
  ctx.fill();
  ctx.stroke();

  drawWheels(ctx, r, color);

  // intake at the front (RobotPreview.tsx draws the same). FUNNEL presets
  // (sloped/triangle) are two RIGHT TRIANGLES — one per side — whose hypotenuses
  // are the slopes that funnel balls to the compliant wheels at the throat (no
  // flat front). VECTOR is a flat plate with a full-width wheel roller.
  const preset = C.INTAKE_PRESETS[r.spec.intake];
  const m = C.intakeMouth(r.spec); // vector's mouth spans the chassis width
  const rw = m.mouthHalf;
  const wedgeTip = hl + preset.reach - 0.5; // wedge/plate front — just behind the roller
  const rollerTip = hl + preset.reach + 0.5; // shaft + wheels ride out just past the wedges
  const mouthOn = intakeOn ? 'rgba(34,197,94,0.85)' : '#2a303c';
  const drawRoller = () => {
    ctx.fillStyle = intakeOn ? '#166534' : '#333a45';
    ctx.fillRect(wedgeTip, -rw, rollerTip - wedgeTip, rw * 2);
    for (let i = -3; i <= 3; i++) {
      const center = Math.abs(i) <= 1;
      ctx.fillStyle = center ? (intakeOn ? '#22c55e' : '#6b7280') : intakeOn ? '#15803d' : '#4b5563';
      ctx.fillRect(rollerTip - 1.5, (i * rw) / 3.4 - 0.8, 1.3, 1.6);
    }
  };
  if (m.wedge) {
    const th = m.throatHalf;
    // funnel mouth: opening at the (recessed) wedge line, narrowing to the throat
    ctx.fillStyle = mouthOn;
    ctx.beginPath();
    ctx.moveTo(wedgeTip, -hw);
    ctx.lineTo(wedgeTip, hw);
    ctx.lineTo(hl, th);
    ctx.lineTo(hl, -th);
    ctx.closePath();
    ctx.fill();
    // two right triangles (right angle at the chassis front-outer corner; the
    // hypotenuse from the front corner in to the throat is the slope)
    ctx.fillStyle = fill;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    for (const s of [1, -1] as const) {
      ctx.beginPath();
      ctx.moveTo(hl, s * hw);
      ctx.lineTo(wedgeTip, s * hw);
      ctx.lineTo(hl, s * th);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    drawRoller();
  } else {
    // vector: flat plate to the (barely recessed) wedge line + the roller out front
    ctx.fillStyle = mouthOn;
    ctx.fillRect(hl, -rw, wedgeTip - hl, rw * 2);
    drawRoller();
  }

  // heading chevron
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(hl - 2.4, 0);
  ctx.lineTo(hl - 5.4, 2.2);
  ctx.lineTo(hl - 5.4, -2.2);
  ctx.closePath();
  ctx.fill();

  // held artifacts — the actual PHYSICAL balls (they slide within the intake),
  // drawn HERE in the robot's local frame so they sit BELOW the turret/shooter.
  for (const b of held) {
    // use the STORED local offset, not `b.pos - r.pos`: for a remote robot the
    // rendered `r.pos` is INTERPOLATED but the ball's world `b.pos` comes straight
    // from the predicted sim (balls aren't interpolated), so the world round-trip
    // would misplace the ball relative to the robot body. lx/ly track it rigidly.
    const lp =
      b.state.kind === 'held'
        ? { x: b.state.lx, y: b.state.ly }
        : rot({ x: b.pos.x - r.pos.x, y: b.pos.y - r.pos.y }, -r.heading);
    ctx.fillStyle = b.color === 'purple' ? C.COLORS.purple : C.COLORS.green;
    ctx.beginPath();
    ctx.arc(lp.x, lp.y, C.BALL_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.4;
    ctx.stroke();
  }
  ctx.restore();

  // turret on top (world orientation) — sized so nothing pokes past the
  // chassis in ANY turret direction: max reach is the distance from the
  // turret center to the nearest chassis edge
  const tp = turretWorldPos(r);
  const off = Math.abs(r.spec.length * C.TURRET_OFFSET_FRAC);
  const reach = Math.min(hl - off, hw) - 0.5;
  const ring = Math.min(4.4, reach);
  ctx.save();
  ctx.translate(tp.x, tp.y);
  ctx.rotate(r.turretHeading);
  ctx.strokeStyle = r.hopper.length > 0 ? '#22c55e' : '#6b7280';
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.arc(0, 0, ring, 0, Math.PI * 2);
  ctx.stroke();
  // turret body + barrel
  ctx.fillStyle = '#3a4150';
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(ring - 1, 1.5), 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#525b6b';
  ctx.fillRect(0, -1.2, reach, 2.4);
  ctx.restore();
}

/**
 * Draw a robot's DRIVETRAIN wheels in the chassis-local frame (already translated +
 * rotated to the robot). Shared by DECODE's drawRobot and Chain Reaction's drawChainRobot
 * so every drivetrain reads identically across games: mecanum/tank point forward, SWERVE
 * pods steer to `moduleAngles`, X-drive omnis sit at ±45° (an X).
 */
export function drawWheels(ctx: CanvasRenderingContext2D, r: RobotState, color: string): void {
  const hl = r.spec.length / 2;
  const hw = r.spec.width / 2;
  const wx = Math.max(hl - C.WHEEL_INSET, 1);
  const wy = Math.max(hw - C.WHEEL_INSET, 1);
  const corners = [
    [wx, wy],
    [wx, -wy],
    [-wx, wy],
    [-wx, -wy],
  ] as const;
  const drawWheel = (px: number, py: number, ang: number, len = 4.4, wid = 2.2, fill = '#12171e'): void => {
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ang);
    ctx.fillStyle = fill;
    ctx.fillRect(-len / 2, -wid / 2, len, wid);
    // a light edge so the wheel's ORIENTATION reads (X-drive X, swerve steer)
    ctx.strokeStyle = 'rgba(190,205,220,0.4)';
    ctx.lineWidth = 0.35;
    ctx.strokeRect(-len / 2, -wid / 2, len, wid);
    ctx.restore();
  };
  if (r.spec.drivetrain === 'swerve') {
    // each of the four pods renders at its OWN angle — they visibly swivel + wobble
    corners.forEach(([px, py], i) => {
      const ang = r.moduleAngles[i] ?? 0;
      // steering module housing
      ctx.save();
      ctx.translate(px, py);
      ctx.fillStyle = '#0c1016';
      ctx.fillRect(-2.6, -2.6, 5.2, 5.2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 0.4;
      ctx.strokeRect(-2.6, -2.6, 5.2, 5.2);
      ctx.restore();
      drawWheel(px, py, ang, 4.2, 1.8, '#1b212b');
      // a tick showing which way this pod points
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(ang);
      ctx.strokeStyle = color;
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(2.4, 0);
      ctx.stroke();
      ctx.restore();
    });
  } else if (r.spec.drivetrain === 'xdrive') {
    // omni wheels canted 45°, opposite corners on the same diagonal → an X. Long +
    // lighter so the X clearly reads; the diagonals nearly meet at the center.
    const reach = Math.hypot(wx, wy);
    for (const [px, py] of corners) drawWheel(px, py, px * py >= 0 ? Math.PI / 4 : -Math.PI / 4, Math.min(reach * 1.15, 7.5), 2.0, '#2b333e');
  } else {
    for (const [px, py] of corners) drawWheel(px, py, 0);
  }
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
