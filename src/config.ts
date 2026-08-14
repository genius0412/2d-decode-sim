import type { RobotSpec } from './types';

/**
 * Single source of truth for all field geometry, physics constants, and
 * scoring values. Units: inches, seconds, radians. Field frame: origin at
 * field center, +x = audience's right, +y = away from the audience.
 *
 * Layout verified against the DECODE Competition Manual Section 9 figures:
 * Red Wall = left (x=-72), Blue Wall = right (x=+72); BLUE goal far-LEFT
 * corner, RED goal far-RIGHT corner (cross-court from their drive teams).
 * See src/sim/field.ts for the geometry helpers.
 */

export const FIELD_HALF = 72; // 144 x 144 in field
export const TILE = 24;
export const TAPE_W = 1;

// ---------------------------------------------------------------- match ----
export const AUTO_DURATION = 30;
export const TRANSITION_DURATION = 8;
export const TELEOP_DURATION = 120;
/** END GAME: the final stretch of TELEOP (warning cue + HUD urgency) */
export const ENDGAME_START = 20; // s left in teleop
/** announcer countdown after pressing start ("Match begins in" + 3,2,1) */
export const PRE_COUNTDOWN = 4;
/** delay from match end (phase 'post') to the "match_result" fanfare/whoosh.
 * The results screen holds its score reveal until this exact moment so the
 * count-up + winner slam land on the whoosh. Shared by the audio (game.ts) and
 * the reveal animation (GameView). */
export const MATCH_RESULT_REVEAL_MS = 2800;
/** seconds the SERVER keeps stepping the sim in phase 'post' before it captures
 * the authoritative final score + saves the record — long enough for balls still
 * flowing down the ramp/gate to settle and score. Matched to the reveal delay so
 * the number saved to the leaderboard is exactly the one shown at the whoosh. */
export const MATCH_SETTLE_S = MATCH_RESULT_REVEAL_MS / 1000;

// --------------------------------------------------------------- season ----
/** Balance / season version. Leaderboards (Phase 3) are keyed to this: it is
 * bumped DELIBERATELY on a gameplay-affecting balance change (any physics or
 * scoring constant below that would move a record's score), which starts a
 * fresh ranked season and archives the previous one. Every record + replay is
 * stamped with the value in effect when it was set, because a deterministic
 * input-log replay only re-simulates to the same score under the exact sim
 * build that produced it. Do NOT auto-derive this from a file hash — that would
 * reset every season on a trivial, non-gameplay edit. See docs/netcodeplan.md
 * Phase 3 + the phase3-leaderboards spec. */
export const BALANCE_VERSION = 3; // 2: real-motor drivetrain retune (torque–speed curve + mecanum losses)
// 3: swerve wobble ↓ + faster turning (REF_TURN 8.5 / cap 12) + tank control-style at input layer
// Bumping this INVALIDATES older replays for playback (they only re-sim exactly under their own
// version's build): ReplayView gates on it and shows "recorded on an older version" instead.

/**
 * SIM BEHAVIOUR version — "which builds can re-simulate a replay", which is a
 * DIFFERENT question from "which competitive season is this".
 *
 * BALANCE_VERSION answers the second: it keys leaderboards, so bumping it starts
 * a fresh season and archives the standings. That makes it the wrong tool for the
 * first. A determinism or float-level physics FIX changes what `step()` produces
 * without being a balance decision at all — and shipping one has only two
 * outcomes if this axis doesn't exist: reset everyone's season over a bug fix, or
 * leave stored replays silently re-simulating into a different game than the one
 * that was played. That second option is the exact failure this constant exists
 * to prevent, so it gets its own number.
 *
 * Bump on ANY change to sim math, physics, or step ordering that moves the
 * output. Never reset it. Leaderboards, ELO and seasons DO NOT read it — only
 * replay playback does (`ReplayView` refuses a mismatch and says so).
 *
 * 1: sim-reachable Math.hypot -> hyp (engine-independent; see src/math.ts)
 * 2: the alpha batch — CR butterfly drivetrain / twin turret / catalyst mechanisms /
 *    corner geometry / start legality, DECODE's G418.B fix (a gate tap no longer
 *    bills the standing ramp column), and the G408/G422 retune (a lenient plowing
 *    test + a pin count that survives its own flicker and recognises goal/classifier
 *    traps), so any match with contact re-sims to a different foul total. All of it
 *    moves `step()` output.
 */
export const SIM_VERSION = 2;

/** Ranked PLACEMENT: a player is "in placements" until they've completed this
 * many ranked games on a board (counted per mode).
 * Until placed they are HIDDEN from the leaderboard and shown a "?" plus an
 * "N matches until placement" line. This REPLACES the old RD-based provisional
 * flag (`rd > 110`), which stayed set far too long in a young pool: Glicko RD
 * shrinks only slowly when opponents are themselves uncertain, so players kept
 * the "?" for dozens of games. RD is still used INTERNALLY by Glicko-2 to size
 * how hard each result swings the rating — it just no longer drives the UI. */
export const PLACEMENT_GAMES = 5;

/** Ratings never print below this. Glicko has no floor of its own, so a long enough losing
 *  run — or a run of behaviour charges (see `src/standing.ts`) — would otherwise show a
 *  player a number that reads as broken rather than as bad. */
export const RATING_FLOOR = 400;

// -------------------------------------------------------------- scoring ----
export const PTS_LEAVE = 3;
export const PTS_CLASSIFIED = 3;
export const PTS_OVERFLOW = 1;
export const PTS_DEPOT = 1;
export const PTS_PATTERN = 2; // per ramp slot matching the motif
export const PTS_BASE_PARTIAL = 5;
export const PTS_BASE_FULL = 10;

// --------------------------------------------------------------- fouls -----
/** Section 11 penalties, awarded TO the OPPOSING (victim) alliance. Straight from the
 * DECODE glossary (Section 16): a MINOR FOUL is "a credit of 5 points", a MAJOR FOUL "a
 * credit of 15 points", towards the MATCH point total. */
export const PTS_FOUL_MINOR = 5;
export const PTS_FOUL_MAJOR = 15;
/** MOMENTARY, per the same glossary: "durations that are fewer than approximately 3
 * seconds". Used by G408's excessive-violation test, which turns on whether CONTROL of 4+
 * artifacts was greater-than-MOMENTARY. */
export const MOMENTARY_S = 3;
/** G422 pinning: hold an opponent trapped for this long (s) while it is trying
 * to move and cannot get away -> foul */
export const PIN_SECONDS = 3;
export const PIN_ESCAPE_DIST = 24; // in — getting this far from the pin, once free, ends it
/** The pinned robot counts as "prevented from moving" while it is not gaining
 * ground AWAY from the pinner faster than this.
 *
 * Deliberately measured along the ESCAPE direction rather than as raw speed: a
 * robot being bulldozed sideways along a wall is moving fast and is still just as
 * pinned, and pausing the 3-count every time it slid was one reason real pins
 * almost never reached the threshold. */
export const PIN_STUCK_SPEED = 8; // in/s
/** the PINNED robot must be trapped against a SOLID with the pinner on the open-
 * field side: its leading corner (straight away from the pinner) sits within this
 * slop of the perimeter, a goal wedge or a classifier channel. This breaks the
 * symmetry of a shove — without it BOTH robots look "slow + commanding" and the
 * victim was wrongly fouled too. */
export const PIN_WALL_SLOP = 3; // in
/** How long the hold may LAPSE before a pin is considered over.
 *
 * The 3-count needs ~180 consecutive ticks, and every input to it flickers: the SAT
 * contact list drops a tick when the bumpers unload, the victim's stick crosses the
 * dead zone as they saw at it, the wall probe slips past the slop as the pair rocks.
 * Resetting the accumulator on any single-tick lapse meant a genuine 5-second pin
 * routinely counted to 0.6 s and started over, which is why the foul "never
 * happened". The clock now PAUSES on a lapse and only resets once the victim has
 * really been let go for this long (or has separated and driven off). */
export const PIN_BREAK_S = 0.6; // s
/** G408: "No more than 3 at a time. A ROBOT may not simultaneously CONTROL more than 3
 * ARTIFACTS." Violation: "MINOR FOUL per SCORING ELEMENT over the limit. YELLOW CARD if
 * excessive." The hopper caps at HOPPER_CAPACITY, so the foul bites when a full robot
 * takes loose artifacts along with it, or when a pile bigger than this is driven around. */
export const POSSESSION_LIMIT = 3; // == HOPPER_CAPACITY
/** contact tolerance for CONTROL — a loose artifact counts only when its surface is
 * within this many inches of the robot's footprint (or of an artifact already
 * controlled, since the manual's CONTROL is transitive through scoring elements).
 * A touch tolerance, not a catchment radius. */
export const POSSESSION_CONTROL_MARGIN = 0.4; // in
/**
 * The POSSESSION test is CONDITIONAL on the robot doing something, and these are the two
 * things the glossary names: an artifact is possessed if "as the ROBOT moves or changes
 * ORIENTATION (for example, moves forward, turns, backs up, SPINS IN PLACE), the object
 * remains in approximately the same position relative to the ROBOT."
 *
 * So there are TWO gates, not one — and TURNING is a first-class trigger. An earlier model
 * gated on linear speed alone at 6-9 in/s, which meant a robot could corral a pile, spin on
 * the spot, and control nothing at all, and a robot that crept below the threshold was
 * likewise invisible. Both are now caught, so the gates only have to separate "doing
 * something" from "parked", and they sit accordingly low.
 */
