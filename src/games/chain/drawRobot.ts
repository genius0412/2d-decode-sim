import type { Artifact, RobotState, Vec2, World } from '../../types';
import * as C from '../../config';
import { roundRect } from '../../render/drawRobot';
import { drawChassisBody, drawWheels } from './parts';
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
  CHAIN_CLAW_SLEW,
  CHAIN_CORNER_BODY_INSET,
} from './config';
import { catalystMouth, catalystRailHalf, catalystTrackTarget, chainIntakeMouths } from './state';
import { EDGE_ANGLE, MOUNT_ANGLE, catalystDrawPos, catalystMountOf, catalystSwingOf, edgeGeom, intakeMouthFrame, isEdgePos, mountOrigin, shooterEdgeOf, turretLocal, turretRadius } from './mounts';
import { wrapAngle } from '../../math';
import { beamRide } from './beams';

/** cosmetic clock for the crossing shudder (render-only, so a wall clock is fine + deterministic-safe) */
const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : 0);

/**
 * CLAW SWIVEL, eased per robot. Same category as the shudder above: cosmetic, wall-clocked,
 * and outside the sim — a turret/rail claw's cone is a full circle, so this angle decides
 * nothing. Keyed by robot id; a stale entry costs one number and re-converges in a third of a
 * second, so nothing has to clean it up.
 */
const clawAim = new Map<number, { a: number; t: number }>();
function easeClaw(id: number, target: number): number {
  const t = nowMs();
  const prev = clawAim.get(id);
  if (!prev) {
    clawAim.set(id, { a: target, t });
    return target; // first sight of this robot: start aimed, never swing in from zero
  }
  const dt = Math.min(0.1, Math.max(0, (t - prev.t) / 1000)); // clamp a tab-switch gap
  const step = CHAIN_CLAW_SLEW * dt;
  const err = wrapAngle(target - prev.a);
  const a = Math.abs(err) <= step ? target : wrapAngle(prev.a + Math.sign(err) * step);
  clawAim.set(id, { a, t });
  return a;
}

/**
 * Chain Reaction robot sprite (top-down). Shares the chassis + drivetrain wheels with
 * DECODE (drawWheels/roundRect) but draws the CR-specific mechanisms so the build reads
 * at a glance: the full-width sweeper INTAKE at the front and the SCORING
 * ARCHETYPE launcher (turret on top · chassis-wide drum · chassis-wide catapult). A slim
 * hopper-fill bar shows how full it is. Front = robot +x (heading).
 */
const GREEN = '#22c55e';

/**
 * MECHANISM PALETTE.
 *
 * The mechanisms used to be drawn as flat SATURATED GREEN slabs — a green wall for the
 * intake, a green ring for the turret, a green wedge for the catapult — with that colour
 * carrying the "running / loaded" state across the whole part. Two problems: green is not
 * what any of these things is made of, and a filled slab has no internal structure, so a
 * robot read as a stack of coloured blocks rather than as a machine.
 *
 * So everything mechanical is now ALUMINIUM AND RUBBER, and colour stays where it means
 * something: the alliance on the chassis outline, and a thin GREEN accent on the part that
 * is actually running. Structure — plates, shafts, bearings, hubs, grooves — is what makes
 * a top-down sprite legible, not fill colour.
 */
const ALU = '#98a3b2'; // machined-edge highlight
const ALU_MID = '#5c6676';
const ALU_DK = '#39414f';
const RUBBER_LO = '#12161c'; // the shaded side of a roller
const RUBBER_HI = '#4a5464'; // its lit crown
const TAU = Math.PI * 2;

/** the status accent — a LINE on the live part, never a fill over the whole part */
const live = (on: boolean, alpha = 0.9): string =>
  on ? `rgba(34,197,94,${alpha})` : `rgba(190,205,220,${alpha * 0.55})`;

/**
 * A ROLLER seen from above: a cylinder lying along the local y axis, centred at local x `cx`.
 *
 * Drawn with a cross-axis GRADIENT (dark lip → lit crown → dark lip), because that shading is
 * the one cue that separates a cylinder from a rectangle in a top-down view, plus the
 * compliant FLAPS along its length and a bearing at each end. `spanHalf` is the barrel's
 * half-length, `dia` its diameter.
 */
