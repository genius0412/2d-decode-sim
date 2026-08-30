import type { DrivetrainType, RobotSpec } from './types';

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
export const BALANCE_VERSION = 4; // 2: real-motor drivetrain retune (torque–speed curve + mecanum losses)
// 3: swerve wobble ↓ + faster turning (REF_TURN 8.5 / cap 12) + tank control-style at input layer
// 4: robot-on-robot pushing rebuilt — push is a stated FORCE and the collider mass is derived
//    from it, so weight, gearing and power draw each act ONCE instead of cancelling or landing
//    twice (a 250 rpm minimum-weight mecanum used to out-push a 42 lb 435 rpm tank). Every
//    head-to-head outcome moves, and the stiffer robot contact moves solo record scores too.
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
 * ALPHA HOLDS AT 2 AND STAYS THERE. Alpha's whole divergence from main is ONE unreleased
 * batch, so it is ONE step past main's 1 — bumping again for each change inside that batch
 * just churns a number nobody can act on, and invalidates alpha replays for no gain. Bump
 * this again only when MAIN moves, or when alpha ships.
 *
 * 1: sim-reachable Math.hypot -> hyp (engine-independent; see src/math.ts) — MAIN is here.
 * 2: the alpha batch, everything below, which all moves `step()` output:
 *    · CR butterfly drivetrain / twin turret / catalyst mechanisms / corner geometry /
 *      start legality;
 *    · DECODE's G418.B fix — a gate tap no longer bills the standing ramp column;
 *    · ROBOT-ON-ROBOT PUSHING rebuilt: the shove is a stated FORCE with the collider mass
 *      derived from it (`pushForce`/`shoveMass`), so weight, gearing and power draw each act
 *      once instead of cancelling or landing twice; a shoved chassis gets a real two-body
 *      contact impulse, so an off-centre hit spins it; the press scaling every robot-robot
 *      response is the pair's CLOSING velocity, not each robot's absolute one; a robot held
 *      against a surface by an opponent feels that load; an auto-path robot is solid instead
 *      of intangible; pair and static responses are summed before either is written; and
 *      contacts are stiffer (PHYS_CONTACT_FREQ 8 -> 12);
 *    · G422 PINNING rewritten against the rule's own clauses — "preventing the movement"
 *      requires the pinner to be IN THE WAY of where the victim is trying to go, "attempting
 *      to move" reads side-drive so a tank can be pinned at all, the count ends only on
 *      criteria A/B/C (pausing and resuming rather than dying on a 0.6 s lapse), and it bills
 *      a MINOR every 3 s instead of one MINOR with an invented MAJOR escalation;
 *    · G408 OVER-POSSESSION rewritten against DECODE's CONTROL definition instead of an FRC
 *      POSSESSION and an invented TRAPPING (neither term is in this manual). Control is
 *      ACQUIRED by herding — a flat-or-concave face, the robot moving the artifact a real
 *      DISTANCE in the push direction, sustained past the confirm window — and LATCHES while
 *      contact holds, so a pile driven into the wall keeps counting while one already resting
 *      there never starts. An established hold keeps counting while it DRAINS, because
 *      artifacts bounce off a bumper rather than riding it. The mouth carve-out is capped at
 *      what the rollers take in one cycle rather than at hopper room, the loading-zone
 *      carve-out is scoped to a robot actually in there, an excused artifact conducts the
 *      transitive chain without being counted, and the per-artifact clocks are swept and
 *      cleared outside auto/teleop;
 *    · PENALTIES ARE ASSESSED IN FREE DRIVE — `freeplay` is a live phase everywhere else in
 *      the sim, and `updatePenalties` was the one place that excluded it.
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
/**
 * G422, verbatim, because every constant below is a clause of it:
 *
 *   "There is a 3-count on PINS. A ROBOT may not PIN an opponent's ROBOT for more than 3
 *    seconds. A ROBOT is PINNING if it is preventing the movement of an opponent ROBOT by
 *    contact, either direct or transitive (such as against a FIELD element) and the opponent
 *    ROBOT is attempting to move. A PIN count ends once any of the following criteria below
 *    are met:
 *      A. the ROBOTS have separated by at least 2 ft. (~61 cm) from each other for more than
 *         3 seconds,
 *      B. either ROBOT has moved 2 ft. from where the PIN initiated for more than 3 seconds, or
 *      C. the PINNING ROBOT gets PINNED.
 *    For criteria A, the PIN count pauses once ROBOTS are separated by 2 ft. until either the
 *    PIN ends or the PINNING ROBOT moves back within 2 ft., at which point the PIN count is
 *    resumed. For criteria B, the PIN count pauses once either ROBOT has moved 2ft from where
 *    the PIN initiated until the PIN ends or until both ROBOTS move back within 2ft., at which
 *    point the PIN count is resumed.
 *    Violation: MINOR FOUL and an additional MINOR FOUL for every 3 seconds in which the
 *    situation is not corrected."
 *
 * Note what is NOT in it: any speed threshold, any requirement that the pinned ROBOT be against
 * a wall, and any escalation to a MAJOR. The sim had all three.
 */
export const PIN_SECONDS = 3;
/** "2 ft. (~61 cm)" — the separation in criterion A and the displacement in criterion B. */
export const PIN_ESCAPE_DIST = 24; // in
/** The pinned robot counts as "prevented from moving" while it is not gaining
 * ground AWAY from the pinner faster than this.
 *
 * Deliberately measured along the ESCAPE direction rather than as raw speed: a
 * robot being bulldozed sideways along a wall is moving fast and is still just as
 * pinned, and pausing the 3-count every time it slid was one reason real pins
 * almost never reached the threshold. */
export const PIN_STUCK_SPEED = 8; // in/s
/**
 * The PINNED robot must be trapped against a SOLID with the pinner on the open-field side: its
 * leading corner (straight away from the pinner) sits within this slop of the perimeter, a goal
 * wedge or a classifier channel.
 *
 * THE RULE DOES NOT REQUIRE THIS — a FIELD element is offered as an EXAMPLE of transitive
 * contact ("such as"), and direct contact alone can pin. It is kept because it is what breaks
 * the SYMMETRY of a shove: without something behind one of them, both robots are equally "in
 * contact, attempting to move, and going nowhere", and the sim has no referee to look at.
 *
 * It costs less than it looks. A pin with nothing behind the victim is a pin the victim is
 * being pushed ACROSS the field, and criterion B ends that as soon as either robot is 2 ft from
 * where it started — so the only open-field pin the rule would sustain is a stationary
 * stalemate, and a stationary stalemate is mutual, which criterion C ends anyway. What is left
 * uncovered is narrow: a robot wedged on another robot with open field behind it.
 */
export const PIN_WALL_SLOP = 3; // in
/**
 * How closely the pinner must lie along the direction the victim is TRYING to go, as a cosine.
 *
 * "Preventing the movement" means the pinner is in the way. Without this the sim fouled a robot
 * for standing behind an opponent who was driving itself into a wall under its own power — every
 * clause was satisfied (contact, attempting to move, going nowhere, trapped) and the opponent was
 * preventing nothing. Measured, the WEAKEST legal build "pinned" a default chassis that way.
 *
 * 0.34 is about 70 degrees either side: wide enough that a pinner does not fall out of it as the
 * pair rocks or as the victim saws at the stick, tight enough that somebody behind you while you
 * drive forwards is not pinning you.
 */
export const PIN_OBSTRUCT_COS = 0.34;
/**
 * "for more than 3 seconds" — how long criterion A or B must hold before the PIN is over.
 *
 * This replaces a 0.6 s lapse timer that ended a pin the moment the hold flickered for any
 * reason at all. The rule is far narrower and far more patient than that: only DISTANCE ends a
 * pin, and only after three full seconds of it. Everything else — the bumpers unloading for a
 * tick, the victim's stick crossing the dead zone, the wall probe slipping past its slop as the
 * pair rocks — merely PAUSES the count, which is exactly the flicker tolerance the 0.6 s timer
 * was reaching for, except that a pinner can no longer wipe a two-and-a-half-second count by
 * easing off for seven tenths of a second.
 */
export const PIN_END_S = 3; // s
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
 * How hard the robot has to be driving INTO an artifact, along the outward normal of the face
 * it is touching, to be "moving the SCORING ELEMENT in a preferred direction" (CONTROL clause
 * B). Measured with `robotPointVelocity`, so the ω×r term is in it and a robot TURNING a
 * corralled pile is moving it too.
 *
 * This replaced two ABSOLUTE-SPEED gates — POSSESSION_MOVE_SPEED (the robot moving at all,
 * 1.5 in/s) and POSSESSION_TURN_RATE (0.15 rad/s) — which came from an FRC POSSESSION
 * definition that is not in the DECODE manual. There is no speed floor anywhere in DECODE's
 * CONTROL, and those floors were exploitable from both ends: a six-artifact pile CREPT below
 * 1.5 in/s drew nothing over twelve seconds, while a pile jammed against the perimeter read as
 * uncontrolled precisely BECAUSE it could not move.
 *
 * It sits low on purpose. It is not a threshold for "is this a violation" — that is what the
 * confirm window and the station test decide — it is only there so numerical noise in a
 * resting contact cannot read as a push. Anything a driver would recognise as leaning on an
 * artifact clears it.
 */
export const POSSESSION_PUSH_MIN = 0.5; // in/s, along the contact normal
/**
 * ...and how far the ARTIFACT has to have actually TRAVELLED, from where this robot first got
 * hold of it, before the robot counts as MOVING it.
 *
 * Clause B is "the ROBOT is MOVING the SCORING ELEMENT in a preferred direction", and the verb
 * is about the artifact, not the wheels. Pressing on something that is going nowhere is not
 * moving it — which is the whole difference between herding a pile and running into one:
 *
 *   · a pile ALREADY resting on the perimeter cannot go anywhere, so driving into it is
 *     contact and nothing else. G408 names exactly this: "bulldozing (INADVERTENT contact with
 *     a SCORING ELEMENT while in the path of the ROBOT moving about the FIELD)";
 *   · nor can a clump you have nosed into far enough to jam. Both were reported — "if you drive
 *     into a pile to intake you get a penalty if you go in too far" and "you get a penalty if
 *     you drive into five balls that are ALREADY at the wall."
 *
 * IT HAS TO BE DISTANCE, NOT SPEED. An instantaneous-speed floor was tried first and does not
 * work, because artifacts do not RIDE a bumper in this sim — they bounce off it and are
 * re-struck, so contact is a train of micro-impacts and a pile jammed on a wall reads as moving
 * quickly while going nowhere at all. Measured, a speed floor at the ball's own rest threshold
 * still billed 6 MINORs for driving into five artifacts that were already on the wall. Net
 * displacement is immune: jitter cancels, travel accumulates.
 *
 * ONE BALL DIAMETER is the threshold because it is the one distance in the game that explains
 * itself — the artifact is no longer where you found it, by its own width. Compression and
 * squirt as a pile settles are well under it; anything you could call herding is well over.
 *
 * This gates ACQUIRING control only. Once herding IS established the latch holds it through a
 * jam, so driving a pile INTO the wall and leaning on it still counts — those artifacts
 * travelled on the way there. That split is the whole of the leniency: running into things is
 * free, taking them somewhere is not.
 *
 * The distance is CUMULATIVE and STICKY: it survives the artifact re-stationing on the chassis
 * and survives its hold clock dying, because ground already covered does not un-happen and
 * because a clump in open space is pushed in a series of bounces rather than one continuous
 * shove. It is cleared only when the artifact stops being a loose ground ball, or outside
 * auto/teleop.
 */
export const POSSESSION_CARRY_DIST = 5; // in — one artifact diameter, carried in the push direction
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
 * Cut 1 s -> 0.4 -> 0.2 s. G408 itself has no grace at all — control over the limit is a foul
 * the moment a referee sees it — and this sits on TOP of the per-artifact confirm, so it is
 * pure added latency before anything happens. The carve-outs are held by the confirm window
 * and the carry distance, not by this.
 *
 * 0.2 IS THE FLOOR. At 0.1 the bulldozing carve-out breaks: clipping an artifact in passing
 * starts to foul, which is the one thing G408 names first as NOT control. */
