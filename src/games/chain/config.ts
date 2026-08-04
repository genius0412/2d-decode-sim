/**
 * Chain Reaction (presented by goBILDA) — field + element constants.
 *
 * The 2026 Unofficial-FTC CAD-competition game. Values from the competition manual
 * (`cm.pdf` — its page streams are corrupt/unrenderable, so the numbers here come
 * from the manual PAGES the user supplied as images + explicit dimensions). mm are
 * converted to the sim's INCH world via `mm()` (÷25.4).
 *
 * Field: standard FTC 12'×12' (144") soft-tile field, origin at center, +x =
 * audience right, +y away from the audience. RED alliance = LEFT (columns A–C, from
 * the audience), BLUE = RIGHT (columns D–F).
 *
 * ── Terminology (manual §2–4) ──────────────────────────────────────────────
 *  • ACCELERATOR — the alliance goal: launch PARTICLES into it (1 pt each). Sits
 *    OUTSIDE each alliance's side wall (red left, blue right).
 *  • PARTICLE — a 3"-OD wiffle ball (300 of them). Launchable from ANYWHERE.
 *
 * ── Automation (manual §3.1) — particles are NEVER consumed ─────────────────
 *  The ACCELERATOR has an auto-score + REJECT system: a launched particle is
 *  counted (scores) then LAUNCHED BACK onto the field. Pre-match it distributes all
 *  300 particles across the field (randomization); during teleop it keeps
 *  re-distributing scored particles back out. So the field always holds ~300
 *  particles. The HOOK has its own auto-score confirming a Catalyst is seated and
 *  applying the +1 pt/particle bonus. (Implement this recycle loop when particles
 *  land — a particle entering the accelerator scores + respawns onto the field.)
 *  • CATALYST — a 6"-OD purple ring (4 of them). Placed on a HOOK ⇒ +1 pt/particle.
 *  • HOOK — on the accelerator wall (this file's `CHAIN_HOOK_Y`); holds a Catalyst.
 *  • RING STAND — a 22.5" vertical steel pole at the field corners; robots ASCEND
 *    (endgame, 100 pt) / DESCEND (auto, 100 pt) it.
 *  • LAB AREA — each alliance's start/park zone (leave 5 pt auto / park 5 pt endgame).
 *  • PARTICLE ZONE — the center diamond of white tape (neutral, unprotected).
 *
 * FULLY PLAYABLE + SCORED: particles (all 300, with pre-match randomization and the
 * accelerator score/recycle loop), the three shooter archetypes, catalysts/hooks,
 * ring-stand ascend/descend, Lab park, beam terrain, and the G05/G06 penalties are all
 * implemented. What is still OUTSTANDING is manual PRECISION, not features: a few
 * field-zone coordinates (Ring-Stand inset, Lab-Area size, Particle-Zone placement) were
 * derived from description rather than a figure — every one of those is FLAGGED `APPROX`
 * below. Refine those constants rather than inventing new ones.
 */

import type {
  ChainCatalystMount,
  ChainCatalystType,
  ChainIntakeMount,
  ChainIntakeStyle,
  ChainScoreMode,
  RobotSpec,
  StartCat,
} from '../../types';
import { intakeMountOf } from './mounts';

/** millimetres → inches (the sim's world unit) */
export const mm = (v: number): number => v / 25.4;

/** field half-extents (inches). Square 12'×12', walls at ±72 (like DECODE). */
export const CHAIN_HALF_X = 72;
export const CHAIN_HALF_Y = 72;

/**
 * PERIMETER CONTAINMENT. The real field is walled to `CHAIN_WALL_H` and then NETTED above
 * that, so nothing can leave play — a Catalyst thrown on a high arc hits the net and drops
 * back in rather than escaping.
 *
 * The two surfaces behave differently, which is the point of modelling them separately: the
 * rigid lower wall gives a real (if damped) rebound, while netting is slack and absorbs most
 * of the energy — a ring that hits the net barely comes back, it mostly just falls. That
 * makes a wild long throw self-punishing (your ring ends up dead against the perimeter)
 * without ever removing it from play.
 */
export const CHAIN_WALL_H = 12; // in — rigid wall below this, netting above
export const CHAIN_WALL_RESTITUTION = 0.3; // rigid wall: a modest bounce
export const CHAIN_NET_RESTITUTION = 0.12; // netting: slack, soaks up most of the energy
export const CHAIN_NET_VZ_KEEP = 0.25; // netting also kills most of the ring's climb

/** perimeter-wall build params (inner faces exactly at ±half) */
export const CHAIN_WALL_T = 10; // half-thickness, well outside the field

/**
 * ACCELERATORS — the alliance goals, OUTSIDE each side wall (red left x<0, blue
 * right x>0), directly adjacent and centered in y. `DEPTH` = protrusion out of the
 * wall (x); `WIDTH` = extent along the wall (y). Manual: 697.49752mm × 1393.65mm.
 */
export const CHAIN_ACCEL_DEPTH = mm(697.49752); // 27.4605" out of the wall (x)
export const CHAIN_ACCEL_WIDTH = mm(1393.65); // 54.8681" along the wall (y)
export const CHAIN_ACCEL_HALF_Y = CHAIN_ACCEL_WIDTH / 2; // 27.4341"

/**
 * HOOKS — on each accelerator wall at y = ±688.09375mm (both walls, both signs ⇒
 * four hooks total). A CATALYST placed on a hook multiplies that accelerator's
 * particle points. Manual value.
 */
export const CHAIN_HOOK_Y = mm(688.09375); // ±27.0903" along the wall

/**
 * ELEMENT specs (manual §4). Used when particles/catalysts are added.
 */
export const CHAIN_PARTICLE_R = 3 / 2; // 3" OD ball → 1.5" radius (300 on field)
export const CHAIN_CATALYST_OD = 6; // 6" OD ring, 1" thick (4 total)
export const CHAIN_RINGSTAND_H = 22.5; // vertical climb pole height (context only)
/**
 * RING STAND ASSEMBLY footprint. The stand is not a bare pole: the post is carried by a
 * plate that fills the field corner (see the CAD top-down), so the whole corner is SOLID and
 * a robot cannot drive into any of it. Modelled as a SQUARE flush with both walls — the
 * simplest shape that matches what is actually there, and it makes the corner a real
 * obstacle to path around rather than a pixel-thin post to clip.
 */
export const CHAIN_RINGSTAND_BOX = 12; // in — side of the corner square, flush to both walls
export const CHAIN_PARTICLE_COUNT = 300;
export const CHAIN_CATALYST_COUNT = 4;

/**
 * SCORING (manual §3) — for when scoring lands. Particle 1 pt; each Catalyst on a
 * hook adds +1 pt per particle scored in that accelerator; Ring-Stand descend 100 pt
 * (auto) / ascend 100 pt (endgame); Lab-Area leave 5 pt (auto) / park 5 pt (endgame).
 */