export const POSSESSION_MOVE_SPEED = 1.5; // in/s — the robot is moving at all
export const POSSESSION_TURN_RATE = 0.15; // rad/s — ...or changing orientation at all
/**
 * How far an artifact may DRIFT relative to the robot and still count as "approximately the
 * same position relative to the ROBOT" — the glossary's own words, measured the only way
 * that phrase can be measured continuously: the artifact's velocity against the RIGID-BODY
 * velocity of the robot AT THAT POINT (`robotPointVelocity`, which carries the ω×r term, so
 * a spin counts).
 *
 * Being RELATIVE is the whole point, and is what makes this the manual's test rather than a
 * heuristic. It needs no direction check (a rear-bumper hoard driven in reverse holds
 * station just as well as one pushed by the nose) and no speed floor (a load crept downfield
 * at 5 in/s is still a load). It also draws the line G408 draws between control and the two
 * things it says are NOT control: an artifact you drive PAST slips at your full road speed,
 * and one DEFLECTING off a bumper leaves at its own. Neither holds station; a possessed one
 * does.
 *
 * THE NUMBER IS MEASURED, not chosen. It was 5 in/s, and at 5 the rule silently switched
 * itself off: artifacts do not RIDE a bumper in this sim, they bounce off it and are
 * re-struck, so contact is a train of micro-impacts. Sampled over a six-second shove of a
 * staged spike row, the slip of the artifacts actually touching the footprint ran p10 7.6,
 * p50 17.2, p90 33.1 in/s — the threshold sat below the TENTH PERCENTILE of a textbook
 * violation, no artifact ever confirmed, and shoving a row down the field drew nothing at
 * all. 40 sits above that distribution and still far below the ~80 in/s a stationary
 * artifact slips at when you simply drive past it, which is the case that must not count.
 *
 * 20 is where the sweep landed: it is above the bulk of a real shove's contact (p50 17.2)
 * and below a deflection off the bumper, so shoving a row fouls while a clipped artifact and
 * a drive-past both stay clean. */
/**
 * How far an artifact may WANDER, in the robot's own frame, and still count as remaining
 * "in approximately the same position relative to the ROBOT" — the glossary's test, applied
 * to the thing it actually talks about: POSITION.
 *
 * This replaced a velocity test (the artifact's speed against the robot's rigid-body
 * velocity at that point). Velocity reads possession only while an artifact is TRAPPED: a
 * clump shoved across open floor bounces and shuffles constantly, so no instantaneous match
 * ever holds, and the rule stayed silent until the pile was pinned against a wall and forced
 * to move at exactly the robot's speed. Reported as exactly that — "I don't get the
 * penalty until I push the clump all the way to the wall."
 *
 * Position is immune to that. An artifact being herded sits in front of the bumper the whole
 * way, however much it rattles; one you drive PAST sweeps the length of the chassis and is
 * gone; one that DEFLECTS leaves immediately. 8 in is about half a chassis width — room to
 * shuffle within the pile, not to travel across it.
 */
export const POSSESSION_DRIFT = 8; // in, in the ROBOT frame, from where the hold began
/** grace before over-possession is fouled — seconds of control that have to ACCUMULATE, on
 * TOP of the per-artifact POSSESSION_CONFIRM.
 *
 * The rule is meant to catch a robot taking a load around the field, not the ordinary
 * business of driving into a clump to collect it or nudging a ball aside.
 *
 * Cut 1 s -> 0.4 s: with the confirm window in front of it the total wait was 1.35 s, which
 * is a long time to hold a violation before anything happens, and G408 itself has no grace
 * at all — control over the limit is a foul the moment a referee sees it. The carve-outs are
 * held by the per-artifact confirm (which artifacts, and for how long each), not by this, so
 * shortening it costs them nothing: every bulldozing case still passes at 0.4. */
export const POSSESSION_GRACE = 0.4; // s
/**
 * ...and how fast that clock DRAINS while control is back within the limit, as a fraction
 * of real time. This is the difference between a clock that accumulates and one that resets,
 * and it is load-bearing.
 *
 * A reset clock is trivially defeated by FLICKING: bump the pile, back off, bump again. Each
 * contact is well under the grace, so the clock never got anywhere — and measured in the sim,
 * a flick-shuttle moved a six-artifact pile FURTHER than a sustained shove did (18" vs 9")
 * while drawing zero fouls, where the shove drew three and a card. A penalty that the evasive
 * version of the same act dodges is worse than no penalty: it does not deter the behaviour,
 * it just selects for the technique.
 *
 * Draining at HALF the fill rate means a repeated violation still climbs (any duty cycle over
 * a third of the time nets upward) while one genuine pass through a clump drains away in about
 * twice the time it lasted. Intent shows up in the aggregate, which is where it actually lives.
 */
export const POSSESSION_LEAK = 0.5;
/**
 * How long ONE artifact has to stay with a robot before it counts toward the limit.
 *
 * This is the test that separates the two things a single frame cannot: HERDING (the same
 * artifacts, held or repeatedly re-struck) from BULLDOZING — "inadvertent contact with a
 * SCORING ELEMENT while in the path of the ROBOT moving about the FIELD", which G408
 * explicitly excuses. Crossing a littered field touches a dozen artifacts for a fifth of a
 * second each and none of them ever confirms; shoving a pile holds the same six for as long
 * as you shove; flicking re-strikes the same six every cycle, and because each artifact's
 * clock is LEAKY rather than resetting, those repeated touches add up on the artifacts
 * themselves. Identity is the signal — which artifacts, not how many.
 */
export const POSSESSION_CONFIRM = 0.35; // s, per artifact

/**
 * G408's YELLOW CARD, and the manual defines "excessive" rather than leaving it to taste:
 *   A. "simultaneous CONTROL of 5 or more ARTIFACTS", or
 *   B. "frequent (i.e., 3 or more separate MATCHES in a MATCH), greater-than-MOMENTARY
 *      CONTROL of 4 or more ARTIFACTS."
 * (B reads oddly because of a typo in the manual — "3 or more separate MATCHES in a MATCH"
 * is plainly 3 or more separate INSTANCES in a match, which is how it is implemented.)
 *
 * MOMENTARY is itself defined, in the glossary: "fewer than approximately 3 seconds"
 * (MOMENTARY_S). So B is three separate stretches of holding 4+ for longer than that.
 *
 * The rule also caps itself: "REPEATED excessive violations of this rule do not result in
 * additional YELLOW CARDS unless the violation reaches the level of egregious to trigger a
 * G211 violation" — so G408 issues at most ONE card per robot per match.
 */
export const CARD_CONTROL_SIMULTANEOUS = 5; // clause A: this many at once is excessive
export const CARD_CONTROL_FREQUENT = 4; // clause B: this many, held longer than MOMENTARY...
export const CARD_CONTROL_INSTANCES = 3; // ...on this many separate occasions
/** A foul fires on the rising edge of its condition and does NOT re-fire while
 * the condition holds — continuous contact in a foul zone is ONE foul, not a
 * stream. It re-arms only after the condition has been CLEAR for this long, so
 * a jittery SAT contact that flickers off for a tick or two never re-fouls, but
 * genuinely leaving a zone and coming back does. Kept short so re-entry still
 * feels immediate. */
export const PENALTY_CLEAR = 1.0; // s

// ------------------------------------------------------------ artifacts ----
export const BALL_RADIUS = 2.5; // 5 in diameter
export const BALL_ROLL_FRICTION = 20; // in/s^2 — low enough that classifier
// outflow carries to the human-player loading zone (~4-5 of 9 reach the corner);
// the clump push-drag (BALL_PUSH_DRAG) still carries the harder-to-push feel
/** fraction of the robot's into-the-ball speed bled off per ball contact each
 * solver pass — small per ball, but a big CLUMP is cumulatively a little heavier
 * to push (the drivetrain meets resistance, accelerates into it slower) */
export const BALL_PUSH_DRAG = 0.01;
export const BALL_REST_SPEED = 2; // in/s, snap to rest below this
export const BALL_WALL_RESTITUTION = 0.5;
export const BALL_BALL_RESTITUTION = 0.55;
export const BALL_GROUND_RESTITUTION = 0.45; // vertical bounce
export const BALL_BOUNCE_H_RETAIN = 0.8; // horizontal speed kept on ground bounce
export const GRAVITY = 386; // in/s^2
/** light foam ball off a heavy chassis: nearly inelastic — the ball inherits
 * the chassis surface speed but gains almost no extra bounce */
export const BALL_ROBOT_RESTITUTION = 0.05;
/** ground-ball mass (lb) for the Rapier ball solve (`solveBalls`). Balls only
 * meet other balls (equal mass ⇒ value cancels) and the immovable static field
 * there — ball↔robot is the bespoke `collideBallRobot` pass, NOT Rapier, because
 * the pin stall + "outflow can't shove a parked robot" feel (product decision #7)
 * is deliberately non-physical. So this is essentially a numerical scale; a light
 * foam-ball value is kept for physical honesty. Ball restitution combines with
 * `CoefficientCombineRule.Min`, so ball↔static = min(BALL_BALL_RESTITUTION,
 * BALL_WALL_RESTITUTION) = BALL_WALL_RESTITUTION and ball↔ball = BALL_BALL_REST. */
export const BALL_MASS = 0.2; // lb
/** a robot push refused by a wall beyond this distance means the ball is
 * PINNED — the constraint transmits back and stalls the robot */
export const BALL_PIN_SLOP = 0.05; // in
/** the pin only pushes the robot back when the robot itself drives into it
 * faster than this — balls arriving under their own momentum just stop */
export const BALL_PIN_PUSH_MIN_SPEED = 0.5; // in/s
/** ball-ball + ball-robot passes per tick, so robot -> ball -> pinned-ball
 * chains converge instead of tunnelling */
export const BALL_SOLVER_ITERATIONS = 2;
/**
 * Passes of the FINAL ball-vs-ball relaxation (see the end of the ground-ball solve in
 * world.ts).
 *
 * Rapier separates artifacts EARLY in the tick, but four things move them afterwards: the
 * bespoke robot push, the held-ball block, the classifier eviction and the wall clamp. With
 * nothing separating them again, a robot ramming a clump drives one artifact into another
 * and the overlap survives to the next tick — and while the robot keeps pushing, the next
 * tick never wins either. That is why artifacts visibly stack when rammed, and why they
 * stack at the gate when a robot blocks the outflow.
 *
 * Four passes because the pile is a CHAIN: separating the front pair pushes into the pair
 * behind it, so the correction has to propagate back through the clump within one tick.
 */
