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

  drawChassisBody(ctx, r, color, fill);
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
  /**
   * The INTAKE ASSEMBLY as it is actually built: a shaft spanning the mouth, a row of
   * COMPLIANT WHEELS threaded onto it, and a side plate at each end carrying the bearings.
   * The wheels are what grab a ball, so they are drawn as discrete wheels you can count
   * rather than one painted bar — and they green individually when the intake is running.
   */
  const drawRoller = () => {
    const on = intakeOn;
    const shaftY = (rollerTip + wedgeTip) / 2;
    // side plates (the bearing blocks the shaft runs in)
    ctx.fillStyle = on ? '#14532d' : '#39424f';
    for (const sgn of [1, -1] as const) {
      ctx.fillRect(wedgeTip - 0.6, sgn * rw - 0.55, rollerTip - wedgeTip + 1.2, 1.1);
    }
    // shaft
    ctx.strokeStyle = on ? '#166534' : '#4b5563';
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    ctx.moveTo(shaftY, -rw);
    ctx.lineTo(shaftY, rw);
    ctx.stroke();
    // compliant wheels along it — spaced by size, so a wide mouth carries more of them
    const n = Math.max(3, Math.round((rw * 2) / 1.9));
    for (let i = 0; i < n; i++) {
      const y = -rw + ((i + 0.5) * (rw * 2)) / n;
      ctx.fillStyle = on ? '#22c55e' : '#6b7280';
      roundRect(ctx, wedgeTip - 0.35, y - 0.62, rollerTip - wedgeTip + 0.7, 1.24, 0.34);
      ctx.fill();
      // the hub each wheel is clamped to
      ctx.fillStyle = on ? '#166534' : '#39424f';
      ctx.fillRect(shaftY - 0.22, y - 0.28, 0.44, 0.56);
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
  /* THE TURRET, as a shooter rather than a circle with a stick: a toothed slew RING it
     rotates on, the body plate, a FLYWHEEL across the breech, and a HOOD that narrows to the
     muzzle. The ring teeth are what say "this rotates"; the hood is what says "this is where
     the ball leaves". */
  const live = r.hopper.length > 0;
  const ink = live ? '#22c55e' : '#6b7280';
  // slew ring + teeth
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.arc(0, 0, ring, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 0.42;
  const teeth = Math.max(10, Math.round(ring * 4));
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(c * ring, sn * ring);
    ctx.lineTo(c * (ring + 0.5), sn * (ring + 0.5));
    ctx.stroke();
  }
  // body plate
  ctx.fillStyle = '#3a4150';
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(ring - 1, 1.5), 0, Math.PI * 2);
  ctx.fill();
  // flywheel across the breech (perpendicular to the barrel — that is the axis it spins on)
  ctx.strokeStyle = live ? '#4ade80' : '#8b95a5';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0.4, -ring * 0.62);
  ctx.lineTo(0.4, ring * 0.62);
  ctx.stroke();
  // hood: tapers from the breech to the muzzle, so the barrel has a direction
  ctx.fillStyle = '#525b6b';
  ctx.beginPath();
  ctx.moveTo(0, -1.35);
  ctx.lineTo(reach, -0.85);
  ctx.lineTo(reach, 0.85);
  ctx.lineTo(0, 1.35);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(190,205,220,0.35)';
  ctx.lineWidth = 0.3;
  ctx.stroke();
  // muzzle
  ctx.fillStyle = ink;
  ctx.fillRect(reach - 0.5, -0.85, 0.5, 1.7);
  ctx.restore();
}

/**
 * The CHASSIS — an FTC frame seen from above. Deliberately PLAIN: extruded aluminium rails
 * around a base plate, and nothing else. There are no bumpers in FTC (that is FRC), and a
 * painted-on control hub is set dressing that competes with the parts you actually configure.
 * Everything that should draw the eye here is a real subsystem — intake, drivetrain, turret,
 * launcher — so the frame's job is to stay out of their way and give them something to be
 * bolted to.
 *
 * The alliance stays in the OUTLINE, which is where it has always been.
 */
