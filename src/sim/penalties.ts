import type { Artifact, Alliance, RobotCommand, RobotState, Vec2, World } from '../types';
import * as C from '../config';
import {
  baseZone,
  classifierRect,
  gateArmRect,
  gateZone,
  goalLineValue,
  loadZone,
  other,
  tunnelStrip,
  inRect, goalSide,
} from './field';
import type { Rect } from './field';
import {
  closestPointOnRobot,
  driveIntent,
  robotCorners,
  robotExtents,
  robotIntersectsRect,
  robotPointVelocity,
} from './physics';
import { pushingGate, ZERO_CMD } from './goal';
import { awardCard, awardFoul } from './scoring';
import { hyp, rot } from '../math';

/**
 * DECODE penalty engine (Competition Manual Section 11). Pure and
 * deterministic: it reads only world.time, robot positions/velocities, the
 * per-tick command map, and world.rrContacts (robot-robot contacts recorded by
 * the collision solver). All state lives in world.penalties as plain JSON, so
 * the sim stays serializable and locklockstep-safe for netcode.
 *
 * Fouls are awarded TO the victim alliance (awardFoul in scoring.ts). Most
 * rules trigger on a CROSS-alliance contact pair while a robot sits in a zone;
 * a per-episode debounce (PENALTY_CLEAR) makes a held contact fire once, not
 * every tick. Pinning (G422) owns a per-ordered-pair second-accumulator.
 *
 * Rules modeled here (numbers/severities per Competition Manual Section 11):
 *   G402  AUTO opponent interference   (MAJOR) — fully on the opponent's side
 *                                       (own side = goalSide: robots stage near
 *                                       their GOAL) while contacting an opponent
 *   G408  over-possession               (MINOR per artifact over the limit, + a
 *                                       YELLOW CARD if excessive) — CONTROLLING more
 *                                       than POSSESSION_LIMIT artifacts (hopper +
 *                                       herded loose balls) past a short grace
 *   G422  pinning ≥3 s                 (MINOR, and another every 3 s it is not corrected)
 *   G417  operating an OPPONENT's GATE  (MAJOR) — contacting/working their gate
 *   G418  artifact off an opponent RAMP (MAJOR per artifact) — each classified
 *                                       ball that leaves an opponent's ramp
 *                                       because you opened their gate (G418.B)
 *   G424  GATE ZONE off limits         (MINOR) — cross-alliance contact while a
 *                                       robot is in a gate zone; protects the
 *                                       gate OWNER's access to their own gate
 *   G425  SECRET TUNNEL                (MINOR) — contact while in the tunnel strip
 *   G426  LOADING ZONE protection      (MINOR)
 *   G427  BASE ZONE protection, endgame (MAJOR + counts the victim fully returned)
 *
 * Uniform "protected zone" model: gate/loading/base zones belong to the alliance
 * whose side they sit on (foul the OTHER alliance on contact); the secret-tunnel
 * strip on a wall belongs to the OPPOSING drive team (tunnelStrip(a) is owned by
 * other(a), so the intruder/offender is alliance a).
 *
 * Rules PHYSICALLY PREVENTED by construction (no code needed):
 *   G403/G417  transition freeze — robots are disabled outside auto/teleop.
 *   G416  out-of-zone launching — the shooter simply refuses (see robot.ts).
 * Deferrable (not yet modeled): G423 shutting down major gameplay (incl.
 * completely blocking the opponent's gate — needs "completely blocking" +
 * duration judgment) and displacing an opponent's pre-staged spike artifacts
 * (G402.B).
 */

/** a robot "occupies" a zone if any wheel-corner or its center is inside it */
function robotInRect(r: RobotState, rect: Rect): boolean {
  if (inRect(r.pos, rect)) return true;
  return robotCorners(r).some((c) => inRect(c, rect));
}

const ALLIANCES: Alliance[] = ['red', 'blue'];

