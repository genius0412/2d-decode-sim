import type { RobotCommand, World } from '../../types';
import * as C from '../../config';
import { solveRobots } from '../../sim/physicsEngine';
import { squareUpRobotsWalls } from '../../sim/physics';
import { updateRobot } from '../../sim/robot';
import { robotsEnabled } from '../../sim/match';
import { CHAIN_HALF_X, CHAIN_HALF_Y } from './config';
import { chainColliders } from './colliders';
import { updateChain, chainAimAssist } from './play';
import { updateChainPenalties } from './penalties';
import { beamBlock, beamDrag, beamStrafeBlock, cogFactor } from './beams';

/**
 * Chain Reaction step — a playable match.
 *
 * Pipeline: resolve driver commands → drive (shared drivetrain/motor) → Rapier
 * position/velocity + wall containment → CR gameplay (`updateChain`: particles,
 * intake, shooter, accelerator scoring/recycle, catalysts, endgame) → phase/timer
 * machine. Deterministic (commands + `world.rngState` only), so client prediction /
 * server authority / replays hold. DELIBERATELY skips DECODE's updateRobotActions,
 * goals/gates, penalties, and DECODE scoring — CR owns all of that in `updateChain`.
 */

const ZERO_CMD: RobotCommand = {
  driveX: 0,
  driveY: 0,
  rotate: 0,
  leftDrive: 0,
  rightDrive: 0,
  intake: false,
  fire: false,
};

export function chainStep(world: World, dt: number, commands: Map<number, RobotCommand>): void {
  world.time += dt;
  world.tick++;
  world.rrContacts.length = 0;

  const enabled = robotsEnabled(world);
  const actual = new Map<number, RobotCommand>();
  for (const r of world.robots) {
    let cmd = enabled ? (commands.get(r.id) ?? ZERO_CMD) : ZERO_CMD;
    // turretless shooters (drum/dumper) turn the whole robot to face the goal while the
    // fire button is held — override the rotate command before the drivetrain model.
    const aim = chainAimAssist(r, cmd, enabled);
    if (aim !== null) cmd = { ...cmd, rotate: aim };
    actual.set(r.id, cmd);
    // raised center of gravity (from ground clearance) makes the drive sluggish:
    // scale the movement command by the CoG factor before the drivetrain model.
    const cog = cogFactor(r.spec);
    const driven =
      cog < 0.999
        ? {
            ...cmd,
            driveX: cmd.driveX * cog,
            driveY: cmd.driveY * cog,
            rotate: cmd.rotate * cog,
            leftDrive: cmd.leftDrive * cog,
            rightDrive: cmd.rightDrive * cog,
          }
        : cmd;
    updateRobot(world, r, driven, dt);
  }

  // beams (difficult terrain): drag the across-velocity BEFORE the solve so a crossing
  // robot physically advances less this tick (momentum/traction/CoG decide how much).
  beamDrag(world, dt);
  // Rapier owns robot translation/velocity + wall containment on the CR field.
  const preVels = solveRobots(world, dt, chainColliders);
  // square a tilted chassis flush against the walls (and other robots) — the same
  // contact-torque pass DECODE runs, restricted to CR's perimeter walls.
  squareUpRobotsWalls(world, preVels, CHAIN_HALF_X, CHAIN_HALF_Y, dt);
  // then hard-block any robot whose frame can't clear a beam (kept on its side).
  beamBlock(world);
  // and curb-block a mecanum strafing sideways into a beam (can't climb the ridge laterally —
  // its wheels rest at the near face, the low frame overhangs, no oozing onto the top).
  beamStrafeBlock(world);

  // penalties BEFORE updateChain so a foul awarded this tick folds into the alliance
  // total updateChain writes (it reads scores[a].foulPoints). Endgame/ascend state read
  // is last-tick's — one deterministic tick of lag, invisible.
  if (world.chain) updateChainPenalties(world);

  // CR gameplay (particles / shooter / scoring / catalysts / endgame)
  if (world.chain) updateChain(world, dt, actual, enabled);

  chainStepMatch(world, dt);
}

/**
 * The Chain Reaction phase/timer machine — 30 s auto, 120 s teleop (last 20 s = end
 * game), then post. Scoring is continuous in `updateChain`, so this only advances the
 * countdown + phase progression (no per-phase assessment).
 */
function chainStepMatch(world: World, dt: number): void {
  const m = world.match;
  if (m.phase === 'pre') {
    if (m.preCountdown == null) return; // solo: the controller starts the match
    m.preCountdown -= dt;
    if (m.preCountdown <= 0) {
      m.preCountdown = undefined;
      m.phase = 'auto';
      m.phaseTimeLeft = C.AUTO_DURATION;
      world.events.push('AUTO');
    }
    return;
  }
  if (m.phase === 'freeplay' || m.phase === 'post') return;
  m.phaseTimeLeft -= dt;
  if (m.phaseTimeLeft > 0) return;
  switch (m.phase) {
    case 'auto':
      for (const r of world.robots) r.autoPathActive = false;
      m.phase = 'transition';
      m.phaseTimeLeft = C.TRANSITION_DURATION;
      world.events.push('AUTO COMPLETE');
      break;
    case 'transition':
      m.phase = 'teleop';
      m.phaseTimeLeft = C.TELEOP_DURATION;
      world.events.push('TELEOP');
      break;
    case 'teleop':
      m.phase = 'post';
      m.phaseTimeLeft = 0;
      world.events.push('MATCH COMPLETE');
      break;
  }
}
