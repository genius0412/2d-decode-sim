import type { DrivetrainType, RobotSpec, RobotState, Vec2, World } from '../../types';
import type { Rect } from '../../sim/field';
import { robotExtents, robotIntersectsRect, wheelContacts } from '../../sim/physics';
import { clamp, dcos, dsin } from '../../math';
import {
  CHAIN_BEAM_HEIGHT,
  CHAIN_BEAM_MOMENTUM_REF,
  CHAIN_BEAM_MOMENTUM_EASE,
  CHAIN_BEAM_MAX_RETAIN,
  CHAIN_BEAM_STRAFE_BLOCK_FWD,
  CHAIN_BEAM_WHEEL_R,
  CHAIN_BEAM_GROUND_FLOOR,
  CHAIN_CLEARANCE_DEFAULT,
  CHAIN_CLEARANCE_MAX,
  CHAIN_CLEARANCE_MIN,
  CHAIN_COG_PENALTY,
  CHAIN_COG_SWERVE_PENALTY,
  CHAIN_BEAM_LEN,
  CHAIN_HALF_X,
  CHAIN_HALF_Y,
} from './config';

/**
 * Chain Reaction BEAMS — four 1"-tall tubes of difficult terrain around the center.
 *
 * Crossing model (bespoke, PER-WHEEL, after the Rapier robot solve):
 *  • The ONLY hard gate is CLEARANCE: `groundClearance ≥ CHAIN_BEAM_HEIGHT`. If the
 *    frame can't clear the beam it's blocked like a wall (it can still drive
 *    ALONGSIDE — only the across-beam motion stops). Given clearance, EVERY drivetrain
 *    can cross — nothing is hard-blocked by wheel type.
 *  • The drag is decided WHEEL-BY-WHEEL, not by the chassis outline. A beam only bites
 *    while one of the robot's FOUR wheels is up on the 1" ridge (`wheelsOnBeam`), so a
 *    robot STRADDLING a beam (tube under the belly, all wheels on the floor) rolls free,
 *    and a straight crossing is felt as TWO bumps — front axle, then rear. Lifted wheels
 *    lose traction (`grounded = (4 − up)/4`), so more wheels on the ridge = harder, and
 *    all four up (high-centered) = barely any grip.
 *  • A mecanum STRAFING sideways into a beam does not climb it at all — its 45° rollers can't
 *    roll up a 1" tube, so it hits the near face like a CURB and stops (`beamStrafeBlock`, a
 *    post-solve positional clamp — the wheel rests at the face, the low frame overhangs, NO
 *    ooze onto the top). That path replaces the climbing drag whenever the crossing is strafe-
 *    dominant (`beamForwardness < CHAIN_BEAM_STRAFE_BLOCK_FWD`); a straighter push climbs over
 *    via the drag above. Mecanum ONLY — tank can't strafe, a swerve steers its pods into the
 *    travel direction, and an x-drive is 4-fold symmetric. So a mecanum must POINT AT a beam.
 *  • The clearance ↔ CoG tradeoff: more clearance eases beam crossing but raises the
 *    center of gravity ⇒ `cogFactor` scales down ALL drive authority (sluggish, tippy).
 *
 * The beams form the +x/−x/+y/−y AXES: each is 56" long, running IN from a field wall to
 * `INNER` (16" from centre). `axis` is a beam's NORMAL (the direction you cross it).
 */
export const BEAM_HALF_W = 0.5; // top-down half-width — a 1"-wide bar
const INNER = CHAIN_HALF_X - CHAIN_BEAM_LEN; // inner end = 72 − 56 = 16" from centre

export const CHAIN_BEAMS: { rect: Rect; axis: 'x' | 'y' }[] = [
  { rect: { x0: INNER, y0: -BEAM_HALF_W, x1: CHAIN_HALF_X, y1: BEAM_HALF_W }, axis: 'y' }, // +x axis
  { rect: { x0: -CHAIN_HALF_X, y0: -BEAM_HALF_W, x1: -INNER, y1: BEAM_HALF_W }, axis: 'y' }, // −x axis
  { rect: { x0: -BEAM_HALF_W, y0: INNER, x1: BEAM_HALF_W, y1: CHAIN_HALF_Y }, axis: 'x' }, // +y axis
  { rect: { x0: -BEAM_HALF_W, y0: -CHAIN_HALF_Y, x1: BEAM_HALF_W, y1: -INNER }, axis: 'x' }, // −y axis
];

