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
 * STILL A SHELL: robots are drivable + wall-contained and the ACCELERATORS, HOOKS,
 * RING STANDS and PARTICLE ZONE are placed/drawn. Scoring/particles/catalysts and
 * the Lab-Area / column-grid geometry are NOT implemented yet (exact field-zone
 * coordinates for the Particle Zone, Lab Areas, and Ring-Stand positions are still
 * needed — approximations below are FLAGGED).
 */

import type { ChainIntakeStyle, ChainScoreMode, RobotSpec, StartCat } from '../../types';

/** millimetres → inches (the sim's world unit) */
export const mm = (v: number): number => v / 25.4;

/** field half-extents (inches). Square 12'×12', walls at ±72 (like DECODE). */
export const CHAIN_HALF_X = 72;
export const CHAIN_HALF_Y = 72;

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
 * INTAKE DESIGN. The only style is the SWEEPER — a full-width roller. It MOUNTS on the FRONT
 * (default) or the LEFT+RIGHT SIDES (`RobotSpec.intakeSide`, a Front/Side selector like the
 * shooter mount). Geometry lives in `chainIntakeBand` (state.ts), shared by the capture AND the
 * renderer so the grab area IS the drawn intake. `widthFrac`·chassis +`overhang` = mouth
 * half-width; `depth` = how far behind the edge it reaches. Side mount's open flanks cost hopper
 * volume ⇒ lower storage (`CHAIN_STORE_SIDE_MULT`).
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
export const CHAIN_SCORE_MODES = ['turret', 'drum', 'dumper'] as const;
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
// the drum streams ~27 balls/s. `CHAIN_DRUM_INTERVAL` is the NOMINAL gap; it's set BELOW 1/27 s to
// counter the throughput lost to 60 Hz tick quantization + the symmetric jitter (each shot fires on
// the next tick past its due time, which rounds a sub-3-tick interval UP) — so the OBSERVED cadence
// lands at ~27/s while still varying naturally (measured, not a rigid uniform stream).
export const CHAIN_DRUM_INTERVAL = 1 / 37.5; // nominal gap → ~27 balls/s observed
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
export const CHAIN_STORAGE_MAX = 60; // ceiling: the control prism packs a bit over one layer
export const CHAIN_STORAGE_DEFAULT = 8;

/** Chain Reaction chassis LENGTH range (in). Unlike DECODE, CR's intake doesn't eat into an
 * 18" cube (the sweeper deploys), so a CR chassis can run the full 18" long. */
export const CHAIN_MIN_LENGTH = 10;
export const CHAIN_MAX_LENGTH = 18;
// effective sq in of chassis footprint per stored Particle — a 3"×3" ball hex-packs at ~8,
// then G03 EXPANSION (the deployed hopper reaches past the 18"×18" frame into the 18"×24"
// control prism) lets a full-frame launcher approach the ceiling: ~5.4 in²/ball → an 18×18
// open-hopper launcher tops out near 60.
export const CHAIN_STORE_AREA_PER_BALL = 5.4;
export const CHAIN_STORE_TURRET_MULT = 0.55; // turret loses center volume to the rotor+shooter
export const CHAIN_STORE_LAUNCHER_MULT = 1.0; // drum + dumper: open hopper (large, equal)
export const CHAIN_STORE_SIDE_MULT = 0.6; // SIDE intake: open flanks eat into the hopper ⇒ smaller

/** the MAX Particles this robot can hold — from its footprint × an archetype factor,
 * clamped to [MIN, MAX]. Turret is smallest; drum + dumper are equal and large; a SIDE
 * intake (open left/right flanks) holds fewer than a front sweeper. */