export const POSSESSION_GRACE = 0.2; // s
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
 * How often a CONTINUING over-possession is billed again.
 *
 * *** THIS IS A HOUSE RULE. G408 HAS NO CONTINUING CLAUSE. ***
 *
 * Its violation line is exactly "MINOR FOUL per SCORING ELEMENT over the limit. YELLOW CARD if
 * excessive." — one assessment, full stop. The omission is deliberate on the manual's part,
 * because the same manual writes the continuing clause three times over when it wants one, and
 * at this very interval:
 *
 *   G422 "MINOR FOUL and an additional MINOR FOUL for every 3 seconds in which the situation
 *         is not corrected."
 *   G423 the same sentence, verbatim.
 *   G434 "MINOR FOUL per ARTIFACT over the limit and an additional MINOR FOUL per ARTIFACT
 *         over the limit for every 3 seconds in which the situation is not corrected."
 *         — which is EXACTLY the shape this constant implements, on a rule that has it.
 *
 * It is kept because the alternative was measured and is worse: billed once per episode, the
 * whole tariff for gathering six artifacts and holding them was three MINORs, after which
 * hoarding them was free for the rest of the match. Reported as "the over-possession penalty
 * is way too lenient." Three seconds is at least the manual's own cadence for a continuing
 * foul, so the house rule borrows the number rather than inventing that too.
 *
 * SET THIS TO Infinity TO GET THE RULE AS WRITTEN — nothing else depends on the re-billing.
 */
export const POSSESSION_REBILL_S = 3;
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
 *
 * TOTAL TIME-TO-FOUL IS WHAT MATTERS, and it is this plus POSSESSION_GRACE plus however long
 * POSSESSION_CARRY_DIST takes to cover. Reported as "I still almost never get penalties" while
 * pushing about ten artifacts around — and measured, that push DID foul, but not until 1.43 s
 * of UNINTERRUPTED herding, which real driving (nudge, turn, adjust) rarely sustains. Trimmed
 * 0.65 -> 0.45 alongside GRACE 0.4 -> 0.2, taking the whole pipeline to 1.05 s with every
 * false-positive case still clean. It cannot go much lower: at GRACE 0.1 the bulldozing
 * carve-out breaks (clipping an artifact in passing starts to foul).
 *
 * This and POSSESSION_CARRY_DIST together are what make the rule LENIENT about running into
 * things. At 0.35 a robot nosing into a clump with its intake held was
 * fouled once it went in deep enough to jam: contact plus a fifth of a second is not enough to
 * tell "taking these somewhere" from "arriving among them". Swept against the full G408 case
 * matrix, 0.65 with a 5 in carry is the window where every case lands — below it the intake
 * cases foul, above it real herding starts slipping through.
 */
export const POSSESSION_CONFIRM = 0.45; // s, per artifact
/**
 * How long an artifact may sit in a RUNNING intake's mouth before it stops counting as
 * "being acquired" and starts counting as being PLOUGHED.
 *
 * The acquire carve-out is the manual's ("inadvertent contact ... while attempting to
 * acquire a SCORING ELEMENT") and it is real, but it used to be bounded by HOPPER ROOM,
 * which is the wrong axis entirely. An empty robot excused HOPPER_CAPACITY artifacts, and
 * a clump you would actually push around is 3-6 — so with the intake held, which is what a
 * driver does, ploughing one across open floor drew NOTHING at any size:
 *
 *     clump of   3   4   5   6   8
 *     intake ON  0   0   2   0   0
 *     intake off 0   1   6   5   7
 *
 * Time is the axis that separates the cases, because it is what "transporting" actually
 * means. An intake takes what is in its mouth in well under a second, so:
 *   · nose in, collect, back off  — contact is brief, excused, no foul;
 *   · clip a clump in passing     — briefer still, no foul;
 *   · push it across the field    — contact runs for seconds, and past this it counts.
 * Hopper room does not enter into it: a full robot ploughs exactly as hard as an empty one.
 */
// 0.4 -> 1.0: the window has to cover a real APPROACH, not just the swallow. A driver noses
// into a clump, the artifacts take a moment to reach the rollers, and the first one is in the
// hopper about a second later — measured, a 1.2s nose-and-back-off was fouling at 0.4. What it
// must NOT cover is herding, which runs for seconds, so a second is the honest split.
export const POSSESSION_ACQUIRE_S = 1.0; // s of grace per artifact in the mouth

/**
 * G408's YELLOW CARD, and the manual defines "excessive" rather than leaving it to taste:
 *   A. "simultaneous CONTROL of 5 or more ARTIFACTS", or
 *   B. "frequent (i.e., 3 or more separate violations in a MATCH), greater-than-MOMENTARY
 *      CONTROL of 4 or more ARTIFACTS."
 * (An earlier note here claimed the manual reads "3 or more separate MATCHES in a MATCH" and
 * called that a typo in the manual. It does not; it reads "violations". The implementation was
 * right and the citation was invented.)
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
export const BALL_BALL_RESTITUTION = 0.68;
export const BALL_GROUND_RESTITUTION = 0.45; // vertical bounce
export const BALL_BOUNCE_H_RETAIN = 0.8; // horizontal speed kept on ground bounce
export const GRAVITY = 386; // in/s^2
/** light foam ball off a heavy chassis: nearly inelastic — the ball inherits
 * the chassis surface speed but gains almost no extra bounce */
/**
 * How tall a robot is to an artifact in the air, in inches.
 *
 * An artifact BELOW this hits the robot; above it, it clears. It was two unnamed numbers (14
 * for the robot, 16 for the classifier) at the flight collision sites, which is fine until the
 * question "should this have gone over?" actually comes up.
 */
export const ROBOT_HEIGHT = 14;
/** the classifier structure stands a little proud of a robot */
export const CLASSIFIER_HEIGHT = 16;

/**
 * How much overlap with a chassis an artifact may end a tick with before it is treated as
 * JAMMED rather than merely in contact. Rapier's soft contacts leave about 0.2in, so this sits
 * clear of that and well under the ~1in of give the squeeze was exploiting.
 */
/**
 * How far a RESTING artifact may be shuffled by the constraint passes before the shuffle is
 * simply refused — the settle threshold.
 *
 * Artifacts packed into a corner cannot all fit without overlap, so the relaxation pass pushes
 * them apart, the wall clamp puts them back, and the pair trade positions forever: measured in
 * the loading-zone corner, 33 direction reversals per second on an artifact with 1.8in of net
 * movement to show for four seconds of it. Neither pass is wrong and neither can win, which is
 * the same shape as the wall-pinch jam rule — an overlap with no valid resolution is not a
 * reason to move something.
 *
 * So an artifact that is at REST, is not being pushed by a robot, and ends the tick within
 * this of where it started, ends it exactly where it started.
 */
export const BALL_SETTLE_SLOP = 0.2; // in
/**
 * How much of an artifact-artifact overlap the separation pass takes out per pass.
 *
 * It used to take out ALL of it, which is an overshoot as soon as anything else has a say:
 * against a wall the clamp puts the pair straight back and the two trade positions forever.
 * Correcting a FRACTION per pass converges instead — the passes are already a relaxation
 * loop (BALL_RELAX_PASSES), which is exactly the setting where a full correction rings and a
 * damped one settles. Measured on a robot pressing an artifact into a corner: 15 direction
 * reversals a second at 1.0, none at 0.5.
 */
export const BALL_SEPARATION_RELAX = 0.5;
/** peak tangential kick (in/s) a contact between two artifacts gets, equal and opposite. Two
 * spheres never meet dead centre; this is that offset, and it is where the drain's spread comes
 * from now that the exit no longer fans them. Deterministic — see `separateBalls`. */
export const BALL_CONTACT_SCATTER = 4; // in/s, the ceiling on that kick
/** ...as a fraction of the CLOSING speed. Two artifacts meeting hard glance off each other;
 * two barely touching do not, and treating those the same is a vibration rather than a
 * contact. */
export const BALL_CONTACT_SCATTER_FRAC = 0.25;
/**
 * How far an artifact will look ALONG a wall for a way out of a chassis, and at what
 * resolution — see `evictBallFromRobot`.
 *
 * An artifact pinched between a chassis and a wall cannot be pushed out the way it came, so
 * it squirts out sideways instead. The reach is what separates squirting out of a pocket from
 * being carried down a robot's whole flank: a corner's exit is an inch or two away, and a
 * 5in artifact must never make it through a 4.6in gap however long it is pushed. A radius
 * and a half covers every real wedge and nothing else.
 */
export const BALL_ESCAPE_REACH = BALL_RADIUS * 1.5; // in
export const BALL_ESCAPE_STEP = 0.25; // in, the resolution that search walks at

export const BALL_JAM_SLOP = 0.35;

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
export const BALL_RELAX_PASSES = 6;

// ------------------------------------------------- robot contact torque ----
/** per-tick angular correction cap from a single contact group (rad), at rest */
export const CONTACT_ALIGN_RATE = 0.03;
/**
 * How much deeper than its neighbours a contact must be before the neighbour stops bearing —
 * the bumper's compliance, in inches of squash.
 *
 * The load at each corner is shared by how far it is compressed, and this is the distance over
 * which that share falls to nothing. It replaces a flat bias floor, which handed load
 * to corners that were not touching at all: with two front corners whose lever arms differ
 * (the intake extends the front, so they are not mirror images), that fabricated vote can
 * outweigh the real contact and reverse the torque — "it's turning me the other way sometimes".
 */
export const CONTACT_COMPLIANCE = 0.5; // in
/** alignment speedup per in/s the robot pushes into the contact — holding
 * forward against a wall turns briskly, a fast hit swings hard */
export const CONTACT_PRESS_GAIN = 0.4;
/** hard cap on per-tick alignment under pressure (rad) */
/**
 * ...AND THE CEILING THAT GAIN CAN REACH. A contact must not out-turn the drivetrain.
 *
 * It was 0.12 rad — 6.9 degrees in ONE TICK, 412 deg/s — so a firm press quadrupled the base
 * rate into a snap: "it spins me around like 90 degrees instantly", "way too fast". At 0.05 the
 * worst single tick ramming a wall at speed is 2.9 degrees (174 deg/s), which is about what a
 * robot can turn itself, and a 20-degree tilt still comes flush in well under a second.
 */
export const CONTACT_ALIGN_RATE_MAX = 0.05;
/** spin injected per (contact torque × in/s of impact speed) — a fast angled
 * hit visibly converts momentum into rotation; dead-center hits add nothing */
/**
 * ...and the FLICK a fast angled hit adds on top, as angular velocity.
 *
 * Unlike the alignment this is not capped at the remaining tilt — it keeps turning the chassis
 * after the contact has done its work, which is what a violent hit should do and also what
 * makes a merely firm one feel violent. Halved and more with the align ceiling: ramming a wall
 * at speed peaked at 3.23 rad/s (185 deg/s of free spin) and now peaks at 0.80.
 */
export const CONTACT_IMPACT_SPIN = 0.05;
/**
 * Coulomb friction at a POINT contact — bumper against field structure.
 *
 * This is a real material constant, not a dial: it is what decides that catching a post with
 * your flank yaws you INTO it rather than away, because the post drags that side back. Rubber
 * bumper on polycarbonate/aluminium runs about 0.6-0.9.
 */
export const CONTACT_MU = 0.8;
/**
 * How close a second separating axis has to be to the least-overlapping one before it counts
 * toward the contact normal, in inches of overlap.
 *
 * SAT returns one axis, which is right in the middle of a face and ill-conditioned at a
 * CORNER — there two axes are within noise of each other and the normal flips between them as
 * the shapes slide a hair. The true normal at a corner is between the two faces that meet
 * there, so axes within this window are blended by how close they are to being the answer.
 * A quarter inch is about the depth a bumper compresses, and well under the size of any
 * feature this is used on.
 */
export const CONTACT_NORMAL_BLEND = 0.25; // in
/**
 * Restitution at a point contact. A bumper is there to absorb, so a robot pressing structure
 * does not bounce off it — zero is the honest value and anything above it reads as springy.
 */