export function updatePenalties(
  world: World,
  dt: number,
  commands: Map<number, RobotCommand>,
): void {
  const phase = world.match.phase;
  const pen = world.penalties;
  // fouls are only assessed while robots are competing under match rules. Drop the
  // gate/ramp tracking on the way out: robots are frozen across the transition, so a
  // ramp that keeps draining through it is nobody's foul, and a stale rampBallIds
  // would otherwise bill the whole gap the instant play resumes.
  /**
   * FREE DRIVE COUNTS. `freeplay` is a live phase everywhere else in the sim — `robotsEnabled`
   * says so, the human player restocks in it, the shooter fires in it — and penalties were the
   * one subsystem that quietly excluded it. So the whole engine was OFF in the mode people
   * actually practise in: measured on an identical six-clump herd, free drive drew 0 fouls
   * where a match drew 13. That is why three rounds of "I'm still not getting the penalty" all
   * came back negative no matter what the rule did.
   *
   * Free Drive is DRIVER PRACTICE, and practising without the fouls a match would give you is
   * the opposite of practice. Phase-specific rules stay correctly inert here on their own
   * terms: G402 tests `phase === 'auto'`, and `endgame` tests `phase === 'teleop'`, so neither
   * fires in a mode that has no auto and no clock.
   */
  if (phase !== 'auto' && phase !== 'teleop' && phase !== 'freeplay') {
    for (const a of ALLIANCES) {
      pen.gateCulprit[a] = null;
      pen.rampBallIds[a] = [];
    }
    /**
     * ...and the same goes for G408's clocks, for the same reason. Robots are FROZEN across
     * the eight-second transition, so nothing that happens in it is anybody's control: an
     * artifact resting on a motionless bumper is exactly the case the rule excuses. Carrying
     * the clocks through meant a violation that was live at the AUTO buzzer resumed at the
     * TELEOP one with its grace already spent and its continuing tariff mid-interval —
     * measured, a 0.52 s clock and four ball holds survived the whole gap untouched.
     */
    pen.possession = {};
    pen.possessionBilled = {};
    pen.possessionRebill = {};
    pen.controlHeld = {};
    pen.ballHold = {};
    pen.ballAnchor = {};
    pen.ballCarry = {};
    return;
  }
  const byId = new Map(world.robots.map((r) => [r.id, r] as const));

  /** EPISODE-debounced foul: fires once when `key`'s condition first holds, then
   * stays quiet for as long as it keeps holding (`episodes[key]` is refreshed to
   * `world.time` every active tick). It re-arms only after the condition has been
   * CLEAR for PENALTY_CLEAR — so continuous contact is ONE foul, a 1-tick SAT
   * flicker never re-fouls, and a real re-entry after the gap does. Idempotent
   * within a tick (duplicate contact pair / two rules on one key award once). */
  const fire = (
    key: string,
    offender: Alliance,
    severity: 'minor' | 'major',
    rule: string,
  ): boolean => {
    const last = pen.episodes[key];
    let fired = false;
    if (last === undefined || world.time - last > C.PENALTY_CLEAR) {
      awardFoul(world, offender, severity, rule);
      fired = true;
    }
    pen.episodes[key] = world.time;
    return fired;
  };

  const endgame = phase === 'teleop' && world.match.phaseTimeLeft <= C.ENDGAME_START;

  // ---- G402 AUTO interference: fully on the OPPONENT's side in AUTO --------
  // A robot BELONGS on its own side; in this sim robots stage near their GOAL
  // (startPose uses goalSide), so "own side" is goalSide(alliance) — blue -x,
  // red +x. G402.A fires when the whole footprint has crossed to the opponent's
  // side AND it contacts an opponent. (This uses goalSide, NOT driverSide: goals
  // are cross-court, and the driverSide version was inverted — it fired when a
  // robot sat on its OWN side and fouled the wrong alliance. G304.C ties the
  // AUTO sides to the same columns each alliance starts in.)
  if (phase === 'auto') {
    for (const r of world.robots) {
      const g = goalSide(r.alliance);
      if (robotCorners(r).every((c) => g * c.x < 0) && touchingOpponent(world, r)) {
        fire(`G402:${r.id}`, r.alliance, 'major', 'G402 auto interference');
      }
    }
  }

  // ---- contact-pair zone rules (gate / tunnel / loading / base) -----------
  // Each protected zone is OWNED by one alliance. gate/loading/base sit on the
  // owner's own side and a cross-alliance CONTACT while either robot occupies
  // them fouls the NON-owner ("regardless of who initiates contact"). The
  // secret-tunnel strip on a wall is owned by the OPPOSING drive team
  // (tunnelStrip(a) belongs to other(a)), and — unlike the others — G425 fouls
  // the INTRUDER, so it fires only when the intruder (the non-owner) is actually
  // in the strip, not when the owner is merely defending inside its own tunnel.
  //
  // GATE↔TUNNEL overlap (G424.A): a robot's own gate zone and its opponent's
  // secret tunnel share the classifier corner, so they can overlap. The two are
  // MUTUALLY EXCLUSIVE — if the gate robot is ALSO in the opponent's tunnel the
  // contact is a G425 (only), otherwise it is a G424 (only):
  //   • X in own gate ∩ opponent tunnel, opponent in own tunnel  → G425 (on X)
  //   • X in own gate, NOT opponent tunnel, opponent in own tunnel → G424 (on Y)
  for (const { a, b } of world.rrContacts) {
    const ra = byId.get(a);
    const rb = byId.get(b);
    if (!ra || !rb) continue;
    if (ra.alliance === rb.alliance) continue; // same-alliance contact never fouls
    const pairKey = `${Math.min(a, b)}-${Math.max(a, b)}`;

    for (const O of ALLIANCES) {
      const opp = other(O); // non-owner of O's own zones == the offender
      const oBot = ra.alliance === O ? ra : rb; // the alliance-O robot of the pair
      const oppBot = oBot === ra ? rb : ra; // its opponent (other(O))

      // G424 GATE ZONE is off limits — protect the OWNER's access to their own
      // gate (SAT test: the body can cover the thin gate zone with no corner
      // inside). Exception G424.A: the owner's robot in its own gate zone AND in
      // the opponent's secret tunnel (tunnelStrip(O) is other(O)'s tunnel) is not
      // protected here — G425 governs instead, so skip the gate foul.
      const oInGate = robotIntersectsRect(oBot, gateZone(O));
      const oppInGate = robotIntersectsRect(oppBot, gateZone(O));
      if (oInGate || oppInGate) {
        const exception = oInGate && robotInRect(oBot, tunnelStrip(O));
        if (!exception) fire(`G424:${pairKey}`, opp, 'minor', 'G424 contact in the gate zone');
      }

      // G426 LOADING ZONE protection — owner's own loading zone.
      if (robotInRect(ra, loadZone(O)) || robotInRect(rb, loadZone(O))) {
        fire(`G426:${pairKey}`, opp, 'minor', 'G426 contact in the loading zone');
      }

      // G427 BASE ZONE protection (endgame) — + credit the owner a full return.
      if (endgame && (robotInRect(ra, baseZone(O)) || robotInRect(rb, baseZone(O)))) {
        oBot.baseAwarded = true;
        fire(`G427:${pairKey}`, opp, 'major', 'G427 contact in the base zone');
      }

      // G425 SECRET TUNNEL — tunnelStrip(O) sits under O's goal but is OWNED by
      // other(O); the INTRUDER/offender is alliance O. Fires only when the
      // intruder itself is in the strip (an owner defending its own tunnel is not
      // a foul), which is also what makes G424/G425 mutually exclusive above.
      if (robotInRect(oBot, tunnelStrip(O))) {
        fire(`G425:${pairKey}`, O, 'minor', 'G425 contact in the secret tunnel');
      }
    }
  }

  // ---- G417 opponent gate + G418 artifacts off the opponent's ramp --------
  updateGateFouls(world, commands, fire);

  // ---- G408 over-possession / plowing (per robot, own second-accumulator) --
  updatePossession(world, dt, commands, fire);

  // ---- G422 pinning (ordered pairs, own second-accumulator) ---------------
  updatePins(world, dt, commands);
}

/**
 * G408 — "No more than 3 at a time. A ROBOT may not simultaneously CONTROL more than 3
 * ARTIFACTS." Violation: MINOR FOUL **per ARTIFACT over the limit**.
 *
 * The per-artifact part is the manual's, and it matters: it is what makes shoving a wall of
 * nine artifacts down the field cost six times what carrying one extra does. This used to
 * award a single MINOR however far over you were, so a bulldozer paid the same as a robot
 * with one ball stuck to its bumper.
 *
 * ...and "YELLOW CARD if excessive", where the rule DEFINES excessive rather than leaving
 * it to taste:
 *   A. "simultaneous CONTROL of 5 or more ARTIFACTS", or
 *   B. "frequent (i.e., 3 or more separate [instances] in a MATCH), greater-than-MOMENTARY
 *      CONTROL of 4 or more ARTIFACTS" — MOMENTARY being "fewer than approximately 3
 *      seconds" per the glossary.
 * It also caps itself: "REPEATED excessive violations of this rule do not result in
 * additional YELLOW CARDS", so G408 cards a robot at most once per match. (A second card
 * from ANOTHER rule would escalate it to a red — that is `awardCard`'s job, not this one's.)
 *
 * `controlledArtifacts` decides the count; POSSESSION_GRACE is how much control has to
 * ACCUMULATE on the leaky clock below.
 */