export function chainStorageMax(spec: RobotSpec): number {
  const area = spec.length * spec.width;
  const mode = spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE;
  let mult = mode === 'turret' ? CHAIN_STORE_TURRET_MULT : CHAIN_STORE_LAUNCHER_MULT;
  if (spec.intakeSide) mult *= CHAIN_STORE_SIDE_MULT;
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
export const CHAIN_FIRE_INTERVAL = 1 / 12; // nominal ~0.083 s → ~10.5 balls/s observed (deterministic;
// 60 Hz quantization + re-anchor-to-actual rounds the sub-6-tick interval UP, so 11 bps lands at 10.5)
export const CHAIN_SHOT_SPEED = 150; // in/s horizontal toward the mouth
export const CHAIN_SHOT_VZ = 70; // in/s initial upward (visual arc)

/** SHOOTING ON THE MOVE. A launched Particle inherits the CHASSIS velocity (real physics), so
 * the shooter must LEAD to compensate — and both archetypes CAN stay accurate while moving,
 * just via different mechanisms: a TURRET leads by turning its TURRET (turretHeading is offset
 * so muzzle+chassis velocity heads at the goal); a TURRETLESS drum/dumper leads by turning its
 * CHASSIS HEADING (`chainGoalAimHeading` returns the lead angle, so the whole robot points off-
 * goal by the lead). `leadDir` (play.ts) solves the projectile-lead angle. */

/** catalysts: auto-pick a nearby free catalyst (if not already carrying one); seat it
 * on a hook when carried near one. */
export const CHAIN_CATALYST_PICK_R = 9; // pick-up radius (to robot center)
export const CHAIN_HOOK_PLACE_R = 12; // seat-on-hook radius (carried catalyst → hook)

/** endgame: park fully inside a Lab-Area corner square (5 pt) / ascend within this
 * radius of a Ring Stand (100 pt). The SAME radius decides the AUTO descent: a robot
 * that STARTS on a stand and leaves this radius during auto scores descent (100 pt).
 * Lab squares are 24" at each field corner; an alliance owns the two on its side
 * (red x<0, blue x>0). APPROX — refine with manual. */
export const CHAIN_LAB = 24; // corner square size (in)
export const CHAIN_ASCEND_R = 9; // ascend proximity to a ring stand (in)

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
const LAB_C = CHAIN_HALF_X - CHAIN_LAB / 2; // 60" — a Lab square's centre coordinate
export const CHAIN_START_POSES: readonly ChainStartAnchor[] = [
  { name: 'LAB · TOP', pos: { x: LAB_C, y: LAB_C }, heading: Math.PI },
  { name: 'LAB · BOTTOM', pos: { x: LAB_C, y: -LAB_C }, heading: Math.PI },
  { name: 'RING STAND · TOP', pos: { x: CHAIN_RINGSTAND_XY, y: CHAIN_RINGSTAND_XY }, heading: Math.PI },
  { name: 'RING STAND · BOTTOM', pos: { x: CHAIN_RINGSTAND_XY, y: -CHAIN_RINGSTAND_XY }, heading: Math.PI },
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
  cat === 'close' ? 'TOP' : cat === 'far' ? 'BOTTOM' : '—';

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
 */
export const CHAIN_PRESETS: readonly RobotSpec[] = [
  {
    // long-range precision: turret shoots from anywhere, swerve + clearance to roam
    // over the beams
    name: 'Sniper', teamName: 'Turret · scores from anywhere', teamNumber: 0,
    length: 14.5, width: 17, intake: 'sloped', massLb: 24, drivetrain: 'swerve',
    driveRpm: 500, flywheelInertia: 0.2, canSort: false,
    ballStorage: 12, groundClearance: 1.3, scoreMode: 'turret', chainIntake: 'sweeper',
  },
  {
    // volume hauler: dumps a huge load at the wall, tank push + MAX storage + high
    // clearance to bulldoze over the beams
    name: 'Hauler', teamName: 'Dumper · haul & unload', teamNumber: 0,
    length: 15, width: 18, intake: 'sloped', massLb: 38, drivetrain: 'tank',
    driveRpm: 340, flywheelInertia: 0.2, canSort: false,
    ballStorage: 40, groundClearance: 1.5, scoreMode: 'dumper', chainIntake: 'sweeper',
  },
  {
    // the volume shooter: a chassis-wide drum firing 6 at once from anywhere, light mecanum
    name: 'Drummer', teamName: 'Drum · fast stream from anywhere', teamNumber: 0,
    length: 14.5, width: 17, intake: 'sloped', massLb: 25, drivetrain: 'mecanum',
    driveRpm: 470, flywheelInertia: 0.3, canSort: false,
    ballStorage: 24, groundClearance: 1.4, scoreMode: 'drum', chainIntake: 'sweeper',
  },
  {
    // fast wall-runner: a quick x-drive dumper that shuttles particles to its own
    // accelerator; low clearance keeps it off the beams (works its own quadrant)
    name: 'Skimmer', teamName: 'Dumper · fast wall runs', teamNumber: 0,
    length: 14.5, width: 16, intake: 'sloped', massLb: 22, drivetrain: 'xdrive',
    driveRpm: 520, flywheelInertia: 0.1, canSort: false,
    ballStorage: 26, groundClearance: 1.0, scoreMode: 'dumper', chainIntake: 'sweeper',
  },
] as const;
