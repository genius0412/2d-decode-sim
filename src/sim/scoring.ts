import type { Alliance, CardColor, GoalState, RobotState, ScoreBreakdown, World } from '../types';
import * as C from '../config';
import { baseZone, inDepot, inRect, launchSegments, other } from './field';
import { robotCorners, wheelContacts } from './physics';
import { distToSegment, hyp } from '../math';

export function emptyScore(): ScoreBreakdown {
  return {
    leave: 0,
    autoClassified: 0,
    autoOverflow: 0,
    autoPattern: 0,
    teleClassified: 0,
    teleOverflow: 0,
    telePattern: 0,
    depot: 0,
    base: 0,
    foulPoints: 0,
    total: 0,
  };
}

function recomputeTotal(s: ScoreBreakdown): void {
  // A RED CARD voids the MATCH — the breakdown still shows everything that was earned,
  // because that is what happened on the field, but the total it counts for is zero.
  if (s.voided) {
    s.total = 0;
    return;
  }
  s.total =
    s.leave +
    s.autoClassified +
    s.autoOverflow +
    s.autoPattern +
    s.teleClassified +
    s.teleOverflow +
    s.telePattern +
    s.depot +
    s.base +
    s.foulPoints;
}

/** award a Section 11 foul: `offender` committed it, so the points go to the
 * OTHER (victim) alliance and the offender's committed-foul count bumps. */
export function awardFoul(
  world: World,
  offender: Alliance,
  severity: 'minor' | 'major',
  rule: string,
): void {
  const victim = other(offender);
  const pts = severity === 'major' ? C.PTS_FOUL_MAJOR : C.PTS_FOUL_MINOR;
  world.match.scores[victim].foulPoints += pts;
  recomputeTotal(world.match.scores[victim]);
  const tally = world.match.fouls[offender];
  if (severity === 'major') tally.major += 1;
  else tally.minor += 1;
  world.events.push(`${severity === 'major' ? 'MAJOR' : 'MINOR'} FOUL - ${victim.toUpperCase()} +${pts} (${rule})`);
}

/**
 * Issue a CARD to a ROBOT — "a warning issued by the Head REFEREE for egregious ROBOT or
 * team member behavior or rule violations" (DECODE glossary).
 *
 * Cards attach to a TEAM, which here is a robot, and ESCALATE: a team that already holds a
 * yellow gets a RED instead. A red VOIDS its ALLIANCE's match points — the breakdown still
 * lists everything earned, since that is what happened on the field, but the total counts
 * zero, which in a 1v1 or 2v2 is the loss the card is supposed to be.
 *
 * Returns the colour actually issued, or null if the robot was already red.
 */
export function awardCard(world: World, robot: RobotState, rule: string): CardColor | null {
  const pen = world.penalties;
  const held = pen.carded[robot.id];
  if (held === 'red') return null; // already the worst there is
  const colour: CardColor = held === 'yellow' ? 'red' : 'yellow';
  pen.carded[robot.id] = colour;

  const cards = (world.match.cards ??= { red: { yellow: 0, red: 0 }, blue: { yellow: 0, red: 0 } });
  const tally = cards[robot.alliance];
  if (colour === 'red') {
    if (held === 'yellow') tally.yellow -= 1; // one carded robot, now shown at its new colour
    tally.red += 1;
    world.match.scores[robot.alliance].voided = true;
    recomputeTotal(world.match.scores[robot.alliance]);
  } else {
    tally.yellow += 1;
  }
  const who = robot.spec.teamNumber ? `#${robot.spec.teamNumber}` : robot.spec.name || `robot ${robot.id}`;
  world.events.push(`${colour.toUpperCase()} CARD - ${robot.alliance.toUpperCase()} ${who} (${rule})`);
  return colour;
}

/** Rule A: assessment of CLASSIFIED/OVERFLOW happens throughout the match and
 * continues until all artifacts come to rest after the match ends. An artifact that
 * meets its criteria BEFORE the start of TELEOP is assessed as AUTO — that includes
 * the post-auto `transition` settle window, not just the `auto` clock. Everything
 * from TELEOP onward (including the post-match settle) is TELEOP. */
function scoredAsAuto(world: World): boolean {
  return world.match.phase === 'auto' || world.match.phase === 'transition';
}

export function addClassified(world: World, alliance: Alliance): void {
  const s = world.match.scores[alliance];
  if (scoredAsAuto(world)) s.autoClassified += C.PTS_CLASSIFIED;
  else s.teleClassified += C.PTS_CLASSIFIED;
  recomputeTotal(s);
}

export function addOverflow(world: World, alliance: Alliance): void {
  const s = world.match.scores[alliance];
  if (scoredAsAuto(world)) s.autoOverflow += C.PTS_OVERFLOW;
  else s.teleOverflow += C.PTS_OVERFLOW;
  recomputeTotal(s);
}

/** pattern points for the current classifier stack: the motif repeats 3x over
 * the 9 positions (gate outward); each retained artifact matching scores. */
