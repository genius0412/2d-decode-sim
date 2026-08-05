import type { Artifact, RobotState, Vec2, World } from '../../types';
import * as C from '../../config';
import { drawChassisBody, drawWheels, roundRect } from '../../render/drawRobot';
import {
  CHAIN_DEFAULT_SCORE_MODE,
  chainHopperCap,
  CHAIN_LAUNCH_LINE_FRAC,
  CHAIN_BEAM_RENDER_H,
  CHAIN_BEAM_RUMBLE,
  CHAIN_TWIN_BARREL_OFFSET,
  CHAIN_DEFAULT_CATALYST,
  CHAIN_CATAPULT_RANGE_MIN,
  CHAIN_CATAPULT_RANGE_MAX,
  chainCatalystGeom,
  chainCatapultRange,
  chainCatapultYaw,
  CHAIN_ARM_DRAW,
  CHAIN_CORNER_BODY_INSET,
} from './config';
import { catalystMouth, catalystTrackTarget, chainIntakeMouths } from './state';
import { EDGE_ANGLE, MOUNT_ANGLE, catalystMountOf, catalystMountPositions, edgeGeom, isEdgePos, isEndEdge, mountOrigin, shooterEdgeOf, turretLocal, turretRadius } from './mounts';
import { beamRide } from './beams';