/** how much across-speed a drivetrain keeps per tick climbing a beam (0..1). MECANUM is BEST:
 * it easily runs compliant/suspension wheels while keeping a LOW center of gravity, so it soaks
 * up the bump. Tank is close behind (grippy). SWERVE is worst — its tall steering pods ride high
 * (high CG) and scrub over the tube. X-drive sits between (omni rollers, low CG, but skittish). */
const TRACTION: Record<DrivetrainType, number> = {
  mecanum: 0.91,
  tank: 0.9,
  xdrive: 0.89,
  // BUTTERFLY: whichever set is down rides on the LIFT LINKAGE rather than a hard-mounted
  // axle, and the STOWED set sits high in the chassis — so it soaks up a 1" ridge worse than
  // either dedicated drivetrain, but its CG is still nowhere near swerve's tall pods.
  butterfly: 0.88,
  swerve: 0.87,
};

export function clearanceOf(spec: RobotSpec): number {
  return clamp(spec.groundClearance ?? CHAIN_CLEARANCE_DEFAULT, CHAIN_CLEARANCE_MIN, CHAIN_CLEARANCE_MAX);
}

/** drive-authority factor (≤1) from the raised center of gravity: more clearance ⇒
 * more sluggish. Applied to the drive command in chainStep. SWERVE is hit MUCH harder
 * (tall tippy modules) — its own big penalty on a squared curve, so a high-CG swerve is
 * way more sluggish than any other drivetrain. */
export function cogFactor(spec: RobotSpec): number {
  const frac = clamp((clearanceOf(spec) - CHAIN_CLEARANCE_MIN) / (CHAIN_CLEARANCE_MAX - CHAIN_CLEARANCE_MIN), 0, 1);
  if (spec.drivetrain === 'swerve') return 1 - CHAIN_COG_SWERVE_PENALTY * frac * frac;
  return 1 - CHAIN_COG_PENALTY * frac;
}

/** does the robot's frame clear a beam at all? (the only hard gate — clearance). */
export function canCrossBeams(spec: RobotSpec): boolean {
  return clearanceOf(spec) >= CHAIN_BEAM_HEIGHT;
}

/**
 * Fraction of the across-beam velocity KEPT this tick while a robot CLIMBS a beam (drives/
 * pushes across it). A beam ALWAYS slows you — even at full speed (`CHAIN_BEAM_MAX_RETAIN`
 * caps how much you can keep). Traction matters (tank/swerve climb best, mecanum a bit worse,
 * omni/x-drive slowest), a running start eases it only a LITTLE (`CHAIN_BEAM_MOMENTUM_EASE`),
 * and a raised center of gravity makes it a touch harder. Applied BEFORE the physics integration.
 *
 * `wheelsUp` (0..4) = how many wheels are perched on the ridge right now. The lifted wheels lose
 * traction, so the retain scales down toward `CHAIN_BEAM_GROUND_FLOOR` as more lift (all four =
 * high-centered, minimal grip). This is direction-agnostic — the special case of a mecanum
 * STRAFING into a beam is not a drag at all but a hard curb-stop (`beamStrafeBlock`).
 */