export const BALL_RELAX_PASSES = 4;

// ------------------------------------------------- robot contact torque ----
/** per-tick angular correction cap from a single contact group (rad), at rest */
export const CONTACT_ALIGN_RATE = 0.03;
/** contact bias: keeps torque alive under light steady pressure so the wall
 * finishes squaring the chassis instead of stalling at a small angle */
export const CONTACT_BIAS = 0.2;
/** alignment speedup per in/s the robot pushes into the contact — holding
 * forward against a wall turns briskly, a fast hit swings hard */
export const CONTACT_PRESS_GAIN = 0.4;
/** hard cap on per-tick alignment under pressure (rad) */
export const CONTACT_ALIGN_RATE_MAX = 0.12;
/** spin injected per (contact torque × in/s of impact speed) — a fast angled
 * hit visibly converts momentum into rotation; dead-center hits add nothing */
export const CONTACT_IMPACT_SPIN = 0.12;
/** touch tolerance (in) for the post-Rapier square-up pass: Rapier resolves
 * translation and leaves a chassis resting AT a face (near-zero penetration),
 * so the bespoke torque nudge treats a contact within this band as touching */
export const CONTACT_TOUCH_EPS = 0.5;
/** Rapier length scale: the world is in INCHES, not meters. Rapier scales its
 * internal penetration/prediction tolerances by this so contacts resolve firmly
 * at our scale (a typical object — robot/ball — is ~10 in). */
export const PHYS_LENGTH_UNIT = 10;
/** Rapier constraint solver iterations per step — high enough that a full-speed
 * pin is fully separated each tick (no penetration accumulation / axis flip) */
export const PHYS_SOLVER_ITERS = 8;
/** Rapier contact stiffness (Hz): LOW = soft contacts, so a body starting deep
 * in a wall (e.g. intake reach) is bled out gently over several ticks instead of
 * ejected with a huge recovery velocity (solver explosion). */
export const PHYS_CONTACT_FREQ = 8;
/** normalized allowed penetration error (× lengthUnit ⇒ inches): a little slack
 * so shallow resting contacts aren't fought every tick */
export const PHYS_ALLOWED_ERROR = 0.01;
/** friction between chassis and walls / other chassis — resists a pinned robot
 * sliding out of a squeeze (the old model squared-and-held; 0 let it squirt) */
export const PHYS_FRICTION = 0.7;
/** BALL contact stiffness (Hz) for the ball solve — stiffer than the robot world
 * (8 Hz), which let two grounded balls sit visibly overlapping for many ticks.
 * Tuned to 25: separates a resting overlapping clump within ~0.5s (as clean as a
 * much higher value) WITHOUT the explosive ejection a very stiff contact (≥60 Hz)
 * gives the tightly-packed column draining out of the gate — at 120 Hz those exit
 * balls shot out at ~2× their intended speed. 25 keeps gate outflow at the natural
 * exit velocity while still killing resting overlap. */
export const PHYS_BALL_CONTACT_FREQ = 25;
/** BALL allowed penetration (× lengthUnit ⇒ inches): tight, so resting balls
 * settle touching rather than at the ~0.1in slop the robot value leaves. */
export const PHYS_BALL_ALLOWED_ERROR = 0.001;
// ---------------------------------------------------------------- robot ----
export const ROBOT_MAX_SIZE = 18; // FTC starting size cap (incl. intake reach)
export const ROBOT_MIN_SIZE = 12;
/** the chassis may be narrower than the intake (easier base parking) */
export const ROBOT_MIN_WIDTH = 10;
/** SWERVE needs a wider base than the other drivetrains — four steering modules
 * at the corners don't fit a tiny frame — so its minimum width floors higher. */
export const SWERVE_MIN_WIDTH = 13.5;
/** wheel centers sit this far INSIDE the chassis edge (typical FTC build);
 * the four wheel ground-contact points are what counts for base parking */
export const WHEEL_INSET = 2.6;
// ============================================================================
// DRIVETRAIN & MOTOR BALANCE — TUNE HERE
// ----------------------------------------------------------------------------
// Grounded in real FTC hardware: a 104 mm goBILDA drive wheel + the MATRIX /
// goBILDA 5000-series 12VDC brushed motor (5800 rpm free, 20.45 oz-in / 9.2 A
// stall, 0.25 A free). A brushed DC motor has a LINEAR torque–speed curve, which
// is exactly the motorStep model below.
// The model (src/sim/drivetrain.ts + robot.ts):
//   1. BASE reference = an IDEAL traction wheel: free speed = wheel geometry
//      (WHEEL_DIAMETER_MM) × driveRpm × DRIVE_EFFICIENCY; BASE_DRIVE_ACCEL stall
//      accel. `driveRpm` is the WHEEL rpm (post-gearbox); the datum is "no roller
//      loss", i.e. what a traction wheel on this motor would do.
//   2. Each DRIVETRAIN_PRESET applies REAL efficiency FACTORS on top (all ≤ 1
//      except tank ≈ ideal): mecanum/x-drive rollers slip → less speed, accel,
//      and pushing; tank/swerve traction bites hard. See the table.
//   3. MOTORS follow the DC torque–speed curve (motorStep): full stall torque off
//      the line, falling ~linearly to zero at free speed, so velocity approaches
//      top speed asymptotically instead of a constant ramp.
//   4. Mass ↓ accel, RPM ↑ speed / ↓ accel (torque), power draw ↓ everything.
// To rebalance: edit the numbers here; `npm test` prints the resulting speed /
// strafe / accel / push table (driveSummary) so the effect is immediately visible.
// ============================================================================
export const REF_DRIVE_RPM = 435;
export const REF_MASS_LB = 26;
/** goBILDA 104 mm mecanum / traction drive wheel */
export const WHEEL_DIAMETER_MM = 104;
/** loaded drivetrain efficiency: a real motor never reaches free speed on the
 * field (gearbox + bearing + rolling losses), so the top speed it APPROACHES is
 * ~80% of the 104 mm free-speed geometry. Bump toward 1 for a floatier top end. */
export const DRIVE_EFFICIENCY = 0.95;
/** in/s of loaded top speed per WHEEL rpm = (π·104 mm → in / 60) · efficiency.
 * ≈ 0.204 → 435 wheel-rpm ≈ 89 in/s (7.4 ft/s), a real fast FTC drive. */
export const SPEED_PER_RPM = (Math.PI * (WHEEL_DIAMETER_MM / 25.4)) / 60 * DRIVE_EFFICIENCY;
/** in/s^2 PEAK accel at reference RPM/mass, TRACTION-limited (μ·g), NOT motor-
 * limited: the MATRIX motor's stall torque could give ~460 in/s² but the wheels
 * slip first, so real peak accel = μ·g (g≈386 in/s²). This base × accelMult lands
 * each drivetrain at its traction limit (tank μ≈0.9 → ~347 … x-drive μ≈0.45 → ~175). */
export const BASE_DRIVE_ACCEL = 240;
export const TURN_MAX_SPEED = 12.0; // rad/s absolute cap ≈ 687°/s (only small/fast bots reach it; default ~8.5)
export const TURN_ACCEL_PER_ACCEL = 40 / 280; // rad/s^2 per in/s^2 of drive accel (≈0.143; traction-limited, so
// turn spin-up tracks linear accel → tank ramps up quickest, xdrive slowest; ~0.15–0.25 s to max spin)

// --- motor torque–speed curve (how the stall accel falls off with speed) ---
/** 0 = old CONSTANT accel; 1 = physically real (force ∝ 1 − v/v_free). Higher =
 * punchier off the line, gentler approach to top speed (a real motor is 1.0). */
export const MOTOR_TORQUE_CURVE = 1.0;
/** floor on the torque fraction near free speed so a bot still closes the last
 * few % to top speed instead of crawling forever. */
export const MOTOR_MIN_TORQUE_FRAC = 0.06;
/** braking torque multiplier: reversing / slowing pulls harder than peak drive
 * accel (motor back-EMF + reverse), so stops feel crisp. */
export const MOTOR_BRAKE_MULT = 1.4;

/** SWERVE module steer rate (rad/s): how fast the four steered pods re-aim to a
 * new drive direction. With MODULE OPTIMIZATION (pod flip — see robot.ts) the pods
 * never rotate more than 90° (a bigger change flips the drive motor instead), so
 * ~7 ⇒ at most ~0.22 s to re-aim. The target angle is set immediately; the pods
 * just physically slew to it while the drive keeps running. This reorient LAG is
 * swerve's real cost vs mecanum's instant rollers — keep it felt (don't raise high). */
export const MODULE_SLEW_RATE = 7;
/** SWERVE control-loop imperfection: each of the four modules has its OWN steering
 * loop (always running) that can't perfectly HOLD its angle, so an INDEPENDENT,
 * FAST oscillating error is superimposed while driving. It's a SUM of a few
 * incommensurate sinusoids at per-module-varied frequencies (robot.ts) — an
 * IRREGULAR, non-periodic jitter, NOT a clean uniform sine — so each pod hunts on
 * its own. The errors don't cancel → the forward-kinematics of the mispointed pods
 * yields a small path DRIFT + net YAW jitter driving straight. Swerve's balancing
 * weakness (imprecise line), NOT weight. Disturbance ∝ actual SPEED, so at rest it's
 * zero and the pods converge to one angle. AMP = peak per-pod error (rad); FREQ =
 * the base jitter rate. Tune AMP for how imprecise, FREQ for how jittery. */
