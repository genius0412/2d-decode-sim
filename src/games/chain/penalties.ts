import type { Alliance, RobotState, Vec2, World } from '../../types';
import { hyp } from '../../math';
import { robotCorners } from '../../sim/physics';
import { awardFoul } from '../../sim/scoring';
import { accelSide } from './state';
import { CHAIN_DIAMOND_R, CHAIN_ENDGAME_S, CHAIN_FOUL_SLOP } from './config';

/**
 * Chain Reaction penalty engine (manual §3.3). Runs each tick AFTER `updateChain` (so endgame
 * state is current). Only the runtime, contact rules are modeled — all MAJORs per the manual,
 * awarded to the VICTIM alliance via `awardFoul`:
 *  • G06 — during AUTONOMOUS, contacting an opponent that is COMPLETELY within its own Alliance
 *    Section (its half, excluding the neutral Particle Zone) → MAJOR on the aggressor.
 *  • G05 — during END GAME, contacting an opponent that is ASCENDING (on a Ring Stand) → MAJOR.
 * Fouls are EDGE-triggered (fire on the false→true edge, once while held, again on re-entry) via
 * `chain.foulEdge`. G01–G04 (control/expansion/start) are structurally enforced; G07 (de-score)
 * is legal; G02 plowing + G08 "prolonged restriction" + G09 (accelerator-exit obstruction) are
 * intentionally not modeled.
 */
export function updateChainPenalties(world: World): void {
  const chain = world.chain;
  if (!chain) return;
  const phase = world.match.phase;
  const isAuto = phase === 'auto';
  const isTeleop = phase === 'teleop';
  const isEndgame = isTeleop && world.match.phaseTimeLeft <= CHAIN_ENDGAME_S;
  if (!isAuto && !isTeleop) {
    chain.foulEdge = {}; // no fouls outside the played periods (pre / transition / post / free)
    return;
  }

  const seen: Record<string, boolean> = {};
  const fire = (key: string, offender: Alliance, rule: string): void => {
    if (!chain.foulEdge[key]) awardFoul(world, offender, 'major', rule);
    seen[key] = true;
  };

  // robot-robot contact fouls (need OPPOSING alliances in contact)
  for (let i = 0; i < world.robots.length; i++) {
    for (let j = i + 1; j < world.robots.length; j++) {
      const A = world.robots[i];
      const B = world.robots[j];
      if (A.alliance === B.alliance) continue;
      if (!robotsContact(A, B)) continue;
      if (isAuto) {
        // G06: whoever contacts a protected (fully-in-own-section) opponent is the offender
        if (protectedInAuto(B)) fire(`g06-${A.id}-${B.id}`, A.alliance, 'G06 contact in the opponent’s section');
        if (protectedInAuto(A)) fire(`g06-${B.id}-${A.id}`, B.alliance, 'G06 contact in the opponent’s section');
      }
      if (isEndgame) {
        if (chain.endgame[B.id] === 'ascended') fire(`g05-${A.id}-${B.id}`, A.alliance, 'G05 contact with an ascending robot');
        if (chain.endgame[A.id] === 'ascended') fire(`g05-${B.id}-${A.id}`, B.alliance, 'G05 contact with an ascending robot');
      }
    }
  }

  chain.foulEdge = seen;
}

/** a robot is protected in AUTO when its whole footprint is inside its OWN alliance section
 * (its half of the field) and it is NOT in the neutral Particle Zone. */
function protectedInAuto(r: RobotState): boolean {
  const side = accelSide(r.alliance); // red −x half, blue +x half
  const corners = robotCorners(r);
  const inOwnHalf = corners.every((c) => (side < 0 ? c.x < 0 : c.x > 0));
  const inParticleZone = Math.abs(r.pos.x) + Math.abs(r.pos.y) < CHAIN_DIAMOND_R;
  return inOwnHalf && !inParticleZone;
}

/** OBB–OBB contact (SAT) between two robot footprints, with a little bumper slack. */
function robotsContact(A: RobotState, B: RobotState): boolean {
  const ca = robotCorners(A);
  const cb = robotCorners(B);
  const axes = [edgeNormal(ca[0], ca[1]), edgeNormal(ca[1], ca[2]), edgeNormal(cb[0], cb[1]), edgeNormal(cb[1], cb[2])];
  for (const ax of axes) {
    const a = projectExtent(ca, ax);
    const b = projectExtent(cb, ax);
    if (a.max + CHAIN_FOUL_SLOP < b.min || b.max + CHAIN_FOUL_SLOP < a.min) return false; // a separating axis
  }
  return true;
}

function edgeNormal(p: Vec2, q: Vec2): Vec2 {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const l = hyp(dx, dy) || 1;
  return { x: -dy / l, y: dx / l };
}

function projectExtent(corners: Vec2[], ax: Vec2): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const c of corners) {
    const d = c.x * ax.x + c.y * ax.y;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return { min, max };
}