export const CONTACT_RESTITUTION = 0;
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
/**
 * Rapier contact stiffness (Hz) for the ROBOT world, and the slack it resolves to.
 *
 * These were 8 Hz / 0.01 on the reasoning that SOFT contacts let a body starting deep inside
 * a wall (a spec change can grow the footprint under a parked robot) bleed out gently instead
 * of being ejected with a huge recovery velocity. The gentleness is real and worth keeping —
 * but 8 Hz was paying far more for it than the hazard costs. Measured, a max-push tank
 * holding an opponent against the wall sank the victim 1.22in into the wall and 1.50in into
 * itself: ~9% of a chassis, and visible.
 *
 * SWEPT, rather than argued about. Across 8/15/20/25/30/40/60 Hz the recovery velocity from
 * BOTH hazard cases — a robot seeded 2in inside the wall, and two robots seeded 6in
 * overlapped — came out at 0.0 in/s at every single setting, because Rapier's positional
 * correction here does not feed velocity. There is no explosion to buy off. What the sweep
 * did show is where the penetration stops improving: 1.22in at 8 Hz, 0.59 at 12, 0.55 at 15,
 * 0.49 at 25, and then it creeps back up past 30.
 *
 * 12 Hz, NOT the 25 the penetration curve would pick, and the slack is UNCHANGED. Everything
 * above 12 cost something else: 15 Hz broke the classifier-jitter ratchet, and 25 Hz also
 * broke two G408 possession checks and the wall-ram torque bound. 12 is the largest step with
 * no collateral, and it is worth roughly half the remaining penetration.
 *
 * THE ITERATION COUNT IS NOT A LEVER HERE. `PHYS_SOLVER_ITERS` is shared with the BALL world
 * (`makeWorld` parameterises the frequency and the slack but not the iterations), so raising
 * it moved artifact behaviour that has nothing to do with robots pushing each other.
 */
export const PHYS_CONTACT_FREQ = 12;
/** normalized allowed penetration error (× lengthUnit ⇒ inches): a little slack
 * so shallow resting contacts aren't fought every tick */
export const PHYS_ALLOWED_ERROR = 0.01;
/**
 * Post-solve speed ceiling for a robot, in in/s. A pure solver-explosion guard — see
 * `solveRobots`.
 *
 * ABSOLUTE, NOT A MULTIPLE OF THE ROBOT'S OWN TOP SPEED. It was `maxSpeed × 2`, which sounds
 * safer and is not: what sets a shoved robot's velocity is the PUSHER's speed, not its own, and
 * the legal envelope runs from 30.1 in/s (x-drive, 18 lb, 200 rpm) to 120.9 (tank, 560 rpm) —
 * so the slowest legal build's ceiling sat at 60.3, well BELOW what the fastest legal build can
 * legitimately shove it to. Measured, it fired on 27 of 65 ticks of a plain open-field push
 * with no wall and nothing over-constrained, throttling the push 12% and putting a
 * discontinuity in the rpm slider that has no physical cause.
 *
 * 300 in/s is ~2.5× the fastest thing that can exist here, so nothing a robot can do to another
 * robot reaches it, while the one genuinely over-constrained case still does: a chassis crushed
 * between a wall and an auto-path robot (kinematic, and it does not yield) left the step at
 * 959 in/s — six field widths a second — before this clamp.
 */
export const PHYS_MAX_ROBOT_SPEED = 300;
/**
 * How far a robot's footprint may sit outside the field before it is walked back in.
 *
 * The perimeter is a hard containment invariant for robots, the same way `clampBallPosToStatics`
 * is for artifacts — and it was only ever enforced by the solver, which is not enough now that a
 * robot on an AUTO PATH is a kinematic body that does not yield: a bystander crushed between one
 * and the far wall was driven 15.2in past it, with its reported velocity reading 0.00 the whole
 * time (Rapier's positional correction does not feed velocity), so no speed guard can see it.
 *
 * The slop matters. Ordinary soft contact leaves a chassis resting a little INTO a wall — 0.59in
 * at the worst measured shove — and a containment pass that fought that every tick is exactly
 * the two-passes-taking-turns failure the artifact solve had to be rebuilt to avoid. This sits
 * above the worst honest penetration and far below "outside the field", so it only ever acts
 * when the solver has already given up.
 */
export const PHYS_CONTAIN_SLOP = 0.75; // in
/**
 * How much of the robot-robot point impulse's ROTATION reaches the chassis.
 *
 * The impulse in `squareUpPair` is the textbook two-body contact solve, and only its rotation
 * is taken — Rapier owns the linear half, and its bodies are rotation-locked. That split is
 * what makes a shoved robot spin at all, and it also leaves the model without the two things
 * that relieve a SUSTAINED contact in reality: the bumpers slipping, and the rotating chassis
 * shoving the other robot aside. So a held pair settles into a frozen geometry and the torque
 * repeats, unrelieved, every tick.
 *
 * Unscaled that torque out-muscles the wheels outright, and — the part that makes it a defect
 * rather than a hard-but-fair matchup — it does so almost regardless of how hard the push is.
 * Measured at full stick against 2748 degrees of free rotation in five seconds: an x-drive
 * pusher FOUR AND A HALF TIMES weaker than its victim still held it to 103 degrees, the same
 * as a tank six times STRONGER. A torque that ignores how hard it is being applied is not a
 * torque.
 *
 * At 0.6 the weak pusher no longer arrests anybody (820 degrees, i.e. a real fight rather than
 * a handbrake) while an equal or stronger one still pins you, which is the honest outcome for
 * a full-force corner bulldoze. It costs the ram: a near-corner hit spins the victim 17.5
 * degrees rather than 28, still clearly graded by how far off centre you catch them. Raising
 * it back toward 1 restores the ram and brings back the weak-pusher handbrake; the real fix is
 * a contact that can slip, which is a bigger piece of work than this dial.
 */
export const CONTACT_PAIR_SPIN = 0.6;
/** friction between chassis and walls / other chassis — resists a pinned robot
 * sliding out of a squeeze (the old model squared-and-held; 0 let it squirt) */
export const PHYS_FRICTION = 0.7;
/** BALL contact stiffness (Hz) for the ball solve — stiffer than the robot world
 * (12 Hz), which let two grounded balls sit visibly overlapping for many ticks.
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

// --- PUSHING POWER ----------------------------------------------------------
/**
 * GEARING'S EFFECT ON SHOVE, and the band it is allowed to act over.
 *
 * Wheel torque is inversely proportional to the gearing, so a drivetrain geared for speed
 * has less of it to put into a shove: the factor is `REF_DRIVE_RPM / driveRpm`, clamped so
 * neither end of the rpm slider becomes the whole game. Over the sliders' 200-600 range the
 * raw ratio runs 2.175 down to 0.725, and the clamp bites only at the torquey end.
 *
 * IT IS APPLIED EXACTLY ONCE. `driveParams().accel` already carries its own `REF_DRIVE_RPM /
 * rpm` term, and because the sim pushes by SETTING VELOCITY the delivered force is
 * `collider mass × that accel` — so a gearing factor baked into the collider mass landed a
 * SECOND time and the spread came out 7.45x instead of 2.48x, which made the rpm slider a
 * stronger pushing lever than the drivetrain pick (a 250 rpm minimum-weight mecanum
 * out-pushed a 42 lb 435 rpm tank). `shoveMass()` in drivetrain.ts is the one place that
 * divides the accel back out; do not re-introduce a gearing, mass, or power-draw term here
 * without checking whether `accel` already has it.
 */
export const PUSH_RPM_MIN = 0.6;
export const PUSH_RPM_MAX = 1.8;

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
 * LATERAL GRIP — how much of a TURN the wheels can carry the chassis' momentum through, as a
 * fraction of that drivetrain's own traction limit.
 *
 * Turning while moving needs a sideways force of m·v·ω to bend the velocity around with the
 * heading. Where the wheels can supply it the robot CARVES: the velocity follows the nose,
 * which is what a tank does, because treads grip sideways as hard as they grip forward. Where
 * they cannot, the chassis keeps going the way it was pointed and slides through the turn,
 * which is what mecanum rollers actually do.
 *
 * The sim had no term for this at all. Velocity is integrated in the WORLD frame and the
 * heading turned out from under it, so every drivetrain side-slipped through every turn and
 * the motor model then dragged the leftover lateral component away at its own accel. On tank
 * that reads as being shoved sideways mid-turn — "when I drive straight and turn with tank, I
 * feel like I get shifted slightly in a weird way ... tank does not slide much because of its
 * very grippy treads."
 *
 * A fraction of the drivetrain's traction ceiling (accelMult × BASE_DRIVE_ACCEL), because that
 * ceiling already IS μ·g for its wheels. So the carve is not free: past what the tyres can
 * supply — fast enough, turning hard enough — the robot slides anyway, and it slides sooner on
 * omnis than on treads.
 */
export const LATERAL_GRIP: Record<DrivetrainType, number> = {
  // TREADS ARE NOT THE SAME SIDEWAYS AS FORWARD — they are BETTER. Forward the wheels roll and
  // the limit is drive traction; sideways the whole tread has to scrub across the tile, which
  // is why a tank cannot strafe at all. So its lateral ceiling is well above its drive one.
  tank: 1.8,
  swerve: 0.9, // proper wheels, but four of them steering
  butterfly: 0.7, // dropped onto its traction wheels
  mecanum: 0.45, // 45-degree rollers — they carry some of it and slide the rest
  xdrive: 0.3, // omnis at 45 degrees, the least grip of the four
};

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
/**
 * How close to the field boundary an artifact counts as PINNED against it, on top of its own
 * radius — the case a funnel intake cannot centre and takes anyway. See `updateIntake`.
 *
 * Small on purpose: this is "the artifact is against the wall", not "the artifact is near the
 * wall". A wedge preset that grabbed anything within a few inches of the perimeter would stop
 * being a funnel at all along the whole edge of the field.
 */
export const INTAKE_WALL_GRAB = 0.6; // in
/**
 * HOW MUCH OF ITSELF AN ARTIFACT MAY OVERLAP THE ROLLER FACE and still count as having landed
 * — the compliance lenience.
 *
 * The rule it bends: an artifact coming off the ramp needs adequate space ON THE GROUND to
 * land in, and only then can a robot take it. So the drop point has to be a full radius clear
 * of the intake, or there is nowhere for the artifact to be. The exception is the front edge
 * of the rollers: compliant wheels reach a little past themselves, so an artifact landing just
 * on that edge is drawn in rather than bounced. Only the FRONT gets this — an artifact cannot
 * half-land inside the side slopes or the chassis.
 */
export const INTAKE_CATCH_LENIENCE = 1.2; // in of the radius, at the roller face only
/**
 * How briskly an artifact resting on a robot's TOP slides off it, per tick of contact.
 *
 * A robot's top is a lid over a mess of mechanism, not a shelf — an artifact that lands on one
 * works its way off rather than parking there for the rest of the match. Added as a velocity
 * each tick it is up there, outward from the robot's centre, so the direction is simply where
 * it landed and nothing is invented. Small: it should look like the artifact easing off a
 * moving roof, not being flicked.
 */
/**
 * CHASSIS SPRITE: square corners, thin outline.
 *
 * The corners were rounded by 1.6in, which is a sixth of a chassis and reads as a pebble
 * rather than as the welded box an FTC frame is — and the collision box has square corners,
 * so the drawing was disagreeing with the shape it stands for. The outline is thinner for the
 * same reason: it is drawn INSIDE the footprint (see `strokeInside`), so every bit of width
 * it takes is width taken off the robot's own body.
 */
export const CHASSIS_CORNER = 0; // in, corner radius of the drawn chassis
export const CHASSIS_OUTLINE = 0.5; // in, its outline width — half what it was

export const ROBOT_TOP_SHED = 6; // in/s outward while it rides the top
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
/**
 * INTAKE ROLLER diameters, in mm to match how they are actually bought. The funnel presets
 * run a big 72mm compliant roller; the vector's wheel row is a smaller 48mm.
 *
 * The roller's FRONT FACE is the intake's reach — `footprintExtents` already puts the
 * collision front at `length/2 + reach` — so growing the diameter grows it BACKWARD into
 * the mouth and changes no physics at all. The wedges meet it at its axle, so the funnel
 * keeps a visible mouth in front of them.
 */