export const CHAIN_PTS = {
  particle: 1,
  catalystPerParticle: 1,
  ringStandDescend: 100,
  ringStandAscend: 100,
  labLeave: 5,
  labPark: 5,
} as const;

/** match timing (manual §2): 30 s auto, 120 s teleop, last 20 s = end game. */
export const CHAIN_AUTO_S = 30;
export const CHAIN_TELEOP_S = 120;
export const CHAIN_ENDGAME_S = 20;

/**
 * RING STANDS — vertical climb poles VERY CLOSE to each field corner (the purple-
 * ringed posts in the render). Small inset from the corner (per the user); refine
 * with exact manual coordinates. Four total: (±(72−inset), ±(72−inset)).
 */
export const CHAIN_RINGSTAND_INSET = 5; // APPROX — "very close to each corner"
export const CHAIN_RINGSTAND_XY = CHAIN_HALF_X - CHAIN_RINGSTAND_INSET; // 67"

/**
 * PARTICLE ZONE — the central diamond of WHITE tape (a rotated square, centered). The
 * manual gives its OUTER sides as 48" long; all tape is 1" wide. `CHAIN_DIAMOND_R` is the
 * half-diagonal (centre → vertex) of that outer diamond: side/√2 = 48/√2 ≈ 33.94".
 */
export const CHAIN_DIAMOND_SIDE = 48; // outer side length of the diamond (manual)
export const CHAIN_DIAMOND_R = CHAIN_DIAMOND_SIDE / Math.SQRT2; // ≈ 33.94" (centre → vertex)

/**
 * BEAMS — four 1"-tall × 1"-wide black tubes (difficult terrain) on the x/y axes. The manual
 * gives them as 56" LONG, running IN from each field wall toward the centre (so the inner end
 * is `CHAIN_HALF_X − 56 = 16"` from centre — they cross the particle-zone diamond). To drive
 * over one a robot needs `groundClearance ≥ CHAIN_BEAM_HEIGHT` and momentum; more clearance
 * eases it but RAISES the centre of gravity (`cogFactor`).
 */
export const CHAIN_BEAM_LEN = 56; // beam length, inches (manual) — from the wall inward
export const CHAIN_BEAM_HEIGHT = 1; // inches (tube height/width — 1" all round)
/** across-beam speed (in/s) at which MOMENTUM gives its full (small) easing */
export const CHAIN_BEAM_MOMENTUM_REF = 55;
/** how much a running start eases the climb (fraction of the gap to no-drag). Small — a beam
 * ALWAYS slows you down, even at high speed; momentum only helps a little (it no longer lets
 * you power over untouched). */
export const CHAIN_BEAM_MOMENTUM_EASE = 0.55;
/** hard ceiling on the per-tick across-speed KEPT on a beam — so even a full-speed crossing
 * sheds a real chunk of speed (a beam is always a noticeable bump). */
export const CHAIN_BEAM_MAX_RETAIN = 0.98;
/** ground-clearance slider (inches). Default just meets a 1" beam (0 margin). A robot below
 * the 1" beam height can't cross beams (blocked); the range spans a low-CG chassis (0.3") up
 * to a beam-clearing 1.5". */
export const CHAIN_CLEARANCE_MIN = 0.3;
export const CHAIN_CLEARANCE_MAX = 1.5;
export const CHAIN_CLEARANCE_DEFAULT = 1;
/** BEAM CROSSING is modeled PER WHEEL — a beam only drags a robot while one of its FOUR wheels
 * is actually perched on the 1" ridge (a wheel within `CHAIN_BEAM_WHEEL_R` of the beam line),
 * NOT merely because the chassis overlaps it. So a robot STRADDLING a beam (tube under the belly,
 * all four wheels on the floor) rolls free, and a perpendicular crossing is TWO distinct bumps
 * (front axle, then rear). The lifted wheels lose traction: `grounded = (4 − wheelsUp)/4` scales
 * the forward push down toward `CHAIN_BEAM_GROUND_FLOOR` (all four up = high-centered on the ridge
 * = barely any grip). */
export const CHAIN_BEAM_WHEEL_R = 2.5; // in — a wheel this close to the beam line is up on the ridge
export const CHAIN_BEAM_GROUND_FLOOR = 0.86; // forward traction kept with wheels lifted (never 0 — grounded wheels still push; raised 2026-08 alongside TRACTION so terrain bites less)
/** MECANUM STRAFE-INTO-BEAM is a WALL, not a drag. Real mecanum wheels climb a bump they DRIVE
 * straight at — the full-diameter wheel rolls over it and the suspension keeps all four loaded
 * (exactly why mecanum has the BEST forward beam traction). But STRAFING is a different mechanism:
 * the sideways force is the balanced sum of four 45° rollers, whose tiny outer diameter can't roll
 * up a 1" tube — so a mecanum strafing sideways into a beam behaves like driving sideways into a
 * CURB: the wheel butts the near face and STOPS. It does NOT climb on top and it does NOT go over.
 * `beamStrafeBlock` (a post-solve positional clamp) keeps the wheels off the ridge, resting at the
 * near face while the low frame overhangs the beam — NO velocity ooze onto the top. It engages
 * only when the crossing is strafe-dominant: `forwardness = |heading · crossNormal| <
 * CHAIN_BEAM_STRAFE_BLOCK_FWD` (a straighter push climbs over via `beamDrag` instead). Mecanum
 * ONLY — tank can't strafe, a SWERVE steers its pods into the travel direction (wheels roll over
 * the beam whichever way the chassis points), and an X-DRIVE is 4-fold symmetric. */
export const CHAIN_BEAM_STRAFE_BLOCK_FWD = 0.5; // below this forwardness a mecanum is walled off the beam
/** RENDER-ONLY beam "height": the 1" tube is invisibly short top-down, so the renderer EXAGGERATES
 * its z-thickness to this many world units (drawn as a raised extruded bar via `screenUp`). A robot
 * whose wheels are on the beam rides UP to this height, with a ground shadow, so you see + feel the
 * terrain. Cosmetic only — the physics footprint stays the flat 1" `CHAIN_BEAM_HEIGHT`. */
export const CHAIN_BEAM_RENDER_H = 1.3;
/** amplitude (world units) of the render-only chassis SHUDDER while a wheel is mid-climb + moving —
 * the visual "thunk/rumble" of crossing rough terrain. */
export const CHAIN_BEAM_RUMBLE = 0.7;
/** max fraction of drive authority lost at full clearance (raised center of gravity) */
export const CHAIN_COG_PENALTY = 0.16;
/** SWERVE is far more sensitive to a raised CG — the tall modules tip and scrub, so a
 * high-clearance swerve is WAY more sluggish than any other drivetrain (its own steep
 * penalty, applied on a squared curve so it bites hard as clearance climbs). */