export const SWERVE_WOBBLE_AMP = 0.15; // rad (~8.6°) peak per module, at full speed
export const SWERVE_WOBBLE_FREQ = 30; // rad/s — the FAST jitter component (the buzz)
/** rad/s of the SLOW per-module drift component. Low enough that it does NOT
 * average out over a wall-to-wall run — the four modules meander independently,
 * so the net heading (yaw) wanders and the robot DRIFTS off a straight line
 * (fast jitter alone just buzzes and cancels). This is what makes swerve hard to
 * track straight. Raise the drift weight/amp for more veer. */
export const SWERVE_DRIFT_FREQ = 2.2;
/** robot mass/rpm GLOBAL fallbacks for the builder (lb / wheel rpm). The real
 * limits are per-drivetrain (DRIVETRAIN_LIMITS below); these bound the widest
 * envelope and still gate settings validation where a drivetrain isn't known. */
export const ROBOT_MIN_MASS = 20;
export const ROBOT_MAX_MASS = 42;
export const ROBOT_MIN_RPM = 200;
export const ROBOT_MAX_RPM = 600;

/** per-drivetrain weight + RPM envelopes. Tank runs heavy with a torque-biased
 * (lower) RPM ceiling; swerve modules are complex → a raised mass floor and a
 * lower RPM ceiling; mecanum/x-drive get the full range. The MASS FLOOR is
 * further raised by flywheel inertia (a heavier flywheel — see massLimits). */
export const DRIVETRAIN_LIMITS = {
  mecanum: { minMass: 18, maxMass: 42, minRpm: 200, maxRpm: 600 },
  xdrive: { minMass: 18, maxMass: 42, minRpm: 200, maxRpm: 600 },
  tank: { minMass: 22, maxMass: 42, minRpm: 200, maxRpm: 560 },
  swerve: { minMass: 21.5, maxMass: 40, minRpm: 200, maxRpm: 500 }, // a touch heavier base (8 motors + modules)
  // BUTTERFLY carries BOTH wheel sets plus the lift, so its floor sits ABOVE tank's 22 —
  // the heaviest starting point in the game, and the literal cost of the archetype. The
  // rpm fields here are the MECANUM-set slider (the full 200-600 mecanum envelope); the
  // traction set has its own, torque-biased range in BUTTERFLY_TANK_RPM.
  butterfly: { minMass: 24, maxMass: 42, minRpm: 200, maxRpm: 600 },
} as const;

/** BUTTERFLY's TANK-set rpm envelope — the same torque-biased ceiling tank runs (560),
 * because it is the same kind of geared traction set. The mecanum set keeps the wider
 * range in `DRIVETRAIN_LIMITS.butterfly`. Two sets, two gearings, two sliders. */
export const BUTTERFLY_TANK_RPM = { min: 200, max: 560 } as const;
/** lb added to a drivetrain's mass floor at flywheelInertia 1 (a big flywheel
 * weighs more): effective floor = base + INERTIA_MASS_FLOOR·inertia. Kept small
 * so inertia only nudges the mass range. */
export const INERTIA_MASS_FLOOR = 4;

/** penalty added to fireInterval when robot is sorting (canSort: true) */
export const SORT_FIRE_PENALTY = 0.25;

/** per-drivetrain REALISM factors + wheel-saturation model. Every factor is a
 * fraction of the ideal-traction BASE — tank ≈ 1 (traction bites), the roller
 * drives (mecanum/x-drive) pay real losses. Resulting free speeds at the 435-rpm
 * reference (base ~89 in/s): tank 89 · swerve 84 · mecanum 77 · x-drive 74; peak
 * accel (μ·g): tank 348 · swerve 317 · mecanum 211 · x-drive 175.
 * DRIVETRAIN NICHES: tank = raw power + no strafe; swerve = strongest holonomic
 * (speed/accel/push/full-strafe) BUT its imperfect pod control makes it WOBBLE
 * driving straight (imprecise line) + pods reorient on direction changes; mecanum =
 * the LIGHT, INSTANT, PRECISE holonomic (no wobble, zero reorient lag) but slower +
 * weak push; x-drive = deliberately-weak novelty.
 *   strafeMult  strafe speed ÷ forward (mecanum rollers < 1; omni/steered = 1; tank dead)
 *   speedMult   forward FREE speed ÷ ideal (roller slip + friction loss)
 *   accelMult   peak accel ÷ base (each drivetrain's traction limit μ·g ÷ the base)
 *   pushMult    EFFECTIVE shove mass in the Rapier solver (physicsEngine.ts) — real
 *               traction; mecanum/x-drive have little, so a tank shoves them around
 *   turnMult    max spin rate ÷ the geometric base (wheelSpeed/halfDiag). swerve > 1
 *               (vectored rotation = fastest turner); the rest = 1 (geometric)
 *   saturation  wheel budget: 'sum' |f|+|s|+|ω| · 'tank' |f|+|ω| · 'vec' hypot(f,s)+|ω|
 * Orders (all realistic): speed tank>swerve=mecanum≫xdrive (swerve's gear loss ≈ mecanum's
 * roller scrub → identical straight-line top speed; xdrive far back) · push
 * tank>swerve≫mecanum>xdrive · accel
 * tank>swerve>mecanum>xdrive · turn swerve>tank>mecanum>xdrive (swerve vectors for rotation).
 * Rebalanced 2026-07: tank the bulldozer, swerve the powerful/holonomic-but-wobbly all-rounder,
 * mecanum the light/PRECISE holonomic, xdrive a deliberately-weak novelty (worst by a margin). */
export const DRIVETRAIN_PRESETS = {
  /** FTC standard mecanum: the LIGHT, INSTANT, PRECISE holonomic pick — rollers change
   * direction with ZERO reorient lag (unlike swerve's pods), no wobble, and its low mass
   * FLOOR keeps it nimble. It's now the 2nd-fastest straight line (single-stage direct
   * drive, unlike swerve's gear-lossy modules), so it's "tank-lite + strafe": you give up
   * accel and pushing power vs tank in exchange for maneuverability. Costs: ~8% forward
   * loss (roller scrub), slower strafe, and modest pushing power (shoved by tank/swerve).
   * accelMult 1.12: close to swerve's EFFECTIVE accel (swerve's steady power draw eats ~10%
   * of its 1.32), so straight-line FEEL matches even though swerve keeps a slight burst edge
   * and more raw accel at equal weight — mecanum was feeling sluggish off the line at the old
   * 0.98. Even at the EXTREME min-weight, MAX-inertia, 500rpm corner, swerve (1.32 / floor
   * 21.5 → 25.5lb) still edges out the equivalent mecanum (1.12 / floor 18 → 22lb) by ~1.7% —
   * its higher accelMult just beats its heavier module floor. Swerve keeps the raw-accel edge. */
  mecanum: { strafeMult: 0.8, speedMult: 0.92, accelMult: 1.12, pushMult: 0.8, turnMult: 1.0, saturation: 'sum' },
  /** 45° omni X-drive: a deliberately-WEAK novelty with no honest competitive niche.
   * REALISTICALLY the worst by a wide margin: each omni sits at 45°, so a big chunk of
   * every wheel's speed is wasted off-axis (low top speed), the free-spinning side
   * rollers slip trivially (weakest traction → poor accel, shoved by everyone), and even
   * rotation scrubs. Fully symmetric (strafe = forward). A hard-mode/style pick only. */
  xdrive: { strafeMult: 1.0, speedMult: 0.74, accelMult: 0.58, pushMult: 0.35, turnMult: 0.9, saturation: 'sum' },
  /** traction wheels: no strafe, but a clear top-SPEED lead plus the best accel and
   * pushing power — the defensive anchor. speedMult 1.06: pushed above the ideal datum so
   * tank is decisively the fastest in a straight line (grippy wheels, least drivetrain loss). */
  tank: { strafeMult: 0, speedMult: 1.06, accelMult: 1.45, pushMult: 1.7, turnMult: 1.0, saturation: 'tank' },
  // (tank accelMult 1.45 × base 240 = 348 ≈ μ·g at μ 0.9 — the traction ceiling)
  /** steered traction modules: the HEAVY all-rounder — full-speed any direction +
   * strong push + good top speed, but its weight (mass FLOOR below) tanks its accel
   * and the pods must REORIENT on direction changes (MODULE_SLEW_RATE). Master of
   * none: tank out-accels + out-pushes it, mecanum out-accels + out-responds it. */
  // speedMult 0.92: MATCHED to mecanum — the module gearing (bevel + reductions) is lossy
  // but swerve rolls on GRIPPY traction wheels (vs mecanum's scrubbing rollers), and the two
  // losses cancel → identical straight-line top speed. accel stays traction-limited, push
  // unaffected. turnMult 1.15: it VECTORS all four wheels tangentially for rotation → the
  // fastest TURNER, its signature. Tradeoffs: WOBBLE (imprecise line), heavy mass, steering draw.
  // turnMult 1.18: kept above tank's raised speed so swerve stays the fastest turner.
  swerve: { strafeMult: 1.0, speedMult: 0.92, accelMult: 1.32, pushMult: 1.35, turnMult: 1.18, saturation: 'vec' },
  /** BUTTERFLY — traction wheels AND mecanum wheels on the same chassis, one set lifted
   * off the floor at a time (the driver drops the other mid-match). This entry is the
   * MECANUM-mode half so every generic `DRIVETRAIN_PRESETS[dt]` reader gets a sane
   * default; `BUTTERFLY_MODES` below holds both halves and `driveParams` picks. */
  butterfly: { strafeMult: 0.76, speedMult: 0.87, accelMult: 1.05, pushMult: 0.74, turnMult: 0.96, saturation: 'sum' },
} as const;