function drawRoller(
  ctx: CanvasRenderingContext2D,
  cx: number,
  spanHalf: number,
  dia: number,
  on: boolean,
  flapEvery = 2.3,
): void {
  const rh = dia / 2;
  const g = ctx.createLinearGradient(cx - rh, 0, cx + rh, 0);
  g.addColorStop(0, RUBBER_LO);
  g.addColorStop(0.42, RUBBER_HI);
  g.addColorStop(0.75, '#2a3240');
  g.addColorStop(1, RUBBER_LO);
  ctx.fillStyle = g;
  roundRect(ctx, cx - rh, -spanHalf, dia, spanHalf * 2, rh * 0.85);
  ctx.fill();
  // compliant flaps — the angled lugs that actually drag a game piece in. Deliberately
  // FAINT: at 8 px/inch a bold hatch across a full-width roller turns into a barber pole
  // and swallows the shape it is meant to describe.
  ctx.strokeStyle = on ? 'rgba(34,197,94,0.34)' : 'rgba(190,205,220,0.22)';
  ctx.lineWidth = Math.min(0.18, rh * 0.22);
  const n = Math.max(3, Math.round((spanHalf * 2) / flapEvery));
  for (let i = 0; i < n; i++) {
    const y = -spanHalf + 0.45 + ((i + 0.5) * (spanHalf * 2 - 0.9)) / n;
    ctx.beginPath();
    ctx.moveTo(cx - rh * 0.6, y - 0.3);
    ctx.lineTo(cx + rh * 0.6, y + 0.3);
    ctx.stroke();
  }
  // bearings at both ends of the shaft
  ctx.fillStyle = ALU;
  for (const s of [1, -1] as const) {
    ctx.beginPath();
    ctx.arc(cx, s * (spanHalf - 0.1), Math.min(0.36, rh * 0.45), 0, TAU);
    ctx.fill();
  }
}

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

/**
 * CR intake — the full-width SWEEPER, drawn on every mounted edge (front, back, both flanks,
 * or both ends). The drawn mechanism IS the grab area: it fills exactly one
 * `chainIntakeMouths` rect, the same rect `interact` captures with.
 *
 * Built like the real thing rather than filled in like a paddle: two SIDE PLATES bolted to
 * the frame, an outer ROLLER on a shaft at the tip, an inner (transfer) roller at the frame
 * line when the mouth is deep enough, and the BELTS that link them running along the plates.
 * The throat between the plates stays OPEN — you can see the mat through it, which is what
 * an intake looks like from above and what makes it read as a mouth rather than a wall.
 */
function drawChainIntake(ctx: CanvasRenderingContext2D, r: RobotState, on: boolean): void {
  for (const m of chainIntakeMouths(r.spec)) {
    const f = intakeMouthFrame(m, r.spec.length / 2, r.spec.width / 2);
    const d = f.depth;
    const h = f.half;
    ctx.save();
    ctx.translate(f.ox, f.oy);
    ctx.rotate(f.rot);

    // polycarb floor — a HINT of a tray, not a slab. Only OUTSIDE the frame line: the part
    // of the mouth that reaches back inside the chassis is the chassis, and tinting it
    // washed out the alliance band it sat on. Faintly green while it can still collect,
    // which is the whole state the colour has to carry.
    ctx.fillStyle = on ? 'rgba(34,197,94,0.11)' : 'rgba(160,175,195,0.06)';
    ctx.fillRect(f.rail, -h, d - f.rail, h * 2);

    // SIDE PLATES: the two rails everything else is bolted between. They start at the frame
    // and run out to the tip, so the intake reads as bolted ON rather than floating.
    ctx.fillStyle = ALU_MID;
    ctx.strokeStyle = 'rgba(210,224,240,0.35)';
    ctx.lineWidth = 0.16;
    for (const s of [1, -1] as const) {
      const y = s > 0 ? h - 0.55 : -h;
      roundRect(ctx, f.rail - 0.6, y, d - f.rail + 0.6, 0.55, 0.2);
      ctx.fill();
      ctx.stroke();
    }

    const outer = d - 0.95; // roller axis, a shade inside the tip
    const inner = f.rail - 0.2; // transfer roller, right at the frame line
    const deep = d - f.rail > 2.2; // shallow mouths get one roller, not two crammed together

    // BELTS between the two rollers, run along the inside of each plate
    if (deep) {
      ctx.strokeStyle = 'rgba(190,205,220,0.22)';
      ctx.lineWidth = 0.18;
      for (const s of [1, -1] as const) {
        ctx.beginPath();
        ctx.moveTo(inner, s * (h - 0.78));
        ctx.lineTo(outer, s * (h - 0.78));
        ctx.stroke();
      }
      drawRoller(ctx, inner, h - 1.35, 0.8, on, 3.2);
    }
    drawRoller(ctx, outer, h - 0.75, 1.5, on);
    ctx.restore();
  }
}

