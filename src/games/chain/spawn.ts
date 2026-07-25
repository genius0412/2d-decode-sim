import type {
  Alliance,
  Artifact,
  GameMode,
  GameSettings,
  GoalState,
  RobotState,
  Vec2,
  World,
} from '../../types';
import * as C from '../../config';
import { datan2, nextRandom, wrapAngle } from '../../math';
import {
  DEFAULT_ASSISTS,
  DEFAULT_SPEC,
  MOTIFS,
  coerceAssists,
  coerceSpec,
  type RobotSetup,
} from '../../sim/spawn';
import { emptyScore } from '../../sim/scoring';
import {
  CHAIN_ACCEL_DEPTH,
  CHAIN_ACCEL_HALF_Y,
  CHAIN_HALF_X,
  CHAIN_PARTICLE_R,
  CHAIN_PARTICLE_SIM,
  CHAIN_START_POSES,
} from './config';
import { accelSide, emptyChainState, onRingStand, ringStands, type ChainCatalyst } from './state';

/**
 * Chain Reaction world spawn — a PLAYABLE match.
 *
 * Robots start in their half; the field is seeded with `CHAIN_PARTICLE_SIM`
 * PARTICLES (scattered, the manual's pre-match randomization) and
 * `CHAIN_CATALYST_COUNT` CATALYSTS. CR-specific state (catalysts / scoring /
 * endgame) rides `world.chain`; the shared `goals`/`scores`/`motif`/`match` are
 * kept inert-but-present (worldHash/HUD read them). Deterministic: a mulberry32
 * chain off `seed` places every particle/catalyst.
 */

interface Pose {
  pos: Vec2;
  heading: number;
}

/**
 * A CR robot's legal start pose (manual G04 — completely in the Lab Area). The named
 * `CHAIN_START_POSES` anchors are CANONICAL for BLUE (goalSide +x); RED is the x-mirror.
 * `index` selects the anchor (the 2-robot alliance defaults to 0/1 → the two Lab corners).
 */
function chainStartPose(alliance: Alliance, index: number): Pose {
  const n = CHAIN_START_POSES.length;
  const p = CHAIN_START_POSES[((index % n) + n) % n];
  if (alliance === 'blue') return { pos: { ...p.pos }, heading: p.heading };
  return { pos: { x: -p.pos.x, y: p.pos.y }, heading: wrapAngle(Math.PI - p.heading) };
}

function inertGoal(alliance: Alliance): GoalState {
  return {
    alliance,
    gateOpen: false,
    gatePos: 0,
    gateVel: 0,
    gateHoldTime: 0,
    gateLatch: 0,
    classifiedCount: 0,
    overflowCount: 0,
  };
}

function makeChainRobot(setup: RobotSetup, nth: number): RobotState {
  const spec = coerceSpec(setup.spec, DEFAULT_SPEC, 'chain');
  const assists = coerceAssists(setup.assists, DEFAULT_ASSISTS);
  // honour the chosen start (the selector's `startIndex`); default a 2-robot alliance to
  // its two Lab corners (0/1). Always a legal Lab-Area / Ring-Stand pose (G04).
  const idx = setup.startIndex ?? nth;
  const pose = chainStartPose(setup.alliance, idx);
  // a TURRET starts already POINTED at its accelerator (it slews at a finite rate — see the
  // turret branch in play.ts — so it must begin aimed, not have to swing around from the spawn
  // heading). Turretless launchers keep the chassis heading.
  const mouthX = accelSide(setup.alliance) * CHAIN_HALF_X;
  const turretHeading =
    (spec.scoreMode ?? 'turret') === 'turret'
      ? datan2(0 - pose.pos.y, mouthX - pose.pos.x)
      : pose.heading;
  return {
    id: setup.id,
    alliance: setup.alliance,
    spec,
    pos: { ...pose.pos },
    heading: pose.heading,
    vel: { x: 0, y: 0 },
    angVel: 0,
    turretHeading,
    moduleAngles: [0, 0, 0, 0],
    moduleTargets: [0, 0, 0, 0],
    hopper: [],
    fieldCentric: assists.fieldCentric,
    aimAssist: assists.aimAssist,
    autoIntake: assists.autoIntake,
    autoFire: assists.autoFire,
    passive: setup.passive,
    lastFireAt: -10,
    lastIntakeAt: -10,
    fireReadyAt: 0,
    flywheelSpin: 0,
    flywheelSpinRate: 0,
    powerDraw: 0,
    autoPathActive: false,
    currentPathSegmentIndex: 0,
    pathSegmentProgress: 0,
    pathWaitTimer: 0,
    pathSequenceIndex: 0,
    pathTargetPoint: null,
    pathTargetHeading: null,
    isAligningHeading: false,
    targetAlignmentHeading: null,
  };
}