export function beamDragFactor(spec: RobotSpec, acrossSpeed: number, wheelsUp = 2): number {
  const clr = clearanceOf(spec);
  const base = clamp(TRACTION[spec.drivetrain] + 0.05 * (clr - CHAIN_BEAM_HEIGHT), 0.4, 0.98);
  const mom = clamp(Math.abs(acrossSpeed) / CHAIN_BEAM_MOMENTUM_REF, 0, 1);
  // beam-crossing CoG penalty scales with how HIGH the robot rides ABOVE the beam (its margin),
  // not its absolute clearance — a chassis that just clears (clr≈beam height) rides low and pays
  // nothing; a tall high-clearance one tips more. Keeps the default (clr=1) penalty-free.
  const margin = clamp((clr - CHAIN_BEAM_HEIGHT) / (CHAIN_CLEARANCE_MAX - CHAIN_BEAM_HEIGHT), 0, 1);
  // grounded wheels still push over the bump; lifted wheels cost traction (fewer grounded ⇒
  // closer to CHAIN_BEAM_GROUND_FLOOR). Never stalls a straight drive.
  const grounded = clamp((4 - clamp(wheelsUp, 0, 4)) / 4, 0, 1);
  const traction = CHAIN_BEAM_GROUND_FLOOR + (1 - CHAIN_BEAM_GROUND_FLOOR) * grounded;
  const retain = clamp((base + CHAIN_BEAM_MOMENTUM_EASE * (1 - base) * mom) * (1 - 0.1 * margin), 0.4, CHAIN_BEAM_MAX_RETAIN) * traction;
  return clamp(retain, 0, CHAIN_BEAM_MAX_RETAIN);
}

/** how many of the robot's four wheels are currently perched on this beam's 1" ridge — a wheel
 * whose contact point is within `CHAIN_BEAM_WHEEL_R` of the beam line (the rect grown by R). */
export function wheelsOnBeam(r: RobotState, rect: Rect): number {
  const R = CHAIN_BEAM_WHEEL_R;
  let n = 0;
  for (const w of wheelContacts(r)) {
    if (w.x >= rect.x0 - R && w.x <= rect.x1 + R && w.y >= rect.y0 - R && w.y <= rect.y1 + R) n++;
  }
  return n;
}

/** RENDER/AUDIO read-only. A wheel's terrain elevation 0..1: 1 while its contact sits over a beam's
 * 1" core, easing smoothly to 0 by `CHAIN_BEAM_WHEEL_R` past the edge — so as a wheel rolls across a
 * beam its z rises then falls (a real up-and-over bump). Max over the four beams. */
function wheelBeamZ(w: Vec2): number {
  const R = CHAIN_BEAM_WHEEL_R;
  let z = 0;
  for (const beam of CHAIN_BEAMS) {
    const r = beam.rect;
    let d: number;
    if (beam.axis === 'y') {
      if (w.x < r.x0 - R || w.x > r.x1 + R) continue; // past the beam's end
      d = Math.abs(w.y - (r.y0 + r.y1) / 2) - (r.y1 - r.y0) / 2; // distance PAST the near edge
    } else {
      if (w.y < r.y0 - R || w.y > r.y1 + R) continue;
      d = Math.abs(w.x - (r.x0 + r.x1) / 2) - (r.x1 - r.x0) / 2;
    }
    if (d <= 0) return 1; // over the core — fully up
    if (d >= R) continue;
    const t = 1 - d / R; // 1 → 0 across the wheel radius
    z = Math.max(z, t * t * (3 - 2 * t)); // smoothstep
  }
  return z;
}

/** RENDER/AUDIO read-only terrain ride for a robot: `lift` = mean wheel elevation (0..1, the body
 * bob), `pitch`/`roll` = front−rear / left−right elevation imbalance (the rock), `onCount` = wheels
 * currently up on a beam (edge-detected for the crossing SFX). Pure pose geometry — no sim state. */
export interface BeamRide {
  lift: number;
  pitch: number;
  roll: number;
  onCount: number;
}
export function beamRide(r: RobotState): BeamRide {
  const wc = wheelContacts(r); // [FL, FR, BR, BL] — 0,1 front · 2,3 rear · 0,3 left · 1,2 right
  const e = [wheelBeamZ(wc[0]), wheelBeamZ(wc[1]), wheelBeamZ(wc[2]), wheelBeamZ(wc[3])];
  return {
    lift: (e[0] + e[1] + e[2] + e[3]) / 4,
    pitch: (e[0] + e[1] - e[2] - e[3]) / 2,
    roll: (e[0] + e[3] - e[1] - e[2]) / 2,
    onCount: e.reduce((n, v) => n + (v > 0.5 ? 1 : 0), 0),
  };
}

