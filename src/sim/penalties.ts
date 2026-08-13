import type { Alliance, RobotCommand, RobotState, World } from '../types';
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
import { closestPointOnRobot, robotCorners, robotIntersectsRect, robotPointVelocity } from './physics';
import { pushingGate, ZERO_CMD } from './goal';
import { awardCard, awardFoul } from './scoring';
import { hyp } from '../math';

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
 *   G408  over-possession / plowing    (MINOR) — CONTROLLING more than
 *                                       POSSESSION_LIMIT artifacts (hopper +
 *                                       herded loose balls) past a short grace
 *   G422  pinning ≥3 s                 (MINOR, MAJOR on a repeat by the same pinner)
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
  if (phase !== 'auto' && phase !== 'teleop') {
    for (const a of ALLIANCES) {
      pen.gateCulprit[a] = null;
      pen.rampBallIds[a] = [];
    }
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
        if (!exception) fire(`G424:${pairKey}`, opp, 'minor', 'G424 gate zone');
      }

      // G426 LOADING ZONE protection — owner's own loading zone.
      if (robotInRect(ra, loadZone(O)) || robotInRect(rb, loadZone(O))) {
        fire(`G426:${pairKey}`, opp, 'minor', 'G426 loading zone');
      }

      // G427 BASE ZONE protection (endgame) — + credit the owner a full return.
      if (endgame && (robotInRect(ra, baseZone(O)) || robotInRect(rb, baseZone(O)))) {
        oBot.baseAwarded = true;
        fire(`G427:${pairKey}`, opp, 'major', 'G427 base zone');
      }

      // G425 SECRET TUNNEL — tunnelStrip(O) sits under O's goal but is OWNED by
      // other(O); the INTRUDER/offender is alliance O. Fires only when the
      // intruder itself is in the strip (an owner defending its own tunnel is not
      // a foul), which is also what makes G424/G425 mutually exclusive above.
      if (robotInRect(oBot, tunnelStrip(O))) {
        fire(`G425:${pairKey}`, O, 'minor', 'G425 secret tunnel');
      }
    }
  }

  // ---- G417 opponent gate + G418 artifacts off the opponent's ramp --------
  updateGateFouls(world, commands, fire);

  // ---- G408 over-possession / plowing (per robot, own second-accumulator) --
  updatePossession(world, dt, fire);

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
function updatePossession(world: World, dt: number, fire: FireFn): void {
  const pen = world.penalties;
  for (const r of world.robots) {
    const controlled = controlledArtifacts(world, r, dt);
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
      pen.controlHeld[r.id] = 0;
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
      if (t === 0) pen.possessionBilled[r.id] = 0; // fully drained — the next episode bills fresh
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
 * How many artifacts robot r is CONTROLLING, straight from the manual's definitions:
 *
 *   CONTROL    — "requires contact with a ROBOT, either directly or TRANSITIVELY through
 *                 other SCORING ELEMENTS."
 *   POSSESSION — an object "is POSSESSED by a ROBOT if, as the ROBOT moves or changes
 *                 ORIENTATION (for example, moves forward, turns, backs up, spins in
 *                 place), the object remains in approximately the same position relative
 *                 to the ROBOT. Objects POSSESSED by a ROBOT are considered to be
 *                 CONTROLLED."
 *   and G408's own list of what is NOT control: "BULLDOZING (inadvertent contact with a
 *   SCORING ELEMENT while in the path of the ROBOT moving about the FIELD)", "DEFLECTING",
 *   "inadvertent contact ... while attempting to acquire a SCORING ELEMENT from the LOADING
 *   ZONE", and LAUNCHED artifacts no longer in contact.
 *
 * Hopper artifacts are possession outright. A loose GROUND artifact counts when:
 *   1. the robot is MOVING or TURNING — the condition the possession test is written under,
 *      and turning counts on its own, so a corralled pile spun on the spot is possessed;
 *   2. it is in CONTACT, directly or through the chain of artifacts that is (the transitive
 *      clause — a shoved wedge counts WHOLE, not just the two against the bumper); and
 *   3. it HOLDS STATION relative to the robot — its velocity is within POSSESSION_SLIP of
 *      the robot's rigid-body velocity AT that point, ω×r included. That is the continuous
 *      form of "remains in approximately the same position relative to the ROBOT", and it
 *      is what separates possession from the exempt cases by itself: an artifact you drive
 *      PAST slips at road speed, one DEFLECTING off leaves at its own.
 *
 * Artifacts in the robot's OWN LOADING ZONE are skipped outright — that is the third carve-
 * out, and without it a robot collecting its restock was fouled for the artifacts it was
 * there to pick up.
 *
 * Artifacts in flight / basin / rail / held by another robot are not loose and never count.
 */
function controlledArtifacts(world: World, r: RobotState, dt: number): number {
  // the possession test only asks what happens "as the ROBOT moves or changes ORIENTATION"
  const active =
    hyp(r.vel.x, r.vel.y) >= C.POSSESSION_MOVE_SPEED || Math.abs(r.angVel) >= C.POSSESSION_TURN_RATE;
  const home = loadZone(r.alliance);
  const ground = active
    ? world.balls.filter((b) => b.state.kind === 'ground' && !inRect(b.pos, home))
    : [];

  /** does this artifact hold station relative to the robot — the possession test itself? */
  const carried = (b: (typeof ground)[number]): boolean => {
    const pv = robotPointVelocity(r, b.pos); // includes the spin term
    return hyp(b.vel.x - pv.x, b.vel.y - pv.y) <= C.POSSESSION_SLIP;
  };

  const reach = C.BALL_RADIUS + C.POSSESSION_CONTROL_MARGIN; // touching the footprint
  const chain = C.BALL_RADIUS * 2 + C.POSSESSION_CONTROL_MARGIN; // ...or touching a ball that is
  const held = new Set<number>();
  for (const b of ground) {
    if (!carried(b)) continue;
    const cp = closestPointOnRobot(r, b.pos);
    if (hyp(b.pos.x - cp.x, b.pos.y - cp.y) <= reach) held.add(b.id);
  }
  // grow the contact chain outward until it stops finding anything (a pile is small, and
  // the pass is order-independent, so this stays deterministic)
  for (let grew = true; grew; ) {
    grew = false;
    for (const b of ground) {
      if (held.has(b.id) || !carried(b)) continue;
      for (const c of ground) {
        if (!held.has(c.id)) continue;
        if (hyp(b.pos.x - c.pos.x, b.pos.y - c.pos.y) > chain) continue;
        held.add(b.id);
        grew = true;
        break;
      }
    }
  }
  /**
   * THE CONFIRM GATE — an artifact counts only once IT has been with this robot long enough.
   *
   * The per-tick tests above answer "is this artifact possessed right now"; they cannot
   * answer "is this robot HERDING or just driving through", because a single frame of a
   * crossing and a single frame of a shove look identical. Identity over time is the signal,
   * and it has to be tracked per ARTIFACT rather than per robot: crossing a littered field
   * touches a dozen artifacts briefly and confirms none of them, while shoving or repeatedly
   * flicking the same six accumulates on those six.
   *
   * Leaky, like the episode clock, which is what makes FLICKING add up: each contact is far
   * too short to confirm on its own, but the artifact's own clock only drains at
   * POSSESSION_LEAK between strikes, so re-hitting the same pile climbs. A robot that leaves
   * an artifact behind drains it to nothing and the entry is deleted.
   */
  const pen = world.penalties;
  let confirmed = 0;
  for (const b of world.balls) {
    const key = `${r.id}:${b.id}`;
    const prev = pen.ballHold[key];
    if (held.has(b.id)) {
      const t = (prev ?? 0) + dt;
      pen.ballHold[key] = t;
      if (t >= C.POSSESSION_CONFIRM) confirmed++;
    } else if (prev !== undefined) {
      const t = prev - dt * C.POSSESSION_LEAK;
      if (t <= 0) delete pen.ballHold[key];
      else pen.ballHold[key] = t;
    }
  }
  return r.hopper.length + confirmed;
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

function updatePins(world: World, dt: number, commands: Map<number, RobotCommand>): void {
  const pen = world.penalties;
  // contacts this tick, as an undirected id-pair set
  const contacts = new Set(world.rrContacts.map(({ a, b }) => `${a}-${b}`));
  const inContact = (i: number, j: number): boolean =>
    contacts.has(`${Math.min(i, j)}-${Math.max(i, j)}`);

  for (const pinner of world.robots) {
    for (const pinned of world.robots) {
      if (pinner.id === pinned.id || pinner.alliance === pinned.alliance) continue;
      const key = `${pinner.id}-${pinned.id}`;
      const cmd = commands.get(pinned.id);
      const commandingMove =
        !!cmd && (hyp(cmd.driveX, cmd.driveY) > 0.1 || Math.abs(cmd.rotate) > 0.1);

      // Only the ACTUAL pinner is fouled: the pinned robot must be trapped against
      // a solid with the pinner on the open-field side. Without this, a wall shove
      // satisfies BOTH orderings (each robot is slow and commanding), and the
      // victim's alliance was wrongly fouled too.
      const contact = inContact(pinner.id, pinned.id);
      const held = contact && commandingMove && pinnedAgainstWall(pinner, pinned);

      const existing = pen.pins[key];
      if (!held) {
        // THE CLOCK PAUSES, IT DOES NOT RESET. Every input here flickers — the SAT
        // contact list drops a tick as bumpers unload, the victim's stick crosses
        // the dead zone, the wall probe slips past the slop as the pair rocks — and
        // wiping the accumulator on any one-tick lapse is why a genuine five-second
        // pin used to count to half a second over and over and never foul.
        if (!existing) continue;
        existing.free = (existing.free ?? 0) + dt;
        // ESCAPED = out of contact AND clear: either the pair is now far apart (the
        // pinner backed off, which frees the victim just as much as the victim
        // driving away does) or the victim has left where the pin began.
        const gone =
          !contact &&
          (hyp(pinned.pos.x - pinner.pos.x, pinned.pos.y - pinner.pos.y) > C.PIN_ESCAPE_DIST ||
            hyp(pinned.pos.x - existing.ox, pinned.pos.y - existing.oy) > C.PIN_ESCAPE_DIST);
        if (gone || existing.free >= C.PIN_BREAK_S) delete pen.pins[key]; // really let go
        continue;
      }

      let st = existing;
      if (!st) {
        st = { seconds: 0, ox: pinned.pos.x, oy: pinned.pos.y, px: pinned.pos.x, py: pinned.pos.y };
        pen.pins[key] = st;
      }
      st.free = 0; // the hold is on again
      if (st.fired) continue; // already fouled this pin — hold until it breaks

      // Progress AWAY from the pinner, from the actual (post-solver) position delta
      // — robust whether or not a blocked robot's velocity has been zeroed.
      //
      // Measured along the ESCAPE direction, not as raw speed: a victim being
      // bulldozed sideways along a wall is moving quickly and is no less pinned, and
      // pausing the count every time it slid was the other reason real pins never
      // reached three seconds. Only actually GAINING GROUND on the pinner counts.
      const e = escapeDir(pinner, pinned);
      const moved = { x: pinned.pos.x - st.px, y: pinned.pos.y - st.py };
      const escapeSpeed = e ? (moved.x * e.x + moved.y * e.y) / dt : 0;
      st.px = pinned.pos.x;
      st.py = pinned.pos.y;

      if (escapeSpeed < C.PIN_STUCK_SPEED) {
        st.seconds += dt;
        if (st.seconds >= C.PIN_SECONDS) {
          const prior = pen.pinFouls[pinner.id] ?? 0;
          awardFoul(world, pinner.alliance, prior > 0 ? 'major' : 'minor', 'G422 pinning');
          pen.pinFouls[pinner.id] = prior + 1;
          // don't re-fire on the SAME pin — require a separation first (that's a
          // genuine "repeat pin", which then escalates to MAJOR)
          st.fired = true;
        }
      } else {
        st.seconds = 0; // breaking away under its own power — pause the clock
      }
    }
  }
}