/**
 * BUTTERFLY DRIVE — the two halves.
 *
 * A real butterfly carries BOTH wheel sets plus the lift that swaps them, so it is never
 * quite either dedicated drivetrain:
 *  • it is ALWAYS hauling the set that is currently in the air (dead weight, and high in
 *    the chassis), which is why its mass FLOOR is the highest of any drivetrain, and
 *  • the deployed set rides on a LIFT LINKAGE rather than a hard-mounted axle, so some
 *    traction and shove is lost to compliance in that linkage.
 *
 * Both halves are therefore the dedicated drivetrain's multipliers times a small
 * EFFICIENCY TAX, weighted by how much each quantity actually suffers from a compliant
 * mount: push −7% (shove force loads the linkage worst), accel −6% (traction transfer
 * runs through it), speed −5% (mostly just gearing + a little scrub), turn −4% (least
 * affected — rotation is a light load). The result is a drivetrain that is never the
 * best at anything but is never far off either, which IS the archetype: you pay a few
 * percent everywhere and a weight penalty for the right to change your mind mid-match.
 */
export const BUTTERFLY_MODES = {
  /** mecanum set down: strafe + holonomic, mecanum's multipliers × the tax */
  mecanum: { strafeMult: 0.76, speedMult: 0.87, accelMult: 1.05, pushMult: 0.74, turnMult: 0.96, saturation: 'sum' },
  /** traction set down: no strafe, tank's push/accel/speed × the tax, tank's control model */
  tank: { strafeMult: 0, speedMult: 1.01, accelMult: 1.36, pushMult: 1.58, turnMult: 0.96, saturation: 'tank' },
} as const;

/** flywheel recovery: after an energetic (long-range) shot, a LOW-inertia
 * flywheel needs time to spin back up before the next shot. Shots below
 * FLYWHEEL_CLOSE_SPEED add only a small CLOSE floor (below), then recovery ramps
 * STRONGLY with (speed over that)² and with (1 - inertia) — so DISTANCE dominates the
 * cadence, and low inertia is punished hard far out while high inertia keeps firing
 * fast at range. NOTE the threshold must sit ABOVE the launch speed of a genuinely
 * CLOSE shot or the DISTANCE penalty bleeds into point-blank range: a 12in shot already
 * needs ~149in/s and a 2-tile (~48in) shot ~180, so 180 keeps everything within ~2
 * tiles free of the distance penalty and only ramps that in past that. */
export const FLYWHEEL_CLOSE_SPEED = 180; // in/s launch speed considered "close" (≈2-tile shot)
export const FLYWHEEL_RECOVERY_MAX = 1.25; // s extra between max-range shots at inertia 0
/** CLOSE-range floor: even a close shot leaves a NEAR-ZERO-inertia wheel needing a brief
 * respin, so close-zone rapid fire isn't quite free at inertia 0. The penalty FADES OUT by
 * FLYWHEEL_CLOSE_INERTIA_KNEE — so a close-zone cycler wants a little inertia (~0.1–0.2),
 * not 0, but doesn't need a heavy far-range wheel. (Was 0 at every inertia before.) */
export const FLYWHEEL_CLOSE_RECOVERY = 0.04; // s extra between CLOSE rapid-fire shots at inertia 0
export const FLYWHEEL_CLOSE_INERTIA_KNEE = 0.2; // inertia at/above which the close floor vanishes

/** POWER DRAW: a running intake, plus the flywheel, pull current away from the
 * drive motors, so the robot gets slightly slower AND pushes weaker. Draw scales
 * drive speed/accel down by (1 − draw) and the Rapier shove mass by the same,
 * capped so it stays "slight". The flywheel has TWO terms (both × inertia):
 *  - HOLD: a small steady cost for keeping a spun-up wheel turning. Just being
 *    far from the goal barely matters — this is intentionally light.
 *  - SPIN-UP: the DOMINANT cost of ACCELERATING the wheel, i.e. actively driving
 *    AWAY from the goal so the required spin is climbing. Proportional to how
 *    fast the spin target is rising (per second) — a heavy (high-inertia) wheel
 *    is expensive to spin up, a light one is nearly free. Spinning DOWN (driving
 *    toward the goal) costs nothing. flywheelSpin is a 0..1 ramp with distance to
 *    the robot's own goal (FLY_SPIN_NEAR→FLY_SPIN_FAR); flywheelSpinRate is its
 *    positive rate of change (1/s), both set in updateRobotActions. */
export const POWER_DRAW_FLYWHEEL_HOLD = 0.04; // steady: inertia × spin (far & idle)
export const POWER_DRAW_FLYWHEEL_SPINUP = 0.45; // per 1/s of rising spin: inertia × rate
export const POWER_DRAW_INTAKE = 0.06; // intake motors running
/** SWERVE draws steady current just RUNNING — the four steering (pivot) motors
 * pull current to hold + correct pod angle even driving straight, on top of the 4
 * drive motors. So a swerve chassis is always a bit slower / weaker-shoving than an
 * equivalent mecanum. Applied whenever the drivetrain is swerve. */
export const POWER_DRAW_SWERVE = 0.1; // steady steering-motor current — kept modest; swerve's
// main weakness is now the mechanical efficiency loss baked into its speedMult, not amperage.
/** DRIVE current scales with RPM: a drivetrain geared for higher rpm pulls more current
 * from the pack to hold power at speed. Modeled only ABOVE the reference rpm (so the
 * 435-rpm base calibration is untouched), ramping to POWER_DRAW_DRIVE at the top rpm —
 * so high-rpm builds top out SUB-linearly and hit the draw cap sooner when also
 * shooting/intaking (voltage sag). Low-rpm builds draw nothing extra. */
export const POWER_DRAW_DRIVE = 0.05;
export const POWER_DRAW_DRIVE_TOP_RPM = 600;
export const POWER_DRAW_MAX = 0.2; // cap ⇒ at most ~20% slower
export const FLY_SPIN_NEAR = 40; // in to goal: flywheel spin 0
export const FLY_SPIN_FAR = 170; // in to goal: flywheel spin 1

/** capture tolerance beyond the ball radius, each way (tight — no vacuuming
 * balls from a distance; a ball must actually reach the compliant wheels) */
export const INTAKE_CAPTURE_BAND = 0.5;
/** how fast a HELD ball slides between storage slots (in/s), in the robot frame —
 * so the triangle's front ball visibly slides aside to make room for a 3rd */
export const HELD_SLIDE_SPEED = 45;
/** the intake ROLLER (axle + compliant wheels) sticks out this far past the
 * ball-colliding wedges. The roller is a physical hitbox for ROBOTS/WALLS (the
 * full `reach`, via robotExtents), but it rides HIGH in z so BALLS pass under it
 * and never collide with it — only the recessed wedges deflect balls. So the
 * ball hitbox is `reach − INTAKE_WHEEL_STICKOUT` deep. */
export const INTAKE_WHEEL_STICKOUT = 1.3;
/** Intake presets model the REAL mechanism, not a touch-and-wait hitbox.
 * TOP LEVEL (feeds robotExtents → the Rapier robot-robot/wall collider, length
 * clamps, drawing):
 *   reach       forward extension of the box past the chassis front
 *   overhang    the compliant wheels may stick out past a narrower chassis
 *               (vector); without it the chassis ENCOMPASSES the intake so side
 *               intake is geometrically impossible
 *   min/maxLength  legal chassis length range · fireInterval  hopper→shooter cadence
 * mouth GEOMETRY (robot-local inches, front = +x):
 *   wedge       true = a FUNNEL front: two angled side slopes (from the front
 *               corners in to the throat) direct balls to the CENTER compliant
 *               wheels — NO flat front wall (sloped/triangle). false = a flat
 *               front, wheels span the whole mouth (vector).
 *   mouthHalf   half-width of the opening at the tip
 *   throatHalf  half-width of the compliant-wheel CAPTURE zone: at the chassis
 *               front for a funnel (balls funnel to center there), = the full
 *               mouth for a flat front (vector captures across the tip)
 *   drawIn      suction speed (in/s) the running intake pulls a ball in the
 *               mouth toward the throat (0 = flat front, wheels grab in place)
 *   capMin/capMax  swallow interval as the capture point goes CENTER→EDGE
 *               (vector: compliant center fast, vectoring sides slow)
 *   clumpInterval  swallow cadence while 2+ balls sit at the mouth
 *   dual        capture TWO balls per cycle from a clump (triangle's 2 front slots) */
export const INTAKE_PRESETS = {
  /** SLOPED: two side slopes funnel artifacts into the compliant wheels at the
   * throat — no flat front. maxLength = 18 − reach (the roller counts toward the
   * 18in cube). Fast + eats clumps. */
  sloped: {
    reach: 3, overhang: false, minLength: 13.5, maxLength: 15, minWidth: 14.5, fireInterval: 0.08, fireCap: 0,
    mouth: {
      wedge: true, mouthHalf: 7, throatHalf: 3, drawIn: 26,
      capMin: 0.05, capMax: 0.09, clumpInterval: 0.04, dual: false,
    },
  },
  /** VECTOR WHEEL: flat front (no side slopes), the roller spans the whole mouth.
   * The mouth is exactly as WIDE AS THE CHASSIS (mouthHalf = width/2, applied per
   * robot in `intakeMouth` — the `8.5` below is only a fallback base), so there's
   * NO overhang: the wheel row matches the frame. CENTER intakes fast, the SIDES
   * slower (vectoring). Chassis 11.5..14.5in. */
  vector: {
    reach: 3.5, overhang: false, minLength: 11.5, maxLength: 14.5, minWidth: ROBOT_MIN_WIDTH, fireInterval: 0.1, fireCap: 0,
    mouth: {
      // flat plate spanning the chassis width; the mecanum wheels VECTOR a ball
      // laterally (drawIn) to the center compliant zone (throatHalf) before sucking
      // it in, so edge entries take longer — the vectoring time. `mouthHalf` here is
      // a fallback; the live value is the robot's half-width (see `intakeMouth`).
      wedge: false, mouthHalf: 8.5, throatHalf: 3, drawIn: 18,
      capMin: 0.08, capMax: 0.14, clumpInterval: 0.12, dual: false,
    },
  },
  /** TRIANGLE: named for the triangular ball storage (2 near the mouth, 1 deep).
   * Sloped-style funnel slopes + longest reach; devours a clump TWO at a time.
   * Transfer is the SAME as the others EXCEPT a max-rate CAP (`fireCap`): it can't
   * fire faster than that, but when conditions are already slower than the cap
   * (flywheel recovery on far shots) it fires at the same rate as everyone else. */
  triangle: {
    reach: 5, overhang: false, minLength: 11, maxLength: 13, minWidth: 15.5, fireInterval: 0.1, fireCap: 0.12,
    mouth: {
      // strongest INTAKE of the three (its identity — devours clumps): a hard
      // suction (drawIn) snaps balls to the throat and it swallows quickest. The
      // tradeoff is TRANSFER (fireCap), not the grab — those stay untouched.
      wedge: true, mouthHalf: 7, throatHalf: 3.5, drawIn: 46,
      capMin: 0.04, capMax: 0.07, clumpInterval: 0.035, dual: true,
    },
  },
} as const;