export const CHAIN_COG_SWERVE_PENALTY = 0.6;

/** extra fit margin around the field when the camera scales it to the viewport.
 * Small because the camera bounds are widened to include the protruding goals. */
export const CHAIN_VIEW_MARGIN = 8;

/** the outer x half-extent the CAMERA must show so the protruding accelerators are
 * on screen (the WALLS/colliders stay at ±CHAIN_HALF_X — this is view-only). */
export const CHAIN_VIEW_HALF_X = CHAIN_HALF_X + CHAIN_ACCEL_DEPTH; // 99.46"

// ─────────────────────────────────────────────────────────────────────────────
// GAMEPLAY tuning (the playable model). The manual fixes the ELEMENT sizes/scoring
// above; these are sim feel/perf knobs chosen for a fun, smooth, deterministic game.
// ─────────────────────────────────────────────────────────────────────────────

/** how many particles the sim actually simulates. The real game has 300; bespoke
 * (non-Rapier) particle physics scales to it at 60 Hz. Conserved: ground + flight +
 * in-hoppers === this, always. */
export const CHAIN_PARTICLE_SIM = 300;

/** ground-particle physics (bespoke integrator + a spatial-hash separation pass so
 * particles never overlap — see `separateParticles`; scales to 300 cheaply) */
export const CHAIN_PART_FRICTION = 42; // in/s² rolling decay
export const CHAIN_PART_REST_SPEED = 1.5; // snap to rest below this
export const CHAIN_PART_WALL_REST = 0.35; // wall bounce restitution
export const CHAIN_PART_SEP_ITERS = 2; // overlap-resolution passes per tick

/** accelerator REJECT: a scored particle enters the accelerator, then the auto-score
 * system launches it BACK onto the field (visible). Tuned to land further out with
 * lots of variance — power (±), arc (±), and lateral spread all randomize per ball. */
export const CHAIN_EJECT_SPEED = 135; // in/s back into the field (base; ×0.75–1.45)
export const CHAIN_EJECT_VZ = 80; // in/s upward arc on the way out (base; ×0.75–1.45)
export const CHAIN_EJECT_SPREAD = 80; // in/s random lateral (y) spread — modestly narrow width-wise scatter

/**
 * INTAKE DESIGN. The only style is the SWEEPER — a full-width roller. Its MOUNT
 * (`RobotSpec.intakeMount`) picks which chassis edge(s) carry it: FRONT (default), BACK, both
 * SIDES, or FRONT+BACK. Geometry lives in `chainIntakeMouths` (state.ts) — one rect per mounted
 * edge, shared by the capture AND the renderer so the grab area IS the drawn intake, and by
 * `footprintExtents` so the mount moves the COLLISION box with it. `widthFrac`·chassis
 * +`overhang` = the mouth half-width on an END edge (a flank mouth spans the chassis length);
 * `depth` = how far behind the edge it reaches. Open edges cost hopper volume ⇒ lower storage
 * (`chainMountStoreMult`).
 */
export interface ChainIntakeGeom {
  widthFrac: number; // mouth half-width as a fraction of the chassis half-width
  overhang: number; // extra mouth half-width past the frame (deployed intake), inches
  depth: number; // mouth reaches this far BEHIND the edge (into the frame), inches
}
export const CHAIN_INTAKES: Record<ChainIntakeStyle, ChainIntakeGeom> = {
  sweeper: { widthFrac: 1.0, overhang: 0, depth: 2.5 }, // full-width roller
};
export const CHAIN_INTAKE_STYLES = ['sweeper'] as const;
export const CHAIN_DEFAULT_INTAKE: ChainIntakeStyle = 'sweeper';

/**
 * SCORING ARCHETYPES (`RobotSpec.scoreMode`) — the robot's expansion/scoring mechanism.
 * turret aims its own turret; drum + dumper are TURRETLESS chassis-wide launchers, so the
 * robot AIMS BY TURNING to face the goal (the fire button steers it) and fires a PARALLEL
 * LINE of Particles across its width. The tall Accelerator opening HANGS over the field, so
 * these can score from a stand-off distance (not point-blank).
 *  • turret — indexes + launches ONE Particle per `CHAIN_FIRE_INTERVAL` from anywhere.
 *  • drum   — a chassis-wide flywheel drum: fires up to `CHAIN_DRUM_MAX` (6 = 18/3) at once
 *    in a UNIFORM parallel line from ANY range; a burst every `CHAIN_DRUM_INTERVAL` (the
 *    drum re-indexes — realistically slower than a turret).
 *  • dumper — a chassis-wide catapult: flings the WHOLE hopper at once from LIMITED range
 *    (`CHAIN_DUMP_RANGE`); balls stored on opposite sides leave at DIFFERENT speeds
 *    (`CHAIN_DUMP_SIDE_VAR`) ⇒ real scatter (< 100% accuracy).
 */
export const CHAIN_SCORE_MODES = ['turret', 'twinturret', 'drum', 'dumper'] as const;

/**
 * TWIN TURRET — two shooters on one turret.
 *
 * THROUGHPUT (`CHAIN_TWIN_FIRE_MULT` 1.65, i.e. ~21.5 bps vs the single turret's 13):
 * deliberately NOT 2.0. Two barrels on ONE turret still share the parts that actually
 * gate a turret's rate — a single dye-rotor/indexer lifting Particles out of the hopper,
 * and a single aim solution. Doubling the barrels does not double the indexer, and
 * alternating between them costs a small handoff each cycle. 1.65 reads as "both barrels
 * firing, minus ~17% for indexer contention and alternation overhead", which lands it
 * clearly ahead of a single turret and clearly behind the drum's 24 bps stream.
 *
 * STORAGE (`CHAIN_STORE_TWIN_MULT` 0.42 vs the single turret's 0.55): a second flywheel,
 * its motor, and a second feed path all eat the centre volume the hopper wants — about a
 * quarter less than the already-cramped single turret.
 *
 * WEIGHT (`CHAIN_TWIN_MASS_FLOOR` +2.5 lb on the chassis mass FLOOR): one more flywheel
 * assembly — motor ~0.8 lb plus wheel, hood, and plate ~1.5 lb. Modest against a 20-42 lb
 * chassis, but it stacks with the drivetrain floor, so a twin turret can't be built at the
 * very lightest weights.
 *
 * The two barrels sit `CHAIN_TWIN_BARREL_OFFSET` either side of the turret centreline and
 * fire ALTERNATELY, so shots visibly leave from both — a real muzzle offset rather than
 * two sprites firing from the same point.
 */