/**
 * The chassis-wide DRUM.
 *
 * It is ONE CYLINDER running across (almost) the whole mounted edge, on a single shaft — not
 * a row of separate wheels, which is what it used to be drawn as and is a different machine.
 * A drum shooter is a barrel the Particles are pinched against, so what has to read from
 * above is: a continuous barrel with round shading, the SHAFT it turns on carried by a
 * bearing block at each end, the traction bands wrapped along its length, and the HOOD
 * plate behind it that everything is squeezed against on the way out.
 *
 * Drawn in the MOUNT's frame (the caller rotates): `dist` = distance out to that edge,
 * `span` = its half-length, so a flank mount spans the chassis LENGTH instead of its width.
 */
function drawDrum(ctx: CanvasRenderingContext2D, dist: number, span: number, loaded: boolean): void {
  const half = span * 0.9; // the barrel itself; the bearings take the last stretch
  const dia = 3.3; // drum diameter
  const cx = dist - dia / 2 - 0.55; // its axis, just inside the frame line

  // HOOD — the fixed plate the Particle is pinched against, behind the drum
  ctx.fillStyle = ALU_DK;
  roundRect(ctx, cx - dia / 2 - 1.15, -half - 0.5, 1.15, (half + 0.5) * 2, 0.35);
  ctx.fill();
  ctx.strokeStyle = 'rgba(200,214,230,0.28)';
  ctx.lineWidth = 0.16;
  ctx.stroke();

  // THE BARREL — round shading across the diameter is what says "cylinder" from above
  const g = ctx.createLinearGradient(cx - dia / 2, 0, cx + dia / 2, 0);
  g.addColorStop(0, '#161b23');
  g.addColorStop(0.38, RUBBER_HI);
  g.addColorStop(0.68, '#333b49');
  g.addColorStop(1, '#0f131a');
  ctx.fillStyle = g;
  roundRect(ctx, cx - dia / 2, -half, dia, half * 2, dia * 0.34);
  ctx.fill();

  // traction bands wrapped along the barrel — evenly spaced rings, drawn ACROSS it
  ctx.strokeStyle = 'rgba(190,205,220,0.26)';
  ctx.lineWidth = 0.16;
  const rings = Math.max(4, Math.round((half * 2) / 2.1));
  for (let i = 1; i < rings; i++) {
    const y = -half + (i * (half * 2)) / rings;
    ctx.beginPath();
    ctx.moveTo(cx - dia / 2 + 0.22, y);
    ctx.lineTo(cx + dia / 2 - 0.22, y);
    ctx.stroke();
  }
  // the lit crown line — one highlight down the length, the cheapest possible "this is round"
  ctx.strokeStyle = 'rgba(214,228,244,0.30)';
  ctx.lineWidth = 0.2;
  ctx.beginPath();
  ctx.moveTo(cx - dia * 0.09, -half + 0.3);
  ctx.lineTo(cx - dia * 0.09, half - 0.3);
  ctx.stroke();

  // BEARING BLOCKS + shaft stubs at both ends — a drum has to be held up by something
  for (const s of [1, -1] as const) {
    ctx.fillStyle = ALU_MID;
    roundRect(ctx, cx - 0.95, s * half - (s > 0 ? 0 : 1.5), 1.9, 1.5, 0.3);
    ctx.fill();
    ctx.fillStyle = ALU;
    ctx.beginPath();
    ctx.arc(cx, s * (half + 0.72), 0.42, 0, TAU);
    ctx.fill();
  }

  // LOADED: one thin line along the exit lip, where the Particle actually leaves
  ctx.strokeStyle = live(loaded, 0.6);
  ctx.lineWidth = 0.22;
  ctx.beginPath();
  ctx.moveTo(cx + dia / 2 - 0.14, -half + 0.6);
  ctx.lineTo(cx + dia / 2 - 0.14, half - 0.6);
  ctx.stroke();
}