/** cosmetic clock for the crossing shudder (render-only, so a wall clock is fine + deterministic-safe) */
const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : 0);

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
  screenUp: Vec2 = { x: 0, y: 1 },
  world?: World,
): void {
  const hl = r.spec.length / 2;
  const hw = r.spec.width / 2;
  const color = r.alliance === 'blue' ? C.COLORS.blue : C.COLORS.red;
  const loaded = r.hopper.length > 0;
  const mode = r.spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE;
  // the intake reads ACTIVE (green) whenever it can still collect — i.e. it's on (auto or the
  // held command) AND the hopper isn't full — not just when nearly empty.
  const intaking = (intakeOn || r.autoIntake) && r.hopper.length < chainHopperCap(r.spec);

  // TERRAIN RIDE: bob the chassis UP onto a beam it's crossing (toward screenUp), with a ground
  // shadow so the lift reads, plus a shudder while a wheel is mid-climb and the robot is moving.
  const ride = beamRide(r);
  const speed = Math.hypot(r.vel.x, r.vel.y);
  const climbing = ride.lift > 0.02 && ride.lift < 0.98;
  const rumble = climbing ? Math.sin(nowMs() * 0.05 + r.id * 1.7) * CHAIN_BEAM_RUMBLE * Math.min(1, speed / 20) : 0;
  const lift = Math.max(0, ride.lift * CHAIN_BEAM_RENDER_H + rumble);
  const ox = screenUp.x * lift;
  const oy = screenUp.y * lift;

  // ground shadow at the true footprint (drawn before the lifted body)
  if (lift > 0.15) {
    ctx.save();
    ctx.translate(r.pos.x, r.pos.y);
    ctx.rotate(r.heading);
    ctx.fillStyle = `rgba(0,0,0,${(0.3 * Math.min(1, ride.lift * 1.3)).toFixed(3)})`;
    roundRect(ctx, -hl, -hw, r.spec.length, r.spec.width, 1.6);
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  ctx.translate(r.pos.x + ox, r.pos.y + oy);
  ctx.rotate(r.heading);

  // chassis — the SHARED body (bumpers, deck, structure), so a robot is the same object in
  // both games. Its own contact shadow is suppressed while the robot is lifted onto a beam:
  // the terrain shadow above is already drawn at the true footprint, and two would read as
  // two robots.
  drawChassisBody(ctx, r, color, C.chassisFill(r.spec.chassisColor), lift <= 0.15);
  drawWheels(ctx, r, color);

  drawChainIntake(ctx, r, intaking);

  // scoring-archetype launcher (chassis-fixed part). Drum + catapult sit just inside the
  // MOUNTED edge — rotate the local frame to that edge and draw the same shape, so a
  // left/right mount spans the chassis LENGTH exactly as the sim launches it (`launchAt`).
  // The turret is drawn last, in the world frame, so it rotates independently.
  if (mode === 'drum' || mode === 'dumper') {
    const edge = shooterEdgeOf(r.spec); // turretless: always a side, never a corner/centre
    const g = edgeGeom(r.spec, edge);
    ctx.save();
    ctx.rotate(EDGE_ANGLE[edge]);
    if (mode === 'drum') drawDrum(ctx, g.dist, g.span, loaded);
    else drawCatapult(ctx, g.dist, g.span, loaded);
    ctx.restore();
  }

  drawCatalystMech(ctx, r, world);

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

  if (mode === 'turret' || mode === 'twinturret') drawTurret(ctx, r, loaded, ox, oy, mode === 'twinturret');
}

/** CR intake — the full-width sweeper roller, drawn on every MOUNTED edge (front, back, both
 * flanks, or both ends). Greens while intaking. The drawn bars ARE the grab area: each bar is
 * one `chainIntakeMouths` rect, the same rects `interact` captures with. */
function drawChainIntake(ctx: CanvasRenderingContext2D, r: RobotState, on: boolean): void {
  const barFill = on ? GREEN_DK : '#333a45';
  const tickFill = on ? GREEN : '#6b7280';

  for (const m of chainIntakeMouths(r.spec)) {
    // the roller bar fills the mouth rect from the frame out to the tip
    ctx.fillStyle = barFill;
    ctx.fillRect(m.x0, m.y0, m.x1 - m.x0, m.y1 - m.y0);

    // ROLLER TICKS along the outer lip, laid out across the mouth's long axis
    const end = isEndEdge(m.edge); // ends run across y, flanks along x
    const half = end ? (m.y1 - m.y0) / 2 : (m.x1 - m.x0) / 2;
    const n = Math.max(2, Math.round(half / 2.4));
    ctx.fillStyle = tickFill;
    for (let i = -n; i <= n; i++) {
      const t = (i * half) / (n + 0.5); // position along the edge
      if (end) {
        // tick sits just inside the outer lip (+x on front, −x on back)
        const x = m.edge === 'front' ? m.x1 - 1.2 : m.x0 + 0.1;
        ctx.fillRect(x, t - 0.65, 1.1, 1.3);
      } else {
        const y = m.edge === 'left' ? m.y1 - 1.2 : m.y0 + 0.1;
        ctx.fillRect(t - 0.65, y, 1.3, 1.1);
      }
    }
  }
}

/** chassis-wide flywheel DRUM: a FULL-WIDTH row of compliant rollers (the flywheels) across
 * the mounted edge — NOT a channelled drum. The rollers spin to intake AND launch. Greens when
 * loaded. Drawn in the MOUNT's frame (caller rotates): `dist` = distance out to that edge,
 * `span` = its half-length, so a flank mount spans the chassis length instead of its width. */
function drawDrum(ctx: CanvasRenderingContext2D, dist: number, span: number, loaded: boolean): void {
  const half = span * 0.96; // spans (nearly) the whole edge
  const th = 3.4; // roller-bar depth (into the frame)
  const cx = dist - th / 2 - 0.5;
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

/** chassis-wide CATAPULT: a wide bucket/paddle across the mounted edge the whole hopper is
 * flung from. Reads as a curved throwing lip. Greens when loaded. Drawn in the MOUNT's frame
 * (caller rotates) — see `drawDrum` for `dist`/`span`. */
function drawCatapult(ctx: CanvasRenderingContext2D, dist: number, span: number, loaded: boolean): void {
  const half = span * CHAIN_LAUNCH_LINE_FRAC;
  const back = dist - 6; // bucket floor, inside the frame
  const lip = dist - 1; // throwing lip near the shooter edge
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

/** turret on top (world orientation), ring + barrel toward the aim heading. `ox`/`oy` = the
 * chassis terrain-bob offset so the turret rides up with the body. */
function drawTurret(
  ctx: CanvasRenderingContext2D,
  r: RobotState,
  loaded: boolean,
  ox = 0,
  oy = 0,
  twin = false,
): void {
  const hl = r.spec.length / 2;
  const hw = r.spec.width / 2;
  const ring = turretRadius(r.spec);
  const reach = Math.min(Math.min(hl, hw) - 0.5, ring + 2.4);
  // WHERE IT IS BOLTED — the same `turretLocal` the sim launches from, so the ring is drawn
  // exactly where the Particle is born (see mounts.ts). A back/corner mount really does sit
  // back there rather than at a fixed rear-of-centre nudge.
  const local = turretLocal(r.spec);
  const cx = r.pos.x + Math.cos(r.heading) * local.x - Math.sin(r.heading) * local.y + ox;
  const cy = r.pos.y + Math.sin(r.heading) * local.x + Math.cos(r.heading) * local.y + oy;
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
  if (twin) {
    // TWO barrels straddling the centreline at the same offset the sim launches from,
    // so what you see is where the Particles actually come out.
    for (const s of [1, -1] as const) {
      ctx.fillRect(0, s * CHAIN_TWIN_BARREL_OFFSET - 0.85, reach, 1.7);
    }
  } else {
    ctx.fillRect(0, -1.2, reach, 2.4);
  }
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


/**
 * The CATALYST mechanism, drawn on its mounted edge in the robot frame so what you see is
 * where `catalystMouth` actually reaches from. Each archetype reads differently on sight:
 *  • arm      — a long thin arm with a claw at the tip (the reach specialist)
 *  • launcher — a low scoop at the edge plus a cocked throwing arm behind it
 *  • turret   — a pivot ring whose claw TRACKS the nearest hook, so it visibly swivels
 *    independently of the chassis (its whole perk is not needing to point the robot)
 */
function drawCatalystMech(ctx: CanvasRenderingContext2D, r: RobotState, world?: World): void {
  const type = r.spec.catalystType ?? CHAIN_DEFAULT_CATALYST;
  // A FRONTBACK swing is ONE arm on a pivot that rotates between the ends, so it is drawn at
  // the front — where it stows. Drawing it at both ends would read as two arms, which is
  // exactly what it isn't.
  const pos = catalystMountPositions(catalystMountOf(r.spec))[0];
  const o = mountOrigin(r.spec, pos);
  const carrying = false; // colour cue is driven by the ring sprite itself, drawn in draw.ts
  ctx.save();
  // move to where it is BOLTED (edge mid-point, or the actual corner) and point +x outward,
  // so every shape below is drawn from the frame outward regardless of mount
  ctx.translate(o.x, o.y);
  ctx.rotate(MOUNT_ANGLE[pos]);
  // a CORNER has only the diagonal behind it, so the body is drawn back along it (see
  // CHAIN_CORNER_BODY_INSET) — the reach origin above is unchanged
  if (!isEdgePos(pos)) ctx.translate(-CHAIN_CORNER_BODY_INSET, 0);
  const dist = 0; // the frame edge is the local origin now
  const ink = carrying ? GREEN : '#8a94a4';
  ctx.strokeStyle = ink;
  ctx.fillStyle = STEEL_DK;
  ctx.lineWidth = 0.55;

  if (type === 'arm') {
    // STOWED length — see CHAIN_ARM_DRAW. The grab radius is bigger (it counts the ring's
    // own radius) and the legal expansion bigger still, but neither is what the robot looks
    // like sitting on the tiles, which is what a top-down sprite should show.
    //
    // Built as a real mechanism rather than a line-with-a-vee: a pivot block at the frame,
    // a boom with actual width, and a two-finger claw whose jaws are curved and open.
    const reach = CHAIN_ARM_DRAW;
    const x0 = dist - 1.1;
    const tip = dist + reach;
    // pivot block at the frame edge
    ctx.fillStyle = STEEL_DK;
    ctx.fillRect(x0 - 0.9, -1.5, 1.9, 3);
    ctx.strokeRect(x0 - 0.9, -1.5, 1.9, 3);
    // boom — a tapered bar, not a hairline
    ctx.beginPath();
    ctx.moveTo(x0, -0.85);
    ctx.lineTo(tip - 0.4, -0.55);
    ctx.lineTo(tip - 0.4, 0.55);
    ctx.lineTo(x0, 0.85);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // claw: two curved jaws opening off the tip
    ctx.lineWidth = 0.62;
    for (const sgn of [1, -1] as const) {
      ctx.beginPath();
      ctx.moveTo(tip - 0.5, sgn * 0.5);
      ctx.quadraticCurveTo(tip + 0.7, sgn * 1.5, tip + 1.5, sgn * 0.85);
      ctx.stroke();
    }
    ctx.lineWidth = 0.55;
  } else if (type === 'launcher') {
    // the CLAW: a low scoop at the mounted edge (this is what grabs and places)
    ctx.beginPath();
    ctx.moveTo(dist - 0.4, -2.2);
    ctx.lineTo(dist + 1.9, -1.2);
    ctx.lineTo(dist + 1.9, 1.2);
    ctx.lineTo(dist - 0.4, 2.2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else {
    // TURRET: a pivot at the edge with a claw arm swivelled toward its NEAREST TARGET, so the
    // sprite shows the tracking this archetype is sold on.
    //
    // A target is a LOOSE RING or a HOOK, whichever is closer — a claw that stared past a ring
    // at its feet to track a hook across the field read as broken. Carried rings are excluded:
    // one is already in this claw (distance ~0, so it would lock the arm pointing at itself),
    // and another robot's ring is not something this one can take.
    const mouth = catalystMouth(r);
    const tgt = catalystTrackTarget(r, world);
    const bestA = tgt ? Math.atan2(tgt.y - mouth.y, tgt.x - mouth.x) : 0;
    ctx.beginPath();
    ctx.arc(dist - 0.8, 0, 2.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.save();
    ctx.translate(dist - 0.8, 0);
    // world aim → this local frame (chassis heading + the mount rotation already applied)
    ctx.rotate(bestA - r.heading - MOUNT_ANGLE[pos]);
    ctx.strokeStyle = GREEN;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(3.6, 0);
    ctx.moveTo(3.6, -0.9);
    ctx.lineTo(4.6, -0.3);
    ctx.moveTo(3.6, 0.9);
    ctx.lineTo(4.6, 0.3);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  // THE CATAPULT — its own fixed mounting yaw, independent of the claw's edge, and NOT
  // turreted: it throws wherever the chassis points plus this offset. Drawn as a throwing
  // arm whose LENGTH grows with the range it is built for, so a long-throw build reads as
  // a bigger machine.
  if (chainCatalystGeom(r.spec).fling) {
    const yaw = chainCatapultYaw(r.spec);
    const rng = chainCatapultRange(r.spec);
    const f = (rng - CHAIN_CATAPULT_RANGE_MIN) / (CHAIN_CATAPULT_RANGE_MAX - CHAIN_CATAPULT_RANGE_MIN);
    const arm = 3.4 + 3.2 * f;
    ctx.save();
    ctx.rotate(yaw);
    ctx.strokeStyle = '#c9a227'; // brass — reads as the throwing mechanism, not the claw
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(-1.5, 0);
    ctx.lineTo(arm, 0);
    ctx.stroke();
    ctx.beginPath(); // the cup at the tip
    ctx.arc(arm, 0, 1.5, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
    ctx.restore();
  }
}