function updatePossession(
  world: World,
  dt: number,
  commands: Map<number, RobotCommand>,
  fire: FireFn,
): void {
  const pen = world.penalties;
  /**
   * SWEEP THE PER-(ROBOT,ARTIFACT) CLOCKS FIRST.
   *
   * `ballHold`/`ballAnchor` are keyed "robotId:ballId" and were only ever deleted along the
   * NOT-TOUCHING path — so an artifact that left the ground state while in contact (the
   * ordinary way one leaves: it gets intaken) kept its clock and its station for the rest of
   * the match. Two consequences, and the second is the sharp one:
   *   · the maps grow without bound inside `world.penalties`, which is plain JSON and rides
   *     every 30 Hz snapshot and every stored replay;
   *   · artifact ids are handed out as `max(id)+1` and `humanPlayer.ts` SPLICES balls out, so
   *     ids are genuinely recycled. A stale key can therefore rebind to a DIFFERENT physical
   *     artifact, which then arrives pre-latched and skips the confirm window entirely — the
   *     one thing standing between herding and BULLDOZING.
   * Iteration is over a snapshot of the keys, in insertion order, so it stays deterministic.
   */
  const live = new Set<string>();
  for (const r of world.robots) {
    for (const b of world.balls) if (b.state.kind === 'ground') live.add(`${r.id}:${b.id}`);
  }
  pen.ballCarry ??= {};
  for (const key of Object.keys(pen.ballHold)) {
    if (!live.has(key)) {
      delete pen.ballHold[key];
      delete pen.ballAnchor[key];
      delete pen.ballCarry[key];
    }
  }
  for (const key of Object.keys(pen.ballAnchor)) if (!live.has(key)) delete pen.ballAnchor[key];
  for (const key of Object.keys(pen.ballCarry)) if (!live.has(key)) delete pen.ballCarry[key];

  for (const r of world.robots) {
    // `cmd.intake || r.autoIntake` is what actually RUNS the intake (robot.ts), and the
    // acquire carve-out has to ask the same question. Reading the raw button alone meant the
    // AUTO-INTAKE assist — a menu option, and forced on for an auto-path robot — silently
    // turned the exemption off for everyone who used it: the assist made the rule HARSHER for
    // its users than for a driver holding the button, which is the opposite of an assist.
    const intaking = (commands.get(r.id)?.intake ?? false) || r.autoIntake;
    const controlled = controlledArtifacts(world, r, dt, intaking);
    const over = controlled - C.POSSESSION_LIMIT;

    // CLAUSE B's clock: one continuous stretch of controlling 4+. The INSTANCE is counted
    // on the tick the stretch crosses MOMENTARY, so a single long hold counts once however
    // long it runs, and the count only grows by letting go and doing it again.
    if (controlled >= C.CARD_CONTROL_FREQUENT) {
      const prev = pen.controlHeld[r.id] ?? 0;
      const now = prev + dt;
      pen.controlHeld[r.id] = now;
      if (prev < C.MOMENTARY_S && now >= C.MOMENTARY_S) {
        pen.controlInstances[r.id] = (pen.controlInstances[r.id] ?? 0) + 1;
      }
    } else {
      // ...and it DRAINS rather than snapping to zero, for the same reason the clock below
      // does. A pile shuffling against a bumper dips under four for a tick or two constantly,
      // and a hard reset let a single dropped frame wipe a nearly-complete instance.
      pen.controlHeld[r.id] = Math.max(0, (pen.controlHeld[r.id] ?? 0) - dt * C.POSSESSION_LEAK);
    }

    // A LEAKY CLOCK, not a resetting one. It fills while over the limit and DRAINS at
    // POSSESSION_LEAK while under, so a violation chopped into repeated FLICKS — bump the
    // pile, back off, bump again — still climbs to the grace.
    //
    // With a resetting clock that technique was free AND better: measured in the sim, a
    // flick-shuttle moved a six-artifact pile twice as far as a sustained shove (18" vs 9")
    // for zero fouls, where the shove drew three and a card. A penalty the evasive version
    // of the same act dodges is worse than no penalty — it does not deter the behaviour, it
    // just selects for the technique.
    let t = pen.possession[r.id] ?? 0;
    if (over > 0) {
      t += dt;
    } else {
      t = Math.max(0, t - dt * C.POSSESSION_LEAK);
      if (t === 0) {
        pen.possessionBilled[r.id] = 0; // fully drained — the next episode bills fresh
        pen.possessionRebill[r.id] = 0;
      }
    }
    pen.possession[r.id] = t;

    // The foul only OPENS on a tick that is actually over the limit, so the first MINOR
    // always corresponds to a real overage; the clock decides WHEN a violation stops being
    // incidental, not what it is billed for.
    if (over > 0 && t >= C.POSSESSION_GRACE) {
      // ONE episode, but N fouls — `fire` owns the edge-debounce (a held violation is one
      // episode, not a stream) and bills the first artifact over the limit.
      if (fire(`G408:${r.id}`, r.alliance, 'minor', 'G408 over-possession')) {
        pen.possessionBilled[r.id] = 1;
      }
      // ...and the rest of the tariff TOPS UP as the pile grows. Billing only at the
      // episode edge meant scooping up more while already over was free: a robot that
      // opened the violation at 4 could grow to 9 inside the same hold and still pay for
      // one. It is a MINOR "per SCORING ELEMENT over the limit" — all of them.
      const billed = pen.possessionBilled[r.id] ?? 0;
      for (let i = billed; i < over; i++) {
        awardFoul(world, r.alliance, 'minor', 'G408 over-possession');
      }
      if (over > billed) pen.possessionBilled[r.id] = over;

      /**
       * ...AND A VIOLATION THAT KEEPS GOING KEEPS COSTING.
       *
       * Billing once per episode meant the whole tariff for hoarding six artifacts was three
       * MINORs, after which holding them for the rest of the match was free. G408 fouls the
       * STATE of controlling too many, and a state that persists is a violation that
       * persists — so the tariff is charged again every POSSESSION_REBILL_S the robot is
       * still over the limit. The clocks in front of this (per-artifact confirm, then the
       * grace) are what keep a legitimate pass through a clump from ever reaching a second
       * billing.
       */
      // The cursor is ANCHORED at the opening tick and CLAMPED to the clock. It used to start
      // at 0 and be guarded by `since > 0`, which quietly ate the first interval: the first
      // continuing charge landed at TWICE POSSESSION_REBILL_S (measured, 6.02 s on a 3 s
      // interval), and after a partial drain the cursor could sit AHEAD of the clock and bank
      // a free window of hoarding until the clock climbed back past it.
      let since = pen.possessionRebill[r.id] ?? 0;
      if (since === 0 || since > t) {
        since = t;
        pen.possessionRebill[r.id] = t;
      }
      if (t - since >= C.POSSESSION_REBILL_S) {
        pen.possessionRebill[r.id] = t;
        {
          for (let i = 0; i < over; i++) {
            awardFoul(world, r.alliance, 'minor', 'G408 over-possession (continuing)');
          }
        }
      }

      // The CARD is likewise re-checked every tick the violation is live, not once at the
      // edge — clause A is about what is controlled AT THE MOMENT, and a pile that grows
      // past 5 after the episode opened is exactly the case it exists for.
      const excessive =
        controlled >= C.CARD_CONTROL_SIMULTANEOUS ||
        (pen.controlInstances[r.id] ?? 0) >= C.CARD_CONTROL_INSTANCES;
      if (excessive && !pen.carded[r.id]) awardCard(world, r, 'G408 excessive control');
    }
  }
}