export function createChainWorld(
  mode: GameMode,
  seed: number,
  setups: RobotSetup[],
  gameSettings?: GameSettings,
): World {
  let rng = nextRandom(seed || 1);
  const rand = (): number => {
    rng = nextRandom(rng.state);
    return rng.value;
  };

  const robots: RobotState[] = [];
  const allianceCount: Record<Alliance, number> = { red: 0, blue: 0 };
  for (const s of [...setups].sort((p, q) => p.id - q.id)) {
    robots.push(makeChainRobot(s, allianceCount[s.alliance]++));
  }

  // STAGE the particles INSIDE the alliance goals (half in each). They are HELD (`staged`)
  // until the pre-match launcher flings them onto the field to randomize it (see
  // `prematchRandomize`) — matching the manual's auto-score/reject randomization. Split evenly:
  // the balls jumble in each goal box (behind the wall, within the accelerator opening in y).
  const balls: Artifact[] = [];
  let id = 1;
  const redCount = Math.floor(CHAIN_PARTICLE_SIM / 2);
  for (let i = 0; i < CHAIN_PARTICLE_SIM; i++) {
    const a: Alliance = i < redCount ? 'red' : 'blue';
    const side = accelSide(a);
    // scatter inside the goal box: from just behind the wall out to near the back face
    const depth = CHAIN_PARTICLE_R + rand() * (CHAIN_ACCEL_DEPTH - 2 * CHAIN_PARTICLE_R);
    const y = (rand() * 2 - 1) * (CHAIN_ACCEL_HALF_Y - CHAIN_PARTICLE_R);
    balls.push({
      id: id++,
      color: 'green', // rendered white in CR; color unused
      state: { kind: 'flight', target: a, scored: true, staged: true },
      pos: { x: side * (CHAIN_HALF_X + depth), y },
      vel: { x: 0, y: 0 },
      z: 0,
      vz: 0,
    });
  }

  // catalysts START ON THE RING STANDS — one on each of the four corner ring stands.
  const chain = emptyChainState();
  chain.nextBallId = id; // runtime spawns continue past the initial particle ids
  ringStands().forEach((rs, i) => {
    const cat: ChainCatalyst = { id: i, pos: { ...rs }, carriedBy: null, hook: null };
    chain.catalysts.push(cat);
  });

  // ARM the auto descent for any robot staged ON a Ring Stand (start anchor 2/3): it
  // earns 100 pt when it comes down off the stand during auto (see updateChain).
  for (const r of robots) {
    if (onRingStand(r.pos)) chain.descentArmed[r.id] = true;
  }

  return {
    game: 'chain',
    chain,
    mode,
    time: 0,
    tick: 0,
    rngState: rng.state,
    motif: MOTIFS[0],
    robots,
    balls,
    goals: { red: inertGoal('red'), blue: inertGoal('blue') },
    humanPlayers: {
      red: { box: [], nextPlaceAt: 0 },
      blue: { box: [], nextPlaceAt: 0 },
    },
    match: {
      phase: mode === 'match' ? 'pre' : 'freeplay',
      phaseTimeLeft: mode === 'match' ? C.AUTO_DURATION : 0,
      scores: { red: emptyScore(), blue: emptyScore() },
      provisionalPattern: { red: 0, blue: 0 },
      fouls: { red: { minor: 0, major: 0 }, blue: { minor: 0, major: 0 } },
    },
    events: [],
    rrContacts: [],
    penalties: {
      episodes: {},
      pins: {},
      pinFouls: {},
      possession: {},
      gateCulprit: { red: null, blue: null },
      rampBallIds: { red: [], blue: [] },
    },
    gameSettings,
  };
}