export function drawChassisBody(
  ctx: CanvasRenderingContext2D,
  r: RobotState,
  color: string,
  fill: string,
  /** draw the contact shadow? CR turns it OFF while a robot is lifted onto a beam — it
   * already draws a shadow at the true footprint down on the mat, and two would read as
   * two robots. */
  shadow = true,
): void {
  const L = r.spec.length;
  const W = r.spec.width;
  const hl = L / 2;
  const hw = W / 2;

  if (shadow) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    roundRect(ctx, -hl + 0.6, -hw + 0.9, L, W, 1.6);
    ctx.fill();
    ctx.restore();
  }

  // base plate
  ctx.fillStyle = fill;
  roundRect(ctx, -hl, -hw, L, W, 1.6);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();

  // the FRAME: an inset rail line, which is what a top-down extrusion perimeter actually
  // looks like. One thin stroke — enough to say "this is a built frame, not a tile".
  ctx.strokeStyle = 'rgba(190,205,220,0.16)';
  ctx.lineWidth = 0.32;
  roundRect(ctx, -hl + 1.15, -hw + 1.15, L - 2.3, W - 2.3, 1.0);
  ctx.stroke();
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
  /**
   * ONE WHEEL, drawn as the wheel it actually is. `kind` picks the tread, which is the only
   * thing that distinguishes these from above and is exactly what the drivetrain choice buys:
   *  • traction — a rubber tyre with tread bars ACROSS the roll direction (grip, no strafe)
   *  • mecanum  — barrel rollers at 45 degrees (see drawMecanumRollers)
   *  • omni     — barrel rollers ACROSS the tyre, in a row: rolls freely sideways
   */
  const drawWheel = (
    px: number,
    py: number,
    ang: number,
    kind: 'traction' | 'omni' | 'plain' = 'plain',
    len = 4.4,
    wid = 2.2,
    fill = '#12171e',
  ): void => {
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ang);
    // tyre
    ctx.fillStyle = fill;
    roundRect(ctx, -len / 2, -wid / 2, len, wid, wid * 0.26);
    ctx.fill();
    ctx.strokeStyle = 'rgba(190,205,220,0.40)';
    ctx.lineWidth = 0.35;
    ctx.stroke();

    ctx.save();
    roundRect(ctx, -len / 2, -wid / 2, len, wid, wid * 0.26);
    ctx.clip(); // tread never bleeds past the rim
    if (kind === 'traction') {
      // tread bars across the roll direction — what gives a traction wheel its grip
      ctx.strokeStyle = 'rgba(205,218,232,0.30)';
      ctx.lineWidth = 0.3;
      for (let o = -len / 2 + 0.55; o < len / 2; o += 0.9) {
        ctx.beginPath();
        ctx.moveTo(o, -wid / 2);
        ctx.lineTo(o, wid / 2);
        ctx.stroke();
      }
    } else if (kind === 'omni') {
      // the barrels: short rollers set across the tyre, which is what lets an omni slide
      // sideways at all. Drawn as discrete capsules, not a hatch — you can count them.
      ctx.fillStyle = 'rgba(205,218,232,0.34)';
      for (let o = -len / 2 + 0.62; o < len / 2; o += 1.05) {
        roundRect(ctx, o - 0.26, -wid / 2 + 0.22, 0.52, wid - 0.44, 0.26);
        ctx.fill();
      }
    }
    ctx.restore();

    // hub + axle — a wheel from above is a rectangle, so without this it reads as a block,
    // and the hub gives the eye something to track when the robot spins
    ctx.fillStyle = 'rgba(190,205,220,0.34)';
    ctx.beginPath();
    ctx.arc(0, 0, Math.min(wid * 0.26, 0.62), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };
  /**
   * MECANUM ROLLERS. A mecanum wheel's rollers sit at 45 degrees to the wheel axis, and the
   * four wheels ALTERNATE by diagonal — FL and BR one way, FR and BL the other — so from above
   * the roller lines form an X. That alternation is not decoration: it is what lets the four
   * wheels' lateral force components add up instead of cancelling, i.e. what makes the drive
   * able to strafe at all. Drawing all four the same way is the classic mecanum render
   * mistake, and it depicts a robot that physically could not strafe.
   * `corners` is [FL, FR, BL, BR] with +x forward and +y left, so the sign of px*py separates
   * the two diagonals exactly (the same test the X-drive branch uses).
   */
  const drawMecanumRollers = (px: number, py: number, len = 4.4, wid = 2.2): void => {
    const s = px * py >= 0 ? 1 : -1; // FL/BR -> "/", FR/BL -> "\\"
    ctx.save();
    ctx.translate(px, py);
    ctx.beginPath();
    ctx.rect(-len / 2, -wid / 2, len, wid);
    ctx.clip(); // the hatch is the wheel's tread — never let it bleed past the rim
    ctx.strokeStyle = 'rgba(200,214,230,0.55)';
    ctx.lineWidth = 0.34;
    const span = len + wid;
    for (let o = -span / 2; o <= span / 2; o += 1.15) {
      ctx.beginPath();
      ctx.moveTo(o - wid / 2, (-s * wid) / 2);
      ctx.lineTo(o + wid / 2, (s * wid) / 2);
      ctx.stroke();
    }
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
      drawWheel(px, py, ang, 'traction', 4.2, 1.8, '#1b212b');
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
    for (const [px, py] of corners)
      drawWheel(px, py, px * py >= 0 ? Math.PI / 4 : -Math.PI / 4, 'omni', Math.min(reach * 1.15, 7.5), 2.0, '#2b333e');
  } else if (r.spec.drivetrain === 'butterfly') {
    // BUTTERFLY: draw the set that is actually DOWN, and show the other one STOWED. The
    // deployed wheels are full-size and lit; the stowed set is a thin dim bar tucked just
    // inboard of them — so a glance tells you whether you have strafe or push right now.
    const tank = r.butterflyTank;
    for (const [px, py] of corners) {
      // stowed set: a slim inboard bar (lifted off the floor, so it reads as inert)
      ctx.save();
      ctx.translate(px - Math.sign(px) * 1.5, py);
      ctx.fillStyle = 'rgba(120,134,150,0.32)';
      ctx.fillRect(-1.7, -0.7, 3.4, 1.4);
      ctx.restore();
      // deployed set: traction wheels read SOLID, the mecanum set gets the real
      // alternating 45° roller hatch (same helper the mecanum drivetrain uses)
      drawWheel(px, py, 0, tank ? 'traction' : 'plain', undefined, undefined, tank ? '#39424f' : '#12171e');
      if (!tank) drawMecanumRollers(px, py);
    }
  } else {
    for (const [px, py] of corners) {
      // TANK runs traction wheels (tread, no strafe); mecanum's tread is its 45 degree rollers
      drawWheel(px, py, 0, r.spec.drivetrain === 'tank' ? 'traction' : 'plain');
      // MECANUM is the only remaining drivetrain with rollers; tank's traction wheels
      // stay plain, which is now a meaningful visual difference rather than an accident.
      if (r.spec.drivetrain === 'mecanum') drawMecanumRollers(px, py);
    }
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