/**
 * HOW MANY ARTIFACTS THIS ROBOT IS CONTROLLING.
 *
 * DECODE DEFINES EXACTLY ONE TERM HERE, and it is CONTROL. This function used to be written
 * against two others — an FRC-style POSSESSION ("as the ROBOT moves or changes ORIENTATION,
 * the object remains in approximately the same position relative to the ROBOT") and a TRAPPING
 * ("preventing the movement of a SCORING ELEMENT against a FIELD element") — and NEITHER IS IN
 * THIS MANUAL. There is no POSSESSION entry and no TRAPPING entry in the DECODE glossary; the
 * word TRAPPING does not appear in Section 11 at all, and the only PIN/PINNING definition is
 * about opponent ROBOTS. The quoted TRAPPING was DECODE's PIN/PINNING with "opponent ROBOT"
 * swapped for "SCORING ELEMENT". Two invented tests carried most of the weight of the rule.
 *
 * The real definition, verbatim (Section 16, V2):
 *
 *   "an action by a ROBOT in which the SCORING ELEMENT is fully supported by or stuck in, on,
 *    or under the ROBOT or it intentionally pushes a SCORING ELEMENT to a desired location or
 *    in a preferred direction (i.e., herding). CONTROL requires contact with a ROBOT, either
 *    directly or transitively through other SCORING ELEMENTS. Typically, CONTROL requires one
 *    of the following to be true:
 *      A. The SCORING ELEMENT is fully supported by the ROBOT
 *      B. The ROBOT is moving the SCORING ELEMENT in a preferred direction with a flat or
 *         concave face of the ROBOT"
 *
 * So there are exactly two ways to control an artifact, and this function is the two of them:
 *
 *   A. FULLY SUPPORTED — the hopper. `r.hopper.length`, added at the bottom.
 *   B. HERDING — "intentionally pushes ... to a desired location or in a preferred direction",
 *      which decomposes into four things the code can actually ask:
 *        · CONTACT with the footprint (the definition says so outright), directly or
 *          TRANSITIVELY through other artifacts;
 *        · a FLAT OR CONCAVE FACE — `contactFace` returns null off a convex CORNER, which is
 *          the one piece of geometry clause B names and the engine had never modelled;
 *        · IN A PREFERRED DIRECTION — the robot's own rigid-body velocity AT the contact point
 *          must carry it INTO the artifact along that face's outward normal. A direction, not
 *          a speed: the previous test was the artifact's ABSOLUTE speed, which says nothing
 *          about who is moving it or where;
 *        · INTENTIONALLY — sustained past POSSESSION_CONFIRM while the artifact keeps its
 *          station on the chassis. The manual gives no numeric test for intent, so this is the
 *          sim's proxy for a referee's eye, and it is the whole of the BULLDOZING and
 *          DEFLECTING carve-outs: something you clip in passing never lasts, and something
 *          that bounces off leaves at once.
 *
 * ...AND "TO A DESIRED LOCATION" IS WHY CONTROL LATCHES.
 *
 * Once herding has been established the artifact stays controlled while contact and station
 * hold, whether or not the robot is still pushing — because having pushed it somewhere and
 * held it there is the first half of that phrase. This is what replaced the invented TRAPPING
 * branch, and it lands in the same place from the real definition: a robot that drove a pile
 * into the perimeter and sits on it is controlling the pile. Measured before this change, that
 * robot paid four MINORs once and then held the pile for the rest of the match for free.
 *
 * It also removes the two ABSOLUTE-SPEED gates that stood in front of the whole rule. There is
 * no speed floor anywhere in the definition, and the floors were exploitable in both
 * directions: a hoard crept below POSSESSION_MOVE_SPEED was invisible (measured: a six-artifact
 * pile walked for twelve seconds, zero fouls), and a jammed pile read as uncontrolled precisely
 * because it could not move. A robot that never pushed anything never latches, so the case that
 * these gates were reached for — "I'm getting spammed with over-possession continuing penalties
 * just by standing still" — is answered by intent rather than by a velocity threshold.
 */

/**
 * HOW HARD THE ROBOT IS PUSHING this artifact, in in/s along the outward contact direction —
 * or NULL if the artifact is not on a face the rule allows you to herd with.
 *
 * This is CONTROL clause B in one number: "The ROBOT is moving the SCORING ELEMENT in a
 * preferred direction with a FLAT OR CONCAVE FACE of the ROBOT."
 *   · the FACE half is the null: a corner is neither flat nor concave, and a ball met by a
 *     vertex squirts off it rather than being taken anywhere, which is why the rule names the
 *     geometry at all;
 *   · the PREFERRED DIRECTION half is the sign: the robot's own rigid-body velocity at the
 *     contact, projected onto the direction it would drive the artifact.
 */
function contactPush(
  r: RobotState,
  b: Artifact,
  cp: Vec2,
  loc: Vec2,
): { speed: number; dirX: number; dirY: number } | null {
  const e = robotExtents(r);
  // how far the artifact's centre lies BEYOND each face plane; the nearest feature is a convex
  // CORNER precisely when it is beyond both at once, which is the whole of the clause-B test
  const ox = loc.x > e.front ? loc.x - e.front : loc.x < -e.rear ? loc.x + e.rear : 0;
  const oy = loc.y > e.half ? loc.y - e.half : loc.y < -e.half ? loc.y + e.half : 0;
  if (ox !== 0 && oy !== 0) return null; // a convex CORNER — neither flat nor concave
  /**
   * The outward direction is taken from the CONTACT, not by snapping to a face: for an artifact
   * resting on a face it IS that face's normal, and it has no degenerate case. Snapping was
   * tried and is subtly broken — an artifact equidistant from the front face and a flank (which
   * a square-ish chassis makes an ordinary position, not a corner case) picks its face on a
   * 1e-11 rounding, and picking the flank means a robot driving dead ahead reads as pushing
   * NOTHING. Measured, that silently zeroed the whole rule for a centred artifact.
   */
  let dx = b.pos.x - cp.x;
  let dy = b.pos.y - cp.y;
  let m = hyp(dx, dy);
  if (m < 1e-6) {
    // centre INSIDE the footprint (a deep overlap): the way the chassis would shove it out
    dx = b.pos.x - r.pos.x;
    dy = b.pos.y - r.pos.y;
    m = hyp(dx, dy);
  }
  if (m < 1e-6) return null;
  /**
   * "MOVING the SCORING ELEMENT" is the magnitude; "in a PREFERRED DIRECTION" is the sign, and
   * the sign is only ever used to rule out the robot pulling AWAY. Projecting onto the outward
   * normal and using THAT as the magnitude is too strong: a robot spinning a corralled pile has
   * a purely TANGENTIAL point velocity, so its outward component is zero and a pile swung round
   * on the spot read as uncontrolled — which is the opposite of what anyone watching would say.
   *
   * Relaxing the magnitude costs nothing, because what stops a DRIVE-PAST from counting is not
   * the sign but the STATION test above: an artifact the robot slides past sweeps the length of
   * the chassis and re-anchors in a few hundredths of a second, where one carried round by a
   * spin holds a constant `loc` (the anchor is in the ROBOT frame, so rigid rotation does not
   * move it). Direction still rules out reversing off an artifact, and the tolerance is there
   * so a tangential contact cannot be tipped negative by rounding.
   */
  const pv = robotPointVelocity(r, cp);
  if ((pv.x * dx + pv.y * dy) / m < -C.POSSESSION_PUSH_MIN) return null; // backing away, not herding
  const speed = hyp(pv.x, pv.y);
  if (speed < C.POSSESSION_PUSH_MIN) return null;
  // ...and WHICH WAY it is being taken: the contact point's own direction of travel. Not the
  // outward normal — under a SPIN the point velocity is purely tangential and the normal
  // component is zero, so a corralled pile swung round would read as going nowhere.
  return { speed, dirX: pv.x / speed, dirY: pv.y / speed };
}