export const INTAKE_ROLLER_MM = { sloped: 72, vector: 48, triangle: 72 } as const;
/** fore-aft thickness of the gate-opener tab on each shaft end. A tab on a beam end, not a
 * slab: drawing it the full roller diameter made the front read as one solid block. */
export const INTAKE_OPENER_THICK = 0.9; // in
/**
 * ALPHA ONLY — a live pose readout (x, y, heading) on the in-match chip row.
 *
 * Added to settle a disagreement about geometry with measurements instead of argument: a
 * search over 792 robot poses found essentially none that could intake off the gate
 * outflow, and the user does it routinely, so the search is wrong somewhere and the pose
 * that works has to come from the game rather than from me guessing at it.
 *
 * MUST NOT REACH MAIN. This branch is never merged (standing rule in CLAUDE.md), but if
 * that ever changes, set this to false first — it is a debug overlay, not a feature.
 */
export const DEBUG_POSE_READOUT = true;
/**
 * The roller beam is covered in rollers ALONG ITS WHOLE LENGTH, out to the gate openers that
 * cap its ends — not a short stack in the middle.
 *
 * `wheelSpan = wedge ? throatHalf : mouthHalf` in robot.ts is the SUCTION region (where an
 * artifact gets drawn toward the throat), not the physical extent of the hardware, and
 * drawing the rollers to it put a handful of them in the centre with bare beam either side.
 */
export const INTAKE_ROLLER_PITCH = 1.6; // in between roller centres
export const INTAKE_ROLLER_W = 1.3; // in, each roller's width along the beam
/** roller diameter in inches for a spec */
export const intakeRollerDia = (spec: { intake: keyof typeof INTAKE_ROLLER_MM }): number =>
  INTAKE_ROLLER_MM[spec.intake] / 25.4;
/**
 * THE INTAKE HAS A ROOF, and it is the same fact the mouth geometry already rests on.
 *
 * `ballRobotContact` leaves the centre of the mouth OPEN at ball height on the grounds that
 * "the wheels ride high in z, so balls pass under them". That is right, and it has an
 * unstated other half: what rides high in z is SOLID to anything coming DOWN. Without it the
 * mouth was open from above too, so an artifact dropped on the intake fell through the
 * rollers to the floor INSIDE the throat and was swallowed — measured, a drop from 24in onto
 * the mouth of every preset ended up held, as did one onto the front of the CHASSIS, which
 * the contact code ejects forward into the mouth on its way down.
 *
 * The height is the geometry the mouth already implies: the roller's underside has to clear
 * a full artifact for one to pass under it, so an artifact landing ON the roller sits a
 * diameter, plus the roller, plus its own radius up.
 */
export const intakeLidZ = (spec: { intake: keyof typeof INTAKE_ROLLER_MM }): number =>
  2 * BALL_RADIUS + intakeRollerDia(spec) + BALL_RADIUS;
/**
 * How briskly an artifact that lands on the intake is thrown clear of it, along the robot's
 * forward axis.
 *
 * A roller is a cylinder with its axis across the robot, so what lands on it goes forward or
 * back, never sideways — and back is the chassis, which is solid. With the intake RUNNING the
 * roller is spinning and throws it; stopped, the front lip is the low side and it rolls off.
 * One constant either way: the artifact ends up on the floor in FRONT of the mouth, where an
 * intake may then legitimately take it, rather than inside the throat where it never was.
 */