export const CHAIN_TWIN_FIRE_MULT = 1.65;
export const CHAIN_STORE_TWIN_MULT = 0.42;
export const CHAIN_TWIN_MASS_FLOOR = 2.5; // lb added to the chassis mass floor
export const CHAIN_TWIN_BARREL_OFFSET = 1.5; // in — lateral spacing of the two muzzles
export const CHAIN_DEFAULT_SCORE_MODE: ChainScoreMode = 'turret';

/** turret slew rate (rad/s). The turret tracks the lead solution at THIS max rate — it follows
 * steady driving easily but CANNOT snap to a sudden velocity change (a shove), so shots fired
 * mid-correction fly along the stale heading and miss (aim is physical, not a guaranteed hit). */
export const CHAIN_TURRET_SLEW = 4;

// turretless-launcher aiming (drum + dumper turn the whole robot to face the goal)
export const CHAIN_AIM_TOL = 0.14; // rad heading error under which a turned shooter fires
export const CHAIN_AIM_GAIN = 4.5; // P-gain turning the robot toward the goal while firing
export const CHAIN_LAUNCH_LINE_FRAC = 0.92; // fraction of the chassis width the line spans
export const CHAIN_LAUNCH_Z0 = 10; // in — launch height (into the tall, over-field opening)

// DRUM: a CONTINUOUS flywheel across the chassis width, any range. It streams SINGLE
// Particles at a natural cadence — one every `CHAIN_DRUM_INTERVAL` (± jitter) while armed —
// each from a RANDOM lateral position across the drum, so the pattern FLOWS naturally and is
// NEVER a rigid uniform line. The launch SPEED is uniform (same-velocity, per the archetype);
// only the position + timing vary. NOT a "6-then-wait" burst.
export const CHAIN_DRUM_MAX = 6; // drum CAPACITY (18"/3" = 6 pockets) — the visual slot count
// the drum streams ~24 balls/s. `CHAIN_DRUM_INTERVAL` is the NOMINAL gap; it's set BELOW 1/24 s to
// counter the throughput lost to 60 Hz tick quantization + the symmetric jitter (each shot fires on
// the next tick past its due time, which rounds a sub-3-tick interval UP) — so the OBSERVED cadence
// lands at ~24/s while still varying naturally (measured, not a rigid uniform stream).
export const CHAIN_DRUM_INTERVAL = 1 / 30; // nominal gap → ~24 balls/s observed
export const CHAIN_DRUM_JITTER = 0.55; // ± fraction of the interval — natural, non-periodic cadence
export const CHAIN_DRUM_SPEED = 175; // in/s uniform horizontal launch

// DUMPER: whole-hopper catapult, limited (but not point-blank) range, side-var scatter
export const CHAIN_DUMP_RANGE = 56; // in — the tall opening hangs over the field: stand off
export const CHAIN_DUMP_INTERVAL = 0.8; // s recovery between full dumps
export const CHAIN_DUMP_SPEED = 150; // in/s base horizontal launch
export const CHAIN_DUMP_SIDE_VAR = 0.16; // ± speed variance across the catapult width (scatter)

// GOAL INTERIOR: a scored Particle keeps its momentum and BOUNCES around inside the goal box
// (off the back wall, side walls, and floor with restitution + friction), funneling toward the
// wall-side launcher, which then flings it back onto the field. NOT an instant eject.
export const CHAIN_FUNNEL_S = 1.4; // s MAX dwell inside the goal before a forced eject (safety)
export const CHAIN_FUNNEL_MIN = 0.2; // s MIN dwell — Particles jumble at least this long
export const CHAIN_GOAL_REST = 0.5; // restitution off the goal's inner walls + floor (bounce)
export const CHAIN_GOAL_FRICTION = 45; // in/s² horizontal decay as Particles jumble + settle
export const CHAIN_FUNNEL_DRIFT_ACC = 130; // in/s² drift toward the wall-side launcher
export const CHAIN_LAUNCHER_MARGIN = 5; // in of the wall (moving fieldward) ⇒ the launcher fires it

// MISSED shot: a Particle that misses the opening is retrieved by a HUMAN and thrown back
// into the field (FOR NOW — this rule may change) — tossed inward from the wall it hit
export const CHAIN_THROWBACK_SPEED = 72; // in/s inward toss (lands mid-field after friction)
export const CHAIN_THROWBACK_SPREAD = 45; // in/s lateral spread on the throw-in

/**
 * BALL STORAGE. The manual sets NO fixed particle-count limit: G01 lets a Robot Control an
 * UNLIMITED number of Particles; G02 only bounds them to an 18"×24"×18"-tall CONTROL PRISM
 * (and G03 lets the Robot EXPAND into that from its 18"×18"×18" start). So the practical MAX
 * is VOLUME-limited: a single layer of 3"-OD Particles across the 18"×24" control footprint
 * is 6×8 = 48 (`CHAIN_STORAGE_MAX`). We DERIVE each robot's max from its footprint × an
 * archetype factor (bigger chassis → more; a TURRET gives up center volume to its dye rotor +
 * shooter, so it's smallest; the DRUM and DUMPER are open-hopper launchers — equal, large),
 * clamped to that ceiling. The `ballStorage` slider picks any capacity up to `chainStorageMax`.
 */
export const CHAIN_STORAGE_MIN = 1;
// CEILING. The old 60 assumed roughly ONE layer of Particles across the control footprint.
// That was too pessimistic: the G02 control prism is 18" TALL and a Particle is 3" OD, so
// the height is not the binding constraint — hopper design is, and real hoppers stack. 90
// corresponds to about a layer and a half across the 18"×24" prism, which is what a
// well-packed open hopper actually manages.
export const CHAIN_STORAGE_MAX = 90;
export const CHAIN_STORAGE_DEFAULT = 12;

/** Chain Reaction chassis LENGTH range (in). Unlike DECODE, CR's intake doesn't eat into an
 * 18" cube (the sweeper deploys), so a CR chassis can run the full 18" long. */