function controlledArtifacts(world: World, r: RobotState, dt: number, intaking: boolean): number {
  const pen = world.penalties;
  const home = loadZone(r.alliance);
  const reach = C.BALL_RADIUS + C.POSSESSION_CONTROL_MARGIN; // touching the footprint
  const chain = C.BALL_RADIUS * 2 + C.POSSESSION_CONTROL_MARGIN; // ...or touching one that is
  const loose = world.balls.filter((b) => b.state.kind === 'ground');

  const held = new Set<number>();
  for (const b of loose) {
    const key = `${r.id}:${b.id}`;
    const cp = closestPointOnRobot(r, b.pos);
    if (hyp(b.pos.x - cp.x, b.pos.y - cp.y) > reach) {
      /**
       * Not touching THIS TICK: the clock drains, and a long enough gap forgets the station.
       *
       * An ESTABLISHED hold still counts while it drains, though, and that is not a fudge — it
       * is the difference between the rule working in open space and not. Artifacts do not ride
       * a bumper here, they bounce off it and are re-struck, so a herded pile is in contact
       * only intermittently. Counting an artifact solely on the ticks it happens to be touching
       * meant a robot pushing a six-clump across the floor controlled exactly THREE (its hopper)
       * for 97% of ticks the moment the driver so much as steered — measured — and the rule
       * simply never fired. Reported as "when I just push a clump in open space it doesn't
       * give me [the penalty]".
       *
       * The drain is what bounds it: at POSSESSION_LEAK an artifact stops counting a couple of
       * confirm-windows after the robot really has left it, and one that was never established
       * has nothing to drain.
       */
      const prev = pen.ballHold[key];
      if (prev !== undefined) {
        const t = prev - dt * C.POSSESSION_LEAK;
        if (t <= 0) {
          delete pen.ballHold[key];
          delete pen.ballAnchor[key];
        } else {
          pen.ballHold[key] = t;
          if (t >= C.POSSESSION_CONFIRM) held.add(b.id);
        }
      }
      continue;
    }
    const loc = rot({ x: b.pos.x - r.pos.x, y: b.pos.y - r.pos.y }, -r.heading);
    const anchor = pen.ballAnchor[key];
    const carried = (pen.ballCarry ??= {});
    const stationed =
      anchor !== undefined && hyp(loc.x - anchor.x, loc.y - anchor.y) <= C.POSSESSION_DRIFT;
    if (!stationed) {
      /**
       * First contact, or it has slid to a NEW station on the chassis — re-anchor there rather
       * than crediting travel across the robot as if it had stayed put. `loc` is in the ROBOT
       * frame, so turning with an artifact held in front of you does not move it: only an
       * artifact actually slipping relative to the chassis re-anchors.
       *
       * A re-anchor RESTARTS the clock but does NOT break an ESTABLISHED hold, because the two
       * are different questions: the clock is how control is ACQUIRED, and contact is how it is
       * KEPT. An artifact still touching the robot has not got away from it. Resetting an
       * established hold here silently unmade the rule in the one place it bites hardest — a
       * pile driven into the perimeter COMPRESSES as it jams, every artifact re-anchors on the
       * same tick, and a stalled robot has no push left to rebuild the clock with. Measured,
       * shoving a six-clump onto a wall and leaning on it drew nothing at all.
       */
      pen.ballAnchor[key] = { x: loc.x, y: loc.y };
      const was = pen.ballHold[key] ?? 0;
      const latched = was >= C.POSSESSION_CONFIRM;
      pen.ballHold[key] = latched ? was : 0;
      // the WORLD origin travels with the hold, not with the station: a latched artifact
      // shuffling along the bumper has not been re-found, and re-zeroing how far it has come
      // every time it slips would mean a pile that rattles can never be shown to have moved.
      if (latched) held.add(b.id);
      continue;
    }
    /**
     * CLAUSE B, as the clause actually reads: a FLAT OR CONCAVE FACE, and the ROBOT moving the
     * artifact IN A PREFERRED DIRECTION. `robotPointVelocity` carries the ω×r term, so a robot
     * turning a corralled pile is moving it just as surely as one driving into it — which is
     * how "changes ORIENTATION" survives the loss of the FRC definition it used to come from.
     */
    /**
     * ...and clause B's verb is MOVING: the robot has to be driving into it (`push`), on a face
     * rather than a corner (`push !== null`), AND THE ARTIFACT HAS TO ACTUALLY BE GOING
     * SOMEWHERE. Pressing on something that cannot move is contact, not herding — G408's own
     * "bulldozing ... while in the path of the ROBOT moving about the FIELD".
     *
     * This gates ACQUIRING only. The latch below carries an established hold straight through a
     * jam, so a pile you DROVE into the wall keeps counting while one that was already there
     * never starts. That split is the whole of the leniency: running into things is free,
     * taking them somewhere is not.
     */
    const push = contactPush(r, b, cp, loc);
    let carry = carried[key] ?? 0;
    // how far the artifact ACTUALLY WENT this tick in the direction the robot is taking it,
    // projected so that squirting SIDEWAYS out of a squeeze earns nothing: a row pinned on the
    // perimeter is moving quickly and travelling nowhere.
    const along = push ? b.vel.x * push.dirX + b.vel.y * push.dirY : 0;
    if (along > 0) carry += along * dt;
    carried[key] = carry;
    let t = pen.ballHold[key] ?? 0;
    /**
     * ...AND AN ARRIVAL IS NOT A JOURNEY. The hold ADVANCES while the artifact is still being
     * taken somewhere, and DRAINS while it is merely being leaned on — even in full contact.
     *
     * Without that drain, control latched on the way in and never let go: shoving two artifacts
     * against a wall billed once for the push (fair, you did herd them there) and then again
     * every POSSESSION_REBILL_S for as long as you stayed, while nothing moved at all. Reported
     * as "I still get penalties when I'm pushing forward against two balls against the wall...
     * it counts as me moving them even tho its basically staying in place."
     */
    if (carry >= C.POSSESSION_CARRY_DIST && along > C.POSSESSION_MOVE_MIN) t += dt;
    else if (along <= C.POSSESSION_MOVE_MIN) t = Math.max(0, t - dt * C.POSSESSION_LEAK);
    pen.ballHold[key] = t;
    // ...and once it is established it LATCHES: "pushes a SCORING ELEMENT TO A DESIRED
    // LOCATION" does not stop being true when the robot stops shoving.
    if (t >= C.POSSESSION_CONFIRM) held.add(b.id);
  }

  /**
   * ...AND AN ARTIFACT ON ITS WAY INTO A SLOT IS NOT A FOURTH ARTIFACT.
   *
   * POSSESSION_LIMIT and HOPPER_CAPACITY are the same three, so an artifact being drawn in is
   * already charged against the limit by the slot waiting for it — counting it in the mouth as
   * well charges that slot twice. It is capped at the room actually LEFT, nearest the mouth
   * first. A FULL robot is acquiring nothing, so it gets none of it and ploughs exactly as hard
   * with the intake running as without — the case that made this worth capping rather than
   * deleting.
   *
   * NOTE this is NOT G408's carve-out C, which is narrower ("inadvertent contact with a SCORING
   * ELEMENT while attempting to acquire a SCORING ELEMENT FROM THE LOADING ZONE" — that one is
   * `inHome` below). This is the sim's own, and it exists because the sim's intake is a
   * multi-tick animation where a real one is instantaneous: an artifact the rollers already own
   * would otherwise be billed for the fraction of a second it spends visibly outside the frame.
   */
  const excused = new Set<number>();
  /**
   * ...AND IT COVERS WHAT THE ROLLERS ARE ACTUALLY TAKING, WHICH IS ONE ARTIFACT (two for a
   * triangle's twin slots) — NOT the whole hopper.
   *
   * Bounding it by hopper ROOM alone is what made this rule unreachable for anyone playing with
   * the assists on, which is the default. `autoFire` keeps all three slots empty, `autoIntake`
   * keeps `intaking` true, so THREE artifacts were excused on every tick forever. Measured on a
   * six-clump herded in open space with the player's own defaults: the robot was in contact with
   * SIX artifacts the whole way, three were excused every tick, the count never passed the limit
   * and the foul never came — 0 MINORs, against 9 for the same push with auto-intake off.
   *
   * The exemption exists because the sim's intake is a multi-tick animation where a real one is
   * instantaneous, so it should cover the artifact the rollers own RIGHT NOW and nothing else.
   * An intake takes one per cycle; excusing a hopper's worth at once modelled nothing.
   */
  const perCycle = C.INTAKE_PRESETS[r.spec.intake].mouth.dual ? 2 : 1;
  let room = Math.min(perCycle, Math.max(0, C.HOPPER_CAPACITY - r.hopper.length));
  if (room > 0 && intaking) {
    const mouth = [...held]
      .map((id) => {
        const b = loose.find((x) => x.id === id)!;
        const loc = rot({ x: b.pos.x - r.pos.x, y: b.pos.y - r.pos.y }, -r.heading);
        return { id, ahead: loc.x, hold: pen.ballHold[`${r.id}:${b.id}`] ?? 0 };
      })
      /**
       * ...AND ONLY FOR AS LONG AS ACQUIRING TAKES.
       *
       * Hopper room alone is not enough, and this is exactly how it fails: a driver who keeps
       * shooting keeps three slots open, so three artifacts are excused permanently, and
       * herding up to six of them in a straight line with the intake held costs nothing.
       * Reported as "I am able to completely avoid penalties in some cases where I'm simply
       * herding going straight."
       *
       * An intake takes what is in its mouth in well under a second. Past that window an
       * artifact has had every chance to be taken, so whatever is happening to it, it is not
       * being acquired — it is being pushed along. The window is per ARTIFACT, so a robot
       * genuinely working through a pile keeps its exemption on each new one it meets while
       * the ones it is merely shoving age out of it.
       */
      .filter((m) => m.ahead > 0 && m.hold < C.POSSESSION_CONFIRM + C.POSSESSION_ACQUIRE_S)
      .sort((p1, p2) => p1.ahead - p2.ahead || p1.id - p2.id);
    for (const m of mouth) {
      if (room <= 0) break;
      held.delete(m.id);
      excused.add(m.id);
      room--;
    }
  }

  /**
   * ...AND CARVE-OUT C: THE LOADING ZONE, scoped the way the rule scopes it.
   *
   * "inadvertent contact with a SCORING ELEMENT while attempting to acquire a SCORING ELEMENT
   * FROM THE LOADING ZONE". The exemption is about a robot IN there collecting its restock, so
   * that is the test. It used to key on the ARTIFACT's position alone, which is a different
   * rule and a worse one in both directions: a robot parked OUTSIDE the zone reaching in and
   * holding a pile was excused, and the whole 23x23 corner became a control-free sanctuary the
   * manual does not grant — G432.D settles that outright by describing an ARTIFACT whose
   * "CONTROL begins when the ROBOT is in the LOADING ZONE" and which "is still CONTROLLED by
   * the ROBOT when the ROBOT leaves", so CONTROL demonstrably applies in there.
   *
   * Carrying one OUT is therefore control again, correctly, and always was.
   */
  if (robotInRect(r, home)) {
    for (const b of loose) {
      // unconditionally, NOT just the ones already held: the artifact the robot has not got a
      // grip on yet still has to be excused, or the CHAIN reaches it through one that is and
      // the carve-out leaks. That is exactly how the restock row fouled — one of the three was
      // on a flank with no push behind it, so it was never in `held`, never excused, and came
      // straight back in as a chain member off the two beside it.
      if (inRect(b.pos, home)) {
        held.delete(b.id);
        excused.add(b.id);
      }
    }
  }

  /**
   * ...THEN THE CHAIN, because CONTROL "requires contact with a ROBOT, either directly or
   * TRANSITIVELY through other SCORING ELEMENTS". The transitive half asks for CONTACT and
   * nothing else — an artifact three deep in a shoved wedge is controlled because it is
   * pressed against one that is, however much it rolls on the way.
   *
   * An EXCUSED artifact CONDUCTS but is not COUNTED. Both halves matter and they used to be
   * wrong in opposite directions. It used to be counted anyway — the chain simply re-added
   * every artifact the mouth exemption had just removed, which is the same number with extra
   * steps. Making it neither went too far the other way: severing the chain at the mouth means
   * a robot nosing into a six-clump controls NOTHING, because the only artifacts touching it
   * are the excused ones and nothing behind them can be reached. The exemption is about what
   * you are CHARGED for; it cannot repeal the physical fact that the pile behind is pressed
   * against the robot through the artifact in the mouth.
   */
  const reached = new Set([...held, ...excused]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const b of loose) {
      if (reached.has(b.id)) continue;
      for (const o of loose) {
        if (!reached.has(o.id)) continue;
        if (hyp(b.pos.x - o.pos.x, b.pos.y - o.pos.y) <= chain) {
          reached.add(b.id);
          grew = true;
          break;
        }
      }
    }
  }
  let controlled = 0;
  for (const id of reached) if (!excused.has(id)) controlled++;
  return r.hopper.length + controlled;
}