export const INTAKE_LID_THROW = 24; // in/s
/**
 * GATE OPENER: a block on each end of the roller beam, filling out to the chassis edge.
 *
 * It is not decoration and it is not a new collider either — `footprintExtents` already
 * makes the whole front of the robot solid out to `width/2` and forward to `length/2 +
 * reach`, which is what lets an intake work the gate lever at all. The funnel presets'
 * roller only spans `mouthHalf`, so the drawing showed nothing out at the corners while the
 * collision box was solid there. This is the part that was missing from the picture, and
 * `npm test` asserts it lands exactly on the footprint corner rather than near it.
 */
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
      //
      // drawIn 18 -> 21 ("make vector intake vector slightly faster"): the vectoring
      // time is the distance to the throat over this speed, so an edge entry at 8in
      // off-centre falls 0.30s -> 0.25s and the centre is untouched at 0.02s. It stays
      // the SLOWEST of the three by a distance (sloped 26, triangle 46) — vectoring an
      // off-centre ball across a flat plate is what this preset trades away.
      wedge: false, mouthHalf: 8.5, throatHalf: 3, drawIn: 21,
      capMin: 0.08, capMax: 0.14, clumpInterval: 0.12, dual: false,
    },
  },
  /** TRIANGLE: named for the triangular ball storage (2 near the mouth, 1 deep).
   * Sloped-style funnel slopes + longest reach; devours a clump TWO at a time.
   * Transfer is the SAME as the others EXCEPT a max-rate CAP (`fireCap`): it can't
   * fire faster than that, but when conditions are already slower than the cap
   * (flywheel recovery on far shots) it fires at the same rate as everyone else. */
  triangle: {
    reach: 5, overhang: false, minLength: 11, maxLength: 13, minWidth: 15.5, fireInterval: 0.08, fireCap: 0.095,
    mouth: {
      // strongest INTAKE of the three (its identity — devours clumps): a hard
      // suction (drawIn) snaps balls to the throat and it swallows quickest. The
      // tradeoff is TRANSFER (fireCap), not the grab — those stay untouched.
      //
      // "Make triangle intake transfer slightly faster." The CAP was not what was slow:
      // measured, the gap between shots was 0.133s against a cap of 0.12, so the cap
      // never bound at all and lowering it alone changed nothing (7.50/s either way).
      // What binds is `fireInterval` plus the flywheel recovery, so that is what moved:
      // 0.10 -> 0.09, with the cap eased to 0.105 so it still sits just under the
      // result and remains the thing that stops this preset being the fastest shooter.
      // It is still the only preset with a cap, and still slower than sloped's 0.08 —
      // the triangle grabs best and shoots slowest, by a little less than before.
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
/**
 * Height an overflow artifact's centre rides at when it is NOT over anything — the fallback
 * only. A ball resting on another ball sits one full DIAMETER above it, so over the retained
 * column the real height is RAMP_SURFACE_Z + 2R = 15, and it is computed per-tick from the
 * artifacts actually underneath (see the scallop in updateRails). This was a flat 13.5 —
 * less than a diameter above the ramp, i.e. sunk into the column it is supposed to be riding
 * on, and pinned there for the whole ride: measured z = 13.50 from top to bottom, dead level
 * across nine spheres.
 */
export const OVERFLOW_Z = RAMP_SURFACE_Z + 2 * BALL_RADIUS;
/**
 * How hard the scalloped top of the retained column throws an overflow artifact about.
 *
 * Riding over a row of spheres is not a ramp: the artifact drops into each hollow and has to
 * climb the next crest, so gravity is alternately with it and against it. This is that
 * component — acceleration per unit of local surface slope — and it is what makes the ride
 * lurch instead of gliding. Without it the overflow lane accelerated monotonically to
 * terminal (1 → 13 → 21 → 26 → 29 → 31 → 33 → 34 in/s, dead smooth) and the artifacts held
 * a tidy second row at exactly RAIL_PITCH, which is not what rolling over a pile looks like.
 */
/** cap on that slope — the geometry diverges at the point where one sphere hands over to
 * the next, and an unbounded kick there would fling artifacts off the ramp */
export const OVERFLOW_SLOPE_MAX = 1.0;
/**
 * WHAT ROLLING OFF THE END OF THE PILE COSTS.
 *
 * An overflow artifact rides the retained column about a diameter up and then runs out of
 * column: it drops onto the ramp and lands. That drop was a cosmetic z-blend costing it
 * nothing, so every overflow artifact arrived at the exit having converged on the same
 * drag-limited terminal and left at the same speed — measured 34.2..35.4 in/s across six of
 * them, a spread of 1.2 against the classified lane's 17.1. Identical speeds means identical
 * spacing, which is "coming out too uniformly in a line".
 *
 * The landing is where the variety lives, and it needs no randomising: the scallop means
 * artifacts leave the pile anywhere between a hollow and a crest, so they begin the drop
 * from different heights and are still falling for different lengths of time.
 *
 * Bumpiness is NOT the lever and was tried first — OVERFLOW_BUMP 40 -> 70 moved the exit
 * spread only 1.2 -> 2.0, and past 100 the ride limit-cycles and nothing exits at all.
 */
export const OVERFLOW_LAND_LOSS = 11; // 1/s while dropping off the end of the column

// goal basin (inside the triangular goal structure)
export const BASIN_FLOOR_Z = 14; // funnel floor height inside the goal
export const BASIN_RESTITUTION = 0.4; // vertical bounce off the funnel floor
export const BASIN_WALL_RESTITUTION = 0.55; // lively caroms off the goal walls
export const BASIN_FUNNEL_ACCEL = 2500; // in/s^2 pull toward the classifier entrance (drains the basin briskly so balls don't clog)
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
/**
 * Down-ramp acceleration, and an artifact is under it for the WHOLE descent.
 *
 * 386 in/s^2 of gravity on a shallow ramp, less the rolling loss: g*sin(th)*5/7 puts 25 in/s^2
 * at about 5 degrees, which is the sort of slope a classifier channel has.
 *
 * It used to be 80, which is a 17-degree ramp, and it was survivable only because RAIL_TERMINAL
 * capped the result at 30 in/s after 5.6in of travel — barely one artifact spacing. Every
 * artifact was therefore at the cap before it reached the gate and the whole column flowed at
 * one speed. Nothing on a ramp does that: rolling resistance does not grow with speed, so there
 * is no terminal velocity to reach, and how fast an artifact is going depends on how far it has
 * come. Now it does: down a full ramp they arrive at 17, 26, 31, 36, 40, 44, 48, 51, 54 in/s,
 * each with more runway than the one in front, so the gaps between arrivals SHORTEN as the
 * column drains and the ramp visibly speeds up as it empties.
 */
export const RAIL_ACCEL = 100; // in/s^2 down-ramp
/**
 * Terminal flow speed down the ramp — the speed at which the incline's pull (RAIL_ACCEL) is
 * balanced by rolling resistance.
 *
 * This is what sets the SHAPE of a drain, not just its speed, because it decides whether the
 * column is still accelerating when it reaches the exit. The column starts from rest packed
 * against a shut gate, so the first artifact has to cover one RAIL_PITCH from a standstill —
 * 0.36s, unavoidable. If terminal is high, everything behind it is still speeding up and the
 * drain reads as a lag and then a dump:
 *
 *     terminal 46 -> at speed after 13.2in, gaps 0.20 0.13 0.13 0.12 0.13 0.12 0.13 0.13
 *     terminal 30 -> at speed after  5.6in, gaps 0.22 0.20 0.20 0.20 0.22 0.23 0.23 0.22
 *
 * Reaching terminal within about ONE PITCH is the condition for the first gap to match the
 * rest, and that is what makes it read as a steady stream. 9 artifacts clear in 2.1s.
 */
/**
 * A SAFETY CAP, not a shaping constant — nothing in a normal drain gets near it (the fastest
 * arrival down a full ramp is about 54 in/s). It exists so a pathological state cannot launch
 * an artifact down the rail at an unbounded speed, not to give the ramp a flow speed.
 */
/**
 * THE CHANNEL IS A GROOVE, AND A FAST ARTIFACT RATTLES DOWN IT.
 *
 * `RAIL_ACCEL`'s own note is right that rolling resistance does not grow with speed, so there
 * is no terminal from rolling — but rolling is not all that is happening. The channel is
 * CLASSIFIER_W across against a 5in artifact, so it weaves (see `railWander`), and the faster
 * it goes the harder it works the walls: knocking side to side, scrubbing the groove, throwing
 * itself against the far side of each weave. That loss DOES grow with speed, and it is what
 * stops a chute from delivering at whatever the drop height would give in a vacuum.
 *
 * Without it the ramp accelerated the whole 59in unopposed and the last artifacts off a full
 * column arrived at 69 in/s — "the balls get supercharged and dash down". With it the early
 * ones are untouched (they have no speed for it to take) and the tail settles near
 * RAIL_ACCEL / this, about 45 in/s, which is the number the ramp actually delivers.
 */
export const RAIL_RATTLE_DRAG = 1.45; // 1/s — terminal ~RAIL_ACCEL/this
export const RAIL_TERMINAL = 120; // in/s safety cap
export const RAIL_PITCH = 5.1; // ball contact spacing on the stack
/** how far off straight an artifact tips as it rolls off the exit lip, in in/s of lateral
 * speed. NOT a fraction of its speed — the weave it carries is groove geometry, so it is worth
 * the same couple of inches a second however fast it arrives. At the drain's ~40in/s that is a
 * few degrees; the rest of the spread comes from collisions. */
export const EXIT_DRIFT = 2.5;
/** how fast the artifact AHEAD has to be rolling before the one behind can push it along
 * (in/s). Below this the column is being held against something — a shut gate, a bumper — and
 * a contact with it is a contact with the field, not a momentum exchange. See the contact
 * clamp in `updateRails`. */
export const RAIL_CONTACT_MOVING = 2;
export const GATE_STOP_S = 2; // lowest rest position against the closed gate
// entrance blocked only while a ball is still within ~one pitch of the top entry
// (s = RAIL_S_MAX = 55); was 43.4, which forced each ball to flow 11.6" clear
// before the next could board — throttling the drain to ~2 balls/s and clogging
// the basin. One pitch below the entry keeps proper spacing but drains ~2× faster.
export const RAIL_ENTRY_BLOCK_S = 50;
/**
 * The speed an artifact BOARDS the ramp at, and its ceiling.
 *
 * The floor (8 in/s) exists so an artifact that dribbles into the entrance still gets under
 * way. The CEILING is the interesting one: an artifact used to board carrying whatever
 * `vel.y` the basin had given it, and the basin's funnel pull is a scripted drain aid
 * (BASIN_FUNNEL_ACCEL, 1150 in/s^2 — three times gravity, there to stop the basin clogging),
 * not a slope. Measured in a real match, artifacts boarded at up to 52 in/s and peaked at
 * 75 in/s on the ramp, against a ramp whose OWN free-fall ceiling over its whole length is
 * 54. It depended entirely on whether an artifact happened to dive straight at the entrance
 * or jumble first, which is exactly "sometimes balls come down the ramp extremely fast".
 *
 * The channel entrance is a THROAT, not a launcher: an artifact turning into a 6in chute
 * spends most of what it had on the walls. So the boarding speed is capped at what the ramp
 * ITSELF could have produced by that point — sqrt(2 * RAIL_ACCEL * (RAIL_S_MAX - s)) — and
 * from there the descent is the ramp's own physics and nothing else's. Nothing on the ramp
 * can then be faster than something released at the very top, which is the property that
 * makes the flow legible.
 */
/**
 * The speed an artifact boards the ramp at.
 *
 * It was 8 in/s, which throttled the whole goal: the next artifact cannot board until this one
 * is a PITCH clear, so the hand-off rate is boarding speed over pitch, and 8 over 5.1in is two
 * a second. It was then tied to the ramp's DELIVERY speed to fix that — and when the chute was
 * steepened for the drain cadence, the delivery speed went with it and artifacts started
 * entering the channel at 69 in/s. "Balls come down the funnel too fast. Not frequency, speed."
 *
 * So it is its own number again. An artifact arrives from the basin under a funnel pull, not
 * off a ramp, and 25 in/s is a brisk hand-off without being a shot: fast enough that the
 * entrance is not the bottleneck it was at 8, slow enough that the channel does not read as
 * firing artifacts down itself. What it costs in hand-off rate the ramp now gives back — a
 * packed column shares momentum, so the artifacts behind push the one at the top along.
 */
export const RAIL_ENTRY_V = 25; // in/s
export const RAIL_EXIT_S = -4; // past the gate: ball drops out to the floor
/**
 * An artifact on the ramp is drawn RAMP_SURFACE_Z up in the air, which is true while it is on
 * the ramp and false the moment it clears the channel mouth — past the wall it is out on the
 * open apron with nothing under it. It used to hold that height across the whole exit stretch
 * and then pop to the floor on release, so it crossed open ground ten inches up and rode over
 * any robot standing there: "balls skip over the chassis when they come down from the
 * classifier". It now descends across that stretch, reaching the floor exactly where the
 * release already puts it, so the drop is continuous instead of a snap.
 */
export const RAIL_DROP_S = 2.5; // inches of travel past the mouth to reach the floor
/** step used to walk a robot's body along the rail line when deciding where it stops the
 * column. Well under an artifact radius, so nothing slips past; a robot is only ~18in long,
 * so the walk is a few dozen samples. Fixed, because the rail must stay deterministic. */
export const RAIL_BLOCK_STEP = 0.5; // in
/** how fast a solid floor (a robot's bumper, the exit lip) may push an artifact back UP the
 * rail. The solver otherwise refuses to move an artifact upward at all — a floor that moves
 * must never yank the column, which is what made it jump up and down the classifier in time
 * with the steering. But a robot leaning into the channel really does shove the column, and
 * an artifact that slipped under the exit really must come back. Rate-limiting it means both
 * read as a push instead of a teleport. */
export const RAIL_PUSH_RATE = 60; // in/s
/**
 * How hard the column shoves an artifact still sitting in the gate's doorway, as a fraction
 * of the exit velocity — a FLOOR on its outward speed, re-applied each tick the doorway is
 * occupied, never an addition (see the release loop: adding compounded to 91 in/s).
 *
 * 1.0 = the queue moves at the speed of the flow that is pushing it, which is the only value
 * that isn't arbitrary. At 0.5 the doorway artifact crept out at 11 in/s and took 0.9s to
 * clear its own diameter, throttling a nine-artifact drain to 12s — and that throttle used
 * to be invisible, because artifacts queued BELOW the exit (off the field entirely) and then
 * burst out together once it cleared. With the exit sealed, the queue rate is what you see.
 */
export const EXIT_NUDGE = 1.0;
/**
 * Clearance BEYOND touching that the doorway needs before the next artifact is released.
 *
 * This was 4.5 — nearly two artifact diameters — swept to that value back when ground
 * artifacts were resolved bespoke and releasing at one diameter left a 2.8in overlap spike
 * (the pair converge after the release, so "not touching yet" was not "there is room").
 * Ground artifacts are Rapier bodies now and the chassis is in that solve, so the overlap
 * is handled where it belongs: re-swept at 4.5 / 2.0 / 1.0 / 0.0, the worst clump overlap
 * is 0.12in at EVERY value. The old margin was buying nothing and costing cadence.
 *
 * What it costs: the doorway is the WAIT half of the drain cadence. The other half is
 * gravity carrying an artifact one RAIL_PITCH down to the exit, ~0.33s, which is real and
 * irreducible. At 4.5 the wait was ~0.5s on top of that and the drain read as a metronome —
 * 0.77s between releases with a mean-abs-dev of 0.10s, artifacts leaving one at a time like
 * a dispenser rather than flowing.
 */
export const EXIT_CLEARANCE = 1.0; // in, on top of a full artifact diameter
/**
 * How close to a chassis the doorway artifact has to be before the column stops shoving it.
 *
 * EXIT_NUDGE is a velocity FLOOR re-applied every tick the doorway is occupied. If the
 * artifact is pinned — between the gate and a robot parked down the tunnel — the floor and
 * the chassis take turns and it BUZZES: measured 60 direction reversals in two seconds, one
 * every other tick, peaking at 67.6 in/s. A fraction of a radius rather than the whole one,
 * so an artifact merely rolling past a robot is still nudged normally.
 */
export const EXIT_PIN_FRAC = 0.8; // of BALL_RADIUS
/**
 * Rolling resistance an artifact carries while it is riding ON TOP of the retained column
 * instead of on the ramp — the bumpy business of climbing over one artifact, dropping between
 * it and the next, and climbing again.
 *
 * This REPLACED a fixed OVERFLOW_FLOW_SPEED. A constant speed made overflow a mode rather
 * than a situation: it could not rejoin the column when the gate opened, and its pace was a
 * number to be argued about instead of a consequence. Gravity drives it, the ramp sets the
 * scale, and nothing about it was ever special except its height.
 *
 * IT IS A DECELERATION, NOT A DRAG, for exactly the reason RAIL_ACCEL gives for the ramp:
 * rolling resistance does not grow with speed, so there is no terminal velocity to reach and
 * how fast an artifact is going depends on how far it has come. It was a 2.2/s velocity drag,
 * which pinned the ride at RAIL_ACCEL / 2.2 — 36 in/s when RAIL_ACCEL was 80, and then 11
 * in/s once it became 25, a crawl beside a ramp lane running 17..54. That is the "overflow
 * flow is weird and slightly slow": one lane accelerating the whole way down and the other
 * held at a fifth of it by a constant that was never rescaled.
 *
 * As a constant loss the two lanes are the same physics and the ratio is fixed and readable:
 * over the same stretch an elevated artifact reaches sqrt((RAIL_ACCEL - this) / RAIL_ACCEL)
 * of the ramp lane's speed — 0.8 — because climbing over a pile costs it, not because it is
 * a different kind of thing.
 */
/**
 * ...AND THE NET IS THE NUMBER THAT MATTERS, so that is what is written down.
 *
 * This was a FRACTION of RAIL_ACCEL — 0.88 of it, "net ride pull is the rest" — which ties
 * how fast a rider clambers over a pile to how steep the chute under the pile is. Those are
 * not the same thing: the crests it climbs are artifact-sized whatever the ramp does. So
 * steepening the chute for the drain cadence doubled the net pull with it and the riders took
 * off — measured, a peak of 32 in/s against a shut gate and 57 with it open, on a lane whose
 * whole character is meant to be a slow lurching ride ("overflow balls come down too quickly
 * ... it would move kinda like in steps").
 *
 * The net pull is 6 in/s^2, as it was, and the loss is whatever the slope leaves over it.
 */
export const OVERFLOW_NET_PULL = 6; // in/s², what actually drives a rider down the pile
export const OVERFLOW_ROLL_LOSS = RAIL_ACCEL - OVERFLOW_NET_PULL; // in/s²
/**
 * HOW STRONGLY THE COLUMN UNDERNEATH CARRIES THE ARTIFACT RIDING ON IT, per second.
 *
 * An overflow artifact is rolling on BALLS, not on the ramp, so what is under it sets its
 * pace: against a shut gate the column is stationary and drags the rider to a crawl, and the
 * only thing moving it is the small net pull left after the clamber loss — which is the
 * STEPPING, hollow to crest. Open the gate and the column is running, and the same contact
 * hands the rider its momentum.
 */
export const OVERFLOW_CARRY = 3.5; // 1/s toward the speed of the artifact beneath it
/** how much faster than its carrier a rider may get, in/s. It is rolling ON the column, so a
 * little lead is the crest it is coming down; a lot is a slide. Only applies while the column
 * is actually moving — over a stationary pile the rider clambers under its own net pull. */
export const OVERFLOW_LEAD = 6;

/**
 * ...AND IT MUST STAY UNDER THE RAMP'S OWN PULL, or the scallop stops being a texture and
 * becomes a TRAP. The crest between two artifacts is a real potential barrier: if the bump
 * can cancel `RAIL_ACCEL` the artifact simply parks in a hollow and never comes out.
 *
 * This was 40 against a RAIL_ACCEL of 80 — half of gravity, a lurch. RAIL_ACCEL is now 25
 * (the ramp accelerates the whole way down instead of running at a capped flow speed) and
 * this was not rescaled with it, so the bump was 1.6x the pull that is supposed to drive the
 * ride. Measured with four overflow artifacts dropped onto a full column: three of them
 * stuck on the pile FOREVER — one at s=52.4 held at v=+5 in/s, i.e. being pushed steadily
 * back UP the ramp — and the fourth crept out at 16 in/s after four seconds. The note under
 * OVERFLOW_LAND_LOSS had already recorded the shape of this ("past 100 the ride limit-cycles
 * and nothing exits at all"); dropping RAIL_ACCEL is what walked the ratio into it.
 *
 * So it is now a FRACTION of the net pull, and the invariant is one line of arithmetic:
 * RAIL_ACCEL - OVERFLOW_ROLL_LOSS - OVERFLOW_BUMP * OVERFLOW_SLOPE_MAX > 0, i.e. the ride
 * always accelerates down-ramp, hardest into a hollow and barely at all over a crest. Smoke
 * asserts it, because it is the difference between a lurch and a stall.
 */
// ...and the LURCH is artifact geometry too, not the chute's: a crest is a crest. Held at
// the value it had when the ramp pulled at 50, rather than scaling with the slope.
// ...and the LURCH is nearly the whole of it, which is what makes the ride read as STEPS
// rather than a glide: cresting a sphere all but cancels the pull, dropping into the next
// hollow doubles it. Held just under the net pull by the invariant a smoke check states — past
// it a crest would drive a rider back UP the pile, and a lurch would become a trap.
export const OVERFLOW_BUMP = 3; // in/s² per unit slope
/** lateral/vertical glide rate as a ball settles onto the rail line */
export const RAIL_BLEND_SPEED = 30; // in/s
/**
 * Spatial frequency of an artifact's weave across the channel (radians per inch travelled).
 * 0.42 is a wavelength of about 15in — three artifact diameters — so a ball crosses the
 * channel's half-inch of slop over a long, lazy roll rather than vibrating. See `railWander`.
 */
export const RAIL_WANDER_K = 0.42;
/**
 * How much of the channel's lateral slop a TRACKED artifact actually uses, as a fraction.
 * The channel is a marble track — it guides what is in it — so this is deliberately small:
 * enough that a resting column is not one ruled line, not enough to read as wobble. Artifacts
 * riding OVER the column (overflow) are not in the groove and use the full slop instead.
 */
export const RAIL_WANDER_AMP = 0.25;

export const GATE_OPEN_HOLD = 0; // s of push before the gate arm starts to lift. ZERO so the lift (and the handle-collider retract that rides on it, see gateColliderPos) begins on the very tick you contact it — no debounce means no jam against the closed stub. The push gate (pushingGate: a STRAIGHT ram, not a graze) already prevents accidental opens.
/**
 * The arm's mechanical OVERSWING: its own momentum carrying it up for a moment past the
 * instant the robot stops touching it.
 *
 * This was 0.5s and meant something quite different — the arm was PINNED at maximum lift,
 * hovering clear of everything, for half a second after a tap with nothing holding it. A
 * hinged arm cannot do that, and it is what made a tap empty the entire ramp: measured, a
 * tap drained every column up to six artifacts, two of them during the latch alone.
 *
 * "A tap opens it and the driver does not have to keep pressing" is still true, but it now
 * comes from the FALL rather than from a timer: gravity needs ~0.23s to bring the arm from
 * full lift back down to GATE_PASS_FRAC, artifacts flow the whole way, and then it lands on
 * the column and meters it. Touch-hold (a robot resting against the arm) is what pins it.
 */
export const GATE_OPEN_LATCH_S = 0.08; // s of overswing after contact ends
/** once open, gravity/flow decide re-close: it can only fall while no ball occupies
 * the gateway (a ball streaming under the arm physically holds it up) */
export const GATE_CLOSE_CLEAR_LO = -4;
export const GATE_CLOSE_CLEAR_HI = 4.5;
/**
 * THE ARM CANNOT HOVER — it rests on whatever is under it, and an artifact is only
 * a ball's worth of lift.
 *
 * A ball in the gateway used to FREEZE `gatePos` wherever it happened to be, which meant
 * a tapped gate stayed pinned at 1.0 (fully lifted, 77°) with artifacts rolling under it
 * touching nothing. Held open and tapped open then drained at exactly the same rate —
 * measured 0.596s vs 0.598s between releases, the same metronome either way — because the
 * arm was doing nothing in either case.
 *
 * An unheld arm falls until it lands on the flow, and that height is GATE_RIDE_FRAC: how
 * far a 5in artifact passing beneath holds the paddle up. Everything the user asked for
 * follows from that one fact and needs no special cases:
 *  · HELD by a robot ⇒ latched at 1.0, well clear of the artifacts ⇒ no contact, no drag,
 *    no cadence: the column just streams out.
 *  · TAPPED ⇒ the arm settles onto the stream and RIDES it. Its weight drags each artifact
 *    passing under (GATE_PADDLE_DRAG), and in the gap between artifacts it sags, so the
 *    next one has to shoulder it back up — which is the cadence, and it is semi-uniform
 *    because it depends on how packed the column happens to be.
 *  · NOT ENOUGH MOMENTUM ⇒ the ride height an artifact can hold is proportional to its
 *    speed (GATE_SHOULDER_LIFT). A faltering one cannot lift the paddle past
 *    GATE_PASS_FRAC, the arm settles onto it, and the drain stops until someone taps
 *    again. Deterministic, but scenario-dependent enough to feel like it just gave out.
 */
export const GATE_RIDE_FRAC = 0.62; // open fraction the arm rests at while riding the flow
/**
 * SITTING UNDER THE ARM IS NOT THE SAME AS GETTING PAST IT — this is the constant that
 * makes the difference, and getting it wrong made a tap empty the whole ramp.
 *
 * GATE_SEAT_FRAC is where the paddle comes to rest on an artifact directly beneath it. It
 * is deliberately BELOW GATE_PASS_FRAC, because a paddle resting on top of a ball is the
 * MARGINAL contact case: the clearance is exactly the ball and no more, so with the arm's
 * weight on it, it does not roll through. Getting past means lifting the paddle the rest
 * of the way, and the only thing that does that is momentum (GATE_SHOULDER_LIFT).
 *
 * It was originally set equal to GATE_PASS_FRAC — "a full diameter of clearance IS the
 * pass height", which sounds right and is off by exactly the amount that matters. The
 * gateway window is 8.5in against a 5.1in artifact pitch, so a packed column ALWAYS has
 * something under the arm; if merely being under it holds the gate exactly passable, a
 * dense column keeps itself flowing forever. Measured, that drained every column up to
 * six artifacts no matter what else was tuned — GATE_RIDE_FRAC swept 0.44→0.62 changed
 * nothing, which is what pointed here.
 */
/**
 * Open fraction an artifact in the gateway can shoulder the arm up to, per in/s of its
 * down-ramp speed (capped at GATE_RIDE_FRAC), taken as the higher of this and the seated
 * geometry. GATE_PASS_FRAC / this is therefore the speed an artifact needs to keep the gate
 * passable at all — below it the arm settles onto it and the drain stops.
 *
 * Ramp speeds run 20–40 in/s (RAIL_ACCEL 80, terminal 46), so this has to put the threshold
 * INSIDE that band or the rule never bites. At the old 0.045 the threshold was 8.9 in/s —
 * far below anything the ramp produces, so every artifact cleared it and the gate never
 * gave out. The drain is meant to be marginal as the column spreads and artifacts start
 * arriving slower; that is the whole "it randomly stops" behaviour.
 */
/**
 * How much SWING SPEED an arriving artifact hands the arm, per in/s of its own speed.
 *
 * This is an IMPULSE, and that is the whole point of it. It used to be a height — the arm was
 * teleported to `speed x constant` — which is not a collision, it is a lookup table, and it
 * made the arm's rise linear in speed when a struck lever's rise goes as the SQUARE of the
 * speed it is struck at (the artifact hands over momentum, the arm converts it to height
 * against gravity: h = v^2 / 2g). Handing over a velocity and letting GATE_GRAVITY decide how
 * high it gets makes that automatic, and it is why the same tap does not give the same result
 * twice: the height now depends on where in the arm's own swing the artifact happens to arrive.
 *
 * It also replaced GATE_FLOW_CUSHION, which damped gravity in proportion to the flow. That was
 * a second, separate knob for the same physical fact, and the two double-counted: the flow
 * holds the arm up because artifacts keep knocking it up, not because a stream of artifacts
 * makes gravity weaker.
 */
/**
 * ...and its SIZE decides whether a drain can die in the MIDDLE. Once the column is flowing,
 * the strike loss puts the arrival speed at a fixed point (v^2 = (1 - loss)^2 * v^2 +
 * 2 * RAIL_ACCEL * RAIL_PITCH, about 19 in/s), so the arm's rise per knock, (v * this)^2 /
 * (2 * GATE_GRAVITY), is a CONSTANT compared against a constant fall between arrivals. Set it
 * high and every drain that survives its first gap runs to the end of the ramp; set it near
 * that balance and the drain is decided artifact by artifact, which is the spread wanted.
 * At 0.12 the sweep was 9-or-nothing (12 ones, 36 nines, nothing between); at 0.07 it spans
 * 1..9 with a mean of 5.
 */
export const GATE_KNOCK = 0.085; // (1/s of gatePos) per in/s of artifact speed
/**
 * WHAT THE STRIKE COSTS THE ARTIFACT — the fraction of its down-ramp speed it spends
 * throwing the arm up. A collision moves momentum; it does not mint it.
 */
export const GATE_STRIKE_LOSS = 0.45;
/**
 * How far UP-RAMP of the gate line an artifact still counts as arriving at the arm.
 *
 * The impulse comes from the artifact reaching the paddle, and its speed has to be read before
 * the arm slows it. Sampling only what was already under the paddle made the arm and the flow
 * chase each other down — arm settles onto the flow, flow slows, slower flow lifts less.
 */
export const GATE_APPROACH_S = RAIL_PITCH;
/**
 * WHAT A TAP IS WORTH is set by three constants together — GATE_SHOULDER_LIFT (momentum
 * needed to keep the gate passable), GATE_FLOW_CUSHION (flow needed to suspend the fall)
 * and GATE_CLOSE_MAX (how fast it settles). They move as a set; adjusting one alone mostly
 * does nothing, because the drain ends when the arm crosses the pass line and all three
 * govern when that happens.
 *
 * IT IS A RANGE, NOT A DOSE — "it should empty up to maximum 9, but as low as like 4 or 5".
 * On a full ramp, across the conditions a driver actually varies (packing, tap length,
 * run-up), this setting yields every value from 4 to 9. The spread comes from the flow
 * itself: a dense column arriving fast holds the arm up and carries the whole ramp, while
 * one that has spread out lets the arm settle and gives out early.
 *
 * MEASURING ONLY PACKING AT A FIXED TAP HIDES ALL OF THIS. Swept that way it reads as a
 * flat 6 at every depth, which is what convinced an earlier pass that the yield was a
 * constant and sent it hunting for variance that was already there. Vary the tap and the
 * run-up too, or the number means nothing.
 *
 *     0.0125 / 62 / 1.65  ->  4 flat        (no spread at all)
 *     0.017  / 46 / 1.42  ->  4..8
 *     0.019  / 42 / 1.34  ->  4..9          <- here
 *     0.020  / 40 / 1.30  ->  5..9          (floor lifts; it stops giving out early)
 *//** rolling resistance the paddle's weight imposes on the artifact it is resting on, at
 * full sag (arm down). Scaled by (1 − gatePos), so a fully-lifted arm — held up by a
 * robot — costs the flow nothing at all, which is what makes a held gate stream. */
export const GATE_PADDLE_DRAG = 5.5; // 1/s at full sag
/**
 * HOW HEAVY THE ARM IS, as a set. There is no single mass constant — the paddle's weight
 * shows up in several places at once, and "lighter" means moving all of them together or
 * the model stops being self-consistent:
 *
 *   GATE_PADDLE_DRAG    how hard it presses on what passes under it        7    -> 5.5
 *   GATE_SHOULDER_LIFT  momentum needed to hold it passable          36 in/s -> 32
 *   GATE_FLOW_CUSHION   flow needed to suspend its fall              70 in/s -> 62
 *   GATE_PADDLE_SHOVE   the sideways component of its weight             120  -> 105
 *   GATE_OPEN_RATE      how readily a gentle push eases it open            10  -> 12
 *   GATE_CLOSE_MAX      terminal fall speed (damping does not scale
 *                       with mass, so a lighter arm settles slower)      1.8  -> 1.65
 *
 * TWO OF THESE ARE LOAD-BEARING and cannot be lightened on their own:
 *
 *  · GATE_PADDLE_SHOVE × GATE_SHOVE_MIN must stay above RAIL_ACCEL (80). That product is
 *    what stops the gate coming to rest on an artifact — gateStopS and gateRestOn are exact
 *    inverses, so the pair is neutrally stable at every offset and only a shove that beats
 *    gravity breaks it. The shove was lightened 120 -> 105 with the minimum lean raised
 *    0.75 -> 0.86 to hold the product at 90.
 *  · GATE_SHOULDER_LIFT and GATE_FLOW_CUSHION both make the gate EASIER to hold open, which
 *    means a tap drains more. They are the direct trade against "one tap never empties the
 *    ramp", and were moved only as far as that invariant tolerates.
 *
 * Verified after the change: 0/48 stalls leave the arm seated, a tap takes 4 at every depth
 * 5-9 and empties none of them, a held gate still empties all, and the held stream is
 * unchanged at a 0.323s mean gap.
 */

// ---- GATE PADDLE GEOMETRY: a stick on a sphere -----------------------------------
/**
 * THE HINGE'S HEIGHT ABOVE THE RAMP, and it is the ONE number the paddle-on-artifact
 * geometry has left to choose. Everything else about "how far does an artifact push the gate
 * open, and from where" falls out of it — see `gateRestOn`.
 *
 * The paddle is a STICK, hinged at the classifier's field edge and lying across the channel,
 * and an artifact under it is a SPHERE. A stick resting on a sphere is TANGENT to it, and
 * the tangent angle depends on how high the hinge is: hinge it level with the ramp and a
 * 5in artifact under a 6in stick stands it almost vertical (rest at the apex works out at
 * 1.03 of the full swing); hinge it at 5in and the artifact fits underneath without touching
 * it at all. Between those, the whole range.
 *
 * THE MANUAL PICKS IT, not taste: 9.8.3 puts the gate's contact area 3.75-5.5in above the
 * ramp, and that is exactly where this stick touches the sphere. Solving for the hinge height
 * that puts the apex contact in the middle of that band gives 3.5in — a ramp-level hinge
 * would contact at 2.95in, below the band, which is what rules it out.
 */
export const GATE_PIVOT_Z = 3.5; // in above the ramp surface

export const GATE_LIFT = 1.35; // rad (~77deg) the paddle swings up from closed to fully open

/**
 * THE STICK-ON-SPHERE ANGLE, in radians of lift above the paddle's closed (horizontal)
 * position, for an artifact whose centre is `d` down-ramp of the gate line.
 *
 * Hinge at (0, GATE_PIVOT_Z) in the channel cross-section, stick running toward the wall;
 * the artifact's centre sits `xb` from the hinge across the channel and BALL_RADIUS up. The
 * stick rests on the sphere when it is TANGENT to it, which (writing W = GATE_PIVOT_Z - R)
 * is the one line of algebra this whole mechanism reduces to:
 *
 *     (xb cos t - W sin t)^2 = xb^2 + d^2 + W^2 - R^2
 *
 * i.e. hypot(xb, W) * cos(t + atan2(W, xb)) = sqrt(xb^2 + d^2 + W^2 - R^2).
 *
 * Two consequences worth naming, because the old model had neither. The reach is not one
 * radius: the stick stops touching the artifact where the right-hand side outgrows the left,
 * which depends on the hinge height. And the profile is not the artifact's surface height —
 * it is flatter near the apex and falls away much faster near the edge of reach.
 */
export function gateRestAngle(d: number): number {
  const R = BALL_RADIUS;
  const xb = CLASSIFIER_W - RAMP_RAIL_INSET; // the rail's distance from the hinge
  const W = GATE_PIVOT_Z - R;
  const M = Math.hypot(xb, W);
  const rhs = xb * xb + d * d + W * W - R * R;
  if (rhs < 0) return GATE_LIFT; // the hinge is inside the artifact — nothing to solve
  const q = Math.sqrt(rhs) / M;
  if (q > 1) return 0; // out of reach: the stick falls past it entirely
  return Math.max(0, Math.acos(q) - Math.atan2(W, xb));
}

/**
 * HOW FAR FROM THE GATE LINE THE PADDLE STILL TOUCHES AN ARTIFACT — its reach, and no longer
 * the artifact's radius. The stick stops meeting the sphere where the tangency runs out, which
 * depends on the hinge height; solved once here so the sim, the block and the gate line all
 * quote the same number.
 */
export const GATE_PADDLE_REACH = (() => {
  let lo = 0;
  let hi = 4 * BALL_RADIUS;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (gateRestAngle(mid) > 0) lo = mid;
    else hi = mid;
  }
  return lo;
})();

/** the apex case, as a fraction of the full swing — GATE_SEAT_FRAC and GATE_PASS_FRAC both */
export function gateApexRest(): number {
  return Math.min(1, gateRestAngle(0) / GATE_LIFT);
}

/**
 * WHERE THE ARM SITS WHEN AN ARTIFACT IS DEAD UNDER IT — DERIVED, not chosen.
 *
 * It was 0.34, a free constant, against a model that took the paddle to be a vertical edge
 * coming down at the gate line and read the artifact's surface height there. That is not
 * what a stick does: a stick hinged off to one side meets the sphere at a TANGENT, and the
 * angle that takes is a different (and larger) number — 0.44 of the full swing for the
 * hinge height the manual implies. "The amount and the point at which the gate opens when a
 * ball forces it open is very off."
 *
 * It is also no longer independent of GATE_PASS_FRAC: the lift an artifact needs to get
 * THROUGH is the highest the stick rides while it passes under, which is this same apex
 * value. See GATE_PASS_FRAC.
 */
export const GATE_SEAT_FRAC = gateApexRest(); // = gateRestOn(0), see goal.ts

/**
 * THE LIFT AN ARTIFACT NEEDS TO GET THROUGH — the same number, and now for a stated reason.
 *
 * It was 0.4 against a seat of 0.34, and the gap was a fudge with a job: "seated under the
 * arm is not past it", so that a resting column could not hold its own gate open and drain
 * itself. The geometry says it plainly instead. The stick rides UP as an artifact comes under
 * it and is highest when the artifact is dead beneath — so the lift needed to pass IS the
 * apex rest, and the two are one value.
 *
 * A resting column still cannot open its own gate, and now by geometry rather than by
 * margin: the arm only reaches this height when an artifact is EXACTLY at the gate line, and
 * the artifact it is resting on is held wherever `gateStopS` puts it, which is somewhere
 * else. GATE_APEX_BIAS is what keeps that apex from being a place to sit.
 */
export const GATE_PASS_FRAC = GATE_SEAT_FRAC; // derived: clearing the apex IS passing

/**
 * WHERE THE PADDLE'S EDGE COMES DOWN, in rail `s`. A retained column rests packed against
 * the shut gate with its first artifact centred at GATE_STOP_S, so the barrier it is
 * resting against sits one radius further down.
 */
export const GATE_LINE_S = GATE_STOP_S - GATE_PADDLE_REACH;

/**
 * THE ARM STOPS WHERE THE GEOMETRY STOPS IT — it does not come to rest between artifacts.
 *
 * The arm used to have no idea what was underneath it: with the flow halted (a robot across
 * the outflow, or a column that ran out of momentum) it fell straight to 0 THROUGH whatever
 * was sitting in the gateway — measured at every offset from +4 to −2.4 in, always 0.000.
 * So it only ever ended up in the gap between two artifacts, which is not something it can
 * physically do.
 *
 * The paddle's edge descends the vertical at GATE_LINE_S and lands wherever that line meets
 * the artifact's surface. With the artifact's centre `d` from the gate line, the contact
 * sits at height `R + sqrt(R² − d²)` above the ramp — a full diameter dead on top (d = 0),
 * shrinking to a single radius out at the equator (|d| = R), and missing entirely beyond
 * that. GATE_SEAT_FRAC is what the full-diameter case maps to and the profile scales from
 * there; note it is BELOW GATE_PASS_FRAC, so an artifact merely SEATED under the arm has
 * not thereby got past it (see GATE_SEAT_FRAC).
 *
 * WHICH SIDE it landed on decides what happens once the robot leaves, and the two are
 * genuinely different situations:
 *  · d > 0 — the artifact has NOT reached the gate line. The paddle rests on its downhill
 *    face, in front of it, and its weight bears back up-ramp: wedged, and it stays wedged
 *    until somebody works the lever. (The block itself is the rail solver's existing gate
 *    floor. Nothing extra is applied, because shoving the column back UP the ramp is the
 *    one thing that solver refuses to do.)
 *  · d < 0 — the artifact is already mostly THROUGH. The paddle is on its uphill face and
 *    the same weight bears down-ramp: GATE_PADDLE_SHOVE is that component, and the arm
 *    squeezes the artifact out from under itself and falls shut behind it, unassisted.
 *  · d ≈ 0 is the balance point: the arm sits squarely on top at GATE_SEAT_FRAC, which is
 *    not passable, so it stays there until something works the lever or shoves it.
 */
/**
 * ...AND IT IS MEASURED AGAINST THE RAMP, because that is what it has to beat.
 *
 * A flat 105 was written against a ramp pulling at 50, and the invariant below
 * (GATE_SHOVE_MIN × this > RAIL_ACCEL) held with room to spare. Steepening the chute for the
 * drain cadence walked straight into it: at RAIL_ACCEL 100 the minimum shove is 90, the ramp
 * pulls harder than the paddle can push, and an artifact wedged under the arm slides back
 * under it instead of being squeezed out — the jam this constant exists to break.
 *
 * So it is a MULTIPLE of the ramp's pull. The paddle is the arm's weight bearing on a sphere;
 * how decisive that is only means anything relative to what is pulling the sphere the other
 * way, and tying the two together means the chute can be tuned without quietly re-opening a
 * jam at the bottom of it.
 */
export const GATE_PADDLE_SHOVE = 2.4 * RAIL_ACCEL; // in/s² at the artifact's equator
/**
 * THE APEX IS NOT A RESTING PLACE — the ramp is tilted, so "dead on top" is not dead on top.
 *
 * The sideways push is proportional to `d`, so at d = 0 it is exactly zero — and `gateStopS`
 * blocks an artifact at exactly d = 0 when the arm is at GATE_SEAT_FRAC. Those two agree, so
 * the pair is a perfect equilibrium and the gate parks on the artifact's apex forever:
 * measured, the arm was left seated in 18 of 48 stalls, every one of them at gatePos 0.340,
 * which is GATE_SEAT_FRAC to three decimals.
 *
 * On an inclined ramp the contact normal is not vertical, so the paddle's weight keeps a
 * down-ramp component even at the geometric apex. That shifts the neutral point up-ramp to
 * `d = GATE_APEX_BIAS · R`, and — this is the part that matters — leaves it UNSTABLE: below
 * it the artifact is pushed further out, above it further in. There is no longer anywhere
 * for the gate to come to rest on an artifact.
 */
export const GATE_APEX_BIAS = 0.25; // of BALL_RADIUS, up-ramp of the gate line
/**
 * MINIMUM decisiveness of that push, as a lean magnitude.
 *
 * The push is proportional to how far off-centre the paddle landed, which means it fades to
 * nothing near the neutral point — and `gateStopS` (where the arm blocks) and `gateRestOn`
 * (how high an artifact holds it) are exact INVERSES, so the pair is neutrally stable at
 * EVERY offset. Wherever the artifact stops, the arm settles to precisely the height that
 * blocks it right there, and it sits forever: measured d = 1.30, v = 0.0, rest = 0.315 =
 * gatePos, tick after tick. A proportional push cannot break that near the neutral point.
 *
 * So the paddle always pushes with at least this much lean, and only the DIRECTION comes
 * from which side of neutral it landed. GATE_PADDLE_SHOVE × this must exceed RAIL_ACCEL, or
 * the up-ramp push loses to gravity and the artifact simply slides back under the arm.
 */
export const GATE_SHOVE_MIN = 0.86; // × GATE_PADDLE_SHOVE must beat RAIL_ACCEL
/** GATE as a PHYSICAL push-to-open arm (manual 9.8.3): a robot shoves the arm the
 * ~2in open, and it is "closed by gravity" — after release it does NOT snap shut but
 * SWINGS closed, starting slow and accelerating (a hinged arm falling), so a tap
 * "may or may not stay open" long enough to clear the ramp. `gatePos` is the arm's
 * physical open fraction 0 (down/closed) .. 1 (fully lifted); `gateVel` is its swing
 * rate. `gateOpen` (a ball can pass) is DERIVED = gatePos >= GATE_PASS_FRAC. */
export const GATE_OPEN_RATE = 12; // 1/s: BASE lift rate for a gentle push (a light arm eases open readily)
/** the lift rate SCALES with how hard you ram the handle (ramSpeed = in/s toward the
 * wall): rate = GATE_OPEN_RATE + GATE_OPEN_RATE_SPEED·ramSpeed, capped at
 * GATE_OPEN_RATE_MAX. A near-full-speed ram lifts the arm ~fully in a single tick, so
 * the physical handle collider — which ANTICIPATES this same lift (gateColliderPos in
 * goal.ts, fed into buildGateArms) — is already out of the drivetrain's path the instant
 * you touch it: it "opens faster the harder you drive into it", with no bounce-off jolt. */
export const GATE_OPEN_RATE_SPEED = 1.2; // extra 1/s of lift per in/s of ram speed
export const GATE_OPEN_RATE_MAX = 66; // 1/s cap (~fully open in one tick at a hard ram)
/**
 * ...AND ITS RATE IS NOT A FEEL CONSTANT — it is set against the RAMP it meters.
 *
 * A tap on a resting column is a race between two times:
 *   the arm's fall from fully open to the pass line   sqrt(2 * (1 - GATE_PASS_FRAC) / this)
 *   the column's delivery of its next artifact        sqrt(2 * RAIL_PITCH / RAIL_ACCEL)
 *
 * The second DOUBLED when the ramp stopped running at a capped flow speed — RAIL_ACCEL 80 ->
 * 25 moved it from 0.36s to 0.64s — and this was left at 6, a 0.45s fall. The arm was then
 * always shut before the second artifact could arrive, and no knock can fix that: the first
 * gap is covered by nothing at all. A tap was worth exactly what was already sitting at the
 * gate, which is what "a tap only lets out one ball" is.
 *
 * At 4 the fall is 0.55s against that 0.64s — marginal, which is the whole point, and it has
 * a ceiling as well as a floor. Take it to 2.9 and the fall matches the delivery: measured,
 * the yield is then 9 out of 9 in every one of 50 tap conditions, i.e. the drain can no
 * longer give out at all. Packed column, tap length -> artifacts drained, at 4: 0.10s 2 ·
 * 0.15s 3 · 0.20s 5 · 0.25s 9. Loosen the column to +5in and a quick tap is worth 1 again,
 * which is the situational answer this is supposed to have.
 */
/**
 * ...AND IT IS NOT THE RAMP'S SLOPE. This was derived from RAIL_ACCEL, which reads as tidy
 * and is a coupling between two unrelated things: how fast a chute delivers artifacts, and
 * how fast a hinged arm falls. Steepening the chute then quietly sped the arm up by the same
 * factor and undid the "stays open longer" work in one edit. The number below is the value
 * that derivation produced at the ramp it was written against (RAIL_ACCEL 50), kept as its
 * own constant so the two can be tuned for their own reasons.
 */
export const GATE_GRAVITY = 7.42; // 1/s^2 on gatePos — see above
/**
 * Terminal swing speed as the arm falls closed.
 *
 * This was 9/s, which the arm never got near — from fully open it reached 0 in 0.30s under
 * GATE_GRAVITY alone, still accelerating the whole way. Two consequences, both wrong: it
 * shut too fast, and because it never hit terminal the time went as the SQUARE ROOT of the
 * starting height (1.00 -> 0.300s but 0.40 -> 0.183s, barely different for less than half
 * the travel). Terminal-limited instead, so the time is very nearly proportional to how far
 * open it was — "how fast it closes is determined by the initial position of the gate".
 */
/**
 * ...AND IT IS SLOW, because a hinge is not frictionless and the paddle is not a point.
 *
 * 3.6 came from matching a free pendulum, which is the wrong model twice over: the arm
 * carries a long paddle lying across the channel (its moment of inertia is the paddle's, not
 * a bob's) and it swings on a real hinge with real friction. Both make the fall slower than
 * gravity alone, and the drain is what pays for it being fast — "gate should stay open for
 * longer in general (let out more balls)".
 *
 * At 2.0 the arm is passable for 0.48s after being released with nothing under it (0.30s
 * before) and fully shut at 0.70s, and a tap on a packed column now drains all nine every
 * time (worst 6, mean 8.8 -> worst 9, mean 9.0 across 30 taps). It still falls all the way
 * shut, and what it comes to rest ON is unchanged, so a loose column still gives out.
 */
export const GATE_CLOSE_MAX = 2.0; // 1/s: terminal swing speed as it falls closed
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




/** the handle is a PHYSICAL one-way door: a solid robot collider spanning the SHORT arm's
 * (foreshortened) field-side reach, so a robot CANNOT strafe/drive through it — the only
 * way past is to OPEN it (a straight push, which lifts gatePos and RETRACTS the handle
 * toward the pivot, so the opening robot glides in rather than being shoved back). The arm
 * is LIGHT: it never shoves a resting robot because a robot touching the OPEN gate holds
 * it open (touch-hold in updateGates), so it doesn't swing closed against you. The long
 * paddle needs no collider — it lies over the already-solid classifier channel. Robot-solve
 * ONLY (not the ball solve): released artifacts still roll out beneath the lifted paddle. */
export const GATE_ARM_THICK = 3; // in, physical thickness (y) of the handle collider
/**
 * How fast the gate HANDLE squares a robot up, as a fraction of a wall's rate.
 *
 * A wall is the field. The handle is a 2.5in hinged bar with a spring's worth of authority, and
 * at the wall's rate it whipped a robot from 20 degrees to flush in 167ms — "the gate applies
 * way too much torque way too fast". This scales the RATE only: which way it turns you and the
 * cap that stops it stepping past flush are geometry and are untouched.
 */
export const GATE_ARM_TORQUE_MULT = 0.12; // ~1s from 20 degrees, against the wall's 0.17s
/**
 * ...AND IT STOPS BEING SOFT WHEN IT RUNS OUT OF TRAVEL.
 *
 * "If the gate is fully open, then that part acts like a wall essentially for collisions."
 * That is not a special case, it is what a lever IS: while it can still swing, a push mostly
 * moves the ARM, and only what the hinge refuses reaches the robot. At full lift there is no
 * travel left to absorb anything, so the whole push lands — a rigid link, i.e. a wall.
 *
 * So the arm's authority runs from GATE_ARM_TORQUE_MULT (free to swing) to a wall's full rate
 * (at its stop), linear in how far it is already lifted. The two complaints this sits between
 * are both real: "the gate applies way too much torque way too fast" was a CLOSED arm hitting
 * at the wall's rate, and "even if I hit it with a large impact it doesn't turn me" / "the
 * chassis is barely turning" was an OPEN one still pretending to be a spring.
 */
export const gateArmTorqueMult = (gatePos: number): number =>
  (globalThis as { __notorque?: boolean }).__notorque ? 0 : GATE_ARM_TORQUE_MULT + (1 - GATE_ARM_TORQUE_MULT) * Math.min(1, Math.max(0, gatePos));
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
/**
 * WHERE THE CHANNEL ENDS AND THE OPEN FIELD BEGINS, in rail `s`.
 *
 * The classifier is a solid structure (`classifierRect`, y from CLASSIFIER_GATE_Y up), so a
 * robot cannot be inside it and cannot reach an artifact that is. Above this `s` an artifact
 * is IN the channel and untouchable; below it the rail runs on in the open, under the gate,
 * toward the exit.
 *
 * `railBlock` used to walk the rail from RAIL_EXIT_S up to a ceiling taken from the ROBOT's
 * own extents — as far as s = 6.5, well inside the channel. That is the single path a robot
 * had to an artifact on the ramp, and it was both a block and a HAND-OFF: a robot with hopper
 * room took artifacts straight off the rail into its hopper.
 */
export const RAIL_OPEN_S = CLASSIFIER_GATE_Y - CLASSIFIER_Y0;


/** where released/overflow balls emerge onto the floor, on the goal's wall */
export const TUNNEL_EXIT = { x: 68, y: -3 };
/**
 * THE RAMP DISCHARGES STRAIGHT DOWN ITS OWN LINE. This is the speed of the doorway nudge and
 * nothing else — there is no direction left to configure.
 *
 * There used to be an `inward` term, an off-the-wall lean of 4 against 22, jittered per
 * artifact into a 5-15 degree fan. Every artifact leaned the SAME WAY (the jitter varied the
 * magnitude, never the sign), so the whole drain left on one diagonal and crossed the floor
 * together: "all the balls keep coming out of the gate at the same angle". Widening or
 * narrowing the fan only changes how wide that one diagonal is.
 *
 * The classifier channel runs down the wall and an artifact rolls off the END of it, so the
 * direction it leaves in is the direction it was already going — straight down the tunnel,
 * carrying the speed the ramp gave it. Nothing is synthesised. The SPREAD comes from where
 * they pile up: artifacts carom off whichever ones stopped first, which is a real cause and
 * fans them differently every time instead of identically every time.
 */
export const TUNNEL_EXIT_VEL = { along: 22 }; // in/s down-tunnel, toward the audience

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
/**
 * ...AND THEY DRIVE ROBOT-CENTRIC. "All DECODE robot presets should be robot centric."
 *
 * The presets are real team BUILDS, and a real FTC team drives robot-centric — field-centric
 * is the rarity, not the default. Every preset picked up the player default (all assists on,
 * including field-centric) because none of them carried assists of their own, so choosing a
 * build silently chose a drive frame with it.
 *
 * Only the FRAME is pinned. The rest is the player default, and the menu toggle still works —
 * this decides what a preset LOADS as, not what the player is stuck with. The custom builder
 * is untouched and still starts field-centric.
 */
const PRESET_ASSISTS = {
  fieldCentric: false,
  aimAssist: true,
  autoIntake: true,
  autoFire: true,
} as const;

export const ROBOT_PRESETS: readonly RobotSpec[] = [
  {
    name: 'TW', teamName: 'Turtle Walkers', teamNumber: 19745,
    length: 14.5, width: 16.5, intake: 'sloped', massLb: 23.5, drivetrain: 'mecanum',
    driveRpm: 440, flywheelInertia: 0.7, canSort: false, assists: PRESET_ASSISTS,
  },
  {
    name: 'Dugtrio', teamName: 'Blu Cru', teamNumber: 6417,
    length: 15, width: 18, intake: 'sloped', massLb: 36, drivetrain: 'tank',
    driveRpm: 340, flywheelInertia: 0.9, canSort: false, assists: PRESET_ASSISTS,
  },
  {
    name: 'Cypher', teamName: 'Seattle Solvers', teamNumber: 23511,
    length: 14, width: 14, intake: 'vector', massLb: 23.5, drivetrain: 'swerve',
    driveRpm: 500, flywheelInertia: 0.1, canSort: false, assists: PRESET_ASSISTS,
  },
  {
    name: 'Rohan', teamName: 'Exodus', teamNumber: 30030,
    length: 13, width: 17.5, intake: 'triangle', massLb: 34, drivetrain: 'mecanum',
    driveRpm: 395, flywheelInertia: 0.8, canSort: false, assists: PRESET_ASSISTS,
  },
  {
    name: 'Ditto', teamName: 'Galactic Narwhal Chicken Effect - Diamond', teamNumber: 22489,
    length: 14.5, width: 16, intake: 'vector', massLb: 28, drivetrain: 'mecanum',
    driveRpm: 450, flywheelInertia: 0.9, canSort: false, assists: PRESET_ASSISTS,
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