export const CHAIN_MIN_LENGTH = 10;
export const CHAIN_MAX_LENGTH = 18;
// effective sq in of chassis footprint per stored Particle — a 3"×3" ball hex-packs at ~8,
// then G03 EXPANSION (the deployed hopper reaches past the 18"×18" frame into the 18"×24"
// control prism) lets a full-frame launcher approach the ceiling: ~5.4 in²/ball → an 18×18
// open-hopper launcher tops out near 60.
// effective sq in of chassis footprint per stored Particle. Lowered from 5.4 for the same
// reason the ceiling rose — 5.4 priced a single flat layer, and hoppers stack. 3.6 is that
// same packing at ~1.5 layers, which lifts EVERY archetype by ~50% while leaving all the
// relative tradeoffs (archetype factor × intake-mount factor) exactly where they were.
export const CHAIN_STORE_AREA_PER_BALL = 3.6;
export const CHAIN_STORE_TURRET_MULT = 0.55; // turret loses center volume to the rotor+shooter
export const CHAIN_STORE_LAUNCHER_MULT = 1.0; // drum + dumper: open hopper (large, equal)
// INTAKE MOUNT storage cost — every mounted edge is an OPENING the hopper can't use.
// front/back are mirror images (one open end), so a rear sweeper is a free stylistic choice;
// two mounts cost real volume. SIDE is the harshest: the flanks run the full chassis LENGTH
// (and on a wide-and-short CR chassis that's most of the perimeter), which is the price for
// collecting a stream you drive alongside. FRONTBACK opens two ENDS — a milder bite, and it
// buys collection in both drive directions.
export const CHAIN_STORE_SIDE_MULT = 0.6; // SIDE intake: open flanks eat into the hopper ⇒ smaller
export const CHAIN_STORE_FRONTBACK_MULT = 0.75; // FRONT+BACK: two open ends, less costly than flanks

/** extra lb on the chassis MASS FLOOR from the Chain Reaction scoring mechanism. Only the
 * twin turret carries one today (a whole second flywheel assembly); every other archetype
 * is already priced into the base chassis. Threaded into `massLimits` by coerceSpec and by
 * the builder's mass slider, so the floor the UI offers is the floor the sim enforces. */
export function chainMassFloorBump(spec: RobotSpec): number {
  const scoring = (spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE) === 'twinturret' ? CHAIN_TWIN_MASS_FLOOR : 0;
  // every robot carries SOME catalyst mechanism, so this is a differential cost between
  // the three archetypes rather than a tax on having one at all — the lightest (arm) is
  // the baseline a chassis is expected to carry.
  const catalyst = chainCatalystGeom(spec).massLb - CHAIN_CATALYSTS[CHAIN_DEFAULT_CATALYST].massLb;
  // a catapult built to throw further stores more energy: bigger spring, stouter frame
  const catapult = chainCatalystGeom(spec).fling ? catapultMassFor(chainCatapultRange(spec)) : 0;
  return scoring + catalyst + catapult;
}

/** the hopper-volume factor an intake mount costs (1 = no cost). */
export function chainMountStoreMult(mount: ChainIntakeMount): number {
  if (mount === 'side') return CHAIN_STORE_SIDE_MULT;
  if (mount === 'frontback') return CHAIN_STORE_FRONTBACK_MULT;
  return 1; // front / back — a single open end, mirror images of each other
}

/** the MAX Particles this robot can hold — from its footprint × an archetype factor × the
 * INTAKE MOUNT factor, clamped to [MIN, MAX]. Turret is smallest; drum + dumper are equal and
 * large; a SIDE intake (open flanks) holds fewest, FRONT+BACK is in between, and a lone
 * front/back sweeper costs nothing (`chainMountStoreMult`). */
export function chainStorageMax(spec: RobotSpec): number {
  const area = spec.length * spec.width;
  const mode = spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE;
  const mult =
    (mode === 'turret'
      ? CHAIN_STORE_TURRET_MULT
      : mode === 'twinturret'
        ? CHAIN_STORE_TWIN_MULT // a second shooter assembly eats even more centre volume
        : CHAIN_STORE_LAUNCHER_MULT) * chainMountStoreMult(intakeMountOf(spec));
  const cap = Math.round((area / CHAIN_STORE_AREA_PER_BALL) * mult);
  return Math.max(CHAIN_STORAGE_MIN, Math.min(CHAIN_STORAGE_MAX, cap));
}

/** the robot's ACTIVE hopper capacity: its chosen `ballStorage`, clamped to its
 * archetype+size max. Used by the sim (intake cap), renderer, and HUD. */
export function chainHopperCap(spec: RobotSpec): number {
  const want = Math.round(spec.ballStorage ?? CHAIN_STORAGE_DEFAULT);
  return Math.max(CHAIN_STORAGE_MIN, Math.min(chainStorageMax(spec), want));
}

/** shooter: launch a held particle toward this robot's own accelerator. Auto-aimed
 * at the mouth center, so (like DECODE's shooter) it reliably scores — arcade feel. */
export const CHAIN_FIRE_INTERVAL = 1 / 13; // 13 balls/s. The turret ACCUMULATES this interval
// (fireReadyAt += CHAIN_FIRE_INTERVAL, play.ts) instead of re-anchoring to world.time, so the
// sub-tick remainder carries and the long-run cadence averages EXACTLY 13 bps (a deterministic
// 4/5-tick gap alternation) — a plain re-anchor would tick-quantize to 12 or 15, never 13. An
// idle-guard (clamp to world.time when the hopper empties) prevents a burst catch-up on resume.
export const CHAIN_SHOT_SPEED = 150; // in/s horizontal toward the mouth
export const CHAIN_SHOT_VZ = 70; // in/s initial upward (visual arc)

/** SHOOTING ON THE MOVE. A launched Particle inherits the CHASSIS velocity (real physics), so
 * the shooter must LEAD to compensate — and both archetypes CAN stay accurate while moving,
 * just via different mechanisms: a TURRET leads by turning its TURRET (turretHeading is offset
 * so muzzle+chassis velocity heads at the goal); a TURRETLESS drum/dumper leads by turning its
 * CHASSIS HEADING (`chainGoalAimHeading` returns the lead angle, so the whole robot points off-
 * goal by the lead). `leadDir` (play.ts) solves the projectile-lead angle. */

/** LEGACY catalyst radii — the old one-size-fits-all grabber, measured from the robot
 * CENTRE with no facing requirement and no cycle time. Kept only as the reference the
 * per-archetype numbers below are calibrated against (the `arm` is the closest match).
 * Nothing reads these at runtime any more; `CHAIN_CATALYSTS` does. */
export const CHAIN_CATALYST_PICK_R = 9;
export const CHAIN_HOOK_PLACE_R = 12;