/** the intake mouth geometry as it applies to a SPECIFIC robot. The VECTOR wheel
 * row spans the FULL chassis width (mouthHalf = width/2 — the intake is exactly as
 * wide as the robot, no overhang); sloped/triangle keep their fixed funnel mouth.
 * Every site that reads the mouth width per-robot (capture, ball collision, both
 * renderers) goes through here so the width rule lives in ONE place. */
export interface IntakeMouth {
  wedge: boolean;
  mouthHalf: number;
  throatHalf: number;
  drawIn: number;
  capMin: number;
  capMax: number;
  clumpInterval: number;
  dual: boolean;
}
export function intakeMouth(spec: { intake: keyof typeof INTAKE_PRESETS; width: number }): IntakeMouth {
  const m = INTAKE_PRESETS[spec.intake].mouth;
  return spec.intake === 'vector' ? { ...m, mouthHalf: spec.width / 2 } : m;
}

/** flank capture engages only when actually strafing toward the ball */
export const INTAKE_SIDE_MIN_STRAFE = 8; // in/s
/** forward speed above which a FLAT (vector) intake driven into a CLUMP scatters
 * it instead of vectoring it in: the non-compliant wheels + impact force push the
 * pile away. Below this a controlled approach still intakes normally. Wedge
 * (sloped/triangle) funnels are immune — they devour clumps by design. */
export const INTAKE_RAM_SPEED = 32; // in/s

export const HOPPER_CAPACITY = 3;

// --------------------------------------------------------------- turret ----
/** turret center as a fraction of chassis length behind the center of
 * rotation — scales with the chassis so the turret never overhangs it */
export const TURRET_OFFSET_FRAC = -1 / 6; // 18in chassis -> 3in behind center
/** base hood angle; the solver steepens it up close so every distance has an
 * exact ballistic solution into the opening — the robot never misses */
export const LAUNCH_ANGLE = (55 * Math.PI) / 180;
export const LAUNCH_ANGLE_MAX = (80 * Math.PI) / 180;
export const LAUNCH_ANGLE_MARGIN = (14 * Math.PI) / 180; // above line-of-sight
export const LAUNCH_HEIGHT = 12; // in, muzzle height
export const LAUNCH_MAX_SPEED = 320; // in/s
/** no flywheel spin-up model — shots are limited only by this cadence */
// firing cadence lives per intake preset: INTAKE_PRESETS[*].fireInterval
/** fraction of chassis velocity inherited by the launched ball. The turret's
 * aim solver lead-compensates for it, so shooting on the move is accurate. */
export const SHOT_ROBOT_VEL_INHERIT = 0.5;

// ----------------------------------------------------------------- goal ----
/** GOAL footprint: a right triangle tucked into the far corner with its legs
 * flush along the two walls. Measured from the manual's "Top View Goal Opening
 * Inside Dimensions" (Section 9): GOAL_FACE_WIDTH runs along the far wall,
 * GOAL_DEPTH down the side wall; the hypotenuse is the FACE the robots shoot
 * at, and the DEPOT tape runs flush along it. The face is therefore NOT at 45°.
 * See goalTriangle / goalFaceNormal / goalLineValue in field.ts. */
export const GOAL_FACE_WIDTH = 26.5; // in, leg along the far wall
export const GOAL_DEPTH = 18.3; // in, leg down the side wall
export const GOAL_FACE_LEN = Math.sqrt(GOAL_FACE_WIDTH ** 2 + GOAL_DEPTH ** 2); // ~32.2 (hypotenuse/face)
export const GOAL_OPENING_Z = 38.75; // in, height of the opening lip
export const GOAL_WALL_TOP = 37; // flights below this bounce off the goal face
export const GOAL_OPENING_RADIUS = 11; // in, effective entry radius at the plane

// ----------------------------------------------------- classifier / gate ----
export const RAMP_SLOTS = 9;
/** classifier channel along the side wall (robot obstacle), running from the
 * gate all the way into the far corner behind the goal */
export const CLASSIFIER_W = 6; // strip width from the wall
export const CLASSIFIER_Y0 = 2; // gate end (y)
export const CLASSIFIER_Y1 = FIELD_HALF; // reaches the far wall corner
export const RAMP_RAIL_INSET = 3; // ball rail distance from the wall
export const RAMP_SURFACE_Z = 10; // drawn height of balls on the ramp
export const OVERFLOW_Z = 13.5; // overflow rolls over the retained balls

// goal basin (inside the triangular goal structure)
export const BASIN_FLOOR_Z = 14; // funnel floor height inside the goal
export const BASIN_RESTITUTION = 0.4; // vertical bounce off the funnel floor
export const BASIN_WALL_RESTITUTION = 0.55; // lively caroms off the goal walls
export const BASIN_FUNNEL_ACCEL = 1150; // in/s^2 pull toward the classifier entrance (drains the basin briskly so balls don't clog)
/** the funnel only really grips slow balls — fast ones carom around first */
export const BASIN_FUNNEL_GRIP_SPEED = 360; // in/s (higher ⇒ funnels sooner, less caroming)
export const BASIN_DAMPING = 1.1; // 1/s horizontal velocity damping (settles onto the funnel faster)
/** tangential (orbital) velocity damping about the funnel throat, 1/s. High so
 * balls SPIRAL straight into the classifier instead of circling the throat —
 * the goal footprint is a triangle, not a bowl, so there is no round basin for
 * them to orbit. This is what stops the "circular jumble". */
export const BASIN_TANGENT_DAMPING = 6; // 1/s
export const BASIN_ENTRY_RADIUS = 10.5; // in, hand-off distance to the rail (wider catch = fewer balls milling at the mouth)
export const BASIN_ENTRY_KEEP_V = 0.45; // entry velocity retained (splash energy)

// classifier rail (1D flow, contact stacking)
export const RAIL_S_MAX = 55; // rail length: SQUARE at the top (y = CLASSIFIER_Y0 + s), at the goal's inner exit
export const RAIL_ACCEL = 80; // in/s^2 down-ramp
export const RAIL_TERMINAL = 46; // in/s max flow speed
export const RAIL_PITCH = 5.1; // ball contact spacing on the stack
export const GATE_STOP_S = 2; // lowest rest position against the closed gate
// entrance blocked only while a ball is still within ~one pitch of the top entry
// (s = RAIL_S_MAX = 55); was 43.4, which forced each ball to flow 11.6" clear
// before the next could board — throttling the drain to ~2 balls/s and clogging
// the basin. One pitch below the entry keeps proper spacing but drains ~2× faster.
export const RAIL_ENTRY_BLOCK_S = 50;
export const RAIL_EXIT_S = -4; // past the gate: ball drops out to the floor
/** how much two artifacts may overlap at the gate's mouth before the drain treats it as
 * occupied. A little slack, because the artifact that just left is still sitting in the
 * doorway for a tick or two and the column should follow it out, not stall behind it. */
export const EXIT_QUEUE_SLOP = 1.5; // in
export const OVERFLOW_FLOW_SPEED = 58; // in/s, overflow rides over everything (clears a full goal quickly)
/** lateral/vertical glide rate as a ball settles onto the rail line */
export const RAIL_BLEND_SPEED = 30; // in/s

export const GATE_OPEN_HOLD = 0; // s of push before the gate arm starts to lift. ZERO so the lift (and the handle-collider retract that rides on it, see gateColliderPos) begins on the very tick you contact it — no debounce means no jam against the closed stub. The push gate (pushingGate: a STRAIGHT ram, not a graze) already prevents accidental opens.
/** a TOUCH commits the arm open and LATCHES it up for this long, so the driver does
 * NOT have to keep pressing to hold it open — a tap lifts it fully and it stays up a
 * beat. After the latch lapses (and no artifact is streaming under it) gravity swings
 * it shut as before, so it still "may or may not stay open" a moment longer. */
export const GATE_OPEN_LATCH_S = 0.5; // s the arm stays latched open after a tap (then it swings shut)
/** once open, gravity/flow decide re-close: it can only fall while no ball occupies
 * the gateway (a ball streaming under the arm physically holds it up) */
export const GATE_CLOSE_CLEAR_LO = -4;
export const GATE_CLOSE_CLEAR_HI = 4.5;
/** GATE as a PHYSICAL push-to-open arm (manual 9.8.3): a robot shoves the arm the
 * ~2in open, and it is "closed by gravity" — after release it does NOT snap shut but
 * SWINGS closed, starting slow and accelerating (a hinged arm falling), so a tap
 * "may or may not stay open" long enough to clear the ramp. `gatePos` is the arm's
 * physical open fraction 0 (down/closed) .. 1 (fully lifted); `gateVel` is its swing
 * rate. `gateOpen` (a ball can pass) is DERIVED = gatePos >= GATE_PASS_FRAC. */