type FireFn = (key: string, offender: Alliance, severity: 'minor' | 'major', rule: string) => boolean;

/** G417 (TOUCHING an OPPOSING GATE — MAJOR) + G418.B (each classified ARTIFACT that
 * leaves an opponent's RAMP because their gate was opened — MAJOR per artifact).
 *
 * G417 fires when an opponent is TOUCHING the gate arm (`gateArmRect`): merely
 * touching the opponent's gate is a foul even if the robot never opens it (you don't
 * have to succeed in opening it — contact with the arm is the violation).
 *
 * G418.B is billed on the DRAIN, not on the touch: `rampBallIds` remembers which
 * classified artifacts were resting on each ramp last tick, and every one that has
 * LEFT this tick costs the responsible opponent a MAJOR. So a TAP that never lifts
 * the arm past the pass fraction drains nothing and costs G417 alone (billing the
 * whole standing column on contact was the old bug), while a real opening is billed
 * artifact-by-artifact as the column empties — including after the offender drives
 * away, since the flow finishes the drain on its own.
 *
 * Responsibility (`gateCulprit`) is pinned to an opponent who actually WORKS the arm
 * (`pushingGate` — the physical push that lifts it), not to anyone merely brushing
 * it: an owner draining their own ramp while an opponent leans on the lever is the
 * owner's own doing, and stays unbilled. It clears once the gate shuts.
 *
 * Touching your OWN gate is legal (that is how an alliance clears its own overflow).
 * Matches the manual's Example 3: work the opponent gate => 1 G417 + one G418 per
 * artifact that leaves. */
function updateGateFouls(
  world: World,
  commands: Map<number, RobotCommand>,
  fire: FireFn,
): void {
  const pen = world.penalties;
  for (const a of ALLIANCES) {
    const goal = world.goals[a];

    // opponents TOUCHING gate a's arm (contact with the physical gate, not merely
    // loitering in the gate zone). Touching your own gate is legal, so only the
    // owner's opponents are flagged — and no push/opening is required.
    let opener: Alliance | null = null; // an opponent actually working it OPEN
    for (const r of world.robots) {
      if (r.alliance === a) continue;
      if (!robotIntersectsRect(r, gateArmRect(a))) continue;
      fire(`G417:${a}:${r.id}`, r.alliance, 'major', 'G417 opponent gate');
      if (pushingGate(r, commands.get(r.id) ?? ZERO_CMD, a)) opener = r.alliance;
    }

    // update who is responsible for gate a being open: an opponent who pushes it
    // takes the blame and keeps it through the drain; it clears once the gate is
    // shut (opened legally by the owner, or never opened at all => stays null)
    if (opener) pen.gateCulprit[a] = opener;
    else if (!goal.gateOpen) pen.gateCulprit[a] = null;

    // G418.B — bill the artifacts that actually LEFT the ramp since last tick
    const onRamp: number[] = [];
    for (const b of world.balls) {
      const st = b.state;
      if (st.kind === 'rail' && st.goal === a && !st.overflow && !st.pending) onRamp.push(b.id);
    }
    const culprit = pen.gateCulprit[a];
    if (culprit) {
      const still = new Set(onRamp);
      for (const id of pen.rampBallIds[a]) {
        if (!still.has(id)) awardFoul(world, culprit, 'major', 'G418 artifact off opponent ramp');
      }
    }
    pen.rampBallIds[a] = onRamp;
  }
}