/**
 * CATALYST MECHANISMS — how a robot handles the rings.
 *
 * ONE CLAW does BOTH jobs on every archetype: it grabs a ring and it seats a ring on a
 * hook, so each mechanism has a single `reach` rather than separate grab/place radii.
 * Reach is measured from the mechanism's MOUTH (a point on the mounted chassis edge), not
 * the robot centre, so where you bolt it genuinely matters. `cone` is the half-angle
 * either side of that edge's outward normal it can work through (`Math.PI` = omni).
 * `cycle` is the cooldown between claw actions. `massLb` is added to the chassis mass FLOOR.
 *
 * What separates the three is NOT how far they can place — it is reach, facing, tempo, and
 * whether they can throw:
 *  • ARM — the reach specialist. A long arm out one edge: the biggest working radius, so it
 *    both grabs and seats from further back than anything else. Pays for it by having to
 *    FACE the target (a ±50° cone) and by being slow to extend and retract.
 *  • LAUNCHER — a short ground-intake claw PLUS a catapult. The claw is the shortest of the
 *    three (it scoops right at the edge) and does the grabbing and placing as usual. The
 *    CATAPULT is a separate trick: it FLINGS a carried ring far downfield to reposition it,
 *    and it is deliberately INACCURATE — see `CHAIN_FLING_*`. It is transport, not scoring.
 *  • TURRET — the convenience specialist. A claw on a rail + turret that tracks the nearest
 *    hook, so it works in ANY direction and never asks the driver to reorient, and it cycles
 *    fastest. Middling reach, and the heaviest of the three.
 *
 * WEIGHTS are all small in absolute terms (1.4-2.6 lb on a 20-42 lb chassis) — these are
 * claws and linkages, not drivetrains. The ORDER is what carries the balance: arm (bare
 * extrusion + a servo) < launcher (adds a catapult and its motor) < turret (adds a rail,
 * a turret ring, and a second motor).
 */
export interface ChainCatalystGeom {
  /** in — the CLAW's working radius, used for BOTH grabbing and seating (one claw does both) */
  reach: number;
  cone: number; // rad — half-angle either side of the mount's outward normal (PI = omni)
  cycle: number; // s — cooldown between claw actions
  massLb: number; // lb added to the chassis mass floor
  /** can this mechanism also FLING a carried ring downfield? (the catapult) */
  fling: boolean;
}
export const CHAIN_CATALYSTS: Record<ChainCatalystType, ChainCatalystGeom> = {
  // ARM raised 14 → 16: it is THE reach mechanism, and it should be unmistakably longer
  // than any intake (the longest intake preset reaches 5" past the frame).
  arm: { reach: 16, cone: 0.87, cycle: 0.9, massLb: 1.4, fling: false },
  // LAUNCHER raised 8 → 11. The 8" scoop was priced back when the catapult was (wrongly)
  // the long-range PLACER, so the claw was taxed to compensate. Now that the claw does the
  // grabbing and placing like everyone else's, that tax made it needlessly awkward — its
  // real costs are the weight, the slow cycle, and the narrow cone. Still the shortest of
  // the three, just no longer punishing.
  launcher: { reach: 11, cone: 0.61, cycle: 1.0, massLb: 2.0, fling: true },
  turret: { reach: 13, cone: Math.PI, cycle: 0.55, massLb: 2.6, fling: false },
};

/**
 * THE CATAPULT FLING (launcher only). Holding a ring with no hook in claw reach and pressing
 * the catalyst button THROWS it downfield instead of dropping it — the point is repositioning
 * a ring across the field without driving it there, NOT placing it.
 *
 * It is meant to be INACCURATE, so the landing spot is scattered three ways: the launch speed
 * varies ±`SPEED_VAR` (which moves the distance a lot, since both the airborne leg and the
 * ground slide scale with it), a random lateral kick up to ±`SPREAD`, and the ring then slides
 * to rest under friction. Typical throws land ~55-130" out along the catapult's facing — most
 * of a 144" field — with no promise about where exactly.
 */
/** the catapult's BUILD RANGE slider (inches) — the nominal distance it is built to throw.
 * A short-range build is light and re-cocks fast; a long one is heavier and slower. The
 * envelope reaches 170" so a maxed catapult can genuinely cross the 144" field — the point
 * of the mechanism is sending a ring somewhere far, not nudging it a tile away. */
export const CHAIN_CATAPULT_RANGE_MIN = 50;
export const CHAIN_CATAPULT_RANGE_MAX = 170;
export const CHAIN_CATAPULT_RANGE_DEFAULT = 110;
/** the catapult's fixed mounting YAW (degrees from chassis forward), in 15° steps. It is
 * NOT turreted, so this is a build-time choice and the chassis must be pointed to aim. */
export const CHAIN_CATAPULT_YAW_STEP = 15;
export const CHAIN_CATAPULT_YAW_DEFAULT = 0;

// Raised 110 → 150 so a throw is mostly FLIGHT rather than a long ground slide: at 110 a
// max-range throw was ~half air / half slide, which read as a shove rather than a launch.
// At 150 the hang time is ~0.78 s and roughly two thirds of the distance is airborne.
export const CHAIN_FLING_VZ = 150; // in/s upward (≈0.78 s hang time at GRAVITY 386)
export const CHAIN_FLING_SPEED_VAR = 0.4; // ± fraction — the dominant source of scatter
export const CHAIN_FLING_SPREAD = 20; // in/s random lateral kick
/** the minimum speed a ring is nudged with when it is evicted from under/on a robot, so it
 * always visibly SLIDES clear (and then decays under CHAIN_FLING_FRICTION) instead of being
 * snapped to the chassis edge. Deliberately SMALL: it only has to roll the ring out from
 * under the frame, not fire it away — at the old 26 in/s rings pinged off robots like
 * pinballs. A moving robot adds a little on top (see the eviction in play.ts). */
export const CHAIN_RING_SLIDE_MIN = 9;
export const CHAIN_FLING_FRICTION = 90; // in/s² ground decay once it lands

/**
 * The launch speed that makes a catapult throw land `range` inches away.
 *
 * A throw is an airborne leg plus a ground slide, and BOTH scale with the launch speed:
 *   range = v·t + v²/(2·friction),  t = 2·VZ/GRAVITY  (the hang time, fixed by the arc)
 * Solving that quadratic for v is what turns the builder's "how far does it throw" slider
 * into physics, instead of the slider secretly being the speed. The ±SPEED_VAR scatter is
 * applied to the RESULT, so a longer-range build is proportionally less precise too —
 * which is the right relationship (you cannot buy accuracy by buying range).
 */
export function catapultSpeedFor(range: number): number {
  const t = (2 * CHAIN_FLING_VZ) / 386; // GRAVITY; local so config stays dependency-free
  const a = 1 / (2 * CHAIN_FLING_FRICTION);
  // a·v² + t·v − range = 0
  return (-t + Math.sqrt(t * t + 4 * a * range)) / (2 * a);
}

/** lb added to the mass floor by a catapult built for `range` — more range means a bigger
 * spring/motor and a stouter frame to survive the recoil. Small in absolute terms (≤1.2 lb),
 * on top of the launcher mechanism's own weight. */
export function catapultMassFor(range: number): number {
  const f = (range - CHAIN_CATAPULT_RANGE_MIN) / (CHAIN_CATAPULT_RANGE_MAX - CHAIN_CATAPULT_RANGE_MIN);
  return 1.2 * Math.max(0, Math.min(1, f));
}

/** seconds to re-cock a catapult built for `range` — storing more energy takes longer, so
 * the long-throw build also throws less often. This is the main cost of buying range. */