/**
 * PRE-solve: slow a robot CLIMBING a beam (drag its across-beam velocity so it advances less
 * this tick), and WALL a mecanum strafing INTO a beam (clamp its inward velocity so the leading
 * wheel stops exactly at the near face — never overshoots onto the ridge). Applied before the
 * Rapier integration so it isn't wiped by the drivetrain re-setting velocity each tick.
 */
export function beamDrag(world: World, dt: number): void {
  for (const r of world.robots) {
    if (!canCrossBeams(r.spec)) continue; // no-clearance robots are hard-blocked instead
    for (const beam of CHAIN_BEAMS) {
      // a mecanum strafing INTO the beam is curb-walled (can't climb the ridge sideways): clamp
      // the inward velocity so the leading wheel stops at the near face instead of oozing on top.
      const curb = strafeCurb(r, beam);
      if (curb) {
        // max inward speed that still leaves the leading wheel at/above the near face this tick.
        // `lead` is the leading wheel's signed distance PAST the near face (>0 = still short of it).
        const allowIn = Math.max(0, curb.lead) / dt; // in/s toward the beam still permitted
        const vAcross = beam.axis === 'y' ? r.vel.y : r.vel.x;
        const inward = -curb.side * vAcross; // speed toward the beam (>0 = approaching)
        if (inward > allowIn) {
          const capped = -curb.side * allowIn; // clamp the across velocity to the permitted inward speed
          if (beam.axis === 'y') r.vel.y = capped;
          else r.vel.x = capped;
        }
        continue; // walled, not dragged
      }
      // PER-WHEEL gate: only drag while a wheel is actually up on the ridge. A robot straddling
      // the beam (all wheels on the floor, tube under the belly) rolls free even though its OBB
      // overlaps — so this is `wheelsOnBeam`, not `robotIntersectsRect`.
      const up = wheelsOnBeam(r, beam.rect);
      if (up === 0) continue;
      if (beam.axis === 'y') r.vel.y *= beamDragFactor(r.spec, r.vel.y, up);
      else r.vel.x *= beamDragFactor(r.spec, r.vel.x, up);
    }
  }
}

/** |chassis-forward · beam-cross-normal|: 1 = the robot points STRAIGHT across the beam
 * (driving over), 0 = it points ALONG the beam (crossing it means strafing sideways). */
export function beamForwardness(r: RobotState, axis: 'x' | 'y'): number {
  return Math.abs(axis === 'y' ? dsin(r.heading) : dcos(r.heading));
}

/** does this robot have MECANUM WHEELS on the floor right now? True for a mecanum chassis, and
 * for a BUTTERFLY that currently has its mecanum set down — the curb rule is about the physical
 * wheel (tiny 45° rollers can't climb a tube sideways), so it follows the deployed set, not the
 * build. A butterfly that drops its traction wheels stops being curbed, and also loses strafe
 * entirely (tank strafeMult 0), which is the honest tradeoff of the swap. */
function onMecanumWheels(r: RobotState): boolean {
  return r.spec.drivetrain === 'mecanum' || (r.spec.drivetrain === 'butterfly' && !r.butterflyTank);
}

/** a robot on MECANUM wheels whose crossing of this axis is strafe-dominant (points along the
 * beam more than across it) — it can't climb the ridge sideways, so it's curb-blocked, not dragged. */
function strafeBlocked(r: RobotState, axis: 'x' | 'y'): boolean {
  return onMecanumWheels(r) && beamForwardness(r, axis) < CHAIN_BEAM_STRAFE_BLOCK_FWD;
}

/**
 * The curb geometry for a mecanum strafing into a beam, or `null` when the beam is not a curb for
 * this robot right now — it isn't strafe-dominant, no wheel is near the ridge, or the robot is
 * STRADDLING the beam (a wheel well on the far side ⇒ it's placed on/drove across the tube, not
 * strafing into it — walling it would eject it, e.g. a launcher parked on the centre beam).
 *
 * `side` = the side the body sits on; `lead` = the LEADING wheel's signed distance short of the
 * near face along the crossing axis (>0 = still approaching, 0 = resting on the face, <0 = it has
 * crept onto the ridge and must be pushed back).
 */