export const GATE_OPEN_RATE = 10; // 1/s: BASE lift rate for a gentle push (light nudge still eases the arm open over several ticks)
/** the lift rate SCALES with how hard you ram the handle (ramSpeed = in/s toward the
 * wall): rate = GATE_OPEN_RATE + GATE_OPEN_RATE_SPEED·ramSpeed, capped at
 * GATE_OPEN_RATE_MAX. A near-full-speed ram lifts the arm ~fully in a single tick, so
 * the physical handle collider — which ANTICIPATES this same lift (gateColliderPos in
 * goal.ts, fed into buildGateArms) — is already out of the drivetrain's path the instant
 * you touch it: it "opens faster the harder you drive into it", with no bounce-off jolt. */
export const GATE_OPEN_RATE_SPEED = 1.2; // extra 1/s of lift per in/s of ram speed
export const GATE_OPEN_RATE_MAX = 66; // 1/s cap (~fully open in one tick at a hard ram)
export const GATE_GRAVITY = 22; // 1/s^2 on gatePos: gravity swinging the released arm shut
export const GATE_CLOSE_MAX = 9; // 1/s: terminal swing speed as it falls closed
export const GATE_PASS_FRAC = 0.4; // arm must be at least this lifted for an ARTIFACT to pass
export const GATE_DISPLACE = 2; // in, real closed->open horizontal displacement (manual 9.8.3)
/** the gate is a class-1 LEVER (manual Figure 9-15) hinged at the CLASSIFIER EDGE — where
 * the gate-zone tape starts (|x| = FIELD_HALF − CLASSIFIER_W = the classifier's field-side
 * rail). It has TWO arms about that pivot:
 *  - a SHORT handle that sticks OUT of the classifier into the field, along the gate-zone
 *    tape — this is what a robot pushes, and the small part that pokes into the open field;
 *  - a LONG paddle that lies ACROSS the channel to the far (WALL) edge, COVERING the
 *    artifacts stacked in the channel.
 * Pushing the handle SWINGS the lever: the long paddle LIFTS off the artifacts (releasing
 * them). Drawn top-down by FORESHORTENING each arm toward the pivot as it lifts
 * (`proj = len·cos(gatePos·GATE_LIFT)`); the long paddle greens as it clears the channel. */
export const GATE_ARM_LONG = CLASSIFIER_W; // in, long paddle: pivot → wall edge (covers the 6in channel)
export const GATE_ARM_SHORT = 2.5; // in, short handle poking past the field edge into the gate zone
export const GATE_LIFT = 1.35; // rad (~77deg) the paddle swings up from closed to fully open
/** the handle is a PHYSICAL one-way door: a solid robot collider spanning the SHORT arm's
 * (foreshortened) field-side reach, so a robot CANNOT strafe/drive through it — the only
 * way past is to OPEN it (a straight push, which lifts gatePos and RETRACTS the handle
 * toward the pivot, so the opening robot glides in rather than being shoved back). The arm
 * is LIGHT: it never shoves a resting robot because a robot touching the OPEN gate holds
 * it open (touch-hold in updateGates), so it doesn't swing closed against you. The long
 * paddle needs no collider — it lies over the already-solid classifier channel. Robot-solve
 * ONLY (not the ball solve): released artifacts still roll out beneath the lifted paddle. */
export const GATE_ARM_THICK = 3; // in, physical thickness (y) of the handle collider
/** the gate does NOT open just because a robot LOITERS in the zone — the arm is a
 * push-to-open mechanism, so the robot must actively PRESS toward it. Detected as
 * a velocity toward the arm (ramming it) OR a drive command toward it (leaning on it
 * while stalled against the classifier, where velocity reads ~0). */
export const GATE_PUSH_MIN_SPEED = 6; // in/s toward the arm to open by driving into it
export const GATE_PUSH_MIN_CMD = 0.35; // drive-command component toward the arm to hold it open
/** gate zone tape in front of the gate: 10in from the wall at y ~ 0 */
/** gate INTERACTION rect (a robot overlapping it works the gate). The tape
 * marking on the mat is drawn separately — see GATE_TAPE_* / gateTapeSegments */
export const GATE_ZONE = { xNear: 62, xFar: 72, y0: -2, y1: 3 };
/** the physical GATE ARM's contact footprint at the channel mouth (`gateArmRect`).
 * A robot whose bumper reaches within GATE_ARM_REACH of the classifier face here is
 * TOUCHING the gate — the trigger for G417 (touching an opponent's gate, even
 * without opening it, is a MAJOR) and the contact half of the push-to-open test.
 * Kept TIGHT around the actual lever handle (which pokes GATE_ARM_SHORT into the field,
 * centered on GATE_TAPE_Y): NOT a big loitering region — a robot must be against the arm. */
export const GATE_ARM_REACH = 3; // in, field-side reach past the classifier edge (~ the handle)
export const GATE_ARM_Y0 = -2; // mouth band edges, centered on the lever (GATE_TAPE_Y = 0.5)
export const GATE_ARM_Y1 = 3;
/** official GATE ZONE marking (manual Section 9): a 2.75in-wide x 10in-long
 * volume bounded by TWO parallel alliance-colored tape LINES, 10in long,
 * running perpendicular to the side wall (into the field), spaced 2.75in
 * apart and centered on the gate. GATE_ZONE above is the (larger, undrawn)
 * interaction rect that actually works the gate. */
export const GATE_TAPE_W = 2.75; // spacing between the two lines (zone width)
export const GATE_TAPE_LEN = 10; // line length, into the field from the wall
export const GATE_TAPE_Y = (GATE_ZONE.y0 + GATE_ZONE.y1) / 2; // gate center y
/**
 * Where the classifier STRUCTURE ends — at the GATE, not past it.
 *
 * The ramp used to be modelled all the way down to `GATE_ZONE.y0`, about 3in beyond the
 * gate line, so its side rails stuck out into the SECRET TUNNEL ZONE and a robot coming up
 * the wall hit ramp instead of gate. Figure 9-16 (GATE Actuation) is a side elevation of
 * exactly this: the structure ends at the pivot mount and only the LEVER extends past it.
 * The zone definition says the same thing from the other side — the tunnel is "bounded by
 * ... the GOAL assembly", so the assembly stops where the tunnel starts.
 *
 * The arm still protrudes (that is what a robot pushes), but it is a separate, retractable
 * collider — `decodeGateArms` — not part of the ramp's footprint.
 */
export const CLASSIFIER_GATE_Y = GATE_TAPE_Y;
/** where released/overflow balls emerge onto the floor, on the goal's wall */
export const TUNNEL_EXIT = { x: 68, y: -3 };
/** gate-release exit velocity. Kept GENTLE (low `along`): a big forward push
 * plows the whole drain out in a straight conga line. With little momentum the
 * front balls stall on friction and the ones behind carom off them, so the
 * drain fans out across the floor instead of running linear. */
export const TUNNEL_EXIT_VEL = { along: 22, inward: 8 }; // toward audience, off the wall

// ---------------------------------------------------------------- zones ----
/** small audience-side launch zone: apex (0,-48), base 2 tiles on the wall */
export const AUD_ZONE_APEX_Y = 48;
export const AUD_ZONE_HALF_W = 24;

/** BASE ZONE: 18x18 with its outer corner at the tile intersection
 * (driverSide*24, -48), extending inward — center (driverSide*33, -39).
 * Diagonally opposite corners (driverSide*24,-48) and (driverSide*42,-30),
 * per the manual Figure 9-3 (measured on-field). */
export const BASE_CENTER = { x: 33, y: -39 };

/** loading zone: 23x23 audience corner on the drive-team side */
export const LOAD_ZONE_SIZE = 23;

/** loading-zone artifact layout (driverSide-relative in x; y is audience-anchored).
 * The GRAB ROW is the 3 pre-staged artifacts, in a row along field-x (which reads
 * vertical on the driver's rotated screen) so a robot sweeps all 3 driving along x.
 * The 2x3 BOX is the human player's out-of-play storage, tucked into the audience
 * corner behind the grab row. */
export const LOAD_COL_XS = [51, 58, 65] as const; // 3 grab-row columns (clear of the corner pre-stage)
export const LOAD_ROW_Y = -65; // grab row y — ~7in in front of the audience wall (y=-72)
// the box is OFF the field (the human player stands off-field): its two rows sit
// well beyond the audience wall (y < -FIELD_HALF) with a clear gap from it, aligned
// below the grab row. This "beyond the audience wall" direction maps to the screen's
// horizontal axis, which has slack past VIEW_MARGIN on landscape windows, so the box
// stays on-screen without shrinking the field.
export const LOAD_BOX_YS = [-80, -85] as const;

/** depot band: floor in front of the goal face, out to the ~30in depot line
 * (the line spans the goal face base — endpoints are the face corners pushed
 * DEPOT_DEPTH out along the face normal, giving the manual's ~30in length) */
export const DEPOT_DEPTH = 6; // perpendicular depth of the band
/** SECRET TUNNEL ZONE (manual Section 9): ~46.5in long x ~6.125in wide floor
 * band along the side wall from the gate toward the audience, bounded by
 * alliance-colored tape. Belongs to the alliance whose DRIVE TEAM is on that
 * wall — i.e. the OPPOSING alliance to the goal above it (its released
 * artifacts roll out here, cross-court from that goal's own drivers). */
export const TUNNEL_STRIP_LEN = 46.5;
export const TUNNEL_W = 6.125; // strip width from the wall

/** spike marks: 10in horizontal white tape, three per side in a column just
 * ONE tile from each side wall (column center ~23.5in off the wall — value
 * re-verified against the Section 9 markings figure July 2026; an older
 * comment claiming "two tiles" was wrong, the VALUE was right); balls sit in
 * a row on the mark */
export const SPIKE_COL_X = 48.5;
export const SPIKE_ROW_YS = [-35.5, -12.8, 11.1]; // near, middle, far
export const SPIKE_BALL_SPACING = 5.6;
export const SPIKE_MARK_LEN = 10;