export function catapultCycleFor(range: number): number {
  const f = (range - CHAIN_CATAPULT_RANGE_MIN) / (CHAIN_CATAPULT_RANGE_MAX - CHAIN_CATAPULT_RANGE_MIN);
  return 1.1 + 1.0 * Math.max(0, Math.min(1, f));
}

/** Within this distance of the mechanism's mouth the reach CONE does not apply — the ring
 * is already in the claw's grasp, so the angle it sits at is irrelevant. Without this, a
 * ring you had just driven onto (and so nudged slightly under the bumper, BEHIND the claw
 * line) would become ungrabbable, which is a real gameplay annoyance rather than a
 * meaningful constraint. The cone still governs everything further out. */
export const CHAIN_CATALYST_NEAR = 5;

export const CHAIN_CATALYST_TYPES = ['arm', 'launcher', 'turret'] as const;
export const CHAIN_DEFAULT_CATALYST: ChainCatalystType = 'arm';
export const CHAIN_DEFAULT_CATALYST_MOUNT: ChainCatalystMount = 'front';

/** the catapult's configured range (in), clamped + defaulted. */
export function chainCatapultRange(spec: RobotSpec): number {
  const r = spec.catapultRange;
  if (typeof r !== 'number' || !Number.isFinite(r)) return CHAIN_CATAPULT_RANGE_DEFAULT;
  return Math.max(CHAIN_CATAPULT_RANGE_MIN, Math.min(CHAIN_CATAPULT_RANGE_MAX, r));
}

/** the catapult's fixed mounting yaw in RADIANS (from chassis forward), clamped + defaulted. */
export function chainCatapultYaw(spec: RobotSpec): number {
  const y = spec.catapultYaw;
  const deg = typeof y === 'number' && Number.isFinite(y) ? Math.max(-180, Math.min(180, y)) : CHAIN_CATAPULT_YAW_DEFAULT;
  return (deg * Math.PI) / 180;
}

/** the catalyst mechanism's geometry for a spec (defaulted). */
export function chainCatalystGeom(spec: RobotSpec): ChainCatalystGeom {
  return CHAIN_CATALYSTS[spec.catalystType ?? CHAIN_DEFAULT_CATALYST];
}

/** endgame: park fully inside a Lab-Area corner square (5 pt) / ascend within this
 * radius of a Ring Stand (100 pt). The SAME radius decides the AUTO descent: a robot
 * that STARTS on a stand and leaves this radius during auto scores descent (100 pt).
 * Lab squares are 24" at each field corner; an alliance owns the two on its side
 * (red x<0, blue x>0). APPROX — refine with manual. */
// Lab-Area corner square (in). Raised 24 → 36 (both this and the Ring-Stand assembly were
// APPROX): the corner assembly occupies the outer 12" of every corner, and at 24" the L that
// was left over was only 12" wide — narrower than a legal chassis, so NO robot could start
// fully inside its own Lab Area without spawning inside a collider. 36" leaves a usable band
// beside the assembly, which is what makes G04 satisfiable at all. Refine with the manual.
export const CHAIN_LAB = 36;
// Ascend/descent proximity, measured to the CORNER ASSEMBLY (the solid square), not to the
// post inside it. Measuring to the box is what makes this stable: the robot can never be
// centred on the post, so post-distance would have to be a big fudge factor that also
// swallowed half the Lab Area. Box-distance means "your bumper is at the structure" — a
// robot pressed against it sits ~a half-extent away, comfortably inside 10".
export const CHAIN_ASCEND_R = 10;

/**
 * START POSITIONS (manual G04 — "Robots must begin the match completely in the Lab Area",
 * on the tile floor OR ascended on a Ring Stand). Each alliance owns the TWO Lab corners on
 * its side; a robot may also START already ascended on either corner Ring Stand. These named
 * anchors are CANONICAL for BLUE (goalSide +x) and MIRRORED (x→−x) for RED in `chainStartPose`.
 * All are legal by construction (inside a Lab square / on a Ring Stand) — the selector only
 * offers legal poses, so G04 always holds. Heading π faces the robot into the field.
 * A 2-robot alliance takes anchors 0 and 1 (the two distinct Lab corners) by default.
 */
export interface ChainStartAnchor {
  name: string;
  pos: { x: number; y: number };
  heading: number;
}
// The RING STAND anchors sit BESIDE the post, not on it — the post is solid now, so a robot
// centred on it would spawn inside a collider and be violently ejected. Offsetting inward
// along the diagonal by CHAIN_STAND_STANDOFF puts the bumper against the post, which is what
// "at the stand" physically means and what `onRingStand`'s radius accepts.
// Anchors are placed CLEAR of the solid corner assemblies (which occupy the outer
// CHAIN_RINGSTAND_BOX of every corner) and inside the walls. The RING STAND ones park
// alongside an assembly — close enough that `onRingStand` counts them (so a stand start
// still arms the auto-descent), without spawning inside a collider, which would eject the
// robot violently on tick one. Smoke asserts every anchor is collider-clear.
// Anchors are all FULLY inside a Lab-Area corner square (G04) AND clear of the solid corner
// assembly, which occupies the outer CHAIN_RINGSTAND_BOX of that same corner — the two
// constraints together leave an L-shaped band, and these are spread across it. The RING
// STAND pair parks alongside an assembly, close enough that `onRingStand` counts them (so a
// stand start still arms the auto-descent) without spawning inside the collider. Smoke
// asserts every anchor is in-zone, collider-clear, and armed/unarmed as intended.
// ORDER IS LOAD-BEARING: a 2-robot alliance defaults to anchors 0 and 1, so those must be
// the two plain FLOOR starts in opposite corners (not two ring-stand starts, which would
// arm both robots' auto-descent by default). Indices 2/3 stay the ring-stand pair, matching
// the long-standing convention the descent tests and the role split rely on.
export const CHAIN_START_POSES: readonly ChainStartAnchor[] = [
  { name: 'LAB · TOP', pos: { x: 47, y: 47 }, heading: Math.PI },
  { name: 'LAB · BOTTOM', pos: { x: 47, y: -47 }, heading: Math.PI },
  { name: 'STAND · TOP', pos: { x: 51, y: 58 }, heading: Math.PI },
  { name: 'STAND · BOTTOM', pos: { x: 51, y: -58 }, heading: Math.PI },
  { name: 'WALL · TOP', pos: { x: 61, y: 46 }, heading: Math.PI },
  { name: 'WALL · BOTTOM', pos: { x: 61, y: -46 }, heading: Math.PI },
];