/** does robot r share a recorded contact with any opposing robot this tick? */
function touchingOpponent(world: World, r: RobotState): boolean {
  for (const { a, b } of world.rrContacts) {
    if (a !== r.id && b !== r.id) continue;
    const otherId = a === r.id ? b : a;
    const o = world.robots.find((x) => x.id === otherId);
    if (o && o.alliance !== r.alliance) return true;
  }
  return false;
}

/** the ESCAPE direction for a pin: the unit vector from the pinner to the pinned
 * robot, i.e. the way the victim would have to go to get out. Null when the two are
 * coincident, where "away" is undefined. */
function escapeDir(pinner: RobotState, pinned: RobotState): { x: number; y: number } | null {
  const dx = pinned.pos.x - pinner.pos.x;
  const dy = pinned.pos.y - pinner.pos.y;
  const d = hyp(dx, dy);
  if (d < 1e-3) return null;
  return { x: dx / d, y: dy / d };
}

/**
 * Is `pinned` trapped against a SOLID with `pinner` on the open-field side?
 *
 * True when the pinned robot's leading corner (straight AWAY from the pinner) sits
 * within PIN_WALL_SLOP of something it cannot drive through — i.e. it cannot retreat
 * from the pinner. This is what distinguishes the aggressor from the victim in a
 * shove where both robots are slow and both are commanding motion.
 *
 * "Solid" means every solid, not just the perimeter. The old test accepted the field
 * wall alone, so a robot held against a GOAL WEDGE or a CLASSIFIER CHANNEL — the two
 * corners of the field where pinning actually happens, since that is where everyone
 * is trying to score — was never recognised as pinned at all.
 */
function pinnedAgainstWall(pinner: RobotState, pinned: RobotState): boolean {
  const e = escapeDir(pinner, pinned);
  if (!e) return false;
  let reach = 0;
  for (const c of robotCorners(pinned)) {
    reach = Math.max(reach, (c.x - pinned.pos.x) * e.x + (c.y - pinned.pos.y) * e.y);
  }
  const p = {
    x: pinned.pos.x + e.x * (reach + C.PIN_WALL_SLOP),
    y: pinned.pos.y + e.y * (reach + C.PIN_WALL_SLOP),
  };
  if (Math.abs(p.x) >= C.FIELD_HALF || Math.abs(p.y) >= C.FIELD_HALF) return true; // perimeter
  for (const a of ['red', 'blue'] as Alliance[]) {
    // goalLineValue > 0 is BEHIND the goal face — inside the wedge. The probe point
    // is inside the field by the test above, so that alone places it in the footprint.
    if (goalLineValue(p, a) > 0) return true;
    if (inRect(p, classifierRect(a))) return true;
  }
  return false;
}

/**
 * The world-frame direction a robot is TRYING to translate, or null if it is not asking to
 * translate at all. Mirrors `updateRobot`'s own command decode, because "attempting to move"
 * has to mean the same thing to the referee as it does to the drivetrain.
 *
 * TANK IS WHY THIS IS A FUNCTION. A tank (or a butterfly on its traction set) is commanded as
 * SIDE-DRIVE, and the old test read only `driveX`/`driveY`/`rotate` — which a Traditional-tank
 * driver on separate sticks never fills. Such a robot was never "attempting to move", so it
 * could not be pinned at all: G422 simply did not protect it.
 */
function attemptDir(r: RobotState, cmd: RobotCommand | undefined): Vec2 | null {
  if (!cmd) return null;
  // `driveIntent` (physics.ts) is the one decode of a stick into a world-frame heading -
  // tank's two side-drives, a field-centric stick with only the camera undone, exactly as
  // `updateRobot` reads them. This rule needs only the DIRECTION.
  const world = driveIntent(r, cmd);
  const m = hyp(world.x, world.y);
  return m > 0.1 ? { x: world.x / m, y: world.y / m } : null;
}

/**
 * Is `pinner` PINNING `pinned` right now?
 *
 * G422: "A ROBOT is PINNING if it is preventing the movement of an opponent ROBOT by contact,
 * either direct or transitive (such as against a FIELD element) and the opponent ROBOT is
 * attempting to move."
 *
 * Three clauses are the rule's own. The fourth — `pinnedAgainstWall` — is the sim standing in
 * for a referee; see PIN_WALL_SLOP for why something has to break the symmetry of a shove, and
 * what leaving it in costs.
 */