function strafeCurb(r: RobotState, beam: { rect: Rect; axis: 'x' | 'y' }): { side: number; lead: number } | null {
  if (!strafeBlocked(r, beam.axis)) return null;
  const R = CHAIN_BEAM_WHEEL_R;
  const axisY = beam.axis === 'y';
  const cy = axisY ? (beam.rect.y0 + beam.rect.y1) / 2 : (beam.rect.x0 + beam.rect.x1) / 2;
  const edge = axisY ? (beam.rect.y1 - beam.rect.y0) / 2 : (beam.rect.x1 - beam.rect.x0) / 2;
  const bodyCoord = axisY ? r.pos.y : r.pos.x;
  const side = bodyCoord >= cy ? 1 : -1;
  let minRel = Infinity; // smallest = the leading wheel (closest to / over the beam)
  for (const w of wheelContacts(r)) {
    const alongOK = axisY
      ? w.x >= beam.rect.x0 - R && w.x <= beam.rect.x1 + R
      : w.y >= beam.rect.y0 - R && w.y <= beam.rect.y1 + R;
    if (!alongOK) continue;
    const cross = axisY ? w.y : w.x;
    const rel = side * (cross - cy); // + = same side as the body, − = the far side
    if (rel < -(edge + R)) return null; // a wheel WELL on the far side ⇒ straddling, don't wall
    if (rel < minRel) minRel = rel;
  }
  if (minRel === Infinity) return null; // no wheel within the beam's span
  // only a curb once the leading wheel is within a wheel-radius of the near face (else it's still
  // approaching in open floor and needs no clamp).
  if (minRel > edge + R) return null;
  return { side, lead: minRel - edge };
}

/**
 * POST-solve safety clamp for the strafe curb: if Rapier still nudged a leading wheel onto the
 * ridge (numerical slop past the pre-solve wall), push it back to the near face and zero the
 * inward velocity. Runs after the Rapier solve + `beamBlock`. Skips straddling robots (see
 * `strafeCurb`), so a launcher parked on a beam is never ejected.
 */
export function beamStrafeBlock(world: World): void {
  for (const r of world.robots) {
    if (!canCrossBeams(r.spec)) continue; // no-clearance frames are already walled by beamBlock
    for (const beam of CHAIN_BEAMS) {
      const curb = strafeCurb(r, beam);
      if (!curb || curb.lead >= 0) continue; // no wheel has crept past the near face
      const pen = -curb.lead; // how far the leading wheel is onto the ridge
      if (beam.axis === 'y') {
        r.pos.y += curb.side * pen;
        if (curb.side * r.vel.y < 0) r.vel.y = 0;
      } else {
        r.pos.x += curb.side * pen;
        if (curb.side * r.vel.x < 0) r.vel.x = 0;
      }
    }
  }
}

/**
 * POST-solve: a robot whose frame can't clear a beam is blocked like a wall — keep it on
 * the side it's on and stop its across-beam motion (it can still drive ALONGSIDE).
 */
export function beamBlock(world: World): void {
  for (const r of world.robots) {
    if (canCrossBeams(r.spec)) continue;
    const e = robotExtents(r);
    const rad = Math.max(e.half, (e.front + e.rear) / 2) + 0.5;
    for (const beam of CHAIN_BEAMS) {
      if (!robotIntersectsRect(r, beam.rect)) continue;
      if (beam.axis === 'y') {
        const bc = (beam.rect.y0 + beam.rect.y1) / 2;
        const bh = (beam.rect.y1 - beam.rect.y0) / 2;
        const side = r.pos.y >= bc ? 1 : -1;
        const limit = bc + side * (bh + rad);
        r.pos.y = side > 0 ? Math.max(r.pos.y, limit) : Math.min(r.pos.y, limit);
        if (side * r.vel.y < 0) r.vel.y = 0;
      } else {
        const bc = (beam.rect.x0 + beam.rect.x1) / 2;
        const bw = (beam.rect.x1 - beam.rect.x0) / 2;
        const side = r.pos.x >= bc ? 1 : -1;
        const limit = bc + side * (bw + rad);
        r.pos.x = side > 0 ? Math.max(r.pos.x, limit) : Math.min(r.pos.x, limit);
        if (side * r.vel.x < 0) r.vel.x = 0;
      }
    }
  }
}