/**
 * CR start ROLES are TOP / BOTTOM (which Lab corner a robot occupies) — NOT DECODE's
 * CLOSE / FAR. In a 2v2 each alliance member locks one corner so the two robots never
 * stack; the shared `StartCat` slots carry it (close = TOP corner y≥0, far = BOTTOM
 * corner y<0), so a locked role limits the selector to that corner's floor + ring-stand
 * anchors. `chainAnchorCat` classifies an anchor by its y sign; `chainDefaultIndex` is a
 * role's fallback anchor (its Lab-floor corner); `chainRoleLabel` is the UI label.
 */
export const chainAnchorCat = (index: number): StartCat =>
  (CHAIN_START_POSES[index]?.pos.y ?? 0) >= 0 ? 'close' : 'far';
export const chainDefaultIndex = (cat: StartCat): number => {
  const i = CHAIN_START_POSES.findIndex((_, idx) => chainAnchorCat(idx) === cat);
  return i >= 0 ? i : 0;
};
export const chainRoleLabel = (cat: StartCat | undefined): string =>
  cat === 'close' ? 'TOP' : cat === 'far' ? 'BOTTOM' : '-';

/**
 * PRE-MATCH FIELD RANDOMIZATION (manual §"auto-score and reject" — the Accelerators launch all
 * 300 Particles back onto the field to randomize it before the Match). We STAGE half the
 * Particles inside each alliance goal and the launcher flings them out one-by-one during the
 * pre-match window: `CHAIN_PRELAUNCH_PER_TICK` Particles leave EACH goal every tick until the
 * goal is empty (~2.5 s to clear 150 at 60 Hz), scattering across the field. Deterministic
 * (world RNG picks each launch's target). See `prematchRandomize` in play.ts.
 */
export const CHAIN_PRELAUNCH_PER_TICK = 1; // Particles ejected per goal per tick during randomization
export const CHAIN_PRELAUNCH_SPEED = 150; // in/s base horizontal eject speed (± random)
export const CHAIN_PRELAUNCH_VZ = 95; // in/s base upward arc on the way out (± random)

/**
 * PENALTIES (manual §3.3, in `penalties.ts`). Manual severities: G05/G06 are MAJORs. We reuse
 * the shared `PTS_FOUL_MINOR/MAJOR` point values. G01–G04 (control/expansion/start limits) are
 * structurally enforced by the sim, G07 (de-scoring) is legal, and G02's plowing, G08's vague
 * "prolonged restriction", and G09 (accelerator-exit obstruction) are intentionally NOT modeled.
 */
export const CHAIN_FOUL_SLOP = 1; // in of bumper slack for the robot-robot contact test

/**
 * CHAIN REACTION ROBOT PRESETS — archetype cards for the CR builder (parallel to
 * DECODE's `ROBOT_PRESETS`). Each is a full, legal `RobotSpec` bundling a scoring
 * archetype + intake design + a matched drivetrain/mass/rpm/storage/clearance loadout,
 * so a single click sets a coherent playstyle. All numbers are within the shared
 * coerceSpec ranges (so applying one is a no-op through the coercer and the card
 * highlights as selected). `name`/`teamName` describe the archetype (no team number).
 *
 * MOUNTS: every preset picks the intake/shooter EDGES that its playstyle actually wants,
 * so the four cards between them demonstrate all of them. The mount is never decoration —
 * each one below buys a specific driving habit, and (for `side`/`frontback`) pays for it in
 * hopper volume via `chainMountStoreMult`, which is why their storage numbers are lower.
 * Every `ballStorage` here must stay ≤ that build's `chainStorageMax`, or coerceSpec clamps
 * it and the card stops highlighting as selected — smoke asserts this.
 */
export const CHAIN_PRESETS: readonly RobotSpec[] = [
  {
    // long-range precision: turret shoots from anywhere, swerve + clearance to roam over
    // the beams. MOUNT: a turret is top-mounted and aims itself, so the chassis never has
    // to face the goal — which is exactly the build that can afford a FRONT+BACK sweeper
    // and collect while driving in either direction. It pays ~25% of the hopper for that.
    name: 'Sniper', teamName: 'Turret · shoots and collects any direction', teamNumber: 0,
    length: 14.5, width: 17, intake: 'sloped', massLb: 24, drivetrain: 'swerve',
    driveRpm: 500, flywheelInertia: 0.2, canSort: false,
    ballStorage: 12, groundClearance: 1.3, scoreMode: 'turret', chainIntake: 'sweeper',
    intakeMount: 'frontback', shooterMount: 'front',
  },
  {
    // volume hauler: dumps a huge load at the wall, tank push + MAX storage + high
    // clearance to bulldoze over the beams. MOUNT: a REAR catapult means the whole cycle
    // is one straight line — drive forward to fill the hopper, reverse into range, dump.
    // No turning around at either end. Two end mounts on opposite edges cost NO storage
    // (front and back are mirror images), so it keeps the biggest hopper in the set.
    name: 'Hauler', teamName: 'Dumper · fill forward, reverse and unload', teamNumber: 0,
    length: 15, width: 18, intake: 'sloped', massLb: 38, drivetrain: 'tank',
    driveRpm: 340, flywheelInertia: 0.2, canSort: false,
    ballStorage: 40, groundClearance: 1.5, scoreMode: 'dumper', chainIntake: 'sweeper',
    intakeMount: 'front', shooterMount: 'back',
  },
  {
    // the volume shooter: a chassis-wide drum streaming from anywhere, light mecanum.
    // MOUNT: SIDE sweepers turn a mecanum's strafe into the collection tool — slide
    // sideways along a line of particles and hoover it up with the flank rollers, then
    // face the goal and stream. The open flanks are the harshest storage cost (0.6).
    name: 'Drummer', teamName: 'Drum · strafe-collect, stream from anywhere', teamNumber: 0,
    length: 14.5, width: 17, intake: 'sloped', massLb: 25, drivetrain: 'mecanum',
    driveRpm: 470, flywheelInertia: 0.3, canSort: false,
    ballStorage: 24, groundClearance: 1.4, scoreMode: 'drum', chainIntake: 'sweeper',
    intakeMount: 'side', shooterMount: 'front',
  },
  {
    // fast wall-runner: a quick x-drive dumper working its own quadrant; low clearance
    // keeps it off the beams. MOUNT: an x-drive strafes as fast as it drives, so a
    // BROADSIDE catapult lets it run the wall and fire sideways WITHOUT ever turning —
    // the launch line then spans the chassis LENGTH, not its width.
    name: 'Skimmer', teamName: 'Dumper · run the wall, fire broadside', teamNumber: 0,
    length: 14.5, width: 16, intake: 'sloped', massLb: 22, drivetrain: 'xdrive',
    driveRpm: 520, flywheelInertia: 0.1, canSort: false,
    ballStorage: 26, groundClearance: 1.0, scoreMode: 'dumper', chainIntake: 'sweeper',
    intakeMount: 'front', shooterMount: 'right',
  },
] as const;