function isPinning(
  pinner: RobotState,
  pinned: RobotState,
  contact: boolean,
  cmd: RobotCommand | undefined,
  pinnerCmd: RobotCommand | undefined,
): boolean {
  if (!contact) return false;
  const e = escapeDir(pinner, pinned);
  if (!e) return false;

  /**
   * THE PINNER HAS TO BE DOING THE HOLDING — and this, not a wall, is what breaks the SYMMETRY
   * of a shove.
   *
   * `pinnedAgainstWall` used to be a hard requirement, kept (it is NOT in the rule — a FIELD
   * element is an example, "such as") precisely because it was the only thing telling the
   * aggressor from the victim when two robots are leaning on each other. But it also meant a
   * pin in OPEN FIELD drew nothing at all, which is not what the rule says and not what a
   * referee calls: reported as "pinning penalty should happen without being against the wall."
   *
   * Requiring the pinner to be DRIVING INTO its victim does the same job directly. Two robots
   * shoving head-on both satisfy it, which makes the pin mutual, and criterion C already
   * throws a mutual pin out as nobody's foul — so the stalemate the wall test existed to
   * exclude is still excluded, by the clause that is actually about it. What it no longer
   * excludes is the ASYMMETRIC case: one robot driving into another that is trying to get away
   * across open floor, which is a pin by every word of the rule.
   *
   * `rrContacts` is recorded on geometric OVERLAP ALONE (physics.ts), so contact by itself says
   * nothing about who is holding whom; without this, an incidental lean would bill a MINOR
   * every 3 s.
   */
  const push = attemptDir(pinner, pinnerCmd);
  if (!push || push.x * e.x + push.y * e.y < C.PIN_PRESS_COS) return false;

  /**
   * ...AND A ROBOT CORNERED AGAINST A SOLID IS ESCAPING, NOT PINNING.
   *
   * Without this, dropping the wall requirement quietly cancelled every wall pin there is. The
   * victim held against a wall pushes BACK into its pinner, which is pressing toward it — so
   * the reverse direction also read as a pin, criterion C called the pair mutual, and the whole
   * thing was thrown out as nobody's foul. Measured: sixteen existing checks went to zero.
   *
   * The wall test used to prevent that as a side effect (the pusher is not against anything, so
   * the reverse never qualified). Stated directly it is a better rule than the one it replaces:
   * a robot with a solid at its back and an opponent at its front is the one being HELD, and
   * pressing toward the opponent is the only way out. That is escaping. It cannot also be the
   * pinning.
   *
   * Two robots meeting in open floor are both free to leave, so both still qualify, and
   * criterion C throws that out as the mutual shove it is.
   */
  if (pinnedAgainstWall(pinned, pinner)) return false;

  /**
   * A VICTIM DOES NOT HAVE TO BE STRUGGLING TO BE PINNED.
   *
   * The rule's own words are "and the opponent ROBOT is ATTEMPTING TO MOVE", and reading that
   * as "the victim's stick is deflected this tick" is what kept the foul rare: a driver who is
   * held stops mashing the stick — they line up a shot, they wait for their partner, they give
   * up — and the pin stopped counting the moment they did. A referee cannot see a stick; what
   * they see is one robot holding another, and they call it either way.
   *
   * ⚠️ A DEVIATION from the rule as written, in the same class as `POSSESSION_REBILL_S`.
   */
  const want = attemptDir(pinned, cmd);
  if (!want) return true;

  /**
   * ...and the ONE case still excluded: a robot driving ITSELF into something it cannot pass.
   * It satisfies contact, attempting to move and going nowhere, while the opponent behind it
   * prevents nothing — measured, the WEAKEST legal build "pinned" a default chassis that way.
   *
   * THIS TEST ONLY MEANS ANYTHING WHEN THERE IS A TRAP. `escapeDir` points from the pinner to
   * the victim, so `want` agreeing with it is a robot pressing further into whatever is behind
   * it — but only if something IS behind it. In open field that same direction is the genuine
   * escape, straight away from the pinner, and excluding it would throw out the very case this
   * change exists to catch. So it is asked only when the victim really is against a solid.
   *
   * Note it deliberately does NOT ask whether the pinner lies along `want`: that is true of a
   * straight reverse and false of every SIDEWAYS exit, so it ruled out the ordinary wall pin
   * (measured: a victim welded to the wall billed ZERO). Whether an escape SUCCEEDS is measured
   * afterwards by `PIN_STUCK_SPEED` and criteria A/B — prevention is an outcome, not a stick
   * direction.
   */
  if (!pinnedAgainstWall(pinner, pinned)) return true;
  return e.x * want.x + e.y * want.y < C.PIN_INTO_TRAP_COS;
}

function updatePins(world: World, dt: number, commands: Map<number, RobotCommand>): void {
  const pen = world.penalties;
  // contacts this tick, as an undirected id-pair set
  const contacts = new Set(world.rrContacts.map(({ a, b }) => `${a}-${b}`));
  const inContact = (i: number, j: number): boolean =>
    contacts.has(`${Math.min(i, j)}-${Math.max(i, j)}`);

  // every ordered opposing pair's verdict FIRST, because criterion C is about both of them
  const pinning = new Map<string, boolean>();
  for (const pinner of world.robots) {
    for (const pinned of world.robots) {
      if (pinner.id === pinned.id || pinner.alliance === pinned.alliance) continue;
      pinning.set(
        `${pinner.id}-${pinned.id}`,
        isPinning(
          pinner,
          pinned,
          inContact(pinner.id, pinned.id),
          commands.get(pinned.id),
          commands.get(pinner.id),
        ),
      );
    }
  }

  for (const pinner of world.robots) {
    for (const pinned of world.robots) {
      if (pinner.id === pinned.id || pinner.alliance === pinned.alliance) continue;
      const key = `${pinner.id}-${pinned.id}`;
      const held = pinning.get(key) === true;
      /** criterion C: "the PINNING ROBOT gets PINNED" — a mutual hold is nobody's foul */
      const mutual = held && pinning.get(`${pinned.id}-${pinner.id}`) === true;

      let st = pen.pins[key];
      if (!st) {
        if (!held || mutual) continue;
        st = {
          seconds: 0,
          ox: pinned.pos.x,
          oy: pinned.pos.y,
          pox: pinner.pos.x,
          poy: pinner.pos.y,
          px: pinned.pos.x,
          py: pinned.pos.y,
          billed: 0,
          sepFor: 0,
          awayFor: 0,
        };
        pen.pins[key] = st;
      }

      if (mutual) {
        delete pen.pins[key]; // C
        continue;
      }

      /**
       * A and B, which are the ONLY things that end a pin.
       *
       * Both are distances held for MORE THAN THREE SECONDS, and both PAUSE the count in the
       * meantime rather than resetting it — the rule says so twice, and it is the whole
       * difference between a pin you can shrug off and one you cannot. The sim used to end a pin
       * after 0.6 s of the hold merely LAPSING, for any reason at all, which let a pinner wipe a
       * two-and-a-half-second count by easing off for seven tenths of a second.
       */
      const apart = hyp(pinned.pos.x - pinner.pos.x, pinned.pos.y - pinner.pos.y) >= C.PIN_ESCAPE_DIST;
      const movedPinned = hyp(pinned.pos.x - st.ox, pinned.pos.y - st.oy) >= C.PIN_ESCAPE_DIST;
      const movedPinner = hyp(pinner.pos.x - st.pox, pinner.pos.y - st.poy) >= C.PIN_ESCAPE_DIST;
      st.sepFor = apart ? st.sepFor + dt : 0;
      // "...until the PIN ends or until BOTH ROBOTS move back within 2ft"
      st.awayFor = movedPinned || movedPinner ? st.awayFor + dt : 0;
      if (st.sepFor > C.PIN_END_S || st.awayFor > C.PIN_END_S) {
        delete pen.pins[key];
        continue;
      }

      // last tick's pose, captured BEFORE it is overwritten — the escape measurement below
      // needs the delta, and the pose must advance on paused ticks too or the first tick after
      // a pause reads a whole pause's worth of travel as one tick of escape.
      const prevX = st.px;
      const prevY = st.py;
      st.px = pinned.pos.x;
      st.py = pinned.pos.y;
      if (apart || movedPinned || movedPinner || !held) continue; // paused, not ended

      /**
       * "...preventing the movement..." measured rather than assumed: progress AWAY from the
       * pinner, taken from the actual post-solver position delta, so it holds whether or not a
       * blocked robot's velocity was zeroed. Along the ESCAPE direction rather than as raw speed
       * — a victim bulldozed sideways along a wall is moving quickly and is no less pinned.
       * PIN_STUCK_SPEED is the sim's own number; the rule leaves this to a referee's eye.
       */
      const e = escapeDir(pinner, pinned);
      const escapeSpeed = e ? ((pinned.pos.x - prevX) * e.x + (pinned.pos.y - prevY) * e.y) / dt : 0;
      if (escapeSpeed >= C.PIN_STUCK_SPEED) continue; // getting away under its own power

      st.seconds += dt;
      /**
       * "Violation: MINOR FOUL and an additional MINOR FOUL for every 3 seconds in which the
       * situation is not corrected." Nine seconds of pinning is three MINORs. It is never a
       * MAJOR — the sim used to escalate a repeat pin to one, which the rule does not describe.
       */
      while (st.seconds >= C.PIN_SECONDS * (st.billed + 1)) {
        st.billed += 1;
        awardFoul(world, pinner.alliance, 'minor', 'G422 pinning');
        pen.pinFouls[pinner.id] = (pen.pinFouls[pinner.id] ?? 0) + 1;
      }
    }
  }
}