/**
 * The chassis-wide CATAPULT (dumper).
 *
 * A real one is a TRAY on a pivot: the hopper sits in it, the whole tray rotates about a
 * shaft at the back, and the load leaves over the lip at the front. So that is what is drawn
 * — a pivot shaft with a hub at each end, two throwing arms running forward from it, a mesh
 * tray between them, and a heavy release lip. It used to be one filled trapezoid with a
 * bright outline, which read as a paper wedge stuck to the front of the robot.
 *
 * Drawn in the MOUNT's frame (the caller rotates) — see `drawDrum` for `dist`/`span`.
 */
function drawCatapult(ctx: CanvasRenderingContext2D, dist: number, span: number, loaded: boolean): void {
  const half = span * CHAIN_LAUNCH_LINE_FRAC;
  const pivot = dist - 7.4; // the shaft it swings about, well inside the frame
  const lip = dist - 0.9; // release lip at the shooter edge

  // TRAY floor — translucent, so it reads as something the load sits IN
  ctx.fillStyle = loaded ? 'rgba(180,200,220,0.10)' : 'rgba(160,175,195,0.06)';
  ctx.beginPath();
  ctx.moveTo(pivot, -half * 0.72);
  ctx.lineTo(lip, -half);
  ctx.lineTo(lip, half);
  ctx.lineTo(pivot, half * 0.72);
  ctx.closePath();
  ctx.fill();
  // the cross-ribs of the tray
  ctx.strokeStyle = 'rgba(190,205,220,0.18)';
  ctx.lineWidth = 0.16;
  for (let i = 1; i <= 3; i++) {
    const t = i / 4;
    const x = pivot + (lip - pivot) * t;
    const hy = half * (0.72 + 0.28 * t);
    ctx.beginPath();
    ctx.moveTo(x, -hy);
    ctx.lineTo(x, hy);
    ctx.stroke();
  }

  // THROWING ARMS — one down each side, pivot to lip
  ctx.strokeStyle = ALU_MID;
  ctx.lineWidth = 0.62;
  ctx.lineCap = 'round';
  for (const s of [1, -1] as const) {
    ctx.beginPath();
    ctx.moveTo(pivot, s * half * 0.72);
    ctx.lineTo(lip, s * half);
    ctx.stroke();
  }
  ctx.lineCap = 'butt';

  // PIVOT shaft + hubs: what the whole thing rotates about
  ctx.strokeStyle = ALU_DK;
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.moveTo(pivot, -half * 0.72);
  ctx.lineTo(pivot, half * 0.72);
  ctx.stroke();
  ctx.fillStyle = ALU;
  for (const s of [1, -1] as const) {
    ctx.beginPath();
    ctx.arc(pivot, s * half * 0.72, 0.45, 0, TAU);
    ctx.fill();
  }

  // RELEASE LIP — the heavy bar the load rolls over, and the only part that takes the accent
  ctx.fillStyle = ALU_MID;
  roundRect(ctx, lip - 0.45, -half, 0.9, half * 2, 0.3);
  ctx.fill();
  ctx.strokeStyle = live(loaded, 0.95);
  ctx.lineWidth = 0.3;
  ctx.beginPath();
  ctx.moveTo(lip + 0.4, -half + 0.2);
  ctx.lineTo(lip + 0.4, half - 0.2);
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

  // THE SLEW RING stays with the CHASSIS — the toothed ring is bolted to the frame and the
  // head turns on it, so drawing it inside the rotation made the whole assembly spin as one
  // piece, which is not how a turret works.
  ctx.fillStyle = ALU_DK;
  ctx.beginPath();
  ctx.arc(0, 0, ring, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = 'rgba(200,214,230,0.34)';
  ctx.lineWidth = 0.22;
  ctx.stroke();
  // gear teeth around the rim: the one detail that says "this rotates"
  ctx.lineWidth = 0.24;
  const teeth = Math.max(14, Math.round(ring * 6));
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * TAU;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * (ring - 0.32), Math.sin(a) * (ring - 0.32));
    ctx.lineTo(Math.cos(a) * ring, Math.sin(a) * ring);
    ctx.stroke();
  }

  // THE HEAD — everything below turns with `turretHeading`
  ctx.rotate(r.turretHeading);

  /** one shooter: a body, a pair of flywheels straddling the channel, and a hood */
  const barrel = (off: number): void => {
    const halfW = twin ? 1.05 : 1.35;
    // body / gearbox, from the ring out to the wheels
    ctx.fillStyle = ALU_MID;
    roundRect(ctx, -ring * 0.55, off - halfW, reach * 0.72 + ring * 0.55, halfW * 2, 0.35);
    ctx.fill();
    ctx.strokeStyle = 'rgba(210,224,240,0.30)';
    ctx.lineWidth = 0.16;
    ctx.stroke();
    // the CHANNEL the Particle runs down, cut through the body
    ctx.fillStyle = 'rgba(8,11,16,0.75)';
    ctx.fillRect(-ring * 0.2, off - halfW * 0.42, reach * 0.9, halfW * 0.84);
    // FLYWHEELS: a pair pinching the channel at the muzzle, drawn as the cylinders they are
    for (const s of [1, -1] as const) {
      const g = ctx.createLinearGradient(0, off + s * halfW * 0.45, 0, off + s * halfW * 1.15);
      g.addColorStop(0, RUBBER_HI);
      g.addColorStop(1, RUBBER_LO);
      ctx.fillStyle = g;
      roundRect(ctx, reach * 0.5, off + s * halfW * 0.45 - (s > 0 ? 0 : halfW * 0.7), 1.7, halfW * 0.7, 0.25);
      ctx.fill();
    }
    // MUZZLE: the two hood plates the Particle leaves between. An arc here read as a
    // claw — a pair of short plates reads as a barrel end, which is what it is.
    ctx.strokeStyle = 'rgba(210,224,240,0.45)';
    ctx.lineWidth = 0.26;
    for (const s of [1, -1] as const) {
      ctx.beginPath();
      ctx.moveTo(reach * 0.45, off + s * halfW * 0.9);
      ctx.lineTo(reach + 0.5, off + s * halfW * 0.62);
      ctx.stroke();
    }
    // the loaded accent sits AT the exit, one short bar across the channel
    ctx.strokeStyle = live(loaded, 0.95);
    ctx.lineWidth = 0.3;
    ctx.beginPath();
    ctx.moveTo(reach + 0.42, off - halfW * 0.5);
    ctx.lineTo(reach + 0.42, off + halfW * 0.5);
    ctx.stroke();
  };

  // a TWIN straddles the centreline at the same offsets the sim launches from, so what you
  // see is where the Particles actually come out
  if (twin) for (const s of [1, -1] as const) barrel(s * CHAIN_TWIN_BARREL_OFFSET);
  else barrel(0);

  // the indexer boss at the breech — where a Particle is fed up into the shooter
  ctx.fillStyle = loaded ? GREEN : ALU_DK;
  ctx.beginPath();
  ctx.arc(-ring * 0.28, 0, 0.52, 0, TAU);
  ctx.fill();
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
  roundRect(ctx, x, y, w, 1.15, 0.4);
  ctx.fill();
  if (frac > 0) {
    ctx.fillStyle = GREEN;
    roundRect(ctx, x + 0.16, y + 0.16, Math.max(0.5, (w - 0.32) * frac), 0.83, 0.3);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(150,163,180,0.45)';
  ctx.lineWidth = 0.22;
  roundRect(ctx, x, y, w, 1.15, 0.4);
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
  const pos = catalystDrawPos(catalystMountOf(r.spec), catalystSwingOf(r.spec));
  const o = mountOrigin(r.spec, pos);
  // Is this robot actually holding a ring? The ring SPRITE is drawn in draw.ts, but the
  // mechanism needs to know too — an arm's jaws close on what they are carrying, and a claw
  // drawn permanently open is the one state that never happens in a match.
  const carrying = (world?.chain?.catalysts ?? []).some((c) => c.carriedBy === r.id);
  ctx.save();
  // move to where it is BOLTED (edge mid-point, or the actual corner) and point +x outward,
  // so every shape below is drawn from the frame outward regardless of mount
  ctx.translate(o.x, o.y);
  ctx.rotate(MOUNT_ANGLE[pos]);
  // a CORNER has only the diagonal behind it, so the body is drawn back along it (see
  // CHAIN_CORNER_BODY_INSET) — the reach origin above is unchanged
  if (!isEdgePos(pos)) ctx.translate(-CHAIN_CORNER_BODY_INSET, 0);
  const dist = 0; // the frame edge is the local origin now
  ctx.strokeStyle = 'rgba(200,214,230,0.32)';
  ctx.fillStyle = ALU_DK;
  ctx.lineWidth = 0.55;

  if (type === 'arm') {
    // STOWED length — see CHAIN_ARM_DRAW. The grab radius is bigger (it counts the ring's
    // own radius) and the legal expansion bigger still, but neither is what the robot looks
    // like sitting on the tiles, which is what a top-down sprite should show.
    //
    // Built as a real mechanism: a SHOULDER the arm pivots on, a boom made of two
    // extrusions with a visible elbow joint, and a two-finger CLAW with grip pads. The jaws
    // CLOSE when it is carrying, so the sprite tells you whether it is holding a ring.
    const reach = CHAIN_ARM_DRAW;
    const x0 = dist - 1.1;
    const tip = dist + reach;

    // shoulder: a pivot boss on a mounting plate
    ctx.fillStyle = ALU_DK;
    ctx.strokeStyle = 'rgba(200,214,230,0.32)';
    ctx.lineWidth = 0.18;
    roundRect(ctx, x0 - 1.15, -1.7, 1.5, 3.4, 0.3);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x0 - 0.4, 0, 0.82, 0, TAU);
    ctx.fillStyle = ALU_MID;
    ctx.fill();
    ctx.stroke();

    // boom: upper extrusion to the elbow, then the forearm — two segments read as a linkage
    const elbow = x0 + (tip - x0) * 0.52;
    ctx.fillStyle = ALU_DK;
    ctx.beginPath();
    ctx.moveTo(x0 - 0.2, -0.82);
    ctx.lineTo(elbow, -0.66);
    ctx.lineTo(elbow, 0.66);
    ctx.lineTo(x0 - 0.2, 0.82);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(elbow, -0.62);
    ctx.lineTo(tip - 0.45, -0.5);
    ctx.lineTo(tip - 0.45, 0.5);
    ctx.lineTo(elbow, 0.62);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // elbow joint
    ctx.beginPath();
    ctx.arc(elbow, 0, 0.5, 0, TAU);
    ctx.fillStyle = ALU_MID;
    ctx.fill();
    ctx.stroke();

    // CLAW: two fingers off the wrist. Open when empty, closed on the ring when carrying —
    // a claw drawn permanently open is the one thing that never happens in a match.
    // WRIST: the jaws hang off a pivot, not off the end of a bar
    ctx.fillStyle = ALU_MID;
    ctx.beginPath();
    ctx.arc(tip - 0.35, 0, 0.46, 0, TAU);
    ctx.fill();
    ctx.stroke();
    const spread = carrying ? 0.5 : 0.95;
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = ALU;
    for (const sgn of [1, -1] as const) {
      ctx.beginPath();
      ctx.moveTo(tip - 0.3, sgn * 0.4);
      ctx.quadraticCurveTo(tip + 0.55, sgn * 1.1 * spread, tip + 1.15, sgn * 0.55 * spread);
      ctx.stroke();
      // grip pad on the inside of each finger — where it actually touches the ring
      ctx.strokeStyle = live(carrying, 0.9);
      ctx.lineWidth = 0.3;
      ctx.beginPath();
      ctx.moveTo(tip + 0.5, sgn * 0.82 * spread);
      ctx.lineTo(tip + 1.05, sgn * 0.55 * spread);
      ctx.stroke();
      ctx.strokeStyle = ALU;
      ctx.lineWidth = 0.5;
    }
    ctx.lineWidth = 0.55;
  } else if (type === 'launcher') {
    // the SCOOP: a low ground pickup — a sloped floor between two side plates with a
    // pickup roller across its lip. It used to be one filled trapezoid, which read as a
    // paper funnel taped to the frame rather than as something that picks a ring up.
    ctx.fillStyle = carrying ? 'rgba(34,197,94,0.13)' : 'rgba(160,175,195,0.07)';
    ctx.beginPath();
    ctx.moveTo(dist - 0.4, -2.2);
    ctx.lineTo(dist + 2.1, -1.15);
    ctx.lineTo(dist + 2.1, 1.15);
    ctx.lineTo(dist - 0.4, 2.2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = ALU_DK;
    ctx.strokeStyle = 'rgba(200,214,230,0.32)';
    ctx.lineWidth = 0.18;
    for (const sgn of [1, -1] as const) {
      ctx.beginPath();
      ctx.moveTo(dist - 0.4, sgn * 2.2);
      ctx.lineTo(dist + 2.1, sgn * 1.15);
      ctx.lineTo(dist + 2.1, sgn * 0.75);
      ctx.lineTo(dist - 0.4, sgn * 1.8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.save();
    ctx.translate(dist + 1.5, 0);
    drawRoller(ctx, 0, 1.0, 0.9, carrying, 1.4);
    ctx.restore();
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
    // AIM IN THE MOUNT'S OWN FRAME, so "no target" can mean STOWED (0 = pointing straight out
    // of its mount) rather than pointing at world +x — which, with the chassis rotation
    // subtracted below, would have swung an idle claw around as the robot turned.
    const aimTarget = tgt
      ? Math.atan2(tgt.y - mouth.y, tgt.x - mouth.x) - r.heading - MOUNT_ANGLE[pos]
      : 0;
    // swivel toward it at a finite rate rather than teleporting onto it (see `easeClaw`)
    const aim = easeClaw(r.id, aimTarget);

    /**
     * THE RAIL (type `rail` only). A linear track spanning the mounted side with a carriage
     * riding it. The carriage is drawn where the SIM put it (`r.catalystRail`, traversed at
     * a finite rate toward whatever the claw is working at) — it used to be pinned at the
     * centre, so the track was decoration and the claw always worked from one fixed spot.
     *
     * A plain `turret` claw has no track: it aims anywhere but stays bolted where it is,
     * which is the whole difference between the two builds.
     */
    const railed = (r.spec.catalystType ?? CHAIN_DEFAULT_CATALYST) === 'rail';
    const railHalf = railed ? catalystRailHalf(r.spec) : 0;
    const slide = railHalf * r.catalystRail; // along the edge, in the mount's local +y
    if (railed && railHalf > 0) {
      ctx.strokeStyle = '#6b7480';
      ctx.lineWidth = 0.42;
      ctx.beginPath(); // the rail itself, spanning the side
      ctx.moveTo(dist - 2.3, -railHalf);
      ctx.lineTo(dist - 2.3, railHalf);
      ctx.stroke();
      // end stops
      ctx.lineWidth = 0.7;
      for (const sgn of [1, -1] as const) {
        ctx.beginPath();
        ctx.moveTo(dist - 3.0, sgn * railHalf);
        ctx.lineTo(dist - 1.6, sgn * railHalf);
        ctx.stroke();
      }
    }

    // CARRIAGE on the rail (or the fixed pivot block for a plain turret), carrying the turret
    ctx.fillStyle = ALU_DK;
    ctx.strokeStyle = 'rgba(200,214,230,0.32)';
    ctx.lineWidth = 0.2;
    roundRect(ctx, dist - 3.1, slide - 1.5, 1.7, 3.0, 0.35);
    ctx.fill();
    ctx.stroke();

    // TURRET ring on the carriage — toothed, like the shooter's slew ring, so it reads as
    // something that rotates rather than a dot
    const ring = 2.0;
    ctx.beginPath();
    ctx.arc(dist - 0.8, slide, ring, 0, TAU);
    ctx.fillStyle = ALU_MID;
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = 0.34;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(dist - 0.8 + Math.cos(a) * ring, slide + Math.sin(a) * ring);
      ctx.lineTo(dist - 0.8 + Math.cos(a) * (ring + 0.42), slide + Math.sin(a) * (ring + 0.42));
      ctx.stroke();
    }

    // the CLAW on its short arm, swivelled to the tracked target
    ctx.save();
    ctx.translate(dist - 0.8, slide);
    // already in this local frame (chassis heading + mount rotation subtracted above)
    ctx.rotate(aim);
    ctx.strokeStyle = 'rgba(200,214,230,0.32)';
    ctx.lineWidth = 0.2;
    ctx.fillStyle = ALU_DK;
    ctx.beginPath(); // forearm
    ctx.moveTo(0, -0.6);
    ctx.lineTo(3.5, -0.45);
    ctx.lineTo(3.5, 0.45);
    ctx.lineTo(0, 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // two fingers, closed when it is carrying
    const spread = carrying ? 0.5 : 0.95;
    // wrist pivot, then the two fingers — same jaw as the arm's, so the two archetypes
    // read as the same hand on different mechanisms
    ctx.fillStyle = ALU_MID;
    ctx.beginPath();
    ctx.arc(3.35, 0, 0.42, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = 0.48;
    for (const sgn of [1, -1] as const) {
      ctx.strokeStyle = ALU;
      ctx.beginPath();
      ctx.moveTo(3.4, sgn * 0.4);
      ctx.quadraticCurveTo(4.25, sgn * 1.05 * spread, 4.8, sgn * 0.5 * spread);
      ctx.stroke();
      ctx.strokeStyle = live(carrying, 0.9);
      ctx.lineWidth = 0.28;
      ctx.beginPath();
      ctx.moveTo(4.15, sgn * 0.78 * spread);
      ctx.lineTo(4.7, sgn * 0.5 * spread);
      ctx.stroke();
      ctx.lineWidth = 0.48;
    }
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
    // BRASS, so it never reads as part of the claw: two side rails off a pivot boss, a
    // cross-brace, and a cradle at the tip. One bar with a hook on the end looked like a
    // spanner lying on the robot.
    ctx.fillStyle = '#8a6f1c';
    ctx.beginPath();
    ctx.arc(-1.5, 0, 0.62, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#c9a227';
    ctx.lineWidth = 0.34;
    for (const sgn of [1, -1] as const) {
      ctx.beginPath();
      ctx.moveTo(-1.5, sgn * 0.28);
      ctx.lineTo(arm - 0.3, sgn * 0.6);
      ctx.stroke();
    }
    ctx.lineWidth = 0.26;
    ctx.beginPath(); // cross-brace
    ctx.moveTo((arm - 1.5) * 0.45, -0.62);
    ctx.lineTo((arm - 1.5) * 0.45, 0.62);
    ctx.stroke();
    ctx.lineWidth = 0.42;
    ctx.beginPath(); // the cradle the ring rides in
    ctx.arc(arm, 0, 0.85, -Math.PI * 0.6, Math.PI * 0.6);
    ctx.stroke();
    ctx.restore();
  }
}