/** named quick-pick robot start poses. Every preset is a LEGAL G304 setup
 * (over a LAUNCH LINE, touching the GOAL or the FIELD perimeter, fully inside
 * the alliance's own half). Coordinates + headings are authored for goalSide=+1
 * (red); the spawn helper mirrors them for blue. Headings are degrees in the
 * field frame. Index = the menu/lobby "start position" quick-pick; a player may
 * also drag a fully CUSTOM pose (validated against the same G304 rule).
 * NOTE: these were re-authored July 2026 to satisfy G304 — the old poses sat
 * mid-launch-zone, touching nothing, which is NOT a legal setup. */
// Semantic ANCHORS (canonical goalSide=+1 / red frame) resolved per-chassis by
// presetPose. Authored so BLUE displays the intended headings (270 is mirror-
// invariant; canonical 0 shows as 180 for blue). NOTE: index 0 and 1 must sit far
// apart — a 2-robot alliance spawns its two slots at indices 0/1 (smoke-checked).
export type StartCategory = 'close' | 'far';
export const START_POSES = [
  { x: 58, y: 48.5, headingDeg: 270, label: 'GATE', cat: 'close' }, // goal, gate end, facing the audience
  { x: 31.25, y: -63.75, headingDeg: 0, label: 'AUDIENCE', cat: 'far' }, // audience corner: tucked toward the loading zone, on the tape, against the back wall
  { x: 48, y: 57, headingDeg: 270, label: 'GOAL', cat: 'close' }, // in front of the goal (far-wall end), x=48 fixed, facing the audience
  { x: 53.25, y: 54.25, headingDeg: 55, label: 'INTAKE', cat: 'close' }, // intake flush on the goal face, a corner at the tape↔classifier point
  { x: 55, y: 56.75, headingDeg: 235, label: 'BACK', cat: 'close' }, // back flush on the goal face, a corner at the tape↔classifier point
] as const;
/** how many of the player's OWN custom start positions per category (close/far) */
export const MAX_SAVED_STARTS = 2;

/**
 * The same cap for a SUPPORTER — one of the membership's convenience perks.
 *
 * Two rules follow from this being a PAID tier, and both matter more than the
 * number itself:
 *
 *  1. SANITIZE against this, never against the free cap. `coerceSettings` slices
 *     the saved list on every load, and slicing to 2 would silently DESTROY a
 *     supporter's poses on any load where the entitlement had not resolved yet,
 *     and again the moment a membership lapsed. Data loss is not an acceptable
 *     way to say "your subscription ended", so the PERSISTED ceiling is always
 *     the high one and only the Save button respects the entitlement.
 *  2. It is deliberately NOT enforced server-side. Hand-editing localStorage to
 *     get six slots is possible and fine: this is a convenience that cannot
 *     affect how a robot drives or scores (product rule, and the terms say so),
 *     and there is nothing here worth defending with a round-trip.
 */
export const MAX_SAVED_STARTS_SUPPORTER = 6;

/** G304 "touching the GOAL or FIELD perimeter" slack (inches): a start pose
 * whose footprint is within this of the goal face or a wall counts as touching.
 * Also the snap distance the drag editor uses to pull a robot onto a surface. */
export const START_TOUCH_TOL = 1.25;

/** how far a start footprint may sink into a solid STRUCTURE (goal wedge /
 * classifier channel) before it counts as penetrating rather than resting
 * against it — a small collision-box tolerance so "flush on the goal" is legal
 * but "inside the goal" is not. */
export const START_PEN_SLOP = 0.75;

// --------------------------------------------------------- human player ----
export const HP_PLACE_DELAY = 0.15; // s between placements from the box into the grab row (fast HP)
/** the alliance-area pool is two 3-ball preload sets (4P+2G total); each present
 * robot takes one, and any leftover sets seed the human-player box (spawn.ts hpBox) */
export const PRELOAD: readonly ('purple' | 'green')[] = ['purple', 'green', 'purple'];
export const HP_INITIAL_STOCK: readonly ('purple' | 'green')[] = ['purple', 'purple', 'green'];

// -------------------------------------------------------- robot presets ----
/** how many of the player's OWN robots / autos they can keep in their library */
export const MAX_SAVED_ROBOTS = 3;
export const MAX_SAVED_AUTOS = 4;

/** real FTC team BUILDS covering the archetype matrix; the menu also offers a
 * fully custom builder. Picking a preset copies its BUILD only — the player's
 * name/team/number are their own. The first entry (TW) is the DEFAULT_SPEC build
 * a new player starts with. */
export const ROBOT_PRESETS: readonly RobotSpec[] = [
  {
    name: 'TW', teamName: 'Turtle Walkers', teamNumber: 19745,
    length: 14.5, width: 16.5, intake: 'sloped', massLb: 23.5, drivetrain: 'mecanum',
    driveRpm: 440, flywheelInertia: 0.7, canSort: false,
  },
  {
    name: 'Dugtrio', teamName: 'Blu Cru', teamNumber: 6417,
    length: 15, width: 18, intake: 'sloped', massLb: 36, drivetrain: 'tank',
    driveRpm: 340, flywheelInertia: 0.9, canSort: false,
  },
  {
    name: 'Cypher', teamName: 'Seattle Solvers', teamNumber: 23511,
    length: 14, width: 14, intake: 'vector', massLb: 23.5, drivetrain: 'swerve',
    driveRpm: 500, flywheelInertia: 0.1, canSort: false,
  },
  {
    name: 'Rohan', teamName: 'Exodus', teamNumber: 30030,
    length: 13, width: 17.5, intake: 'triangle', massLb: 34, drivetrain: 'mecanum',
    driveRpm: 395, flywheelInertia: 0.8, canSort: false,
  },
  {
    name: 'Ditto', teamName: 'Galactic Narwhal Chicken Effect - Diamond', teamNumber: 22489,
    length: 14.5, width: 16, intake: 'vector', massLb: 28, drivetrain: 'mecanum',
    driveRpm: 450, flywheelInertia: 0.9, canSort: false,
  },
] as const;

// ------------------------------------------------------------------ sim ----
// 60 Hz fixed timestep. Lower than 120 so weaker browsers can sustain it (in
// lockstep multiplayer everyone is coupled to the slowest peer) and so the
// 8-tick INPUT_DELAY buffer covers ~133 ms of latency. step() is dt-parameterized
// (physics scales with dt), so this stays deterministic across peers.
export const SIM_DT = 1 / 60;
export const MAX_STEPS_PER_FRAME = 5;
/** Angle tolerance (radians) for heading alignment between path segments.
 * If the difference between the robot's current heading and the next segment's
 * start heading is greater than this, the robot will rotate to align. */
export const ALIGNMENT_ANGLE_TOLERANCE = 0.02; // ~1.1 degrees
/** Rotational speed (radians/second) for heading alignment. */
export const ALIGNMENT_ROTATIONAL_SPEED = 3.0; // rad/s

// ------------------------------------------------------------ rendering ----
export const COLORS = {
  /** letterbox around the field — tracks `--ds-bg` in shell.css, per THEME.
   * The field mat NEVER themes: the board reads as a physical object sitting on
   * the floor, and its outline keeps it separated even when the floor goes dark
   * (`backdropDark` #20262c vs `mat` #23262b is only 1.03:1 on fill alone). */
  backdrop: '#f9faf7',
  backdropDark: '#20262c',
  mat: '#23262b',
  tile: '#2c3038',
  wall: '#4b5563',
  red: '#ef4444',
  redDim: 'rgba(239,68,68,0.10)',
  blue: '#3b82f6',
  blueDim: 'rgba(59,130,246,0.10)',
  white: '#e5e7eb',
  purple: '#a855f7',
  green: '#22c55e',
  launchTint: 'rgba(229,231,235,0.05)',
} as const;

/**
 * Supporter cosmetic: the robot's CHASSIS FILL.
 *
 * Scoped to the fill on purpose. A robot's alliance is carried entirely by its
 * OUTLINE (`COLORS.red` / `COLORS.blue` — see `drawRobot`), and the fill has
 * always been one flat `#1f242c`. Recolouring only the fill therefore cannot make
 * a red robot read as blue, which is the one thing a cosmetic must never do in a
 * game where you identify targets at a glance.
 *
 * An ALLOWLIST rather than a free hex picker, for three reasons that all matter
 * more than the extra choice would:
 *  - sanitizing a free colour string means parsing untrusted CSS on the wire;
 *  - every entry is chosen dark enough to keep the alliance outline readable
 *    against it, and distinct from the mat (#23262b) and tile (#2c3038) so a
 *    robot never camouflages into the field;
 *  - nobody can pick the artifact green/purple and fake a scoring element.
 *
 * The KEY is what goes over the wire and into replays, never the hex — so these
 * values can be retuned later without invalidating a single saved robot.
 */
export const CHASSIS_COLORS = {
  default: '#1f242c',
  slate: '#374151',
  plum: '#3b2b45',
  moss: '#25382c',
  rust: '#452b25',
  navy: '#1f2d45',
  cocoa: '#3a2f28',
} as const;

export type ChassisColor = keyof typeof CHASSIS_COLORS;
export const CHASSIS_COLOR_KEYS = Object.keys(CHASSIS_COLORS) as ChassisColor[];

/** the chassis fill for a spec — the default for everyone without the perk, and
 *  for any key an older or spoofed spec carries that we no longer recognise. */
export function chassisFill(key: string | undefined): string {
  return (key && CHASSIS_COLORS[key as ChassisColor]) || CHASSIS_COLORS.default;
}
export const VIEW_MARGIN = 14; // in of world margin around the field when fitting (just clears the obelisk)

// ------------------------------------------------------------ off-field ----
/** ALLIANCE AREA: taped drive-team rectangle OUTSIDE each alliance wall
 * (red left, blue right). Runs from the audience wall toward the far wall —
 * NOT wall-centered (verified from the Section 9 figures). */
export const ALLIANCE_AREA_ALONG = 96; // in along the wall
export const ALLIANCE_AREA_DEEP = 54; // in outward from the wall
