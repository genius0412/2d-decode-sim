/**
 * Headless smoke test of the sim core: drives, shoots (incl. on the move),
 * opens the gate, and checks scoring math. Run with: npx tsx scripts/smoke.ts
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { createWorld, DEFAULT_ASSISTS, DEFAULT_SPEC, coerceAssists, coerceSpec, coerceSetup, coerceStartPose } from '../src/sim/spawn';
import { drawWheels } from '../src/render/drawRobot';
import { sanitizePlayer, sanitizePlayerPatch } from '../src/net/sanitize';
import { derivedRole, savedStartCap } from '../src/ui/startPositions';
import { queuedModes, queuedGames, queuesFor, anyoneQueued, expandLabel, widenHint } from '../src/ui/queueDepth';
import {
  parkQueue, takeQueue, dropQueue, updateQueue, peekQueue, subscribeQueue, elapsedLabel, elapsedSeconds,
} from '../src/ui/queueKeeper';
import type { LobbyPlayer } from '../src/net/protocol';
import { generateRoomCode, isValidRoomCode, normalizeRoomCode } from '../src/net/roomCode';
import { step } from '../src/sim/world';
import { updatePenalties } from '../src/sim/penalties';
import { aimSolution, robotInLaunchZone } from '../src/sim/robot';
import { updateHumanPlayers } from '../src/sim/humanPlayer';
import { startMatch } from '../src/sim/match';
import { gateColliderPos, pushingGate } from '../src/sim/goal';
import {
  inLaunchZone,
  gateZone,
  gateArmRect,
  startPose,
  goalCenter,
  goalTriangle,
  goalFaceNormal,
  goalLineValue,
  basinFunnelTarget,
  railPos,
  classifierRect,
  baseZone,
  gateTapeSegments,
  depotSegment,
  allianceArea,
  tunnelStrip,
  loadZone,
  loadSlots,
  loadBoxSlots,
  loadPreStage,
  inRect,
  evalStartPose,
  snapStartToLegal,
  mirrorStartPose,
  presetPose,
  activeStartLegal,
  footprintExtents,
} from '../src/sim/field';
import { addClassified, addOverflow, assessMatchEnd } from '../src/sim/scoring';
import type { Alliance, DrivetrainType, GameId, GameMode, RobotCommand, RobotSpec, RobotState, World } from '../src/types';
import {
  SIM_DT,
  PRE_COUNTDOWN as C_PRE_COUNTDOWN,
  GATE_STOP_S,
  GATE_OPEN_LATCH_S,
  GATE_TAPE_Y,
  RAIL_PITCH,
  BASIN_FLOOR_Z,
  RAMP_SURFACE_Z,
  FIELD_HALF,
  BALL_RADIUS,
  HP_INITIAL_STOCK,
  HP_PLACE_DELAY,
  BALANCE_VERSION,
  SIM_VERSION,
  INTAKE_PRESETS,
  ROBOT_PRESETS,
  ROBOT_MAX_SIZE,
  ROBOT_MIN_WIDTH,
  SWERVE_MIN_WIDTH,
  intakeMouth,
  DRIVETRAIN_PRESETS,
  DRIVETRAIN_LIMITS,
  BUTTERFLY_MODES,
  START_POSES,
  SPEED_PER_RPM,
  REF_DRIVE_RPM,
  DRIVE_EFFICIENCY,
  WHEEL_DIAMETER_MM,
  BASE_DRIVE_ACCEL,
  POWER_DRAW_SWERVE,
  POSSESSION_MOVE_SPEED,
  POSSESSION_GRACE,
  PTS_FOUL_MAJOR,
  MAX_SAVED_STARTS,
  MAX_SAVED_STARTS_SUPPORTER,
  CHASSIS_COLORS,
  chassisFill,
} from '../src/config';
import { robotCorners, robotExtents, robotIntersectsRect, wheelContacts } from '../src/sim/physics';
import { beamBlock, beamDrag, beamDragFactor, beamStrafeBlock, beamForwardness, beamRide, canCrossBeams, cogFactor, wheelsOnBeam, CHAIN_BEAMS } from '../src/games/chain/beams';
import { butterflyTankRpmLimits, driveParams, massLimits, rpmLimits, motorStep, driveSummary, widthLimits } from '../src/sim/drivetrain';
import { coerceSettings, defaultSettings, switchGame, syncAudioMirrors } from '../src/settings';
import type { RobotSetup } from '../src/sim/spawn';
import { DEFAULT_BINDINGS, mergeBindings } from '../src/input/bindings';
import { quantizeCommand, dequantizeCommand, localizeCommand, slimWorld, unslimWorld, encodeBallDelta, applyBallDelta } from '../src/net/protocol';
import type { Artifact } from '../src/types';
import { worldHash } from '../src/net/checksum';
import {
  runRecordMatch,
  simulateReplay,
  verifyReplay,
  recordSetups,
  recordScore,
  maxMatchTicks,
  REPLAY_FORMAT,
  type CommandSource,
  replayViewpoint,
  type Replay,
  type ReplayResult,
} from '../src/sim/replay';
import { Room, type Client } from '../server/room';
import { maintenanceBiting } from '../server/db/repo';
import { maintenanceLine } from '../src/ui/MaintenanceBanner';
import { Matchmaker, radiusCeiling, type QueueEntry } from '../server/matchmaking';
import { bestHost } from '../server/regions';
import type { PendingMatch } from '../server/matchTypes';
import { computeGlicko, glicko2Update, eloMode, RD_PROVISIONAL, type EloParticipant } from '../server/ranked';
import type { ServerMsg, QueueMode } from '../src/net/protocol';
import { dsin, dcos, dtan, datan2, hyp, rot, wrapAngle } from '../src/math';
import { initPhysics } from '../src/sim/physicsEngine';
import { moduleFor, gameOf } from '../src/games';
import { decodeColliders } from '../src/games/decode/colliders';
import { createChainWorld } from '../src/games/chain/spawn';
import { chainStep } from '../src/games/chain/step';
import { chainGoalAimHeading, chainCatalystPrompt, updateChain } from '../src/games/chain/play';
import { chainColliders } from '../src/games/chain/colliders';
import {
  CHAIN_HALF_X,
  CHAIN_HALF_Y,
  CHAIN_ACCEL_DEPTH,
  CHAIN_ACCEL_HALF_Y,
  CHAIN_HOOK_Y,
  CHAIN_PARTICLE_SIM,
  CHAIN_PARTICLE_R,
  CHAIN_PRESETS,
  chainStorageMax,
  CHAIN_TWIN_MASS_FLOOR,
  CHAIN_TWIN_FIRE_MULT,
  CHAIN_TWIN_BARREL_OFFSET,
  CHAIN_DRUM_SPEED,
  CHAIN_MIN_LENGTH,
  CHAIN_MAX_LENGTH,
  CHAIN_PRISM,
  chainArmReach,
} from '../src/games/chain/config';
import { CHAIN_HOOKS_PER_GOAL, accelMultiplier, catalystTrackTarget, chainEvalStart, chainStartExtents, chainHeadingFits, chainNearestFittingHeading, chainSnapStartPose, chainIntakeMouths, chainMirrorStart, chainSnapStart, chainStartLegal, hookPos, labAreas, onRingStand, ringStandBoxes, ringStands } from '../src/games/chain/state';
import {
  CHAIN_CATALYSTS,
  CHAIN_CATALYST_TYPES,
  CHAIN_DEFAULT_CATALYST,
  CHAIN_HALF_Y,
  CHAIN_STORAGE_MAX,
  CHAIN_EXPANSION,
  CHAIN_CATALYST_OD,
  CHAIN_MAX_LENGTH,
  chainSizeLimits,
  chainMountFits,
  CHAIN_CATAPULT_RANGE_MIN,
  CHAIN_CATAPULT_RANGE_MAX,
  catapultMassFor,
  catapultCycleFor,
  CHAIN_NET_RESTITUTION,
  CHAIN_WALL_RESTITUTION,
  CHAIN_NET_VZ_KEEP,
  CHAIN_START_POSES,
  CHAIN_LAB,
  CHAIN_RINGSTAND_BOX,
  CHAIN_HALF_Y,
  chainMassFloorBump,
  chainStorageMax,
} from '../src/games/chain/config';
import { CHAIN_CATALYST_MOUNTS, CHAIN_INTAKE_MOUNTS, CHAIN_TURRET_POSITIONS, intakeMountOf, isEdgePos, isTurreted, shooterMountOf, turretLocal, turretRadius } from '../src/games/chain/mounts';

// the sim now steps a Rapier physics world (robots) — load the WASM before any
// step() runs. tsx runs this file as ESM, so top-level await is available.
await initPhysics();

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const cmd = (patch: Partial<RobotCommand>): RobotCommand => ({
  driveX: 0,
  driveY: 0,
  rotate: 0,
  intake: false,
  fire: false,
  ...patch,
});

function run(world: World, c: RobotCommand, seconds: number): void {
  const commands = new Map([[0, c]]);
  const n = Math.round(seconds / SIM_DT);
  for (let i = 0; i < n; i++) step(world, SIM_DT, commands);
}

/** legacy single-robot spawn used by most checks: robot id 0 on `alliance`,
 * default spec/assists, optionally overridden by a partial spec */
const mkWorld = (
  mode: GameMode,
  alliance: Alliance,
  seed: number,
  spec?: Partial<RobotSpec>,
): World =>
  createWorld(mode, seed, [
    {
      id: 0,
      alliance,
      spec: { ...DEFAULT_SPEC, ...spec },
      assists: { ...DEFAULT_ASSISTS },
      startIndex: 0,
    },
  ]);

const slotCount = (w: World, a: 'red' | 'blue') =>
  w.balls.filter((b) => b.state.kind === 'rail' && b.state.goal === a && !b.state.overflow)
    .length;

// ---- spawn sanity ----------------------------------------------------------
{
  const w = mkWorld('match', 'blue', 42);
  // on-field = ground balls (preloads are now PHYSICAL 'held' balls inside robots)
  const field = w.balls.filter((b) => b.state.kind === 'ground');
  const purple = field.filter((b) => b.color === 'purple').length;
  const green = field.filter((b) => b.color === 'green').length;
  check('24 on-field balls at spawn (9 spike + 3 loading pre-stage per alliance)', field.length === 24, `${field.length}`);
  check('on-field color split 16P/8G', purple === 16 && green === 8, `${purple}P ${green}G`);
  check('hopper preloaded with 3', w.robots[0].hopper.length === 3);
  check(
    'default spawn is a legal G304 start (blue)',
    evalStartPose(w.robots[0].spec, { x: w.robots[0].pos.x, y: w.robots[0].pos.y, headingDeg: (w.robots[0].heading * 180) / Math.PI }, 'blue').legal,
  );
  const pose = startPose('blue', 0);
  check(
    'start pose heading comes from START_POSES degrees',
    Math.abs(w.robots[0].heading - pose.heading) < 1e-9,
    `${(w.robots[0].heading * 180 / Math.PI).toFixed(1)}°`,
  );
  check('blue goal is far-left (cross-court)', goalCenter('blue').x < 0 && goalCenter('blue').y > 0);
  check('red goal is far-right', goalCenter('red').x > 0 && goalCenter('red').y > 0);
}

// ---- configurable start positions (rule G304) ------------------------------
{
  // every named preset is a LEGAL setup for the default spec, both alliances
  let presetsLegal = true;
  for (const p of START_POSES) {
    const canon = { x: p.x, y: p.y, headingDeg: p.headingDeg };
    if (!evalStartPose(DEFAULT_SPEC, canon, 'red').legal) presetsLegal = false;
    if (!evalStartPose(DEFAULT_SPEC, mirrorStartPose(canon, 'blue'), 'blue').legal) presetsLegal = false;
  }
  check('every START_POSES preset is a legal G304 setup (both alliances)', presetsLegal);

  // DYNAMIC presets: presetPose resolves EVERY preset legal for ANY chassis size
  let dynOk = true;
  const chassis = [DEFAULT_SPEC, { ...DEFAULT_SPEC, length: 18, width: 18, intake: 'triangle' as const }, { ...DEFAULT_SPEC, length: 10, width: 10, intake: 'vector' as const }];
  for (const s of chassis) for (const a of ['red', 'blue'] as const) for (let i = 0; i < START_POSES.length; i++) {
    if (!evalStartPose(s, presetPose(i, a, s), a).legal) dynOk = false;
  }
  check('presetPose yields a legal pose for every preset/alliance/chassis size', dynOk);

  // a mid-field pose (touching nothing) is NOT legal — the OLD presets were here
  const midField = evalStartPose(DEFAULT_SPEC, { x: 20, y: 40, headingDeg: 315 }, 'red');
  check('mid-launch-zone pose fails G304 (not touching goal/wall)', !midField.legal && !midField.touching);

  // a pose off the field / into the opponent half fails the containment clauses
  check('off-field pose fails containment', !evalStartPose(DEFAULT_SPEC, { x: 71, y: 71, headingDeg: 0 }, 'red').contained);
  check('pose in the opponent half fails ownHalf', !evalStartPose(DEFAULT_SPEC, { x: -30, y: 50, headingDeg: 0 }, 'red').ownHalf);

  // collision box: a pose buried in the goal corner is NOT clear (penetrates the structure)
  const buried = evalStartPose(DEFAULT_SPEC, { x: 62, y: 62, headingDeg: 0 }, 'red');
  check('footprint inside the goal structure fails the clear clause', !buried.clear && !buried.legal);

  // snapping makes ANY spec legal from ANY seed, both alliances
  let snapOk = true;
  const specs = [DEFAULT_SPEC, { ...DEFAULT_SPEC, length: 18, width: 18, intake: 'triangle' as const }, { ...DEFAULT_SPEC, length: 10, width: 10, intake: 'vector' as const }];
  const seeds = [{ x: 5, y: 5, headingDeg: 33 }, { x: 30, y: 0, headingDeg: 100 }, { x: 65, y: -10, headingDeg: 200 }, { x: 10, y: 65, headingDeg: 0 }];
  for (const s of specs) for (const a of ['red', 'blue'] as const) for (const seed of seeds) {
    if (!evalStartPose(s, snapStartToLegal(s, seed, a), a).legal) snapOk = false;
  }
  check('snapStartToLegal yields a legal pose for any spec/alliance/seed', snapOk);
  check('snapStartToLegal leaves an already-legal pose unchanged', (() => {
    const legal = mirrorStartPose({ x: START_POSES[0].x, y: START_POSES[0].y, headingDeg: START_POSES[0].headingDeg }, 'red');
    const s = snapStartToLegal(DEFAULT_SPEC, legal, 'red');
    return s.x === legal.x && s.y === legal.y && s.headingDeg === legal.headingDeg;
  })());

  // mirror is self-inverse
  const mp = { x: 33.3, y: -12.1, headingDeg: 47 };
  const rt = mirrorStartPose(mirrorStartPose(mp, 'blue'), 'blue');
  check('mirrorStartPose is self-inverse', Math.abs(rt.x - mp.x) < 1e-9 && Math.abs(rt.headingDeg - mp.headingDeg) < 1e-9);

  // coerceStartPose rejects junk, clamps to the field
  check('coerceStartPose rejects non-finite', coerceStartPose({ x: NaN, y: 0, headingDeg: 0 }) === null);
  check('coerceStartPose rejects non-object', coerceStartPose(null) === null && coerceStartPose('x') === null);
  const clamped = coerceStartPose({ x: 999, y: -999, headingDeg: 725 });
  check('coerceStartPose clamps x/y to field + normalizes heading', !!clamped && clamped.x === FIELD_HALF && clamped.y === -FIELD_HALF && clamped.headingDeg === 5);

  // coerceSetup snaps a spoofed illegal custom pose to a legal spawn pose
  const bad = coerceSetup({ id: 0, alliance: 'blue', spec: DEFAULT_SPEC, assists: DEFAULT_ASSISTS, startIndex: 0, startPose: { x: 0, y: 0, headingDeg: 0 } });
  check('coerceSetup snaps an illegal custom startPose legal', !!bad.startPose && evalStartPose(DEFAULT_SPEC, mirrorStartPose(bad.startPose, 'blue'), 'blue').legal);

  // a custom pose actually drives the spawn position (canonical → mirrored)
  const customCanon = { x: START_POSES[1].x, y: START_POSES[1].y, headingDeg: START_POSES[1].headingDeg };
  const cw = createWorld('match', 1, [{ id: 0, alliance: 'red', spec: DEFAULT_SPEC, assists: DEFAULT_ASSISTS, startIndex: 0, startPose: customCanon }]);
  const want = startPose('red', 0, customCanon);
  check('custom startPose overrides startIndex at spawn', Math.hypot(cw.robots[0].pos.x - want.pos.x, cw.robots[0].pos.y - want.pos.y) < 1e-6);

  // the spawned robot (red = canonical frame) is a legal G304 setup
  const spawnedPose = { x: cw.robots[0].pos.x, y: cw.robots[0].pos.y, headingDeg: (cw.robots[0].heading * 180) / Math.PI };
  check('spawned custom-pose robot is a legal G304 setup', evalStartPose(cw.robots[0].spec, spawnedPose, 'red').legal);

  // activeStartLegal (LOCAL start guard): null (preset) is always ok; a custom pose
  // legal for a SMALL chassis but illegal for a BIGGER one is caught so the local
  // game start can block-and-warn instead of silently snapping.
  const smallSpec = coerceSpec({ ...DEFAULT_SPEC, length: 11, width: 10, intake: 'vector' });
  const bigSpec = coerceSpec({ ...DEFAULT_SPEC, length: 18, width: 18, intake: 'vector' });
  let crossChassisCaught = false;
  outer: for (let x = -70; x <= 70 && !crossChassisCaught; x += 3)
    for (let y = -70; y <= 70; y += 3)
      for (let h = 0; h < 360; h += 30) {
        const p = { x, y, headingDeg: h };
        if (evalStartPose(smallSpec, p, 'red').legal && !evalStartPose(bigSpec, p, 'red').legal) {
          crossChassisCaught = activeStartLegal(smallSpec, 'red', p) && !activeStartLegal(bigSpec, 'red', p);
          if (crossChassisCaught) break outer;
        }
      }
  check('activeStartLegal ok for a preset (null pose)', activeStartLegal(bigSpec, 'blue', null));
  check('activeStartLegal flags a pose legal for a small chassis but illegal for a big one', crossChassisCaught);

  // 2v2 CLOSE/FAR role derivation always yields DISTINCT roles for the two allies —
  // including after a swap + host-leave + rejoin (rejoiner returns with a NEW
  // clientId and NO startRole; partner keeps its swapped role).
  const lp = (clientId: string, startRole?: 'close' | 'far'): LobbyPlayer =>
    ({ clientId, alliance: 'blue', hidden: false, startRole }) as unknown as LobbyPlayer;
  const rolesDistinct = (a: LobbyPlayer, b: LobbyPlayer): boolean => {
    const ra = derivedRole([a, b], a);
    const rb = derivedRole([a, b], b);
    return ra !== undefined && rb !== undefined && ra !== rb;
  };
  check('duo roles: a fresh pair splits close/far', rolesDistinct(lp('a'), lp('b')));
  check(
    'duo roles: after a swap, explicit distinct roles are honored',
    derivedRole([lp('a', 'far'), lp('b', 'close')], lp('a', 'far')) === 'far',
  );
  // the reported bug: swap (partner keeps far), host leaves, rejoins with a NEW
  // higher clientId + no startRole — old clientId-only sort put BOTH on far.
  check(
    'duo roles: rejoiner (new id, no role) takes the OPPOSITE of partner’s retained role',
    (() => {
      const partner = lp('a', 'far'); // stayed, kept swapped role
      const rejoiner = lp('z'); // rejoined: new id sorts after 'a', no startRole
      return derivedRole([partner, rejoiner], partner) === 'far' && derivedRole([partner, rejoiner], rejoiner) === 'close';
    })(),
  );
  check('duo roles: identical explicit roles (collision) still resolve distinct', rolesDistinct(lp('a', 'far'), lp('b', 'far')));

  // Close/Far categories: presets partition, and each is legal in its own category
  const closeP = START_POSES.filter((p) => p.cat === 'close');
  const farP = START_POSES.filter((p) => p.cat === 'far');
  check('presets partition into close + far (both non-empty)', closeP.length > 0 && farP.length > 0 && closeP.length + farP.length === START_POSES.length);

  // settings: new start fields default sanely + saved library caps per category
  const def = coerceSettings({});
  check('coerceSettings defaults startCat/library/memory', def.startCat === 'close' && Array.isArray(def.savedStartPoses.close) && def.startMemory.far.index === 1);
  const capped = coerceSettings({ savedStartPoses: { close: [{ x: 5, y: 6, headingDeg: 0 }, { x: 7, y: 8, headingDeg: 10 }, { x: 9, y: 9, headingDeg: 20 }], far: [{ x: NaN, y: 0, headingDeg: 0 }, 'junk'] } });
  // The PERSIST cap is the SUPPORTER ceiling, deliberately — not the free one.
  // Sanitizing to 2 would silently delete a supporter's saved poses on any load
  // before the entitlement resolved, and again the moment a membership lapsed.
  // The free cap is enforced by the Save button (savedStartCap), not by storage.
  check('coerceSettings keeps saved starts up to the SUPPORTER cap + drops junk', capped.savedStartPoses.close.length === 3 && capped.savedStartPoses.far.length === 0);
  const overflow = coerceSettings({
    savedStartPoses: {
      close: Array.from({ length: MAX_SAVED_STARTS_SUPPORTER + 3 }, (_, i) => ({ x: i, y: 0, headingDeg: 0 })),
      far: [],
    },
  });
  check('coerceSettings still caps runaway saved starts at the supporter ceiling', overflow.savedStartPoses.close.length === MAX_SAVED_STARTS_SUPPORTER);
  check('savedStartCap: free players get MAX_SAVED_STARTS, supporters get more', savedStartCap(false) === MAX_SAVED_STARTS && savedStartCap(true) === MAX_SAVED_STARTS_SUPPORTER);
  // the supporter chassis colour is an ALLOWLIST — a spoofed spec cannot inject
  // an arbitrary CSS colour into the renderer, and an unknown key falls back
  check('chassisColor: coerceSpec accepts only allowlisted keys', coerceSpec({ chassisColor: 'plum' }).chassisColor === 'plum' && coerceSpec({ chassisColor: 'url(javascript:x)' }).chassisColor === undefined);
  check('chassisFill: an unknown/absent key renders the default fill', chassisFill(undefined) === CHASSIS_COLORS.default && chassisFill('nope') === CHASSIS_COLORS.default);

  // PER-GAME loadouts: switching games swaps robot + saved robots + start positions; nothing bleeds
  {
    let s = coerceSettings({ game: 'decode' });
    // build a DECODE loadout: name the robot + save one + pick a start
    s = { ...s, spec: { ...s.spec, name: 'DecodeBot' }, savedRobots: [{ ...s.spec, name: 'DSaved' }], startIndex: 2 };
    // switch to CR: the flat fields become CR's (fresh) — DECODE's are archived, not visible
    s = switchGame(s, 'chain');
    check('per-game: switching to CR hides DECODE saved robots', s.savedRobots.length === 0 && s.game === 'chain');
    // build a CR loadout: an 18"-long robot + a CR start anchor (index 3, valid only for CR)
    // 15" is the CR cap for a front-mounted sloped sweeper (18" cube − 3" reach); the
    // sweeper is structure and now counts toward the start cube, so 18" is no longer legal.
    const crCap = chainSizeLimits({ ...DEFAULT_SPEC, intake: 'sloped', intakeMount: 'front' }).maxLength;
    s = { ...s, spec: coerceSpec({ ...s.spec, name: 'ChainBot', length: crCap }, undefined, 'chain'), savedRobots: [{ ...s.spec, name: 'CSaved' }], startIndex: 3 };
    check('per-game: a CR chassis keeps its max legal length + anchor 3', s.spec.length === crCap && s.startIndex === 3);
    // back to DECODE: our DECODE loadout returns intact (name/saved/start), CR's is archived
    s = switchGame(s, 'decode');
    check('per-game: DECODE loadout restored on switch back', s.spec.name === 'DecodeBot' && s.savedRobots[0]?.name === 'DSaved' && s.startIndex === 2);
    // and CR's 18" build is preserved in the archive (would clamp to ~15 if it lived under DECODE)
    s = switchGame(s, 'chain');
    check('per-game: CR loadout (max-length build) survives the round-trip', s.spec.name === 'ChainBot' && s.spec.length === crCap && s.startIndex === 3);
  }
}

// ---- field markings geometry (manual Section 9) ----------------------------
{
  // gate-zone marking: two parallel 10in tape LINES, 2.75in apart, running
  // perpendicular to the wall (constant y), centered on the gate
  let tapeOk = true;
  for (const a of ['red', 'blue'] as const) {
    const [s0, s1] = gateTapeSegments(a);
    for (const [p0, p1] of [s0, s1]) {
      if (Math.abs(Math.abs(p1.x - p0.x) - 10) > 1e-9) tapeOk = false; // 10in into the field
      if (Math.abs(p1.y - p0.y) > 1e-9) tapeOk = false; // runs ⟂ to the wall (constant y)
      if (Math.abs(Math.abs(p0.x) - (FIELD_HALF - 6)) > 1e-9) tapeOk = false; // starts at classifier edge (66)
    }
    if (Math.abs(Math.abs(s0[0].y - s1[0].y) - 2.75) > 1e-9) tapeOk = false; // 2.75in apart
  }
  check('gate tape: two 10in lines 2.75in apart, starting at the classifier edge', tapeOk);

  // depot tape runs flush ALONG the goal face from the far-wall corner to the
  // classifier edge (it must NOT run through the classifier to the side wall)
  const [d0, d1] = depotSegment('blue');
  const tri = goalTriangle('blue');
  check(
    'depot tape starts flush at the goal face far-wall corner',
    Math.hypot(d0.x - tri[0].x, d0.y - tri[0].y) < 1e-9,
  );
  check(
    'depot tape lies flush on the goal face (both ends, perp dist ~0)',
    Math.abs(goalLineValue(d0, 'blue')) < 1e-9 && Math.abs(goalLineValue(d1, 'blue')) < 1e-9,
  );
  check(
    'depot tape ends at the classifier edge, not the side wall',
    Math.abs(Math.abs(d1.x) - (FIELD_HALF - 6)) < 1e-9,
    `end x=${d1.x.toFixed(1)}`,
  );

  // alliance areas: fully outside the field, 96 along wall from the audience end
  let areaOk = true;
  for (const a of ['red', 'blue'] as const) {
    const r = allianceArea(a);
    const outside = Math.min(Math.abs(r.x0), Math.abs(r.x1)) >= FIELD_HALF - 1e-9;
    const span = r.y1 - r.y0;
    if (!outside || Math.abs(span - 96) > 1e-9 || r.y0 !== -FIELD_HALF) areaOk = false;
  }
  check('alliance areas: 96x54 outside the walls, flush with the audience end', areaOk);

  // secret tunnel tape length + width (manual: ~46.5 x ~6.125)
  const ts = tunnelStrip('blue');
  check('secret tunnel strip is TUNNEL_STRIP_LEN long', Math.abs(ts.y1 - ts.y0 - 46.5) < 1e-9, `${(ts.y1 - ts.y0).toFixed(1)} in`);
  check('secret tunnel strip is ~6.125in wide', Math.abs(ts.x1 - ts.x0 - 6.125) < 1e-9, `${(ts.x1 - ts.x0).toFixed(3)} in`);

  // GOAL footprint: right triangle in the corner, 26.5in along the far wall,
  // 18.3in down the side wall (manual "Top View Goal Opening Inside Dimensions")
  for (const a of ['red', 'blue'] as const) {
    const [far, side, corner] = goalTriangle(a);
    // corner is the right angle, on both walls
    const cornerOk = Math.abs(Math.abs(corner.x) - FIELD_HALF) < 1e-9 && Math.abs(corner.y - FIELD_HALF) < 1e-9;
    const farLeg = Math.hypot(far.x - corner.x, far.y - corner.y); // along the far wall
    const sideLeg = Math.hypot(side.x - corner.x, side.y - corner.y); // down the side wall
    check(
      `${a} goal: 26.5in far-wall leg / 18.3in side-wall leg, right-angle in the corner`,
      cornerOk && Math.abs(farLeg - 26.5) < 1e-9 && Math.abs(sideLeg - 18.3) < 1e-9,
      `far=${farLeg.toFixed(1)} side=${sideLeg.toFixed(1)}`,
    );
  }
  // goal face normal is a unit vector pointing into the field (not 45°)
  const n = goalFaceNormal('blue');
  check(
    'goal face normal is unit and points into the field',
    Math.abs(Math.hypot(n.x, n.y) - 1) < 1e-9 && n.x > 0 && n.y < 0 && Math.abs(n.x - Math.SQRT1_2) > 1e-3,
    `(${n.x.toFixed(3)},${n.y.toFixed(3)})`,
  );
  // BASE ZONE: 18x18, diagonally opposite corners (d*24,-48) and (d*42,-30)
  let baseOk = true;
  for (const a of ['red', 'blue'] as const) {
    const bz = baseZone(a);
    const d = a === 'blue' ? 1 : -1; // driver side (blue +x, red -x)
    const xs = [bz.x0, bz.x1].map((x) => x).sort((p, q) => p - q);
    const want = [d * 24, d * 42].sort((p, q) => p - q);
    if (Math.abs(xs[0] - want[0]) > 1e-9 || Math.abs(xs[1] - want[1]) > 1e-9) baseOk = false;
    if (Math.abs(bz.y0 - -48) > 1e-9 || Math.abs(bz.y1 - -30) > 1e-9) baseOk = false;
  }
  check('base zone: 18x18 corners at (d*24,-48) & (d*42,-30)', baseOk);

  // goalLineValue: >0 behind the face (in the corner), <0 in front (field side)
  const [, , blueCorner] = goalTriangle('blue');
  check(
    'goalLineValue: corner is behind the face, field center is in front',
    goalLineValue(blueCorner, 'blue') > 0 && goalLineValue({ x: 0, y: 0 }, 'blue') < 0,
    `corner=${goalLineValue(blueCorner, 'blue').toFixed(1)} center=${goalLineValue({ x: 0, y: 0 }, 'blue').toFixed(1)}`,
  );
}

// ---- driving: forward vs strafe ratio -------------------------------------
{
  const w = mkWorld('free', 'blue', 7);
  const r = w.robots[0];
  r.pos = { x: 0, y: 0 };
  r.heading = Math.PI / 2;
  r.fieldCentric = false;
  run(w, cmd({ driveY: 1 }), 0.8);
  const fwd = r.pos.y;

  const w2 = mkWorld('free', 'blue', 7);
  const r2 = w2.robots[0];
  r2.pos = { x: 0, y: 0 };
  r2.heading = Math.PI / 2;
  r2.fieldCentric = false;
  run(w2, cmd({ driveX: 1 }), 0.8);
  const strafe = Math.abs(r2.pos.x);
  const ratio = strafe / fwd;
  check('strafe slower than forward (~0.8x)', ratio > 0.7 && ratio < 0.95, `ratio=${ratio.toFixed(3)}`);
}

// ---- wall contact squares the robot up --------------------------------------
{
  const w = mkWorld('free', 'blue', 3);
  const r = w.robots[0];
  r.pos = { x: 0, y: 50 };
  r.heading = Math.PI / 2 + 0.3; // tilted ~17° while driving at the far wall
  r.fieldCentric = false;
  run(w, cmd({ driveY: 1 }), 2.5);
  const misalign = Math.abs(((r.heading - Math.PI / 2 + Math.PI) % Math.PI) - Math.PI);
  const err = Math.min(Math.abs(misalign), Math.abs(Math.abs(misalign) - Math.PI));
  check('driving tilted into a wall straightens the robot', err < 0.08, `residual=${err.toFixed(3)} rad`);
}

// ---- contact torque scales with speed: a fast hit squares up fast ---------------
{
  const w = mkWorld('free', 'blue', 4);
  const r = w.robots[0];
  r.pos = { x: 0, y: 25 }; // long run-up: reaches full speed before the far wall
  r.heading = Math.PI / 2 + 0.35; // ~20° tilt
  r.fieldCentric = false;
  run(w, cmd({ driveY: 1 }), 1.2);
  const misalign = Math.abs(((r.heading - Math.PI / 2 + Math.PI) % Math.PI) - Math.PI);
  const err = Math.min(Math.abs(misalign), Math.abs(Math.abs(misalign) - Math.PI));
  check(
    'full-speed wall hit swings the robot flush quickly',
    err < 0.05,
    `residual=${err.toFixed(3)} rad after 1.2s incl. run-up`,
  );
  // keep shoving for another 0.5s: the settled heading must not buzz
  let hMin = Infinity;
  let hMax = -Infinity;
  const commands = new Map([[0, cmd({ driveY: 1 })]]);
  for (let i = 0; i < Math.round(0.5 / SIM_DT); i++) {
    step(w, SIM_DT, commands);
    hMin = Math.min(hMin, r.heading);
    hMax = Math.max(hMax, r.heading);
  }
  check(
    'no heading oscillation while squared against the wall',
    hMax - hMin < 0.01,
    `jitter=${(hMax - hMin).toFixed(4)} rad`,
  );
}

// ---- Rapier containment: full-speed wall drive never tunnels ----------------
{
  const w = mkWorld('free', 'blue', 33);
  const r = w.robots[0];
  r.pos = { x: 0, y: 0 }; // center column: the far wall at x=0 is clear of goals
  r.heading = Math.PI / 2; // +y forward
  r.fieldCentric = false;
  run(w, cmd({ driveY: 1 }), 3); // slam the far (+y) wall for 3s
  const front = robotExtents(r).front;
  // soft contacts allow a sub-half-inch steady penetration (invisible at field
  // scale); the point of the check is that it can't tunnel THROUGH the wall
  const inField = robotCorners(r).every(
    (c) => Math.abs(c.x) <= FIELD_HALF + 0.6 && Math.abs(c.y) <= FIELD_HALF + 0.6,
  );
  check(
    'full-speed wall drive is contained (no tunneling, front edge at the wall)',
    inField && r.pos.y + front <= FIELD_HALF + 0.6 && r.pos.y + front > FIELD_HALF - 2,
    `frontEdge=${(r.pos.y + front).toFixed(2)} wall=${FIELD_HALF}`,
  );
}

// ---- a wheel wedged in the classifier is evicted (no wall fight) ----------------
{
  const w = mkWorld('free', 'blue', 8);
  const r = w.robots[0];
  // left-front corner lands at (-71, 1): 1" off the wall, inside the blue
  // channel — the nearest eviction is THROUGH the wall, which must be refused
  r.pos = { x: -62, y: -11 };
  r.heading = Math.PI / 2;
  r.fieldCentric = false;
  r.vel = { x: 0, y: 0 };
  run(w, cmd({}), 1);
  const rect = classifierRect('blue');
  const stuck = robotCorners(r).some(
    (c) => c.x > rect.x0 && c.x < rect.x1 && c.y > rect.y0 && c.y < rect.y1,
  );
  check('wheel wedged in the classifier gets evicted', !stuck, `pos=(${r.pos.x.toFixed(1)},${r.pos.y.toFixed(1)})`);
  run(w, cmd({ driveY: -1 }), 1);
  check('robot drives free after the eviction', r.pos.y < -25, `y=${r.pos.y.toFixed(1)}`);
}

// ---- a ground ball meshed in the classifier channel is evicted (not stuck) --
{
  const w = mkWorld('free', 'blue', 11);
  const cr = classifierRect('red'); // right-wall channel, x ∈ [66, 72]
  const ball = w.balls[0];
  ball.state = { kind: 'ground' };
  ball.pos = { x: (cr.x0 + cr.x1) / 2, y: 20 }; // dead-center inside the channel
  ball.vel = { x: 0, y: 0 };
  ball.z = 0;
  ball.vz = 0;
  run(w, cmd({}), 0.3);
  const inside = ball.pos.x > cr.x0 && ball.pos.x < cr.x1 && ball.pos.y > cr.y0 && ball.pos.y < cr.y1;
  check(
    'a ground ball meshed in the classifier is evicted out the field side (grabbable)',
    !inside && ball.pos.x <= cr.x0 - BALL_RADIUS + 0.01,
    `pos=(${ball.pos.x.toFixed(1)},${ball.pos.y.toFixed(1)})`,
  );
}

// ---- pinned ball resists the robot ------------------------------------------
{
  const w = mkWorld('free', 'blue', 21);
  const r = w.robots[0];
  r.pos = { x: 0, y: 45 };
  r.heading = Math.PI / 2; // facing the far wall
  r.fieldCentric = false;
  const ball = w.balls[0];
  ball.state = { kind: 'ground' };
  ball.pos = { x: 0, y: FIELD_HALF - BALL_RADIUS }; // resting against the far wall
  ball.vel = { x: 0, y: 0 };
  ball.z = 0;
  ball.vz = 0;
  run(w, cmd({ driveY: 1 }), 2.5); // grind straight into the pinned ball
  const ballSpeed = Math.hypot(ball.vel.x, ball.vel.y);
  const robotSpeed = Math.hypot(r.vel.x, r.vel.y);
  // the funnel mouth is OPEN, so a centered ball nestles against the throat
  // (chassis front) with the intake around it — the CHASSIS must stall behind
  // the ball (the intake tip legitimately overlaps it in the open mouth)
  check(
    'wall-pinned ball stalls the robot (no grind-through)',
    r.pos.y + r.spec.length / 2 < FIELD_HALF - BALL_RADIUS,
    `chassis front y=${(r.pos.y + r.spec.length / 2).toFixed(1)}`,
  );
  check('robot stalled against the pinned ball', robotSpeed < 5, `v=${robotSpeed.toFixed(1)}`);
  check(
    'pinned ball stays put, in-field, no energy blow-up',
    Math.abs(ball.pos.x) < 6 && ball.pos.y <= FIELD_HALF - BALL_RADIUS + 0.01 && ballSpeed < 20,
    `pos=(${ball.pos.x.toFixed(1)},${ball.pos.y.toFixed(1)}) v=${ballSpeed.toFixed(1)}`,
  );
}

// ---- off-center wall ball scatters out of the way -----------------------------
{
  const w = mkWorld('free', 'blue', 22);
  const r = w.robots[0];
  r.pos = { x: 0, y: 45 };
  r.heading = Math.PI / 2;
  r.fieldCentric = false;
  const half = r.spec.width / 2;
  const ball = w.balls[0];
  ball.state = { kind: 'ground' };
  ball.pos = { x: half + 1.5, y: FIELD_HALF - BALL_RADIUS }; // at the corner's path
  ball.vel = { x: 0, y: 0 };
  ball.z = 0;
  ball.vz = 0;
  const startX = ball.pos.x;
  run(w, cmd({ driveY: 1 }), 2.5);
  // a ball beside the chassis (past the intake) gets brushed aside, not funneled,
  // and the robot drives on past it
  check(
    'corner-hit wall ball is nudged aside (not funneled in)',
    ball.pos.x > startX + 0.5 && Math.abs(ball.pos.x) <= FIELD_HALF - BALL_RADIUS + 0.01,
    `x ${startX.toFixed(1)} -> ${ball.pos.x.toFixed(1)}`,
  );
  check('robot drove on once the ball escaped', r.pos.y > 52, `y=${r.pos.y.toFixed(1)}`);
}

// ---- open-field push still moves balls easily ---------------------------------
{
  const w = mkWorld('free', 'blue', 23);
  const r = w.robots[0];
  r.pos = { x: 0, y: -20 };
  r.heading = Math.PI / 2;
  r.fieldCentric = false;
  const ball = w.balls[0];
  ball.state = { kind: 'ground' };
  ball.pos = { x: 0, y: 0 };
  ball.vel = { x: 0, y: 0 };
  ball.z = 0;
  ball.vz = 0;
  run(w, cmd({ driveY: 1 }), 1);
  const dist = Math.hypot(ball.pos.x, ball.pos.y);
  check('open-field push sends the ball rolling', dist > 20, `moved ${dist.toFixed(1)} in`);
}

// ---- launch zone: robot straddling the wedge APEX is IN (OBB overlap, not just
//      corners — the wedge narrows to a point at field center, so all four corners
//      can sit outside both diagonals while the body covers the zone) -------------
{
  const w = mkWorld('free', 'blue', 30);
  const r = w.robots[0];
  r.heading = -Math.PI / 2; // intake points -y, AWAY from the wedge (can't help)
  r.pos = { x: 0, y: -5 }; // body straddles the apex (0,0); no corner is inside
  const cornersIn = robotCorners(r).some((c) => inLaunchZone(c, 'blue'));
  check(
    'robot straddling the launch-wedge apex counts as in-zone (no corner inside)',
    robotInLaunchZone(r) && !cornersIn,
    `result=${robotInLaunchZone(r)} anyCornerIn=${cornersIn}`,
  );
  // sanity: a robot parked in a far corner (well outside both zones) is OUT
  r.pos = { x: 60, y: -60 };
  r.heading = 0;
  check('robot in a far corner is NOT in a launch zone', !robotInLaunchZone(r));
}

// ---- Rapier ground balls: ball-ball separation (no robot involved) -------------
{
  const w = mkWorld('free', 'blue', 24);
  w.robots[0].pos = { x: 60, y: -60 }; // park the robot far from the balls
  const a = w.balls[0];
  const b = w.balls[1];
  for (const bb of [a, b]) {
    bb.state = { kind: 'ground' };
    bb.z = 0;
    bb.vz = 0;
    bb.vel = { x: 0, y: 0 };
  }
  a.pos = { x: -2, y: 0 };
  b.pos = { x: 2, y: 0 }; // overlapping (centers 4in < 5in diameter)
  run(w, cmd({}), 0.5);
  const sep = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
  // started 4in apart (overlapping); Rapier pushes them out to ~contact distance
  // (a small residual < BALL_RADIUS is the soft-contact steady penetration, the
  // same slack robots rest at — the point is they separated, no explosion)
  check(
    'Rapier separates two overlapping ground balls (ball-ball contact)',
    sep >= 2 * BALL_RADIUS - 0.5 && sep < 2 * BALL_RADIUS + 1 && Number.isFinite(sep),
    `sep=${sep.toFixed(2)} in`,
  );
}

// ---- Rapier ground ball never tunnels a wall (hard clamp holds) ----------------
{
  const w = mkWorld('free', 'blue', 25);
  w.robots[0].pos = { x: -60, y: -60 };
  const ball = w.balls[0];
  ball.state = { kind: 'ground' };
  ball.pos = { x: 0, y: FIELD_HALF - 8 };
  ball.vel = { x: 0, y: 400 }; // fired hard at the far wall
  ball.z = 0;
  ball.vz = 0;
  run(w, cmd({}), 0.5);
  check(
    'fast ground ball stays inside the wall (no tunnel past the clamp)',
    ball.pos.y <= FIELD_HALF - BALL_RADIUS + 0.02 && Number.isFinite(ball.pos.y),
    `y=${ball.pos.y.toFixed(3)}`,
  );
}

// ---- Rapier ground-ball physics is deterministic across replays ----------------
{
  const mk = (): World => {
    const w = mkWorld('free', 'blue', 26);
    w.robots[0].pos = { x: 55, y: 55 };
    const a = w.balls[0];
    const b = w.balls[1];
    a.state = { kind: 'ground' }; a.pos = { x: -20, y: 0 }; a.vel = { x: 120, y: 0 }; a.z = 0; a.vz = 0;
    b.state = { kind: 'ground' }; b.pos = { x: 20, y: 0 }; b.vel = { x: -120, y: 0 }; b.z = 0; b.vz = 0;
    return w;
  };
  const w1 = mk();
  const w2 = mk();
  for (let i = 0; i < 300; i++) { step(w1, SIM_DT, new Map()); step(w2, SIM_DT, new Map()); }
  check(
    'ground-ball collisions are bit-for-bit deterministic across two replays',
    worldHash(w1) === worldHash(w2),
    `${worldHash(w1)} vs ${worldHash(w2)}`,
  );
}

// ---- driver-side view frames ------------------------------------------------
{
  // blue driver stands at the RIGHT wall: stick-up must drive toward -x
  const wb = mkWorld('free', 'blue', 7);
  wb.robots[0].pos = { x: 0, y: 0 };
  wb.robots[0].fieldCentric = true;
  run(wb, cmd({ driveY: 1 }), 1);
  check('blue field-centric stick-up drives toward -x (away from blue wall)', wb.robots[0].pos.x < -10, `x=${wb.robots[0].pos.x.toFixed(1)}`);

  // red driver stands at the LEFT wall: stick-up must drive toward +x
  const wr = mkWorld('free', 'red', 7);
  wr.robots[0].pos = { x: 0, y: 0 };
  wr.robots[0].fieldCentric = true;
  run(wr, cmd({ driveY: 1 }), 1);
  check('red field-centric stick-up drives toward +x (away from red wall)', wr.robots[0].pos.x > 10, `x=${wr.robots[0].pos.x.toFixed(1)}`);
}

// ---- passive dummy skips ALL action compute (no aim solve / fire / intake) --
{
  const w = createWorld('match', 42, [
    { id: 0, alliance: 'blue', spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS }, startIndex: 0, passive: true },
  ]);
  startMatch(w);
  const r = w.robots[0];
  r.pos = { x: 10, y: 40 }; // same firing spot a NON-passive robot empties its hopper from
  const hopper0 = r.hopper.length;
  run(w, cmd({ fire: true, intake: true }), 0.5);
  check(
    'passive robot flag propagates + it never acts (fire/intake ignored)',
    r.passive === true && r.hopper.length === hopper0,
    `passive=${r.passive} hopper ${hopper0}->${r.hopper.length}`,
  );
}

// ---- shooting & visible classification -------------------------------------
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  const r = w.robots[0];
  r.pos = { x: 10, y: 40 }; // launch zone, mid-range to the blue goal (-60,60)
  run(w, cmd({ fire: true }), 0.5); // instant burst: 3 preloads in ~0.3s
  const inTransit = w.balls.filter((b) => b.state.kind === 'flight' || b.state.kind === 'basin').length;
  check('burst fire emptied hopper in ~0.3s', r.hopper.length === 0, `hopper=${r.hopper.length}`);
  check('balls travel visibly (flight/basin, no teleport)', inTransit > 0, `${inTransit} in transit`);
  run(w, cmd({}), 6); // land, jumble in the basin, funnel onto the rail
  const g = w.goals.blue;
  const s = w.match.scores.blue;
  check('shots settled into ramp slots', slotCount(w, 'blue') >= 2, `slots=${slotCount(w, 'blue')} classified=${g.classifiedCount} overflow=${g.overflowCount}`);
  check('classified points = 3 each', s.autoClassified === g.classifiedCount * 3, `${s.autoClassified} pts`);
}

// ---- shooting on the move ----------------------------------------------------
{
  const w = mkWorld('match', 'blue', 99);
  startMatch(w);
  const r = w.robots[0];
  r.pos = { x: 20, y: 50 };
  run(w, cmd({ fire: true, driveX: 0.6 }), 1); // strafing while firing
  run(w, cmd({}), 6);
  const g = w.goals.blue;
  check('shooting on the move still scores (lead compensation)', g.classifiedCount + g.overflowCount >= 2, `entered=${g.classifiedCount + g.overflowCount}`);
}

// ---- manual aim: the turret is bolted to the chassis ------------------------
// AIM ASSIST IS ALWAYS ON in the product (the toggle is gone; `coerceAssists` forces
// the flag true), so this path is not reachable through settings. The BRANCH stays, and
// stays tested, because the bug it fixes is what made removing the toggle safe to undo:
// `fire()` launches along `r.turretHeading`, and the aim-assist-off branch used to leave
// it at whatever `spawn` wrote — so the robot shot along one FROZEN world-frame direction
// all match. Reported by @shlok-k720 (PR #37). Set on the robot directly, since the
// coercer will not build a manual-aim config any more.
{
  const w = mkWorld('match', 'blue', 104);
  startMatch(w);
  const r = w.robots[0];
  r.aimAssist = false;
  r.pos = { x: 10, y: 40 };
  r.heading = 0;
  run(w, cmd({}), 0.1);
  const tracks = Math.abs(wrapAngle(r.turretHeading - r.heading)) < 1e-9;
  r.heading = aimSolution(r).yaw; // driver lines it up by hand
  const held = r.hopper.length;
  run(w, cmd({ fire: true }), 6);
  const g = w.goals.blue;
  check(
    'manual aim: the turret tracks the chassis, so a hand-aimed shot scores',
    tracks && g.classifiedCount + g.overflowCount === held,
    `tracks=${tracks} in=${g.classifiedCount + g.overflowCount}/${held}`,
  );
}

// AIM ASSIST IS NOT CONFIGURABLE: every coercion path forces it on, so neither a stale
// localStorage value, a synced account blob, a saved robot slot, nor a spoofed wire
// payload can leave a player on manual aim with no control to switch back.
{
  const forced =
    coerceAssists({ aimAssist: false }).aimAssist &&
    coerceAssists({ aimAssist: false }, { ...DEFAULT_ASSISTS, aimAssist: false }).aimAssist &&
    (coerceSpec({ ...DEFAULT_SPEC, assists: { ...DEFAULT_ASSISTS, aimAssist: false } }).assists
      ?.aimAssist ??
      false) &&
    sanitizePlayer({ assists: { ...DEFAULT_ASSISTS, aimAssist: false } } as never).assists.aimAssist;
  check('aim assist is forced ON through every coercion path (settings, spec, wire)', !!forced);
}

// ---- intake -----------------------------------------------------------------
{
  const w = mkWorld('free', 'blue', 42);
  const r = w.robots[0];
  r.hopper = [];
  w.balls = w.balls.filter((b) => b.state.kind !== 'held'); // clear physical preloads too
  // blue spike column is on the blue (right) side at x=+46
  r.pos = { x: 46, y: -55 };
  r.heading = Math.PI / 2;
  r.fieldCentric = false;
  run(w, cmd({ driveY: 0.6, intake: true }), 3);
  check('intake collected balls from the spike column', r.hopper.length > 0, `hopper=${r.hopper.length}`);
  check('hopper capped at 3', r.hopper.length <= 3);
}

// ---- vector intake spans EXACTLY the chassis width (no overhang) -------------
{
  // the vector wheel row is as wide as the frame — mouthHalf tracks width/2
  const vm14 = intakeMouth({ intake: 'vector', width: 14 });
  const vm18 = intakeMouth({ intake: 'vector', width: 18 });
  check('vector mouth = chassis half-width (no overhang)', vm14.mouthHalf === 7 && vm18.mouthHalf === 9);
  // never wider than the frame, at either width extreme
  check('vector mouth never overhangs the frame', vm14.mouthHalf <= 14 / 2 && vm18.mouthHalf <= 18 / 2);
  // funnel presets keep their FIXED mouth (width-independent)
  check(
    'sloped/triangle keep their fixed funnel mouth',
    intakeMouth({ intake: 'sloped', width: 14 }).mouthHalf === INTAKE_PRESETS.sloped.mouth.mouthHalf &&
      intakeMouth({ intake: 'triangle', width: 18 }).mouthHalf === INTAKE_PRESETS.triangle.mouth.mouthHalf,
  );
}

// ---- sloped intake: the same maneuver only shoves the ball ---------------------
{
  const w = mkWorld('free', 'blue', 6);
  const r = w.robots[0];
  r.hopper = [];
  r.pos = { x: 0, y: 0 };
  r.heading = Math.PI / 2;
  r.fieldCentric = false;
  const ball = w.balls[0];
  w.balls.splice(1); // only this ball on the field
  ball.state = { kind: 'ground' };
  ball.pos = { x: -12, y: 8 };
  ball.vel = { x: 0, y: 0 };
  ball.z = 0;
  ball.vz = 0;
  run(w, cmd({ driveX: -1, intake: true }), 1);
  check('sloped intake has no side capture', r.hopper.length === 0, `hopper=${r.hopper.length}`);
}

// ---- vector intake grabs at the FRONT only — never from the chassis flank ------
{
  // the vector mouth spans the full chassis width now (no overhang), but it's still
  // a FRONT-face intake: a ball sitting beside the chassis BODY is never captured.
  const spec = { length: 11.5, width: 18, intake: 'vector' as const, driveRpm: 435, massLb: 26 };
  const w = mkWorld('free', 'blue', 6, spec);
  const r = w.robots[0];
  r.hopper = [];
  r.pos = { x: 0, y: 0 };
  r.heading = Math.PI / 2;
  r.fieldCentric = false;
  const ball = w.balls[0];
  w.balls.splice(1);
  ball.state = { kind: 'ground' };
  // beside the chassis body (local x≈0), just past the side edge — at heading π/2,
  // world (−(half+2), 0) maps to robot-local (0, half+2): flank, NOT in front
  const half = spec.width / 2;
  ball.pos = { x: -(half + 2), y: 0 };
  ball.vel = { x: 0, y: 0 };
  ball.z = 0;
  ball.vz = 0;
  run(w, cmd({ intake: true }), 0.5); // intake running, not driven into the front
  check(
    'vector intake never captures from the chassis flank',
    r.hopper.length === 0,
    `hopper=${r.hopper.length}`,
  );
}

// ---- sloped drives into a clump; the slopes funnel it to the throat wheels -------
{
  const w = mkWorld('free', 'blue', 6);
  const r = w.robots[0];
  r.hopper = [];
  r.pos = { x: 0, y: -12 };
  r.heading = Math.PI / 2; // forward = +y
  r.fieldCentric = false;
  r.vel = { x: 0, y: 0 };
  // three balls a bit ahead; the robot drives in and the physical slopes deflect
  // the off-center ones to the center compliant wheels (no wide vacuum)
  w.balls.splice(3);
  const ahead = -12 + r.spec.length / 2 + 4;
  [-4, 0, 4].forEach((off, i) => {
    const b = w.balls[i];
    b.state = { kind: 'ground' };
    b.pos = { x: off, y: ahead };
    b.vel = { x: 0, y: 0 };
    b.z = 0;
    b.vz = 0;
  });
  run(w, cmd({ driveY: 0.3, intake: true }), 1.6);
  check(
    'sloped drives a clump in via the slopes (all 3)',
    r.hopper.length === 3,
    `hopper=${r.hopper.length}`,
  );
}

// ---- triangle transfer is CAPPED, not generally slower --------------------------
{
  // CLOSE range (recovery ~0): the triangle's max-rate cap (fireCap 0.12) is its only
  // limit, so it fires a touch slower than a fast sloped intake (interval 0.08). Keep the
  // hopper topped up every tick so CADENCE — not the 3-ball hopper — bounds the count;
  // measure over a full second so the 0.08-vs-0.12 gap resolves cleanly.
  const firedPerSec = (intake: 'sloped' | 'triangle') => {
    const w = mkWorld('free', 'blue', 6, { length: 12, width: 14, intake });
    const r = w.robots[0];
    const g = goalCenter('blue');
    r.pos = { x: g.x + 8, y: g.y - 8 }; // point-blank → recovery ~0, so the cap shows
    let shots = 0;
    for (let i = 0; i < Math.round(1.0 / SIM_DT); i++) {
      while (r.hopper.length < 3) r.hopper.push('green'); // unlimited ammo ⇒ cadence limits
      const before = r.hopper.length;
      step(w, SIM_DT, new Map([[0, cmd({ fire: true })]]));
      shots += before - r.hopper.length;
    }
    return shots;
  };
  const sloped = firedPerSec('sloped');
  const triangle = firedPerSec('triangle');
  check(
    'triangle fires FEWER than sloped up close (max-rate cap bites)',
    triangle < sloped,
    `triangle ${triangle} vs sloped ${sloped}`,
  );
  // buffed cap 0.12 → ~1/0.12 ≈ 8-9 shots/s, comfortably faster than the old 0.18 cap (~6)
  check('triangle close-range cadence honors the buffed fireCap', triangle >= 8, `${triangle} shots/s`);
}

// ---- CLOSE-range rapid fire: near-zero inertia carries a small floor -------------
{
  // point-blank, so the DISTANCE recovery is ~0 and only the close floor differs:
  // a ~0-inertia wheel fires FEWER shots in a tight window than a ~0.2-inertia one.
  const closeShots = (inertia: number) => {
    const w = mkWorld('free', 'blue', 7, { intake: 'sloped', flywheelInertia: inertia });
    const r = w.robots[0];
    const g = goalCenter('blue');
    r.pos = { x: g.x + 8, y: g.y - 8 };
    const start = r.hopper.length;
    run(w, cmd({ fire: true }), 0.25);
    return start - r.hopper.length;
  };
  const lo = closeShots(0);
  const hi = closeShots(0.2);
  check('close rapid fire: ~0 inertia is nerfed vs 0.2 inertia', lo < hi, `inertia0 ${lo} vs inertia0.2 ${hi}`);
}

// ---- gate release --------------------------------------------------------------
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  const r = w.robots[0];
  r.pos = { x: 10, y: 40 };
  run(w, cmd({ fire: true }), 0.5);
  run(w, cmd({}), 6);
  const ramped = slotCount(w, 'blue');
  const zone = gateZone('blue');
  r.pos = { x: zone.x1 + 7, y: (zone.y0 + zone.y1) / 2 };
  r.heading = Math.PI; // face the -x (blue) wall
  r.fieldCentric = false;
  r.vel = { x: 0, y: 0 };
  run(w, cmd({ driveY: 1 }), 4); // drive INTO the gate arm to open it (push-to-open)
  check('gate opened and released ramp balls', slotCount(w, 'blue') < ramped, `slots ${ramped} -> ${slotCount(w, 'blue')}`);
  const groundBalls = w.balls.filter((b) => b.state.kind === 'ground').length;
  check('released balls rolled out onto the field', groundBalls >= 21 + ramped - 1, `${groundBalls} ground`);
}

// ---- gate tap: flow holds the gate open ----------------------------------------
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  const r = w.robots[0];
  r.pos = { x: 10, y: 40 };
  run(w, cmd({ fire: true }), 0.5);
  run(w, cmd({}), 6);
  const ramped = slotCount(w, 'blue');
  const zone = gateZone('blue');
  r.pos = { x: zone.x1 + 7, y: (zone.y0 + zone.y1) / 2 };
  r.heading = Math.PI; // face the -x (blue) wall
  r.fieldCentric = false;
  r.vel = { x: 0, y: 0 };
  run(w, cmd({ driveY: 1 }), 0.3); // tap: a brief push opens the arm...
  r.pos = { x: 0, y: -30 }; // ...and drive away immediately
  run(w, cmd({}), 4);
  check('tapped gate kept draining (flow holds it open)', ramped >= 2 && slotCount(w, 'blue') === 0, `slots ${ramped} -> ${slotCount(w, 'blue')}`);
  check('gate re-closed after the column cleared', !w.goals.blue.gateOpen);
  check('gate arm fell fully closed (gatePos 0) after draining', w.goals.blue.gatePos === 0, `gatePos ${w.goals.blue.gatePos.toFixed(3)}`);
}

// ---- gate is a physical arm: only opens on a real push, then lifts/falls smoothly
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  const g = w.goals.blue;
  const zone = gateZone('blue');
  const r = w.robots[0];
  r.pos = { x: zone.x1 + 7, y: (zone.y0 + zone.y1) / 2 };
  r.heading = Math.PI; // face the -x (blue) wall
  r.fieldCentric = false;
  r.vel = { x: 0, y: 0 };
  // merely LOITERING in the gate zone (no drive input) must NOT open the arm
  run(w, cmd({}), 0.5);
  check('loitering in the gate zone does not open the gate', g.gatePos === 0 && !g.gateOpen, `gatePos ${g.gatePos.toFixed(3)}`);
  // a real push eases the arm open — it travels continuously (not a teleport to full).
  // One tick of a gentle lean lifts it partway, not all the way.
  r.pos = { x: (gateArmRect('blue').x0 + gateArmRect('blue').x1) / 2, y: GATE_TAPE_Y };
  r.vel = { x: 0, y: 0 };
  run(w, cmd({ driveY: 1 }), 1 / 60);
  check('a real push eases the arm open (not instant)', g.gatePos > 0 && g.gatePos < 1, `gatePos ${g.gatePos.toFixed(3)}`);
  // keep leaning on it: it lifts fully open
  run(w, cmd({ driveY: 1 }), 0.5);
  check('sustained push lifts the arm fully open', g.gatePos >= 0.99 && g.gateOpen, `gatePos ${g.gatePos.toFixed(3)}`);
  // release with no ball flowing: the arm stays LATCHED open a beat (no need to hold),
  // then gravity swings it shut
  r.pos = { x: 0, y: -30 };
  run(w, cmd({}), 1 / 60);
  check('gate stays open right after release (latched — no need to keep pressing)', g.gatePos >= 0.99 && g.gateOpen, `gatePos ${g.gatePos.toFixed(3)}`);
  run(w, cmd({}), GATE_OPEN_LATCH_S + 1); // latch lapses, then gravity finishes closing it
  check('gate arm eventually falls fully closed once the latch lapses', g.gatePos === 0 && !g.gateOpen, `gatePos ${g.gatePos.toFixed(3)}`);
}

// ---- gate TAP latches open (no continuous pressing needed) ----------------------
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  const g = w.goals.blue;
  const zone = gateZone('blue');
  const r = w.robots[0];
  r.pos = { x: zone.x1 + 7, y: (zone.y0 + zone.y1) / 2 };
  r.heading = Math.PI; // face the -x (blue) wall
  r.fieldCentric = false;
  r.vel = { x: 0, y: 0 };
  run(w, cmd({ driveY: 1 }), 0.15); // a brief TAP against the arm
  r.pos = { x: 0, y: -30 }; // then drive away immediately (stop pressing)
  run(w, cmd({}), 0.3); // no ball flowing, no push — yet the latch holds it up
  check('a brief tap latches the gate fully open without holding', g.gatePos >= 0.99 && g.gateOpen, `gatePos ${g.gatePos.toFixed(3)}`);
}

// ---- gate opens on a straight push only — NOT driving sideways along the lever ---
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  const r = w.robots[0];
  const ar = gateArmRect('blue');
  r.pos = { x: (ar.x0 + ar.x1) / 2, y: GATE_TAPE_Y }; // squarely against the arm
  // sideways: fast motion ALONG the wall (Y), none into the handle (X) — must NOT open
  r.vel = { x: 0, y: 12 };
  check('driving sideways along the lever does not open the gate', !pushingGate(r, cmd({}), 'blue'));
  // straight in: motion toward the wall (−x for blue) DOES open it
  r.vel = { x: -12, y: 0 };
  check('driving straight into the handle opens the gate', pushingGate(r, cmd({}), 'blue'));
}

// ---- gate handle is a PHYSICAL one-way door: solid when idle, YIELDS on the same
// ---- tick you ram it (no 1-tick jolt), and retracts further the harder you ram -----
{
  // gateColliderPos is the open fraction buildGateArms uses for the handle collider.
  // With the arm pinned CLOSED (gatePos 0): an idle/strafing robot sees the solid stub;
  // a robot ramming it sees the handle already retracting THIS tick (anticipated lift),
  // so it glides through instead of bouncing off — and a harder ram retracts it more.
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  const r = w.robots[0];
  r.pos = { x: (gateArmRect('blue').x0 + gateArmRect('blue').x1) / 2, y: GATE_TAPE_Y };
  r.heading = Math.PI; // face the -x (blue) wall
  r.fieldCentric = false;
  w.goals.blue.gatePos = 0; // handle down (closed)
  const push = new Map([[0, cmd({ driveY: 1 })]]);
  r.vel = { x: 0, y: 0 };
  const idle = gateColliderPos(w, SIM_DT, new Map([[0, cmd({})]]), 'blue');
  r.vel = { x: -10, y: 0 }; // gentle ram toward the -x wall
  const soft = gateColliderPos(w, SIM_DT, push, 'blue');
  r.vel = { x: -55, y: 0 }; // hard ram
  const hard = gateColliderPos(w, SIM_DT, push, 'blue');
  check('idle at a closed gate leaves the handle down (collider not retracted)', idle === 0, `pos ${idle.toFixed(3)}`);
  check('ramming retracts the handle collider on the same tick (no 1-tick jolt)', soft > 0, `pos ${soft.toFixed(3)}`);
  check(
    'a harder ram retracts the handle collider further (speed-scaled)',
    hard > soft,
    `hard ${hard.toFixed(3)} > soft ${soft.toFixed(3)}`,
  );
}

// ---- resting against the OPEN gate holds it open without re-pushing ---------------
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  const g = w.goals.blue;
  const zone = gateZone('blue');
  const r = w.robots[0];
  r.pos = { x: zone.x1 + 7, y: (zone.y0 + zone.y1) / 2 };
  r.heading = Math.PI;
  r.fieldCentric = false;
  r.vel = { x: 0, y: 0 };
  run(w, cmd({ driveY: 1 }), 0.5); // push it open
  check('gate is open after the push', g.gateOpen && g.gatePos >= 0.99, `gatePos ${g.gatePos.toFixed(3)}`);
  // now STOP driving but stay resting against the arm — it must stay open (no re-push)
  r.pos = { x: (gateArmRect('blue').x0 + gateArmRect('blue').x1) / 2, y: GATE_TAPE_Y };
  r.vel = { x: 0, y: 0 };
  run(w, cmd({}), 2); // idle, just touching — well past the latch time
  check('resting against the open gate holds it open (no constant push needed)', g.gateOpen, `gatePos ${g.gatePos.toFixed(3)}`);
  // back away entirely — now it swings shut
  r.pos = { x: 0, y: -30 };
  run(w, cmd({}), GATE_OPEN_LATCH_S + 1);
  check('leaving the gate lets it swing shut', g.gatePos === 0 && !g.gateOpen, `gatePos ${g.gatePos.toFixed(3)}`);
}

// ---- a near-closed gate does NOT reopen when a fresh ball reaches the gateway -----
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  const g = w.goals.blue;
  w.robots[0].pos = { x: 0, y: -30 }; // robot nowhere near the gate
  // one ball sitting right in the gateway window
  const b = w.balls[0];
  b.state = { kind: 'rail', goal: 'blue', s: 0, v: 0, overflow: false };
  b.pos = railPos('blue', 0);
  b.vel = { x: 0, y: 0 };
  // arm caught almost shut (below the pass fraction) with a little downward swing
  g.gatePos = 0.25;
  g.gateVel = -1;
  g.gateLatch = 0;
  g.gateOpen = false;
  run(w, cmd({}), 0.5);
  check(
    'a ball reaching an almost-closed gate does not reopen it',
    g.gatePos === 0 && !g.gateOpen,
    `gatePos ${g.gatePos.toFixed(3)}`,
  );
}

// fill the blue rail with 9 retained balls by direct placement (bypasses
// scoring — counters stay 0)
function fillBlueRail(w: World): void {
  for (let i = 0; i < 9; i++) {
    const b = w.balls[i];
    const s = GATE_STOP_S + i * RAIL_PITCH;
    b.state = { kind: 'rail', goal: 'blue', s, v: 0, overflow: false };
    b.pos = railPos('blue', s);
    b.vel = { x: 0, y: 0 };
    b.z = RAMP_SURFACE_Z;
    b.vz = 0;
  }
}

// drop a 10th ball into the blue basin right at the funnel entrance
function queueTenth(w: World): void {
  const tenth = w.balls[9];
  tenth.state = { kind: 'basin', goal: 'blue' };
  tenth.pos = basinFunnelTarget('blue');
  tenth.vel = { x: 0, y: 0 };
  tenth.z = BASIN_FLOOR_Z;
  tenth.vz = 0;
}

// ---- overflow decided at contact: full column + closed gate ---------------------
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  fillBlueRail(w);
  queueTenth(w);
  run(w, cmd({}), 3);
  const g = w.goals.blue;
  check(
    '10th ball meeting a full column overflows (1 pt)',
    g.overflowCount === 1 && g.classifiedCount === 0 && w.match.scores.blue.autoOverflow === 1,
    `classified=${g.classifiedCount} overflow=${g.overflowCount}`,
  );
  check('overflow ball rode over the closed gate and exited', w.balls[9].state.kind === 'ground');
}

// ---- overflow decided at contact: gate cleared in time -> classified -------------
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  fillBlueRail(w);
  // tap the gate, drive away — the column starts draining
  const r = w.robots[0];
  const zone = gateZone('blue');
  r.pos = { x: zone.x1 + 7, y: (zone.y0 + zone.y1) / 2 };
  r.heading = Math.PI; // face the -x (blue) wall
  r.fieldCentric = false;
  r.vel = { x: 0, y: 0 };
  run(w, cmd({ driveY: 1 }), 0.3); // tap: push opens the gate...
  r.pos = { x: 0, y: -30 };
  run(w, cmd({}), 0.7);
  // a late ball arrives while the drain is under way: by the time it reaches
  // the column there are fewer than 9 below it, so it must classify
  queueTenth(w);
  run(w, cmd({}), 5);
  const g = w.goals.blue;
  check(
    'ball arriving during a gate drain classifies (3 pts, not overflow)',
    g.overflowCount === 0 && g.classifiedCount === 1 && w.match.scores.blue.autoClassified === 3,
    `classified=${g.classifiedCount} overflow=${g.overflowCount} pts=${w.match.scores.blue.autoClassified}`,
  );
}

// ---- gate outflow stops against a parked robot instead of shoving it ------------
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  fillBlueRail(w);
  // robot parked square across the tunnel exit path (as when intaking the drain)
  const r = w.robots[0];
  r.pos = { x: -63, y: -14 };
  r.heading = Math.PI / 2; // front (intake) faces the oncoming flow
  r.vel = { x: 0, y: 0 };
  const start = { x: r.pos.x, y: r.pos.y };
  w.goals.blue.gatePos = 1; // arm lifted open; flow keeps it up while balls stream out
  w.goals.blue.gateOpen = true;
  run(w, cmd({}), 4);
  const moved = Math.hypot(r.pos.x - start.x, r.pos.y - start.y);
  const strays = w.balls.filter(
    (b) => b.state.kind === 'ground' && Math.abs(b.pos.x) > FIELD_HALF - BALL_RADIUS + 0.01,
  ).length;
  check('gate outflow cannot shove the parked robot', moved < 1.5, `moved ${moved.toFixed(2)} in`);
  check('blocked outflow stays in the field', strays === 0, `${strays} out of bounds`);
}

// ---- point-blank shots never miss ------------------------------------------------
{
  const w = mkWorld('match', 'blue', 11);
  startMatch(w);
  const r = w.robots[0];
  r.pos = { x: -44, y: 54 }; // right up against the blue goal face
  r.vel = { x: 0, y: 0 };
  run(w, cmd({ fire: true }), 0.5);
  run(w, cmd({}), 6);
  const g = w.goals.blue;
  check('point-blank shots all enter the goal', g.classifiedCount + g.overflowCount === 3, `entered=${g.classifiedCount + g.overflowCount}`);

  const w2 = mkWorld('match', 'blue', 12);
  startMatch(w2);
  const r2 = w2.robots[0];
  r2.pos = { x: 30, y: 35 }; // long cross-court shot
  run(w2, cmd({ fire: true }), 0.5);
  run(w2, cmd({}), 6);
  const g2 = w2.goals.blue;
  check('long shots all enter the goal', g2.classifiedCount + g2.overflowCount === 3, `entered=${g2.classifiedCount + g2.overflowCount}`);
}

// ---- auto intake & auto fire ----------------------------------------------------
{
  const w = mkWorld('free', 'blue', 5);
  const r = w.robots[0];
  r.hopper = [];
  w.balls = w.balls.filter((b) => b.state.kind !== 'held'); // clear physical preloads too
  r.autoIntake = true;
  r.autoFire = true;
  // drive up the blue spike column with no buttons held
  r.pos = { x: 46, y: -55 };
  r.heading = Math.PI / 2;
  r.fieldCentric = false;
  run(w, cmd({ driveY: 0.5 }), 2.5);
  run(w, cmd({}), 6);
  const g = w.goals.blue;
  check('auto intake collected without holding intake', r.hopper.length > 0 || g.classifiedCount + g.overflowCount > 0);
  check('auto fire launched without pressing fire', g.classifiedCount + g.overflowCount >= 1, `entered=${g.classifiedCount + g.overflowCount}`);
}

// ---- auto fire must NOT fire before the match starts ------------------------------
{
  const w = mkWorld('match', 'blue', 13);
  w.robots[0].autoFire = true;
  run(w, cmd({}), 2); // still in 'pre'
  check('auto fire holds until AUTO begins', w.robots[0].hopper.length === 3, `hopper=${w.robots[0].hopper.length}`);
  startMatch(w);
  run(w, cmd({}), 2);
  check('auto fire engages once AUTO starts', w.robots[0].hopper.length === 0, `hopper=${w.robots[0].hopper.length}`);
}

// ---- match flow ---------------------------------------------------------------
{
  const w = mkWorld('match', 'blue', 9);
  startMatch(w);
  run(w, cmd({ driveY: 0.5 }), 25);
  // park clearly off every launch line before the end-of-auto assessment
  w.robots[0].pos = { x: 0, y: -20 };
  w.robots[0].vel = { x: 0, y: 0 };
  w.robots[0].heading = 0;
  run(w, cmd({}), 6);
  check('auto -> transition after 30s', w.match.phase === 'transition', w.match.phase);
  run(w, cmd({}), 8.1);
  check('transition -> teleop after 8s', w.match.phase === 'teleop', w.match.phase);
  run(w, cmd({}), 120.2);
  check('teleop -> post after 2:00', w.match.phase === 'post', w.match.phase);
  check('leave scored (drove off launch lines)', w.match.scores.blue.leave === 3, `${w.match.scores.blue.leave}`);
}

// ---- Rule A: artifacts assessed BEFORE teleop (incl. the post-auto transition
// settle) count as AUTO, not TELEOP -------------------------------------------------
{
  const w = mkWorld('match', 'blue', 7);
  w.match.phase = 'transition';
  addClassified(w, 'blue');
  addOverflow(w, 'blue');
  check(
    'artifact scored during transition banks as AUTO, not TELEOP (Rule A)',
    w.match.scores.blue.autoClassified === 3 &&
      w.match.scores.blue.autoOverflow === 1 &&
      w.match.scores.blue.teleClassified === 0 &&
      w.match.scores.blue.teleOverflow === 0,
    `autoC=${w.match.scores.blue.autoClassified} autoO=${w.match.scores.blue.autoOverflow} teleC=${w.match.scores.blue.teleClassified}`,
  );
}

// ---- Rules C/D/F: resting-position scores (TELEOP PATTERN / DEPOT / BASE) are
// RE-ASSESSED through the post-match settle window, not frozen on the buzzer tick ---
{
  const spec = { length: 11.5, width: 12, intake: 'vector' as const };
  const w = mkWorld('match', 'blue', 8, spec);
  const zone = baseZone('blue');
  const cx = (zone.x0 + zone.x1) / 2;
  const cy = (zone.y0 + zone.y1) / 2;
  // enter 'post' with the robot AWAY from its base, as if the buzzer caught it out
  w.robots[0].pos = { x: 0, y: 0 };
  w.match.phase = 'post';
  w.match.phaseTimeLeft = 0;
  assessMatchEnd(w); // buzzer snapshot: no base credit yet
  check('base not yet earned at the buzzer', w.match.scores.blue.base === 0, `base=${w.match.scores.blue.base}`);
  // the robot comes to rest inside its base during the settle window
  w.robots[0].pos = { x: cx, y: cy };
  w.robots[0].heading = 0;
  w.robots[0].vel = { x: 0, y: 0 };
  run(w, cmd({}), 0.1); // post-phase ticks -> stepMatch recomputes assessMatchEnd
  check(
    'BASE re-assessed as the robot settles in the post window (Rules C/D/F)',
    w.match.scores.blue.base === 10,
    `base=${w.match.scores.blue.base}`,
  );
}

// ---- base parking counts wheels on the ground, not intake overhang --------------
{
  const spec = { length: 11.5, width: 12, intake: 'vector' as const };
  const zone = baseZone('blue');
  const cx = (zone.x0 + zone.x1) / 2;
  const cy = (zone.y0 + zone.y1) / 2;

  // all four wheels inside, wide/long intake hanging out over the edge -> FULL
  const w1 = mkWorld('free', 'blue', 14, spec);
  w1.robots[0].pos = { x: cx, y: cy };
  w1.robots[0].heading = Math.PI / 2; // intake pokes out the top of the base
  assessMatchEnd(w1);
  check(
    'base FULL credit with intake overhanging (wheels all in)',
    w1.match.scores.blue.base === 10,
    `base=${w1.match.scores.blue.base}`,
  );

  // only the intake reaches into the base, wheels outside -> NO credit
  const w2 = mkWorld('free', 'blue', 14, spec);
  w2.robots[0].pos = { x: cx, y: zone.y1 + 11 };
  w2.robots[0].heading = -Math.PI / 2; // intake dips into the zone from above
  assessMatchEnd(w2);
  check(
    'intake-only overhang earns no base credit (no wheel touching)',
    w2.match.scores.blue.base === 0,
    `base=${w2.match.scores.blue.base}`,
  );

  // just ONE wheel in (parked over the inner corner) -> PARTIAL
  const w3 = mkWorld('free', 'blue', 14, spec);
  w3.robots[0].pos = { x: zone.x0, y: zone.y1 }; // one wheel dips over the corner
  w3.robots[0].heading = Math.PI / 2;
  const wheelsIn = wheelContacts(w3.robots[0]).filter((c) => inRect(c, zone)).length;
  assessMatchEnd(w3);
  check(
    'a single wheel in the base earns partial credit',
    wheelsIn === 1 && w3.match.scores.blue.base === 5,
    `wheelsIn=${wheelsIn} base=${w3.match.scores.blue.base}`,
  );
}

// ---- control bindings: validation / merge of persisted settings -----------------
{
  const clean = mergeBindings(null);
  check(
    'mergeBindings(null) yields the defaults',
    JSON.stringify(clean) === JSON.stringify(DEFAULT_BINDINGS),
  );
  const merged = mergeBindings({
    keys: { fire: ['j'], driveUp: 42, restart: ['escape'] }, // driveUp/restart invalid
    pad: { driveStick: 'right', buttons: { fire: [2], intake: 'nope' } },
  });
  check(
    'mergeBindings keeps valid overrides and repairs invalid ones',
    merged.keys.fire[0] === 'j' &&
      merged.keys.driveUp[0] === 'w' &&
      merged.keys.restart[0] === 'r' &&
      merged.pad.driveStick === 'right' &&
      merged.pad.buttons.fire[0] === 2 &&
      merged.pad.buttons.intake[0] === 6,
    JSON.stringify({ fire: merged.keys.fire, up: merged.keys.driveUp, stick: merged.pad.driveStick }),
  );
}

// ============================================================================
// Phase B: RobotSpec v2 — drivetrains, flywheel model, robot-robot physics,
// multi-robot spawn / determinism
// ============================================================================

const setup = (
  id: number,
  alliance: 'red' | 'blue',
  spec: Partial<RobotSpec>,
  startIndex = 0,
): RobotSetup => ({
  id,
  alliance,
  spec: { ...DEFAULT_SPEC, ...spec },
  assists: { ...DEFAULT_ASSISTS },
  startIndex,
});

// ---- drivetrain calibration: derived from real 104mm-wheel geometry ---------
{
  // BASE speed derives from the 104 mm wheel free-speed geometry × DRIVE_EFFICIENCY;
  // the ref 26lb / 435rpm chassis lands ~75/7/280 at mult=1 (× the per-drivetrain
  // mult). Check against the FORMULA (not a magic 75) so it survives wheel/efficiency
  // edits, plus a realistic-band assertion.
  const refFree = SPEED_PER_RPM * REF_DRIVE_RPM; // loaded top speed of the ideal traction datum
  check('104mm-wheel derived ref speed is a realistic FTC drive (~6–8 ft/s)', refFree > 72 && refFree < 96, `${refFree.toFixed(2)} in/s = ${(refFree / 12).toFixed(1)} ft/s`);
  check('SPEED_PER_RPM = π·wheel/60 · efficiency', Math.abs(SPEED_PER_RPM - (Math.PI * (WHEEL_DIAMETER_MM / 25.4)) / 60 * DRIVE_EFFICIENCY) < 1e-9);
  const CALIB_REF: RobotSpec = {
    ...DEFAULT_SPEC, length: 15, width: 18, intake: 'sloped',
    massLb: 26, drivetrain: 'mecanum', driveRpm: 435, flywheelInertia: 0.5,
  };
  const dp = driveParams(CALIB_REF);
  const M = DRIVETRAIN_PRESETS.mecanum; // maxSpeed/turn scale with speedMult, accel with accelMult
  check(
    'base calibration ref: refFree in/s, 8.5 rad/s, base accel (× mecanum mult)',
    Math.abs(dp.maxSpeed - refFree * M.speedMult) < 1e-6 &&
      Math.abs(dp.maxTurn - 8.5 * M.speedMult * M.turnMult) < 1e-6 &&
      Math.abs(dp.accel - BASE_DRIVE_ACCEL * M.accelMult) < 1e-6,
    `${dp.maxSpeed.toFixed(2)} / ${dp.maxTurn.toFixed(2)} / ${dp.accel.toFixed(1)}`,
  );
}

// ---- top speed scales linearly with wheel RPM -------------------------------
{
  const slow = driveParams({ ...DEFAULT_SPEC, driveRpm: 300 });
  const fast = driveParams({ ...DEFAULT_SPEC, driveRpm: 600 });
  check(
    'top speed scales linearly with RPM',
    Math.abs(fast.maxSpeed / slow.maxSpeed - 2) < 1e-6,
    `${slow.maxSpeed.toFixed(1)} -> ${fast.maxSpeed.toFixed(1)}`,
  );
}

// ---- tank drivetrain has no strafe ------------------------------------------
{
  const w = mkWorld('free', 'blue', 7, { drivetrain: 'tank' });
  const r = w.robots[0];
  r.pos = { x: 0, y: 0 };
  r.heading = Math.PI / 2;
  r.fieldCentric = false;
  run(w, cmd({ driveX: 1 }), 0.8); // pure strafe command
  check('tank drivetrain cannot strafe', Math.hypot(r.pos.x, r.pos.y) < 0.5, `moved ${Math.hypot(r.pos.x, r.pos.y).toFixed(2)} in`);
}

// ---- no DIAGONAL-SPEED bug: moving diagonally is never FASTER than straight -----
// The classic 2D pitfall: stepping fwd + strafe INDEPENDENTLY lets the velocity vector
// accelerate at √2·accel on a diagonal. Top speed is capped fine, but the ACCEL PHASE covers
// more ground diagonally — so this must be measured by DISPLACEMENT from rest, not peak speed.
// `motorStepVec` caps the accel budget in vector magnitude, so diagonal ≤ straight everywhere.
{
  const disp = (drivetrain: DrivetrainType, c: RobotCommand): number => {
    const w = mkWorld('free', 'blue', 3, { drivetrain });
    const r = w.robots[0];
    r.pos = { x: 0, y: 0 };
    r.heading = 0;
    r.fieldCentric = false;
    for (let i = 0; i < 30; i++) step(w, SIM_DT, new Map([[r.id, c]])); // 0.5 s from rest
    return Math.hypot(r.pos.x, r.pos.y);
  };
  for (const dt of ['mecanum', 'swerve', 'xdrive'] as DrivetrainType[]) {
    const straight = disp(dt, cmd({ driveY: 1 })); // forward
    const diag = disp(dt, cmd({ driveX: 1, driveY: 1 })); // forward + strafe
    const ratio = diag / straight;
    // diagonal must never travel farther than straight in the same time (+ a hair of ε).
    check(
      `${dt} drive: diagonal is not faster than straight (no √2 bug)`,
      ratio <= 1.02,
      `0.5s disp straight=${straight.toFixed(1)} diagonal=${diag.toFixed(1)} ratio=${ratio.toFixed(3)}`,
    );
  }
}

// ---- mass-weighted shove: the heavier robot yields less ---------------------
{
  const w = createWorld('free', 7, [setup(0, 'blue', { massLb: 42 }, 0), setup(1, 'blue', { massLb: 21 }, 1)]);
  const [a, b] = w.robots;
  a.pos = { x: -5, y: 0 }; a.heading = 0; a.vel = { x: 0, y: 0 };
  b.pos = { x: 5, y: 0 }; b.heading = 0; b.vel = { x: 0, y: 0 };
  const a0 = { ...a.pos };
  const b0 = { ...b.pos };
  step(w, SIM_DT, new Map());
  const da = Math.hypot(a.pos.x - a0.x, a.pos.y - a0.y);
  const db = Math.hypot(b.pos.x - b0.x, b.pos.y - b0.y);
  check('heavier robot yields less (42 vs 21 lb ≈ 1:2 push)', Math.abs(db / da - 2) < 0.15, `da=${da.toFixed(2)} db=${db.toFixed(2)}`);
}

// ---- equal masses separate symmetrically ------------------------------------
{
  const w = createWorld('free', 7, [setup(0, 'blue', { massLb: 30 }, 0), setup(1, 'blue', { massLb: 30 }, 1)]);
  const [a, b] = w.robots;
  a.pos = { x: -5, y: 0 }; a.heading = 0; a.vel = { x: 0, y: 0 };
  b.pos = { x: 5, y: 0 }; b.heading = 0; b.vel = { x: 0, y: 0 };
  const a0 = { ...a.pos };
  const b0 = { ...b.pos };
  step(w, SIM_DT, new Map());
  const da = Math.hypot(a.pos.x - a0.x, a.pos.y - a0.y);
  const db = Math.hypot(b.pos.x - b0.x, b.pos.y - b0.y);
  check('equal-mass robots separate symmetrically', Math.abs(da - db) < 0.05, `da=${da.toFixed(2)} db=${db.toFixed(2)}`);
}

// ---- every bundled preset obeys its drivetrain's clamps ---------------------
{
  let ok = true;
  const bad: string[] = [];
  for (const p of ROBOT_PRESETS) {
    const mass = massLimits(p.drivetrain, p.flywheelInertia);
    const rpm = rpmLimits(p.drivetrain);
    if (p.massLb < mass.min || p.massLb > mass.max || p.driveRpm < rpm.min || p.driveRpm > rpm.max) {
      ok = false;
      bad.push(`${p.name}(${p.massLb}lb/${p.driveRpm}rpm want mass[${mass.min},${mass.max}] rpm[${rpm.min},${rpm.max}])`);
    }
  }
  check('all ROBOT_PRESETS satisfy their drivetrain mass/rpm clamps (incl. inertia floor)', ok, bad.join(' '));
}

// ---- accel ordering: tank > swerve > mecanum > xdrive -----------------------
{
  const a = (dt: RobotSpec['drivetrain']) => driveParams({ ...DEFAULT_SPEC, drivetrain: dt }).accel;
  const t = a('tank'), s = a('swerve'), me = a('mecanum'), x = a('xdrive');
  check(
    'drivetrain accel order tank > swerve > mecanum > xdrive',
    t > s && s > me && me > x,
    `${t.toFixed(0)}/${s.toFixed(0)}/${me.toFixed(0)}/${x.toFixed(0)}`,
  );
}

// ---- MECANUM ROLLER DIRECTIONS (a render-geometry check, not a cosmetic one) ----
// A mecanum wheel's rollers sit at 45°, and the four wheels must ALTERNATE by diagonal
// (FL/BR one way, FR/BL the other) so their lateral force components ADD instead of
// cancelling — that alternation is literally what makes strafing possible, so a sprite
// with all four the same depicts a robot that could not strafe. Verified by running the
// real `drawWheels` against a recording stub and reading back the stroked segments.
{
  const probeRollers = (drivetrain: RobotSpec['drivetrain'], butterflyTank = false) => {
    let tx = 0;
    let ty = 0;
    const stack: [number, number][] = [];
    const segs: { cx: number; cy: number; dx: number; dy: number }[] = [];
    let cur: [number, number] | null = null;
    const ctx = {
      save() { stack.push([tx, ty]); },
      restore() { const p = stack.pop()!; tx = p[0]; ty = p[1]; },
      translate(x: number, y: number) { tx += x; ty += y; },
      rotate() {}, fillRect() {}, strokeRect() {}, fill() {}, clip() {}, rect() {}, arc() {},
      // `arcTo` is the rounded-rect corner (roundRect); it never emits a 45 degree segment,
      // so recording it as a no-op keeps the probe reading only the roller hatch it is after
      arcTo() {}, closePath() {},
      beginPath() { cur = null; },
      moveTo(x: number, y: number) { cur = [x, y]; },
      lineTo(x: number, y: number) { if (cur) segs.push({ cx: tx, cy: ty, dx: x - cur[0], dy: y - cur[1] }); },
      stroke() {},
      set fillStyle(_v: unknown) {}, set strokeStyle(_v: unknown) {}, set lineWidth(_v: unknown) {},
    } as unknown as CanvasRenderingContext2D;
    const r = {
      spec: { ...DEFAULT_SPEC, drivetrain, length: 16, width: 17 },
      moduleAngles: [0, 0, 0, 0],
      butterflyTank,
    } as unknown as World['robots'][number];
    drawWheels(ctx, r, '#fff');
    const byWheel = new Map<string, number>();
    for (const g of segs) {
      if (Math.abs(Math.abs(g.dx) - Math.abs(g.dy)) > 1e-9 || g.dx === 0) continue; // 45° only
      byWheel.set(`${g.cx.toFixed(2)},${g.cy.toFixed(2)}`, Math.sign(g.dy / g.dx));
    }
    return byWheel;
  };

  const mec = probeRollers('mecanum');
  const slope = (x: number, y: number) => mec.get(`${x.toFixed(2)},${y.toFixed(2)}`);
  // wheel centres are (±(len/2−inset), ±(wid/2−inset)) = (±5.40, ±5.90) for 16×17
  const FL = slope(5.4, 5.9);
  const FR = slope(5.4, -5.9);
  const BL = slope(-5.4, 5.9);
  const BR = slope(-5.4, -5.9);
  check('mecanum: all four wheels carry 45° roller hatching', mec.size === 4, `${mec.size} wheels`);
  check(
    'mecanum: rollers form an X — FL/BR share one diagonal, FR/BL the other',
    FL !== undefined && FL === BR && FR !== undefined && FR === BL && FL === -FR,
    `FL ${FL} FR ${FR} BL ${BL} BR ${BR}`,
  );
  // the deployed set decides: a butterfly on mecanum shows the same X, on traction none
  const bMec = probeRollers('butterfly', false);
  const bTank = probeRollers('butterfly', true);
  check(
    'butterfly: rollers follow the DEPLOYED set (mecanum X down, none on traction)',
    bMec.size === 4 &&
      bMec.get('5.40,5.90') === FL &&
      bMec.get('5.40,-5.90') === FR &&
      bTank.size === 0,
    `mecMode ${bMec.size} tankMode ${bTank.size}`,
  );
  // traction drivetrains must never draw rollers — they don't have any
  check('tank: traction wheels draw no rollers', probeRollers('tank').size === 0);
}

// ---- BUTTERFLY: two wheel sets, one chassis --------------------------------
{
  const bfly = (tankRpm?: number): RobotSpec =>
    coerceSpec({ ...DEFAULT_SPEC, drivetrain: 'butterfly', driveRpm: 500, tankRpm, massLb: 30 });
  const spec = bfly(500);
  const mec = driveParams(spec, false);
  const tnk = driveParams(spec, true);

  // the swap is REAL: it changes the saturation model, so strafe exists in one half and
  // is structurally dead in the other (that IS the tradeoff, not a stat tweak)
  check(
    'butterfly: mecanum half strafes holonomically, tank half has no strafe at all',
    mec.saturation === 'sum' && mec.strafeMult > 0 && tnk.saturation === 'tank' && tnk.strafeMult === 0,
    `mec ${mec.saturation}/${mec.strafeMult} tank ${tnk.saturation}/${tnk.strafeMult}`,
  );
  // tank half out-accels and out-pushes; mecanum half is the manoeuvrable one
  check(
    'butterfly: dropping traction buys accel + push over its own mecanum half',
    tnk.accel > mec.accel && BUTTERFLY_MODES.tank.pushMult > BUTTERFLY_MODES.mecanum.pushMult * 1.5,
    `accel ${mec.accel.toFixed(0)}→${tnk.accel.toFixed(0)} push ${BUTTERFLY_MODES.mecanum.pushMult}→${BUTTERFLY_MODES.tank.pushMult}`,
  );
  // THE EFFICIENCY TAX: each half is strictly worse than the dedicated drivetrain it
  // imitates — you pay a few percent everywhere for the right to change your mind
  const M = DRIVETRAIN_PRESETS.mecanum;
  const T = DRIVETRAIN_PRESETS.tank;
  check(
    'butterfly: each half is strictly worse than the dedicated drivetrain (speed/accel/push)',
    BUTTERFLY_MODES.mecanum.speedMult < M.speedMult &&
      BUTTERFLY_MODES.mecanum.accelMult < M.accelMult &&
      BUTTERFLY_MODES.mecanum.pushMult < M.pushMult &&
      BUTTERFLY_MODES.tank.speedMult < T.speedMult &&
      BUTTERFLY_MODES.tank.accelMult < T.accelMult &&
      BUTTERFLY_MODES.tank.pushMult < T.pushMult,
  );
  // ...but the tax is SMALL — within 10% — or the drivetrain would be a trap pick
  const tax = (a: number, b: number) => 1 - a / b;
  check(
    'butterfly: the tax stays inside 10% on every axis (a real option, not a trap)',
    [
      tax(BUTTERFLY_MODES.mecanum.speedMult, M.speedMult),
      tax(BUTTERFLY_MODES.mecanum.accelMult, M.accelMult),
      tax(BUTTERFLY_MODES.mecanum.pushMult, M.pushMult),
      tax(BUTTERFLY_MODES.tank.speedMult, T.speedMult),
      tax(BUTTERFLY_MODES.tank.accelMult, T.accelMult),
      tax(BUTTERFLY_MODES.tank.pushMult, T.pushMult),
    ].every((t) => t > 0 && t < 0.1),
  );
  // WEIGHT is the headline cost: it hauls both sets, so it starts heavier than anything
  check(
    'butterfly: the heaviest mass floor of any drivetrain (it carries both sets)',
    massLimits('butterfly', 0).min > massLimits('tank', 0).min &&
      massLimits('butterfly', 0).min > massLimits('swerve', 0).min &&
      massLimits('butterfly', 0).min > massLimits('mecanum', 0).min,
    `bfly ${massLimits('butterfly', 0).min} tank ${massLimits('tank', 0).min} swerve ${massLimits('swerve', 0).min}`,
  );
  // TWO GEARINGS: the traction slider is its own value on its own (lower) ceiling
  check(
    'butterfly: the traction set has its own rpm slider + a lower ceiling than the mecanum set',
    butterflyTankRpmLimits().max < rpmLimits('butterfly').max &&
      driveParams(bfly(300), true).maxSpeed < driveParams(bfly(560), true).maxSpeed,
  );
  // each half reads ITS OWN slider — changing traction rpm must not move mecanum-mode speed
  const slow = bfly(200);
  const fast = bfly(560);
  check(
    'butterfly: each half reads its own rpm (traction gearing never moves mecanum-mode speed)',
    Math.abs(driveParams(slow, false).maxSpeed - driveParams(fast, false).maxSpeed) < 1e-9 &&
      driveParams(fast, true).maxSpeed > driveParams(slow, true).maxSpeed + 5,
  );
  // coerceSpec owns the second slider: clamped for butterfly, STRIPPED otherwise
  const over = coerceSpec({ ...DEFAULT_SPEC, drivetrain: 'butterfly', tankRpm: 9999 });
  const away = coerceSpec({ ...over, drivetrain: 'mecanum' });
  check(
    'butterfly: coerceSpec clamps tankRpm, and strips it when the drivetrain changes',
    over.tankRpm === butterflyTankRpmLimits().max && away.tankRpm === undefined,
    `clamped ${over.tankRpm} stripped ${String(away.tankRpm)}`,
  );

  // ---- the SWAP itself, driven through a real world ----
  const w = createWorld('free', 42, [
    { id: 0, alliance: 'blue', spec: coerceSpec({ ...DEFAULT_SPEC, drivetrain: 'butterfly' }), assists: DEFAULT_ASSISTS, startIndex: 0 },
  ]);
  const rb = w.robots[0];
  check('butterfly: spawns on the mecanum set', rb.butterflyTank === false);
  const press = (down: boolean) => step(w, SIM_DT, new Map([[0, { ...cmd({}), driveMode: down }]]));
  press(true);
  check('butterfly: a press drops the traction set', rb.butterflyTank === true);
  press(true);
  press(true);
  check('butterfly: HOLDING does not keep swapping (edge-triggered)', rb.butterflyTank === true);
  press(false);
  press(true);
  check('butterfly: releasing and pressing again swaps back', rb.butterflyTank === false);
  // a non-butterfly must ignore the command entirely
  const w2 = createWorld('free', 42, [
    { id: 0, alliance: 'blue', spec: coerceSpec({ ...DEFAULT_SPEC, drivetrain: 'mecanum' }), assists: DEFAULT_ASSISTS, startIndex: 0 },
  ]);
  step(w2, SIM_DT, new Map([[0, { ...cmd({}), driveMode: true }]]));
  check('butterfly: every other drivetrain ignores the swap command', w2.robots[0].butterflyTank === false);
}

// ---- 2026-07 real-motor retune: mecanum has losses, tank tops speed ----------
{
  const sp = (dt: RobotSpec['drivetrain']) => driveParams({ ...DEFAULT_SPEC, drivetrain: dt }).maxSpeed;
  // realistic straight-line order: traction fastest; swerve and mecanum tie (gear loss ≈
  // roller scrub); X-drive far back (45° omnis waste speed off-axis).
  check('speed order tank > swerve = mecanum > xdrive', sp('tank') > sp('swerve') && Math.abs(sp('swerve') - sp('mecanum')) < 0.01 && sp('mecanum') > sp('xdrive'), `tank ${sp('tank').toFixed(1)} sw ${sp('swerve').toFixed(1)} mec ${sp('mecanum').toFixed(1)} x ${sp('xdrive').toFixed(1)}`);
  // xdrive is the clear worst — a wide margin below the pack on speed AND push
  check('xdrive is way worse (speed & push well below mecanum)', sp('xdrive') < sp('mecanum') - 8 && DRIVETRAIN_PRESETS.xdrive.pushMult < DRIVETRAIN_PRESETS.mecanum.pushMult - 0.2, `x ${sp('xdrive').toFixed(1)} vs mec ${sp('mecanum').toFixed(1)}`);
  // mecanum now sits BELOW the ideal base on every axis (roller slip + friction)
  const M = DRIVETRAIN_PRESETS.mecanum;
  // mecanum loses forward SPEED (roller scrub) and PUSH (shoved around); its accel is a
  // tuned feel value (raised so straights don't feel sluggish vs swerve) — not a "loss".
  check('mecanum loses speed & push (roller scrub / low traction)', M.speedMult < 1 && M.pushMult < 1);
  // pushing order: traction bites, rollers get shoved
  check('push order tank > swerve > mecanum > xdrive', DRIVETRAIN_PRESETS.tank.pushMult > DRIVETRAIN_PRESETS.swerve.pushMult && DRIVETRAIN_PRESETS.swerve.pushMult > M.pushMult && M.pushMult > DRIVETRAIN_PRESETS.xdrive.pushMult);
  // swerve VECTORS its wheels for rotation → the fastest turner (its signature),
  // even though tank has a higher straight-line speed. turnMult > 1 buys this.
  const tr = (dt: RobotSpec['drivetrain']) => driveParams({ ...DEFAULT_SPEC, drivetrain: dt }).maxTurn;
  check('swerve is the fastest turner (turnMult edge beats tank)', tr('swerve') > tr('tank') && tr('tank') > tr('mecanum') && tr('mecanum') > tr('xdrive'), `swerve ${tr('swerve').toFixed(2)} tank ${tr('tank').toFixed(2)} mec ${tr('mecanum').toFixed(2)} x ${tr('xdrive').toFixed(2)}`);

  // print the tuning table (visible on every run so a balance edit shows its effect)
  const rows = driveSummary().map((r) => `${r.dt.padEnd(7)} fwd ${r.fwd.toFixed(1).padStart(5)}  strafe ${r.strafe.toFixed(1).padStart(5)}  accel ${r.accel.toFixed(0).padStart(4)}  push ${r.push.toFixed(2)}`);
  console.log('  drivetrain @435rpm/26lb:\n    ' + rows.join('\n    '));
}

// ---- motor torque–speed curve: accel eases off near top speed ----------------
{
  const ref = { ...DEFAULT_SPEC, drivetrain: 'tank' as const, driveRpm: 435, massLb: 26 };
  const dp = driveParams(ref);
  const aStall = dp.accel;
  // off the line = full stall accel; near free speed = a small fraction
  const aStart = (motorStep(0, dp.maxSpeed, aStall, dp.maxSpeed, SIM_DT) - 0) / SIM_DT;
  const aNearTop = (motorStep(dp.maxSpeed * 0.98, dp.maxSpeed, aStall, dp.maxSpeed, SIM_DT) - dp.maxSpeed * 0.98) / SIM_DT;
  check('motor accel is full stall off the line', Math.abs(aStart - aStall) < 1e-6, `${aStart.toFixed(1)} vs ${aStall.toFixed(1)}`);
  check('motor accel falls off near free speed (torque curve)', aNearTop < aStall * 0.2, `${aNearTop.toFixed(1)}`);
  // braking pulls harder than peak drive accel
  const aBrake = (dp.maxSpeed - motorStep(dp.maxSpeed, 0, aStall, dp.maxSpeed, SIM_DT)) / SIM_DT;
  check('motor braking is stronger than stall accel', aBrake > aStall, `${aBrake.toFixed(1)} vs ${aStall.toFixed(1)}`);
  // integrate: reaches ~95% of free speed in a realistic ~0.6–1.0 s (not instant)
  let v = 0;
  let t95 = 0;
  for (let i = 0; i < 300; i++) {
    v = motorStep(v, dp.maxSpeed, aStall, dp.maxSpeed, SIM_DT);
    if (v >= dp.maxSpeed * 0.95) { t95 = (i + 1) * SIM_DT; break; }
  }
  check('reaches 95% top speed in a realistic ~0.5–1.2 s', t95 > 0.5 && t95 < 1.2, `${t95.toFixed(2)} s`);
}

// ---- swerve = 4 independent steered modules (kinematics + pod flip + wobble) --
{
  const strafe = { driveX: 1, driveY: 0, rotate: 0, buttons: {}, leftDrive: 0, rightDrive: 0 } as unknown as RobotCommand;
  const w = createWorld('free', 3, [setup(0, 'blue', { drivetrain: 'swerve' }, 0)]);
  const r = w.robots[0];
  r.fieldCentric = false;
  r.moduleAngles = [0, 0, 0, 0];
  step(w, SIM_DT, new Map([[0, strafe]]));
  // 90° command (no flip): each pod turns toward -90° but is slew-limited after 1 tick
  check('swerve pods steer (not instant) toward a 90° command', r.moduleAngles.every((a) => a < -0.01 && a > -Math.PI / 2 + 0.5), `${r.moduleAngles.map((a) => a.toFixed(2)).join(',')} after 1 tick`);
  for (let i = 0; i < 40; i++) step(w, SIM_DT, new Map([[0, strafe]]));
  check('all four pods reach the commanded direction (~-90° ± wobble)', r.moduleAngles.every((a) => Math.abs(a - -Math.PI / 2) < 0.3), `${r.moduleAngles.map((a) => a.toFixed(2)).join(',')}`);
  const mec = createWorld('free', 3, [setup(0, 'blue', { drivetrain: 'mecanum' }, 0)]).robots[0];
  check('only swerve uses moduleAngles (mecanum stays [0,0,0,0])', mec.moduleAngles.every((a) => a === 0));

  // swerve draws steady STEERING current (pivot motors) just running — mecanum doesn't
  const swIdle = createWorld('free', 3, [setup(0, 'blue', { drivetrain: 'swerve', flywheelInertia: 0 }, 0)]);
  step(swIdle, SIM_DT, new Map());
  const mecIdle = createWorld('free', 3, [setup(0, 'blue', { drivetrain: 'mecanum', flywheelInertia: 0 }, 0)]);
  step(mecIdle, SIM_DT, new Map());
  check('swerve pulls steady steering power (mecanum does not)', swIdle.robots[0].powerDraw >= POWER_DRAW_SWERVE - 1e-9 && mecIdle.robots[0].powerDraw < swIdle.robots[0].powerDraw, `swerve ${swIdle.robots[0].powerDraw.toFixed(3)} vs mecanum ${mecIdle.robots[0].powerDraw.toFixed(3)}`);

  // drive current rises with RPM: a higher-geared drivetrain pulls more from the pack
  const hiRpm = createWorld('free', 3, [setup(0, 'blue', { drivetrain: 'mecanum', flywheelInertia: 0, driveRpm: 600 }, 0)]);
  step(hiRpm, SIM_DT, new Map());
  const loRpm = createWorld('free', 3, [setup(0, 'blue', { drivetrain: 'mecanum', flywheelInertia: 0, driveRpm: 435 }, 0)]);
  step(loRpm, SIM_DT, new Map());
  check('higher-rpm drivetrain pulls more current', hiRpm.robots[0].powerDraw > loRpm.robots[0].powerDraw + 0.02, `600rpm ${hiRpm.robots[0].powerDraw.toFixed(3)} vs 435rpm ${loRpm.robots[0].powerDraw.toFixed(3)}`);

  // WOBBLE done right: driving straight, the four pods hunt INDEPENDENTLY (their
  // angles differ), producing BOTH a path drift AND a net YAW wobble (heading
  // oscillates). Mecanum holds a perfect line + heading.
  const w3 = createWorld('free', 3, [setup(0, 'blue', { drivetrain: 'swerve' }, 0)]);
  const r3 = w3.robots[0];
  r3.fieldCentric = false;
  r3.pos = { x: 0, y: -40 };
  r3.heading = Math.PI / 2; // face +y, drive straight up the field
  const fwd1 = { driveX: 0, driveY: 1, rotate: 0, buttons: {}, leftDrive: 0, rightDrive: 0 } as unknown as RobotCommand;
  for (let i = 0; i < 40; i++) step(w3, SIM_DT, new Map([[0, fwd1]])); // build speed
  let podSpread = 0;
  let lateral = 0;
  let headingDev = 0;
  for (let i = 0; i < 100; i++) {
    step(w3, SIM_DT, new Map([[0, fwd1]]));
    podSpread = Math.max(podSpread, Math.max(...r3.moduleAngles) - Math.min(...r3.moduleAngles));
    lateral = Math.max(lateral, Math.abs(r3.pos.x)); // drift off the straight-up line
    headingDev = Math.max(headingDev, Math.abs(r3.heading - Math.PI / 2));
  }
  check('swerve pods hunt INDEPENDENTLY (angles differ) driving straight', podSpread > 0.01, `spread ${podSpread.toFixed(3)} rad`);
  check('swerve DRIFTS off a straight line (path wobble)', lateral > 0.02, `${lateral.toFixed(2)} in`);
  check('swerve HEADING wobbles from mispointed pods (yaw)', headingDev > 0.001, `${(headingDev * 180 / Math.PI).toFixed(2)}°`);
  // control loops are ALWAYS applied: releasing the stick, the disturbance fades
  // with speed and every pod shares the target → they CONVERGE to one angle at rest
  for (let i = 0; i < 200; i++) step(w3, SIM_DT, new Map()); // coast to a stop, no command
  const rest = Math.max(...r3.moduleAngles) - Math.min(...r3.moduleAngles);
  check('swerve pods CONVERGE to one angle when stopped (no frozen mis-alignment)', rest < 1e-4, `spread ${rest.toExponential(1)} rad, speed ${Math.hypot(r3.vel.x, r3.vel.y).toFixed(2)}`);

  // releasing the stick HOLDS the last driven direction, NOT forward: strafe (pods
  // → -90°), then coast to a stop → the pods stay pointing ~-90°, converged.
  const wh = createWorld('free', 3, [setup(0, 'blue', { drivetrain: 'swerve' }, 0)]);
  const rh = wh.robots[0];
  rh.fieldCentric = false;
  rh.pos = { x: 0, y: 0 };
  rh.heading = 0;
  for (let i = 0; i < 60; i++) step(wh, SIM_DT, new Map([[0, strafe]])); // steer pods to -90 + drive
  for (let i = 0; i < 260; i++) step(wh, SIM_DT, new Map()); // release + coast to a stop
  const held = rh.moduleAngles;
  check('swerve HOLDS the last driven direction at rest (not snapping forward)', Math.abs(held[0] - -Math.PI / 2) < 0.1 && Math.max(...held) - Math.min(...held) < 1e-4, `${held.map((a) => a.toFixed(2)).join(',')}`);

  // a BRIEF TAP still commits the target: tap strafe for a few ticks (pods only
  // start turning), let go → they FINISH slewing to the commanded ~-90°, not freeze.
  const wt = createWorld('free', 3, [setup(0, 'blue', { drivetrain: 'swerve' }, 0)]);
  const rt = wt.robots[0];
  rt.fieldCentric = false;
  rt.pos = { x: 0, y: 0 };
  rt.heading = 0;
  for (let i = 0; i < 3; i++) step(wt, SIM_DT, new Map([[0, strafe]])); // brief tap right
  const partway = rt.moduleAngles[0]; // only partly turned toward -90 after 3 ticks
  for (let i = 0; i < 40; i++) step(wt, SIM_DT, new Map()); // let go → pods keep going to target
  check('swerve finishes turning to the tapped target after release (not frozen partway)', partway > -Math.PI / 2 + 0.3 && Math.abs(rt.moduleAngles[0] - -Math.PI / 2) < 0.1, `partway ${partway.toFixed(2)} → ${rt.moduleAngles[0].toFixed(2)}`);

  const w4 = createWorld('free', 3, [setup(0, 'blue', { drivetrain: 'mecanum' }, 0)]);
  const r4 = w4.robots[0];
  r4.fieldCentric = false;
  r4.pos = { x: 0, y: -40 };
  r4.heading = Math.PI / 2;
  for (let i = 0; i < 140; i++) step(w4, SIM_DT, new Map([[0, fwd1]]));
  check('mecanum holds a perfect line + heading (no wobble)', Math.abs(r4.pos.x) < 1e-6 && Math.abs(r4.heading - Math.PI / 2) < 1e-6, `x=${r4.pos.x.toFixed(3)}`);

  // MODULE OPTIMIZATION (pod flip): a 180° reversal must NOT rotate the pods —
  // it flips each drive motor instead, so the pods stay put and the robot reverses.
  const w2 = createWorld('free', 3, [setup(0, 'blue', { drivetrain: 'swerve' }, 0)]);
  const r2 = w2.robots[0];
  r2.fieldCentric = false;
  r2.moduleAngles = [0, 0, 0, 0];
  r2.pos = { x: 0, y: 0 };
  r2.heading = 0;
  const back = { driveX: 0, driveY: -1, rotate: 0, buttons: {}, leftDrive: 0, rightDrive: 0 } as unknown as RobotCommand;
  for (let i = 0; i < 25; i++) step(w2, SIM_DT, new Map([[0, back]]));
  const fwd = r2.vel.x * Math.cos(r2.heading) + r2.vel.y * Math.sin(r2.heading);
  check('swerve pod-flips a 180° reversal (pods stay, no big rotation)', r2.moduleAngles.every((a) => Math.abs(a) < 0.35), `${r2.moduleAngles.map((a) => a.toFixed(2)).join(',')}`);
  check('swerve reversal drives BACKWARD via flipped motors', fwd < -5, `${fwd.toFixed(1)} in/s fwd`);
}

// ---- tank reads side-drive only (control STYLE resolved at the input layer) --
{
  // The sim's tank branch must drive from leftDrive/rightDrive alone — the
  // Traditional-vs-Normal preference is converted to side-drive in GameController,
  // so the same command behaves identically regardless of any world setting.
  const w = createWorld('free', 5, [setup(0, 'blue', { drivetrain: 'tank' }, 0)]);
  const r = w.robots[0];
  r.fieldCentric = false;
  r.pos = { x: 0, y: -40 }; r.heading = Math.PI / 2;
  const side = { driveX: 0, driveY: 0, rotate: 0, buttons: {}, leftDrive: 1, rightDrive: 1 } as unknown as RobotCommand;
  for (let i = 0; i < 30; i++) step(w, SIM_DT, new Map([[0, side]]));
  const fwdSpeed = r.vel.x * Math.cos(r.heading) + r.vel.y * Math.sin(r.heading);
  check('tank drives from leftDrive/rightDrive (side-drive command)', fwdSpeed > 20, `${fwdSpeed.toFixed(1)} in/s fwd`);
  // arcade driveY/rotate on their own do NOT move a tank robot in the sim (the
  // Normal-tank conversion into side-drive happens BEFORE the command reaches step)
  const w2 = createWorld('free', 5, [setup(0, 'blue', { drivetrain: 'tank' }, 0)]);
  const r2 = w2.robots[0];
  r2.fieldCentric = false;
  r2.pos = { x: 0, y: -40 }; r2.heading = Math.PI / 2;
  const arcade = { driveX: 0, driveY: 1, rotate: 0, buttons: {}, leftDrive: 0, rightDrive: 0 } as unknown as RobotCommand;
  for (let i = 0; i < 30; i++) step(w2, SIM_DT, new Map([[0, arcade]]));
  check('tank ignores raw arcade driveY (no side-drive ⇒ no motion)', Math.hypot(r2.vel.x, r2.vel.y) < 1e-6, `speed ${Math.hypot(r2.vel.x, r2.vel.y).toExponential(1)}`);
}

// ---- pushing power: equal-mass tank out-pushes mecanum ----------------------
{
  const w = createWorld('free', 7, [
    setup(0, 'blue', { massLb: 30, drivetrain: 'mecanum' }, 0),
    setup(1, 'blue', { massLb: 30, drivetrain: 'tank' }, 1),
  ]);
  const [a, b] = w.robots;
  a.pos = { x: -5, y: 0 }; a.heading = 0; a.vel = { x: 0, y: 0 };
  b.pos = { x: 5, y: 0 }; b.heading = 0; b.vel = { x: 0, y: 0 };
  const a0 = { ...a.pos }, b0 = { ...b.pos };
  step(w, SIM_DT, new Map());
  const da = Math.hypot(a.pos.x - a0.x, a.pos.y - a0.y);
  const db = Math.hypot(b.pos.x - b0.x, b.pos.y - b0.y);
  check('equal-mass tank out-pushes mecanum (mecanum yields more)', da > db * 1.2, `mecanum ${da.toFixed(2)} vs tank ${db.toFixed(2)}`);
}

// ---- pushing power: a geared-for-speed (high RPM) robot pushes weaker --------
{
  const w = createWorld('free', 7, [
    setup(0, 'blue', { massLb: 30, drivetrain: 'mecanum', driveRpm: 600 }, 0),
    setup(1, 'blue', { massLb: 30, drivetrain: 'mecanum', driveRpm: 300 }, 1),
  ]);
  const [a, b] = w.robots;
  a.pos = { x: -5, y: 0 }; a.heading = 0; a.vel = { x: 0, y: 0 };
  b.pos = { x: 5, y: 0 }; b.heading = 0; b.vel = { x: 0, y: 0 };
  const a0 = { ...a.pos }, b0 = { ...b.pos };
  step(w, SIM_DT, new Map());
  const da = Math.hypot(a.pos.x - a0.x, a.pos.y - a0.y);
  const db = Math.hypot(b.pos.x - b0.x, b.pos.y - b0.y);
  check('geared-for-speed (600 rpm) robot yields more than a torquey (300 rpm) one', da > db * 1.2, `600rpm ${da.toFixed(2)} vs 300rpm ${db.toFixed(2)}`);
}

// ---- power draw: a spun-up flywheel is slightly slower far from goal ---------
{
  const measure = (inertia: number) => {
    const w = mkWorld('free', 'blue', 9, { flywheelInertia: inertia });
    const r = w.robots[0];
    // far from the blue goal + heading +x so driving forward keeps distance high
    r.pos = { x: 0, y: -60 }; r.heading = 0; r.vel = { x: 0, y: 0 }; r.fieldCentric = false;
    run(w, cmd({ driveY: 1 }), 0.7);
    return Math.hypot(r.vel.x, r.vel.y);
  };
  const v0 = measure(0), v1 = measure(1);
  const ratio = v1 / v0;
  check('power draw: spun-up flywheel is ~10% slower far from goal', ratio > 0.8 && ratio < 0.97, `inertia1 ${v1.toFixed(1)} vs inertia0 ${v0.toFixed(1)} (${(ratio * 100).toFixed(0)}%)`);
  check(
    'power draw leaves driveParams calibration byte-identical',
    driveParams({ ...DEFAULT_SPEC, flywheelInertia: 1 }).maxSpeed ===
      driveParams({ ...DEFAULT_SPEC, flywheelInertia: 0 }).maxSpeed,
  );
}

// ---- per-drivetrain clamps + inertia→mass-floor coupling --------------------
{
  check('massLimits mecanum floor is 18 at inertia 0', massLimits('mecanum', 0).min === 18);
  check('massLimits mecanum floor climbs to 22 at inertia 1', massLimits('mecanum', 1).min === 22);
  check('massLimits swerve floor is 21.5 at inertia 0', massLimits('swerve', 0).min === 21.5);
  check('inertia only nudges the floor (≤ 4 lb across the whole range)', massLimits('mecanum', 1).min - massLimits('mecanum', 0).min <= 4);
  check('rpmLimits swerve caps at 500', rpmLimits('swerve').max === 500);
  // swerve keeps its raw-accel edge even at the WORST case for it: a min-weight,
  // MAX-inertia, 500rpm build out-accels the equivalent mecanum (massLb 0 → the
  // per-drivetrain×inertia floor). Its higher accelMult (1.32) beats its heavier floor.
  {
    const accelOf = (drivetrain: 'swerve' | 'mecanum') =>
      driveParams(coerceSpec({ drivetrain, driveRpm: 500, flywheelInertia: 1, massLb: 0 })).accel;
    const sw = accelOf('swerve'), me = accelOf('mecanum');
    check('swerve out-accels a 500rpm max-inertia min-weight mecanum', sw > me, `swerve ${sw.toFixed(1)} vs mecanum ${me.toFixed(1)}`);
  }
  const s = coerceSettings({
    spec: { drivetrain: 'swerve', massLb: 18, driveRpm: 600, flywheelInertia: 0.8 },
  });
  const floor = massLimits('swerve', 0.8).min; // 21.5 + 4·0.8 = 24.7
  check('coerceSettings clamps swerve mass up to the inertia-coupled floor', Math.abs(s.spec.massLb - floor) < 1e-9, `${s.spec.massLb} vs ${floor}`);
  check('coerceSettings clamps swerve rpm down to 500', s.spec.driveRpm === 500, `${s.spec.driveRpm}`);
}

// ---- saved robot / auto libraries are validated + capped ---------------------
{
  const validAuto = (name: string) => ({
    fileName: name,
    startPoint: { x: 0, y: 0, heading: 'constant', degrees: 0 },
    lines: [],
    sequence: [],
  });
  const lib = coerceSettings({
    savedRobots: Array.from({ length: 6 }, () => ({ drivetrain: 'mecanum' })),
    savedAutos: [validAuto('a'), null, { bogus: true }, validAuto('b'), validAuto('c'), validAuto('d'), validAuto('e')],
  });
  check('savedRobots capped at MAX_SAVED_ROBOTS', lib.savedRobots.length === 3, `${lib.savedRobots.length}`);
  check('each saved robot is coerced to a legal spec', lib.savedRobots.every((r) => r.driveRpm >= 200 && r.massLb >= 10));
  check('savedAutos drops invalid entries + caps at MAX_SAVED_AUTOS', lib.savedAutos.length === 4, `${lib.savedAutos.length}`);
  check('defaultSettings starts with empty libraries', coerceSettings({}).savedRobots.length === 0 && coerceSettings({}).savedAutos.length === 0);
}

// ---- audio volumes: migration off the legacy booleans + the old-client mirrors -
// Settings sync per ACCOUNT and one account is shared across client versions, so
// the two legacy switches have to keep meaning what they meant — a mute set on a
// new build must not come back un-muted on an old tab or an old Electron install.
{
  const legacyOff = coerceSettings({ audio: { sounds: false, voice: true } });
  check('legacy sounds:false migrates to master 0', legacyOff.audio.volume.master === 0, `${legacyOff.audio.volume.master}`);
  const legacyNoVoice = coerceSettings({ audio: { sounds: true, voice: false } });
  check('legacy voice:false migrates to voice 0, master untouched', legacyNoVoice.audio.volume.voice === 0 && legacyNoVoice.audio.volume.master === 1);

  const junk = coerceSettings({ audio: { volume: { master: 9, game: -3, shoot: 'x', voice: NaN } } });
  check('volumes clamp to 0–1 and non-numbers fall back', junk.audio.volume.master === 1 && junk.audio.volume.game === 0 && junk.audio.volume.shoot === 1 && junk.audio.volume.voice === 1, JSON.stringify(junk.audio.volume));

  // `sfx` was ONE level driving the shooter, intake, gate and countdown beep. It is
  // now four, and a save from before the split must keep the player's choice on all
  // four rather than silently resetting three of them to full.
  const oldSfx = coerceSettings({ audio: { volume: { master: 1, game: 1, sfx: 0.2, voice: 1 } } });
  const v = oldSfx.audio.volume;
  check(
    'legacy sfx level migrates onto ALL four emitters it used to drive',
    v.shoot === 0.2 && v.intake === 0.2 && v.gate === 0.2 && v.beep === 0.2,
    JSON.stringify(v),
  );
  // ...but an explicit new key wins over the legacy seed
  const mixed = coerceSettings({ audio: { volume: { sfx: 0.2, shoot: 0.9 } } });
  check(
    'an explicit per-emitter level overrides the migrated sfx value',
    mixed.audio.volume.shoot === 0.9 && mixed.audio.volume.gate === 0.2,
    JSON.stringify(mixed.audio.volume),
  );

  const muted = coerceSettings({ audio: { volume: { master: 0, game: 1, shoot: 1, voice: 1 } } });
  check('master 0 derives BOTH legacy mirrors false', !muted.audio.sounds && !muted.audio.voice);
  const voiceOff = coerceSettings({ audio: { volume: { master: 1, game: 1, shoot: 1, voice: 0 } } });
  check('voice 0 derives voice mirror false, sounds true', voiceOff.audio.sounds && !voiceOff.audio.voice);
  // every emitter silent but voice on: `sounds` still true (voice IS sound)
  const onlyVoice = coerceSettings({
    audio: { volume: { master: 1, game: 0, shoot: 0, intake: 0, gate: 0, beep: 0, voice: 1 } },
  });
  check('sounds mirror stays true when only voice is audible', onlyVoice.audio.sounds);

  // ---- ranked queue counts shown across the menus ------------------------
  // The RULE is "omit a mode at zero, show nothing when nothing is queued" — a
  // visible "0 waiting" reads as a verdict on whether to bother rather than as the
  // absence of news. It is logic, not styling, so it is tested rather than eyeballed.
  {
    const pres = (a: number, b: number) =>
      ({ online: 0, signedIn: 0, queues: { '1v1': a, '2v2': b } }) as never;
    const j = (v: unknown) => JSON.stringify(v);
    check('queue counts: both modes busy → both listed', j(queuedModes(pres(2, 3))) === j(['1v1', '2v2']));
    check('queue counts: a mode at 0 is OMITTED', j(queuedModes(pres(2, 0))) === j(['1v1']));
    check('queue counts: the other way round too', j(queuedModes(pres(0, 4))) === j(['2v2']));
    check('queue counts: nothing queued → nothing rendered', queuedModes(pres(0, 0)).length === 0);
    check('queue counts: no presence yet → nothing rendered', queuedModes(null).length === 0);
    check('queue counts: a junk count is not shown as a number', queuedModes({ queues: { '1v1': NaN, '2v2': undefined } } as never).length === 0);
    check('queue counts: anyoneQueued mirrors it', anyoneQueued(pres(0, 1)) && !anyoneQueued(pres(0, 0)));

    // ---- PER-GAME depth --------------------------------------------------
    // The matchmaker buckets by game, so a combined count told a DECODE player that
    // a Chain Reaction queuer was waiting FOR THEM — a number they could act on and
    // never match from, printed next to the button whose whole job is to get them to
    // act on it. Depth is per game now, everywhere it is shown.
    const gp = (decode: [number, number], chain: [number, number]) =>
      ({
        online: 0,
        signedIn: 0,
        queues: { '1v1': decode[0] + chain[0], '2v2': decode[1] + chain[1] },
        gameQueues: {
          decode: { '1v1': decode[0], '2v2': decode[1] },
          chain: { '1v1': chain[0], '2v2': chain[1] },
        },
      }) as never;

    check('per-game: DECODE reads its OWN 1v1 depth, not the combined one',
      queuesFor(gp([1, 0], [5, 0]), 'decode')?.['1v1'] === 1);
    check('per-game: ...and Chain Reaction reads its own',
      queuesFor(gp([1, 0], [5, 0]), 'chain')?.['1v1'] === 5);
    check('per-game: a game with an empty queue lists NO modes',
      queuedModes(gp([0, 0], [3, 0]), 'decode').length === 0);
    check('per-game: ...while the busy one still does',
      j(queuedModes(gp([0, 0], [3, 0]), 'chain')) === j(['1v1']));
    check('per-game: an unknown game reads as empty, never as the combined total',
      queuesFor(gp([1, 1], [1, 1]), 'nope' as never)?.['1v1'] === 0);

    // the TOP BAR lists every game that has somebody waiting, each labelled — and
    // omits a game with an empty queue ENTIRELY, name included
    const games = ['decode', 'chain'] as const;
    const both = queuedGames(gp([1, 3], [2, 0]), games);
    check('top bar: every busy game is listed', j(both.map((g) => g.game)) === j(['decode', 'chain']));
    check('top bar: with each of its non-empty modes',
      j(both[0].modes) === j([{ mode: '1v1', n: 1 }, { mode: '2v2', n: 3 }]));
    check('top bar: a mode at 0 is dropped from a busy game',
      j(both[1].modes) === j([{ mode: '1v1', n: 2 }]));
    const oneGame = queuedGames(gp([0, 0], [2, 0]), games);
    check('top bar: a game with NOTHING queued is omitted entirely (no label)',
      oneGame.length === 1 && oneGame[0].game === 'chain');
    check('top bar: nobody queued anywhere → nothing at all',
      queuedGames(gp([0, 0], [0, 0]), games).length === 0);

    // OLDER SERVER (no gameQueues): fall back to the combined total rather than
    // rendering nothing. It is the pre-fix number, but it is the only one such a
    // server can give, and a rollout window should not blank the count.
    check('per-game: an old server without gameQueues still yields a count',
      queuesFor(pres(2, 0), 'decode')?.['1v1'] === 2);
    check('per-game: ...and the labelled top-bar form shows nothing rather than guessing',
      queuedGames(pres(2, 0), games).length === 0);

    // EXPAND SEARCH used to call the server and change nothing on screen, so it read
    // as a dead button. These are the strings that now have to move when it is pressed.
    check('expand: the button says so after a press', expandLabel(0) === 'EXPAND SEARCH' && expandLabel(2) === 'EXPANDED ×2');
    check('expand: a press changes the hint immediately, at any elapsed time',
      widenHint(1, 0) !== widenHint(0, 0) && widenHint(1, 0) === widenHint(1, 99));
    check('expand: with no presses the hint still follows the automatic ramp',
      widenHint(0, 0) !== widenHint(0, 4) && widenHint(0, 4) !== widenHint(0, 20));
    // it must never claim to be searching "your region" — the queue opens wide
    // enough for a same-continent match on the first attempt (see RADIUS_BASE_MS)
    check('expand: the ramp reaches "worldwide", and never says region-only',
      widenHint(0, 20).includes('worldwide') && ![0, 4, 20].some((s) => widenHint(0, s).includes('your region')));
    check('expand: a manual press outranks the automatic line',
      widenHint(3, 99).includes('3×'));
  }

  // ---- background ranked queue: the keeper store -------------------------
  // The store is what makes a queue survive leaving the screen, so its contract is
  // worth pinning: parking makes it visible, taking hands it back exactly once, a
  // late assignment is remembered rather than lost, and cancel really cancels.
  {
    let disposed = 0, left = 0;
    const fakeLobby = () => ({ dispose: () => disposed++, leaveQueue: () => left++ }) as never;
    const mk = (over: Partial<Parameters<typeof parkQueue>[0]> = {}) => ({
      lobby: fakeLobby(), mode: '1v1' as const, game: 'decode' as const, challenge: null,
      since: 1000, size: 1, need: 2,
      assignedRoom: null, start: null, strategy: null, found: false, error: null, ...over,
    });

    // THE GAME TRAVELS WITH THE SEARCH. Parking exists so the player can go and do
    // something else, and "something else" can be the OTHER game — which moves
    // `settings.game`. A queue that does not remember its own game gets adopted as
    // whatever the player wandered into: queue Chain Reaction, start a DECODE run,
    // and the match-found takeover came up as DECODE for a CR match. The parked
    // search is the authority, not the live setting.
    check('queue keeper: nothing parked to begin with', peekQueue() === null);
    parkQueue(mk({ game: 'chain' }));
    check('queue keeper: a search remembers WHICH GAME it queued for', peekQueue()?.game === 'chain');
    check(
      'queue keeper: ...and still carries it after an unrelated update',
      (updateQueue({ size: 3 }), peekQueue()?.game === 'chain'),
    );
    check('queue keeper: ...and hands it back on adopt', takeQueue()?.game === 'chain');
    check('queue keeper: DECODE searches carry their own game too', (parkQueue(mk()), peekQueue()?.game === 'decode'));
    takeQueue();

    let seen = 0;
    const un = subscribeQueue(() => seen++);
    parkQueue(mk());
    check('queue keeper: parking makes the search visible', peekQueue()?.mode === '1v1');
    check('queue keeper: ...and notifies subscribers', seen === 1, `seen=${seen}`);

    const beforeUpdate = peekQueue();
    updateQueue({ size: 2 });
    check('queue keeper: an update lands on the parked search', peekQueue()?.size === 2);
    // REFERENCE must change: useSyncExternalStore compares snapshots by identity, so
    // an in-place mutation notifies subscribers who then re-read the same object and
    // skip the render — which is exactly how the match-found takeover silently
    // failed the first time this was written
    check('queue keeper: an update yields a NEW snapshot, not a mutated one', peekQueue() !== beforeUpdate);
    check('queue keeper: ...and notified again', seen === 2, `seen=${seen}`);

    // an assignment that arrives while parked must be REMEMBERED — its event has
    // already fired and will not fire again for the screen that adopts the socket
    updateQueue({ assignedRoom: 'iad-abc', found: true });
    check('queue keeper: a late assignment is remembered', peekQueue()?.assignedRoom === 'iad-abc');

    // The SAME applies to the two signals that carry a whole match with them. On
    // the single-region / no-DB path the match runs on the matchmaker socket
    // itself, so `matchStart` / `strategyStart` arrive here rather than an
    // assignment — and they were being recorded as a bare `found: true` with the
    // payload dropped. Nothing can reconstruct it: the event is gone, so the
    // adopting screen sat on "Finding a match…" for a match already in progress.
    updateQueue({ start: { seed: 7, setups: [], yourRobotId: 1 } as never });
    check('queue keeper: a late matchStart keeps its PAYLOAD, not just the fact', peekQueue()?.start?.seed === 7);
    updateQueue({
      strategy: { deadline: 42, yourRobotId: 0, mode: '1v1', intros: [], players: [], myClientId: 'c1' },
    });
    check('queue keeper: a late strategyStart keeps its deadline', peekQueue()?.strategy?.deadline === 42);

    const taken = takeQueue();
    check('queue keeper: taking hands back the same search', taken?.assignedRoom === 'iad-abc');
    check('queue keeper: ...and only once', takeQueue() === null);
    check('queue keeper: taking does NOT close the socket (the screen adopts it)', disposed === 0);

    parkQueue(mk());
    dropQueue();
    check('queue keeper: cancelling leaves the queue AND closes the socket', left === 1 && disposed === 1);
    check('queue keeper: ...and clears it', peekQueue() === null);
    updateQueue({ size: 9 });
    check('queue keeper: updating nothing is a no-op, not a crash', peekQueue() === null);
    un();
  }

  {
    check('queue keeper: elapsed formats as m:ss', elapsedLabel(0, 67_000) === '1:07', elapsedLabel(0, 67_000));
    check('queue keeper: ...pads the seconds', elapsedLabel(0, 65_000) === '1:05');
    check('queue keeper: ...and never goes negative on a clock skew', elapsedLabel(5_000, 0) === '0:00');

    // THE STOPWATCH IS A FUNCTION OF `since`, never a counter started on mount.
    // The search screen used to count up from when IT appeared, so adopting a
    // parked queue restarted a wait the player had genuinely been sitting through.
    check('queue keeper: elapsed is measured from the search START', elapsedSeconds(1_000, 96_000) === 95);
    check('queue keeper: ...so adopting mid-search reports the real wait, not 0', elapsedSeconds(1_000, 96_000) > 0);
    check('queue keeper: ...and a clock that runs backwards floors at 0', elapsedSeconds(96_000, 1_000) === 0);
  }

  // A CHALLENGE travels with the parked search, same as its game. Leaving the
  // screen while waiting on a named opponent must not quietly turn a private
  // challenge into an ordinary open-queue entry on the way back in.
  {
    const ch = {
      token: 'TMFX2K', format: 'rated1v1', mode: '1v1' as const,
      partyOnly: true, game: 'chain' as const, opponent: 'bob',
    };
    parkQueue({
      lobby: {} as never, mode: '1v1', game: 'chain', challenge: ch, since: 1, size: 1, need: 2,
      assignedRoom: null, start: null, strategy: null, found: false, error: null,
    });
    check('queue keeper: a parked search remembers its CHALLENGE', peekQueue()?.challenge?.opponent === 'bob');
    const back = takeQueue();
    check('queue keeper: ...and hands the token back on adopt', back?.challenge?.token === 'TMFX2K');
    check('queue keeper: ...with the challenge’s own game', back?.challenge?.game === 'chain');
  }

  // the match-found alert is its own level: it plays while you are deliberately NOT
  // looking at the game, so it must not be tied to the in-match effects
  check('match alert has its own volume, defaulting on', coerceSettings({}).audio.volume.alert === 1);
  check(
    'match alert level survives a round trip',
    coerceSettings({ audio: { volume: { alert: 0.4 } } }).audio.volume.alert === 0.4,
  );
  check(
    'silencing every effect but the alert still reads as "sounds on"',
    coerceSettings({
      audio: { volume: { master: 1, game: 0, shoot: 0, intake: 0, gate: 0, beep: 0, alert: 1, voice: 0 } },
    }).audio.sounds === true,
  );

  check('in-match event log defaults ON', coerceSettings({}).showEventLog === true);
  check('...and the toggle persists', coerceSettings({ showEventLog: false }).showEventLog === false);

  // a slider drag writes the live object straight to storage, bypassing coerce
  const d = coerceSettings({});
  const edited = { ...d, audio: { ...d.audio, volume: { ...d.audio.volume, master: 0 } } };
  check('syncAudioMirrors re-derives mirrors after a raw edit', !syncAudioMirrors(edited).audio.sounds);
  check('syncAudioMirrors is a no-op when already in step', syncAudioMirrors(d) === d);

  // the round trip that matters: mute on a new build → an OLD client saves (it
  // drops `volume` entirely) → back on a new build. Levels are lost; silence is not.
  const asOldClientSavedIt = { audio: { sounds: false, voice: false } };
  check('mute survives a round trip through an old client', coerceSettings(asOldClientSavedIt).audio.volume.master === 0);
}

// ---- untrusted spec sanitization (anti-cheat: spoofed devtools / wire spec) --
{
  // an attacker sends an absurd oversized robot: coerceSpec must clamp EVERY axis
  const evil = coerceSpec({
    intake: 'sloped',
    length: 999,
    width: 999,
    massLb: 9999,
    driveRpm: 99999,
    flywheelInertia: 50,
    teamNumber: 1e12,
    name: 'x'.repeat(500),
    drivetrain: 'mecanum',
  });
  check('coerceSpec clamps length to the preset max', evil.length <= INTAKE_PRESETS.sloped.maxLength, `${evil.length}`);
  check('coerceSpec clamps width to ROBOT_MAX_SIZE', evil.width <= ROBOT_MAX_SIZE, `${evil.width}`);
  check('coerceSpec clamps mass to the drivetrain max', evil.massLb <= massLimits('mecanum', 1).max, `${evil.massLb}`);
  check('coerceSpec clamps rpm to the drivetrain max', evil.driveRpm <= rpmLimits('mecanum').max, `${evil.driveRpm}`);
  check('coerceSpec clamps inertia to 1', evil.flywheelInertia === 1, `${evil.flywheelInertia}`);
  check('coerceSpec clamps teamNumber to 99999', evil.teamNumber === 99999, `${evil.teamNumber}`);
  check('coerceSpec truncates an over-long name', evil.name.length <= 24, `${evil.name.length}`);

  // NaN / Infinity injected via devtools must NOT slip through (bare clamp lets
  // NaN pass — the whole reason coerceSpec guards finiteness)
  const nan = coerceSpec({ length: NaN, width: Infinity, massLb: NaN, driveRpm: -Infinity, flywheelInertia: NaN });
  check('coerceSpec rejects NaN length (finite fallback)', Number.isFinite(nan.length), `${nan.length}`);
  check('coerceSpec rejects Infinity width', Number.isFinite(nan.width) && nan.width <= ROBOT_MAX_SIZE, `${nan.width}`);
  check('coerceSpec rejects NaN mass', Number.isFinite(nan.massLb), `${nan.massLb}`);
  check('coerceSpec rejects -Infinity rpm', Number.isFinite(nan.driveRpm) && nan.driveRpm >= rpmLimits('mecanum').min, `${nan.driveRpm}`);

  // BELOW-minimum values are clamped UP just as strictly as over-max is clamped down
  const tiny = coerceSpec({
    intake: 'sloped', drivetrain: 'mecanum', flywheelInertia: 0.5,
    length: -5, width: 0, massLb: 1, driveRpm: 1,
  });
  check('coerceSpec clamps length UP to the preset min', tiny.length >= INTAKE_PRESETS.sloped.minLength, `${tiny.length}`);
  check('coerceSpec clamps width UP to ROBOT_MIN_WIDTH', tiny.width >= ROBOT_MIN_WIDTH, `${tiny.width}`);
  // swerve needs a wider base — its width floors at SWERVE_MIN_WIDTH, above the others
  // isolate the drivetrain floor with a VECTOR intake (its own width floor is the
  // lowest — ROBOT_MIN_WIDTH — so it doesn't mask the drivetrain floor)
  const swWide = coerceSpec({ drivetrain: 'swerve', intake: 'vector', width: 10 });
  check('coerceSpec clamps swerve width UP to SWERVE_MIN_WIDTH', swWide.width === SWERVE_MIN_WIDTH, `${swWide.width}`);
  check('non-swerve vector width floor stays ROBOT_MIN_WIDTH', coerceSpec({ drivetrain: 'mecanum', intake: 'vector', width: 10 }).width === ROBOT_MIN_WIDTH);
  // per-INTAKE width floors: the funnel presets need a wider frame than vector
  check('widthLimits sloped floors at 14.5', widthLimits('sloped', 'mecanum').min === 14.5, `${widthLimits('sloped', 'mecanum').min}`);
  check('widthLimits triangle floors at 15.5', widthLimits('triangle', 'mecanum').min === 15.5, `${widthLimits('triangle', 'mecanum').min}`);
  // the floor is the MAX of the intake + drivetrain floors
  check('widthLimits takes the MAX of intake + drivetrain floor', widthLimits('triangle', 'swerve').min === 15.5 && widthLimits('vector', 'swerve').min === SWERVE_MIN_WIDTH);
  check('coerceSpec clamps a sloped robot UP to the intake width floor', coerceSpec({ intake: 'sloped', width: 10 }).width === 14.5, `${coerceSpec({ intake: 'sloped', width: 10 }).width}`);
  check('coerceSpec clamps mass UP to the drivetrain×inertia floor', tiny.massLb >= massLimits('mecanum', 0.5).min, `${tiny.massLb}`);
  check('coerceSpec clamps rpm UP to the drivetrain min', tiny.driveRpm >= rpmLimits('mecanum').min, `${tiny.driveRpm}`);
  check('coerceSpec clamps a NEGATIVE inertia to 0', coerceSpec({ flywheelInertia: -3 }).flywheelInertia === 0);
  // the mass floor tracks inertia: max inertia demands a heavier minimum than min inertia
  check('mass floor rises with inertia', massLimits('mecanum', 1).min > massLimits('mecanum', 0).min);
  // ORDER matters: an out-of-range inertia is clamped to 1 FIRST, so the mass floor
  // is then computed from the CLAMPED inertia (not the raw 9) — mass is pulled up to
  // the inertia-1 floor. This is the dependency chain the builder UI also follows.
  const ord = coerceSpec({ drivetrain: 'mecanum', flywheelInertia: 9, massLb: 18 });
  check('mass range uses the CLAMPED inertia (intake→drivetrain→inertia→mass order)',
    ord.flywheelInertia === 1 && ord.massLb >= massLimits('mecanum', 1).min, `${ord.massLb} @ i=${ord.flywheelInertia}`);

  // garbage / missing input falls back to a fully-legal default spec
  const junk = coerceSpec(undefined);
  check('coerceSpec(undefined) returns a legal default', junk.length === DEFAULT_SPEC.length && junk.width === DEFAULT_SPEC.width);

  // the ULTIMATE chokepoint: createWorld sanitizes every setup, so even a raw
  // spoofed setup can never spawn an oversized robot in the actual world
  const setups: RobotSetup[] = [{
    id: 0,
    alliance: 'blue',
    spec: { ...DEFAULT_SPEC, length: 999, width: 999, massLb: 9999 },
    assists: { ...DEFAULT_ASSISTS },
    startIndex: 99,
  }];
  const w = createWorld('match', 1, setups);
  const rspec = w.robots[0].spec;
  check('createWorld sanitizes a spoofed setup spec (length)', rspec.length <= INTAKE_PRESETS[rspec.intake].maxLength, `${rspec.length}`);
  check('createWorld sanitizes a spoofed setup spec (width)', rspec.width <= ROBOT_MAX_SIZE, `${rspec.width}`);
  check('createWorld clamps an out-of-range startIndex (no crash, robot spawned)', w.robots.length === 1);

  // server ingress: a spoofed join / update patch is clamped before it hits the roster
  const player = sanitizePlayer({ name: 'A', alliance: 'blue', spec: { length: 999, width: 999 }, assists: {} });
  check('sanitizePlayer clamps a spoofed join spec', player.spec.width <= ROBOT_MAX_SIZE && player.spec.length <= INTAKE_PRESETS[player.spec.intake].maxLength);
  const patched = sanitizePlayerPatch({ spec: { width: 999, massLb: 9999 } }, { ...player, clientId: 'x' });
  check('sanitizePlayerPatch clamps a spoofed spec patch', (patched.spec?.width ?? 0) <= ROBOT_MAX_SIZE, `${patched.spec?.width}`);
  check('sanitizePlayerPatch ignores unknown/absent fields (empty patch is a no-op)', Object.keys(sanitizePlayerPatch({ bogus: 1 }, { ...player, clientId: 'x' })).length === 0);

  // 2v2 start-ROLE swap fields survive server sanitization (the server passes them
  // through so the consent handshake can propagate over the roster)
  const rolePlayer = sanitizePlayer({ name: 'R', alliance: 'red', spec: {}, assists: {}, startRole: 'far', swapReq: true });
  check('sanitizePlayer passes a valid startRole + swapReq', rolePlayer.startRole === 'far' && rolePlayer.swapReq === true);
  check('sanitizePlayer rejects a bogus startRole', sanitizePlayer({ name: 'R', spec: {}, assists: {}, startRole: 'middle' }).startRole === undefined);
  const rolePatch = sanitizePlayerPatch({ startRole: 'close', swapReq: true }, { ...player, clientId: 'x' });
  check('sanitizePlayerPatch passes startRole + swapReq', rolePatch.startRole === 'close' && rolePatch.swapReq === true);

  // GAME-AWARE server clamp: Chain Reaction runs its own chassis length range
  // (CHAIN_MIN/MAX_LENGTH), wider than DECODE's per-intake range. The server must
  // clamp with the ROOM's game, or a record-run/ranked CR robot gets silently
  // resized to a DIFFERENT envelope than the config menu offered.
  // A length legal in CR (10) but BELOW the sloped-intake DECODE floor (13.5): the
  // chain-aware clamp keeps it; the game-less (DECODE) clamp would pull it up.
  const crShort = sanitizePlayer({ name: 'C', alliance: 'blue', spec: { length: CHAIN_MIN_LENGTH, intake: 'sloped' }, assists: {} }, 'chain');
  check('sanitizePlayer(chain) keeps a CR-legal short chassis', crShort.spec.length === CHAIN_MIN_LENGTH, `${crShort.spec.length}`);
  check('sanitizePlayer(chain) length matches config-menu range (not DECODE intake range)',
    crShort.spec.length < INTAKE_PRESETS.sloped.minLength, `${crShort.spec.length} vs decode min ${INTAKE_PRESETS.sloped.minLength}`);
  // and the CR ceiling (18) is honoured too — DECODE sloped maxes at 15
  // the CR cap is per-build now: the 18" start cube MINUS the mounted sweeper's reach
  const crLongCap = chainSizeLimits({ ...DEFAULT_SPEC, intake: 'sloped', intakeMount: 'front' }).maxLength;
  const crLong = sanitizePlayer({ name: 'C', alliance: 'blue', spec: { length: crLongCap, intake: 'sloped' }, assists: {} }, 'chain');
  check('sanitizePlayer(chain) keeps a CR-legal long chassis', crLong.spec.length === crLongCap, `${crLong.spec.length}`);
  // a spec patch takes the same game-aware clamp
  const crPatch = sanitizePlayerPatch({ spec: { length: CHAIN_MIN_LENGTH, intake: 'sloped' } }, { ...crShort, clientId: 'x' }, 'chain');
  check('sanitizePlayerPatch(chain) keeps a CR-legal short chassis', crPatch.spec?.length === CHAIN_MIN_LENGTH, `${crPatch.spec?.length}`);
  // WITHOUT the game arg the DECODE range still applies (regression guard both ways)
  const decodeClamp = sanitizePlayer({ name: 'D', alliance: 'blue', spec: { length: CHAIN_MIN_LENGTH, intake: 'sloped' }, assists: {} });
  check('sanitizePlayer(no game) still clamps to the DECODE intake range', decodeClamp.spec.length >= INTAKE_PRESETS.sloped.minLength, `${decodeClamp.spec.length}`);
}

// ---- vector intake: WHERE the ball enters decides the swallow time -----------
{
  // one ball at the mouth, capture cadence started (lastIntakeAt = now) so the
  // first swallow must wait the position-dependent interval
  const capTicks = (localY: number) => {
    const w = mkWorld('free', 'blue', 6, { length: 12, width: 14, intake: 'vector' });
    const r = w.robots[0];
    r.hopper = []; r.pos = { x: 0, y: 0 }; r.heading = Math.PI / 2; r.fieldCentric = false; r.vel = { x: 0, y: 0 };
    r.lastIntakeAt = w.time;
    const wheelLine = r.spec.length / 2 + INTAKE_PRESETS.vector.reach; // 6 + 3.5
    const b = w.balls[0]; w.balls.splice(1);
    b.state = { kind: 'ground' };
    // shallow contact just ahead of the face (placing dead-on the OBB face
    // triggers the deep-push eviction); at heading π/2 world = (−localY, localX)
    b.pos = { x: -localY, y: wheelLine + 2 }; b.vel = { x: 0, y: 0 }; b.z = 0; b.vz = 0;
    const commands = new Map([[0, cmd({ intake: true })]]);
    let ticks = 0;
    while (r.hopper.length === 0 && ticks < 120) { step(w, SIM_DT, commands); ticks++; }
    return ticks;
  };
  // width 14 → vector mouth half-width 7, so an edge entry sits at localY 6 (inside
  // the mouth); the vectoring travel to center makes it slower than a center entry
  const center = capTicks(0), edge = capTicks(6);
  check('vector intake swallows a CENTER ball faster than an EDGE ball', edge > center + 3, `center ${center}t vs edge ${edge}t`);
}

// ---- sloped: driving into an OFF-CENTER ball, the slopes funnel it to center ----
{
  const w = mkWorld('free', 'blue', 6, { intake: 'sloped' }); // default 18-wide chassis
  const r = w.robots[0];
  r.hopper = []; r.pos = { x: 0, y: -12 }; r.heading = Math.PI / 2; r.fieldCentric = false; r.vel = { x: 0, y: 0 };
  const b = w.balls[0]; w.balls.splice(1);
  b.state = { kind: 'ground' };
  // off-center ball ahead (on the slope path); only the physical slope + drive can
  // bring it to the center wheels — the edge of the intake can't grab it
  b.pos = { x: 4, y: -12 + r.spec.length / 2 + 4 }; b.vel = { x: 0, y: 0 }; b.z = 0; b.vz = 0;
  run(w, cmd({ driveY: 0.3, intake: true }), 1.3);
  check('sloped slopes funnel an off-center ball to the center wheels', r.hopper.length === 1, `hopper=${r.hopper.length}`);
}

// ---- triangle intake devours TWO from a clump per cycle ---------------------
{
  const w = mkWorld('free', 'blue', 6, { length: 12, width: 14, intake: 'triangle' });
  const r = w.robots[0];
  r.hopper = []; r.pos = { x: 0, y: 0 }; r.heading = Math.PI / 2; r.fieldCentric = false; r.vel = { x: 0, y: 0 };
  const throat = r.spec.length / 2 + BALL_RADIUS; // where the compliant wheels grab
  w.balls.splice(2);
  // two balls side by side at the throat: local (throat, ±2.5) → world (∓2.5, throat)
  [2.5, -2.5].forEach((ly, i) => {
    const b = w.balls[i];
    b.state = { kind: 'ground' };
    b.pos = { x: -ly, y: throat }; b.vel = { x: 0, y: 0 }; b.z = 0; b.vz = 0;
  });
  run(w, cmd({ intake: true }), 0.03); // one cycle
  check('triangle intake devours two clumped balls in one cycle', r.hopper.length === 2, `hopper=${r.hopper.length}`);
}

// ---- a robot squeezed by an opponent against a wall stays in-field ----------
{
  const w = createWorld('free', 3, [setup(0, 'blue', {}, 0), setup(1, 'blue', { massLb: 42 }, 1)]);
  const [a, b] = w.robots;
  a.pos = { x: 58, y: 0 }; a.heading = 0; a.vel = { x: 0, y: 0 }; a.fieldCentric = false; // pinned near +x wall
  b.pos = { x: 30, y: 0 }; b.heading = 0; b.vel = { x: 0, y: 0 }; b.fieldCentric = false; // heavy pusher
  const commands = new Map([[1, cmd({ driveY: 1 })]]); // drive B east into A
  for (let i = 0; i < Math.round(2 / SIM_DT); i++) step(w, SIM_DT, commands);
  const inField = (r: (typeof w.robots)[number]): boolean =>
    robotCorners(r).every((c) => Math.abs(c.x) <= FIELD_HALF + 0.5 && Math.abs(c.y) <= FIELD_HALF + 0.5);
  check('robot squeezed against a wall by an opponent stays in-field', inField(a) && inField(b), `a=(${a.pos.x.toFixed(1)},${a.pos.y.toFixed(1)})`);
}

// ---- 4-robot, 1200-tick determinism -----------------------------------------
{
  const build = (seed: number): World =>
    createWorld('match', seed, [
      setup(0, 'blue', {}, 0),
      setup(1, 'blue', { massLb: 24, driveRpm: 500 }, 1),
      setup(2, 'red', { drivetrain: 'tank' }, 0),
      setup(3, 'red', { intake: 'triangle' }, 1),
    ]);
  const cmds = new Map([
    [0, cmd({ driveY: 1, fire: true })],
    [1, cmd({ driveX: 0.5, intake: true })],
    [2, cmd({ rotate: 1 })],
    [3, cmd({ driveY: -0.7, fire: true })],
  ]);
  const runTicks = (w: World): void => {
    for (let i = 0; i < 1200; i++) step(w, SIM_DT, cmds);
  };
  const w1 = build(123); startMatch(w1); runTicks(w1);
  const w2 = build(123); startMatch(w2); runTicks(w2);
  check('4-robot 1200-tick sim is bit-for-bit deterministic', JSON.stringify(w1) === JSON.stringify(w2));
}

// ---- flywheel recovery: low inertia slows far shots, not close ones ---------
{
  // gap between the first two shots, fired continuously from `pos` (free mode
  // ignores launch-zone gating so we can place the robot anywhere)
  const firstGap = (spec: Partial<RobotSpec>, pos: { x: number; y: number }): number => {
    const w = mkWorld('free', 'blue', 5, spec);
    const r = w.robots[0];
    r.pos = { ...pos };
    r.vel = { x: 0, y: 0 };
    r.hopper = ['purple', 'green', 'purple'];
    const times: number[] = [];
    let prev = r.lastFireAt;
    const commands = new Map([[0, cmd({ fire: true })]]);
    for (let i = 0; i < Math.round(3 / SIM_DT) && times.length < 2; i++) {
      step(w, SIM_DT, commands);
      if (r.lastFireAt !== prev) { times.push(r.lastFireAt); prev = r.lastFireAt; }
    }
    return times.length >= 2 ? times[1] - times[0] : Infinity;
  };
  const near = { x: -50, y: 60 }; // point-blank on the blue goal
  const far = { x: 58, y: -30 };  // long cross-court shot
  const closeGap = firstGap({ flywheelInertia: 0 }, near);
  const farGap = firstGap({ flywheelInertia: 0 }, far);
  check('low-inertia flywheel fires rapidly up close', closeGap < 0.15, `gap=${closeGap.toFixed(3)}s`);
  check('low-inertia flywheel is slowed by a far shot (>3× the close gap)', farGap > 3 * closeGap, `far=${farGap.toFixed(3)}s close=${closeGap.toFixed(3)}s`);
  const hiFar = firstGap({ flywheelInertia: 1 }, far);
  check('high-inertia flywheel keeps rapid fire at range', Math.abs(hiFar - 0.1) < 0.03, `gap=${hiFar.toFixed(3)}s`);

  // the very first shot is always immediate (no spin-up before shot one)
  const w = mkWorld('free', 'blue', 5, { flywheelInertia: 0 });
  const r = w.robots[0];
  r.pos = { x: 58, y: -30 };
  r.hopper = ['purple', 'green', 'purple'];
  run(w, cmd({ fire: true }), SIM_DT * 2);
  check('first shot fires immediately even for a far low-inertia shot', r.lastFireAt <= SIM_DT * 2 + 1e-9, `t=${r.lastFireAt.toFixed(4)}`);
}

// ---- canSort fires the color the motif wants next ---------------------------
{
  const w = mkWorld('free', 'blue', 42, { canSort: true });
  const r = w.robots[0];
  r.pos = { x: -50, y: 60 };
  r.vel = { x: 0, y: 0 };
  const want = w.motif[0];
  const other: 'purple' | 'green' = want === 'purple' ? 'green' : 'purple';
  r.hopper = [other, want, other]; // FIFO would fire `other` first; sorter must skip to `want`
  run(w, cmd({ fire: true }), SIM_DT * 2); // exactly one shot
  const shot = w.balls[w.balls.length - 1];
  check('canSort robot fires the motif color first (skips FIFO)', shot.color === want, `shot=${shot.color} want=${want}`);
}

// ---- 4-robot spawn: distinct poses, preload split, HP stock drained ---------
{
  const w = createWorld('match', 77, [
    setup(0, 'blue', {}, 0),
    setup(1, 'blue', {}, 1),
    setup(2, 'red', {}, 0),
    setup(3, 'red', {}, 1),
  ]);
  const blue0 = w.robots.find((r) => r.id === 0)!;
  const blue1 = w.robots.find((r) => r.id === 1)!;
  check('4 robots spawn (2 per alliance)', w.robots.length === 4);
  check('first robot per alliance gets the 3-ball preload', blue0.hopper.length === 3, `${blue0.hopper.length}`);
  check(
    'second robot per alliance takes the HP stock as its preload',
    JSON.stringify(blue1.hopper) === JSON.stringify([...HP_INITIAL_STOCK]),
    `${blue1.hopper.join(',')}`,
  );
  check(
    'HP box is empty when two robots fill an alliance',
    w.humanPlayers.blue.box.length === 0 && w.humanPlayers.red.box.length === 0,
    `blue=${w.humanPlayers.blue.box.length} red=${w.humanPlayers.red.box.length}`,
  );
  const gap = Math.hypot(blue0.pos.x - blue1.pos.x, blue0.pos.y - blue1.pos.y);
  check('two robots on an alliance spawn at distinct, non-overlapping poses', gap > 20, `${gap.toFixed(1)} in apart`);
}

// ---- HP box = missing-robot leftovers only; pre-stage sits in the corner -----
{
  // full 2v2 -> box empty (both robots preloaded)
  const w2r = createWorld('match', 77, [setup(0, 'blue', {}, 0), setup(1, 'blue', {}, 1), setup(2, 'red', {}, 0), setup(3, 'red', {}, 1)]);
  check(
    'full 2v2 -> HP box is empty',
    w2r.humanPlayers.blue.box.length === 0 && w2r.humanPlayers.red.box.length === 0,
    `blue=${w2r.humanPlayers.blue.box.length}`,
  );
  // one robot -> box holds only the missing robot's set (3, PPG) — NOT full
  const w1 = createWorld('match', 77, [setup(0, 'blue', {}, 0), setup(1, 'red', {}, 0)]);
  check(
    'one-robot alliance -> box holds only the missing set (3, PPG)',
    JSON.stringify(w1.humanPlayers.blue.box) === JSON.stringify([...HP_INITIAL_STOCK]),
    `box=${w1.humanPlayers.blue.box.join(',')}`,
  );
  // empty alliance -> both leftover sets (6, 4P+2G), at the cap
  const w0 = createWorld('match', 77, [setup(0, 'blue', {}, 0)]);
  const redBox = w0.humanPlayers.red.box;
  check(
    'empty alliance -> box holds both leftover sets (6, 4P+2G)',
    redBox.length === 6 && redBox.filter((c) => c === 'purple').length === 4 && redBox.filter((c) => c === 'green').length === 2,
    `box=${redBox.join(',')}`,
  );
  // grab-row geometry: 3 slots in a row along x
  const slots = loadSlots('blue');
  check('grab row is 3 slots', slots.length === 3);
  check('grab row shares one y (a row along x)', slots.every((s) => s.y === slots[0].y));
  check(
    'grab row spans a range of x (robot sweeps along x)',
    Math.abs(slots[2].x - slots[0].x) > 2 * BALL_RADIUS,
    `dx=${(slots[2].x - slots[0].x).toFixed(1)}`,
  );
  // the 3 pre-staged artifacts (PGP) sit ON the field in the loading-zone corner,
  // against the alliance wall, touching, and NOT at the grab-row slots
  const pre = loadPreStage('blue');
  check('pre-stage is 3 PGP artifacts', pre.length === 3 && pre.map((p) => p.color).join(',') === 'purple,green,purple');
  check('pre-stage is flush against the alliance (side) wall', pre.every((p) => Math.abs(Math.abs(p.pos.x) - (FIELD_HALF - BALL_RADIUS)) < 1e-9));
  check('pre-stage balls are touching each other', Math.abs(Math.abs(pre[1].pos.y - pre[0].pos.y) - 2 * BALL_RADIUS) < 1e-9);
  check(
    'pre-stage is NOT at the grab-row slots',
    pre.every((p) => slots.every((s) => Math.hypot(p.pos.x - s.x, p.pos.y - s.y) > BALL_RADIUS * 1.5)),
  );
  const inZoneAtSetup = w0.balls.filter((b) => b.state.kind === 'ground' && inRect(b.pos, loadZone('blue')));
  check('the 3 pre-stage artifacts are on the field in the loading zone at setup', inZoneAtSetup.length === 3, `${inZoneAtSetup.length}`);
  // the 2x3 box has 6 cells OFF the field, just beyond the audience wall
  const cells = loadBoxSlots('blue');
  check(
    'the 2x3 box has 6 cells off the field (beyond the audience wall)',
    cells.length === 6 && cells.every((c) => c.y < -FIELD_HALF),
  );
}

// ---- HP is idle until teleop; then moves the corner pre-stage to the grab row -
{
  const w = createWorld('match', 5, [setup(0, 'blue', {}, 0)]); // starts in 'pre'
  w.robots[0].pos = { x: 0, y: 40 };
  const box0 = JSON.stringify(w.humanPlayers.blue.box);
  const preStageStill = () => loadPreStage('blue').every((p) => w.balls.some((b) => b.state.kind === 'ground' && Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y) < 0.1));
  // pre / auto / transition: HP does nothing — box untouched, pre-stage untouched
  for (const ph of ['pre', 'auto', 'transition'] as const) {
    w.match.phase = ph;
    updateHumanPlayers(w);
  }
  check(
    'HP does nothing before teleop (box + corner pre-stage untouched)',
    JSON.stringify(w.humanPlayers.blue.box) === box0 && preStageStill(),
    `boxMoved=${JSON.stringify(w.humanPlayers.blue.box) !== box0} preStage=${preStageStill()}`,
  );
  // teleop: over a couple seconds the HP moves the 3 pre-stage balls into the grab row
  w.match.phase = 'teleop';
  for (let k = 0; k < 40; k++) {
    updateHumanPlayers(w);
    w.time += HP_PLACE_DELAY + 0.02;
  }
  const slots = loadSlots('blue');
  const inGrabRow = slots.filter((s) => w.balls.some((b) => b.state.kind === 'ground' && Math.hypot(b.pos.x - s.x, b.pos.y - s.y) < 0.2)).length;
  check(
    'HP moves the pre-stage into the grab row once teleop begins',
    inGrabRow === 3 && !preStageStill(),
    `grabRow=${inGrabRow}`,
  );
}

// ---- HP recycles loose balls in teleop (grabs them into the box), capped ------
{
  const setups4 = [setup(0, 'blue', {}, 0), setup(1, 'blue', {}, 1), setup(2, 'red', {}, 0), setup(3, 'red', {}, 1)];
  const slots = loadSlots('blue');
  const lz = loadZone('blue');

  // 2v2 -> box empty; fill the grab row so STAGING is a no-op, isolating COLLECT
  const w = createWorld('match', 5, setups4);
  w.match.phase = 'teleop';
  for (const r of w.robots) r.pos = { x: 0, y: 40 };
  // remove the corner pre-stage so only our injected loose ball is collectable
  w.balls = w.balls.filter((b) => !(b.state.kind === 'ground' && inRect(b.pos, lz)));
  slots.forEach((s, i) => w.balls.push({ id: 5000 + i, color: 'purple', state: { kind: 'ground' }, pos: { x: s.x, y: s.y }, vel: { x: 0, y: 0 }, z: 0, vz: 0 }));
  w.balls.push({ id: 4242, color: 'green', state: { kind: 'ground' }, pos: { x: (lz.x0 + lz.x1) / 2, y: lz.y1 - 3 }, vel: { x: 0, y: 0 }, z: 0, vz: 0 });
  const before = w.humanPlayers.blue.box.length;
  updateHumanPlayers(w);
  check(
    'HP grabs a loose ball out of the loading zone into the box',
    !w.balls.some((b) => b.id === 4242) && w.humanPlayers.blue.box.length === before + 1,
    `box ${before}->${w.humanPlayers.blue.box.length}`,
  );
  check(
    'HP does not grab the balls staged at the grab slots',
    [5000, 5001, 5002].every((id) => w.balls.some((b) => b.id === id)),
  );

  // at the 6-out-of-play cap the HP grabs nothing more
  const w3 = createWorld('match', 5, []); // no robots -> box = 6 (capped)
  w3.match.phase = 'teleop';
  w3.balls = w3.balls.filter((b) => !(b.state.kind === 'ground' && inRect(b.pos, lz)));
  slots.forEach((s, i) => w3.balls.push({ id: 5200 + i, color: 'purple', state: { kind: 'ground' }, pos: { x: s.x, y: s.y }, vel: { x: 0, y: 0 }, z: 0, vz: 0 }));
  w3.balls.push({ id: 4243, color: 'green', state: { kind: 'ground' }, pos: { x: (lz.x0 + lz.x1) / 2, y: lz.y1 - 3 }, vel: { x: 0, y: 0 }, z: 0, vz: 0 });
  updateHumanPlayers(w3);
  check(
    'HP does not grab when the box is already at the 6-out-of-play cap',
    w3.balls.some((b) => b.id === 4243) && w3.humanPlayers.blue.box.length === 6,
  );
}

// ============================================================================
// Phase C: penalty engine (Section 11 fouls)
// ============================================================================

/** two cross-alliance robots (blue id0, red id1) forced into teleop */
function foulWorld(timeLeft = 60): World {
  const w = createWorld('match', 55, [setup(0, 'blue', {}, 0), setup(1, 'red', {}, 0)]);
  w.match.phase = 'teleop';
  w.match.phaseTimeLeft = timeLeft;
  // park both well away from every foul zone until each test places them
  w.robots[0].pos = { x: 0, y: -8 };
  w.robots[1].pos = { x: 0, y: 20 };
  for (const r of w.robots) { r.vel = { x: 0, y: 0 }; r.fieldCentric = false; }
  return w;
}

function runCmds(w: World, cmds: Map<number, RobotCommand>, seconds: number): void {
  const n = Math.round(seconds / SIM_DT);
  for (let i = 0; i < n; i++) step(w, SIM_DT, cmds);
}

/** drop a robot into an opposing gate zone and press it in for `secs` */
function inGate(w: World, robotIdx: number, gate: 'red' | 'blue'): void {
  const gz = gateZone(gate);
  w.robots[robotIdx].pos = { x: (gz.x0 + gz.x1) / 2, y: (gz.y0 + gz.y1) / 2 };
}

// ---- G417 operating an OPPONENT's gate (MAJOR) -----------------------------
// Rules driven directly through updatePenalties (world.time advanced by hand) so
// the episode debounce can be exercised without physics moving the robot.
{
  const w = foulWorld();
  const gz = gateZone('red');
  const gcx = (gz.x0 + gz.x1) / 2;
  const gcy = (gz.y0 + gz.y1) / 2;
  w.time = 0;
  w.robots[0].pos = { x: gcx, y: gcy }; // blue TOUCHING red's gate arm (no push, idle)
  w.robots[0].vel = { x: 0, y: 0 };
  w.robots[1].pos = { x: 0, y: 20 };    // red elsewhere
  updatePenalties(w, 1 / 60, new Map());
  check(
    'TOUCHING the opponent gate (even without opening it) is an immediate MAJOR (G417)',
    w.match.fouls.blue.major === 1 && w.match.scores.red.foulPoints === 15,
    `blueMajor=${w.match.fouls.blue.major} redFoulPts=${w.match.scores.red.foulPoints}`,
  );
  // holding at the gate is ONE foul (episode-debounced)
  w.time = 0.5;
  updatePenalties(w, 1 / 60, new Map());
  check('holding at the opponent gate is a single G417 foul', w.match.fouls.blue.major === 1, `blueMajor=${w.match.fouls.blue.major}`);
  // leave past the clear window, then return -> a fresh foul
  w.robots[0].pos = { x: 0, y: -8 };
  w.time = 2.0;
  updatePenalties(w, 1 / 60, new Map());
  check('leaving the gate does not add a foul', w.match.fouls.blue.major === 1);
  w.robots[0].pos = { x: gcx, y: gcy };
  w.time = 2.1;
  updatePenalties(w, 1 / 60, new Map());
  check('re-entering the opponent gate after the clear window fouls again', w.match.fouls.blue.major === 2, `blueMajor=${w.match.fouls.blue.major}`);

  // operating your OWN gate is legal
  const w2 = foulWorld();
  w2.robots[1].pos = { x: gcx, y: gcy }; // red on red's own gate
  updatePenalties(w2, 1 / 60, new Map());
  check(
    'operating your OWN gate is not a foul',
    w2.match.scores.red.foulPoints === 0 && w2.match.fouls.red.major === 0,
    `redFoulPts=${w2.match.scores.red.foulPoints} redMajor=${w2.match.fouls.red.major}`,
  );
}

// ---- G408 over-possession / plowing (MINOR) --------------------------------
// A robot CONTROLLING more than POSSESSION_LIMIT artifacts (hopper + herded
// loose balls) past POSSESSION_GRACE draws a MINOR foul on its own alliance.
{
  const w = foulWorld();
  const r = w.robots[0]; // blue
  r.pos = { x: 0, y: -8 };
  r.heading = 0;
  r.hopper = ['green', 'green', 'green']; // full hopper = 3 stored (at the limit)
  r.vel = { x: POSSESSION_MOVE_SPEED + 4, y: 0 }; // driving = herding
  // a loose ground ball plowed against the robot -> 4 controlled, over the limit
  w.balls.push({ id: 9001, color: 'purple', state: { kind: 'ground' }, pos: { x: 2, y: 0 }, vel: { x: 0, y: 0 }, z: 0, vz: 0 });
  // hold the over-possession just past the grace window
  for (let i = 0; i < Math.round(POSSESSION_GRACE / (1 / 60)) + 2; i++) {
    w.time = i / 60;
    updatePenalties(w, 1 / 60, new Map());
  }
  check(
    'controlling a 4th artifact (full hopper + a plowed loose ball) past the grace is a MINOR G408',
    w.match.fouls.blue.minor === 1 && w.match.scores.red.foulPoints === 5,
    `blueMinor=${w.match.fouls.blue.minor} redFoulPts=${w.match.scores.red.foulPoints}`,
  );

  // a PARKED robot merely resting against the same ball is not controlling it
  const w2 = foulWorld();
  const r2 = w2.robots[0];
  r2.pos = { x: 0, y: -8 };
  r2.heading = 0;
  r2.hopper = ['green', 'green', 'green'];
  r2.vel = { x: 0, y: 0 }; // stationary
  w2.balls.push({ id: 9002, color: 'purple', state: { kind: 'ground' }, pos: { x: 2, y: 0 }, vel: { x: 0, y: 0 }, z: 0, vz: 0 });
  for (let i = 0; i < Math.round(POSSESSION_GRACE / (1 / 60)) + 2; i++) {
    w2.time = i / 60;
    updatePenalties(w2, 1 / 60, new Map());
  }
  check(
    'a stationary robot resting against a loose ball is not over-possession (no G408)',
    w2.match.fouls.blue.minor === 0 && w2.match.scores.red.foulPoints === 0,
    `blueMinor=${w2.match.fouls.blue.minor} redFoulPts=${w2.match.scores.red.foulPoints}`,
  );

  // a full hopper with NO plowed ball is exactly at the limit — no foul
  const w3 = foulWorld();
  const r3 = w3.robots[0];
  r3.pos = { x: 0, y: -8 };
  r3.hopper = ['green', 'green', 'green'];
  r3.vel = { x: POSSESSION_MOVE_SPEED + 4, y: 0 };
  for (let i = 0; i < Math.round(POSSESSION_GRACE / (1 / 60)) + 2; i++) {
    w3.time = i / 60;
    updatePenalties(w3, 1 / 60, new Map());
  }
  check(
    'a full hopper at the possession limit (no plowed ball) is legal (no G408)',
    w3.match.fouls.blue.minor === 0,
    `blueMinor=${w3.match.fouls.blue.minor}`,
  );

  // brief contact under the grace window does not foul (normal intake pass)
  const w4 = foulWorld();
  const r4 = w4.robots[0];
  r4.pos = { x: 0, y: -8 };
  r4.heading = 0;
  r4.hopper = ['green', 'green', 'green'];
  r4.vel = { x: POSSESSION_MOVE_SPEED + 4, y: 0 };
  w4.balls.push({ id: 9003, color: 'purple', state: { kind: 'ground' }, pos: { x: 2, y: 0 }, vel: { x: 0, y: 0 }, z: 0, vz: 0 });
  for (let i = 0; i < Math.floor((POSSESSION_GRACE / 2) / (1 / 60)); i++) { // < grace
    w4.time = i / 60;
    updatePenalties(w4, 1 / 60, new Map());
  }
  check(
    'over-possession briefer than the grace window does not foul',
    w4.match.fouls.blue.minor === 0,
    `blueMinor=${w4.match.fouls.blue.minor}`,
  );
}

// ---- G424 GATE ZONE off limits (MINOR): robot-robot contact at the gate -----
// Isolated from G417: the OWNER (red) sits in its own gate zone and the opponent
// (blue) contacts from the field side, clear of the gate zone (so blue is not
// operating the gate). Only G424 should fire.
{
  const w = foulWorld();
  for (const r of w.robots) r.heading = 0;
  w.robots[1].pos = { x: 52, y: 0 };  // red (owner) in its own gate zone, clear of the tunnel corner
  w.robots[0].pos = { x: 30, y: 0 };  // blue contacts from the field side, clear of the gate zone
  w.rrContacts = [{ a: 0, b: 1 }];
  updatePenalties(w, 1 / 60, new Map());
  check(
    'robot contact with the gate owner in its own gate is a MINOR G424 on the opponent (and NOT G417)',
    w.match.fouls.blue.minor === 1 && w.match.fouls.blue.major === 0 && w.match.scores.red.foulPoints === 5,
    `blueMinor=${w.match.fouls.blue.minor} blueMajor=${w.match.fouls.blue.major} redFoulPts=${w.match.scores.red.foulPoints}`,
  );
}

// ---- G418.B artifacts off the opponent's ramp (MAJOR per artifact) ----------
// Manual Example 3: open the opponent gate, N artifacts drain off their ramp ->
// 1 MAJOR (G417) + N MAJOR (G418.B, one per artifact).
{
  const w = foulWorld();
  const N = 3;
  for (let i = 0; i < N; i++) {
    const b = w.balls[i];
    b.state = { kind: 'rail', goal: 'red', s: GATE_STOP_S + i * RAIL_PITCH, v: 0, overflow: false };
    b.pos = railPos('red', GATE_STOP_S + i * RAIL_PITCH);
    b.vel = { x: 0, y: 0 };
    b.z = RAMP_SURFACE_Z;
  }
  const gz = gateZone('red');
  w.robots[0].pos = { x: gz.x0 - 7, y: (gz.y0 + gz.y1) / 2 }; // blue field-side of red's gate
  w.robots[0].heading = 0; // face the +x (red) wall
  w.robots[0].fieldCentric = false;
  w.robots[1].pos = { x: 0, y: 30 };
  // blue drives INTO red's gate arm (push-to-open) — the column drains off red's ramp
  runCmds(w, new Map([[0, cmd({ driveY: 1 })]]), 2.5);
  const drained = w.balls.filter((b) => !(b.state.kind === 'rail' && b.state.goal === 'red')).length;
  check(
    'opening the opponent gate: 1 G417 + one G418 per artifact that drains off their ramp',
    w.match.fouls.blue.major === N + 1,
    `blueMajor=${w.match.fouls.blue.major} (expected ${N + 1})  redFoulPts=${w.match.scores.red.foulPoints}`,
  );
}

// ---- G418.B is billed on the DRAIN, not on the touch -------------------------
// TAPPING an opponent's gate arm without ever lifting it is G417 alone: nothing
// leaves their ramp, so nothing is billed. (This used to charge a MAJOR for every
// artifact standing on the ramp at the moment of contact.)
{
  const w = foulWorld();
  const N = 3;
  for (let i = 0; i < N; i++) {
    const b = w.balls[i];
    b.state = { kind: 'rail', goal: 'red', s: GATE_STOP_S + i * RAIL_PITCH, v: 0, overflow: false };
    b.pos = railPos('red', GATE_STOP_S + i * RAIL_PITCH);
    b.vel = { x: 0, y: 0 };
    b.z = RAMP_SURFACE_Z;
  }
  const ar = gateArmRect('red');
  w.robots[0].pos = { x: (ar.x0 + ar.x1) / 2, y: (ar.y0 + ar.y1) / 2 }; // blue ON red's arm
  w.robots[0].heading = 0;
  w.robots[0].vel = { x: 0, y: 0 };
  w.robots[1].pos = { x: 0, y: 30 };
  // penalties only (no world step): the arm is touched but never pushed, so it
  // stays shut and the column stays put
  for (let i = 0; i < 30; i++) updatePenalties(w, 1 / 60, new Map());
  check(
    'touching the opponent gate WITHOUT opening it is G417 only — no G418 for the standing column',
    w.match.fouls.blue.major === 1 && w.match.scores.red.foulPoints === 15,
    `blueMajor=${w.match.fouls.blue.major} (expected 1) redFoulPts=${w.match.scores.red.foulPoints}`,
  );
  check('a tap leaves the ramp column untouched', w.balls.filter((b) => b.state.kind === 'rail').length === N);
}

// ---- G418.B blames the opponent who OPENED the gate, not one merely leaning ---
// The owner drains their OWN ramp while an opponent rests against the lever: the
// opponent owes G417 for the contact, but the artifacts are the owner's own doing.
{
  const w = foulWorld();
  const b = w.balls[0];
  b.state = { kind: 'rail', goal: 'red', s: GATE_STOP_S, v: 0, overflow: false };
  b.pos = railPos('red', GATE_STOP_S);
  b.z = RAMP_SURFACE_Z;
  const ar = gateArmRect('red');
  w.robots[0].pos = { x: (ar.x0 + ar.x1) / 2, y: (ar.y0 + ar.y1) / 2 }; // blue touching, not pushing
  w.robots[0].vel = { x: 0, y: 0 };
  w.robots[1].pos = { x: 0, y: 30 };
  w.goals.red.gatePos = 1; // the OWNER has it open
  w.goals.red.gateOpen = true;
  updatePenalties(w, 1 / 60, new Map()); // records the ball on the ramp
  b.state = { kind: 'ground' }; // ...and it drains out
  updatePenalties(w, 1 / 60, new Map());
  check(
    'an artifact off a ramp the OWNER opened is not billed to an opponent touching the lever',
    w.match.fouls.blue.major === 1 && w.match.scores.red.foulPoints === 15,
    `blueMajor=${w.match.fouls.blue.major} (expected 1, G417 only)`,
  );
}

// ---- G425 secret tunnel (MINOR) --------------------------------------------
{
  const w = foulWorld();
  const ts = tunnelStrip('red'); // the strip under RED's goal, owned by BLUE
  const cx = (ts.x0 + ts.x1) / 2;
  w.robots[0].pos = { x: cx, y: -25 };
  w.robots[1].pos = { x: cx, y: -24 }; // overlapping -> contact
  runCmds(w, new Map(), 0.3);
  check(
    'contact in the secret tunnel draws a MINOR foul on the intruder',
    w.match.scores.blue.foulPoints === 5 && w.match.fouls.red.minor === 1,
    `blueFoulPts=${w.match.scores.blue.foulPoints} redMinor=${w.match.fouls.red.minor}`,
  );
}

// ---- G424 x G425 exception: gate zone and secret tunnel are mutually exclusive
// The LEFT wall holds BLUE's gate zone AND RED's secret tunnel (they overlap in
// the classifier corner). Rules are hand-driven through updatePenalties with a
// forced contact pair so the exact overlap geometry isn't perturbed by physics.
{
  // Scenario 1: blue is in its OWN gate zone AND in red's (opponent's) tunnel,
  // red is in its own tunnel -> ONLY a secret-tunnel foul (on blue), no gate foul.
  const w = foulWorld();
  w.robots[0].pos = { x: -68, y: -3 };  // blue: overlaps gate zone + red's tunnel
  w.robots[1].pos = { x: -68, y: -6 };  // red: in its own tunnel
  w.rrContacts = [{ a: 0, b: 1 }];
  updatePenalties(w, 1 / 60, new Map());
  check(
    'gate robot ALSO in the opponent tunnel: only a secret-tunnel foul (on blue), no gate foul',
    w.match.fouls.blue.minor === 1 && w.match.fouls.red.minor === 0,
    `blueMinor=${w.match.fouls.blue.minor} redMinor=${w.match.fouls.red.minor}`,
  );

  // Scenario 2: blue is in its OWN gate zone but NOT in red's tunnel, red is in
  // its own tunnel -> ONLY a gate foul (on red), no secret-tunnel foul.
  const w2 = foulWorld();
  w2.robots[0].pos = { x: -64, y: 0 };  // blue: in its gate zone, clear of the tunnel
  w2.robots[1].pos = { x: -68, y: -10 }; // red: in its own tunnel
  w2.rrContacts = [{ a: 0, b: 1 }];
  updatePenalties(w2, 1 / 60, new Map());
  check(
    'gate robot clear of the opponent tunnel: only a gate foul (on red), no secret-tunnel foul',
    w2.match.fouls.red.minor === 1 && w2.match.fouls.blue.minor === 0,
    `redMinor=${w2.match.fouls.red.minor} blueMinor=${w2.match.fouls.blue.minor}`,
  );
}

// ---- G426 loading zone (MINOR): opponent contacts you in your own zone ------
{
  const w = foulWorld();
  // sit well inside the loading zone AND clear of the side-wall tunnel strip
  // (a wide chassis near the +x wall would straddle both zones)
  const cx = loadZone('blue').x0 + 5;
  for (const r of w.robots) r.heading = Math.PI / 2; // forward = +y
  w.robots[0].pos = { x: cx, y: -58 }; // victim (blue) in its own loading zone
  w.robots[1].pos = { x: cx, y: -42 }; // opponent (red) overlapping slightly -> one contact
  runCmds(w, new Map(), 0.3);
  check(
    'opponent contact in your loading zone fouls the opponent (MINOR)',
    w.match.scores.blue.foulPoints === 5 && w.match.fouls.red.minor === 1,
    `blueFoulPts=${w.match.scores.blue.foulPoints} redMinor=${w.match.fouls.red.minor}`,
  );
}

// ---- G427 base zone (MAJOR + counts the victim fully returned) --------------
{
  const w = foulWorld(15); // endgame (<= ENDGAME_START)
  const bz = baseZone('blue');
  const cx = (bz.x0 + bz.x1) / 2;
  const cy = (bz.y0 + bz.y1) / 2;
  w.robots[0].pos = { x: cx, y: cy }; // blue in its base
  w.robots[1].pos = { x: cx, y: cy + 1 }; // red contacts it
  runCmds(w, new Map(), 0.3);
  check(
    'base contact in endgame draws a MAJOR foul + marks the victim base-awarded',
    w.match.scores.blue.foulPoints === 15 &&
      w.match.fouls.red.major === 1 &&
      w.robots[0].baseAwarded === true,
    `blueFoulPts=${w.match.scores.blue.foulPoints} redMajor=${w.match.fouls.red.major} awarded=${w.robots[0].baseAwarded}`,
  );
  // drive the victim clear out of its base, then assess: baseAwarded => full
  w.robots[0].pos = { x: 0, y: 0 };
  w.robots[1].pos = { x: 0, y: 40 };
  assessMatchEnd(w);
  check(
    'a base-awarded robot is credited a FULL base return even outside the base',
    w.match.scores.blue.base === 10,
    `base=${w.match.scores.blue.base}`,
  );

  // outside endgame the same contact is NOT a base foul
  const w2 = foulWorld(60);
  w2.robots[0].pos = { x: cx, y: cy };
  w2.robots[1].pos = { x: cx, y: cy + 1 };
  runCmds(w2, new Map(), 0.3);
  check(
    'base contact BEFORE endgame is not a G427 foul',
    w2.match.scores.blue.foulPoints === 0 && !w2.robots[0].baseAwarded,
  );
}

// ---- G402 AUTO interference (MAJOR): fully on the opponent's side -----------
// Each alliance BELONGS on its goal side (blue -x, red +x — robots stage near
// their cross-court goal); crossing fully to the OPPONENT's side fouls the
// crosser. (Regression: this used to key off driverSide and fired when a robot
// sat on its OWN side, fouling the wrong alliance.)
{
  const w = createWorld('match', 55, [setup(0, 'blue', {}, 0), setup(1, 'red', {}, 0)]);
  startMatch(w); // -> auto
  for (const r of w.robots) { r.vel = { x: 0, y: 0 }; r.fieldCentric = false; }
  w.robots[0].pos = { x: 30, y: 0 }; // blue entirely on RED's (+x) side
  w.robots[1].pos = { x: 30, y: 1 }; // contacting a red robot
  runCmds(w, new Map(), 0.2);
  check(
    'crossing fully onto the opponent side and contacting in AUTO is a MAJOR foul on the crosser',
    w.match.scores.red.foulPoints === 15 && w.match.fouls.blue.major === 1,
    `redFoulPts=${w.match.scores.red.foulPoints} blueMajor=${w.match.fouls.blue.major}`,
  );

  // a robot fully on its OWN side (blue on -x) contacting an opponent is NOT G402
  const w2 = createWorld('match', 55, [setup(0, 'blue', {}, 0), setup(1, 'red', {}, 0)]);
  startMatch(w2);
  for (const r of w2.robots) { r.vel = { x: 0, y: 0 }; r.fieldCentric = false; }
  w2.robots[0].pos = { x: -30, y: 0 }; // blue on its OWN (-x) side
  w2.robots[1].pos = { x: -30, y: 1 }; // red has crossed onto blue's side
  runCmds(w2, new Map(), 0.2);
  check(
    'G402 fouls the CROSSER, not the alliance sitting on its own side',
    w2.match.fouls.blue.major === 0 && w2.match.fouls.red.major === 1,
    `blueMajor=${w2.match.fouls.blue.major} redMajor=${w2.match.fouls.red.major}`,
  );
}

// ---- same-alliance contact never fouls -------------------------------------
{
  const w = createWorld('match', 55, [setup(0, 'blue', {}, 0), setup(1, 'blue', {}, 1)]);
  w.match.phase = 'teleop';
  w.match.phaseTimeLeft = 60;
  const ts = tunnelStrip('red');
  const cx = (ts.x0 + ts.x1) / 2;
  for (const r of w.robots) { r.vel = { x: 0, y: 0 }; r.fieldCentric = false; }
  w.robots[0].pos = { x: cx, y: -25 };
  w.robots[1].pos = { x: cx, y: -24 };
  runCmds(w, new Map(), 0.5);
  check(
    'same-alliance contact in a foul zone never fouls',
    w.match.scores.red.foulPoints === 0 &&
      w.match.scores.blue.foulPoints === 0 &&
      w.match.fouls.blue.minor === 0 &&
      w.match.fouls.blue.major === 0,
  );
}

/** pin scenario: pinned robot flush against the far wall, pinner just below and
 * driving up into it (heading π/2 so robot-forward = +y). */
function pinWorld(): World {
  const w = foulWorld();
  for (const r of w.robots) r.heading = Math.PI / 2;
  w.robots[1].pos = { x: 0, y: 63 }; // pinned red, flush at the far wall
  w.robots[0].pos = { x: 0, y: 44 }; // pinner blue, 1" gap, drives up into it
  return w;
}
const PIN_CMDS = new Map([[0, cmd({ driveY: 1 })], [1, cmd({ driveY: 1 })]]);

// ---- G422 pinning: 3-count fires, then resets on separation -----------------
{
  const w = pinWorld();
  runCmds(w, PIN_CMDS, 2.7);
  check('no pin foul before the 3 s threshold', w.match.fouls.blue.minor === 0, `blueMinor=${w.match.fouls.blue.minor}`);
  runCmds(w, PIN_CMDS, 0.5); // cross 3 s
  check(
    'a 3 s pin draws a MINOR foul on the pinner',
    w.match.fouls.blue.minor === 1,
    `blueMinor=${w.match.fouls.blue.minor}`,
  );
  // ONLY the pinner is fouled — the pinned victim's alliance (red) must not be
  // (both robots are slow + commanding in a wall shove; the wall-trap test picks
  // the real pinner)
  check(
    'the pinned victim alliance is NOT fouled (no wrong-alliance pin penalty)',
    w.match.fouls.red.minor === 0 && w.match.fouls.red.major === 0,
    `redMinor=${w.match.fouls.red.minor} redMajor=${w.match.fouls.red.major}`,
  );
  // separate: the accumulator must reset and stop fouling
  w.robots[0].pos = { x: 0, y: -20 };
  const before = w.match.fouls.blue.minor + w.match.fouls.blue.major;
  runCmds(w, new Map(), 2);
  check(
    'breaking the pin resets the count (no further foul while separated)',
    w.match.fouls.blue.minor + w.match.fouls.blue.major === before,
    `after=${w.match.fouls.blue.minor + w.match.fouls.blue.major}`,
  );
}

// ---- G422 pinning: a continuous pin is ONE foul; a REPEAT escalates to MAJOR -
{
  const w = pinWorld();
  runCmds(w, PIN_CMDS, 6.3); // hold the pin continuously well past 6 s
  check(
    'a sustained pin is a single MINOR foul, not one every 3 s',
    w.match.fouls.blue.minor === 1 && w.match.fouls.blue.major === 0,
    `blueMinor=${w.match.fouls.blue.minor} blueMajor=${w.match.fouls.blue.major}`,
  );
  // separate, then pin again — the repeat by the same pinner escalates to MAJOR
  w.robots[0].pos = { x: 0, y: -20 };
  runCmds(w, new Map(), 0.4); // break contact
  w.robots[0].pos = { x: 0, y: 44 };
  runCmds(w, PIN_CMDS, 3.3);
  check(
    'a repeat pin (after separating) escalates to MAJOR',
    w.match.fouls.blue.major === 1,
    `blueMinor=${w.match.fouls.blue.minor} blueMajor=${w.match.fouls.blue.major}`,
  );
}

// ---- penalty state stays deterministic -------------------------------------
{
  const w1 = pinWorld(); runCmds(w1, PIN_CMDS, 4);
  const w2 = pinWorld(); runCmds(w2, PIN_CMDS, 4);
  check('penalty engine is bit-for-bit deterministic', JSON.stringify(w1) === JSON.stringify(w2));
}

// ============================================================================
// Phase 0: server-authoritative netcode (protocol / checksum / predict-reconcile)
// ============================================================================

// ---- command quantization: clamp + idempotent round-trip -------------------
{
  const q = quantizeCommand(cmd({ driveX: 5, driveY: -5, rotate: 0.5, intake: true, fire: false }));
  check(
    'quantize clamps out-of-range axes to int8 and packs buttons',
    q.dx === 127 && q.dy === -127 && q.rot === Math.round(0.5 * 127) && q.buttons === 1,
    `dx=${q.dx} dy=${q.dy} rot=${q.rot} btn=${q.buttons}`,
  );
  // quantize∘dequantize is the identity on a QCommand, so localize is stable —
  // the client predicts on exactly what the server decodes from the same bytes
  const raw = cmd({ driveX: 0.37, driveY: -0.81, rotate: 0.12, fire: true });
  const once = localizeCommand(raw);
  const twice = localizeCommand(once);
  check(
    'localizeCommand is stable (client prediction == server-decoded value)',
    JSON.stringify(once) === JSON.stringify(twice),
    JSON.stringify(once),
  );
  // EVERY held button must survive the wire. The quantizer enumerates bits, so a newly
  // added button silently becomes a no-op in multiplayer (and in any predicted/replayed
  // step) unless it is added to the mask — which is exactly what happened to `fling` and
  // `driveMode`. This asserts each one round-trips, so the next one can't regress quietly.
  {
    const btns: (keyof RobotCommand)[] = ['intake', 'fire', 'catalyst', 'fling', 'driveMode'];
    const lost = btns.filter((b) => {
      const rt = dequantizeCommand(quantizeCommand(cmd({ [b]: true } as Partial<RobotCommand>)));
      return rt[b] !== true;
    });
    check('wire: every held button survives quantization', lost.length === 0, `dropped: ${lost.join(', ') || 'none'}`);
    // and they are INDEPENDENT bits — one pressed must not set another
    const only = dequantizeCommand(quantizeCommand(cmd({ fling: true })));
    check(
      'wire: button bits are independent (fling does not imply catalyst/fire)',
      only.fling === true && !only.catalyst && !only.fire && !only.intake && !only.driveMode,
    );
  }

  // TANK drive lives in leftDrive/rightDrive — these MUST survive quantization or a
  // networked tank robot gets zero drive and sits frozen at spawn (regression guard).
  const tank = dequantizeCommand(quantizeCommand(cmd({ leftDrive: 1, rightDrive: -0.5 })));
  check(
    'quantization carries tank leftDrive/rightDrive (not dropped to 0)',
    tank.leftDrive === 1 && Math.abs(tank.rightDrive + 0.5) < 0.02,
    `ld=${tank.leftDrive} rd=${tank.rightDrive}`,
  );
  // an OLD client's ld/rd-less packet still decodes (missing ⇒ 0, the old behavior)
  const legacy = dequantizeCommand({ dx: 0, dy: 64, rot: 0, buttons: 0 });
  check('dequantize tolerates a legacy ld/rd-less packet', legacy.leftDrive === 0 && legacy.rightDrive === 0);
}

// ---- worldHash: replay determinism + sensitivity ---------------------------
{
  const build = (): World =>
    createWorld('match', 321, [
      setup(0, 'blue', {}, 0),
      setup(1, 'blue', { massLb: 24, driveRpm: 500 }, 1),
      setup(2, 'red', { drivetrain: 'tank' }, 0),
      setup(3, 'red', { intake: 'triangle' }, 1),
    ]);
  const cmds = new Map([
    [0, cmd({ driveY: 1, fire: true })],
    [1, cmd({ driveX: 0.5, intake: true })],
    [2, cmd({ rotate: 1 })],
    [3, cmd({ driveY: -0.7, fire: true })],
  ]);
  const hashesAt = (w: World): number[] => {
    startMatch(w);
    const out: number[] = [];
    for (let i = 0; i < 600; i++) {
      step(w, SIM_DT, cmds);
      if (w.tick % 120 === 0) out.push(worldHash(w)); // sample every ~2 s
    }
    return out;
  };
  const h1 = hashesAt(build());
  const h2 = hashesAt(build());
  check(
    'worldHash agrees across identical replays (server/client parity per tick)',
    h1.length === 5 && JSON.stringify(h1) === JSON.stringify(h2),
    `n=${h1.length}`,
  );
  check('the checksum actually evolves (not constant)', new Set(h1).size > 1);

  const wa = build();
  const wb = build();
  wb.robots[0].pos.x += 1; // a 1" divergence must change the hash
  check('worldHash detects a diverged position', worldHash(wa) !== worldHash(wb));
}

// ---- snapshot fidelity: World survives a JSON snapshot round-trip -----------
// (reconciliation replaces the world with a JSON snapshot from the server, so
// the parsed world must hash identically to the original)
{
  const w = createWorld('match', 555, [setup(0, 'blue', {}, 0), setup(1, 'red', {}, 1)]);
  startMatch(w);
  const cmds = new Map([
    [0, cmd({ driveY: 1, rotate: 0.4, fire: true })],
    [1, cmd({ driveX: -0.6, intake: true })],
  ]);
  for (let i = 0; i < 240; i++) step(w, SIM_DT, cmds);
  const clone: World = JSON.parse(JSON.stringify(w));
  check('World survives a JSON snapshot round-trip (hash-identical)', worldHash(clone) === worldHash(w));
}

// ---- delta snapshots: slim (spec-stripped) + ball delta reassemble exactly --
{
  const setups = [setup(0, 'blue', {}, 0), setup(1, 'red', { drivetrain: 'tank' }, 1)];
  const w = createWorld('match', 654, setups);
  startMatch(w);
  const cmds = new Map([
    [0, cmd({ driveY: 1, fire: true })],
    [1, cmd({ driveX: -0.5, intake: true })],
  ]);
  // stop early, while balls are still in flight/motion (so the delta below has
  // both changed and idle balls to distinguish)
  for (let i = 0; i < 45; i++) step(w, SIM_DT, cmds);

  // slim (drop balls + robot.spec) then reassemble with spec re-injected
  const specById = (id: number): (typeof setups)[number]['spec'] =>
    setups.find((s) => s.id === id)!.spec;
  const rebuilt = unslimWorld(slimWorld(w), w.balls, specById);
  check('slim+unslim snapshot reassembles to an identical worldHash', worldHash(rebuilt) === worldHash(w));
  check(
    'the slim wire world carries no robot spec (client re-injects it)',
    !('spec' in (slimWorld(w).robots[0] as object)),
  );

  // OLD-SERVER SKEW: one Fly app serves every client version, so a newer client
  // can receive a snapshot from an older server whose RobotState predates the
  // power-draw fields. Simulate that by stripping flywheelSpin/flywheelSpinRate/
  // powerDraw from the wire, then unslim + step — the client must NOT go NaN
  // (regression: it rendered the robot at the field centre and froze).
  const oldWire = slimWorld(w);
  for (const r of oldWire.robots) {
    delete (r as Record<string, unknown>).flywheelSpin;
    delete (r as Record<string, unknown>).flywheelSpinRate;
    delete (r as Record<string, unknown>).powerDraw;
  }
  const oldRebuilt = unslimWorld(oldWire, w.balls, specById);
  check(
    'unslim back-fills missing power-draw fields (old-server skew, no undefined)',
    oldRebuilt.robots.every(
      (r) =>
        Number.isFinite(r.flywheelSpin) &&
        Number.isFinite(r.flywheelSpinRate) &&
        Number.isFinite(r.powerDraw),
    ),
  );
  for (let i = 0; i < 30; i++) step(oldRebuilt, SIM_DT, cmds);
  check(
    'stepping an old-server snapshot never NaNs the robot position',
    oldRebuilt.robots.every((r) => Number.isFinite(r.pos.x) && Number.isFinite(r.pos.y)),
    oldRebuilt.robots.map((r) => `(${r.pos.x.toFixed(1)},${r.pos.y.toFixed(1)})`).join(' '),
  );

  // CR MULTIPLAYER: a Chain Reaction world's snapshot must round-trip the CR-specific
  // `chain` state (catalysts / scored / endgame) AND keep game === 'chain', then keep
  // stepping deterministically on the client (server-authoritative + reconcile).
  {
    const crSetup = (id: number, alliance: Alliance): (typeof setups)[number] => ({
      id,
      alliance,
      spec: { ...DEFAULT_SPEC },
      assists: { ...DEFAULT_ASSISTS },
      startIndex: id,
    });
    const cwmp = createChainWorld('match', 77, [crSetup(0, 'blue'), crSetup(1, 'red')]);
    cwmp.match.phase = 'teleop';
    cwmp.match.phaseTimeLeft = 60;
    const cSpecById = (id: number): RobotSpec => cwmp.robots.find((r) => r.id === id)!.spec;
    for (let i = 0; i < 40; i++) chainStep(cwmp, SIM_DT, new Map());
    const cRebuilt = unslimWorld(slimWorld(cwmp), cwmp.balls, cSpecById);
    check('CR snapshot: game stays "chain" through slim/unslim', cRebuilt.game === 'chain');
    check(
      'CR snapshot: the chain state (catalysts/scored) survives serialization',
      !!cRebuilt.chain &&
        cRebuilt.chain.catalysts.length === cwmp.chain!.catalysts.length &&
        cRebuilt.chain.scored.blue === cwmp.chain!.scored.blue,
    );
    check('CR snapshot: reassembles to an identical worldHash', worldHash(cRebuilt) === worldHash(cwmp));
    // the client re-steps the CR world (reconcile replay) without throwing / NaN
    for (let i = 0; i < 20; i++) chainStep(cRebuilt, SIM_DT, new Map());
    check(
      'CR snapshot: stepping the reassembled CR world never NaNs a robot',
      cRebuilt.robots.every((r) => Number.isFinite(r.pos.x) && Number.isFinite(r.pos.y)),
    );
  }

  // ball delta codec (shared encodeBallDelta/applyBallDelta, PR2): encode changes
  // vs a client baseline, apply on the client's running baseline, compare.
  const snap = (): Artifact[] => w.balls.map((b) => JSON.parse(JSON.stringify(b)));
  const b0 = snap();
  const clientBase = new Map(b0.map((b) => [b.id, b])); // the client's running baseline
  const serverBaseA = new Map(b0.map((b) => [b.id, b])); // server's view of that same baseline
  for (let i = 0; i < 6; i++) step(w, SIM_DT, cmds); // move some balls
  const d1 = encodeBallDelta(serverBaseA, w.balls);
  const applied = applyBallDelta(clientBase, d1);
  check(
    'ball delta reconstructs the exact ball array (order + data)',
    JSON.stringify(applied) === JSON.stringify(w.balls),
    `sent ${d1.upd.length}/${w.balls.length} balls`,
  );
  const unchanged = w.balls.length - d1.upd.length;
  check(
    'ball delta sends only the moved balls (some changed, some idle)',
    d1.upd.length > 0 && unchanged > 0 && d1.upd.length < w.balls.length,
    `${d1.upd.length} changed, ${unchanged} idle`,
  );
  check('a null baseline yields a full keyframe (every ball in upd)', encodeBallDelta(null, w.balls).upd.length === w.balls.length);

  // ACK-KEYED / DROPPED-FRAME: the property the unreliable lane needs. A client sits
  // at baseline b0 and MISSES the intermediate frame; the next delta is encoded vs
  // b0 (the ack), NOT vs the skipped frame. It must still reconstruct the live world
  // exactly — proof a dropped snapshot can't corrupt a baseline keyed to the ack.
  {
    const droppedClient = new Map(b0.map((b) => [b.id, JSON.parse(JSON.stringify(b))]));
    const ackBaseline = new Map(b0.map((b) => [b.id, JSON.parse(JSON.stringify(b))]));
    for (let i = 0; i < 5; i++) step(w, SIM_DT, cmds); // world advances; client got NOTHING
    const dGap = encodeBallDelta(ackBaseline, w.balls); // server deltas vs the ACK, not last-sent
    const recon = applyBallDelta(droppedClient, dGap);
    check(
      'ack-keyed delta survives a dropped frame (reconstructs vs the acked baseline)',
      JSON.stringify(recon) === JSON.stringify(w.balls),
      `sent ${dGap.upd.length}/${w.balls.length}`,
    );
  }

  // ADD + REMOVE: a ball that despawns drops out of `order`; a new id shows up in
  // `upd`. Reconstruction must add the new one and prune the gone one.
  {
    const start: Artifact[] = w.balls.map((b) => JSON.parse(JSON.stringify(b)));
    const cbase = new Map(start.map((b) => [b.id, b]));
    const sbase = new Map(start.map((b) => [b.id, JSON.parse(JSON.stringify(b))]));
    const next = start.slice(1).map((b) => JSON.parse(JSON.stringify(b))) as Artifact[]; // drop the first
    const added = { ...JSON.parse(JSON.stringify(start[0])), id: 999999 } as Artifact; // a brand-new id
    next.push(added);
    const dAR = encodeBallDelta(sbase, next);
    const reconAR = applyBallDelta(cbase, dAR);
    check(
      'ball delta handles add + remove (new id sent, despawned id pruned)',
      JSON.stringify(reconAR) === JSON.stringify(next) &&
        dAR.upd.some((b) => b.id === 999999) &&
        !reconAR.some((b) => b.id === start[0].id),
    );
  }
}

// ---- predict/reconcile parity ----------------------------------------------
// The client replaces its world with a server snapshot at `serverTick`, then
// replays the local inputs it had buffered PAST that tick (remote robots default
// to ZERO in step()). The result must equal the authoritative world stepped with
// those same local inputs — this is exactly GameController.reconcile().
{
  const seed = 909;
  const setups = [setup(0, 'blue', {}, 0), setup(1, 'red', {}, 1)];
  const localStream = (t: number): RobotCommand =>
    cmd({ driveY: 0.8, rotate: 0.2, fire: t % 15 === 0 });

  // authoritative world: local robot driven, remote robot idle (ZERO)
  const auth = createWorld('match', seed, setups);
  startMatch(auth);
  for (let t = 1; t <= 100; t++) step(auth, SIM_DT, new Map([[0, localizeCommand(localStream(t))]]));
  const snap: World = JSON.parse(JSON.stringify(auth)); // the "server snapshot" at tick 100

  // authority runs 20 more ticks with the same local inputs
  const buffered: RobotCommand[] = [];
  for (let t = 101; t <= 120; t++) {
    const l = localizeCommand(localStream(t));
    buffered.push(l);
    step(auth, SIM_DT, new Map([[0, l]]));
  }

  // client reconciles: adopt the snapshot, replay the 20 buffered local inputs
  const client: World = JSON.parse(JSON.stringify(snap));
  for (const l of buffered) step(client, SIM_DT, new Map([[0, l]]));
  check(
    'reconcile replay reproduces the authoritative world exactly',
    worldHash(client) === worldHash(auth),
    `client=${worldHash(client)} auth=${worldHash(auth)}`,
  );
}

// ---- remote prediction reproduces robot-robot collisions --------------------
// The client predicts remote robots forward with their HELD command (not a
// render-time hack), so `step()` moves + COLLIDES them exactly like the server.
// Two robots seeded overlapping ⇒ collideRobots runs every tick; the client that
// replays with the held remote command must match the server bit-for-bit.
{
  const setups = [setup(0, 'blue', {}, 0), setup(1, 'red', {}, 0)];
  const mk = (): World => {
    const w = createWorld('match', 111, setups);
    startMatch(w);
    w.robots[0].pos = { x: 0, y: -5 }; // 10" apart, chassis ~18" ⇒ overlapping
    w.robots[1].pos = { x: 0, y: 5 };
    return w;
  };
  const c0 = localizeCommand(cmd({ driveY: 0.5, fire: true })); // local robot
  const c1 = localizeCommand(cmd({ driveX: -0.5, intake: true })); // remote robot (held)

  const auth = mk();
  for (let t = 1; t < 60; t++) step(auth, SIM_DT, new Map([[0, c0], [1, c1]]));
  const overlapStart = Math.hypot(
    auth.robots[0].pos.x - auth.robots[1].pos.x,
    auth.robots[0].pos.y - auth.robots[1].pos.y,
  );
  const snap: World = JSON.parse(JSON.stringify(auth));
  const buffered: RobotCommand[] = [];
  for (let t = 61; t <= 90; t++) {
    buffered.push(c0);
    step(auth, SIM_DT, new Map([[0, c0], [1, c1]]));
  }
  // client: snapshot + replay local(0) live and remote(1) HELD command
  const client: World = JSON.parse(JSON.stringify(snap));
  for (const l of buffered) step(client, SIM_DT, new Map([[0, l], [1, c1]]));
  check(
    'remote prediction (held command) reproduces the world incl. robot-robot collisions',
    worldHash(client) === worldHash(auth),
    `client=${worldHash(client)} auth=${worldHash(auth)}`,
  );
  check(
    'seeded-overlapping robots get separated by the sim (collision actually ran)',
    overlapStart > 10,
    `sep=${overlapStart.toFixed(1)}"`,
  );
}

// ---- server drop degrades cleanly (ZERO from the drop tick) -----------------
// a robot whose client left runs on ZERO and never stalls the others; the match
// keeps advancing and the world stays finite.
{
  const w = createWorld('match', 42, [setup(0, 'blue', {}, 0), setup(1, 'red', {}, 1)]);
  startMatch(w);
  // both robots active for a bit
  for (let t = 0; t < 60; t++) {
    step(w, SIM_DT, new Map([[0, cmd({ driveY: 1 })], [1, cmd({ driveX: 1 })]]));
  }
  const before = w.tick;
  // robot 1 "drops": server feeds only robot 0; robot 1 gets ZERO by default
  for (let t = 0; t < 120; t++) step(w, SIM_DT, new Map([[0, cmd({ driveY: -1 })]]));
  const r1 = w.robots[1];
  check(
    'a dropped robot keeps the sim advancing (no stall) and stays finite',
    w.tick === before + 120 && Number.isFinite(r1.pos.x) && Number.isFinite(r1.pos.y),
    `tick=${w.tick} r1=(${r1.pos.x.toFixed(1)},${r1.pos.y.toFixed(1)})`,
  );
}

// ---- DUO RECORD REMATCH: a vote, not one driver's decision ------------------
// A co-op run belongs to both people, so neither may restart it out from under the
// other — mid-match or from the results screen. Everyone toggles their own vote and
// the run only restarts on unanimity. The generation guard is what makes restarting
// a LIVE match safe: a rebuild starts at tick 0, so inputs still in flight from the
// old match carry tick numbers the new one will reach minutes later.
{
  const msgs: Record<string, ServerMsg[]> = { d1: [], d2: [] };
  const mkD = (id: string): Client => ({
    id,
    send: (m) => msgs[id].push(m),
    player: { clientId: id, name: id, teamName: 'T', teamNumber: 1, alliance: 'blue', startIndex: 0, ready: true, spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS } },
    connected: true, disconnectAt: 0, userId: `u-${id}`,
  });
  const room = new Room('smoke-duo', () => {}, { kind: 'record', record: 'duo' });
  room.add(mkD('d1'));
  room.add(mkD('d2'));
  room.onMessage('d1', { t: 'start' });
  room.advanceForTest(30);
  const gen0 = (msgs.d1.find((m) => m.t === 'matchStart') as Extract<ServerMsg, { t: 'matchStart' }>).gen;
  check('duo rematch: the match is stamped with a generation', typeof gen0 === 'number');

  const tally = (id: string) =>
    [...msgs[id]].reverse().find((m) => m.t === 'rematch') as Extract<ServerMsg, { t: 'rematch' }> | undefined;

  // ONE driver voting is not enough, and BOTH are told the count
  room.onMessage('d1', { t: 'rematch', on: true });
  check('duo rematch: one vote reads 1/2', tally('d1')?.votes === 1 && tally('d1')?.need === 2);
  check('duo rematch: the PARTNER is told too (that is the point of showing 1/2)',
    tally('d2')?.votes === 1 && tally('d2')?.need === 2);
  check('duo rematch: each side is told whether the vote is THEIRS',
    tally('d1')?.you === true && tally('d2')?.you === false);
  check('duo rematch: one vote does NOT restart the run', room.tick > 0);

  // ...and a vote can be TAKEN BACK
  room.onMessage('d1', { t: 'rematch', on: false });
  check('duo rematch: a vote can be un-pressed', tally('d1')?.votes === 0 && tally('d1')?.you === false);

  // unanimity restarts, mid-match, with a fresh generation
  room.onMessage('d1', { t: 'rematch', on: true });
  msgs.d1.length = 0;
  room.onMessage('d2', { t: 'rematch', on: true });
  const restarted = msgs.d1.find((m) => m.t === 'matchStart') as Extract<ServerMsg, { t: 'matchStart' }> | undefined;
  check('duo rematch: BOTH votes restart the run mid-match', !!restarted);
  check('duo rematch: ...at tick 0 again', room.tick === 0, String(room.tick));
  check('duo rematch: ...with a NEW generation (stale inputs become identifiable)',
    (restarted?.gen ?? 0) > (gen0 ?? 0));
  check('duo rematch: ...and a fresh seed, so it is a new run not a replay',
    restarted?.seed !== undefined);
  const after = tally('d1');
  check('duo rematch: the tally resets after a restart', (after?.votes ?? 1) === 0);

  // THE GENERATION GUARD: an input stamped with the old match must not be applied
  // to the new one, even though its tick is perfectly plausible here.
  const gNew = restarted?.gen ?? 1;
  const drive = quantizeCommand({ driveX: 1, driveY: 1, rotate: 0, intake: false, fire: false });
  const posOf = (): { x: number; y: number } => {
    const r = room.worldForTest()?.robots.find((x) => x.id === 0);
    return { x: r?.pos.x ?? 0, y: r?.pos.y ?? 0 };
  };
  // clear the pre-match countdown FIRST — robots are frozen during it, so measuring
  // "did the input move anything" before auto begins measures nothing at all (the
  // first cut of this check did exactly that and read a 0.1in physics settle as a
  // pass on one line and a failure on the next)
  room.advanceForTest(Math.ceil(C_PRE_COUNTDOWN / SIM_DT) + 30);
  const base = posOf();
  const t0 = room.tick;
  for (let t = t0 + 1; t <= t0 + 60; t++) room.onMessage('d1', { t: 'input', tick: t, q: drive, gen: gNew - 1 });
  room.advanceForTest(60);
  const afterStale = posOf();
  check('duo rematch: a STALE-generation input moves nothing',
    Math.hypot(afterStale.x - base.x, afterStale.y - base.y) < 0.5,
    `moved ${Math.hypot(afterStale.x - base.x, afterStale.y - base.y).toFixed(3)}`);
  // positive control: the SAME command at the CURRENT generation DOES move it, so
  // the check above is measuring the guard rather than a robot that cannot drive
  const t1 = room.tick;
  for (let t = t1 + 1; t <= t1 + 60; t++) room.onMessage('d1', { t: 'input', tick: t, q: drive, gen: gNew });
  room.advanceForTest(60);
  const afterFresh = posOf();
  check('duo rematch: ...while a CURRENT-generation input does move it',
    Math.hypot(afterFresh.x - afterStale.x, afterFresh.y - afterStale.y) > 2,
    `moved ${Math.hypot(afterFresh.x - afterStale.x, afterFresh.y - afterStale.y).toFixed(2)}`);

  // a versus room must NOT accept the vote at all — "both agree" is a co-op idea,
  // and in a rated match it would just be a coercion surface
  const vs: ServerMsg[] = [];
  const vroom = new Room('smoke-vs-rematch', () => {}, { kind: 'versus' });
  vroom.add({ ...mkD('v1'), send: (m) => vs.push(m) });
  vroom.onMessage('v1', { t: 'rematch', on: true });
  check('duo rematch: a VERSUS room ignores the vote entirely', !vs.some((m) => m.t === 'rematch'));
}

// ---- MAINTENANCE LOCKDOWN: when the window actually bites -------------------
// The scheduling semantics are the whole feature: an armed window with a FUTURE
// start must announce itself WITHOUT locking anyone out (otherwise it is just an
// outage with extra steps), and an expired one must stop biting on its own so a
// lockdown somebody forgets to lift cannot strand the service.
{
  const w = (over: Partial<Parameters<typeof maintenanceBiting>[0]> = {}) => ({
    active: true, startsAt: null, endsAt: null, message: '', ...over,
  });
  const T = 1_000_000;
  check('maintenance: inactive never bites', !maintenanceBiting(w({ active: false }), T));
  check('maintenance: active with no window bites now', maintenanceBiting(w(), T));
  check('maintenance: SCHEDULED (future start) does NOT lock anyone out yet',
    !maintenanceBiting(w({ startsAt: T + 60_000 }), T));
  check('maintenance: ...and does once its start passes',
    maintenanceBiting(w({ startsAt: T - 1 }), T));
  check('maintenance: an EXPIRED window stops biting by itself',
    !maintenanceBiting(w({ startsAt: T - 60_000, endsAt: T - 1 }), T));
  check('maintenance: inside the window it bites',
    maintenanceBiting(w({ startsAt: T - 60_000, endsAt: T + 60_000 }), T));

  // the copy players read is the part they act on, so it is asserted too
  const line = (over: Record<string, unknown>, now: number) =>
    maintenanceLine({ startsAt: null, endsAt: null, message: 'Season reset', biting: false, ...over } as never, now);
  check('maintenance: a live window says new games are paused',
    (line({ biting: true }, T) ?? '').includes('paused'));
  check('maintenance: a scheduled one counts down instead of claiming to be live',
    (line({ startsAt: T + 5 * 60_000 }, T) ?? '').includes('5 minutes'));
  check('maintenance: nothing scheduled renders nothing at all', line({}, T) === null);
  check('maintenance: the operator message is carried through to players',
    (line({ biting: true }, T) ?? '').includes('Season reset'));
}

// ---- SOURCE GUARD: no engine-defined math anywhere the sim can reach --------
// The accuracy checks below prove `dsin`/`dcos`/`datan2` are good replacements.
// They do NOT prove anyone USED them, and that is the gap this closes: six
// `Math.hypot` calls had drifted into drivetrain/field/physics/CR-penalties, one
// of them in `motorStep` — every robot, every tick. `Math.hypot` is not
// correctly-rounded, so its result is the engine's choice; the sim then produces
// a different match on an engine that chooses differently, which is a desync in
// live play (the client predicts) and a wrong game on replay (recorded in Node,
// re-simulated in a browser). Swapping those six to `hyp` measurably moved a
// match score, so this is load-bearing, not hygiene.
//
// A grep, deliberately: the rule is "don't write this", and only reading the
// source can check it. `Math.round/floor/ceil/abs/min/max/sqrt/sign/trunc/imul`
// are IEEE-exact and stay allowed.
{
  const BANNED = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'hypot',
    'pow', 'exp', 'expm1', 'log', 'log2', 'log10', 'log1p', 'cbrt', 'fround', 'random'];
  const rx = new RegExp(`Math\\.(${BANNED.join('|')})\\s*\\(`);
  const roots = ['src/sim', 'src/games'];
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = joinPath(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.ts') || e.name.endsWith('.d.ts')) continue;
      // renderers are NOT sim-reachable — they read world state and draw it, so
      // an engine-specific cosine there changes pixels, never the match
      if (/^(draw|render)/i.test(e.name)) continue;
      readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        if (rx.test(code)) offenders.push(`${p}:${i + 1}`);
      });
    }
  };
  for (const r of roots) walk(r);
  check(
    'sim source uses NO engine-defined Math (hypot/sin/cos/pow/random/…) — cross-engine desync',
    offenders.length === 0,
    offenders.join(', '),
  );
  // and the sim must not read wall-clock time either (same determinism contract)
  const clockers: string[] = [];
  const walkClock = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = joinPath(dir, e.name);
      if (e.isDirectory()) { walkClock(p); continue; }
      if (!e.name.endsWith('.ts') || /^(draw|render)/i.test(e.name)) continue;
      readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        if (/\bDate\.now\s*\(|\bnew Date\s*\(|performance\.now\s*\(/.test(code)) clockers.push(`${p}:${i + 1}`);
      });
    }
  };
  for (const r of roots) walkClock(r);
  check('sim source reads NO wall clock (Date/performance) — replays must be pure', clockers.length === 0, clockers.join(', '));
}

// ---- deterministic trig: cross-engine lockstep needs Math-free sin/cos/atan2 -
// (Math.sin/cos/tan/atan2 are not correctly-rounded, so they differ across
// browsers and fork a lockstep sim; dsin/dcos/dtan/datan2 are pure +,-,*,/ )
{
  let maxSin = 0;
  let maxCos = 0;
  let maxTan = 0;
  let maxAtan2 = 0;
  for (let i = 0; i < 4001; i++) {
    const x = (i / 4000 - 0.5) * 40 * Math.PI; // ±20π, exercises range reduction
    maxSin = Math.max(maxSin, Math.abs(dsin(x) - Math.sin(x)));
    maxCos = Math.max(maxCos, Math.abs(dcos(x) - Math.cos(x)));
    if (Math.abs(Math.cos(x)) > 0.2) maxTan = Math.max(maxTan, Math.abs(dtan(x) - Math.tan(x)));
  }
  for (let i = -40; i <= 40; i++) {
    for (let j = -40; j <= 40; j++) {
      if (i === 0 && j === 0) continue;
      let d = datan2(i, j) - Math.atan2(i, j);
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      maxAtan2 = Math.max(maxAtan2, Math.abs(d));
    }
  }
  check('dsin matches Math.sin (<1e-9) across ±20π', maxSin < 1e-9, maxSin.toExponential(2));
  check('dcos matches Math.cos (<1e-9) across ±20π', maxCos < 1e-9, maxCos.toExponential(2));
  check('dtan matches Math.tan (<1e-7) away from asymptotes', maxTan < 1e-7, maxTan.toExponential(2));
  check('datan2 matches Math.atan2 (<1e-7) over all quadrants', maxAtan2 < 1e-7, maxAtan2.toExponential(2));
  // determinism proper: pure arithmetic ⇒ identical on repeat (no engine state)
  check('deterministic trig is referentially stable', dsin(1.2345) === dsin(1.2345) && datan2(3, -4) === datan2(3, -4));
}

// ---- replays + record-chasing (Phase 3 foundation) -------------------------
{
  // a scripted driver that varies its command (so tracks hold multiple entries)
  // and fires + intakes throughout — the start poses sit in the launch zone with
  // a preloaded hopper, so this scores real points to compare on.
  const drive: CommandSource = (tick) => {
    const seg = Math.floor(tick / 37) % 4;
    const c: RobotCommand = {
      driveX: seg === 1 ? 0.5 : 0,
      driveY: seg === 2 ? -0.4 : 0,
      rotate: seg === 3 ? 0.3 : 0,
      intake: true,
      fire: true,
    };
    const m = new Map<number, RobotCommand>();
    for (const r of [0, 1]) m.set(r, c);
    return m;
  };

  // recordSetups shape
  const solo = recordSetups(DEFAULT_SPEC, 'solo', DEFAULT_ASSISTS, undefined, true);
  const duo = recordSetups(DEFAULT_SPEC, 'duo', DEFAULT_ASSISTS, undefined, true);
  check('recordSetups solo = 1 robot (1v0)', solo.length === 1 && solo[0].id === 0);
  check(
    'recordSetups duo = 2 robots at distinct poses',
    duo.length === 2 && duo[0].startIndex !== duo[1].startIndex,
  );
  // each duo driver brings their OWN build — a duo can mix drivetrains
  const mixedDuo = recordSetups(
    { ...DEFAULT_SPEC, drivetrain: 'tank' },
    'duo',
    DEFAULT_ASSISTS,
    undefined,
    true,
    undefined,
    { ...DEFAULT_SPEC, drivetrain: 'swerve' },
  );
  check(
    'recordSetups duo keeps each driver’s own drivetrain',
    mixedDuo[0].spec.drivetrain === 'tank' && mixedDuo[1].spec.drivetrain === 'swerve',
  );

  // recordScore: an opponent-free run's NET score subtracts the player's OWN
  // fouls (awarded to the empty opposing alliance), clamped at 0
  {
    const r: ReplayResult = { score: { blue: 90, red: 0 }, foulPoints: { blue: 0, red: 20 }, hash: 0, ticks: 0 };
    check('recordScore subtracts the player\'s own penalties from the net score', recordScore(r, 'blue') === 70, `${recordScore(r, 'blue')}`);
    const r2: ReplayResult = { score: { blue: 10, red: 0 }, foulPoints: { blue: 0, red: 45 }, hash: 0, ticks: 0 };
    check('recordScore clamps a penalty-heavy run at 0 (never negative)', recordScore(r2, 'blue') === 0, `${recordScore(r2, 'blue')}`);
  }

  // full SOLO record match → re-simulate → byte-identical (the core guarantee)
  const run = runRecordMatch(0x51ce, solo, drive);
  check('record match runs to phase "post"', run.world.match.phase === 'post');
  check('replay stamped with format + balance version', run.replay.format === REPLAY_FORMAT && run.replay.balanceVersion === BALANCE_VERSION);
  // the SIM-BEHAVIOUR stamp: what decides whether THIS build can re-simulate the
  // log at all. Separate from balanceVersion so a determinism fix can invalidate
  // stale replays without resetting the competitive season (config.ts SIM_VERSION).
  check('replay stamped with the sim-behaviour version', run.replay.sim === SIM_VERSION);
  check('...and a replay with no sim stamp reads as 0, never as current',
    ((({ ...run.replay, sim: undefined }) as Replay).sim ?? 0) === 0);
  const entries0 = (run.replay.tracks[0]?.length ?? 0) / 5;
  check('replay recorded a non-trivial run', run.replay.ticks > 1000 && entries0 >= 2);
  check('replay hold-last compresses (entries << ticks)', entries0 * 20 < run.replay.ticks, `${entries0} entries / ${run.replay.ticks} ticks`);
  check('record run scored points to compare on', run.result.score.blue > 0, `blue ${run.result.score.blue}`);

  const v = verifyReplay(run.replay);
  check('verifyReplay reproduces the final worldHash', v.hash === run.result.hash, `${v.hash} vs ${run.result.hash}`);
  check('verifyReplay reproduces the score', v.score.blue === run.result.score.blue && v.score.red === run.result.score.red);
  check('verifyReplay reproduces the tick count', v.ticks === run.result.ticks);

  // ---- WHOSE VIEW the replay is watched from ------------------------------
  // The camera swings a full 180° between alliances, so the wrong seat shows every
  // robot at the wrong end of the field driving the wrong way — which reads, to the
  // person who played it, as the replay having DIVERGED. The viewer defaulted to
  // setups[0], and a staged 1v1 roster always puts red at index 0, so it was wrong
  // for exactly the blue player in every match: the two people in one match saw
  // mirror images of the same replay.
  {
    const vs = [
      { id: 0, alliance: 'red' as Alliance, spec: DEFAULT_SPEC, assists: DEFAULT_ASSISTS, startIndex: 0 },
      { id: 1, alliance: 'blue' as Alliance, spec: DEFAULT_SPEC, assists: DEFAULT_ASSISTS, startIndex: 1 },
    ];
    check('viewpoint: the RED driver watches from red', replayViewpoint(vs, 0).alliance === 'red');
    check('viewpoint: the BLUE driver watches from BLUE, not from roster order',
      replayViewpoint(vs, 1).alliance === 'blue' && replayViewpoint(vs, 1).robotId === 1);
    check('viewpoint: the two drivers get OPPOSITE cameras (the bug: they got the same one)',
      replayViewpoint(vs, 0).alliance !== replayViewpoint(vs, 1).alliance);
    check('viewpoint: ...and each is marked as their OWN robot',
      replayViewpoint(vs, 0).robotId === 0 && replayViewpoint(vs, 1).robotId === 1);
    // a non-participant (leaderboard link) has no seat — fall back to the first
    // setup, which is right for the opponent-free record runs that fill the boards
    check('viewpoint: a watcher who was not in the match falls back to setups[0]',
      replayViewpoint(vs).alliance === 'red' && replayViewpoint(vs, null).alliance === 'red');
    check('viewpoint: an unknown robot id falls back rather than throwing',
      replayViewpoint(vs, 99).robotId === 0);
    check('viewpoint: a solo record run reads its own alliance',
      replayViewpoint([{ id: 0, alliance: 'blue' as Alliance, spec: DEFAULT_SPEC, assists: DEFAULT_ASSISTS, startIndex: 0 }]).alliance === 'blue');
  }

  // referential determinism: a second re-sim is identical
  check('simulateReplay is referentially stable', worldHash(simulateReplay(run.replay)) === v.hash);

  // CHAIN REACTION replays: a CR run must re-simulate through the CR module (createWorld +
  // chainStep), stamp game:'chain', and reproduce its outcome byte-for-byte (the replay is
  // watchable + verifiable exactly like a DECODE one).
  {
    const crSetups = [
      { id: 0, alliance: 'blue' as Alliance, spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS }, startIndex: 0 },
    ];
    const crRun = runRecordMatch(0xc4a1, crSetups, drive, { game: 'chain' });
    check('CR replay: stamped game "chain"', crRun.replay.game === 'chain');
    check('CR replay: runs to phase "post"', crRun.world.match.phase === 'post' && crRun.world.game === 'chain');
    const crV = verifyReplay(crRun.replay);
    check('CR replay: verifyReplay reproduces the final worldHash', crV.hash === crRun.result.hash, `${crV.hash} vs ${crRun.result.hash}`);
    check('CR replay: simulateReplay is referentially stable', worldHash(simulateReplay(crRun.replay)) === crV.hash);
    // a DECODE and a CR replay of the SAME seed diverge (different sim module) — proves the
    // module is actually chosen from replay.game, not hardcoded.
    check('CR replay: re-sims via the chain module (differs from a decode re-sim)', crV.hash !== v.hash);
  }

  // DUO (2v0) short run: two command tracks, both re-simulate deterministically
  const duoRun = runRecordMatch(0xd0, duo, drive, { stopTick: 700 });
  check('duo replay has a track per robot', !!duoRun.replay.tracks[0] && !!duoRun.replay.tracks[1]);
  check('duo replay re-simulates deterministically', verifyReplay(duoRun.replay).hash === duoRun.result.hash);
}

// ---- server-side recording via a real Room (Phase 3 server spine) ----------
{
  const msgs: ServerMsg[] = [];
  const host: Client = {
    id: 'host-1',
    send: (m) => msgs.push(m),
    player: {
      clientId: 'host-1',
      name: 'Rec',
      teamName: 'T',
      teamNumber: 1,
      alliance: 'red', // record must FORCE this to blue (co-op, opponent-free)
      startIndex: 0,
      ready: true,
      spec: { ...DEFAULT_SPEC },
      assists: { ...DEFAULT_ASSISTS },
    },
    connected: true,
    disconnectAt: 0,
  };
  const room = new Room('smoke-rec', () => {}, { kind: 'record', record: 'solo' });
  check('record-solo room caps the roster at 1', room.canJoin());
  room.add(host);
  check('record-solo room is full after 1 driver', !room.canJoin());
  room.onMessage('host-1', { t: 'start' });
  // pre-load a fire+intake command for every tick so the run scores real points
  const cap = maxMatchTicks();
  const fire = quantizeCommand({ driveX: 0, driveY: 0, rotate: 0, intake: true, fire: true });
  for (let t = 1; t <= cap; t++) room.onMessage('host-1', { t: 'input', tick: t, q: fire });
  room.advanceForTest(cap + 5);

  const res = msgs.find((m) => m.t === 'matchResult');
  check('server Room emits a matchResult at match end', !!res);
  if (res && res.t === 'matchResult') {
    check('matchResult tagged kind=record / solo', res.kind === 'record' && res.record === 'solo');
    check(
      'record forces the run onto blue (opponent-free, red player → blue robot)',
      res.result.score.blue > 0 && res.result.score.red === 0,
      `blue ${res.result.score.blue} red ${res.result.score.red}`,
    );
    check(
      'server-recorded replay re-simulates to the authoritative world',
      verifyReplay(res.replay).hash === res.result.hash,
      `${verifyReplay(res.replay).hash} vs ${res.result.hash}`,
    );
    check('server replay stamped with balance version', res.replay.balanceVersion === BALANCE_VERSION);
  }
}

// ---- a MULTIPLAYER match's replay must re-simulate exactly ------------------
// The check above covers a solo record room: ONE robot, one input stream, no
// robot-robot contact. That is the easy half, and it was the only half covered —
// so nothing was watching the case the desync report was actually about. A versus
// room runs two independently-commanded robots that shove each other through
// Rapier, which is where a recording gap (a command applied but not logged, or
// logged at the wrong tick) would actually show up.
{
  const msgs: ServerMsg[] = [];
  const mkVs = (id: string, alliance: Alliance): Client => ({
    id,
    send: (m) => msgs.push(m),
    player: {
      clientId: id, name: id, teamName: 'T', teamNumber: 1, alliance,
      startIndex: alliance === 'red' ? 0 : 1, ready: true,
      spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS },
    },
    connected: true, disconnectAt: 0, userId: `u-${id}`,
  });
  const room = new Room('smoke-vs-replay', () => {}, { kind: 'versus' });
  room.add(mkVs('va', 'red'));
  room.add(mkVs('vb', 'blue'));
  room.onMessage('va', { t: 'start' });
  // two DIFFERENT time-varying streams, so the robots genuinely interact rather
  // than sitting on their start poses running identical inputs
  const vcap = maxMatchTicks();
  for (let t = 1; t <= vcap; t++) {
    room.onMessage('va', { t: 'input', tick: t, q: quantizeCommand({ driveX: dsin(t / 37), driveY: dcos(t / 53), rotate: dsin(t / 91), intake: true, fire: t % 7 === 0 }) });
    room.onMessage('vb', { t: 'input', tick: t, q: quantizeCommand({ driveX: dcos(t / 41), driveY: dsin(t / 29), rotate: dcos(t / 67), intake: t % 3 !== 0, fire: t % 11 === 0 }) });
  }
  room.advanceForTest(vcap + 400);
  const vres = msgs.find((m) => m.t === 'matchResult');
  check('versus Room emits a matchResult', !!vres);
  if (vres && vres.t === 'matchResult') {
    const rv = verifyReplay(vres.replay);
    check('MULTIPLAYER replay re-simulates to the authoritative world (no desync)',
      rv.hash === vres.result.hash, `${rv.hash} vs ${vres.result.hash}`);
    check('multiplayer replay reproduces BOTH alliances’ scores',
      rv.score.red === vres.result.score.red && rv.score.blue === vres.result.score.blue,
      `${JSON.stringify(rv.score)} vs ${JSON.stringify(vres.result.score)}`);
    check('multiplayer replay reproduces the tick count', rv.ticks === vres.result.ticks);
    check('multiplayer replay logged a track per robot', Object.keys(vres.replay.tracks).length === 2);
    check('multiplayer replay is a real contested match (both sides scored)',
      vres.result.score.red > 0 && vres.result.score.blue > 0,
      JSON.stringify(vres.result.score));
  }
}

// ---- mid-match reconnect race: fast rejoin before the dropped socket is reaped -
// A transient network drop breaks the client's TCP, it reconnects in ~1s and sends
// `rejoin` — but the server often hasn't reaped the OLD socket yet (a partitioned
// connection lingers for tens of seconds). Reattach must take over anyway (the
// clientId proves ownership), and the stale old socket's later close must NOT knock
// the reconnected player offline. Covers both duo-record and versus (same code path).
{
  const a2: ServerMsg[] = []; // messages to the RECONNECTED 'a' socket
  const b1: ServerMsg[] = []; // messages to 'b' (watch for roster churn)
  const mkC = (id: string, alliance: 'red' | 'blue', sink: ServerMsg[]): Client => ({
    id,
    send: (m) => sink.push(m),
    player: { clientId: id, name: id, teamName: 'T', teamNumber: 1, alliance, startIndex: 0, ready: true, spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS } },
    connected: true,
    disconnectAt: 0,
    userId: `u-${id}`,
  });
  const room = new Room('smoke-reconnect', () => {}, { kind: 'versus' });
  const a = mkC('a', 'red', []);
  const b = mkC('b', 'blue', b1);
  room.add(a);
  room.add(b);
  room.onMessage('a', { t: 'start' }); // host 'a' starts the match (world != null)
  room.advanceForTest(30); // a few live ticks, then the real-time loop is stopped

  const oldConn = a.conn; // the connection stamp issued to the ORIGINAL socket
  // 'a' drops but its old socket is NOT reaped yet (no detach). The client reconnects
  // on a fresh socket and reattaches — this used to be REFUSED (c.connected still true).
  const nc = room.reattach('a', (m) => a2.push(m));
  check('reconnect: fast rejoin reclaims the slot even while it still shows connected', nc !== null && nc !== oldConn);
  check('reconnect: the reconnected socket gets an immediate resync snapshot', a2.some((m) => m.t === 'snapshot'));

  b1.length = 0; // watch for roster churn caused by a (mis)handled close
  room.detach('a', oldConn); // the STALE old socket finally closes — must be ignored
  check('reconnect: the stale old-socket close is ignored (no disconnect churn)', !b1.some((m) => m.t === 'roster'));
  // positive control: a close carrying the CURRENT conn IS honoured (broadcasts roster)
  room.detach('a', nc as number);
  check('reconnect: the current socket close is honoured (roster broadcast)', b1.some((m) => m.t === 'roster'));

  check('reconnect: reattach on an unknown/gone slot returns null (→ rejoined:false)', room.reattach('ghost', () => {}) === null);
}

// ---- SPECTATING: a read-only watcher gets the stream, affects nothing -----------
{
  const mkDriver = (id: string, alliance: Alliance, sink: ServerMsg[]): Client => ({
    id,
    send: (m) => sink.push(m),
    player: { clientId: id, name: id, teamName: 'Team ' + id, teamNumber: 7, alliance, startIndex: 0, ready: true, spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS } },
    connected: true,
    disconnectAt: 0,
    userId: `u-${id}`,
  });
  const room = new Room('smoke-spec', () => {}, { kind: 'versus' });
  const rosterA: ServerMsg[] = [];
  const rosterB: ServerMsg[] = [];
  room.add(mkDriver('a', 'red', rosterA));
  room.add(mkDriver('b', 'blue', rosterB));
  room.onMessage('a', { t: 'start' });
  room.advanceForTest(20);

  // a spectator joins mid-match
  const spec: ServerMsg[] = [];
  const specClient: Client = { id: 'watch-1', send: (m) => spec.push(m), player: { clientId: 'watch-1', name: 'Watcher', teamName: '', teamNumber: 0, alliance: 'blue', startIndex: 0, ready: false, spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS } }, connected: true, disconnectAt: 0 };
  room.addSpectator(specClient);
  const ms = spec.find((m) => m.t === 'matchStart') as Extract<ServerMsg, { t: 'matchStart' }> | undefined;
  check('spectate: the spectator receives matchStart with yourRobotId -1 (no slot)', ms?.yourRobotId === -1);
  check('spectate: the spectator gets an immediate snapshot', spec.some((m) => m.t === 'snapshot'));

  // it must not appear on the roster (drivers only) nor block a would-be joiner
  rosterA.length = 0;
  room.advanceForTest(6); // more live ticks → more snapshots to the spectator
  const specSnaps = spec.filter((m) => m.t === 'snapshot').length;
  check('spectate: the watcher keeps receiving the live snapshot stream', specSnaps >= 2, `snaps=${specSnaps}`);
  const lastRoster = [...rosterB].reverse().find((m) => m.t === 'roster') as Extract<ServerMsg, { t: 'roster' }> | undefined;
  check('spectate: spectators are NOT on the driver roster', (lastRoster?.players.length ?? 2) === 2);

  // Room.summary() lists the live match for the Watch Live list
  const sum = room.summary();
  check('spectate: Room.summary() reports the live match', sum !== null && sum.mode === '1v1' && sum.spectators === 1 && sum.players.length === 2);

  // players are TOLD how many people are watching — edge-triggered, not on the
  // snapshot path (it moves a handful of times a match; the hot loop runs at 30 Hz)
  const specMsgs = (sink: ServerMsg[]): Extract<ServerMsg, { t: 'spectators' }>[] =>
    sink.filter((m) => m.t === 'spectators') as Extract<ServerMsg, { t: 'spectators' }>[];
  check('spectate: players are told the watcher count', specMsgs(rosterB).slice(-1)[0]?.n === 1);

  // HIDDEN ADMIN OBSERVER: an operator can watch a suspected cheat without the
  // count announcing their arrival — which is the whole point, since a count that
  // ticks up is itself the tip-off. Server-set only; there is no client path to it.
  rosterB.length = 0;
  const hidden: ServerMsg[] = [];
  room.addSpectator({ id: 'admin-1', send: (m) => hidden.push(m), player: { clientId: 'admin-1', name: 'Admin', teamName: '', teamNumber: 0, alliance: 'blue', startIndex: 0, ready: false, spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS } }, connected: true, disconnectAt: 0 });
  room.hideSpectator('admin-1');
  check('spectate: a hidden observer is NOT in the visible count', room.visibleSpectators() === 1);
  check('spectate: ...nor in the Watch Live card', room.summary()?.spectators === 1);
  check('spectate: ...and the hidden observer still gets the live stream', hidden.some((m) => m.t === 'snapshot'));
  // the count went 1 -> 2 -> 1 across the hide, so players must end on 1 and must
  // NOT have been left believing a phantom watcher is present
  check('spectate: players end up back at the honest count after a hide',
    (specMsgs(rosterB).slice(-1)[0]?.n ?? 1) === 1);

  // the spectator leaving is clean and never touches the match
  room.detach('watch-1');
  check('spectate: after the watcher leaves, the match summary drops the spectator', (room.summary()?.spectators ?? 1) === 0);
  check('spectate: a room with ONLY a hidden observer reads as unwatched', room.visibleSpectators() === 0);

  // ---- the operator snapshot: signed-in by id, anonymous by COUNT --------
  // The privacy line lives here rather than in the UI: an anonymous session gets
  // no identifier at any layer, so there is nothing for a later feature to
  // accidentally surface. See 0021_presence_detail.sql.
  {
    const r2 = new Room('smoke-opsnap', () => {}, { kind: 'versus' });
    r2.add(mkDriver('signed', 'red', []));
    r2.add({ id: 'guest', send: () => {}, player: { clientId: 'guest', name: 'Guest', teamName: '', teamNumber: 0, alliance: 'blue', startIndex: 0, ready: true, spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS } }, connected: true, disconnectAt: 0 });
    const snap = r2.presenceSnapshot();
    check('operator snapshot: the signed-in driver is listed by account id',
      snap.players.length === 1 && snap.players[0].userId === 'u-signed');
    // GUESTS ARE ROWS NOW (operator's call), keyed by the per-socket connection id —
    // not an IP, not a fingerprint, and gone when the socket closes. It separates two
    // live sessions; it cannot connect either to a past one.
    check('operator snapshot: the anonymous driver is a ROW, keyed by connection id',
      snap.guests.length === 1 && snap.guests[0].id === 'guest');
    check('operator snapshot: ...and carries no display name or account id',
      !('userId' in snap.guests[0]) && !('name' in snap.guests[0]));
    check('operator snapshot: a lobby reads as "lobby", not "match"',
      snap.players[0].act === 'lobby' && snap.guests[0].act === 'lobby');
    r2.onMessage('signed', { t: 'start' });
    r2.advanceForTest(3);
    const after = r2.presenceSnapshot();
    check('operator snapshot: once the match runs BOTH read as "match"',
      after.players[0].act === 'match' && after.guests[0].act === 'match');
  }
}

// ---- snapshot ACK channel + self-healing keyframe (PR2) ---------------------
// A client piggybacks its newest-applied snapshot tick as `ack` on `input`. The
// happy path still deltas vs the last broadcast, but a client whose CONFIRMED
// baseline falls > ACK_STALE_TICKS behind is force-resynced with a full keyframe.
{
  const aMsgs: ServerMsg[] = [];
  const bMsgs: ServerMsg[] = [];
  const mkC = (id: string, alliance: 'red' | 'blue', sink: ServerMsg[]): Client => ({
    id,
    send: (m) => sink.push(m),
    player: { clientId: id, name: id, teamName: 'T', teamNumber: 1, alliance, startIndex: 0, ready: true, spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS } },
    connected: true,
    disconnectAt: 0,
    userId: `u-${id}`,
  });
  const room = new Room('smoke-ack', () => {}, { kind: 'versus' });
  room.add(mkC('a', 'red', aMsgs));
  room.add(mkC('b', 'blue', bMsgs));
  room.onMessage('a', { t: 'start' });
  room.advanceForTest(4);

  const q = quantizeCommand(cmd({}));
  const lastSnap = (arr: ServerMsg[]): Extract<ServerMsg, { t: 'snapshot' }> | undefined =>
    [...arr].reverse().find((m) => m.t === 'snapshot') as Extract<ServerMsg, { t: 'snapshot' }> | undefined;
  aMsgs.length = 0;
  bMsgs.length = 0;
  // 'a' is WEDGED — it keeps acking tick 0 forever; 'b' acks the latest each round.
  for (let round = 0; round < 22; round++) {
    const t = lastSnap(bMsgs)?.serverTick ?? 0;
    room.onMessage('a', { t: 'input', tick: 10_000 + round, q, ack: 0 });
    room.onMessage('b', { t: 'input', tick: 10_000 + round, q, ack: t });
    room.advanceForTest(30);
  }
  const recent = (arr: ServerMsg[], n: number): Extract<ServerMsg, { t: 'snapshot' }>[] =>
    (arr.filter((m) => m.t === 'snapshot') as Extract<ServerMsg, { t: 'snapshot' }>[]).slice(-n);
  const aKeyframes = recent(aMsgs, 5).every((s) => s.balls.upd.length === s.balls.order.length);
  const bDeltas = recent(bMsgs, 5).some((s) => s.balls.upd.length < s.balls.order.length);
  check('ack self-heal: a client whose confirmed baseline goes stale gets full keyframes', aKeyframes);
  check('ack channel: a client that keeps acking still gets incremental deltas (no regression)', bDeltas);
  // an OLD client that never sends `ack` must not be force-keyframed — its ack stays
  // unknown, so the stale check never fires (it keeps getting normal deltas)
  const cMsgs: ServerMsg[] = [];
  const room2 = new Room('smoke-ack-legacy', () => {}, { kind: 'versus' });
  room2.add(mkC('a', 'red', cMsgs));
  room2.add(mkC('b', 'blue', []));
  room2.onMessage('a', { t: 'start' });
  room2.advanceForTest(4);
  cMsgs.length = 0;
  for (let round = 0; round < 22; round++) {
    room2.onMessage('a', { t: 'input', tick: 20_000 + round, q }); // NO ack field (old client)
    room2.advanceForTest(30);
  }
  const legacyDeltas = recent(cMsgs, 5).some((s) => s.balls.upd.length < s.balls.order.length);
  check('ack channel: an ack-less legacy client is never force-keyframed', legacyDeltas);
}

// ---- single live game per user + restart disabled (server enforcement) ------
{
  const active: string[] = [];
  const inactive: string[] = [];
  const msgs: ServerMsg[] = [];
  const client: Client = {
    id: 'c1',
    send: (m) => msgs.push(m),
    player: {
      clientId: 'c1',
      name: 'U',
      teamName: 'T',
      teamNumber: 1,
      alliance: 'blue',
      startIndex: 0,
      ready: true,
      spec: { ...DEFAULT_SPEC },
      assists: { ...DEFAULT_ASSISTS },
    },
    connected: true,
    disconnectAt: 0,
    userId: 'user-1',
  };
  const room = new Room(
    'smoke-lock',
    () => {},
    { kind: 'versus' },
    undefined,
    (uid) => active.push(uid),
    (uid) => inactive.push(uid),
  );
  room.add(client);
  room.onMessage('c1', { t: 'start' });
  check('single-game lock registered for an authed driver at match begin', active.includes('user-1'));

  // restart is DISABLED in multiplayer — it must NOT re-author the live match
  const startsBefore = msgs.filter((m) => m.t === 'matchStart').length;
  room.onMessage('c1', { t: 'restart' });
  const startsAfter = msgs.filter((m) => m.t === 'matchStart').length;
  check('restart is ignored mid-match (no re-authored match)', startsAfter === startsBefore && startsBefore === 1);

  // run to the end → the lock is released at finalize so the user can start again
  room.advanceForTest(maxMatchTicks() + 5);
  check('single-game lock released when the match finalizes', inactive.includes('user-1'));
}

// ---- ranked ELO math (Phase 3) ---------------------------------------------
{
  const p = (
    userId: string,
    alliance: 'red' | 'blue',
    rating = 1000,
    rd = 350,
  ): EloParticipant => ({
    userId,
    alliance,
    rating: { rating, rd, vol: 0.06 },
  });

  check('eloMode: 2 players = 1v1, 4 = 2v2', eloMode(2) === '1v1' && eloMode(4) === '2v2');

  // even 1v1, red wins → single-board symmetric swing (ranked is NOT split by
  // drivetrain); a fresh PROVISIONAL (RD 350) rating moves a LOT (vs settled ±16)
  const evenRedWin = computeGlicko([p('a', 'red'), p('b', 'blue')], { red: 50, blue: 30 });
  check('a game produces exactly one rating update per player', evenRedWin.length === 2);
  const aOverall = evenRedWin.find((u) => u.userId === 'a')!;
  const bOverall = evenRedWin.find((u) => u.userId === 'b')!;
  check(
    'provisional win swings hard (>100) and is symmetric',
    aOverall.after - 1000 > 100 && Math.abs(aOverall.after - 1000 + (bOverall.after - 1000)) <= 1,
    `a +${aOverall.after - 1000} / b ${bOverall.after - 1000}`,
  );
  check('a game shrinks the rating deviation (more certainty)', aOverall.rd < 350 && bOverall.rd < 350, `rd ${aOverall.rd}`);
  check('a fresh rating is still provisional after one game', aOverall.rd > RD_PROVISIONAL, `rd ${aOverall.rd}`);

  // mixed drivetrains rate identically — the board is not divided by drivetrain
  const mixed = computeGlicko([p('a', 'red'), p('b', 'blue')], { red: 50, blue: 30 });
  check('mixed-drivetrain game rates on the one board', mixed.length === 2);

  // a draw between equals leaves the rating put but still sharpens RD
  const draw = computeGlicko([p('a', 'red'), p('b', 'blue')], { red: 40, blue: 40 });
  const aDraw = draw.find((u) => u.userId === 'a')!;
  check('a draw between equals leaves rating ~unchanged but shrinks RD', Math.abs(aDraw.after - 1000) <= 1 && aDraw.rd < 350, `${aDraw.after} rd${aDraw.rd}`);

  // ESTABLISHED (low-RD) ratings barely move — the chess.com "settled" feel
  const estWin = glicko2Update({ rating: 1500, rd: 45, vol: 0.06 }, 1500, 45, 1);
  check('an established (low-RD) win moves the rating only a little (<15)', estWin.rating - 1500 > 0 && estWin.rating - 1500 < 15, `+${(estWin.rating - 1500).toFixed(1)}`);
  check('an established rating is NOT provisional (RD stays low)', estWin.rd < RD_PROVISIONAL, `rd ${estWin.rd.toFixed(0)}`);

  // heavily-favored winner (settled RD) gains only a little
  const team = computeGlicko(
    [
      p('a', 'red', 1400, 60),
      p('b', 'red', 1400, 60),
      p('c', 'blue', 1000, 60),
      p('d', 'blue', 1000, 60),
    ],
    { red: 60, blue: 20 },
  );
  const aT = team.find((u) => u.userId === 'a')!;
  check('favored winner gains modestly', aT.after - aT.before > 0 && aT.after - aT.before < 40, `+${aT.after - aT.before}`);
}

// ---- ranked results: server broadcasts eloResult, re-keyed to robot ids ------
{
  const msgs: ServerMsg[] = [];
  const mk = (id: string, alliance: 'red' | 'blue', userId: string): Client => ({
    id,
    send: (m) => msgs.push(m),
    player: {
      clientId: id,
      name: id,
      teamName: 'T',
      teamNumber: 1,
      alliance,
      startIndex: 0,
      ready: true,
      spec: { ...DEFAULT_SPEC },
      assists: { ...DEFAULT_ASSISTS },
    },
    connected: true,
    disconnectAt: 0,
    userId,
    caps: ['strategy'],
  });
  // onResult resolves to overall-ELO changes (as applyMatchElo would); the Room
  // must re-key them to robot ids (add order → robotId 0 = red, 1 = blue)
  const onResult = () =>
    Promise.resolve({
      elo: [
        { userId: 'u-red', before: 1000, after: 1016, rd: 120 },
        { userId: 'u-blue', before: 1000, after: 984, rd: 120 },
      ],
    });
  const room = new Room('smoke-elo', () => {}, { kind: 'versus' }, onResult);
  room.add(mk('cr', 'red', 'u-red'));
  room.add(mk('cb', 'blue', 'u-blue'));
  room.onMessage('cr', { t: 'start' });
  room.advanceForTest(maxMatchTicks() + 5);
  await new Promise((r) => setTimeout(r, 0)); // flush the async eloResult broadcast

  const elo = msgs.find((m) => m.t === 'eloResult');
  check('server Room broadcasts eloResult after a ranked match', !!elo);
  if (elo && elo.t === 'eloResult') {
    const red = elo.results.find((r) => r.robotId === 0);
    const blue = elo.results.find((r) => r.robotId === 1);
    check('eloResult re-keys the winner delta to red robot 0', red?.after === 1016 && red?.before === 1000);
    check('eloResult re-keys the loser delta to blue robot 1', blue?.after === 984 && blue?.before === 1000);
  }
}

// ---- pre-match STRATEGY window: reveal / re-pick / ready gate / redaction ----
// a staged ranked 1v1 opens a strategy window instead of starting immediately: both
// drivers see their own alliance (opponents redacted), may re-pick within the build
// limits, and the match starts only when both ready (else it cancels).
{
  const rec: Record<string, ServerMsg[]> = { red: [], blue: [] };
  const mkC = (id: string, userId: string, teamNumber: number): Client => ({
    id,
    send: (m) => rec[id].push(m),
    player: {
      clientId: id,
      name: id,
      teamName: 'T',
      teamNumber,
      alliance: 'red',
      startIndex: 0,
      ready: false,
      spec: { ...DEFAULT_SPEC },
      assists: { ...DEFAULT_ASSISTS },
    },
    connected: true,
    disconnectAt: 0,
    userId,
    caps: ['strategy'],
  });
  const mkRoster = (): PendingMatch => ({
    code: 'iad-strat',
    hostRegion: 'iad',
    mode: '1v1',
    seed: 42,
    ranked: true,
    roster: [
      { userId: 'u-red', name: 'red', teamName: 'T', teamNumber: 111, spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS }, startIndex: 0, alliance: 'red', introElo: 1200 },
      { userId: 'u-blue', name: 'blue', teamName: 'T', teamNumber: 222, spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS }, startIndex: 0, alliance: 'blue', introElo: 1300 },
    ],
  });
  // mirror production order: the host stages the pending match FIRST, then each
  // paired client joins and the host re-checks (index.ts: add → maybeStartRanked).
  const room = new Room('smoke-strat', () => {}, { kind: 'versus' });
  room.applyPending(mkRoster());
  room.add(mkC('red', 'u-red', 111));
  room.maybeStartRanked();
  // only red is here: no opponent roster may have leaked while still connecting
  check('strategy: no roster revealed before everyone connects', !rec.red.some((m) => m.t === 'roster'));
  check('strategy: no strategyStart until all paired players connect', !rec.red.some((m) => m.t === 'strategyStart'));
  room.add(mkC('blue', 'u-blue', 222));
  room.maybeStartRanked();

  const ssRed = rec.red.find((m) => m.t === 'strategyStart');
  const ssBlue = rec.blue.find((m) => m.t === 'strategyStart');
  check('strategy: strategyStart sent to both drivers', !!ssRed && !!ssBlue);
  check('strategy: yourRobotId matches roster slot', ssRed?.t === 'strategyStart' && ssRed.yourRobotId === 0 && ssBlue?.t === 'strategyStart' && ssBlue.yourRobotId === 1);
  check('strategy: deadline is in the future', ssRed?.t === 'strategyStart' && ssRed.deadline > Date.now());
  check('strategy: no matchStart before anyone readies', !rec.red.some((m) => m.t === 'matchStart'));

  const lastRoster = (id: string): Extract<ServerMsg, { t: 'roster' }> | undefined =>
    [...rec[id]].reverse().find((m) => m.t === 'roster') as Extract<ServerMsg, { t: 'roster' }> | undefined;
  const redRoster = lastRoster('red');
  const opp = redRoster?.players.find((p) => p.alliance === 'blue');
  const own = redRoster?.players.find((p) => p.alliance === 'red');
  check('strategy: opponent card is hidden (redacted), keeps name/team/slot', opp?.hidden === true && opp?.teamNumber === 222 && opp?.slot === 1);
  check('strategy: opponent spec is neutralized (no counter-pick)', opp?.spec.drivetrain === DEFAULT_SPEC.drivetrain && opp?.spec.intake === DEFAULT_SPEC.intake);
  check('strategy: own card is full + carries its slot', own?.hidden !== true && own?.slot === 0);

  // alliance is server-authoritative during strategy: a client can't switch sides
  room.onMessage('red', { t: 'update', patch: { alliance: 'blue' } });
  const afterAlliance = lastRoster('red')?.players.find((p) => p.slot === 0);
  check('strategy: alliance lockdown — red stays red', afterAlliance?.alliance === 'red');

  // live re-pick within the limits: swap to tank + an over-limit mass (clamped)
  check('strategy: DEFAULT_SPEC is not already tank (re-pick is a real change)', DEFAULT_SPEC.drivetrain !== 'tank');
  room.onMessage('red', { t: 'update', patch: { spec: { ...DEFAULT_SPEC, drivetrain: 'tank', massLb: 999 } } });

  // ready gate: only starts once BOTH ready
  room.onMessage('red', { t: 'update', patch: { ready: true } });
  check('strategy: still no match with only one driver ready', !rec.red.some((m) => m.t === 'matchStart'));
  room.onMessage('blue', { t: 'update', patch: { ready: true } });
  const ms = rec.red.find((m) => m.t === 'matchStart');
  check('strategy: match starts once both drivers ready', ms?.t === 'matchStart');
  if (ms?.t === 'matchStart') {
    const redSetup = ms.setups.find((s) => s.id === 0);
    check('strategy: match uses the LIVE re-picked build (tank)', redSetup?.spec.drivetrain === 'tank');
    check('strategy: re-pick is clamped to the build limits (mass ≤ 42)', (redSetup?.spec.massLb ?? 999) <= 42);
    check('strategy: alliance stays authoritative from the staged roster', redSetup?.alliance === 'red');
  }
}

// strict deadline: if not everyone readies in time, the match CANCELS
{
  const rec: Record<string, ServerMsg[]> = { red: [], blue: [] };
  const mkC = (id: string, userId: string): Client => ({
    id,
    send: (m) => rec[id].push(m),
    player: { clientId: id, name: id, teamName: 'T', teamNumber: 1, alliance: 'red', startIndex: 0, ready: false, spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS } },
    connected: true,
    disconnectAt: 0,
    userId,
    caps: ['strategy'],
  });
  const room = new Room('smoke-strat-deadline', () => {}, { kind: 'versus' });
  room.add(mkC('red', 'u-red'));
  room.add(mkC('blue', 'u-blue'));
  room.applyPending({ code: 'iad-d', hostRegion: 'iad', mode: '1v1', seed: 7, ranked: true, roster: [
    { userId: 'u-red', name: 'red', teamName: 'T', teamNumber: 1, spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS }, startIndex: 0, alliance: 'red', introElo: null },
    { userId: 'u-blue', name: 'blue', teamName: 'T', teamNumber: 1, spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS }, startIndex: 0, alliance: 'blue', introElo: null },
  ] });
  room.onMessage('red', { t: 'update', patch: { ready: true } }); // only red readies
  room.forceStrategyDeadlineForTest();
  check('strategy deadline: cancels (error) when not everyone readied', rec.red.some((m) => m.t === 'error'));
  check('strategy deadline: no match started', !rec.red.some((m) => m.t === 'matchStart'));
}

// a disconnect during strategy cancels the (unratable) pre-match
{
  const rec: Record<string, ServerMsg[]> = { red: [], blue: [] };
  const mkC = (id: string, userId: string): Client => ({
    id,
    send: (m) => rec[id].push(m),
    player: { clientId: id, name: id, teamName: 'T', teamNumber: 1, alliance: 'red', startIndex: 0, ready: false, spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS } },
    connected: true,
    disconnectAt: 0,
    userId,
    caps: ['strategy'],
  });
  const room = new Room('smoke-strat-drop', () => {}, { kind: 'versus' });
  room.add(mkC('red', 'u-red'));
  room.add(mkC('blue', 'u-blue'));
  room.applyPending({ code: 'iad-x', hostRegion: 'iad', mode: '1v1', seed: 9, ranked: true, roster: [
    { userId: 'u-red', name: 'red', teamName: 'T', teamNumber: 1, spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS }, startIndex: 0, alliance: 'red', introElo: null },
    { userId: 'u-blue', name: 'blue', teamName: 'T', teamNumber: 1, spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS }, startIndex: 0, alliance: 'blue', introElo: null },
  ] });
  room.detach('blue');
  check('strategy drop: cancels the match (error to the remaining driver)', rec.red.some((m) => m.t === 'error'));
  check('strategy drop: no match started', !rec.red.some((m) => m.t === 'matchStart'));
}

// backward compat: a MIXED room (one old client without the 'strategy' cap) skips the
// strategy window and starts immediately with the staged specs — so one server can
// serve alpha/beta/main clients at once without stranding an old build.
{
  const rec: Record<string, ServerMsg[]> = { red: [], blue: [] };
  const mkC = (id: string, userId: string, caps: string[]): Client => ({
    id,
    send: (m) => rec[id].push(m),
    player: { clientId: id, name: id, teamName: 'T', teamNumber: 1, alliance: 'red', startIndex: 0, ready: false, spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS } },
    connected: true,
    disconnectAt: 0,
    userId,
    caps,
  });
  const room = new Room('smoke-strat-mixed', () => {}, { kind: 'versus' });
  room.applyPending({ code: 'iad-m', hostRegion: 'iad', mode: '1v1', seed: 5, ranked: true, roster: [
    { userId: 'u-red', name: 'red', teamName: 'T', teamNumber: 1, spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS }, startIndex: 0, alliance: 'red', introElo: null },
    { userId: 'u-blue', name: 'blue', teamName: 'T', teamNumber: 1, spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS }, startIndex: 0, alliance: 'blue', introElo: null },
  ] });
  room.add(mkC('red', 'u-red', ['strategy'])); // new client
  room.maybeStartRanked();
  room.add(mkC('blue', 'u-blue', [])); // OLD client — no 'strategy' cap
  room.maybeStartRanked();
  check('compat: mixed room skips the strategy window (no strategyStart)', !rec.red.some((m) => m.t === 'strategyStart'));
  check('compat: mixed room starts immediately (matchStart to both)', rec.red.some((m) => m.t === 'matchStart') && rec.blue.some((m) => m.t === 'matchStart'));
}

// ---- region-aware matchmaking: minimax host + expanding radius --------------
// helpers: a queue entry (new region-aware shape) + a flush for the async assign
const rEntry = (
  id: string,
  homeRegion: string,
  opts: { accessMs?: number; noWiden?: boolean; channel?: string; build?: string; game?: GameId } = {},
): QueueEntry => ({
  id,
  channel: opts.channel,
  build: opts.build,
  game: opts.game,
  send: () => {},
  player: {
    name: id,
    teamName: 'T',
    teamNumber: 1,
    alliance: 'red',
    startIndex: 0,
    ready: true,
    spec: { ...DEFAULT_SPEC },
    assists: { ...DEFAULT_ASSISTS },
  },
  userId: id,
  mode: '1v1',
  homeRegion,
  accessMs: opts.accessMs ?? 20,
  noWiden: opts.noWiden ?? false,
  enqueuedAt: 0,
  expandBumps: 0,
});
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
// a matchmaker with a controlled clock + a recording stage (no DB): lets us drive
// the widening deterministically and inspect the staged match.
const mkMM = () => {
  const staged: PendingMatch[] = [];
  let clock = 0;
  const mm = new Matchmaker({ now: () => clock, stage: async (m) => void staged.push(m) });
  return { mm, staged, setNow: (v: number) => (clock = v) };
};

// bestHost: minimax picks the fair MIDPOINT region and its worst-case ping/spread
{
  const local = bestHost([{ homeRegion: 'iad', accessMs: 20 }, { homeRegion: 'iad', accessMs: 20 }]);
  check('bestHost: same-region hosts locally with spread 0', local.hostRegion === 'iad' && local.spread === 0);
  const far = bestHost([{ homeRegion: 'iad', accessMs: 20 }, { homeRegion: 'syd', accessMs: 20 }]);
  // iad↔syd hosts on an INTERMEDIATE region (fair midpoint), never on an endpoint —
  // hosting on iad or syd would give the far player 20 + iad↔syd = ~210ms.
  check('bestHost: iad+syd hosts on an intermediate region, not an endpoint', far.hostRegion !== 'iad' && far.hostRegion !== 'syd', `host=${far.hostRegion} cost=${far.cost}`);
  check('bestHost: midpoint beats hosting on either endpoint (<210ms)', far.cost > 0 && far.cost < 210, `cost=${far.cost}`);
}

// radiusCeiling: opens same-continent immediately, worldwide within seconds, capped,
// noWiden pins 0. The times are the point of these checks, not incidental: this pool
// is small enough that the radius schedule IS the matchmaking time, and quality is
// held by nearest-first pairing rather than by making everyone wait (see findMatch).
{
  check('radius: same-continent allowed from t=0 (iad↔lhr 76, iad↔sjc 85)', radiusCeiling(0, 0, false) >= 85);
  check('radius: one step after one interval', radiusCeiling(3000, 0, false) === 195);
  check('radius: WORLDWIDE within 6s (was 40)', radiusCeiling(6000, 0, false) === 300);
  check('radius: expand bumps add steps', radiusCeiling(0, 2, false) === 300);
  check('radius: capped at max', radiusCeiling(10_000_000, 0, false) === 300);
  check('radius: noWiden pins to 0 forever', radiusCeiling(10_000_000, 9, true) === 0);
}

// region-local pair matches immediately and stages a match hosted in that region
{
  const { mm, staged } = mkMM();
  mm.enqueue(rEntry('a', 'iad'));
  mm.enqueue(rEntry('b', 'iad'));
  check('region-local: same-region 1v1 pairs immediately', mm.queueSizes()['1v1'] === 0);
  await flush();
  check('staged host = the shared region; code is region-coded', staged[0]?.hostRegion === 'iad' && !!staged[0]?.code.startsWith('iad-'));
  check('staged roster splits red/blue with distinct start poses', staged[0]?.roster[0].alliance === 'red' && staged[0]?.roster[1].alliance === 'blue');
}

// CHANNEL SEGREGATION: alpha players never pair with stable ones (they run a
// different src/sim — a shared authoritative match would desync). Same-channel
// pairs normally, and the staged match carries the channel (→ unpersisted alpha).
{
  const { mm } = mkMM();
  mm.enqueue(rEntry('a', 'iad', { channel: 'alpha' }));
  mm.enqueue(rEntry('b', 'iad')); // stable (no channel)
  check('channel: alpha + stable in the same region do NOT pair', mm.queueSizes()['1v1'] === 2);
}
{
  const { mm, staged } = mkMM();
  mm.enqueue(rEntry('a', 'iad', { channel: 'alpha' }));
  mm.enqueue(rEntry('b', 'iad', { channel: 'alpha' }));
  check('channel: two alpha players DO pair', mm.queueSizes()['1v1'] === 0);
  await flush();
  check('channel: the staged alpha match is tagged alpha (→ unpersisted)', staged[0]?.channel === 'alpha');
}

// BUILD SEGREGATION: two DIFFERENT builds never share an authoritative match even
// inside one channel (the "same code" invariant — alpha and main always have
// different shas, so this separates them automatically without VITE_APP_CHANNEL).
{
  const { mm } = mkMM();
  mm.enqueue(rEntry('a', 'iad', { build: 'sha_alpha' }));
  mm.enqueue(rEntry('b', 'iad', { build: 'sha_main' })); // same (default) channel, different build
  check('build: two different builds in the same region do NOT pair', mm.queueSizes()['1v1'] === 2);
}
{
  const { mm } = mkMM();
  mm.enqueue(rEntry('a', 'iad', { build: 'sha_x' }));
  mm.enqueue(rEntry('b', 'iad', { build: 'sha_x' }));
  check('build: two same-build players DO pair', mm.queueSizes()['1v1'] === 0);
}
// GAME SEGREGATION: a Chain-Reaction queuer and a DECODE queuer run different
// step()s, so they must NEVER be paired into one authoritative room.
{
  const { mm } = mkMM();
  mm.enqueue(rEntry('a', 'iad', { game: 'chain' }));
  mm.enqueue(rEntry('b', 'iad', { game: 'decode' }));
  check('game: a chain and a decode queuer do NOT pair', mm.queueSizes()['1v1'] === 2);
}
{
  const { mm } = mkMM();
  mm.enqueue(rEntry('a', 'iad', { game: 'chain' }));
  mm.enqueue(rEntry('b', 'iad', { game: 'chain' }));
  check('game: two chain queuers DO pair', mm.queueSizes()['1v1'] === 0);
}
{
  // old clients that send no build fall back to channel-only separation (still pair)
  const { mm } = mkMM();
  mm.enqueue(rEntry('a', 'iad'));
  mm.enqueue(rEntry('b', 'iad'));
  check('build: two build-less (old) clients still pair (channel-only fallback)', mm.queueSizes()['1v1'] === 0);
}

// cross-region does NOT pair at t=0 (spread > radius), but DOES once widened
{
  const { mm, staged, setNow } = mkMM();
  mm.enqueue(rEntry('a', 'iad'));
  mm.enqueue(rEntry('b', 'syd'));
  check('cross-region: no pair while radius is region-local (t=0)', mm.queueSizes()['1v1'] === 2);
  setNow(30_000); // radius now 180ms ≥ the iad↔host↔syd spread (~148ms)
  mm.tick();
  check('cross-region: pairs after the radius widens with wait', mm.queueSizes()['1v1'] === 0);
  await flush();
  check('widened cross-region hosts on an intermediate region', staged[0]?.hostRegion !== 'iad' && staged[0]?.hostRegion !== 'syd', `host=${staged[0]?.hostRegion}`);
}

// noWiden never reaches across regions, no matter how long it waits
{
  const { mm, setNow } = mkMM();
  mm.enqueue(rEntry('a', 'iad', { noWiden: true }));
  mm.enqueue(rEntry('b', 'syd', { noWiden: true }));
  setNow(10_000_000);
  mm.tick();
  check('noWiden: stays region-local forever (never pairs cross-region)', mm.queueSizes()['1v1'] === 2);
}

// expandSearch widens on demand: a cross-region pair matches once BOTH expand enough
{
  const { mm } = mkMM();
  mm.enqueue(rEntry('a', 'iad'));
  mm.enqueue(rEntry('b', 'syd'));
  for (let i = 0; i < 3; i++) {
    mm.expand('a');
    mm.expand('b');
  }
  check('expandSearch: manual widening pairs a cross-region match', mm.queueSizes()['1v1'] === 0);
}

// queue depth is still reported per bucket (powers GET /api/presence)
{
  const { mm } = mkMM();
  mm.enqueue(rEntry('q1', 'iad'));
  check('matchmaker queueSizes reports per-bucket depth', mm.queueSizes()['1v1'] === 1 && mm.queueSizes()['2v2'] === 0);
  mm.remove('q1');
  check('matchmaker queueSizes drops when a player leaves', mm.queueSizes()['1v1'] === 0);
}

// a user can never be matched with THEMSELF (a 2nd tab / a stale reconnect entry
// under a fresh connection id). That produced a roster with two slots for one
// identity → one robot frozen ("ghost" the driver also controls). Same userId ⇒
// the newer entry REPLACES the old one; two distinct users pair normally.
{
  const { mm } = mkMM();
  mm.enqueue({ ...rEntry('conn1', 'iad'), userId: 'userU' });
  mm.enqueue({ ...rEntry('conn2', 'iad'), userId: 'userU' }); // same account, new socket
  // if it self-paired, the queue would empty (matched); dedup keeps exactly one
  check('same-user 2nd queue entry replaces the first (no self-pair)', mm.queueSizes()['1v1'] === 1);
  mm.enqueue({ ...rEntry('conn3', 'iad'), userId: 'userV' }); // a real opponent
  check('a genuine 2nd user pairs (queue empties)', mm.queueSizes()['1v1'] === 0);
}

// ---- shareable room codes (generated, 6-char, vowel-free, profanity-safe) ----
{
  let allValid = true;
  let anyBad = false;
  const seen = new Set<string>();
  for (let i = 0; i < 5000; i++) {
    const c = generateRoomCode();
    if (!isValidRoomCode(c)) allValid = false;
    if (/[AEIOU01IL]/.test(c)) anyBad = true; // no vowels / ambiguous chars ever
    seen.add(c);
  }
  check('generateRoomCode always yields a valid code', allValid);
  check('generated codes never contain vowels / ambiguous chars', !anyBad);
  check('generated codes are 6 chars', generateRoomCode().length === 6);
  check('generated codes vary (not a constant)', seen.size > 100, `${seen.size} distinct`);
  check('isValidRoomCode rejects the wrong length', !isValidRoomCode('ABC') && !isValidRoomCode('BCDFGHJ'));
  check('isValidRoomCode rejects vowels', !isValidRoomCode('BANANA'));
  check('normalizeRoomCode strips junk + uppercases', normalizeRoomCode(' b2-c3 d4x ') === 'B2C3D4');
}

// ------------------------------------------------------------ multi-game (Chain Reaction seam) ----
{
  // registry integrity + back-compat default
  check('registry: gameOf({}) defaults to decode', gameOf({}).id === 'decode');
  check('registry: gameOf(undefined) defaults to decode', gameOf(undefined).id === 'decode');
  check('registry: moduleFor("chain") resolves the chain module', moduleFor('chain').id === 'chain');
  check('registry: an unknown game id degrades to decode', moduleFor('nope' as never).id === 'decode');
  check('chain module is SCORED (ranked + records on, keyed per game)', moduleFor('chain').scored === true);

  // the DECODE collider extraction is intact: 4 walls + per-alliance (face + classifier)
  check(
    'decode colliders: 4 walls + 2 goal-face + 2 classifier = 8 statics',
    decodeColliders.statics.length === 8,
    `${decodeColliders.statics.length}`,
  );
  // 4 perimeter walls + the 4 SOLID corner assemblies (post + mounting plate). No dynamic.
  check(
    'chain colliders: 4 walls + 4 corner ring-stand assemblies, no dynamic',
    chainColliders.statics.length === 8 && !chainColliders.dynamic,
    `${chainColliders.statics.length}`,
  );
  // EVERY start anchor must be spawnable: fully inside its Lab Area (G04) and clear of the
  // corner assembly that eats that same corner — a robot spawned inside a collider is
  // ejected violently on tick one. The two constraints fight, so this is worth pinning.
  {
    const e = 8.5; // a generous chassis half-extent
    const bad: string[] = [];
    for (const a of CHAIN_START_POSES) {
      const inLab =
        a.pos.x >= CHAIN_HALF_X - CHAIN_LAB + e &&
        a.pos.x <= CHAIN_HALF_X - e &&
        Math.abs(a.pos.y) >= CHAIN_HALF_Y - CHAIN_LAB + e &&
        Math.abs(a.pos.y) <= CHAIN_HALF_Y - e;
      const clear = ringStandBoxes().every(
        (b) =>
          !(Math.abs(a.pos.x - b.x) < CHAIN_RINGSTAND_BOX / 2 + e &&
            Math.abs(a.pos.y - b.y) < CHAIN_RINGSTAND_BOX / 2 + e),
      );
      if (!inLab || !clear) bad.push(`${a.name}(lab=${inLab} clear=${clear})`);
    }
    check('chain starts: every anchor is inside its Lab Area AND clear of the corner assembly', bad.length === 0, bad.join(' '));
    // THE CONSTRAINT ITSELF. G04 wants the robot COMPLETELY inside its Lab square; the
    // corner assembly is solid and sits in that same square's outer corner. Those only
    // coexist when the assembly is small enough to leave a chassis-wide band:
    //     BOX <= LAB - 2*(half-extent)
    // Enlarging the assembly (or shrinking the Lab) without honouring this makes G04
    // unsatisfiable for every legal robot — it fails HERE rather than silently spawning
    // robots inside colliders.
    const widest = ROBOT_MAX_SIZE / 2;
    check(
      'chain starts: the corner assembly leaves room for the widest legal chassis (G04 stays satisfiable)',
      CHAIN_RINGSTAND_BOX <= CHAIN_LAB - 2 * widest,
      `box ${CHAIN_RINGSTAND_BOX}" vs lab ${CHAIN_LAB}" − 2×${widest}" = ${CHAIN_LAB - 2 * widest}"`,
    );
    // exactly the STAND anchors arm the auto-descent
    const armed = CHAIN_START_POSES.filter((a) => onRingStand(a.pos)).map((a) => a.name);
    check(
      'chain starts: only the STAND anchors count as at-the-ring-stand',
      armed.length === 2 && armed.every((n) => n.startsWith('STAND')),
      armed.join(', ') || 'none',
    );
  }

  // THE START EDITOR's contract (ChainStartEditor). It colours the field from
  // `chainEvalStart` and stores CANONICAL poses via `chainMirrorStart`, so both have to
  // agree with what the spawn actually does — a green ring that relocates the robot, or a
  // pose that jumps corners when the alliance flips, is the whole bug class here.
  {
    const spec = DEFAULT_SPEC;
    const badAnchor = CHAIN_START_POSES.filter((a) => !chainEvalStart(spec, a.pos, (a.heading * 180) / Math.PI).legal).map((a) => a.name);
    check('chain start editor: every named anchor evaluates LEGAL', badAnchor.length === 0, badAnchor.join(', '));

    // the verdict never contradicts the reasons it shows — a legal pose must satisfy BOTH
    // sub-rules, so a green ring can never be paired with a broken one
    let contradiction = '';
    // sweep HEADINGS too: legality became heading-aware, so a 45deg pose exercises the
    // widest footprint and 0/90 the narrowest
    for (const deg of [0, 30, 45, 90, 135]) {
    for (let x = -CHAIN_HALF_X; x <= CHAIN_HALF_X && !contradiction; x += 3) {
      for (let y = -CHAIN_HALF_Y; y <= CHAIN_HALF_Y && !contradiction; y += 3) {
        const ev = chainEvalStart(spec, { x, y }, deg);
        if (ev.legal !== chainStartLegal(spec, { x, y }, deg)) contradiction = `verdict split at ${x},${y}`;
        else if (ev.legal && !(ev.inLab && ev.clearOfStand)) contradiction = `legal but unexplained at ${x},${y}`;
      }
    }
    }
    check('chain start editor: legality and its stated reason never disagree', !contradiction, contradiction);

    // the two failure modes are distinguishable (so the status line can name one)
    const mid = chainEvalStart(spec, { x: 0, y: 0 }, 0);
    // a spot INSIDE the Lab band that still overlaps the assembly — the case where the
    // status line must blame the Ring Stand rather than containment
    const onStand = chainEvalStart(spec, { x: 62, y: 62 }, 0);
    check('chain start editor: mid-field fails as OUT OF LAB', !mid.legal && !mid.inLab);
    check(
      'chain start editor: in-Lab but on the corner assembly fails as BLOCKED, not out-of-lab',
      !onStand.legal && onStand.inLab && !onStand.clearOfStand,
      `inLab=${onStand.inLab} clear=${onStand.clearOfStand}`,
    );

    // canonical <-> actual mirroring is SELF-INVERSE for both alliances (the editor uses the
    // one call in both directions), and blue is the identity
    // a LEGAL custom pose (off-anchor, odd heading) — the spawn only honours a custom pose
    // verbatim when it is legal, so an illegal probe would test the snap instead of the mirror
    // 180deg, not a diagonal: heading is no longer free (a turned chassis sweeps wider
    // than the 24in Lab allows), so a 150deg probe now tests the SNAP, not the mirror
    const probe = { x: 57, y: -58, headingDeg: 180 };
    check('chain start editor: the custom-pose probe is itself legal', chainStartLegal(spec, probe, probe.headingDeg));
    let mirrorOk = true;
    for (const a of ['blue', 'red'] as const) {
      const round = chainMirrorStart(chainMirrorStart(probe, a), a);
      if (
        Math.abs(round.x - probe.x) > 1e-9 ||
        Math.abs(round.y - probe.y) > 1e-9 ||
        Math.abs(round.headingDeg - probe.headingDeg) > 1e-9
      ) {
        mirrorOk = false;
      }
    }
    check('chain start editor: canonical<->actual mirror is self-inverse', mirrorOk);
    check(
      'chain start editor: blue IS the canonical frame (mirror is identity)',
      chainMirrorStart(probe, 'blue').x === probe.x &&
        chainMirrorStart(probe, 'blue').headingDeg === probe.headingDeg,
    );

    // and the mirror agrees with the SPAWN: a canonical custom pose lands where the editor
    // drew it, for either alliance
    for (const a of ['blue', 'red'] as const) {
      const w = createChainWorld('match', 1, [
        { id: 0, alliance: a, spec, assists: DEFAULT_ASSISTS, startIndex: 0, startPose: probe },
      ]);
      const shown = chainMirrorStart(probe, a);
      const r = w.robots[0];
      check(
        `chain start editor: a custom ${a} pose spawns where the editor showed it`,
        Math.abs(r.pos.x - shown.x) < 0.01 && Math.abs(r.pos.y - shown.y) < 0.01,
        `spawn ${r.pos.x.toFixed(2)},${r.pos.y.toFixed(2)} vs shown ${shown.x.toFixed(2)},${shown.y.toFixed(2)}`,
      );
    }

    // HEADING is part of the rule now. A chassis turned off-axis sweeps a wider
    // axis-aligned bound, and the Lab is only 24in across with a solid 6in assembly in
    // its outer corner — so a big robot has NO legal diagonal start, and the editor has
    // to be able to say so and repair it by turning rather than sliding.
    {
      const big = coerceSpec({ ...DEFAULT_SPEC, length: 18, width: 18 }, DEFAULT_SPEC, 'chain');
      check(
        'chain start heading: a squared-up robot fits the Lab',
        chainHeadingFits(big, 0) && chainHeadingFits(big, 90) && chainHeadingFits(big, 180),
      );
      check(
        'chain start heading: a big robot cannot start diagonally',
        !chainHeadingFits(big, 45),
        `ex at 45deg = ${chainStartExtents(big, 45).ex.toFixed(2)}`,
      );
      const fixed = chainNearestFittingHeading(big, 45);
      check('chain start heading: the repair TURNS to a heading that fits', chainHeadingFits(big, fixed), `45 -> ${fixed}`);
      check('chain start heading: a fitting heading is left alone', chainNearestFittingHeading(big, 0) === 0);
      // THE invariant tying it together: "fits" must mean a legal pose really exists, and
      // the pose-level snap must find one — for every spec and every heading.
      let unplaceable = '';
      let unrepaired = '';
      for (const sp of [big, DEFAULT_SPEC, ...CHAIN_PRESETS]) {
        const spc = coerceSpec({ ...sp }, DEFAULT_SPEC, 'chain');
        for (let d = 0; d < 360 && !unplaceable && !unrepaired; d += 5) {
          if (chainHeadingFits(spc, d)) {
            const sn = chainSnapStart(spc, { x: 0, y: 0 }, d);
            if (!chainStartLegal(spc, sn, d)) unplaceable = `${spc.name} deg ${d}`;
          }
          // and the POSE-level snap (what the spawn runs) always lands legal, whatever
          // heading it is handed — this is the guard against spawning inside the assembly
          const rep = chainSnapStartPose(spc, { x: 200, y: -500, headingDeg: d });
          if (!chainStartLegal(spc, { x: rep.x, y: rep.y }, rep.headingDeg)) {
            unrepaired = `${spc.name} deg ${d} -> ${rep.x.toFixed(1)},${rep.y.toFixed(1)}@${rep.headingDeg}`;
          }
        }
      }
      check('chain start heading: every fitting heading has a legal position', !unplaceable, unplaceable);
      check('chain start heading: the pose snap ALWAYS lands legal, from any heading', !unrepaired, unrepaired);
    }

    // free placement still cannot beat G04: an out-of-bounds pose SNAPS back into the Lab
    const snapped = chainSnapStart(spec, { x: 0, y: 0 }, 0);
    check(
      'chain start editor: snapping a mid-field pose returns a legal Lab spot',
      chainStartLegal(spec, snapped, 0),
      `${snapped.x.toFixed(1)},${snapped.y.toFixed(1)}`,
    );
  }

  /**
   * coerceSpec FUZZ — the chokepoint every untrusted spec passes (localStorage, account
   * sync, the wire, createWorld). Each property is re-derived from the OUTPUT spec
   * independently of the coercer's internals, so a broken clamp shows up as a violated
   * invariant instead of quietly agreeing with itself.
   */
  {
    let sd = 0x2f6e2b1;
    const rnd = (): number => {
      sd ^= sd << 13; sd >>>= 0;
      sd ^= sd >> 17;
      sd ^= sd << 5; sd >>>= 0;
      return sd / 0x100000000;
    };
    const pickOf = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length) % xs.length];
    const HOSTILE: unknown[] = [
      undefined, null, NaN, Infinity, -Infinity, 0, -1, -1e9, 1e9, 1e309,
      '18', 'banana', '', true, false, {}, [], { valueOf: () => 99 }, -0,
    ];
    const ENUMISH: unknown[] = [
      ...HOSTILE, 'front', 'back', 'side', 'left', 'right', 'center', 'frontback',
      'frontleft', 'backright', 'turret', 'twinturret', 'drum', 'dumper', 'arm', 'rail',
      'sloped', 'vector', 'triangle', 'compact', 'extended', 'mecanum', 'tank', 'swerve',
      'xdrive', 'butterfly', '__proto__', 'constructor',
    ];
    const randomRaw = (): Record<string, unknown> => {
      const o: Record<string, unknown> = {};
      for (const f of ['length', 'width', 'massLb', 'driveRpm', 'tankRpm', 'flywheelInertia',
                       'ballStorage', 'groundClearance', 'catapultRange', 'catapultYaw', 'teamNumber']) {
        if (rnd() < 0.75) o[f] = pickOf(HOSTILE);
      }
      for (const f of ['intake', 'drivetrain', 'scoreMode', 'chainIntake', 'catalystType',
                       'intakeMount', 'shooterMount', 'catalystMount', 'chassisColor']) {
        if (rnd() < 0.75) o[f] = pickOf(ENUMISH);
      }
      if (rnd() < 0.4) o.intakeSide = pickOf([true, false, 'yes', 1, null]);
      if (rnd() < 0.4) o.shooterRear = pickOf([true, false, 'yes', 1, null]);
      if (rnd() < 0.5) o.canSort = pickOf([true, false, 'yes', 1, null]);
      if (rnd() < 0.5) o.name = pickOf([undefined, '', '   ', 'x'.repeat(200), 42, null]);
      if (rnd() < 0.5) o.teamName = pickOf([undefined, '', 'y'.repeat(300), 7, null]);
      if (rnd() < 0.5) o.assists = pickOf([undefined, null, {}, { aimAssist: false }, { fieldCentric: 'no' }]);
      return o;
    };

    const problems: string[] = [];
    const note = (m: string) => { if (problems.length < 6) problems.push(m); };
    for (const game of ['decode', 'chain', undefined] as (GameId | undefined)[]) {
      const lbl = game ?? 'no-game';
      for (let i = 0; i < 300; i++) {
        const raw = randomRaw();
        let a: RobotSpec;
        try {
          a = coerceSpec(raw, DEFAULT_SPEC, game);
        } catch (e) {
          note(`${lbl}: THREW ${String(e)}`);
          continue;
        }
        for (const [k, v] of Object.entries(a)) {
          if (typeof v === 'number' && !Number.isFinite(v)) note(`${lbl}: ${k} not finite (${v})`);
        }
        const rpm = rpmLimits(a.drivetrain);
        if (a.driveRpm < rpm.min || a.driveRpm > rpm.max) note(`${lbl}: driveRpm ${a.driveRpm}`);
        if ((a.drivetrain === 'butterfly') !== (a.tankRpm !== undefined)) note(`${lbl}: tankRpm presence`);
        const mass = massLimits(a.drivetrain, a.flywheelInertia, game === 'chain' ? chainMassFloorBump(a) : 0);
        if (a.massLb < mass.min - 1e-9 || a.massLb > mass.max + 1e-9) note(`${lbl}: mass ${a.massLb}`);
        if ((a.ballStorage ?? 0) > chainStorageMax(a)) note(`${lbl}: storage over max`);
        if (a.intakeSide !== (a.intakeMount === 'side')) note(`${lbl}: intakeSide mirror`);
        if (a.shooterRear !== (a.shooterMount === 'back')) note(`${lbl}: shooterRear mirror`);
        if (!isTurreted(a.scoreMode) && !isEdgePos(a.shooterMount as never)) note(`${lbl}: turretless on ${a.shooterMount}`);
        if (a.assists?.aimAssist !== true) note(`${lbl}: aim assist not forced on`);
        if (a.name.length > 24 || a.teamName.length > 48) note(`${lbl}: identity too long`);
        // IDEMPOTENT — it runs at several layers, so a second pass must change nothing
        if (JSON.stringify(coerceSpec(a, DEFAULT_SPEC, game)) !== JSON.stringify(a)) {
          note(`${lbl}: NOT idempotent from ${JSON.stringify(raw).slice(0, 120)}`);
        }
      }
    }
    // a CR build routed through DECODE and back must still be legal (switchGame / mixed rooms)
    for (let i = 0; i < 100; i++) {
      const cr = coerceSpec(randomRaw(), DEFAULT_SPEC, 'chain');
      const back = coerceSpec(coerceSpec(cr, DEFAULT_SPEC, 'decode'), DEFAULT_SPEC, 'chain');
      if ((back.ballStorage ?? 0) > chainStorageMax(back)) note('cr->decode->chain: storage over max');
      if (!Number.isFinite(back.massLb)) note('cr->decode->chain: mass not finite');
    }
    check('coerceSpec: 900 fuzzed specs hold every range/enum/mirror invariant + idempotency',
      problems.length === 0, problems.join(' | '));
  }

  // CR CHASSIS SIZE: the sweeper is structure inside the 18" START CUBE, so its reach eats
  // that cube on whichever axis it is MOUNTED on. Without this a "legal" build could be an
  // 18x18 frame with a 5" sweeper on BOTH ends — a 28" starting footprint.
  {
    const size = (intake: RobotSpec['intake'], mount: RobotSpec['intakeMount']) =>
      chainSizeLimits({ ...DEFAULT_SPEC, intake, intakeMount: mount });
    const reach = (i: RobotSpec['intake']) => INTAKE_PRESETS[i].reach;
    // one end mounted → one reach off the length; both ends → two
    check(
      'chain size: an end-mounted sweeper eats the length, front+back eats it twice',
      size('triangle', 'front').maxLength === CHAIN_MAX_LENGTH - reach('triangle') &&
        size('triangle', 'frontback').maxLength === CHAIN_MAX_LENGTH - 2 * reach('triangle'),
      `front ${size('triangle', 'front').maxLength} fb ${size('triangle', 'frontback').maxLength}`,
    );
    // some combinations simply cannot fit the cube — a 5"-reach sweeper on BOTH ends leaves
    // 8" of chassis, under the 10" minimum. Those are reported infeasible, not clamped.
    check(
      'chain size: a double-mounted long intake is reported as impossible, not silently clamped',
      !chainMountFits({ ...DEFAULT_SPEC, intake: 'triangle' }, 'frontback') &&
        chainMountFits({ ...DEFAULT_SPEC, intake: 'sloped' }, 'frontback'),
      `triangle fb ${chainMountFits({ ...DEFAULT_SPEC, intake: 'triangle' }, 'frontback')} sloped fb ${chainMountFits({ ...DEFAULT_SPEC, intake: 'sloped' }, 'frontback')}`,
    );
    // ...and coerceSpec refuses it, falling back to the single front sweeper
    check(
      'chain size: coerceSpec rejects an impossible mount instead of building it',
      coerceSpec({ ...DEFAULT_SPEC, intake: 'triangle', intakeMount: 'frontback' }, undefined, 'chain').intakeMount === 'front',
    );
    // flanks eat the WIDTH instead, and leave the length alone
    check(
      'chain size: a side-mounted sweeper eats the width, not the length',
      size('sloped', 'side').maxWidth === ROBOT_MAX_SIZE - 2 * reach('sloped') &&
        size('sloped', 'side').maxLength === CHAIN_MAX_LENGTH,
      `w ${size('sloped', 'side').maxWidth} l ${size('sloped', 'side').maxLength}`,
    );
    // a longer-reach intake costs more of the cube
    check(
      'chain size: a longer intake preset leaves less chassis',
      size('triangle', 'front').maxLength < size('sloped', 'front').maxLength,
      `triangle ${size('triangle', 'front').maxLength} vs sloped ${size('sloped', 'front').maxLength}`,
    );
    // and coerceSpec ENFORCES it — a spoofed max-size front+back build is clamped
    const big = coerceSpec(
      { ...DEFAULT_SPEC, intake: 'triangle', intakeMount: 'front', length: 18 },
      undefined,
      'chain',
    );
    check(
      'chain size: coerceSpec clamps an oversized build to its start-cube envelope',
      big.length <= CHAIN_MAX_LENGTH - reach('triangle') + 0.01,
      `length ${big.length} (cap ${CHAIN_MAX_LENGTH - reach('triangle')})`,
    );
    const wide = coerceSpec(
      { ...DEFAULT_SPEC, intake: 'sloped', intakeMount: 'side', width: 18 },
      undefined,
      'chain',
    );
    check(
      'chain size: coerceSpec clamps a side-mounted build to its width envelope',
      wide.width <= ROBOT_MAX_SIZE - 2 * reach('sloped') + 0.01,
      `width ${wide.width}`,
    );
  }

  // CUSTOM start poses: whatever a player (or a spoofed client) asks for, the spawned robot
  // must end up inside its Lab Area and clear of the corner assembly — otherwise it spawns
  // inside a collider and gets flung across the field on tick one.
  {
    const tries: StartPose[] = [
      { x: 0, y: 0, headingDeg: 180 },        // middle of the field
      { x: 71, y: 71, headingDeg: 0 },         // deep inside the corner assembly
      { x: 66, y: 66, headingDeg: 90 },        // dead centre of the assembly
      { x: 200, y: -500, headingDeg: 45 },     // far outside the field
      { x: 57, y: -57, headingDeg: 180 },      // already legal — must be left alone
    ];
    const bad: string[] = [];
    for (const sp of tries) {
      const w = createChainWorld('match', 21, [
        { id: 0, alliance: 'blue', spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS }, startIndex: 0, startPose: sp },
      ]);
      const p = w.robots[0].pos;
      // extents are HEADING-AWARE, and per-axis: re-derive from the spawned robot's own
      // spec + heading rather than from one scalar, or this re-check is a different
      // (stricter, and wrong) rule than the one the spawn applied
      const rspec = w.robots[0].spec;
      const { ex, ey } = chainStartExtents(rspec, (w.robots[0].heading * 180) / Math.PI);
      const inLab =
        p.x >= CHAIN_HALF_X - CHAIN_LAB + ex - 0.01 &&
        p.x <= CHAIN_HALF_X - ex + 0.01 &&
        Math.abs(p.y) >= CHAIN_HALF_Y - CHAIN_LAB + ey - 0.01 &&
        Math.abs(p.y) <= CHAIN_HALF_Y - ey + 0.01;
      const clear = ringStandBoxes().every(
        (b) =>
          !(Math.abs(p.x - b.x) < CHAIN_RINGSTAND_BOX / 2 + ex - 0.01 &&
            Math.abs(p.y - b.y) < CHAIN_RINGSTAND_BOX / 2 + ey - 0.01),
      );
      if (!inLab || !clear) bad.push(`(${sp.x},${sp.y})→(${p.x.toFixed(0)},${p.y.toFixed(0)}) lab=${inLab} clear=${clear}`);
    }
    check('chain starts: ANY custom pose is snapped into the Lab and out of the assembly', bad.length === 0, bad.join(' '));
    // a pose that is already legal is respected, not shoved somewhere else
    const wOk = createChainWorld('match', 22, [
      { id: 0, alliance: 'blue', spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS }, startIndex: 0, startPose: { x: 57, y: 57, headingDeg: 180 } },
    ]);
    check(
      'chain starts: an already-legal custom pose is used as given',
      Math.abs(wOk.robots[0].pos.x - 57) < 0.01 && Math.abs(wOk.robots[0].pos.y - 57) < 0.01,
      `(${wOk.robots[0].pos.x.toFixed(1)},${wOk.robots[0].pos.y.toFixed(1)})`,
    );
  }

  // you cannot drive THROUGH a ring stand — the corner assembly is solid
  {
    const w = createChainWorld('free', 11, [
      { id: 0, alliance: 'blue', spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS }, startIndex: 0 },
    ]);
    const rob = w.robots[0];
    const box = ringStandBoxes()[0]; // +x/+y corner
    // approach the box's OPEN −x face. It is flush with both walls, so the only lanes to it
    // are its two inward faces; y is pulled in so the chassis clears the +y wall.
    rob.pos = { x: box.x - 20, y: 63 };
    rob.heading = 0;
    rob.fieldCentric = false; // driveY = straight ahead (+x)
    rob.vel = { x: 0, y: 0 };
    for (let i = 0; i < 90; i++) chainStep(w, SIM_DT, new Map([[rob.id, cmd({ driveY: 1 })]]));
    const e = robotExtents(rob);
    const stopped = rob.pos.x + e.front <= box.x - CHAIN_RINGSTAND_BOX / 2 + 1.5;
    check(
      'chain: a robot cannot drive into a ring-stand assembly',
      stopped,
      `front edge ${(rob.pos.x + e.front).toFixed(1)} vs box face ${(box.x - CHAIN_RINGSTAND_BOX / 2).toFixed(1)}`,
    );
  }


  // manual geometry (mm → in ÷25.4): accelerator 697.49752×1393.65mm, hooks ±688.09375mm
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;
  check('chain accelerator: depth = 27.4605in (697.49752mm)', near(CHAIN_ACCEL_DEPTH, 27.460532), CHAIN_ACCEL_DEPTH.toFixed(4));
  check('chain accelerator: half-width = 27.4341in (1393.65mm/2)', near(CHAIN_ACCEL_HALF_Y, 27.434055), CHAIN_ACCEL_HALF_Y.toFixed(4));
  check('chain hook: y = ±27.0903in (688.09375mm)', near(CHAIN_HOOK_Y, 27.090305), CHAIN_HOOK_Y.toFixed(4));
  // accelerators sit OUTSIDE the ±72 walls (protrude, don't overlap the play area)
  check('chain accelerator: protrudes past the wall (outer x = 99.46)', near(CHAIN_HALF_X + CHAIN_ACCEL_DEPTH, 99.460532));
  // hooks fall within the accelerator mouth (|hookY| < accelerator half-width)
  check('chain hook: within the accelerator-mouth span', CHAIN_HOOK_Y < CHAIN_ACCEL_HALF_Y);

  const chainSetup = (id: number, alliance: Alliance): RobotSetup => ({
    id,
    alliance,
    spec: { ...DEFAULT_SPEC },
    assists: { ...DEFAULT_ASSISTS },
    startIndex: id,
  });
  const runChain = (world: World, c: RobotCommand, seconds: number): void => {
    const commands = new Map(world.robots.map((r) => [r.id, c]));
    const n = Math.round(seconds / SIM_DT);
    for (let i = 0; i < n; i++) chainStep(world, SIM_DT, commands);
  };

  // spawn: robots only, inert goals/scores present (so worldHash never throws), in-bounds
  const cw = createChainWorld('free', 12345, [chainSetup(0, 'blue'), chainSetup(1, 'red')]);
  check('chain spawn: world.game === "chain"', cw.game === 'chain');
  check('chain spawn: 300 particles + 4 catalysts staged (not scattered)', cw.balls.length === CHAIN_PARTICLE_SIM && cw.chain?.catalysts.length === 4);
  // pre-match: all 300 particles START staged inside the two goals (150 each), NOT on the field
  {
    const staged = cw.balls.filter((b) => b.state.kind === 'flight' && (b.state as { staged?: boolean }).staged);
    const redStaged = staged.filter((b) => b.state.kind === 'flight' && b.state.target === 'red').length;
    const blueStaged = staged.filter((b) => b.state.kind === 'flight' && b.state.target === 'blue').length;
    const inGoals = staged.every((b) => Math.abs(b.pos.x) > CHAIN_HALF_X); // behind the alliance wall
    check(
      'chain spawn: 300 particles staged in the goals (150 each), none on the field',
      staged.length === CHAIN_PARTICLE_SIM && redStaged === 150 && blueStaged === 150 && inGoals,
      `staged=${staged.length} red=${redStaged} blue=${blueStaged} inGoals=${inGoals}`,
    );
  }
  // pre-match randomization: the launchers fling every staged particle onto the field within
  // a few seconds — count conserved, all end as ground particles inside the field
  {
    const rw = createChainWorld('match', 99, [chainSetup(0, 'blue')]);
    runChain(rw, cmd({}), 4); // ~2.5 s to empty the goals + flight/settle time
    const anyStaged = rw.balls.some((b) => b.state.kind === 'flight' && (b.state as { staged?: boolean }).staged);
    const onField = rw.balls.filter((b) => b.state.kind === 'ground').length;
    check(
      'chain randomize: goal launchers empty the staged particles onto the field',
      !anyStaged && rw.balls.length === CHAIN_PARTICLE_SIM && onField > CHAIN_PARTICLE_SIM * 0.9,
      `staged=${anyStaged} total=${rw.balls.length} ground=${onField}`,
    );
  }
  // START POSITIONS (G04): a robot spawns COMPLETELY in its Lab Area; startIndex picks the anchor
  {
    const s0 = chainSetup(0, 'blue');
    s0.startIndex = 0;
    const w0 = createChainWorld('match', 1, [s0]);
    const r0 = w0.robots[0];
    const inLab = labAreas('blue').some(
      (L) => r0.pos.x > L.x0 && r0.pos.x < L.x1 && r0.pos.y > L.y0 && r0.pos.y < L.y1,
    );
    check('chain start: robot spawns inside its Lab Area (G04)', inLab, `pos=(${r0.pos.x},${r0.pos.y})`);
    // a different startIndex ⇒ a different (also-legal) pose
    const s1 = chainSetup(0, 'blue');
    s1.startIndex = 1;
    const w1 = createChainWorld('match', 1, [s1]);
    check('chain start: startIndex selects distinct anchors', w1.robots[0].pos.y !== r0.pos.y);
    // RED is the x-mirror of BLUE (same anchor, opposite side)
    const sr = chainSetup(0, 'red');
    sr.startIndex = 0;
    const wr = createChainWorld('match', 1, [sr]);
    check('chain start: red mirrors blue across x', Math.abs(wr.robots[0].pos.x + r0.pos.x) < 0.01 && Math.abs(wr.robots[0].pos.y - r0.pos.y) < 0.01);
  }
  // catalysts start ON the four ring stands (never loose on the field)
  {
    const stands = ringStands();
    const onStands = cw.chain!.catalysts.every((c) =>
      stands.some((s) => Math.hypot(s.x - c.pos.x, s.y - c.pos.y) < 0.01),
    );
    check('chain spawn: catalysts start on the ring stands', onStands);
  }
  check('chain spawn: inert goals + scores present (worldHash-safe)', !!cw.goals.red && !!cw.goals.blue && !!cw.match.scores.blue);
  check(
    'chain spawn: robots start inside the CR field',
    cw.robots.every((r) => Math.abs(r.pos.x) < CHAIN_HALF_X && Math.abs(r.pos.y) < CHAIN_HALF_Y),
  );
  check('chain spawn: worldHash does not throw', Number.isFinite(worldHash(cw)));

  // drive: a robot moves under a command (freeplay ⇒ robots enabled)
  const driveW = createChainWorld('free', 7, [chainSetup(0, 'blue')]);
  const startX = driveW.robots[0].pos.x;
  const startY = driveW.robots[0].pos.y;
  runChain(driveW, cmd({ driveX: 1, driveY: 1 }), 1);
  const moved = Math.hypot(driveW.robots[0].pos.x - startX, driveW.robots[0].pos.y - startY);
  check('chain drive: the robot actually moves under a command', moved > 2, `moved=${moved.toFixed(1)}in`);

  // wall containment: hammer the field in every direction; the center never leaves
  const wallW = createChainWorld('free', 9, [chainSetup(0, 'blue')]);
  let contained = true;
  const dirs = [
    { driveX: 1, driveY: 0 },
    { driveX: -1, driveY: 0 },
    { driveX: 0, driveY: 1 },
    { driveX: 0, driveY: -1 },
  ];
  for (const d of dirs) {
    runChain(wallW, cmd(d), 2.5);
    const r = wallW.robots[0];
    if (Math.abs(r.pos.x) >= CHAIN_HALF_X || Math.abs(r.pos.y) >= CHAIN_HALF_Y) contained = false;
  }
  const wr = wallW.robots[0];
  check(
    'chain drive: full-speed wall drive stays contained on the CR field',
    contained,
    `pos=(${wr.pos.x.toFixed(1)},${wr.pos.y.toFixed(1)}) half=(${CHAIN_HALF_X},${CHAIN_HALF_Y})`,
  );

  // wall SQUARE-UP: a tilted robot driven into a wall settles flush (like DECODE). CR now
  // runs the contact-torque pass restricted to its perimeter walls.
  {
    const sw = createChainWorld('free', 13, [chainSetup(0, 'blue')]);
    const rob = sw.robots[0];
    rob.pos = { x: CHAIN_HALF_X - 12, y: 0 };
    rob.heading = 0.35; // ~20° tilt off the +x wall
    runChain(sw, cmd({ driveX: 1 }), 3); // shove toward the +x wall
    check(
      'chain drive: driving into a wall squares the robot flush to it',
      Math.abs(rob.heading) < 0.05,
      `heading ${rob.heading.toFixed(3)} (want ≈0)`,
    );
  }

  // determinism: identical seed + inputs ⇒ identical worldHash
  const a = createChainWorld('match', 4242, [chainSetup(0, 'blue'), chainSetup(1, 'red')]);
  const b = createChainWorld('match', 4242, [chainSetup(0, 'blue'), chainSetup(1, 'red')]);
  runChain(a, cmd({ driveX: 0.7, rotate: 0.3 }), 2);
  runChain(b, cmd({ driveX: 0.7, rotate: 0.3 }), 2);
  check('chain determinism: same seed + inputs ⇒ equal worldHash', worldHash(a) === worldHash(b));

  // gameplay: intake → fire → accelerator score, with the 300-particle count CONSERVED
  {
    const gw = createChainWorld('match', 555, [chainSetup(0, 'blue')]);
    gw.match.phase = 'teleop';
    gw.match.phaseTimeLeft = 120;
    const rob = gw.robots[0];
    rob.autoIntake = true;
    rob.autoFire = true;
    // drop a particle right at the robot's intake mouth so it's captured then fired
    const e = robotExtents(rob);
    const m = rot({ x: e.front - 1, y: 0 }, rob.heading);
    gw.balls[0].state = { kind: 'ground' };
    gw.balls[0].pos = { x: rob.pos.x + m.x, y: rob.pos.y + m.y };
    gw.balls[0].vel = { x: 0, y: 0 };
    const total = (): number => gw.balls.length + gw.robots.reduce((n, r) => n + r.hopper.length, 0);
    const before = total();
    runChain(gw, cmd({}), 2);
    check('chain: a particle is intaked, fired, and scored', gw.chain!.scored.blue >= 1, `scored=${gw.chain!.scored.blue}`);
    check(
      'chain: particle count conserved through the recycle',
      total() === before && before === CHAIN_PARTICLE_SIM,
      `${total()} vs ${before}`,
    );
  }

  // wide roller: a row of particles across the full chassis width is intaked in ONE tick
  {
    const gw = createChainWorld('match', 771, [chainSetup(0, 'blue')]);
    gw.match.phase = 'teleop';
    gw.match.phaseTimeLeft = 120;
    const rob = gw.robots[0];
    rob.autoIntake = true;
    rob.autoFire = false; // isolate intake (don't fire them away this tick)
    const hl = rob.spec.length / 2;
    const hw = rob.spec.width / 2;
    // lay 5 particles spread across the mouth width, right at the front edge
    for (let i = 0; i < 5; i++) {
      const ly = (i - 2) * (hw * 0.4);
      const m = rot({ x: hl + 1, y: ly }, rob.heading);
      gw.balls[i].state = { kind: 'ground' };
      gw.balls[i].pos = { x: rob.pos.x + m.x, y: rob.pos.y + m.y };
      gw.balls[i].vel = { x: 0, y: 0 };
    }
    const held0 = rob.hopper.length;
    runChain(gw, cmd({}), 1);
    check(
      'chain intake: a wide row is gulped multiple-at-once in one tick',
      rob.hopper.length - held0 >= 3,
      `intaked=${rob.hopper.length - held0}`,
    );
  }

  const dumperSetup = (): RobotSetup => {
    const s = chainSetup(0, 'blue');
    s.spec = { ...DEFAULT_SPEC, scoreMode: 'dumper' };
    return s;
  };

  // DUMPER: aims by facing the goal, then flings the whole hopper — and can shoot from a
  // STAND-OFF distance (the tall opening hangs over the field), not just point-blank
  {
    const gw = createChainWorld('match', 801, [dumperSetup()]);
    gw.match.phase = 'teleop';
    gw.match.phaseTimeLeft = 120;
    const rob = gw.robots[0];
    rob.autoIntake = false; // isolate the dump (don't refill from ambient particles)
    rob.autoFire = true;
    rob.heading = 0; // blue faces +x (its goal) — aligned
    rob.pos = { x: CHAIN_HALF_X - 40, y: 0 }; // 40" back from the wall — a real stand-off
    rob.hopper = ['green', 'green', 'green', 'green', 'green', 'green'];
    const before = gw.chain!.scored.blue;
    runChain(gw, cmd({}), 0.6); // let the fanned burst fly in
    check(
      'chain dumper: flings the whole hopper from a stand-off distance',
      gw.chain!.scored.blue - before >= 4,
      `scored+=${gw.chain!.scored.blue - before}`,
    );
  }

  // DUMPER out of range: beyond CHAIN_DUMP_RANGE the dump never fires (limited range)
  {
    const gw = createChainWorld('match', 802, [dumperSetup()]);
    gw.match.phase = 'teleop';
    gw.match.phaseTimeLeft = 120;
    const rob = gw.robots[0];
    rob.autoIntake = false;
    rob.autoFire = true;
    rob.heading = 0; // aligned — so RANGE is the only thing gating the shot
    rob.pos = { x: -20, y: 0 }; // ~92" from the blue mouth — well beyond dump range
    rob.hopper = ['green', 'green', 'green', 'green'];
    const before = gw.chain!.scored.blue;
    runChain(gw, cmd({}), 0.3);
    check(
      'chain dumper: out of range keeps its load (limited range)',
      rob.hopper.length === 4 && gw.chain!.scored.blue === before,
      `hopper=${rob.hopper.length} scored+=${gw.chain!.scored.blue - before}`,
    );
  }

  // DRUM shooter: fires up to 6 at once, from ANY range (aligned)
  {
    const s = chainSetup(0, 'blue');
    s.spec = { ...DEFAULT_SPEC, scoreMode: 'drum' };
    const gw = createChainWorld('match', 803, [s]);
    gw.match.phase = 'teleop';
    gw.match.phaseTimeLeft = 120;
    const rob = gw.robots[0];
    rob.autoIntake = false;
    rob.autoFire = true;
    rob.heading = 0;
    rob.pos = { x: -30, y: 0 }; // >100" from the goal — a drum shoots from anywhere
    rob.hopper = Array(10).fill('green');
    const before = gw.chain!.scored.blue;
    runChain(gw, cmd({}), 1.2);
    check(
      'chain drum: scores from long range (any distance)',
      gw.chain!.scored.blue - before >= 5,
      `scored+=${gw.chain!.scored.blue - before}`,
    );
  }

  // DRUM streams SINGLE particles CONTINUOUSLY — not a 6-then-wait burst. Over 0.5 s it fires
  // several shots (one at a time), never dumping a whole line at once.
  {
    const s = chainSetup(0, 'blue');
    s.spec = { ...DEFAULT_SPEC, scoreMode: 'drum' };
    const gw = createChainWorld('match', 804, [s]);
    gw.match.phase = 'teleop';
    gw.match.phaseTimeLeft = 120;
    const rob = gw.robots[0];
    rob.autoIntake = false;
    rob.autoFire = true;
    rob.heading = 0;
    rob.pos = { x: -30, y: 0 }; // far, so shots don't score+respawn before we count
    rob.hopper = Array(24).fill('green');
    const h0 = rob.hopper.length;
    // one tick fires at most ONE particle (single-ball, not a line)
    runChain(gw, cmd({}), SIM_DT);
    const perTick = h0 - rob.hopper.length;
    runChain(gw, cmd({}), 0.5);
    const drained = h0 - rob.hopper.length;
    check('chain drum: single-ball continuous stream (not a 6-then-wait burst)', perTick === 1 && drained >= 4, `perTick=${perTick} drained=${drained} in ~0.5s`);
  }

  // FIRE CADENCE: the DRUM averages ~24 balls/s (jittered around CHAIN_DRUM_INTERVAL).
  {
    const s = chainSetup(0, 'blue');
    s.spec = { ...DEFAULT_SPEC, scoreMode: 'drum' };
    const gw = createChainWorld('match', 804, [s]);
    gw.match.phase = 'teleop';
    gw.match.phaseTimeLeft = 120;
    const rob = gw.robots[0];
    rob.autoIntake = false; rob.autoFire = true; rob.heading = 0;
    rob.pos = { x: -30, y: 0 };
    const T = 6; rob.hopper = Array(24 * T + 60).fill('green'); // never runs dry
    const h0 = rob.hopper.length;
    runChain(gw, cmd({}), T);
    const bps = (h0 - rob.hopper.length) / T;
    check('chain drum: cadence averages ~24 balls/s', bps >= 22 && bps <= 26, `${bps.toFixed(1)} bps`);
  }

  // FIRE CADENCE: the TURRET fires EXACTLY ~13 balls/s (fractional-carry averages to 13, where
  // a plain tick-quantized re-anchor would land on 12 or 15).
  {
    const s = chainSetup(0, 'blue');
    s.spec = { ...DEFAULT_SPEC, scoreMode: 'turret' };
    const gw = createChainWorld('match', 805, [s]);
    gw.match.phase = 'teleop';
    gw.match.phaseTimeLeft = 120;
    const rob = gw.robots[0];
    rob.autoIntake = false; rob.autoFire = true;
    rob.pos = { x: -30, y: 0 };
    const T = 6; rob.hopper = Array(13 * T + 60).fill('green');
    const h0 = rob.hopper.length;
    runChain(gw, cmd({}), T);
    const bps = (h0 - rob.hopper.length) / T;
    check('chain turret: cadence averages ~13 balls/s', bps >= 12.5 && bps <= 13.5, `${bps.toFixed(2)} bps`);
  }

  // TWIN TURRET: two shooters on one turret — MEASURED rate, storage, and weight, so the
  // archetype's whole tradeoff is pinned by behaviour rather than by reading constants back.
  {
    const rateOf = (mode: RobotSpec['scoreMode']): number => {
      const s = chainSetup(0, 'blue');
      s.spec = { ...DEFAULT_SPEC, scoreMode: mode, massLb: 34 };
      const gw = createChainWorld('match', 806, [s]);
      gw.match.phase = 'teleop';
      gw.match.phaseTimeLeft = 120;
      const rob = gw.robots[0];
      rob.autoIntake = false;
      rob.autoFire = true;
      rob.pos = { x: -30, y: 0 };
      const T = 6;
      rob.hopper = Array(30 * T + 60).fill('green');
      const h0 = rob.hopper.length;
      runChain(gw, cmd({}), T);
      return (h0 - rob.hopper.length) / T;
    };
    const single = rateOf('turret');
    const twinBps = rateOf('twinturret');
    const ratio = twinBps / single;
    // the headline: FASTER than one turret, but only SLIGHTLY — the second barrel isn't the
    // bottleneck (one indexer, one aim solution), so it buys a small edge, not a second gun.
    // Pinned to the constant so the two can't drift apart.
    check(
      'chain twin turret: fires slightly faster than a single turret, nowhere near double',
      ratio > 1.05 && ratio < 1.3,
      `${single.toFixed(1)} → ${twinBps.toFixed(1)} bps (x${ratio.toFixed(2)})`,
    );
    check(
      'chain twin turret: the measured rate matches CHAIN_TWIN_FIRE_MULT',
      Math.abs(ratio - CHAIN_TWIN_FIRE_MULT) < 0.06,
      `measured x${ratio.toFixed(2)} vs constant x${CHAIN_TWIN_FIRE_MULT}`,
    );
    // ...and still slower than the drum, which is the dedicated volume archetype
    check(
      'chain twin turret: still streams slower than the drum',
      twinBps < 24,
      `${twinBps.toFixed(1)} bps vs drum ~24`,
    );
    // STORAGE: a second shooter assembly eats centre volume — strictly less than a single
    // turret, which is already the most cramped archetype
    const capOf = (mode: RobotSpec['scoreMode']) =>
      chainStorageMax({ ...DEFAULT_SPEC, scoreMode: mode, intakeMount: 'front' });
    check(
      'chain twin turret: holds LESS than a single turret (and far less than a drum)',
      capOf('twinturret') < capOf('turret') && capOf('turret') < capOf('drum'),
      `twin ${capOf('twinturret')} < turret ${capOf('turret')} < drum ${capOf('drum')}`,
    );
    // WEIGHT: the second flywheel raises the chassis mass FLOOR, so it can't be built
    // at the lightest weights a single turret can
    const floorOf = (mode: RobotSpec['scoreMode']) =>
      coerceSpec({ ...DEFAULT_SPEC, scoreMode: mode, massLb: 1 }, undefined, 'chain').massLb;
    check(
      'chain twin turret: raises the mass floor (a whole second flywheel assembly)',
      floorOf('twinturret') > floorOf('turret') &&
        floorOf('twinturret') - floorOf('turret') <= CHAIN_TWIN_MASS_FLOOR + 0.01,
      `turret ${floorOf('turret')} → twin ${floorOf('twinturret')} lb`,
    );
    // the weight is MODEST — a second shooter, not a second robot
    check(
      'chain twin turret: the weight cost stays modest (< 15% of the mass range)',
      CHAIN_TWIN_MASS_FLOOR / (DRIVETRAIN_LIMITS.mecanum.maxMass - DRIVETRAIN_LIMITS.mecanum.minMass) < 0.15,
    );
    // it is TURRETED: it aims itself, so the fire button must NOT hijack the heading the
    // way it does for a turretless drum/dumper
    {
      const s2 = chainSetup(0, 'blue');
      s2.spec = { ...DEFAULT_SPEC, scoreMode: 'twinturret' };
      const gw2 = createChainWorld('match', 807, [s2]);
      gw2.match.phase = 'teleop';
      gw2.match.phaseTimeLeft = 120;
      const rob2 = gw2.robots[0];
      rob2.pos = { x: -30, y: 20 };
      rob2.heading = 1.0;
      const h0 = rob2.heading;
      runChain(gw2, cmd({ fire: true }), 0.5);
      check(
        'chain twin turret: is turreted — holding fire does not steer the chassis',
        Math.abs(wrapAngle(rob2.heading - h0)) < 1e-6,
      );
      // BOTH barrels are really used: fire a short burst and check consecutive shots are
      // born on OPPOSITE sides of the turret centreline (a mirror pair, not one muzzle).
      const s3 = chainSetup(0, 'blue');
      s3.spec = { ...DEFAULT_SPEC, scoreMode: 'twinturret', massLb: 34 };
      const gw3 = createChainWorld('match', 808, [s3]);
      gw3.match.phase = 'teleop';
      gw3.match.phaseTimeLeft = 120;
      const rob3 = gw3.robots[0];
      rob3.autoIntake = false;
      rob3.autoFire = true;
      rob3.pos = { x: -30, y: 0 };
      rob3.hopper = Array(20).fill('green');
      // measure each shot AT BIRTH — a ball sampled later has flown tens of inches, which
      // would swamp a 1.5" muzzle offset (and make this assertion pass by accident)
      const seen = new Set(gw3.balls.map((b) => b.id));
      const lats: number[] = [];
      for (let i = 0; i < 24; i++) {
        runChain(gw3, cmd({}), SIM_DT);
        const dir = { x: dcos(rob3.turretHeading), y: dsin(rob3.turretHeading) };
        for (const b of gw3.balls) {
          if (seen.has(b.id)) continue;
          seen.add(b.id);
          lats.push((b.pos.x - rob3.pos.x) * -dir.y + (b.pos.y - rob3.pos.y) * dir.x);
        }
      }
      const near = (v: number, t: number) => Math.abs(v - t) < 0.25;
      check(
        'chain twin turret: consecutive shots leave from OPPOSITE barrels (±offset, alternating)',
        lats.length >= 4 &&
          lats.every((l) => near(l, CHAIN_TWIN_BARREL_OFFSET) || near(l, -CHAIN_TWIN_BARREL_OFFSET)) &&
          lats.slice(1).every((l, i) => Math.sign(l) === -Math.sign(lats[i])),
        `${lats.length} shots, lats ${lats.slice(0, 4).map((l) => l.toFixed(2)).join(' ')}`,
      );
    }
    // both barrels share ONE aim solution — the muzzle offset moves where the ball is BORN,
    // not where it is pointed, so a twin is no less accurate than a single turret
    check(
      'chain twin turret: the barrel offset is a muzzle position, not an aim change',
      CHAIN_TWIN_BARREL_OFFSET > 0 && CHAIN_TWIN_BARREL_OFFSET < 3,
      `${CHAIN_TWIN_BARREL_OFFSET}"`,
    );
  }

  // TURN-TO-AIM control: holding fire steers a turretless shooter to face the goal, then it fires
  {
    const s = chainSetup(0, 'blue');
    s.spec = { ...DEFAULT_SPEC, scoreMode: 'drum' };
    const gw = createChainWorld('match', 805, [s]);
    gw.match.phase = 'teleop';
    gw.match.phaseTimeLeft = 120;
    const rob = gw.robots[0];
    rob.autoIntake = false;
    rob.autoFire = false; // NOT auto — the manual fire button must do the aiming
    rob.heading = Math.PI; // facing AWAY from the blue (+x) goal
    rob.pos = { x: -20, y: 0 };
    rob.hopper = Array(6).fill('green');
    const before = gw.chain!.scored.blue;
    runChain(gw, cmd({ fire: true }), 1.6); // hold fire → turns to the goal, then shoots
    const aligned = Math.abs(Math.atan2(Math.sin(rob.heading), Math.cos(rob.heading))) < 0.2;
    check(
      'chain aim: holding fire turns a drum to face the goal, then it fires',
      aligned && gw.chain!.scored.blue - before >= 1,
      `heading=${rob.heading.toFixed(2)} scored+=${gw.chain!.scored.blue - before}`,
    );
  }

  // AIM AT THE GOAL CENTER: an OFF-AXIS robot turns DIAGONALLY to face the opening center
  // (maximizing balls in), NOT parallel to the field wall
  {
    const s = chainSetup(0, 'blue');
    s.spec = { ...DEFAULT_SPEC, scoreMode: 'drum' };
    const gw = createChainWorld('match', 809, [s]);
    gw.match.phase = 'teleop';
    gw.match.phaseTimeLeft = 120;
    const rob = gw.robots[0];
    rob.autoIntake = false;
    rob.autoFire = false;
    rob.heading = Math.PI;
    rob.pos = { x: 10, y: 40 }; // well off the goal's y=0 axis
    rob.hopper = Array(6).fill('green');
    const expected = Math.atan2(0 - rob.pos.y, CHAIN_HALF_X - rob.pos.x); // ≈ −0.57 (diagonal)
    const before = gw.chain!.scored.blue;
    runChain(gw, cmd({ fire: true }), 1.8);
    const err = Math.abs(Math.atan2(Math.sin(rob.heading - expected), Math.cos(rob.heading - expected)));
    check(
      'chain aim: off-axis robot faces the goal CENTER (diagonal), not parallel to the wall',
      err < 0.25 && Math.abs(expected) > 0.3 && gw.chain!.scored.blue - before >= 1,
      `heading=${rob.heading.toFixed(2)} expected=${expected.toFixed(2)} err=${err.toFixed(2)} scored+=${gw.chain!.scored.blue - before}`,
    );
  }

  // SHOOTING ON THE MOVE (turretless LEAD): a moving drum's chassis-heading LEAD makes the shot
  // (muzzle along heading + inherited chassis velocity) head straight at the goal.
  {
    const s = chainSetup(0, 'blue');
    s.spec = { ...DEFAULT_SPEC, scoreMode: 'drum' };
    const gw = createChainWorld('match', 830, [s]);
    const rob = gw.robots[0];
    rob.pos = { x: 0, y: 0 };
    rob.vel = { x: 0, y: 40 }; // strafing across the goal line
    const aim = chainGoalAimHeading(rob); // leads: not straight at the goal (+x = 0)
    const netx = Math.cos(aim) * CHAIN_DRUM_SPEED + rob.vel.x;
    const nety = Math.sin(aim) * CHAIN_DRUM_SPEED + rob.vel.y;
    check(
      'chain move-shot: turretless chassis-heading lead cancels the cross velocity (net heads at goal)',
      Math.abs(aim) > 0.05 && Math.abs(nety) < 0.6 && netx > 0,
      `aim=${aim.toFixed(3)} net=(${netx.toFixed(1)},${nety.toFixed(2)})`,
    );
  }

  // SHOOTING ON THE MOVE (turret LEAD): a strafing turret still scores — the turret leads.
  {
    const gw = createChainWorld('match', 831, [chainSetup(0, 'blue')]);
    gw.match.phase = 'teleop';
    gw.match.phaseTimeLeft = 120;
    const rob = gw.robots[0];
    rob.autoIntake = false;
    rob.autoFire = true;
    rob.pos = { x: 30, y: 0 };
    rob.turretHeading = Math.atan2(0 - rob.pos.y, 72 - rob.pos.x); // already tracking (test teleports it)
    rob.hopper = Array(12).fill('green');
    const before = gw.chain!.scored.blue;
    // strafe sideways the whole time (driveY) while auto-firing the turret
    runChain(gw, cmd({ driveY: 1 }), 1.5);
    check(
      'chain move-shot: a strafing turret still scores (turret leads to compensate)',
      gw.chain!.scored.blue - before >= 3,
      `scored+=${gw.chain!.scored.blue - before}`,
    );
  }

  // PHYSICAL aim: a turret that gets a SUDDEN velocity change (a shove) can't re-aim in time, so
  // the shot flies along its STALE heading + the new velocity and MISSES — the trajectory depends
  // on the robot's physical state, not a per-shot re-solved guarantee.
  {
    const aimErr = (settledV: number, shockV: number): number => {
      const gw = createChainWorld('match', 3, [chainSetup(0, 'blue')]);
      gw.match.phase = 'teleop'; gw.match.phaseTimeLeft = 120; gw.balls = [];
      const rob = gw.robots[0]; rob.pos = { x: 0, y: 0 };
      const idle = new Map([[rob.id, cmd({})]]);
      // settle the turret aim while moving at `settledV` (no fire), holding the velocity
      for (let i = 0; i < 170; i++) { rob.vel = { x: 0, y: settledV }; updateChain(gw, SIM_DT, idle, true); }
      // INSTANT velocity shock (like a collision), then fire ONE shot this tick
      rob.vel = { x: 0, y: shockV }; rob.hopper = ['green'];
      updateChain(gw, SIM_DT, new Map([[rob.id, cmd({ fire: true })]]), true);
      const ball = gw.balls.find((b) => b.state.kind === 'flight');
      if (!ball) return -1;
      const toGoal = Math.atan2(-rob.pos.y, 72 - rob.pos.x);
      return Math.abs(Math.atan2(ball.vel.y, ball.vel.x) - toGoal) * 180 / Math.PI;
    };
    check('chain aim: a settled/steady turret shoots accurately (net heads at the goal)',
      aimErr(0, 0) < 2 && aimErr(50, 50) < 3, `still=${aimErr(0, 0).toFixed(1)}° steady=${aimErr(50, 50).toFixed(1)}°`);
    check('chain aim: a SUDDEN shove throws the shot off (turret can\'t react in time)',
      aimErr(0, 60) > 10, `shockErr=${aimErr(0, 60).toFixed(1)}°`);
  }

  // DRUM stream: SAME launch speed every shot, but a NON-UNIFORM lateral PATTERN (random
  // position across the width) — never a rigid line.
  {
    const s = chainSetup(0, 'blue');
    s.spec = { ...DEFAULT_SPEC, scoreMode: 'drum' };
    const gw = createChainWorld('match', 806, [s]);
    gw.match.phase = 'teleop';
    gw.match.phaseTimeLeft = 120;
    const rob = gw.robots[0];
    rob.autoIntake = false;
    rob.autoFire = true;
    rob.heading = 0;
    rob.pos = { x: -30, y: 0 }; // far, so shots stay airborne while we collect them
    rob.hopper = Array(24).fill('green');
    runChain(gw, cmd({}), 0.35);
    const flight = gw.balls.filter((b) => b.state.kind === 'flight' && !(b.state as { scored?: boolean }).scored);
    const speeds = flight.map((b) => Math.hypot(b.vel.x, b.vel.y));
    const ys = flight.map((b) => b.pos.y);
    const sameSpeed = flight.length >= 3 && Math.max(...speeds) - Math.min(...speeds) < 1e-6;
    const nonUniform = flight.length >= 3 && Math.max(...ys) - Math.min(...ys) > 4;
    check('chain drum: uniform SPEED but a non-uniform (varied) launch pattern', sameSpeed && nonUniform, `n=${flight.length} spdSpread=${(Math.max(...speeds) - Math.min(...speeds)).toFixed(3)} ySpread=${(Math.max(...ys) - Math.min(...ys)).toFixed(1)}`);
  }

  // DUMPER: the whole-hopper catapult has side-to-side velocity VARIANCE (scatter)
  {
    const s = chainSetup(0, 'blue');
    s.spec = { ...DEFAULT_SPEC, scoreMode: 'dumper' };
    const gw = createChainWorld('match', 816, [s]);
    gw.match.phase = 'teleop';
    gw.match.phaseTimeLeft = 120;
    const rob = gw.robots[0];
    rob.autoIntake = false;
    rob.autoFire = true;
    rob.heading = 0;
    rob.pos = { x: 30, y: 0 }; // within dump range (distMouth 42 < 56)
    rob.hopper = Array(6).fill('green');
    runChain(gw, cmd({}), SIM_DT);
    const pv = gw.balls.filter((b) => b.state.kind === 'flight').map((b) => Math.hypot(b.vel.x, b.vel.y));
    check('chain dumper: side-to-side launch-velocity variance', pv.length >= 3 && Math.max(...pv) - Math.min(...pv) > 10, `n=${pv.length} spread=${(Math.max(...pv) - Math.min(...pv)).toFixed(1)}`);
  }

  // GOAL FUNNEL: a scored particle DWELLS inside the goal (funnels down) before the
  // wall-side launcher flings it back out — it is not ejected instantly
  {
    const gw = createChainWorld('match', 807, [chainSetup(0, 'blue')]);
    gw.match.phase = 'teleop';
    gw.match.phaseTimeLeft = 120;
    // a flight ball just short of the blue opening, heading in on the centerline
    gw.balls[0].state = { kind: 'flight', target: 'blue' };
    gw.balls[0].pos = { x: CHAIN_HALF_X - 3, y: 0 };
    gw.balls[0].vel = { x: 300, y: 0 };
    gw.balls[0].z = 10;
    gw.balls[0].vz = 0;
    const id = gw.balls[0].id;
    runChain(gw, cmd({}), SIM_DT); // one tick → crosses the opening + scores
    const b1 = gw.balls.find((b) => b.id === id)!;
    const dwelling = b1.state.kind === 'flight' && b1.state.scored === true && (b1.state.funnelT ?? 0) > 0;
    runChain(gw, cmd({}), 0.7); // past the funnel dwell → launched back onto the field
    const b2 = gw.balls.find((b) => b.id === id)!;
    const relaunched = b2.state.kind !== 'flight' || b2.vel.x < 0; // moving back into the field (−x)
    check('chain goal: a scored particle funnels down before re-launch', dwelling && relaunched);
  }

  // GOAL BOUNCE: scored particles keep momentum and BOUNCE to VARIED positions inside the box —
  // they do NOT all snap to one x and eject instantly.
  {
    const gw = createChainWorld('match', 818, [chainSetup(0, 'blue')]);
    gw.match.phase = 'teleop';
    gw.match.phaseTimeLeft = 120;
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const b = gw.balls[i];
      b.state = { kind: 'flight', target: 'blue' };
      b.pos = { x: CHAIN_HALF_X - 3, y: (i - 2) * 6 };
      b.vel = { x: 120 + i * 40, y: 0 }; // different depths of entry
      b.z = 10;
      b.vz = 0;
      ids.push(b.id);
    }
    runChain(gw, cmd({}), 0.12); // a few ticks in — scattered around the box
    const inBox = gw.balls.filter(
      (b) => ids.includes(b.id) && b.state.kind === 'flight' && (b.state as { scored?: boolean }).scored,
    );
    const xs = inBox.map((b) => b.pos.x);
    check(
      'chain goal: scored particles bounce to VARIED x inside the box (not one x, not instant eject)',
      inBox.length >= 3 && Math.max(...xs) - Math.min(...xs) > 5,
      `n=${inBox.length} xSpread=${inBox.length ? (Math.max(...xs) - Math.min(...xs)).toFixed(1) : 'na'}`,
    );
  }

  // MISS → HUMAN THROW-BACK: a particle that misses the opening is thrown back INTO the field
  {
    const gw = createChainWorld('match', 808, [chainSetup(0, 'blue')]);
    gw.match.phase = 'teleop';
    gw.match.phaseTimeLeft = 120;
    const before = gw.chain!.scored.blue;
    gw.balls[0].state = { kind: 'flight', target: 'blue' };
    gw.balls[0].pos = { x: CHAIN_HALF_X - 3, y: 40 }; // y=40 is OUTSIDE the opening (±27.4)
    gw.balls[0].vel = { x: 300, y: 0 };
    gw.balls[0].z = 10;
    gw.balls[0].vz = 0;
    const id = gw.balls[0].id;
    runChain(gw, cmd({}), SIM_DT);
    const b = gw.balls.find((x) => x.id === id)!;
    const thrownBack =
      b.state.kind === 'ground' &&
      Math.abs(b.pos.x) < CHAIN_HALF_X &&
      b.vel.x < 0 && // tossed back inward (−x from the +x wall)
      gw.chain!.scored.blue === before; // a miss never scores
    check('chain miss: a missed particle is thrown back into the field (not scored)', thrownBack, `kind=${b.state.kind} x=${b.pos.x.toFixed(1)} vx=${b.vel.x.toFixed(1)}`);
  }

  // INTAKE reaches the COLLISION FRONT: a particle right at the intake tip is captured (not
  // plowed forward) — this is what keeps intaking fast when driving into a cluster.
  {
    const gw = createChainWorld('match', 820, [chainSetup(0, 'blue')]);
    gw.match.phase = 'teleop';
    gw.match.phaseTimeLeft = 120;
    const rob = gw.robots[0];
    rob.autoIntake = true;
    rob.autoFire = false;
    rob.heading = 0;
    rob.pos = { x: 0, y: 0 };
    const mouth = chainIntakeMouths(rob.spec)[0];
    // a particle right at the intake tip (the collision front) → captured this tick
    gw.balls[0].state = { kind: 'ground' };
    gw.balls[0].pos = { x: rob.pos.x + mouth.x1, y: 0 };
    gw.balls[0].vel = { x: 0, y: 0 };
    const id = gw.balls[0].id;
    runChain(gw, cmd({}), SIM_DT);
    check(
      'chain intake: captures at the collision front (no plow-forward slowness)',
      !gw.balls.some((b) => b.id === id),
    );
  }

  // REAR SHOOTER: a drum mounted at the BACK turns its back to the goal (aim heading = toGoal+π)
  // and still scores from range.
  {
    const s = chainSetup(0, 'blue');
    s.spec = { ...DEFAULT_SPEC, scoreMode: 'drum', shooterMount: 'back' };
    const gw = createChainWorld('match', 821, [s]);
    gw.match.phase = 'teleop';
    gw.match.phaseTimeLeft = 120;
    const rob = gw.robots[0];
    rob.autoIntake = false;
    rob.autoFire = true;
    rob.pos = { x: -30, y: 0 };
    rob.heading = Math.PI; // BACK (+x) faces the blue (+x) goal
    rob.hopper = Array(10).fill('green');
    const aim = chainGoalAimHeading(rob);
    const before = gw.chain!.scored.blue;
    runChain(gw, cmd({}), 1.0);
    check(
      'chain rear-shooter: back faces the goal (aim = toGoal+π) and it scores',
      Math.abs(Math.atan2(Math.sin(aim - Math.PI), Math.cos(aim - Math.PI))) < 1e-6 &&
        gw.chain!.scored.blue - before >= 3,
      `aim=${aim.toFixed(2)} scored+=${gw.chain!.scored.blue - before}`,
    );
  }

  // INTAKE: the full-width sweeper — grabs anywhere across the chassis width, but its
  // capture stays ~chassis-sized (no grab past the frame side / far ahead of the tip)
  {
    const mk = () => {
      const setup = chainSetup(0, 'blue');
      setup.spec = { ...DEFAULT_SPEC, chainIntake: 'sweeper' };
      const gw = createChainWorld('match', 803, [setup]);
      gw.match.phase = 'teleop';
      gw.match.phaseTimeLeft = 120;
      const rob = gw.robots[0];
      rob.heading = 0;
      rob.pos = { x: 0, y: 20 };
      rob.autoIntake = true;
      rob.autoFire = false;
      return { gw, rob };
    };
    // capture is measured off the CHASSIS (length/2 × width/2), not the collision OBB
    const spec0 = mk().rob.spec;
    const hl = spec0.length / 2;
    const hw = spec0.width / 2;
    const place = (gw: World, rob: (typeof gw.robots)[number], dx: number, dy: number): number => {
      const p = rot({ x: dx, y: dy }, rob.heading);
      gw.balls[0].state = { kind: 'ground' };
      gw.balls[0].pos = { x: rob.pos.x + p.x, y: rob.pos.y + p.y };
      gw.balls[0].vel = { x: 0, y: 0 };
      return gw.balls[0].id;
    };
    const gone = (gw: World, id: number): boolean => !gw.balls.some((b) => b.id === id);
    // a wide particle at 0.85·half-width: the full-width sweeper swallows it
    const r2 = mk();
    const idRW = place(r2.gw, r2.rob, hl - 1, hw * 0.85);
    runChain(r2.gw, cmd({}), SIM_DT);
    check('chain intake: the full-width sweeper grabs a wide particle', gone(r2.gw, idRW));
    // ACCURACY: capture stays ~chassis-sized — a particle 2" outside the chassis side,
    // or well ahead of the small front bite, is NOT swallowed
    const rSide = mk();
    const idSide = place(rSide.gw, rSide.rob, hl - 1, hw + 2); // 2" past the frame side
    runChain(rSide.gw, cmd({}), SIM_DT);
    const rFar = mk();
    const idFar = place(rFar.gw, rFar.rob, hl + 8, 0); // well beyond the intake tip
    runChain(rFar.gw, cmd({}), SIM_DT);
    check(
      'chain intake: capture stays ~chassis-sized (no grab past the frame side / far ahead)',
      !gone(rSide.gw, idSide) && !gone(rFar.gw, idFar),
    );
  }

  // SIDE-mount sweeper: grabs from the LEFT/RIGHT edges (not the front), holds fewer, and its
  // rollers are part of the collision hitbox (wider footprint) — like DECODE's front intake.
  {
    const mkSide = (side: boolean) => {
      const setup = chainSetup(0, 'blue');
      setup.spec = { ...DEFAULT_SPEC, scoreMode: 'drum', intakeMount: side ? 'side' : 'front' };
      const gw = createChainWorld('match', 909, [setup]);
      gw.match.phase = 'teleop'; gw.match.phaseTimeLeft = 120;
      const rob = gw.robots[0]; rob.heading = 0; rob.pos = { x: 0, y: 20 }; rob.autoIntake = true; rob.autoFire = false;
      return { gw, rob };
    };
    const hw = DEFAULT_SPEC.width / 2;
    const place = (gw: World, rob: (typeof gw.robots)[number], dx: number, dy: number): number => {
      const p = rot({ x: dx, y: dy }, rob.heading);
      gw.balls[0].state = { kind: 'ground' }; gw.balls[0].pos = { x: rob.pos.x + p.x, y: rob.pos.y + p.y }; gw.balls[0].vel = { x: 0, y: 0 };
      return gw.balls[0].id;
    };
    const gone = (gw: World, id: number): boolean => !gw.balls.some((b) => b.id === id);
    // a particle beside the RIGHT edge is grabbed by a SIDE intake, ignored by a FRONT one
    const sd = mkSide(true); const idS = place(sd.gw, sd.rob, 0, -(hw + 1));
    runChain(sd.gw, cmd({}), SIM_DT);
    const fr = mkSide(false); const idF = place(fr.gw, fr.rob, 0, -(hw + 1));
    runChain(fr.gw, cmd({}), SIM_DT);
    check('chain side-intake: grabs a particle alongside the edge (a front sweeper misses it)', gone(sd.gw, idS) && !gone(fr.gw, idF));
    // lower storage cap
    const sideMax = chainStorageMax({ ...DEFAULT_SPEC, scoreMode: 'drum', intakeMount: 'side' });
    const frontMax = chainStorageMax({ ...DEFAULT_SPEC, scoreMode: 'drum', intakeMount: 'front' });
    check('chain side-intake: holds fewer than a front sweeper', sideMax < frontMax, `side=${sideMax} front=${frontMax}`);
    // the intake is part of the collision hitbox: side mount widens the footprint, no front reach
    const eSide = robotExtents({ ...sd.rob, spec: { ...DEFAULT_SPEC, intakeMount: 'side' } } as typeof sd.rob);
    const eFront = robotExtents({ ...fr.rob, spec: { ...DEFAULT_SPEC, intakeMount: 'front' } } as typeof fr.rob);
    check('chain side-intake: rollers extend the collision hitbox sideways (front reach moves to the sides)',
      eSide.half > DEFAULT_SPEC.width / 2 && Math.abs(eSide.front - DEFAULT_SPEC.length / 2) < 0.01 && eFront.front > DEFAULT_SPEC.length / 2,
      `sideHalf=${eSide.half.toFixed(1)} sideFront=${eSide.front.toFixed(1)} frontFront=${eFront.front.toFixed(1)}`);
  }

  // ── MECHANISM MOUNTS ─────────────────────────────────────────────────────────────────────
  // The sweeper mounts FRONT / BACK / SIDES / FRONT+BACK and the turretless launcher fires
  // over ANY of the four edges. Each mount has to move three things together: the CAPTURE
  // band, the COLLISION footprint, and (shooter) the aim heading + launch line.
  {
    const mkMount = (patch: Partial<RobotSpec>, seed: number) => {
      const setup = chainSetup(0, 'blue');
      setup.spec = { ...DEFAULT_SPEC, scoreMode: 'drum', ...patch };
      const gw = createChainWorld('match', seed, [setup]);
      gw.match.phase = 'teleop';
      gw.match.phaseTimeLeft = 120;
      const rob = gw.robots[0];
      rob.heading = 0;
      rob.pos = { x: 0, y: 20 };
      rob.autoIntake = true;
      rob.autoFire = false;
      return { gw, rob };
    };
    const put = (gw: World, rob: (typeof gw.robots)[number], dx: number, dy: number): number => {
      const p = rot({ x: dx, y: dy }, rob.heading);
      gw.balls[0].state = { kind: 'ground' };
      gw.balls[0].pos = { x: rob.pos.x + p.x, y: rob.pos.y + p.y };
      gw.balls[0].vel = { x: 0, y: 0 };
      return gw.balls[0].id;
    };
    const eaten = (gw: World, id: number): boolean => !gw.balls.some((b) => b.id === id);
    const hl = DEFAULT_SPEC.length / 2;
    const hw = DEFAULT_SPEC.width / 2;
    /** does mount `m` swallow a particle placed at robot-local (dx,dy) in one tick? */
    const grabs = (m: RobotSpec['intakeMount'], dx: number, dy: number, seed: number): boolean => {
      const t = mkMount({ intakeMount: m }, seed);
      const id = put(t.gw, t.rob, dx, dy);
      runChain(t.gw, cmd({}), SIM_DT);
      return eaten(t.gw, id);
    };
    // BACK mount: grabs behind the chassis, and NOT in front (the mirror of a front sweeper)
    check(
      'chain back-intake: grabs behind the chassis and no longer grabs in front',
      grabs('back', -(hl + 1), 0, 940) && !grabs('back', hl + 1, 0, 941),
      `behind=${grabs('back', -(hl + 1), 0, 940)} front=${grabs('back', hl + 1, 0, 941)}`,
    );
    // FRONT+BACK mount: BOTH ends grab (drive either way), flanks still don't
    check(
      'chain front+back intake: both ends grab, the flanks still do not',
      grabs('frontback', hl + 1, 0, 942) &&
        grabs('frontback', -(hl + 1), 0, 943) &&
        !grabs('frontback', 0, hw + 1, 944),
    );
    // a FRONT mount must NOT grab behind (guards against a mouth list that leaks edges)
    check('chain front-intake: does not grab behind the chassis', !grabs('front', -(hl + 1), 0, 945));

    // COLLISION FOOTPRINT follows the mount — the rollers are physical on whichever edge
    // they are bolted to (this is what keeps a rear intake from clipping through a wall).
    const ext = (m: RobotSpec['intakeMount']) => footprintExtents({ ...DEFAULT_SPEC, intakeMount: m });
    const eF = ext('front');
    const eB = ext('back');
    const eFB = ext('frontback');
    const eS = ext('side');
    const reach = INTAKE_PRESETS[DEFAULT_SPEC.intake].reach;
    check(
      'chain intake mounts: the collision hitbox grows on exactly the mounted edge(s)',
      Math.abs(eB.rear - (hl + reach)) < 1e-9 &&
        Math.abs(eB.front - hl) < 1e-9 && // back mount: rear only
        Math.abs(eFB.front - (hl + reach)) < 1e-9 &&
        Math.abs(eFB.rear - (hl + reach)) < 1e-9 && // frontback: both ends
        Math.abs(eFB.half - hw) < 1e-9 &&
        Math.abs(eS.half - (hw + reach)) < 1e-9 && // side: flanks only
        Math.abs(eS.front - hl) < 1e-9 &&
        Math.abs(eF.front - (hl + reach)) < 1e-9,
      `back=${eB.front.toFixed(1)}/${eB.rear.toFixed(1)} fb=${eFB.front.toFixed(1)}/${eFB.rear.toFixed(1)} side=${eS.half.toFixed(1)}`,
    );

    // STORAGE cost ranks by how much of the perimeter is left open: front == back (mirror
    // images, so a rear sweeper is free) > frontback (two ends) > side (two full flanks).
    const cap = (m: RobotSpec['intakeMount']) =>
      chainStorageMax({ ...DEFAULT_SPEC, scoreMode: 'drum', intakeMount: m });
    check(
      'chain intake mounts: storage front == back > front+back > side',
      cap('front') === cap('back') && cap('front') > cap('frontback') && cap('frontback') > cap('side'),
      `front=${cap('front')} back=${cap('back')} fb=${cap('frontback')} side=${cap('side')}`,
    );

    // SHOOTER on all four edges: the aim heading turns the MOUNTED EDGE to the goal, so the
    // heading is offset by that edge's angle — and it still actually scores from range.
    const EDGE_OFF: Record<string, number> = { front: 0, back: Math.PI, left: Math.PI / 2, right: -Math.PI / 2 };
    let aimOk = true;
    let scoreOk = true;
    const detail: string[] = [];
    for (const m of ['front', 'back', 'left', 'right'] as const) {
      const s = chainSetup(0, 'blue');
      s.spec = { ...DEFAULT_SPEC, scoreMode: 'drum', shooterMount: m };
      const gw = createChainWorld('match', 950 + EDGE_OFF[m], [s]);
      gw.match.phase = 'teleop';
      gw.match.phaseTimeLeft = 120;
      const rob = gw.robots[0];
      rob.autoIntake = false;
      rob.autoFire = true;
      rob.pos = { x: -30, y: 0 };
      rob.hopper = Array(10).fill('green');
      // face the goal (+x) with the MOUNTED edge, then check the solver agrees
      rob.heading = wrapAngle(0 - EDGE_OFF[m]);
      const aim = chainGoalAimHeading(rob);
      if (Math.abs(wrapAngle(aim - rob.heading)) > 1e-6) aimOk = false;
      const before = gw.chain!.scored.blue;
      runChain(gw, cmd({}), 1.0);
      const got = gw.chain!.scored.blue - before;
      if (got < 3) scoreOk = false;
      detail.push(`${m}:${got}`);
    }
    check('chain shooter mounts: all four edges aim the mounted edge at the goal', aimOk);
    check('chain shooter mounts: all four edges score from range', scoreOk, detail.join(' '));

    // the LAUNCH LINE spans the MOUNTED edge: on a flank it spreads across the chassis
    // LENGTH, not its width — so a long, narrow robot fires a wider broadside than nose-on.
    {
      const spread = (m: RobotSpec['shooterMount']): number => {
        const s = chainSetup(0, 'blue');
        // deliberately non-square so length-vs-width spread is distinguishable
        s.spec = { ...DEFAULT_SPEC, scoreMode: 'dumper', shooterMount: m, length: 12, width: 18, ballStorage: 12 };
        const gw = createChainWorld('match', 977, [s]);
        gw.match.phase = 'teleop';
        gw.match.phaseTimeLeft = 120;
        const rob = gw.robots[0];
        rob.autoIntake = false;
        rob.autoFire = true;
        rob.pos = { x: 30, y: 0 }; // inside CHAIN_DUMP_RANGE of the blue mouth (+x)
        rob.heading = wrapAngle(0 - EDGE_OFF[m as string]);
        rob.hopper = Array(8).fill('green');
        const ids = new Set(gw.balls.map((b) => b.id));
        runChain(gw, cmd({}), SIM_DT * 2);
        // the fresh shots: spread of their launch points across the launch line
        const fresh = gw.balls.filter((b) => !ids.has(b.id));
        const along = fresh.map((b) => {
          const p = rot({ x: b.pos.x - rob.pos.x, y: b.pos.y - rob.pos.y }, -rob.heading);
          // measure across the edge: ends spread in local y, flanks in local x
          return m === 'front' || m === 'back' ? p.y : p.x;
        });
        return along.length ? Math.max(...along) - Math.min(...along) : 0;
      };
      const front = spread('front'); // spans width 18
      const left = spread('left'); // spans length 12
      check(
        'chain shooter mounts: the launch line spans the mounted edge (flank = chassis length)',
        front > left + 2 && left > 4,
        `frontSpread=${front.toFixed(1)} leftSpread=${left.toFixed(1)}`,
      );
    }

    // LEGACY MIGRATION: the old intakeSide/shooterRear booleans still resolve, coerceSpec
    // normalizes them into the new mounts, and MIRRORS them back so a spec routed through an
    // older peer (which drops unknown fields) round-trips instead of silently resetting.
    {
      const old = coerceSpec({ ...DEFAULT_SPEC, intakeMount: undefined, shooterMount: undefined, intakeSide: true, shooterRear: true });
      const mirrored = coerceSpec({ ...DEFAULT_SPEC, intakeMount: 'side', shooterMount: 'back' });
      // an older peer strips the new fields — what survives is the mirror
      const stripped = coerceSpec({ ...mirrored, intakeMount: undefined, shooterMount: undefined });
      check(
        'chain mounts: legacy intakeSide/shooterRear migrate, and coerceSpec mirrors them back',
        old.intakeMount === 'side' &&
          old.shooterMount === 'back' &&
          mirrored.intakeSide === true &&
          mirrored.shooterRear === true &&
          stripped.intakeMount === 'side' &&
          stripped.shooterMount === 'back',
        `old=${old.intakeMount}/${old.shooterMount} stripped=${stripped.intakeMount}/${stripped.shooterMount}`,
      );
      // an unknown/garbage mount falls back to the default rather than reaching the sim
      const junk = coerceSpec({ ...DEFAULT_SPEC, intakeMount: 'diagonal', shooterMount: 7 });
      check(
        'chain mounts: a bogus mount coerces to the default (never reaches the sim)',
        junk.intakeMount === 'front' && junk.shooterMount === 'front',
        `${junk.intakeMount}/${junk.shooterMount}`,
      );
      // the resolvers agree with the coerced spec (single source of truth for read sites)
      check(
        'chain mounts: intakeMountOf/shooterMountOf agree with the coerced spec',
        intakeMountOf(mirrored) === 'side' && shooterMountOf(mirrored) === 'back',
      );
    }

    // MOUNTS ARE CHAIN-ONLY. The intake mount moves the COLLISION FOOTPRINT, so a CR build
    // reaching DECODE would widen its flanks and delete its front intake reach. coerceSpec
    // normalizes whenever the game is explicitly non-chain — and must NOT when it's unknown,
    // since several call paths omit `game` and would otherwise wipe a real CR build.
    {
      const crBuild = { ...DEFAULT_SPEC, intakeMount: 'side' as const, shooterMount: 'left' as const };
      const asChain = coerceSpec(crBuild, DEFAULT_SPEC, 'chain');
      const asDecode = coerceSpec(crBuild, DEFAULT_SPEC, 'decode');
      const noGame = coerceSpec(crBuild, DEFAULT_SPEC);
      check(
        'mounts are chain-only: a CR mount is stripped for DECODE, kept when the game is unknown',
        asChain.intakeMount === 'side' &&
          asChain.shooterMount === 'left' &&
          asDecode.intakeMount === 'front' &&
          asDecode.shooterMount === 'front' &&
          asDecode.intakeSide === false &&
          noGame.intakeMount === 'side',
        `chain=${asChain.intakeMount} decode=${asDecode.intakeMount} noGame=${noGame.intakeMount}`,
      );
      // the point of the strip: DECODE's hitbox keeps its FRONT intake reach and normal width
      const eD = footprintExtents(asDecode);
      const eRef = footprintExtents(coerceSpec(DEFAULT_SPEC, DEFAULT_SPEC, 'decode'));
      check(
        'mounts are chain-only: a leaked CR spec cannot reshape the DECODE collision box',
        Math.abs(eD.front - eRef.front) < 1e-9 &&
          Math.abs(eD.half - eRef.half) < 1e-9 &&
          Math.abs(eD.rear - eRef.rear) < 1e-9,
        `leaked=${eD.front.toFixed(2)}/${eD.half.toFixed(2)} ref=${eRef.front.toFixed(2)}/${eRef.half.toFixed(2)}`,
      );
      // the UI path: switching games swaps in that game's OWN loadout and restores it on return
      const sChain = coerceSettings({ game: 'chain', spec: crBuild });
      const sDecode = switchGame(sChain, 'decode');
      const sBack = switchGame(sDecode, 'chain');
      check(
        'switchGame: the robot build does NOT carry across a game switch (and is restored on return)',
        intakeMountOf(sChain.spec) === 'side' &&
          intakeMountOf(sDecode.spec) === 'front' &&
          shooterMountOf(sDecode.spec) === 'front' &&
          intakeMountOf(sBack.spec) === 'side' &&
          shooterMountOf(sBack.spec) === 'left',
        `chain=${intakeMountOf(sChain.spec)} decode=${intakeMountOf(sDecode.spec)} back=${intakeMountOf(sBack.spec)}`,
      );
    }

    // ── DRIVER ASSISTS RIDE THE ROBOT (both games), all ON by default ──────────────────
    {
      // 1. the default robot has every assist enabled, in BOTH games
      const dDecode = coerceSpec(DEFAULT_SPEC, DEFAULT_SPEC, 'decode').assists!;
      const dChain = coerceSpec(DEFAULT_SPEC, DEFAULT_SPEC, 'chain').assists!;
      const allOn = (a: typeof dDecode): boolean =>
        a.fieldCentric && a.aimAssist && a.autoIntake && a.autoFire;
      check(
        'assists: every assist defaults ON, for DECODE and Chain Reaction alike',
        allOn(dDecode) && allOn(dChain) && allOn(defaultSettings().assists),
        `decode=${JSON.stringify(dDecode)} chain=${JSON.stringify(dChain)}`,
      );

      // 2. they are STORED on the spec, so they survive the coercer field-by-field
      const custom = coerceSpec(
        { ...DEFAULT_SPEC, assists: { fieldCentric: false, aimAssist: true, autoIntake: false, autoFire: true } },
        DEFAULT_SPEC,
        'chain',
      );
      check(
        'assists: a per-robot assist choice survives coerceSpec exactly',
        custom.assists!.fieldCentric === false &&
          custom.assists!.aimAssist === true &&
          custom.assists!.autoIntake === false &&
          custom.assists!.autoFire === true,
        JSON.stringify(custom.assists),
      );

      // 3. they ride the ROBOT across a game switch — each game keeps its own, and the
      //    flat active `assists` always mirrors the active spec (they can't drift)
      const s0 = coerceSettings({ game: 'chain', spec: custom });
      const s1 = switchGame(s0, 'decode');
      const s2 = switchGame(s1, 'chain');
      check(
        'assists: saved with the robot — per game, and the active mirror never drifts',
        s0.assists.autoIntake === false && // chain robot's own choice
          s1.assists.autoIntake === true && // DECODE gets its own all-ON robot
          s1.assists.fieldCentric === true &&
          s2.assists.autoIntake === false && // restored on return
          s2.assists.fieldCentric === false &&
          JSON.stringify(s0.assists) === JSON.stringify(s0.spec.assists) &&
          JSON.stringify(s1.assists) === JSON.stringify(s1.spec.assists) &&
          JSON.stringify(s2.assists) === JSON.stringify(s2.spec.assists),
        `chain=${JSON.stringify(s0.assists)} decode=${JSON.stringify(s1.assists)}`,
      );

      // 4. MIGRATION: a pre-assists-on-spec save kept the choice in the flat field with no
      //    spec.assists — adopt it onto the robot rather than resetting the player to all-ON
      const legacy = coerceSettings({
        game: 'decode',
        assists: { fieldCentric: false, aimAssist: false, autoIntake: false, autoFire: false },
        spec: { ...DEFAULT_SPEC, assists: undefined },
      });
      check(
        'assists: an old save without spec.assists migrates its flat choice onto the robot',
        legacy.spec.assists!.autoFire === false &&
          legacy.spec.assists!.fieldCentric === false &&
          legacy.assists.autoFire === false,
        JSON.stringify(legacy.spec.assists),
      );

      // 5. a saved-robot slot carries its own assists (that is the point of storing them
      //    on the spec — loading a build restores how it drives)
      const withSaved = coerceSettings({ game: 'chain', savedRobots: [custom] });
      check(
        'assists: a saved robot slot keeps its own assists',
        withSaved.savedRobots[0].assists!.autoIntake === false &&
          withSaved.savedRobots[0].assists!.fieldCentric === false,
        JSON.stringify(withSaved.savedRobots[0].assists),
      );
    }

    // CR AIM ASSIST: with it OFF the fire button no longer steers a turretless launcher
    // (the driver aims by hand); ON, it turns the robot onto the goal. The toggle is gone
    // from the menu and `coerceAssists` forces the flag on, so the OFF case is set on the
    // spawned ROBOT rather than built from a config — the BEHAVIOUR is what is guarded
    // here, kept ready for the option to come back.
    {
      const mkAim = (aimAssist: boolean) => {
        const s = chainSetup(0, 'blue');
        s.spec = { ...DEFAULT_SPEC, scoreMode: 'drum' };
        s.assists = { ...DEFAULT_ASSISTS, autoFire: false };
        const gw = createChainWorld('match', 991, [s]);
        gw.match.phase = 'teleop';
        gw.match.phaseTimeLeft = 120;
        const rob = gw.robots[0];
        rob.aimAssist = aimAssist;
        rob.pos = { x: -30, y: 0 };
        rob.heading = Math.PI / 2; // 90° off the goal (+x): assist must turn it back
        rob.hopper = Array(10).fill('green');
        runChain(gw, cmd({ fire: true }), 0.6);
        return Math.abs(wrapAngle(gw.robots[0].heading - 0)); // heading error to the goal
      };
      const errOn = mkAim(true);
      const errOff = mkAim(false);
      check(
        'chain aim assist: ON steers a turretless launcher onto the goal, OFF leaves the heading alone',
        errOn < 0.1 && errOff > 1.4,
        `errOn=${errOn.toFixed(2)} errOff=${errOff.toFixed(2)}`,
      );
    }
  }

  // CR presets are legal + STABLE through coerceSpec (so a card applies as a no-op and
  // highlights as selected) — every archetype/intake/storage/clearance survives intact
  {
    let ok = true;
    const bad: string[] = [];
    for (const p of CHAIN_PRESETS) {
      const c = coerceSpec({ ...p }, undefined, 'chain');
      if (
        c.massLb !== p.massLb ||
        c.driveRpm !== p.driveRpm ||
        c.width !== p.width ||
        c.length !== p.length ||
        c.scoreMode !== p.scoreMode ||
        c.chainIntake !== p.chainIntake ||
        c.ballStorage !== p.ballStorage ||
        c.groundClearance !== p.groundClearance ||
        // the MOUNTS must survive too — and `ballStorage` surviving is the sharp assertion
        // now that mounts exist: a mount's storage multiplier LOWERS chainStorageMax, so a
        // preset whose hopper exceeds its mount-adjusted cap gets silently clamped and the
        // card stops matching what it just applied.
        intakeMountOf(c) !== intakeMountOf(p) ||
        shooterMountOf(c) !== shooterMountOf(p)
      ) {
        ok = false;
        bad.push(p.name);
      }
    }
    check('chain presets: every CR archetype survives coerceSpec unchanged', ok, bad.join(' '));

    // showcasing the mount space is now these cards' job — keep them from drifting back
    // to all-default mounts the next time someone retunes the presets.
    check(
      'chain presets: between them they showcase the mount options',
      CHAIN_PRESETS.some((p) => intakeMountOf(p) === 'side') &&
        CHAIN_PRESETS.some((p) => intakeMountOf(p) === 'frontback') &&
        CHAIN_PRESETS.some((p) => shooterMountOf(p) === 'back') &&
        CHAIN_PRESETS.some((p) => shooterMountOf(p) === 'left' || shooterMountOf(p) === 'right'),
      CHAIN_PRESETS.map((p) => `${p.name}:${intakeMountOf(p)}/${shooterMountOf(p)}`).join(' '),
    );
  }

  // HOPPER MAX = archetype × size: turret smallest, drum == dumper (large), bigger chassis holds more
  {
    const base = coerceSpec({ ...DEFAULT_SPEC, scoreMode: 'turret' }); // valid dims
    const turretMax = chainStorageMax(base);
    const drumMax = chainStorageMax({ ...base, scoreMode: 'drum' });
    const dumperMax = chainStorageMax({ ...base, scoreMode: 'dumper' });
    const small = chainStorageMax({ ...base, length: 11, width: 11 }); // smaller footprint
    check(
      'chain storage: turret max < drum = dumper, and a bigger chassis holds more',
      turretMax < drumMax && drumMax === dumperMax && small < drumMax,
      `turret=${turretMax} drum=${drumMax} dumper=${dumperMax} small=${small}`,
    );
    // coerceSpec clamps ballStorage down to the archetype+size max
    const over = coerceSpec({ ...base, ballStorage: 99 });
    check('chain storage: coerceSpec clamps ballStorage to the archetype max', over.ballStorage === turretMax, `${over.ballStorage} vs ${turretMax}`);
    // a big open-hopper launcher reaches the ceiling (raised to 90 — a hopper stacks
    // Particles rather than laying out one flat layer)
    const bigDrum = chainStorageMax({ ...base, scoreMode: 'drum', length: 18, width: 18 });
    check(
      'chain storage: a large launcher tops out at the CHAIN_STORAGE_MAX ceiling',
      bigDrum >= CHAIN_STORAGE_MAX - 5 && bigDrum <= CHAIN_STORAGE_MAX,
      `bigDrum=${bigDrum} ceiling=${CHAIN_STORAGE_MAX}`,
    );
    // BOTH games now bound the chassis by the 18" START CUBE minus the intake that lives in
    // it — CR just applies it on the axis the sweeper is MOUNTED on rather than always the
    // front. Neither game lets a chassis be the full 18" while also carrying an intake.
    const crLong = coerceSpec({ ...DEFAULT_SPEC, length: 18 }, undefined, 'chain');
    const decLong = coerceSpec({ ...DEFAULT_SPEC, length: 18 });
    check(
      'chain size: the start cube bounds the chassis in BOTH games (intake counts as structure)',
      crLong.length < 18 && decLong.length < 18,
      `cr=${crLong.length} decode=${decLong.length}`,
    );
  }

  // catalyst multiplier: a catalyst seated on a blue hook ⇒ +1 pt per particle
  {
    const gw = createChainWorld('match', 99, [chainSetup(0, 'blue')]);
    gw.match.phase = 'teleop';
    gw.match.phaseTimeLeft = 120;
    // seat one catalyst on blue hook 0 (multiplier 2), score one particle
    gw.chain!.catalysts[0].hook = { alliance: 'blue', index: 0 };
    const rob = gw.robots[0];
    rob.autoFire = true;
    rob.hopper.push('green'); // one particle to fire (net +1 handled: we only check points)
    const before = gw.chain!.particlePoints.blue;
    runChain(gw, cmd({}), 1);
    check(
      'chain: a seated catalyst doubles a scored particle (2 pts)',
      gw.chain!.particlePoints.blue - before === 2,
      `+${gw.chain!.particlePoints.blue - before}`,
    );
  }

  // endgame: park in a Lab Area (5 pt) / ascend a Ring Stand (100 pt)
  {
    const gw = createChainWorld('match', 7, [chainSetup(0, 'blue')]);
    gw.match.phase = 'teleop';
    gw.match.phaseTimeLeft = 8; // inside the last-20s end game
    const rob = gw.robots[0];
    // park at a real START ANCHOR rather than the lab's geometric centre — the corner
    // assembly is solid and occupies the lab's outer corner, so the centre is inside it now
    rob.pos = { ...CHAIN_START_POSES[0].pos };
    rob.vel = { x: 0, y: 0 };
    runChain(gw, cmd({}), 0.1);
    check('chain endgame: parked in a lab area = 5 pts', gw.chain!.endgame[0] === 'parked' && gw.match.scores.blue.total >= 5);
    const rs = ringStands()[3];
    rob.pos = { x: rs.x, y: rs.y };
    rob.vel = { x: 0, y: 0 };
    runChain(gw, cmd({}), 0.1);
    check('chain endgame: ascended a ring stand = 100 pts', gw.chain!.endgame[0] === 'ascended' && gw.match.scores.blue.total >= 100);
  }

  // AUTO DESCENT: a robot STAGED on a ring stand (start anchor 2) earns 100 pt when it
  // comes down off the stand during auto — awarded ONCE, and the points persist after.
  {
    const gw = createChainWorld('match', 7, [
      { id: 0, alliance: 'blue', spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS }, startIndex: 2 },
    ]);
    check('chain descent: staged on a ring stand arms the descent', gw.chain!.descentArmed[0] === true);
    gw.match.phase = 'auto';
    gw.match.phaseTimeLeft = 30;
    runChain(gw, cmd({}), 0.1); // still on the stand → not yet awarded
    check('chain descent: not awarded while still on the stand', !gw.chain!.descended[0] && gw.match.scores.blue.total < 100);
    gw.robots[0].pos = { x: 0, y: 0 }; // drive it down off the stand to field centre
    runChain(gw, cmd({}), 0.1);
    check('chain descent: coming down off the stand in auto = 100 pts', gw.chain!.descended[0] === true && gw.match.scores.blue.total >= 100);
    // a robot that did NOT start on a stand is never armed (no free descent)
    const gw2 = createChainWorld('match', 7, [chainSetup(0, 'blue')]); // start anchor 0 = lab floor
    check('chain descent: a floor start is NOT armed', !gw2.chain!.descentArmed[0]);
    gw2.match.phase = 'auto';
    gw2.match.phaseTimeLeft = 30;
    gw2.robots[0].pos = { x: 0, y: 0 };
    runChain(gw2, cmd({}), 0.1);
    check('chain descent: floor start earns no descent', !gw2.chain!.descended[0]);
  }

  // particles never overlap (spatial-hash separation)
  {
    const w = createChainWorld('match', 3, [chainSetup(0, 'blue')]);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 120;
    runChain(w, cmd({}), 2); // let the separation pass settle the scatter
    const g = w.balls.filter((b) => b.state.kind === 'ground');
    let minD = Infinity;
    for (let i = 0; i < g.length; i++)
      for (let j = i + 1; j < g.length; j++) {
        const d = Math.hypot(g[i].pos.x - g[j].pos.x, g[i].pos.y - g[j].pos.y);
        if (d < minD) minD = d;
      }
    check('chain: particles never overlap on top of each other', minD >= 2 * CHAIN_PARTICLE_R - 0.25, `minD=${minD.toFixed(2)}`);
  }

  // FOUR hooks per goal ⇒ all four catalysts seated gives ×5 points/particle
  {
    const gw = createChainWorld('match', 42, [chainSetup(0, 'blue')]);
    for (let i = 0; i < 4; i++) gw.chain!.catalysts[i].hook = { alliance: 'blue', index: i };
    check('chain: four catalysts on the four hooks ⇒ ×5', accelMultiplier(gw.chain!, 'blue') === 5);
  }

  // a FAR shot still reaches + scores inside the goal (never lands short)
  {
    const w = createChainWorld('match', 15, [chainSetup(0, 'blue')]);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 120;
    const rob = w.robots[0];
    rob.pos = { x: -60, y: 0 }; // far side of the field from the blue accelerator (x=+72)
    rob.vel = { x: 0, y: 0 };
    rob.turretHeading = Math.atan2(0 - rob.pos.y, 72 - rob.pos.x); // aimed (test teleports it)
    rob.autoFire = true;
    rob.hopper.push('green');
    const before = w.chain!.scored.blue;
    runChain(w, cmd({}), 2);
    check('chain shot: a far shot still reaches + scores in the goal', w.chain!.scored.blue > before);
  }

  // BEAMS — clearance + drivetrain gate crossing; raised CoG is sluggish
  {
    const mk = (dt: 'tank' | 'mecanum' | 'swerve' | 'xdrive', clr: number) => ({
      ...DEFAULT_SPEC,
      drivetrain: dt,
      groundClearance: clr,
    });
    // clearance is the ONLY hard gate — every drivetrain crosses if the frame clears it
    check('chain beams: x-drive WITH clearance can cross', canCrossBeams(mk('xdrive', 1)) === true);
    check('chain beams: tank with clearance crosses', canCrossBeams(mk('tank', 1)) === true);
    check('chain beams: too little clearance is blocked (frame hits)', canCrossBeams(mk('mecanum', 0.5)) === false);
    // MOMENTUM eases crossing only a LITTLE — a running start keeps SOME more speed than a
    // standstill, but no longer lets you power over untouched.
    check(
      'chain beams: momentum eases crossing a little (fast keeps a bit more than standstill)',
      beamDragFactor(mk('xdrive', 1), 50) > beamDragFactor(mk('xdrive', 1), 0) &&
        beamDragFactor(mk('xdrive', 1), 50) - beamDragFactor(mk('xdrive', 1), 0) < 0.18,
    );
    // a BEAM ALWAYS SLOWS YOU — even at very high across-speed the per-tick retain stays
    // below 1 (capped by CHAIN_BEAM_MAX_RETAIN), so you can't power over untouched.
    check(
      'chain beams: per-tick retain is capped below 1 even at high speed',
      beamDragFactor(mk('mecanum', 1), 300) < 0.99 && beamDragFactor(mk('tank', 1), 300) < 0.99,
      `mecanum=${beamDragFactor(mk('mecanum', 1), 300).toFixed(2)} tank=${beamDragFactor(mk('tank', 1), 300).toFixed(2)}`,
    );
    // FULL-SIM crossing: drive a robot at speed across a beam and confirm it loses a real
    // chunk of speed (the user's ask — beams slow you down even when you're moving fast).
    {
      const beamW = createChainWorld('free', 5, [chainSetup(0, 'blue')]);
      const rb = beamW.robots[0];
      rb.pos = { x: 44, y: -60 }; rb.heading = Math.PI / 2; rb.fieldCentric = false;
      let vBefore = 0, vAfter = 0, it = 0;
      while (rb.pos.y < 14 && it < 800) {
        chainStep(beamW, SIM_DT, new Map([[rb.id, cmd({ driveY: 1 })]]));
        it++;
        if (rb.pos.y < -9) vBefore = Math.abs(rb.vel.y); // approaching, before the beam
        if (rb.pos.y > 9 && vAfter === 0) vAfter = Math.abs(rb.vel.y); // just cleared the beam
      }
      check(
        'chain beams: driving across a beam at speed loses a real chunk of speed',
        rb.pos.y >= 14 && vBefore > 40 && vAfter < vBefore * 0.75,
        `before=${vBefore.toFixed(0)} after=${vAfter.toFixed(0)} keep=${(vAfter / (vBefore || 1)).toFixed(2)}`,
      );
    }
    // MECANUM is the BEST beam-crosser (suspension + low CG) — it keeps more than tank at speed
    check(
      'chain beams: mecanum crosses better than swerve (and edges tank)',
      beamDragFactor(mk('mecanum', 1), 50) > beamDragFactor(mk('swerve', 1), 50) &&
        beamDragFactor(mk('mecanum', 1), 50) >= beamDragFactor(mk('tank', 1), 50),
    );
    // PER-WHEEL climbing drag: only wheels actually on the 1" ridge count. STRADDLING a beam
    // (tube under the belly, wheels either side) has NO wheel up ⇒ DRAG-FREE (old OBB model
    // wrongly slowed it). A FORWARD drive with a wheel pair on the ridge IS dragged.
    {
      const w = createChainWorld('free', 7, [chainSetup(0, 'blue')]);
      const r = w.robots[0];
      r.spec = { ...DEFAULT_SPEC, drivetrain: 'mecanum', width: 18, length: 18, groundClearance: 1 };
      const beam = CHAIN_BEAMS[0]; // +x-axis beam (thin in y, at y≈0)
      r.pos = { x: 44, y: 0 }; r.heading = 0; // beam runs under the belly; wheels at y≈±6.4
      check('chain beams: a straddling robot has NO wheel on the ridge', wheelsOnBeam(r, beam.rect) === 0, `up=${wheelsOnBeam(r, beam.rect)}`);
      r.vel = { x: 0, y: 50 };
      beamDrag(w, SIM_DT);
      check('chain beams: straddling a beam is drag-free (no wheel up)', Math.abs(r.vel.y - 50) < 1e-6, `vy=${r.vel.y.toFixed(2)}`);
      // FORWARD across (heading +y ⇒ moving in y is a forward drive, not a strafe): a wheel pair
      // on the ridge IS counted and dragged (the climbing path, not the curb block).
      r.heading = Math.PI / 2; r.pos = { x: 44, y: 6.4 }; // facing +y (across the beam)
      const up = wheelsOnBeam(r, beam.rect);
      r.vel = { x: 0, y: 50 };
      beamDrag(w, SIM_DT);
      check('chain beams: a forward wheel pair on the ridge is counted and dragged', up >= 1 && r.vel.y < 50, `up=${up} vy=${r.vel.y.toFixed(1)}`);
    }
    // TERRAIN RIDE (render/audio read-only): off any beam ⇒ flat (lift 0, onCount 0); a wheel pair
    // ON a beam ⇒ raised (lift > 0, onCount 2). Drives the beam-height bob + crossing SFX.
    {
      const w = createChainWorld('free', 11, [chainSetup(0, 'blue')]);
      const r = w.robots[0];
      r.spec = { ...DEFAULT_SPEC, drivetrain: 'mecanum', width: 18, length: 18, groundClearance: 1 };
      r.pos = { x: 30, y: 40 }; r.heading = 0; // clear of every beam
      const flat = beamRide(r);
      r.pos = { x: 44, y: 6.4 }; // one wheel pair sitting on the +x beam line
      const onBeam = beamRide(r);
      check(
        'chain beams: terrain ride is flat off a beam, raised with wheels on it',
        flat.lift === 0 && flat.onCount === 0 && onBeam.lift > 0 && onBeam.onCount === 2,
        `flat=${flat.lift.toFixed(2)}/${flat.onCount} onBeam=${onBeam.lift.toFixed(2)}/${onBeam.onCount}`,
      );
    }
    // more wheels LIFTED ⇒ less forward traction (a high-centered 4-up robot climbs worse than a
    // single wheel on the ridge). Monotonic in wheelsUp (the 3rd `beamDragFactor` arg).
    check(
      'chain beams: more wheels lifted onto the ridge ⇒ less forward retain',
      beamDragFactor(mk('mecanum', 1), 50, 1) > beamDragFactor(mk('mecanum', 1), 50, 2) &&
        beamDragFactor(mk('mecanum', 1), 50, 2) > beamDragFactor(mk('mecanum', 1), 50, 4),
      `up1=${beamDragFactor(mk('mecanum', 1), 50, 1).toFixed(2)} up2=${beamDragFactor(mk('mecanum', 1), 50, 2).toFixed(2)} up4=${beamDragFactor(mk('mecanum', 1), 50, 4).toFixed(2)}`,
    );
    // MECANUM STRAFE = CURB (beamStrafeBlock), NOT a drag. A mecanum pointing ALONG a beam is
    // strafe-dominant vs it (forwardness ≈ 0 < the block threshold); pointing ACROSS is not.
    check(
      'chain beams: forwardness is ≈0 pointing along a beam, ≈1 pointing across',
      beamForwardness({ heading: 0 } as never, 'y') < 0.5 &&
        beamForwardness({ heading: Math.PI / 2 } as never, 'y') > 0.5,
    );
    // POSITIONAL BLOCK: a mecanum whose LEADING wheel pair has reached the ridge while strafing
    // (its body center is ~6.4" back — wheels are at the chassis corners) is pushed back so the
    // leading wheel rests at the near face (never on top), and its into-the-beam velocity dies.
    {
      const w = createChainWorld('free', 8, [chainSetup(0, 'blue')]);
      const r = w.robots[0];
      r.spec = { ...DEFAULT_SPEC, drivetrain: 'mecanum', width: 18, length: 18, groundClearance: 1 };
      const beam = CHAIN_BEAMS[0]; // +x beam at y≈0; near face from below at y=−0.5
      r.pos = { x: 44, y: -6.0 }; r.heading = 0; // leading (+y) wheel pair at y≈0.4 — on the ridge
      r.vel = { x: 0, y: 40 }; // strafing up INTO the beam
      const upBefore = wheelsOnBeam(r, beam.rect);
      beamStrafeBlock(w);
      const leadY = Math.max(...wheelContacts(r).map((c) => c.y)); // leading wheel after the block
      check(
        'chain beams: a strafing mecanum is curb-blocked (leading wheel back to the near face, vel killed)',
        upBefore >= 1 && leadY <= -0.5 + 1e-6 && r.vel.y === 0 && r.pos.y < -6.0,
        `up=${upBefore} leadY=${leadY.toFixed(2)} vy=${r.vel.y.toFixed(1)} y=${r.pos.y.toFixed(2)}`,
      );
    }
    // the curb block is MECANUM-ONLY and STRAFE-ONLY: from the SAME pose, a swerve (pods steer
    // into travel) and a mecanum DRIVING ACROSS (forwardness high) are NOT pushed back.
    {
      const w = createChainWorld('free', 9, [chainSetup(0, 'blue')]);
      const sv = w.robots[0];
      sv.spec = { ...DEFAULT_SPEC, drivetrain: 'swerve', width: 18, length: 18, groundClearance: 1 };
      sv.pos = { x: 44, y: -6.0 }; sv.heading = 0; sv.vel = { x: 0, y: 40 };
      beamStrafeBlock(w);
      check('chain beams: a swerve is NOT curb-blocked (pods steer into travel)', Math.abs(sv.pos.y - -6.0) < 1e-6 && sv.vel.y === 40, `y=${sv.pos.y.toFixed(2)} vy=${sv.vel.y}`);
      const mc = w.robots[0];
      mc.spec = { ...DEFAULT_SPEC, drivetrain: 'mecanum', width: 18, length: 18, groundClearance: 1 };
      mc.pos = { x: 44, y: -6.0 }; mc.heading = Math.PI / 2; mc.vel = { x: 0, y: 40 }; // facing +y = driving across
      beamStrafeBlock(w);
      check('chain beams: a mecanum driving ACROSS is NOT curb-blocked (it climbs over)', Math.abs(mc.pos.y - -6.0) < 1e-6 && mc.vel.y === 40, `y=${mc.pos.y.toFixed(2)} vy=${mc.vel.y}`);
    }
    // FULL-SIM: a mecanum pointed ALONG a beam and trying to STRAFE across it hits the curb and
    // stops on the near side — it never climbs onto the ridge (y stays below the beam's near face).
    {
      const sw = createChainWorld('free', 6, [chainSetup(0, 'blue')]);
      const rs = sw.robots[0];
      rs.spec = mk('mecanum', 1);
      rs.pos = { x: 44, y: -8 }; rs.heading = 0; rs.fieldCentric = false; // facing +x ALONG the +x-axis beam
      // robot-centric strafe = −driveX, so driveX:−1 strafes toward +y (into the beam)
      for (let i = 0; i < 240; i++) chainStep(sw, SIM_DT, new Map([[rs.id, cmd({ driveX: -1 })]]));
      check(
        'chain beams: a mecanum strafing into a beam stops at the near face (never on top)',
        rs.pos.y < -4,
        `y=${rs.pos.y.toFixed(2)} (started -8; leading wheel hits the curb ~-6.9, never crosses)`,
      );
    }
    // clearance floor 0.3" ⇒ best handling (no CoG penalty); more clearance = more sluggish
    check(
      'chain beams: raised CoG reduces drive authority',
      cogFactor(mk('tank', 1.5)) < cogFactor(mk('tank', 0.3)) && cogFactor(mk('tank', 0.3)) === 1,
    );
    // SWERVE is hit WAY harder by a raised CoG than any other drivetrain (tippy tall modules)
    check(
      'chain beams: high-CoG swerve is far more sluggish than tank/mecanum',
      cogFactor(mk('swerve', 3)) < cogFactor(mk('tank', 3)) - 0.3 &&
        cogFactor(mk('swerve', 3)) < cogFactor(mk('mecanum', 3)) - 0.3,
      `swerve=${cogFactor(mk('swerve', 3)).toFixed(2)} tank=${cogFactor(mk('tank', 3)).toFixed(2)} mecanum=${cogFactor(mk('mecanum', 3)).toFixed(2)}`,
    );
    // integration: a robot that can't clear a beam is pushed off it (hard block)
    const w = createChainWorld('free', 1, [chainSetup(0, 'blue')]);
    const rob = w.robots[0];
    rob.spec = mk('xdrive', 0.5); // clearance < beam height → blocked
    const beam = CHAIN_BEAMS[0];
    rob.pos = { x: (beam.rect.x0 + beam.rect.x1) / 2, y: (beam.rect.y0 + beam.rect.y1) / 2 };
    rob.vel = { x: 0, y: 0 };
    beamBlock(w);
    check('chain beams: a robot that cannot clear a beam is pushed off it', !robotIntersectsRect(rob, beam.rect));
  }

  // ---- CATALYST MECHANISMS: three archetypes, configurable type AND mount ----------
  {
    /** a CR world with one robot carrying the given mechanism, parked facing +x at origin */
    const mk = (catalystType: RobotSpec['catalystType'], catalystMount: RobotSpec['catalystMount'] = 'front') => {
      const setup = chainSetup(0, 'blue');
      setup.spec = { ...DEFAULT_SPEC, catalystType, catalystMount, massLb: 34 };
      const w = createChainWorld('match', 77, [setup]);
      w.match.phase = 'teleop';
      w.match.phaseTimeLeft = 120;
      const rob = w.robots[0];
      rob.pos = { x: 0, y: 0 };
      rob.heading = 0;
      // park every ring far away so a test can place exactly the one it cares about
      for (const c of w.chain!.catalysts) {
        c.carriedBy = null;
        c.hook = null;
        c.pos = { x: 500, y: 500 };
      }
      return { w, rob, ring: w.chain!.catalysts[0] };
    };
    const press = (w: World, rob: { id: number }) =>
      chainStep(w, SIM_DT, new Map([[rob.id, cmd({ catalyst: true })]]));
    const release = (w: World, rob: { id: number }) =>
      chainStep(w, SIM_DT, new Map([[rob.id, cmd({})]]));
    /** can this build grab a ring placed `d` inches straight off its FRONT? */
    const grabsAt = (t: RobotSpec['catalystType'], d: number, mount: RobotSpec['catalystMount'] = 'front') => {
      const { w, rob, ring } = mk(t, mount);
      ring.pos = { x: d, y: 0 };
      press(w, rob);
      return ring.carriedBy === rob.id;
    };

    // REACH: each mechanism grabs just INSIDE its own claw reach and refuses just outside
    // it — derived from the geometry (mouth sits length/2 ahead of centre) rather than
    // hand-picked distances, so retuning a reach doesn't silently invalidate the test.
    const mouthAt = DEFAULT_SPEC.length / 2;
    let reachOk = true;
    const detail: string[] = [];
    for (const t of CHAIN_CATALYST_TYPES) {
      const R = CHAIN_CATALYSTS[t].reach;
      const inside = grabsAt(t, mouthAt + R - 1);
      const outside = grabsAt(t, mouthAt + R + 1);
      if (!inside || outside) reachOk = false;
      detail.push(`${t} in=${inside} out=${outside}`);
    }
    check('catalyst: each claw grabs inside its reach and refuses outside it', reachOk, detail.join(' '));
    // ...and the reaches are ordered arm > turret > launcher (the arm is the reach pick,
    // the launcher's ground-intake claw is the shortest)
    // THE ARM MUST OUT-REACH THE INTAKE. It is the long-reach mechanism; if a robot could
    // grab a ring by simply driving at it with the intake, the arm would be pointless.
    // and NO mechanism may out-reach the legal expansion plus the ring's own radius —
    // a robot that grabs from further than that could not physically exist
    // NO MECHANISM MAY OUT-REACH THE CONTROL PRISM. The bound is per-chassis, not a flat
    // number: G02/G03 give a 24" prism, so what's legally left is 24 − whatever the robot
    // already spends along that axis, plus the ring's own radius (the claw tip sits at the
    // limit and still closes on a ring centred 3" further out). Swept over the whole legal
    // build space rather than spot-checked, because the ARM's reach now VARIES with the
    // build and a bad formula would only break at one end of it.
    {
      let illegal = '';
      let minArm = Infinity;
      let maxArm = 0;
      for (const intake of Object.keys(INTAKE_PRESETS) as RobotSpec['intake'][]) {
        for (const im of CHAIN_INTAKE_MOUNTS) {
          for (const cm of CHAIN_CATALYST_MOUNTS) {
            const base = coerceSpec(
              { ...DEFAULT_SPEC, intake, intakeMount: im, catalystMount: cm, catalystType: 'arm' },
              DEFAULT_SPEC,
              'chain',
            );
            const lim = chainSizeLimits(base);
            for (const length of [lim.minLength, lim.maxLength]) {
              for (const width of [lim.minWidth, lim.maxWidth]) {
                const s = coerceSpec({ ...base, length, width }, DEFAULT_SPEC, 'chain');
                const reach = chainArmReach(s);
                const axis = cm === 'front' || cm === 'back' ? s.length : s.width;
                const ends =
                  cm === 'front' || cm === 'back'
                    ? intakeMountOf(s) === 'frontback'
                      ? 2
                      : intakeMountOf(s) === 'side'
                        ? 0
                        : 1
                    : intakeMountOf(s) === 'side'
                      ? 2
                      : 0;
                const spent = axis + ends * INTAKE_PRESETS[s.intake].reach;
                const cap = CHAIN_PRISM - spent + CHAIN_CATALYST_OD / 2;
                if (reach > cap + 1e-9) illegal = `${intake}/${im}/${cm} reach ${reach} > ${cap}`;
                minArm = Math.min(minArm, reach);
                maxArm = Math.max(maxArm, reach);
              }
            }
          }
        }
      }
      check(
        'catalyst: no arm reach exceeds what the control prism leaves for that chassis',
        !illegal,
        illegal || `arm reach spans ${minArm.toFixed(1)}"-${maxArm.toFixed(1)}" across the legal build space`,
      );
      // a MAXED-OUT chassis gets exactly the old flat allowance; a compact one gets much more.
      // That spread is the point — the arm is the mechanism you build small to exploit.
      check(
        'catalyst: a compact chassis genuinely out-reaches a maxed one',
        maxArm >= minArm + 6,
        `${minArm.toFixed(1)}" (maxed) -> ${maxArm.toFixed(1)}" (compact)`,
      );
      check(
        'catalyst: even the WORST-case arm equals the maxed-robot expansion + ring radius',
        Math.abs(minArm - (CHAIN_EXPANSION + CHAIN_CATALYST_OD / 2)) < 1e-9,
        `${minArm} vs ${CHAIN_EXPANSION + CHAIN_CATALYST_OD / 2}`,
      );
    }
    // THE ARM MUST OUT-REACH THE INTAKE, at ANY legal size. It is the long-reach mechanism;
    // if a robot could grab a ring by simply driving at it with the intake, the arm would be
    // pointless. Checked against the worst-case arm, not the default one.
    check(
      'catalyst: the claw arm reaches further than ANY intake preset',
      CHAIN_EXPANSION + CHAIN_CATALYST_OD / 2 >
        Math.max(...Object.values(INTAKE_PRESETS).map((p) => p.reach)) + 3,
      `worst-case arm ${CHAIN_EXPANSION + CHAIN_CATALYST_OD / 2}" vs intakes ${Object.values(INTAKE_PRESETS).map((p) => p.reach).join('/')}"`,
    );
    check(
      'catalyst: reach order arm > turret > launcher',
      CHAIN_CATALYSTS.arm.reach > CHAIN_CATALYSTS.turret.reach &&
        CHAIN_CATALYSTS.turret.reach > CHAIN_CATALYSTS.launcher.reach,
      `${CHAIN_CATALYSTS.arm.reach} / ${CHAIN_CATALYSTS.turret.reach} / ${CHAIN_CATALYSTS.launcher.reach}`,
    );

    // THE CATAPULT: with no hook in claw reach, a launcher THROWS the ring downfield
    // instead of dropping it. It is transport, not placement — and deliberately imprecise.
    const fling = (t: RobotSpec['catalystType'], seed: number) => {
      const setup = chainSetup(0, 'blue');
      setup.spec = { ...DEFAULT_SPEC, catalystType: t, catalystMount: 'front', massLb: 34 };
      const w = createChainWorld('match', seed, [setup]);
      w.match.phase = 'teleop';
      w.match.phaseTimeLeft = 120;
      const rob = w.robots[0];
      rob.pos = { x: -40, y: 0 };
      rob.heading = 0; // catapult points at +x, far from any hook
      for (const c of w.chain!.catalysts) {
        c.carriedBy = null;
        c.hook = null;
        c.pos = { x: 500, y: 500 };
        c.vel = { x: 0, y: 0 };
        c.z = 0;
        c.vz = 0;
      }
      const ring = w.chain!.catalysts[0];
      ring.carriedBy = rob.id;
      chainStep(w, SIM_DT, new Map([[rob.id, cmd({ fling: true })]])); // the CATAPULT button
      const airborne = ring.z > 0; // it LEFT the ground — a real throw, not a teleport
      let ticks = 0;
      while ((ring.z > 0 || hyp(ring.vel.x, ring.vel.y) > 0.01) && ticks < 600) {
        chainStep(w, SIM_DT, new Map([[rob.id, cmd({})]]));
        ticks++;
      }
      return {
        airborne,
        ticks,
        carried: ring.carriedBy === rob.id,
        dist: hyp(ring.pos.x - rob.pos.x, ring.pos.y - rob.pos.y),
        pos: { ...ring.pos },
      };
    };
    const f1 = fling('launcher', 101);
    check(
      'catalyst: the catapult throws a carried ring FAR downfield (a real arc, not a teleport)',
      f1.airborne && f1.ticks > 20 && f1.dist > 45,
      `airborne=${f1.airborne} flightTicks=${f1.ticks} landed ${f1.dist.toFixed(0)}" away`,
    );
    // a plain CLAW has no catapult at all: the throw button does nothing, so it keeps the ring
    // (dist stays ~7" for these because a CARRIED ring rides at the claw mouth — the point
    // is that it is still carried, not that it is at the chassis centre)
    check(
      'catalyst: the throw button does nothing without a catapult (arm / rail turret keep the ring)',
      fling('arm', 101).carried && !fling('arm', 101).airborne && fling('turret', 101).carried,
      `arm carried=${fling('arm', 101).carried} turret carried=${fling('turret', 101).carried}`,
    );
    // ACCURACY DOES NOT MATTER: the same throw from the same pose lands somewhere different
    // every time (speed variance + a lateral kick), so it can never be used as a placer
    {
      const spots = [201, 202, 203, 204, 205].map((sd) => fling('launcher', sd).pos);
      const spread = Math.max(...spots.map((a) => Math.max(...spots.map((b) => hyp(a.x - b.x, a.y - b.y)))));
      check(
        'catalyst: the catapult is INACCURATE — repeated throws scatter their landing spot',
        spread > 12,
        `landing spread ${spread.toFixed(0)}" across 5 throws`,
      );
    }
    // RANGE is a BUILD OPTION: a longer-range catapult really does throw further, and the
    // slider is a DISTANCE (catapultSpeedFor solves for the speed), not a raw velocity.
    const rangeOf = (range: number, seed = 555) => {
      const setup = chainSetup(0, 'blue');
      setup.spec = { ...DEFAULT_SPEC, catalystType: 'launcher', catapultRange: range, catapultYaw: 0, massLb: 36 };
      const w = createChainWorld('match', seed, [setup]);
      w.match.phase = 'teleop';
      w.match.phaseTimeLeft = 120;
      const rob = w.robots[0];
      rob.pos = { x: -60, y: 0 };
      rob.heading = 0;
      for (const c of w.chain!.catalysts) {
        c.carriedBy = null; c.hook = null; c.pos = { x: 500, y: 500 };
        c.vel = { x: 0, y: 0 }; c.z = 0; c.vz = 0; c.flungBy = null; c.outOfPlay = false;
      }
      const ring = w.chain!.catalysts[0];
      ring.carriedBy = rob.id;
      chainStep(w, SIM_DT, new Map([[rob.id, cmd({ fling: true })]]));
      let n = 0;
      while ((ring.z > 0 || hyp(ring.vel.x, ring.vel.y) > 0.01) && n < 900) {
        chainStep(w, SIM_DT, new Map([[rob.id, cmd({})]]));
        n++;
      }
      return hyp(ring.pos.x - rob.pos.x, ring.pos.y - rob.pos.y);
    };
    // AVERAGE several throws — a single sample carries the deliberate ±40% speed roll, which
    // is exactly the thing that must not be read as a calibration error
    const meanRange = (range: number) => {
      const seeds = [555, 556, 557, 558, 559, 560, 561, 562, 563];
      return seeds.reduce((a, sd) => a + rangeOf(range, sd), 0) / seeds.length;
    };
    const shortR = meanRange(CHAIN_CATAPULT_RANGE_MIN);
    const longR = meanRange(CHAIN_CATAPULT_RANGE_MAX);
    // calibration is checked at ranges the FIELD can actually contain — a max-range throw
    // is stopped by the perimeter net long before it would land, so it under-reads by design
    const midRange = 110;
    const midR = meanRange(midRange);
    check(
      'catapult: the RANGE slider really changes how far it throws',
      longR > shortR * 1.6,
      `${CHAIN_CATAPULT_RANGE_MIN}" build → ${shortR.toFixed(0)}"  ·  ${CHAIN_CATAPULT_RANGE_MAX}" build → ${longR.toFixed(0)}"`,
    );
    // the slider is calibrated: `catapultSpeedFor` inverts the throw, so the nominal build
    // range should land near the actual distance (before the deliberate ±scatter)
    // distances are measured from the robot CENTRE, so subtract the claw mouth the ring
    // leaves from; what remains should sit near the nominal build range
    const mouthOff = DEFAULT_SPEC.length / 2;
    check(
      'catapult: the range slider is a real distance, not a raw speed',
      Math.abs(shortR - mouthOff - CHAIN_CATAPULT_RANGE_MIN) < CHAIN_CATAPULT_RANGE_MIN * 0.3 &&
        Math.abs(midR - mouthOff - midRange) < midRange * 0.3,
      `${CHAIN_CATAPULT_RANGE_MIN}"→${(shortR - mouthOff).toFixed(0)}"  ${midRange}"→${(midR - mouthOff).toFixed(0)}" (mean of 9)`,
    );
    // a maxed catapult genuinely crosses most of the field — that is the point of it
    check(
      'catapult: a max-range build throws most of the way across the field',
      longR > 100,
      `${(longR).toFixed(0)}" on a ${CHAIN_HALF_X * 2}" field`,
    );
    // buying range COSTS: heavier, and slower to re-cock
    check(
      'catapult: a longer-range build is heavier and re-cocks slower',
      catapultMassFor(CHAIN_CATAPULT_RANGE_MAX) > catapultMassFor(CHAIN_CATAPULT_RANGE_MIN) &&
        catapultCycleFor(CHAIN_CATAPULT_RANGE_MAX) > catapultCycleFor(CHAIN_CATAPULT_RANGE_MIN) &&
        catapultMassFor(CHAIN_CATAPULT_RANGE_MAX) <= 1.25,
      `+${catapultMassFor(CHAIN_CATAPULT_RANGE_MAX).toFixed(2)} lb, ${catapultCycleFor(CHAIN_CATAPULT_RANGE_MIN).toFixed(2)}→${catapultCycleFor(CHAIN_CATAPULT_RANGE_MAX).toFixed(2)} s`,
    );

    // YAW is a BUILD OPTION and the catapult is NOT turreted: it throws along chassis
    // heading + the built yaw, so a 90° mount throws off the side of the robot.
    {
      const throwDir = (yawDeg: number) => {
        const setup = chainSetup(0, 'blue');
        setup.spec = { ...DEFAULT_SPEC, catalystType: 'launcher', catapultRange: 70, catapultYaw: yawDeg, massLb: 36 };
        const w = createChainWorld('match', 556, [setup]);
        w.match.phase = 'teleop';
        w.match.phaseTimeLeft = 120;
        const rob = w.robots[0];
        rob.pos = { x: 0, y: 0 };
        rob.heading = 0;
        for (const c of w.chain!.catalysts) {
          c.carriedBy = null; c.hook = null; c.pos = { x: 500, y: 500 };
          c.vel = { x: 0, y: 0 }; c.z = 0; c.vz = 0; c.flungBy = null; c.outOfPlay = false;
        }
        const ring = w.chain!.catalysts[0];
        ring.carriedBy = rob.id;
        chainStep(w, SIM_DT, new Map([[rob.id, cmd({ fling: true })]]));
        return datan2(ring.vel.y, ring.vel.x); // the launch direction
      };
      const fwd = throwDir(0);
      const left = throwDir(90);
      const back = throwDir(180);
      const near = (a: number, b: number) => Math.abs(wrapAngle(a - b)) < 0.35; // scatter kick
      check(
        'catapult: the YAW slider aims it (fixed mount — 0° forward, 90° left, 180° back)',
        near(fwd, 0) && near(left, Math.PI / 2) && near(back, Math.PI),
        `0°→${fwd.toFixed(2)} 90°→${left.toFixed(2)} 180°→${back.toFixed(2)} rad`,
      );
      // and it is NOT turreted: turning the chassis turns the throw with it
      const setup = chainSetup(0, 'blue');
      setup.spec = { ...DEFAULT_SPEC, catalystType: 'launcher', catapultRange: 70, catapultYaw: 0, massLb: 36 };
      const w = createChainWorld('match', 557, [setup]);
      w.match.phase = 'teleop';
      w.match.phaseTimeLeft = 120;
      const rob = w.robots[0];
      rob.pos = { x: 0, y: 0 };
      rob.heading = Math.PI / 2; // chassis turned 90°
      for (const c of w.chain!.catalysts) {
        c.carriedBy = null; c.hook = null; c.pos = { x: 500, y: 500 };
        c.vel = { x: 0, y: 0 }; c.z = 0; c.vz = 0; c.flungBy = null; c.outOfPlay = false;
      }
      const ring = w.chain!.catalysts[0];
      ring.carriedBy = rob.id;
      chainStep(w, SIM_DT, new Map([[rob.id, cmd({ fling: true })]]));
      check(
        'catapult: it is NOT turreted — the throw follows the chassis heading',
        Math.abs(wrapAngle(datan2(ring.vel.y, ring.vel.x) - Math.PI / 2)) < 0.35,
      );
    }

    // A throw that stays BELOW the wall top bounces back in and is contained.
    check(
      'catalyst: a contained throw stays inside the field walls',
      [301, 302, 303].every((sd) => {
        const p = fling('launcher', sd).pos;
        return Math.abs(p.x) <= CHAIN_HALF_X && Math.abs(p.y) <= CHAIN_HALF_Y;
      }),
    );

    // NETTING: the field is walled low and NETTED above, so nothing ever leaves play. Throw
    // a long-range catapult straight at a wall from close range — on a high arc, at a flat
    // one, and hard into a corner — and the ring must always end up back inside.
    {
      const atWall = (yawDeg: number, standoff: number, seed: number) => {
        const setup = chainSetup(0, 'blue');
        setup.spec = { ...DEFAULT_SPEC, catalystType: 'launcher', catapultRange: 120, catapultYaw: yawDeg, massLb: 36 };
        const w = createChainWorld('match', seed, [setup]);
        w.match.phase = 'teleop';
        w.match.phaseTimeLeft = 120;
        const rob = w.robots[0];
        rob.pos = { x: CHAIN_HALF_X - standoff, y: CHAIN_HALF_Y - standoff };
        rob.heading = 0;
        for (const c of w.chain!.catalysts) {
          c.carriedBy = null; c.hook = null; c.pos = { x: 0, y: 0 };
          c.vel = { x: 0, y: 0 }; c.z = 0; c.vz = 0;
        }
        const ring = w.chain!.catalysts[0];
        ring.carriedBy = rob.id;
        chainStep(w, SIM_DT, new Map([[rob.id, cmd({ fling: true })]]));
        let n = 0;
        while ((ring.z > 0 || hyp(ring.vel.x, ring.vel.y) > 0.01) && n < 900) {
          chainStep(w, SIM_DT, new Map([[rob.id, cmd({})]]));
          n++;
        }
        return ring.pos;
      };
      const cases: [number, number, number][] = [
        [0, 10, 701], [0, 30, 702], [45, 8, 703], [90, 12, 704], [30, 20, 705],
      ];
      const inside = cases.map(([y, d, sd]) => atWall(y, d, sd))
        .every((p) => Math.abs(p.x) <= CHAIN_HALF_X && Math.abs(p.y) <= CHAIN_HALF_Y);
      check('catalyst: the netting keeps every throw in play — nothing can leave the field', inside);

      // the NET is slacker than the wall: a ring that hits it high rebounds LESS than one
      // that hits the rigid wall low, so a wild high throw dies against the perimeter
      check(
        'catalyst: netting rebounds less than the rigid wall (slack absorbs the energy)',
        CHAIN_NET_RESTITUTION < CHAIN_WALL_RESTITUTION && CHAIN_NET_VZ_KEEP < 1,
        `net ${CHAIN_NET_RESTITUTION} vs wall ${CHAIN_WALL_RESTITUTION}`,
      );
      // and a ring is never removed from play — all four are always grabbable somewhere
      const setup = chainSetup(0, 'blue');
      setup.spec = { ...DEFAULT_SPEC, catalystType: 'launcher', catapultRange: 120, massLb: 36 };
      const w = createChainWorld('match', 706, [setup]);
      check(
        'catalyst: all four rings stay in play (no out-of-bounds removal)',
        w.chain!.catalysts.length === 4,
        `${w.chain!.catalysts.length} rings`,
      );
    }

    // A ring that ends up ON a robot slides off instead of perching on the chassis.
    {
      const setup = chainSetup(0, 'blue');
      setup.spec = { ...DEFAULT_SPEC, catalystType: 'arm', massLb: 34 };
      const w = createChainWorld('match', 910, [setup]);
      w.match.phase = 'teleop';
      w.match.phaseTimeLeft = 120;
      const rob = w.robots[0];
      rob.pos = { x: 0, y: 0 };
      rob.heading = 0;
      for (const c of w.chain!.catalysts) {
        c.carriedBy = null;
        c.hook = null;
        c.pos = { x: 500, y: 500 };
        c.vel = { x: 0, y: 0 };
        c.z = 0;
        c.vz = 0;
      }
      const ring = w.chain!.catalysts[0];
      ring.pos = { x: 0, y: 0 }; // dead centre of the chassis
      let moved = false;
      for (let i = 0; i < 90; i++) {
        chainStep(w, SIM_DT, new Map([[rob.id, cmd({})]]));
        if (hyp(ring.vel.x, ring.vel.y) > 0.01) moved = true;
      }
      const e = robotExtents(rob);
      const rel = rot({ x: ring.pos.x - rob.pos.x, y: ring.pos.y - rob.pos.y }, -rob.heading);
      const clear = Math.abs(rel.x) > e.front || Math.abs(rel.y) > e.half;
      const e0 = robotExtents(rob);
      const outBy = Math.max(Math.abs(rel.x) - e0.front, Math.abs(rel.y) - e0.half);
      check(
        'catalyst: a ring under a robot SLIDES off the chassis instead of riding on it',
        moved && clear && hyp(ring.vel.x, ring.vel.y) < 0.02,
        `slid=${moved} clear=${clear} restPos=(${ring.pos.x.toFixed(1)},${ring.pos.y.toFixed(1)})`,
      );
      // ...and it is a NUDGE, not a launch: it settles just clear of the frame, not metres away
      check(
        'catalyst: the eviction is a gentle nudge, not a bounce across the field',
        outBy < 10,
        `settled ${outBy.toFixed(1)}" past the frame`,
      );
    }

    // FACING: arm/launcher work through a CONE, the rail turret is omnidirectional. Same
    // ring, same distance, placed off the robot's SIDE instead of its front.
    const grabsBeside = (t: RobotSpec['catalystType']) => {
      const { w, rob, ring } = mk(t);
      // beside the MOUTH (which sits at the front edge), inside the turret's reach but 90°
      // off the front normal — so distance passes and only the CONE decides
      ring.pos = { x: DEFAULT_SPEC.length / 2, y: 6 };
      press(w, rob);
      return ring.carriedBy === rob.id;
    };
    check(
      'catalyst: the rail turret reaches sideways; the arm and catapult must face it',
      grabsBeside('turret') && !grabsBeside('arm') && !grabsBeside('launcher'),
      `turret ${grabsBeside('turret')} arm ${grabsBeside('arm')} launcher ${grabsBeside('launcher')}`,
    );

    // MOUNT: bolting the SAME mechanism to the back flips which side it can work from.
    check(
      'catalyst: the MOUNT moves the reach — a back-mounted arm grabs behind, not ahead',
      (() => {
        const behind = mk('arm', 'back');
        behind.ring.pos = { x: -12, y: 0 };
        press(behind.w, behind.rob);
        const gotBehind = behind.ring.carriedBy === behind.rob.id;
        const ahead = mk('arm', 'back');
        ahead.ring.pos = { x: 12, y: 0 };
        press(ahead.w, ahead.rob);
        return gotBehind && ahead.ring.carriedBy === null;
      })(),
    );

    // CYCLE TIME: the reach/range specialists pay for it in rate. Count how many actions
    // land in a fixed window of alternating press/release.
    const actionsIn = (t: RobotSpec['catalystType'], seconds: number) => {
      const { w, rob, ring } = mk(t);
      ring.pos = { x: 11, y: 0 }; // just past the front mouth — in reach of all three
      let n = 0;
      const ticks = Math.round(seconds / SIM_DT);
      for (let i = 0; i < ticks; i++) {
        const carriedBefore = ring.carriedBy;
        if (i % 2 === 0) press(w, rob);
        else release(w, rob);
        if (ring.carriedBy !== carriedBefore) n++;
        // keep it grabbable: drop it back at the robot so the next press can re-grab
        if (ring.carriedBy === null) ring.pos = { x: rob.pos.x + 11, y: rob.pos.y };
      }
      return n;
    };
    const nTurret = actionsIn('turret', 4);
    const nArm = actionsIn('arm', 4);
    const nLauncher = actionsIn('launcher', 4);
    check(
      'catalyst: cycle rate turret > arm > catapult (reach and range cost tempo)',
      nTurret > nArm && nArm > nLauncher,
      `turret ${nTurret} arm ${nArm} launcher ${nLauncher} actions / 4s`,
    );

    // WEIGHT: ordered arm < launcher < turret, and ALL modest in absolute terms — these
    // are claws and linkages, not drivetrains (the user's explicit guidance).
    check(
      'catalyst: weight order arm < catapult < turret, and every delta stays small',
      CHAIN_CATALYSTS.arm.massLb < CHAIN_CATALYSTS.launcher.massLb &&
        CHAIN_CATALYSTS.launcher.massLb < CHAIN_CATALYSTS.turret.massLb &&
        CHAIN_CATALYSTS.turret.massLb <= 3,
      `${CHAIN_CATALYSTS.arm.massLb} / ${CHAIN_CATALYSTS.launcher.massLb} / ${CHAIN_CATALYSTS.turret.massLb} lb`,
    );
    // and it reaches the actual mass floor, differentially (arm is the baseline)
    // Compared at the catapult's MINIMUM range, so this measures the MECHANISMS themselves;
    // the catapult's range build then stacks on top (checked separately below).
    const floorFor = (t: RobotSpec['catalystType']) =>
      coerceSpec(
        { ...DEFAULT_SPEC, catalystType: t, catapultRange: CHAIN_CATAPULT_RANGE_MIN, massLb: 1 },
        undefined,
        'chain',
      ).massLb;
    check(
      'catalyst: the heavier mechanisms really raise the chassis mass floor',
      floorFor('turret') > floorFor('launcher') && floorFor('launcher') > floorFor('arm'),
      `arm ${floorFor('arm')} launcher ${floorFor('launcher')} turret ${floorFor('turret')} lb`,
    );
    // a long-range catapult build is a big machine — heavy enough to pass the rail turret,
    // which is the right relationship (you are buying a bigger throwing mechanism)
    const heavyCata = coerceSpec(
      { ...DEFAULT_SPEC, catalystType: 'launcher', catapultRange: CHAIN_CATAPULT_RANGE_MAX, massLb: 1 },
      undefined,
      'chain',
    ).massLb;
    check(
      'catalyst: a max-range catapult outweighs even the rail turret',
      heavyCata > floorFor('turret'),
      `max-range launcher ${heavyCata} lb vs turret ${floorFor('turret')} lb`,
    );

    // the HUD prompt must agree with the action — a prompt that offers something the
    // button then refuses is worse than no prompt
    check(
      'catalyst: the HUD prompt uses the same reach as the action (no phantom offers)',
      (() => {
        for (const t of CHAIN_CATALYST_TYPES) {
          for (const d of [5, 9, 13, 17, 24]) {
            const { w, rob, ring } = mk(t);
            ring.pos = { x: d, y: 0 };
            const offered = chainCatalystPrompt(w.chain!, rob)?.action === 'pickup';
            press(w, rob);
            if (offered !== (ring.carriedBy === rob.id)) return false;
          }
        }
        return true;
      })(),
    );

    // coerceSpec owns both fields (enum-checked, defaulted)
    const junk = coerceSpec({ ...DEFAULT_SPEC, catalystType: 'grabber', catalystMount: 'up' }, undefined, 'chain');
    check(
      'catalyst: a bogus type/mount coerces to the default',
      junk.catalystType === CHAIN_DEFAULT_CATALYST && junk.catalystMount === 'front',
      `${junk.catalystType}/${junk.catalystMount}`,
    );

    // ---- CORNER mounts: the claw reaches along its own DIAGONAL, not down a side ----
    // A back-right claw must work behind-and-right and refuse ahead-and-left. Both probes
    // sit the SAME distance from the robot centre, so this can only pass on direction.
    {
      const dx = DEFAULT_SPEC.length / 2 + 2;
      const dy = DEFAULT_SPEC.width / 2 + 2;
      const cornerGrab = (x: number, y: number) => {
        const { w, rob, ring } = mk('arm', 'backright');
        ring.pos = { x, y };
        press(w, rob);
        return ring.carriedBy === rob.id;
      };
      const behindRight = cornerGrab(-dx, -dy);
      const aheadLeft = cornerGrab(dx, dy);
      check(
        'catalyst: a CORNER mount reaches off its own diagonal and not the opposite one',
        behindRight && !aheadLeft,
        `back-right=${behindRight} front-left=${aheadLeft}`,
      );
    }

    // ---- FRONTBACK swing: one arm on a pivot, so BOTH ends work ---------------------
    // The whole point of the swing is a second cone. A plain FRONT mount is the control:
    // same robot, same ring positions, and it must refuse the one behind it.
    {
      const behind = { x: -DEFAULT_SPEC.length / 2 - 3, y: 0 };
      const ahead = { x: DEFAULT_SPEC.length / 2 + 3, y: 0 };
      const grab = (mount: RobotSpec['catalystMount'], at: { x: number; y: number }) => {
        const { w, rob, ring } = mk('arm', mount);
        ring.pos = { ...at };
        press(w, rob);
        return ring.carriedBy === rob.id;
      };
      const swingAhead = grab('frontback', ahead);
      const swingBehind = grab('frontback', behind);
      const frontAhead = grab('front', ahead);
      const frontBehind = grab('front', behind);
      check(
        'catalyst: the FRONTBACK swing works BOTH ends where a fixed front mount works one',
        swingAhead && swingBehind && frontAhead && !frontBehind,
        `swing f=${swingAhead} b=${swingBehind} | fixed-front f=${frontAhead} b=${frontBehind}`,
      );
    }
  }

  // ---- RAIL-TURRET CLAW tracks the NEAREST target, ring or hook ---------------------
  // It used to track hooks only, so a claw would stare across the field at a hook while a
  // ring sat at its feet. A loose ring is now a candidate and wins when it is closer.
  {
    const w = createChainWorld('match', 9, [chainSetup(0, 'blue')]);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 120;
    const rob = w.robots[0];
    rob.pos = { x: 0, y: 0 };
    rob.heading = 0;
    for (const c of w.chain!.catalysts) {
      c.carriedBy = null;
      c.hook = null;
      c.pos = { x: 500, y: 500 }; // park them all far away
    }
    const near = (t: { x: number; y: number } | null, p: { x: number; y: number }) =>
      !!t && Math.abs(t.x - p.x) < 0.01 && Math.abs(t.y - p.y) < 0.01;

    // no loose ring in play -> a hook, exactly as before
    const hookOnly = catalystTrackTarget(rob, w);
    const isHook = (['red', 'blue'] as const).some((a) =>
      Array.from({ length: CHAIN_HOOKS_PER_GOAL }, (_, i) => hookPos(a, i)).some((h) => near(hookOnly, h)),
    );
    check('catalyst track: with no loose ring nearby it still tracks a hook', isHook,
      `${hookOnly?.x.toFixed(1)},${hookOnly?.y.toFixed(1)}`);

    // a ring at its feet beats every hook
    const ring = w.chain!.catalysts[0];
    ring.pos = { x: 12, y: 3 };
    check(
      'catalyst track: a LOOSE ring closer than any hook wins',
      near(catalystTrackTarget(rob, w), ring.pos),
      JSON.stringify(catalystTrackTarget(rob, w)),
    );

    // ...but a CARRIED ring is not a target: it is already in the claw (distance ~0), so
    // tracking it would lock the arm pointing at itself
    ring.carriedBy = rob.id;
    check(
      'catalyst track: a CARRIED ring is never the target',
      !near(catalystTrackTarget(rob, w), ring.pos),
      JSON.stringify(catalystTrackTarget(rob, w)),
    );
    // ...and neither is one already seated on a hook
    ring.carriedBy = null;
    ring.hook = { alliance: 'blue', index: 0 };
    const seated = catalystTrackTarget(rob, w);
    check(
      'catalyst track: a ring already SEATED on a hook is not a loose target',
      !near(seated, { x: 12, y: 3 }),
      JSON.stringify(seated),
    );
  }

  // ---- TURRET POSITION: shooterMount is where it is BOLTED, so it moves the shot -----
  // A turret aims itself, so its mount is not a facing — it is the point the Particle is
  // born at. Fire the same robot from the same pose with the turret at three positions and
  // the birth point must follow the mount.
  {
    const born = (pos: RobotSpec['shooterMount']) => {
      const setup = chainSetup(0, 'blue');
      setup.spec = { ...DEFAULT_SPEC, scoreMode: 'turret', shooterMount: pos, massLb: 34 };
      const w = createChainWorld('match', 3, [setup]);
      w.match.phase = 'teleop';
      w.match.phaseTimeLeft = 120;
      const rob = w.robots[0];
      rob.pos = { x: 0, y: 0 };
      rob.heading = 0; // +x forward, so a BACK mount sits at negative local x
      rob.hopper = ['green'];
      rob.fireReadyAt = 0;
      const before = new Set(w.balls.map((b) => b.id));
      chainStep(w, SIM_DT, new Map([[rob.id, cmd({ fire: true })]]));
      const shot = w.balls.find((b) => !before.has(b.id));
      return shot ? { x: shot.pos.x, y: shot.pos.y } : null;
    };
    const mid = born('center');
    const back = born('back');
    const bl = born('backleft');
    // The birth point must move by EXACTLY the mount's own offset, so this asserts against
    // `turretLocal` — the shared helper the sprite also draws at — rather than a hand-picked
    // fraction. The residual tolerance is the barrel-tip term, which points at the goal and so
    // differs slightly between origins.
    const at = (pos: RobotSpec['shooterMount']) => turretLocal({ ...DEFAULT_SPEC, shooterMount: pos });
    const near = (a: number, b: number) => Math.abs(a - b) < 2;
    const dBack = at('back');
    const dBL = at('backleft');
    check(
      'chain turret: a BACK mount launches from behind the chassis centre, by its mount offset',
      !!mid && !!back && near(back.x - mid.x, dBack.x) && back.x < mid.x - 2,
      `delta ${(back!.x - mid!.x).toFixed(2)} vs turretLocal ${dBack.x.toFixed(2)}`,
    );
    check(
      'chain turret: a CORNER mount launches from that corner (offset on BOTH axes)',
      !!mid && !!bl && near(bl.x - mid.x, dBL.x) && near(bl.y - mid.y, dBL.y) && bl.y > mid.y + 2,
      `delta ${(bl!.x - mid!.x).toFixed(2)},${(bl!.y - mid!.y).toFixed(2)} vs turretLocal ${dBL.x.toFixed(2)},${dBL.y.toFixed(2)}`,
    );

    // A TURRETLESS launcher fires along a LINE spanning a side, so a corner/centre is not a
    // build it can have — coerceSpec folds it to the nearest edge at the one chokepoint.
    const fold = (pos: string, mode: RobotSpec['scoreMode']) =>
      coerceSpec({ ...DEFAULT_SPEC, scoreMode: mode, shooterMount: pos }, undefined, 'chain').shooterMount;
    check(
      'chain shooter: a turretless launcher folds a corner/centre mount to an edge',
      fold('backleft', 'drum') === 'back' &&
        fold('frontright', 'dumper') === 'front' &&
        fold('center', 'drum') === 'front',
      `drum backleft=${fold('backleft', 'drum')} dumper frontright=${fold('frontright', 'dumper')} drum center=${fold('center', 'drum')}`,
    );
    // NOTHING MAY HANG OFF THE CHASSIS. A mounted turret's ring has to sit fully on the frame
    // — swept over every position AND both size bounds, because the failure was position- and
    // size-dependent: pulling inboard by r along a CORNER's diagonal clears each rail by only
    // r/sqrt2, so the ring overhung both by ~0.29r (caught on a real preset, KITSUNE).
    {
      let worst = 0;
      let worstAt = '';
      for (const pos of CHAIN_TURRET_POSITIONS) {
        for (const [length, width] of [[CHAIN_MIN_LENGTH, 10], [CHAIN_MAX_LENGTH, 18], [12, 17], [15, 11]]) {
          const spec = { ...DEFAULT_SPEC, length, width, shooterMount: pos } as RobotSpec;
          const t = turretLocal(spec);
          const r = turretRadius(spec);
          const over = Math.max(
            Math.abs(t.x) + r - length / 2,
            Math.abs(t.y) + r - width / 2,
          );
          if (over > worst) { worst = over; worstAt = `${pos} @${length}x${width}`; }
        }
      }
      check(
        'chain turret: the ring sits fully ON the chassis at every position and size',
        worst <= 0.01,
        worst > 0.01 ? `overhangs ${worst.toFixed(2)}" at ${worstAt}` : 'no overhang',
      );
    }
    check(
      'chain shooter: a TURRET keeps any of the nine positions',
      fold('backleft', 'turret') === 'backleft' &&
        fold('center', 'twinturret') === 'center' &&
        fold('frontright', 'turret') === 'frontright',
      `${fold('backleft', 'turret')} / ${fold('center', 'twinturret')} / ${fold('frontright', 'turret')}`,
    );
  }

  // catalyst BUTTON: pick up a nearby ring, then seat it on a hook (edge-triggered)
  {
    const w = createChainWorld('match', 5, [chainSetup(0, 'blue')]);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 120;
    const rob = w.robots[0];
    const free = w.chain!.catalysts.find((c) => c.hook === null)!;
    // the mechanism reaches out its MOUNTED EDGE now, so put the ring in front of the claw
    // rather than an arbitrary +x offset from the chassis centre
    rob.heading = 0;
    free.pos = { x: rob.pos.x + 10, y: rob.pos.y };
    free.carriedBy = null;
    const one = (c: RobotCommand): void => chainStep(w, SIM_DT, new Map([[rob.id, c]]));
    one(cmd({ catalyst: true })); // press → pick up
    check('chain: catalyst button picks up a nearby ring', w.chain!.catalysts.some((c) => c.carriedBy === rob.id));
    one(cmd({})); // release
    // the mechanism now has a CYCLE time (an arm has to extend and retract), so a second
    // action a few ticks later is correctly refused — wait it out before seating.
    for (let i = 0; i < 60; i++) one(cmd({}));
    const hk = hookPos('blue', 0);
    rob.pos = { x: hk.x - 12, y: hk.y };
    rob.vel = { x: 0, y: 0 };
    // the default mechanism is the CLAW ARM, which reaches through a cone out its mounted
    // edge — so it has to be POINTED at the hook. (A rail turret would not care; that is
    // exactly what you buy with it.) Facing was irrelevant under the old centre-radius model.
    rob.heading = 0; // front mount, hook is straight ahead at +x
    one(cmd({ catalyst: true })); // press again → seat on the hook
    check('chain: catalyst button seats a carried ring on a hook', w.chain!.catalysts.some((c) => c.hook?.alliance === 'blue'));
  }

  // PLACE ON THE OPPONENT'S GOAL: a blue robot carrying a ring, next to a RED hook, can seat it there
  {
    const w = createChainWorld('match', 7, [chainSetup(0, 'blue')]);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 120;
    const rob = w.robots[0];
    const ring = w.chain!.catalysts[0];
    ring.hook = null;
    ring.carriedBy = rob.id; // carrying
    const redHook = hookPos('red', 0);
    rob.pos = { x: redHook.x + 6, y: redHook.y }; // next to the RED (opponent) hook
    rob.vel = { x: 0, y: 0 };
    chainStep(w, SIM_DT, new Map([[rob.id, cmd({ catalyst: true })]]));
    check('chain: a ring can be placed on the OPPONENT goal', w.chain!.catalysts[0].hook?.alliance === 'red');
  }

  // RING ACTION PROMPT: chainCatalystPrompt reports pickup/place availability for the HUD hint
  {
    const w = createChainWorld('match', 6, [chainSetup(0, 'blue')]);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 120;
    const rob = w.robots[0];
    const free = w.chain!.catalysts.find((c) => c.hook === null)!;
    free.pos = { x: 0, y: 0 };
    free.carriedBy = null;
    // far from any ring → no prompt
    rob.pos = { x: 60, y: 60 };
    const farNull = chainCatalystPrompt(w.chain!, rob) === null;
    // next to the free ring, claw pointed at it → pickup
    rob.pos = { x: -10, y: 0 };
    rob.heading = 0;
    const canPick = chainCatalystPrompt(w.chain!, rob)?.action === 'pickup';
    // carrying, facing an empty own hook → place
    free.carriedBy = rob.id;
    const hk = hookPos('blue', 0);
    rob.pos = { x: hk.x - 12, y: hk.y };
    rob.heading = 0;
    const canPlace = chainCatalystPrompt(w.chain!, rob)?.action === 'place';
    check('chain ring prompt: reports pickup/place availability (and null when out of range)', farNull && canPick && canPlace, `far=${farNull} pick=${canPick} place=${canPlace}`);
  }

  // take rings OUT of a goal — your OWN and the OPPONENT's (de-score)
  {
    const w = createChainWorld('match', 8, [chainSetup(0, 'blue')]);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 120;
    const rob = w.robots[0]; // blue
    const cat = w.chain!.catalysts[0];
    cat.carriedBy = null;
    // own goal: seat on a blue hook, drive to it, press → removed + carried
    cat.hook = { alliance: 'blue', index: 0 };
    const bh = hookPos('blue', 0);
    rob.pos = { x: bh.x - 12, y: bh.y };
    rob.heading = 0; // claw pointed at the hook (see the mechanism reach model)
    rob.vel = { x: 0, y: 0 };
    chainStep(w, SIM_DT, new Map([[rob.id, cmd({ catalyst: true })]]));
    check('chain: take a ring OUT of your own goal', cat.hook === null && cat.carriedBy === rob.id);
  }
  {
    const w = createChainWorld('match', 9, [chainSetup(0, 'blue')]);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 120;
    const rob = w.robots[0]; // blue robot at the RED (opponent) goal
    const cat = w.chain!.catalysts[0];
    cat.carriedBy = null;
    cat.hook = { alliance: 'red', index: 0 };
    const rh = hookPos('red', 0);
    rob.pos = { x: rh.x + 6, y: rh.y };
    rob.vel = { x: 0, y: 0 };
    chainStep(w, SIM_DT, new Map([[rob.id, cmd({ catalyst: true })]]));
    check(
      'chain: take a ring OUT of the opponent goal (de-score)',
      cat.hook === null && cat.carriedBy === rob.id && accelMultiplier(w.chain!, 'red') === 1,
    );
  }

  // ── PENALTIES (G05 endgame ascend / G06 auto section) ──
  // G06: in AUTO, contacting an opponent that is COMPLETELY in its own section → MAJOR
  // on the aggressor. Blue sits fully in its half (x>0, outside the particle diamond);
  // red touches it → foul RED.
  {
    const w = createChainWorld('match', 20, [chainSetup(0, 'blue'), chainSetup(1, 'red')]);
    w.match.phase = 'auto';
    w.match.phaseTimeLeft = 20;
    const blue = w.robots[0];
    const red = w.robots[1];
    blue.heading = 0; blue.pos = { x: 45, y: 0 }; blue.vel = { x: 0, y: 0 };
    red.heading = 0; red.pos = { x: 30, y: 0 }; red.vel = { x: 0, y: 0 };
    chainStep(w, SIM_DT, new Map());
    check('chain penalty G06: contacting a section-protected opponent in auto → MAJOR on aggressor',
      w.match.fouls.red.major === 1 && w.match.fouls.blue.major === 0,
      `red=${w.match.fouls.red.major} blue=${w.match.fouls.blue.major}`);
    check('chain penalty G06: victim (blue) gets the foul points', w.match.scores.blue.foulPoints === PTS_FOUL_MAJOR);
    // edge-triggered: held contact does NOT re-award on the next tick
    chainStep(w, SIM_DT, new Map());
    check('chain penalty: EDGE-triggered (held contact fires once)', w.match.fouls.red.major === 1);
  }
  // G06 does NOT fire outside auto/teleop (e.g. pre) — same geometry, no foul
  {
    const w = createChainWorld('match', 21, [chainSetup(0, 'blue'), chainSetup(1, 'red')]);
    w.match.phase = 'pre';
    const blue = w.robots[0]; const red = w.robots[1];
    blue.heading = 0; blue.pos = { x: 45, y: 0 }; blue.vel = { x: 0, y: 0 };
    red.heading = 0; red.pos = { x: 30, y: 0 }; red.vel = { x: 0, y: 0 };
    chainStep(w, SIM_DT, new Map());
    check('chain penalty: no fouls during pre-match', w.match.fouls.red.major === 0);
  }
  // G05: in END GAME, contacting an ASCENDING opponent → MAJOR on the aggressor.
  {
    const w = createChainWorld('match', 22, [chainSetup(0, 'blue'), chainSetup(1, 'red')]);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 10; // within the 20 s end game
    const blue = w.robots[0]; const red = w.robots[1];
    blue.heading = 0; blue.pos = { x: 0, y: 0 }; blue.vel = { x: 0, y: 0 };
    red.heading = 0; red.pos = { x: 15, y: 0 }; red.vel = { x: 0, y: 0 };
    w.chain!.endgame[blue.id] = 'ascended'; // read last-tick by the penalty pass
    chainStep(w, SIM_DT, new Map());
    check('chain penalty G05: contacting an ascending opponent in endgame → MAJOR on aggressor',
      w.match.fouls.red.major === 1, `red=${w.match.fouls.red.major}`);
  }
  // foul points fold into the CR alliance TOTAL (particles + endgame + fouls)
  {
    const w = createChainWorld('match', 24, [chainSetup(0, 'blue'), chainSetup(1, 'red')]);
    w.match.phase = 'auto';
    w.match.phaseTimeLeft = 20;
    const blue = w.robots[0]; const red = w.robots[1];
    blue.heading = 0; blue.pos = { x: 45, y: 0 }; blue.vel = { x: 0, y: 0 };
    red.heading = 0; red.pos = { x: 30, y: 0 }; red.vel = { x: 0, y: 0 };
    chainStep(w, SIM_DT, new Map());
    check('chain penalty: foul points fold into the alliance total', w.match.scores.blue.total === PTS_FOUL_MAJOR);
  }

  // a server Room configured for Chain Reaction runs its step + advances to 'post'
  // without throwing, and its matchStart advertises game:'chain'
  const msgs: ServerMsg[] = [];
  let crOutcomeGame: string | undefined = 'unset';
  const crRoom = new Room('smoke-chain', () => {}, { kind: 'versus', game: 'chain' }, (o) => {
    crOutcomeGame = o.game;
  });
  const crClient: Client = {
    id: 'cc1',
    send: (m: ServerMsg) => msgs.push(m),
    player: {
      clientId: 'cc1',
      name: 'CR',
      teamName: 'T',
      teamNumber: 1,
      alliance: 'blue',
      startIndex: 0,
      ready: true,
      spec: { ...DEFAULT_SPEC },
      assists: { ...DEFAULT_ASSISTS },
    },
    connected: true,
    disconnectAt: 0,
  };
  crRoom.add(crClient);
  let threw = false;
  try {
    crRoom.onMessage('cc1', { t: 'start' });
    crRoom.advanceForTest(maxMatchTicks() + 5);
  } catch {
    threw = true;
  }
  const crStart = msgs.find((m) => m.t === 'matchStart') as Extract<ServerMsg, { t: 'matchStart' }> | undefined;
  check('chain room: starts + advances to post without throwing', !threw);
  check('chain room: matchStart advertises game:"chain"', crStart?.game === 'chain');
  // the outcome carries game:'chain' so persistMatch writes to the CR boards (its own
  // per-game ranked/record period — see server/persist.ts + repo.ts game keying)
  check('chain room: MatchOutcome.game is "chain" (per-game board keying)', crOutcomeGame === 'chain');
  check('chain: is scored, so its matches DO persist (to CR boards)', moduleFor('chain').scored === true);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);