export function patternPoints(world: World, goal: GoalState): number {
  const stack = world.balls
    .filter(
      (b) =>
        b.state.kind === 'rail' &&
        b.state.goal === goal.alliance &&
        !b.state.overflow &&
        !b.state.pending, // still descending — not settled into a slot yet
    )
    .sort((p, q) => (p.state as { s: number }).s - (q.state as { s: number }).s);
  let pts = 0;
  stack.slice(0, C.RAMP_SLOTS).forEach((ball, i) => {
    if (ball.color === world.motif[i % 3]) pts += C.PTS_PATTERN;
  });
  return pts;
}

/** does the robot's footprint overlap any launch-line tape? */
function robotOverLaunchLine(world: World, robotIdx: number): boolean {
  const r = world.robots[robotIdx];
  const corners = robotCorners(r);
  const halfDiag = hyp(r.spec.length, r.spec.width) / 2;
  for (const [a, b] of launchSegments()) {
    // any corner close to the tape?
    if (corners.some((c) => distToSegment(c, a, b) < C.TAPE_W + 0.25)) return true;
    // or the tape passes beneath the chassis: corners straddle the line while
    // the segment is near the robot center
    if (distToSegment(r.pos, a, b) < halfDiag) {
      const nx = -(b.y - a.y);
      const ny = b.x - a.x;
      const side = (p: { x: number; y: number }) => (p.x - a.x) * nx + (p.y - a.y) * ny;
      const signs = corners.map(side);
      if (signs.some((s) => s > 0) && signs.some((s) => s < 0)) return true;
    }
  }
  return false;
}

/** Rule E: LEAVE is assessed at the END OF AUTO — a robot whose footprint no longer
 * overlaps its launch line has left. Called ONCE, on the auto→transition edge. */
export function assessLeave(world: World): void {
  for (let i = 0; i < world.robots.length; i++) {
    const r = world.robots[i];
    if (!robotOverLaunchLine(world, i)) {
      world.match.scores[r.alliance].leave += C.PTS_LEAVE;
      world.events.push(`LEAVE +${C.PTS_LEAVE}`);
      recomputeTotal(world.match.scores[r.alliance]);
    }
  }
}

/** Rule B: AUTO PATTERN is assessed when all artifacts come to rest after AUTO or at
 * the start of TELEOP, whichever comes first. This is an IDEMPOTENT snapshot of the
 * banked pattern from the currently-settled classifier stack — `stepMatch` recomputes
 * it through the post-auto `transition` window and locks the final value at TELEOP
 * start, so a ball still in flight/on the rail at the auto buzzer is counted once it
 * settles. No events (would spam every tick); the AUTO PATTERN event fires at the lock. */
export function assessAutoPattern(world: World): void {
  for (const a of ['red', 'blue'] as Alliance[]) {
    world.match.scores[a].autoPattern = patternPoints(world, world.goals[a]);
    recomputeTotal(world.match.scores[a]);
  }
}

/** Rules C/D/F: TELEOP PATTERN, DEPOT and BASE are assessed when all ROBOTS and
 * ARTIFACTS have come to rest after the match. IDEMPOTENT (every term is recomputed
 * from scratch, not accumulated) so `stepMatch` can call it each tick through the
 * post-match settle window — late-draining balls and still-rolling depot balls are
 * folded in as they stop, and the final resting value locks when stepping ceases. */
export function assessMatchEnd(world: World): void {
  for (const a of ['red', 'blue'] as Alliance[]) {
    const s = world.match.scores[a];
    s.base = 0; // recomputed from robot positions below (idempotent — see doc)
    s.telePattern = patternPoints(world, world.goals[a]);
    // depot: ground balls resting in the alliance's depot band
    let depot = 0;
    for (const b of world.balls) {
      if (b.state.kind === 'ground' && inDepot(b.pos, a)) depot += C.PTS_DEPOT;
    }
    s.depot = depot;
    // base return per robot, + bonus when 2 robots fully returned. Only the
    // WHEEL ground-contact points count — intake/turret overhang doesn't
    // touch the floor, so it neither earns nor spoils parking credit.
    let fullCount = 0;
    for (const r of world.robots) {
      if (r.alliance !== a) continue;
      const zone = baseZone(a);
      const wheels = wheelContacts(r);
      const insideCount = wheels.filter((c) => inRect(c, zone)).length;
      // an opponent that fouled this robot out of its base (G427) forfeits the
      // denial: the robot is credited a full return regardless of position
      if (r.baseAwarded || insideCount === wheels.length) {
        s.base += C.PTS_BASE_FULL;
        fullCount++;
      } else if (insideCount > 0) {
        s.base += C.PTS_BASE_PARTIAL;
      }
    }
    if (fullCount >= 2) s.base += C.PTS_BASE_FULL; // 2-robot alliance bonus
    recomputeTotal(s);
  }
}

export function updateProvisionalPattern(world: World): void {
  for (const a of ['red', 'blue'] as Alliance[]) {
    world.match.provisionalPattern[a] = patternPoints(world, world.goals[a]);
  }
}
