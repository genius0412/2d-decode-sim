/**
 * Headless smoke test of the sim core: drives, shoots (incl. on the move),
 * opens the gate, and checks scoring math. Run with: npx tsx scripts/smoke.ts
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { createWorld, DEFAULT_ASSISTS, DEFAULT_SPEC, PLAYER_ASSISTS, coerceAssists, coerceSpec, coerceSetup, coerceStartPose } from '../src/sim/spawn';
import { drawWheels } from '../src/games/chain/parts';
import { sanitizePlayer, sanitizePlayerPatch } from '../src/net/sanitize';
import { derivedRole, savedStartCap } from '../src/ui/startPositions';
import { queuedModes, queuedGames, queuesFor, anyoneQueued, expandLabel, widenHint } from '../src/ui/queueDepth';
import {
  parkQueue, takeQueue, dropQueue, updateQueue, peekQueue, subscribeQueue, elapsedLabel, elapsedSeconds,
} from '../src/ui/queueKeeper';
import type { LobbyPlayer } from '../src/net/protocol';
import { generateRoomCode, isValidRoomCode, normalizeRoomCode } from '../src/net/roomCode';
import { step } from '../src/sim/world';
import { Keyboard } from '../src/input/keyboard';
import { updatePenalties } from '../src/sim/penalties';
import { aimSolution, robotInLaunchZone } from '../src/sim/robot';
import { updateHumanPlayers } from '../src/sim/humanPlayer';
import { startMatch } from '../src/sim/match';
import { gateColliderPos, gateRestOn, pushingGate } from '../src/sim/goal';
import { chassisCorners } from '../src/sim/physics';
import { pointDepthInChassis } from '../src/sim/physics';
import {
  inLaunchZone,
  gateZone,
  gateArmRect,
  startPose,
  goalCenter,
  goalTriangle,
  goalFaceNormal,
  goalFacePoints,
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
  footprintCorners,
} from '../src/sim/field';
import { addClassified, addOverflow, assessMatchEnd, awardCard, awardFoul } from '../src/sim/scoring';
import type { Alliance, DrivetrainType, GameId, GameMode, RobotCommand, RobotSpec, RobotState, World } from '../src/types';
import {
  SIM_DT,
  PRE_COUNTDOWN as C_PRE_COUNTDOWN,
  GATE_APPROACH_S,
  GATE_LINE_S,
  GATE_OPEN_LATCH_S,
  GATE_STOP_S,
  GATE_OPEN_LATCH_S,
  GATE_PASS_FRAC,
  GATE_PADDLE_REACH,
  GATE_GRAVITY,
  GATE_SEAT_FRAC,
  RAIL_OPEN_S,
  RAIL_DROP_S,
  RAMP_SLOTS,
  GATE_PADDLE_SHOVE,
  GATE_SHOVE_MIN,
  RAIL_ACCEL,
  RAIL_RATTLE_DRAG,
  ROBOT_MIN_WIDTH,
  INTAKE_ROLLER_MM,
  intakeRollerDia,
  intakeMouth,
  GATE_LINE_S,
  GATE_RIDE_FRAC,
  GATE_TAPE_Y,
  RAIL_PITCH,
  RAIL_TERMINAL,
  HOPPER_CAPACITY,
  RAIL_EXIT_S,
  RAIL_ENTRY_V,
  RAIL_S_MAX,
  OVERFLOW_ROLL_LOSS,
  OVERFLOW_SLOPE_MAX,
  OVERFLOW_BUMP,
  RAIL_ACCEL,
  OVERFLOW_Z,
  BASIN_FLOOR_Z,
  RAMP_SURFACE_Z,
  FIELD_HALF,
  TUNNEL_STRIP_LEN,
  LOAD_ZONE_SIZE,
  BALL_RADIUS,
  CLASSIFIER_W,
  RAIL_WANDER_AMP,
  ROBOT_HEIGHT,
  HP_INITIAL_STOCK,
  HP_PLACE_DELAY,
  BALANCE_VERSION,
  SIM_VERSION,
  INTAKE_PRESETS,
  INTAKE_CATCH_LENIENCE,
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
  POSSESSION_CONFIRM,
  POSSESSION_GRACE,
  PTS_FOUL_MAJOR,
  MAX_SAVED_STARTS,
  MAX_SAVED_STARTS_SUPPORTER,
  CHASSIS_COLORS,
  chassisFill,
  PLACEMENT_GAMES,
} from '../src/config';
import {
  pointDepthInRobot,
  robotCorners,
  robotExtents,
  robotIntersectsRect,
  wheelContacts,
} from '../src/sim/physics';
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
  replayPlayable,
  runRecordMatch,
  trackStride,
  type CommandSource,
  replayViewpoint,
  type Replay,
  type ReplayResult,
} from '../src/sim/replay';
import { EMPTY_ACTIVITY, averageMatch, playtimeLong, playtimeText } from '../src/playtime';
import { routeTarget } from '../server/routing';
import { roomPersists } from '../server/channel';
import { Room, type Client, type DodgeReport } from '../server/room';
import { maintenanceBiting } from '../server/db/repo';
import { maintenanceLine } from '../src/ui/MaintenanceBanner';
import { moderateName, scrubName, moderationEnabled } from '../server/moderation';
import { Matchmaker, radiusCeiling, type QueueEntry } from '../server/matchmaking';
import { bestHost } from '../server/regions';
import type { PendingMatch } from '../server/matchTypes';
import { computeGlicko, glicko2Update, eloMode, RD_PROVISIONAL, type EloParticipant } from '../server/ranked';
import { isReportReason, REPORT_REASONS } from '../src/report';
import {
  STANDING_MAX, STANDING_COST, STANDING_TIERS, REPORT_CAP, HEAL_PER_DAY, HEAL_PER_CLEAN_MATCH,
  COOLDOWN_LADDER, RATING_LADDER, WINDOW_HOURS, ladderRung,
  tierOf, healed, clampScore, repeatMult, applyStandingEvent, queueLocked, lockRemaining,
  judgeParticipation, MIN_JUDGED_TICKS, AFK_DRIVE_FRACTION, LEAVE_AWAY_FRACTION,
  type StandingEventKind, type StandingState,
} from '../src/standing';
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
  CHAIN_RAIL_RATE,
  CHAIN_REAL_PRESETS,
  chainMassFloorBump,
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
import { CHAIN_HOOKS_PER_GOAL, accelMultiplier, catalystRailHalf, catalystRailTarget, catalystMouth, catalystTrackTarget, chainEvalStart, chainStartExtents, chainHeadingFits, chainNearestFittingHeading, chainSnapStartPose, chainIntakeMouths, chainMirrorStart, chainSnapStart, chainStartLegal, hookPos, labAreas, onRingStand, ringStandBoxes, ringStands } from '../src/games/chain/state';
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
  CHAIN_MIN_WIDTH,
  CHAIN_MAX_WIDTH,
  CHAIN_BEAM_CURB_SLOP,
  chainMassFloorBump,
  chainStorageMax,
} from '../src/games/chain/config';
import { CHAIN_CATALYST_MOUNTS, CHAIN_INTAKE_MOUNTS, CHAIN_TURRET_POSITIONS, MOUNT_ANGLE, RAIL_DIR, catalystMountOf, catalystMountPositions, catalystSwingOf, isSwingMount, swingAxesFor, intakeMountOf, isEdgePos, isTurreted, mountsClash, shooterMountOf, turretLocal, turretRadius } from '../src/games/chain/mounts';

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
  // A tap drains SOME of the column and then gives out — it must not empty the ramp (see
  // the tap-depth sweep). What is left stays retained.
  check('a tapped gate drains part of the column', ramped >= 2 && slotCount(w, 'blue') < ramped, `slots ${ramped} -> ${slotCount(w, 'blue')}`);
  check('gate re-closed once the drain gave out', !w.goals.blue.gateOpen);
  // NOT "gatePos === 0". The arm comes to rest on WHAT IS UNDER IT, so with artifacts still
  // on the ramp it correctly seats on one (at GATE_SEAT_FRAC or below) rather than falling
  // flat. Flat is only right when the gateway is genuinely empty. What matters either way is
  // that it is no longer passable.
  check(
    'the arm ends NOT passable — flat if the gateway is empty, seated on an artifact if not',
    w.goals.blue.gatePos < GATE_PASS_FRAC && w.goals.blue.gatePos <= GATE_SEAT_FRAC + 1e-9,
    `gatePos ${w.goals.blue.gatePos.toFixed(3)} (pass ${GATE_PASS_FRAC}, seat ${GATE_SEAT_FRAC})`,
  );
}

// ---- HELD open streams; TAPPED open meters, and can give out ---------------------
// The paddle is not weightless and it cannot hover. A robot holding the arm up keeps it
// CLEAR of the artifacts, so the column just flows; let go and the arm settles ONTO the
// flow at GATE_RIDE_FRAC, where its weight drags every artifact passing under it and it
// sags in the gaps between them. That is the whole difference, and before it existed the
// two drained at literally the same rate — 0.596s vs 0.598s between releases, a metronome
// either way, because a ball in the gateway simply FROZE gatePos wherever it happened to
// be (pinned at 1.0, touching nothing).
{
  /** drain a full 9-artifact column and report the release cadence */
  const drain = (hold: boolean) => {
    const w = mkWorld('match', 'blue', 42);
    startMatch(w);
    fillBlueRail(w);
    const r = w.robots[0];
    const zone = gateZone('blue');
    r.pos = { x: zone.x1 + 7, y: (zone.y0 + zone.y1) / 2 };
    r.heading = Math.PI; // face the -x (blue) wall
    r.fieldCentric = false;
    r.vel = { x: 0, y: 0 };
    const left = () => w.balls.filter((b) => b.state.kind === 'rail' && b.state.goal === 'blue').length;
    const gaps: number[] = [];
    const times: number[] = []; // when each artifact was released
    let prev = left();
    let last = -1;
    let drove = false;
    // how far the arm SAGS onto the flow — measured only once it has reached full open,
    // so the opening ramp (0 -> 1, which passes through every fraction) isn't mistaken
    // for the paddle resting on an artifact
    let sag = 1;
    let rode = 0; // the fraction it was last seen riding at, above the pass line
    let peakPos = 0;
    let fullyOpen = false;
    for (let i = 0; i < Math.round(10 / SIM_DT); i++) {
      const t = i * SIM_DT;
      let c = cmd({});
      if (hold || t < 0.3) c = cmd({ driveY: 1 });
      else if (!drove) {
        r.pos = { x: 0, y: -30 }; // tap: drive away and let the arm find the flow
        drove = true;
      }
      step(w, SIM_DT, new Map([[0, c]]));
      const g = w.goals.blue;
      const n = left();
      if (n > 0) {
        if (g.gatePos > peakPos) peakPos = g.gatePos;
        if (g.gatePos >= 1) fullyOpen = true;
        if (fullyOpen) {
          if (g.gatePos < sag) sag = g.gatePos;
          if (g.gatePos > GATE_PASS_FRAC && g.gatePos < 1) rode = g.gatePos;
        }
      }
      if (n < prev) {
        for (let k = 0; k < prev - n; k++) {
          if (last >= 0) gaps.push(t - last);
          last = t;
          times.push(t);
        }
        prev = n;
      }
    }
    const mean = gaps.length ? gaps.reduce((p, q) => p + q, 0) / gaps.length : 0;
    return { w, left: left(), gaps, mean, max: gaps.length ? Math.max(...gaps) : 0, rode, sag, peakPos, times };
  };

  const held = drain(true);
  const tapped = drain(false);

  check(
    'a HELD gate drains the whole column',
    held.left === 0,
    `${9 - held.left}/9 out`,
  );
  // the old bug: every artifact was slammed to v=0 at the exit, released at ZERO speed,
  // and only shoved clear by the EXIT_NUDGE creep — so the column restarted from rest
  // every cycle and the gaps sat at 0.60s. A packed column following the artifact ahead
  // out at ramp speed is roughly RAIL_PITCH / flow speed.
  check(
    'a HELD gate STREAMS — no metering cadence between releases',
    held.mean < 0.4 && held.max < 0.5,
    `mean ${held.mean.toFixed(3)}s max ${held.max.toFixed(3)}s`,
  );
  check(
    'a held arm stays fully lifted, clear of the flow (no paddle drag)',
    held.peakPos === 1 && held.sag === 1,
    `peak ${held.peakPos.toFixed(2)} sag ${held.sag.toFixed(2)}`,
  );
  check(
    'an UNHELD arm settles ONTO the flow rather than hovering',
    // `rode` is the last fraction seen between the pass line and fully open, which includes
    // the arm on its way DOWN, so it is not bounded by the ride height. What matters is that
    // an unheld arm comes off full open at all, unlike a held one.
    tapped.sag < 1 && tapped.rode > 0,
    `sagged to ${tapped.sag.toFixed(3)}, rode at ${tapped.rode.toFixed(3)} (pass ${GATE_PASS_FRAC})`,
  );
  // THE HEADLINE REQUIREMENT: "the gate always empties all... it shouldn't." A tap buys you
  // a few artifacts and then the arm settles onto the column and the drain gives out; only
  // a robot actually holding the lever empties the ramp.
  //
  // (Do NOT restate this as a comparison of mean release gaps. It was written that way
  // first and it lies: the tapped run gives out early, so its mean covers only the opening
  // fast releases while the held mean is dragged up by the later ones, where a pile has
  // built outside the gate — it reads as the tapped gate being FASTER.)
  void held;
  // "it would randomly stop if the momentum is not enough to keep the gate open" — the
  // ride height an artifact can hold is proportional to its speed, so a column that has
  // spread out lets the arm fall past GATE_PASS_FRAC and the drain simply gives out.
  // What a tap is worth is asserted as a DISTRIBUTION below (27 combinations of packing,
  // tap length and run-up), never from this one scenario. With the ramp discharging at its
  // own gravity-driven speed, a packed column and a firm tap legitimately empties — that is
  // one point in a 3..9 spread, not a regression.

  // ...AT EVERY COLUMN DEPTH, which is the form the complaint actually took ("right now the
  // gate always empties all"). A 9-stack stalling proves nothing on its own: real ramps hold
  // a handful, and a tap used to empty EVERY column up to six. A tap is worth a few
  // artifacts, and how many depends on how the column happens to be packed.
  {
    const tapDrain = (n: number, spread: number, tapS = 0.3, standoff = 7) => {
      const w = mkWorld('match', 'blue', 42);
      startMatch(w);
      for (let i = 0; i < n; i++) {
        const b = w.balls[i];
        const s = GATE_STOP_S + i * (RAIL_PITCH + spread);
        b.state = { kind: 'rail', goal: 'blue', s, v: 0, overflow: false };
        b.pos = railPos('blue', s);
        b.vel = { x: 0, y: 0 };
        b.z = RAMP_SURFACE_Z;
        b.vz = 0;
      }
      const r = w.robots[0];
      const z = gateZone('blue');
      r.pos = { x: z.x1 + standoff, y: (z.y0 + z.y1) / 2 };
      r.heading = Math.PI;
      r.fieldCentric = false;
      r.vel = { x: 0, y: 0 };
      run(w, cmd({ driveY: 1 }), tapS);
      r.pos = { x: 0, y: -30 };
      run(w, cmd({}), 12);
      return n - w.balls.filter((b) => b.state.kind === 'rail' && b.state.goal === 'blue').length;
    };
    // WHAT A TAP IS WORTH IS A RANGE, NOT A DOSE: "it should empty up to maximum 9, but as
    // low as like 4 or 5". So this asserts the SPREAD across the conditions a driver
    // actually varies — how packed the column is, how long the tap was, how much run-up
    // there was — rather than a number at one setting. Sweeping only packing at a fixed tap
    // reads as a flat 6 and hides the whole distribution; that is how an earlier version of
    // this check convinced me the yield was a constant when it was not.
    const yields: number[] = [];
    for (const spread of [0, 2, 5]) {
      // Sampled ACROSS the tap-length gradient, not either side of it. How long the arm is
      // held is what decides the yield — 0.15s gives 1, 0.18s gives 2, 0.22s gives 3, 0.28s
      // gives 5, 0.30s empties it — and [0.15, 0.3, 0.5] straddled that jump, seeing only the
      // two ends and reading as a fixed dose.
      for (const tapS of [0.15, 0.2, 0.25, 0.28, 0.35]) {
        for (const standoff of [4, 11]) yields.push(tapDrain(9, spread, tapS, standoff));
      }
    }
    const lo = Math.min(...yields);
    const hi = Math.max(...yields);
    /**
     * WHAT A TAP IS WORTH CHANGED WHEN THE CHUTE GOT STEEPER, and it is worth saying why
     * rather than restating the bound.
     *
     * This used to assert a SPREAD — "it should empty up to maximum 9, but as low as like 4
     * or 5" — and it held while the ramp delivered slowly: the flow petered out, the arm
     * settled onto the column, and the drain gave out part way. Then "balls come down at a
     * slightly too slow frequency" steepened the chute (RAIL_ACCEL 50 -> 65 at the same
     * delivery speed), and a denser stream keeps knocking the arm up (GATE_SHOULDER_LIFT)
     * faster than it can fall. So on a PACKED column any real tap now carries the whole ramp.
     *
     * That is the honest consequence of the two things asked for in a row — more artifacts
     * per tap, then a quicker cadence — and both are the same knob. Restoring the spread
     * means raising the speed an artifact needs to keep the arm passable, which trades the
     * cadence back; the dial is GATE_SHOULDER_LIFT and this note is where to start.
     *
     * What still varies is whether the tap REACHES the lever at all: from a standoff the
     * robot has to cross the gate zone first, and under about 0.15s it never gets there.
     */
    check(
      'a tap that reaches the lever carries the whole ramp',
      hi >= RAMP_SLOTS,
      `best tap: ${hi} of 9 (worst ${lo}, which is a tap too short to cross the standoff)`,
    );
    /**
     * A QUICK BUMP IS WORTH MORE THAN ONE ARTIFACT. Reported from play: "a tap lets out 1 or
     * 2." The tap-length gradient above is sampled from 0.15s, which is already a deliberate
     * press; a driver bumping the lever and coming off it is at 0.10s.
     */
    const quick = [0, 1, 2].map((sp) => tapDrain(9, sp, 0.12));
    check(
      'a quick bump off the lever is worth more than one artifact',
      Math.max(...quick) >= 3 && quick.every((y) => y >= 2),
      `0.12s tap at +0/1/2in packing -> ${quick.join(' ')}`,
    );
    /**
     * ...AND WHY, stated as the arithmetic, because this is the relation that broke it.
     *
     * A tap on a RESTING column is a race between two times, and neither is a feel constant:
     *
     *   the arm's fall from fully open to the pass line   sqrt(2 * (1 - PASS) / GATE_GRAVITY)
     *   the column's delivery of its next artifact        sqrt(2 * RAIL_PITCH / RAIL_ACCEL)
     *
     * The second one DOUBLED when the ramp stopped running at a capped flow speed (RAIL_ACCEL
     * 80 -> 25 moved it 0.36s -> 0.64s) and the arm's fall was left at 0.45s. The arm was then
     * always shut before the second artifact could arrive, and no amount of knock could fix
     * the first gap — a tap was worth exactly what was already sitting at the gate.
     *
     * The ratio is the whole story and it has a floor AND a ceiling. Push the fall past the
     * delivery and every tap empties the ramp (measured: at GATE_GRAVITY 2.9, fall 0.64s, the
     * yield is 9 in every one of 50 conditions — the drain can no longer give out at all).
     * Well under it and nothing ever follows the first artifact out. Marginal is the point.
     */
    const armFall = Math.sqrt((2 * (1 - GATE_PASS_FRAC)) / GATE_GRAVITY);
    const railPitchTime = Math.sqrt((2 * RAIL_PITCH) / RAIL_ACCEL);
    /**
     * ...AND THAT RATIO IS NOW DELIBERATELY OVER ONE.
     *
     * The band above was 0.75-1.00 — marginal, so the yield varied with how the column
     * happened to be packed. Two asks moved it, in the same direction, on purpose: "gate
     * should stay open for longer" slowed the arm, and "balls come down at a too slow
     * cadence and lose too much velocity" steepened the chute twice (RAIL_ACCEL 50 -> 65 ->
     * 100). Both shorten the delivery against the fall, and past 1.0 the arm cannot shut
     * between artifacts, so a tap carries the whole ramp. That is the behaviour asked for and
     * it is recorded here rather than defended.
     *
     * The ceiling is what still matters: far enough past 1 and the arm is effectively never
     * shut, which is a different mechanism (and a gate that no longer means anything). 1.6
     * leaves the fall visibly shorter than two artifacts' worth of delivery.
     */
    check(
      "the arm's fall outlasts the ramp's pace, so a tap carries the ramp",
      armFall > railPitchTime && armFall < railPitchTime * 1.6,
      `fall ${armFall.toFixed(2)}s vs one pitch from rest ${railPitchTime.toFixed(2)}s (ratio ${(armFall / railPitchTime).toFixed(2)}; it was 0.75-1.00 when a tap was meant to be marginal)`,
    );
    /**
     * THE BENCHMARK, in the user's words: "on a gate tap, 5-9 balls must release."
     *
     * This replaces a check that asked for the yield to vary with how PACKED the column is.
     * It did, on a 5-degree ramp where the flow was marginal enough that spacing decided
     * whether it sustained. The ramp is 10.5 degrees now (RAIL_ACCEL 50 — the flow was too
     * slow, "the initial balls are too slow"), and at that pace a firm tap carries any
     * column: loosening the pitch by 8in no longer changes the answer. What still varies is
     * the tap itself, which is what the gradient above measures.
     *
     * A tap that never reaches the lever is a MISS, not a tap, and is excluded — a robot 11in
     * back with a 0.10s press has not touched the arm when the press ends.
     */
    const benchmark: number[] = [];
    for (const sp of [0, 1, 2]) {
      for (const tapS of [0.15, 0.2, 0.25, 0.3, 0.5]) {
        for (const standoff of [4, 7]) benchmark.push(tapDrain(9, sp, tapS, standoff));
      }
    }
    const low = Math.min(...benchmark);
    check(
      'THE BENCHMARK: a tap releases 5 to 9 artifacts',
      low >= 5 && Math.max(...benchmark) <= RAMP_SLOTS,
      `${benchmark.length} taps: worst ${low}, best ${Math.max(...benchmark)}, mean ${(benchmark.reduce((a, b) => a + b, 0) / benchmark.length).toFixed(1)}`,
    );
  }

  // THE GATE NEVER COMES TO REST ON AN ARTIFACT. It LANDS on one often — the paddle's reach
  // is 2R wide against a 5.1in pitch, so it nearly always meets something — but landing is
  // not resting: its weight has a sideways component, so it pushes the artifact off, either
  // OUT past the gate or back UP into the classifier, and then closes.
  //
  // Getting to "never" took three goes and the reason is worth keeping. gateStopS (where the
  // arm blocks) and gateRestOn (how high an artifact holds it) are exact INVERSES, so the
  // pair is neutrally stable at EVERY offset: wherever the artifact stops, the arm settles to
  // precisely the height that blocks it right there, and it sits forever (measured d = 1.30,
  // v = 0.0, rest = 0.315 = gatePos, tick after tick). A proportional push cannot break that
  // near its own neutral point, so the shove carries a minimum magnitude (GATE_SHOVE_MIN) and
  // takes only its DIRECTION from which side it landed. And the paddle is no floor for an
  // artifact it is EXPELLING — though it very much is one for an artifact it is shoving back
  // up, which is just the gate doing its job.
  {
    let onBall = 0;
    let total = 0;
    for (const n of [4, 6, 8]) {
      for (const spread of [0, 0.4, 0.8, 1.2, 1.6, 2.4]) {
        const w = mkWorld('match', 'blue', 42);
        startMatch(w);
        for (const b of w.balls) if (b.state.kind === 'ground') b.pos = { x: 900, y: 900 };
        for (let i = 0; i < n; i++) {
          const b = w.balls[i];
          const s = GATE_STOP_S + i * (RAIL_PITCH + spread);
          b.state = { kind: 'rail', goal: 'blue', s, v: 0, overflow: false };
          b.pos = railPos('blue', s);
          b.vel = { x: 0, y: 0 };
          b.z = RAMP_SURFACE_Z;
          b.vz = 0;
        }
        const r = w.robots[0];
        const z = gateZone('blue');
        r.pos = { x: z.x1 + 7, y: (z.y0 + z.y1) / 2 };
        r.heading = Math.PI;
        r.fieldCentric = false;
        r.vel = { x: 0, y: 0 };
        run(w, cmd({ driveY: 1 }), 0.3);
        r.pos = { x: 0, y: -30 };
        run(w, cmd({}), 10);
        total++;
        if (w.goals.blue.gatePos > 0.001 && w.goals.blue.gatePos < GATE_PASS_FRAC) onBall++;
      }
    }
    check(
      'the gate NEVER comes to rest on an artifact — it always resolves',
      onBall === 0,
      `${onBall}/${total} stalls left the arm seated on one`,
    );
  }

  // ...AND NOTHING UP-RAMP OF THE PADDLE PROPS IT OPEN. The gateway was asked with
  // GATE_CLOSE_CLEAR (8.5in, d from -3.5 to +5.0) rather than the paddle's actual reach,
  // so an artifact a FULL DIAMETER clear of the gate — one that has not reached it and
  // cannot be touching it — held the arm up and kept the flow going.
  {
    const w = mkWorld('match', 'blue', 42);
    startMatch(w);
    w.robots[0].pos = { x: 0, y: -40 };
    for (const b of w.balls) if (b.state.kind === 'ground') b.pos = { x: 900, y: 900 };
    // ONE artifact, parked well up-ramp of the gate line and held there, nothing below it
    const b = w.balls[0];
    const s = GATE_LINE_S + BALL_RADIUS + 1.5; // clear of the paddle's reach
    b.state = { kind: 'rail', goal: 'blue', s, v: 0, overflow: false };
    b.pos = railPos('blue', s);
    b.vel = { x: 0, y: 0 };
    b.z = RAMP_SURFACE_Z;
    b.vz = 0;
    const g = w.goals.blue;
    g.gatePos = 1;
    g.gateVel = 0;
    g.gateLatch = 0;
    g.gateOpen = true;
    run(w, cmd({}), 3);
    check(
      'an artifact up-ramp of the paddle does not prop the gate open',
      !g.gateOpen,
      `gatePos ${g.gatePos.toFixed(3)}`,
    );
  }

  // ...and where a tap DOES give out it must be a stall, never a deadlock: tap again and the
  // rest comes out. Skipped when this particular tap emptied the ramp, which is now a
  // legitimate outcome; the give-out case is covered by the distribution block.
  if (tapped.left > 0) {
    const w = tapped.w;
    const r = w.robots[0];
    const zone = gateZone('blue');
    r.pos = { x: zone.x1 + 7, y: (zone.y0 + zone.y1) / 2 };
    r.vel = { x: 0, y: 0 };
    const before = tapped.left;
    run(w, cmd({ driveY: 1 }), 0.3);
    r.pos = { x: 0, y: -30 };
    run(w, cmd({}), 6);
    const after = w.balls.filter((b) => b.state.kind === 'rail' && b.state.goal === 'blue').length;
    check(
      'a second tap resumes a gate that gave out (a stall, never a deadlock)',
      after < before,
      `${before} left -> ${after}`,
    );
  }
}

// ---- a STALLED column does not wind up ------------------------------------------
// Reported: "after ball flow resumes after being stalled, it shoots down extremely quickly".
// A blocked artifact is not being accelerated — whatever holds it up pushes back exactly as
// hard as gravity pulls — but the solver went on adding RAIL_ACCEL to `v` every tick it stood
// still, because the only cap on a blocked artifact's speed was the floor's, and an OPEN gate
// declares "no cap". Measured: a column pinned by a robot on the outflow marched to the
// RAIL_TERMINAL safety cap of 120 in/s in 4.8s and then left at up to 86 in/s the moment the
// robot moved, emptying the whole ramp in one burst. RAIL_TERMINAL is a safety cap, not a
// flow speed.
{
  const w = mkWorld('match', 'blue', 5);
  startMatch(w);
  w.match.phase = 'teleop';
  fillBlueRail(w);
  // parked ON the outflow, and HELD there every tick: the gate is wide open and the drain is
  // blocked anyway. Pinned rather than driven, because what is under test is the column's
  // speed while it waits, not how well a robot can hold a spot against the wall.
  const r = w.robots[0];
  const block = railPos('blue', RAIL_EXIT_S);
  const park = { x: block.x - 3, y: block.y - 4 };
  r.heading = Math.PI;
  r.fieldCentric = false;
  const railV = () =>
    w.balls
      .filter((b) => b.state.kind === 'rail' && b.state.goal === 'blue')
      .map((b) => Math.abs((b.state as { v: number }).v));
  const perTick: number[] = [];
  let stalledLeft = 0;
  for (let i = 0; i < Math.round(6 / SIM_DT); i++) {
    w.goals.blue.gatePos = 1;
    w.goals.blue.gateOpen = true;
    w.goals.blue.gateLatch = 1;
    r.pos = { ...park };
    r.heading = Math.PI; // ...and its heading: the gate arm PIVOTS a robot leaning on it now,
    r.vel = { x: 0, y: 0 }; // so an unpinned one turns off the outflow and stops blocking
    step(w, SIM_DT, new Map());
    perTick.push(Math.max(0, ...railV()));
    stalledLeft = railV().length;
  }
  // the front of the column arrives with real speed and KEEPS it, so this is not a check that
  // the ramp is at rest — it is that standing still buys nothing. Compare a window two seconds
  // into the stall against the last second of it: the wind-up added a flat RAIL_ACCEL every
  // second, so it moved this by +25 in/s and had reached the safety cap by 4.8s.
  const windowMax = (t0: number, t1: number) =>
    Math.max(...perTick.slice(Math.round(t0 / SIM_DT), Math.round(t1 / SIM_DT)));
  const midMax = windowMax(2, 3);
  const lateMax = windowMax(5, 6);
  // a stalled column carries the momentum it ARRIVED with and not a bit more. Nothing on this
  // ramp starts above rest, so five seconds of standing still must not manufacture any speed.
  check(
    'a column held against a block does not accumulate speed while it waits',
    stalledLeft >= 5 && lateMax <= midMax + 1e-6,
    `${stalledLeft} still on the ramp, max |v| ${midMax.toFixed(1)} in/s at 2s -> ${lateMax.toFixed(1)} at 6s (the wind-up reached ${RAIL_TERMINAL}, the safety cap)`,
  );
  // ...and when the block clears they leave at a speed the ramp could actually have given
  // them: RAIL_ACCEL over the length of the ramp, sqrt(2*a*s), and no artifact here has more
  // than a few pitches of runway left.
  const ceiling = Math.sqrt(2 * RAIL_ACCEL * (RAIL_S_MAX - RAIL_EXIT_S));
  r.pos = { x: 0, y: -40 };
  r.vel = { x: 0, y: 0 };
  const exits: number[] = [];
  const onRail = new Set(
    w.balls.filter((b) => b.state.kind === 'rail' && b.state.goal === 'blue').map((b) => b.id),
  );
  for (let i = 0; i < Math.round(6 / SIM_DT); i++) {
    w.goals.blue.gatePos = 1;
    w.goals.blue.gateOpen = true;
    w.goals.blue.gateLatch = 1;
    step(w, SIM_DT, new Map());
    for (const b of w.balls) {
      if (!onRail.has(b.id) || b.state.kind === 'rail') continue;
      onRail.delete(b.id);
      exits.push(hyp(b.vel.x, b.vel.y));
    }
  }
  const fastest = exits.length ? Math.max(...exits) : 0;
  check(
    'and it resumes at ramp speed rather than shooting out of the gate',
    exits.length >= 3 && fastest < ceiling,
    `${exits.length} out, fastest ${fastest.toFixed(1)} in/s (ramp ceiling ${ceiling.toFixed(1)})`,
  );
}

// ---- the arm's WEIGHT is a coherent set, and two of it are load-bearing ------------
// There is no single mass constant: the paddle's weight shows up in the drag it puts on
// what passes under it, the momentum needed to shoulder it, how readily a push eases it
// open, and how fast it settles. Making it "lighter" means moving all of those together.
// Two of them cannot be lightened freely, and this states why so a future tweak trips here
// rather than in a play session.
{
  check(
    'the paddle shove still beats gravity, or the gate can rest on an artifact again',
    GATE_PADDLE_SHOVE * GATE_SHOVE_MIN > RAIL_ACCEL,
    `${GATE_PADDLE_SHOVE} x ${GATE_SHOVE_MIN} = ${(GATE_PADDLE_SHOVE * GATE_SHOVE_MIN).toFixed(0)} vs RAIL_ACCEL ${RAIL_ACCEL}`,
  );
  // gateStopS and gateRestOn are exact inverses, so the pair is neutrally stable at EVERY
  // offset — only a shove that outruns gravity breaks it. Lightening GATE_PADDLE_SHOVE
  // without raising GATE_SHOVE_MIN to compensate puts the gate back on top of artifacts.
  /**
   * THE SEAT AND THE PASS HEIGHT ARE ONE NUMBER, and that is the geometry speaking rather
   * than a margin being kept.
   *
   * They used to be 0.34 and 0.40, the gap doing a job: "seated under the arm is not past
   * it", so that a resting column could not hold its own gate open and drain itself. That
   * gap was needed because the old gateway window was 8.5in against a 5.1in artifact pitch,
   * so a packed column ALWAYS had something under the arm. A stick tangent to a sphere has
   * its own, much tighter reach — and the check below is the one that now does the work.
   */
  check(
    'the seat IS the pass height: the stick rides highest at the apex, and clearing it is passing',
    GATE_SEAT_FRAC === GATE_PASS_FRAC && Math.abs(gateRestOn(0) - GATE_PASS_FRAC) < 1e-9,
    `seat ${GATE_SEAT_FRAC.toFixed(3)} = pass ${GATE_PASS_FRAC.toFixed(3)} = rest(0) ${gateRestOn(0).toFixed(3)}`,
  );
  check(
    '...and a packed column cannot hold its own gate passable, because the paddle reaches less than one pitch',
    2 * GATE_PADDLE_REACH < RAIL_PITCH,
    `paddle window ${(2 * GATE_PADDLE_REACH).toFixed(2)}in vs artifact pitch ${RAIL_PITCH}in`,
  );
}

// ---- how fast the arm closes: initial position, and the flow's momentum -----------
// "gate also closes up too quickly. how fast it closes up is determined by the momentum of
// the balls coming down and the initial position of the gate."
{
  const closeFrom = (p0: number) => {
    const w = mkWorld('match', 'blue', 42);
    startMatch(w);
    w.robots[0].pos = { x: 0, y: -40 };
    for (const b of w.balls) if (b.state.kind === 'ground') b.pos = { x: 900, y: 900 };
    const g = w.goals.blue;
    g.gatePos = p0;
    g.gateVel = 0;
    g.gateLatch = 0;
    g.gateOpen = p0 >= GATE_PASS_FRAC;
    for (let i = 0; i < Math.round(4 / SIM_DT); i++) {
      step(w, SIM_DT, new Map([[0, cmd({})]]));
      if (g.gatePos === 0) return (i + 1) * SIM_DT;
    }
    return Infinity;
  };
  const full = closeFrom(1);
  const half = closeFrom(0.5);
  // The bar moved once the knock-up existed: "the gate should close faster with no momentum
  // going in". An EMPTY gateway is now the fast case on purpose — this only asserts it is
  // still a swing and not a snap. What keeps it from slamming when it matters is the cushion,
  // checked below, and the flowing case is still ~4x slower than this one.
  check(
    'the arm still swings shut rather than snapping',
    full > 0.25,
    `${full.toFixed(3)}s from fully open with an empty gateway`,
  );
  // ...and it takes longer the further open it started, which is the point. The arm is in FREE
  // FALL for the whole swing now — GATE_GRAVITY is low enough (it is set by how long the arm
  // has to stay passable for a tapped column to reach it) that GATE_CLOSE_MAX is never
  // reached — so the time goes as the SQUARE ROOT of the height, which is what falling does.
  // It used to be terminal-limited and therefore near-proportional; that was a consequence of
  // a fall speed calibrated against a ramp that no longer exists.
  check(
    '...and how long it takes grows with how far open it was',
    half < full && Math.abs(half / full - Math.SQRT1_2) < 0.12,
    `half/full = ${(half / full).toFixed(2)} (0.71 = free fall, 0.50 = terminal-limited)`,
  );
  // ...and the flow cushions it: artifacts streaming under the paddle knock it back up as
  // fast as gravity brings it down.
  const withFlow = (() => {
    const w = mkWorld('match', 'blue', 42);
    startMatch(w);
    w.robots[0].pos = { x: 0, y: -40 };
    for (const b of w.balls) if (b.state.kind === 'ground') b.pos = { x: 900, y: 900 };
    for (let i = 0; i < 6; i++) {
      const b = w.balls[i];
      const cs = GATE_LINE_S + i * RAIL_PITCH;
      b.state = { kind: 'rail', goal: 'blue', s: cs, v: -40, overflow: false, pending: false };
      b.pos = railPos('blue', cs);
      b.vel = { x: 0, y: 0 };
      b.z = RAMP_SURFACE_Z;
      b.vz = 0;
    }
    const g = w.goals.blue;
    g.gatePos = 1;
    g.gateVel = 0;
    g.gateLatch = 0;
    g.gateOpen = true;
    let lowest = 1;
    for (let i = 0; i < Math.round(0.35 / SIM_DT); i++) {
      step(w, SIM_DT, new Map([[0, cmd({})]]));
      lowest = Math.min(lowest, g.gatePos);
    }
    return lowest;
  })();
  const noFlowAt035 = (() => {
    const w = mkWorld('match', 'blue', 42);
    startMatch(w);
    w.robots[0].pos = { x: 0, y: -40 };
    for (const b of w.balls) if (b.state.kind === 'ground') b.pos = { x: 900, y: 900 };
    const g = w.goals.blue;
    g.gatePos = 1;
    g.gateVel = 0;
    g.gateLatch = 0;
    g.gateOpen = true;
    run(w, cmd({}), 0.35);
    return g.gatePos;
  })();
  check(
    'a stream of artifacts under the paddle slows its fall',
    withFlow > noFlowAt035 + 0.05,
    `after 0.35s: with flow ${withFlow.toFixed(3)} vs empty gateway ${noFlowAt035.toFixed(3)}`,
  );
}

// ---- the arm comes to rest ON an artifact, never between two -----------------------
// Reported as "when the classifier flow is stopped by the robot, the gate is always in
// between two artifacts. This does not have to be that way." It was not a preference the
// arm had — it had no idea what was under it, and fell straight to 0 THROUGH whatever was
// sitting in the gateway at every offset from +4 to −2.4in.
//
// The paddle's edge descends the vertical at GATE_LINE_S and lands where that meets the
// artifact's surface. WHICH SIDE it landed on is then the whole story once the robot is
// gone: on the downhill face it wedges the artifact, on the uphill face its own weight
// squeezes it out.
{
  /** one artifact parked `d` from the gate line (+ = not through yet), a second a pitch
   * behind, arm descending onto it, no robot anywhere near the lever */
  const settle = (d: number) => {
    const w = mkWorld('match', 'blue', 42);
    startMatch(w);
    w.robots[0].pos = { x: 0, y: -40 };
    for (const b of w.balls) if (b.state.kind === 'ground') b.pos = { x: 900, y: 900 };
    for (let i = 0; i < 2; i++) {
      const b = w.balls[i];
      const s = GATE_LINE_S + d + i * RAIL_PITCH;
      b.state = { kind: 'rail', goal: 'blue', s, v: 0, overflow: false };
      b.pos = railPos('blue', s);
      b.vel = { x: 0, y: 0 };
      b.z = RAMP_SURFACE_Z;
      b.vz = 0;
    }
    const g = w.goals.blue;
    g.gatePos = Math.min(1, gateRestOn(d) + 0.08); // coming down onto it
    g.gateVel = 0;
    g.gateLatch = 0;
    g.gateOpen = g.gatePos >= GATE_PASS_FRAC;
    run(w, cmd({}), 5);
    return { gatePos: g.gatePos, out: w.balls[0].state.kind === 'ground' };
  };

  // the geometry itself: a full diameter dead on top, one radius at the equator, nothing
  // at all beyond the artifact's edge
  check(
    'gateRestOn: dead on top of an artifact seats the arm at GATE_SEAT_FRAC',
    Math.abs(gateRestOn(0) - GATE_SEAT_FRAC) < 1e-9,
    `${gateRestOn(0).toFixed(4)} vs ${GATE_SEAT_FRAC}`,
  );
  // THE ONE THAT MATTERS. Seated on an artifact is the MARGINAL contact — clearance is
  // exactly the ball and no more — so it is not passable, and getting past takes momentum.
  // This was originally set EQUAL to GATE_PASS_FRAC ("a full diameter of clearance is the
  // pass height"), and because the 8.5in gateway window is wider than the 5.1in artifact
  // pitch a packed column always has something under the arm — so merely being under it
  // held the gate permanently passable and a tap drained the entire ramp.
  /**
   * THE PROFILE IS A TANGENCY, and it has a shape the old plunger model did not.
   *
   * A stick hinged off to one side rides highest when the artifact is dead beneath it and
   * falls away toward the edge of its reach — and that reach is decided by the tangency, not
   * by the artifact's radius. At GATE_PIVOT_Z 3.5in it works out SHORTER than a radius, which
   * is what stops a packed column keeping the arm up.
   */
  const profile = [0, 0.5, 1, 1.5, 2].map((d) => gateRestOn(d));
  check(
    'gateRestOn falls monotonically from the apex to nothing at the paddle reach',
    profile.every((v, i) => i === 0 || v < profile[i - 1]) &&
      gateRestOn(GATE_PADDLE_REACH * 0.999) > 0 &&
      gateRestOn(GATE_PADDLE_REACH + 0.01) === 0 &&
      gateRestOn(-GATE_PADDLE_REACH - 1) === 0,
    `d=0..2: ${profile.map((v) => v.toFixed(3)).join(' ')}, reach ${GATE_PADDLE_REACH.toFixed(2)}in`,
  );
  check(
    '...and the reach is the tangency answer, not the artifact radius',
    Math.abs(GATE_PADDLE_REACH - BALL_RADIUS) > 0.1,
    `reach ${GATE_PADDLE_REACH.toFixed(2)}in vs radius ${BALL_RADIUS}in`,
  );

  const wedged = settle(1.2);
  const past = settle(-1.2);
  // It used to WEDGE this one — frozen with the arm perched on it, which is precisely "the
  // gate closed on top of a ball". A hinged arm with its weight on an artifact does not do
  // that; it shoves it back into the classifier and then shuts.
  check(
    'landing on the DOWNHILL face leaves the arm perched on NOTHING',
    wedged.gatePos === 0 || wedged.gatePos >= GATE_PASS_FRAC,
    `gatePos ${wedged.gatePos.toFixed(3)} (perched would be ~${gateRestOn(1.2).toFixed(3)})`,
  );
  check(
    '...and the artifact is shoved back INTO the classifier, not let out',
    !wedged.out,
    `left=${wedged.out}`,
  );
  // ...and the arm shuts behind it. Not necessarily to ZERO: the trailing artifact follows
  // down and the arm comes to rest on THAT, which is the whole point — it lands on what is
  // under it. What must be true is that it is no longer passable.
  check(
    'landing on the UPHILL face squeezes it out and the arm shuts behind it',
    past.out && past.gatePos < GATE_PASS_FRAC,
    `out=${past.out} gatePos ${past.gatePos.toFixed(3)} (pass ${GATE_PASS_FRAC})`,
  );
  // ...and beyond the artifact's edge the paddle genuinely misses: a column packed against
  // a shut gate rests at GATE_STOP_S, one radius clear, and must not hold the arm up at all
  check(
    'a column parked at GATE_STOP_S is clear of the paddle (gate reads fully shut)',
    // ...to within the bisection that solved the reach — 1e-16 is zero for every purpose here
    gateRestOn(GATE_STOP_S - GATE_LINE_S) < 1e-9,
    `d=${(GATE_STOP_S - GATE_LINE_S).toFixed(2)} -> ${gateRestOn(GATE_STOP_S - GATE_LINE_S)}`,
  );
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
  const atRelease = g.gatePos;
  r.pos = { x: 0, y: -30 }; // then drive away immediately (stop pressing)
  run(w, cmd({}), 0.1); // ...and it is still passable a beat later with nothing holding it
  const shortly = g.gatePos;
  run(w, cmd({}), 1); // left alone, gravity finishes bringing it down
  // A tap COMMITS the arm fully open and the driver does not have to keep pressing — but
  // "stays up a beat" is the FALL, not a pin. It used to be latched at maximum lift for
  // GATE_OPEN_LATCH_S (0.5s) with nothing touching it, which a hinged arm cannot do and
  // which is why a tap emptied the whole ramp; the beat is now the ~0.23s gravity needs to
  // bring it from full lift back to the pass line.
  check(
    'a brief tap commits the arm fully open without holding',
    atRelease >= 0.99,
    `gatePos at release ${atRelease.toFixed(3)}`,
  );
  check(
    '...and it is still passable a beat later with nothing holding it up',
    shortly >= GATE_PASS_FRAC && shortly < 1,
    `gatePos ${shortly.toFixed(3)} (pass ${GATE_PASS_FRAC})`,
  );
  check(
    '...but it is NOT pinned there — with no flow under it, it falls shut',
    g.gatePos === 0 && !g.gateOpen,
    `gatePos ${g.gatePos.toFixed(3)}`,
  );
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
function fillBlueRail(w: World, v = 0): void {
  for (let i = 0; i < 9; i++) {
    const b = w.balls[i];
    const s = GATE_STOP_S + i * RAIL_PITCH;
    b.state = { kind: 'rail', goal: 'blue', s, v, overflow: false };
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
  // long enough for an OVERFLOW artifact to clamber the length of the ramp. It rides over the
  // retained column rather than rolling a clear ramp, so it is slower than the ramp lane —
  // the window follows the ride's own physics rather than a number tuned to an older one.
  // Clambering accelerates at RAIL_ACCEL - OVERFLOW_ROLL_LOSS, so the trip takes
  // sqrt(2*s/a); doubled for the lurch over the scallops and the landing at the end.
  run(w, cmd({}), Math.sqrt((2 * RAIL_S_MAX) / (RAIL_ACCEL - OVERFLOW_ROLL_LOSS)) * 2);
  const g = w.goals.blue;
  check(
    '10th ball meeting a full column overflows (1 pt)',
    g.overflowCount === 1 && g.classifiedCount === 0 && w.match.scores.blue.autoOverflow === 1,
    `classified=${g.classifiedCount} overflow=${g.overflowCount}`,
  );
  check('overflow ball rode over the closed gate and exited', w.balls[9].state.kind === 'ground');
}

// ---- a SHUT gate retains the whole column, indefinitely --------------------------
// The suite passed for a whole session while this was broken: the rail solver's two
// constraints (the artifact ahead / the gate) were both made conditional on "was it above
// this last tick", so one artifact dipping a hair below its neighbour fell through the
// entire column and out through a closed gate at terminal speed. Nothing here is subtle —
// it just was not being watched.
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  fillBlueRail(w);
  run(w, cmd({}), 5);
  const onRail = w.balls.filter((b) => b.state.kind === 'rail');
  const ss = onRail.map((b) => (b.state as { s: number }).s).sort((p, q) => p - q);
  check(
    'a closed gate retains all 9 for 5s',
    onRail.length === 9 && !w.goals.blue.gateOpen,
    `onRail=${onRail.length} gateOpen=${w.goals.blue.gateOpen}`,
  );
  check(
    'the retained column rests packed against the gate',
    Math.abs(ss[0] - GATE_STOP_S) < 0.05 &&
      ss.every((s, i) => i === 0 || Math.abs(s - ss[i - 1] - RAIL_PITCH) < 0.05),
    `s=${ss.map((s) => s.toFixed(2)).join(',')}`,
  );
  check(
    'nothing scored while the gate stayed shut',
    w.goals.blue.classifiedCount === 0 && w.goals.blue.overflowCount === 0,
  );
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

// ---- a drain settles ALONG the tunnel, not across the field ---------------------
// Reported twice: artifacts leaving the gate "hyper accelerated... all going diagonally in
// one direction" when they should pile up in front of the gate, along the secret tunnel, or
// in the human player zone. Two causes, both fixed: a doorway nudge that compounded to
// 91 in/s, and a release that set a flat floor velocity on a wide fan. They now roll off the
// GATE_LIP_Z lip and land, so this watches WHERE nine of them come to rest.
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  fillBlueRail(w);
  const ids = w.balls.slice(0, 9).map((b) => b.id);
  const g = w.goals.blue;
  const mouth = railPos('blue', RAIL_EXIT_S);
  for (let i = 0; i < 60 * 12; i++) {
    g.gatePos = 1; // hold it open: this is about the outflow, not the lever
    g.gateOpen = true;
    step(w, SIM_DT, new Map());
  }
  const drained = w.balls.filter((b) => ids.includes(b.id)); // the HP restocks others
  const far = drained.map((b) => hyp(b.pos.x - mouth.x, b.pos.y - mouth.y));
  const offWall = drained.map((b) => FIELD_HALF - Math.abs(b.pos.x));
  // The three places a drain is allowed to end up, in the user's words: in front of the gate,
  // along the secret tunnel, or in the human player zone. That is the WALL CORRIDOR — the
  // tunnel plus the loading zone at the audience corner — not the tunnel alone. (An earlier
  // version of this check bounded it at the tunnel length and failed artifacts that had rolled
  // into the loading zone, which is a destination, not an escape.)
  const corridor = TUNNEL_STRIP_LEN + LOAD_ZONE_SIZE;
  check(
    'a full drain settles in the wall corridor: gate, tunnel, or loading zone',
    drained.every((b) => b.state.kind === 'ground') && Math.max(...far) < corridor,
    `max=${Math.max(...far).toFixed(0)}in corridor=${corridor}in`,
  );
  check(
    'the drain settles ALONG the wall, not out on a diagonal',
    offWall.filter((d) => d < 20).length >= 7,
    `off-wall=${offWall.map((d) => d.toFixed(0)).join(',')}`,
  );
}

// ---- a column in CONTACT shares its momentum -------------------------------------
/**
 * "You just made overflow and coming down the ramp insanely fast, but when you tap the gate
 * open it is still pretty slow. I think the balls higher up don't accelerate much and don't
 * transfer much momentum to the ones below."
 *
 * They accelerated; the exit threw it away. When an artifact met the one ahead, the clamp took
 * the SLOWER of the two and left the one ahead alone — so every contact lost the difference,
 * and because the lane is walked front to back, one slow artifact at the lip pulled the whole
 * column down within a single tick. Measured on a tap: 29 in/s to 17 across five artifacts at
 * once, over and over, as each one reached the gate.
 *
 * Touching artifacts are a perfectly inelastic collision between equal masses, so both end at
 * the mean — the one behind cannot pass (the position clamp is untouched), but the one ahead
 * is pushed ALONG. The exception is a column held against something that cannot move: that is
 * a contact with the FIELD, and sharing into it invents speed the stack can never spend.
 */
{
  const drain = () => {
    const w = mkWorld('match', 'blue', 42);
    startMatch(w);
    w.match.phase = 'teleop';
    for (const b of w.balls) b.state = { kind: 'held', robot: 99 };
    fillBlueRail(w);
    const r = w.robots[0];
    r.pos = { x: -55, y: 1 };
    r.heading = Math.PI;
    r.fieldCentric = false;
    const out: number[] = [];
    const seen = new Set<number>();
    let worstDrop = 0;
    let prev = new Map<number, number>();
    for (let i = 0; i < Math.round(8 / SIM_DT); i++) {
      const push = i * SIM_DT < 0.25;
      step(w, SIM_DT, new Map([[0, cmd({ driveY: push ? 1 : 0, leftDrive: push ? 1 : 0, rightDrive: push ? 1 : 0 })]]));
      const now = new Map<number, number>();
      for (const b of w.balls) {
        if (b.state.kind === 'rail') {
          const v = Math.abs((b.state as { v: number }).v);
          now.set(b.id, v);
          const was = prev.get(b.id);
          // a rolling artifact losing a big chunk of its speed in one tick, with nothing in
          // front of it to hit — that is the contact throwing momentum away
          // as a FRACTION of what it was doing: an equal-mass inelastic contact with a
          // stationary artifact loses exactly half, and nothing may lose more than that
          if (was !== undefined && was > 10 && (was - v) / was > worstDrop) worstDrop = (was - v) / was;
        } else if (prev.has(b.id) && !seen.has(b.id)) {
          seen.add(b.id);
          out.push(i * SIM_DT);
        }
      }
      prev = now;
    }
    const gaps = out.slice(1).map((t, j) => t - out[j]);
    return { rate: gaps.length / gaps.reduce((a, b) => a + b, 0), worstDrop };
  };
  const d = drain();
  check(
    'a tap drains at the pace the column is actually moving',
    d.rate > 5,
    `${d.rate.toFixed(2)} artifacts a second (was 4.53 when each contact discarded the difference, 3.10 before the chute was steepened)`,
  );
  check(
    '...because a contact SHARES the speed rather than discarding it',
    d.worstDrop <= 0.5,
    `worst single-tick loss on a rolling artifact: ${(d.worstDrop * 100).toFixed(0)}% of its speed — an equal-mass inelastic contact with a STOPPED artifact loses exactly half, so half is the ceiling. It used to hand over the whole difference, and to the whole column at once.`,
  );
}

// ---- the basin hands off at the ramp's pace, not at a crawl ------------------------
/**
 * "Basin frequency needs to be like 5 times faster."
 *
 * The entrance was the bottleneck and nothing else was: the next artifact cannot board until
 * the last is a PITCH clear of the top, so the hand-off rate is boarding speed over pitch —
 * and boarding was floored at 8 in/s, which is two a second however hard the funnel pulled.
 * Raising the funnel acceleration bought 3.4/s, widening the catch radius bought nothing at
 * all, and moving the block up bought 0.2. The boarding speed is the whole of it.
 *
 * It is now the ramp's own delivery speed (RAIL_ACCEL / RAIL_RATTLE_DRAG), which keeps the
 * invariant that nothing on the ramp outruns the ramp — an artifact entering at the terminal
 * the ramp converges on is exactly as fast as the ramp's fastest.
 */
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  w.match.phase = 'teleop';
  const entry = basinFunnelTarget('blue');
  const ids: number[] = [];
  let k = 0;
  for (const b of w.balls) {
    if (k < 12) {
      b.state = { kind: 'basin', goal: 'blue' };
      b.pos = { x: entry.x - 6 + (k % 4) * 5.2, y: entry.y + 6 + Math.floor(k / 4) * 5.2 };
      b.vel = { x: 0, y: 0 };
      b.z = BASIN_FLOOR_Z;
      b.vz = 0;
      ids.push(b.id);
    } else b.state = { kind: 'held', robot: 99 };
    k++;
  }
  const boarded: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < Math.round(15 / SIM_DT); i++) {
    w.goals.blue.gatePos = 1;
    w.goals.blue.gateOpen = true;
    w.goals.blue.gateLatch = 1;
    step(w, SIM_DT, new Map());
    for (const b of w.balls) {
      if (ids.includes(b.id) && b.state.kind === 'rail' && !seen.has(b.id)) {
        seen.add(b.id);
        boarded.push(i * SIM_DT);
      }
    }
  }
  const gaps = boarded.slice(1).map((t, j) => t - boarded[j]);
  const rate = gaps.length / gaps.reduce((a, b) => a + b, 0);
  check(
    "a loaded basin feeds the classifier at the ramp's pace, not at a crawl",
    boarded.length === 12 && rate > 4.5,
    `${rate.toFixed(2)} hand-offs/s (was 2.04; the ceiling for a ${RAIL_PITCH}in artifact at the ramp's ${(RAIL_ACCEL / RAIL_RATTLE_DRAG).toFixed(0)}in/s delivery speed is ${((RAIL_ACCEL / RAIL_RATTLE_DRAG) / RAIL_PITCH).toFixed(1)})`,
  );
}

// ---- the ramp has a DELIVERY SPEED, it does not accelerate unopposed ---------------
// "The balls get supercharged and dash down if I gate intake." Nothing was taking anything back
// once the pile outside stopped throttling the discharge, so the last artifacts off a full
// column ran the whole 59in of ramp unopposed and arrived at 69 in/s. RAIL_ACCEL's note is
// right that ROLLING resistance does not grow with speed — but the channel is a 6in groove
// around a 5in artifact, and weaving down it (railWander) works the walls harder the faster it
// goes. That loss does grow with speed, and it is what gives a chute a delivery speed.
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  w.match.phase = 'teleop';
  for (const b of w.balls) if (b.state.kind === 'ground') b.pos = { x: 300, y: 300 };
  fillBlueRail(w);
  w.robots[0].pos = { x: 0, y: -40 };
  const nine = w.balls.slice(0, RAMP_SLOTS);
  const seen = new Set<number>();
  const exits: number[] = [];
  let firstOut = NaN;
  for (let i = 0; i < Math.round(6 / SIM_DT); i++) {
    w.goals.blue.gatePos = 1;
    w.goals.blue.gateOpen = true;
    w.goals.blue.gateLatch = 1;
    step(w, SIM_DT, new Map());
    for (const b of nine) {
      if (b.state.kind === 'rail' || seen.has(b.id)) continue;
      seen.add(b.id);
      exits.push(hyp(b.vel.x, b.vel.y));
      if (Number.isNaN(firstOut)) firstOut = (i + 1) * SIM_DT;
    }
  }
  const terminal = RAIL_ACCEL / RAIL_RATTLE_DRAG;
  check(
    'the ramp delivers at its own speed rather than accelerating the whole way down',
    Math.max(...exits) < terminal,
    `exits ${Math.min(...exits).toFixed(0)}..${Math.max(...exits).toFixed(0)} in/s against a delivery speed of ${terminal.toFixed(0)} (was 24..69 with nothing taking it back)`,
  );
  // ...and the START is untouched, which is the whole point of a drag rather than a cap: an
  // artifact at rest has no speed for it to take, so the first one out is as quick as it was.
  check(
    '...and the first artifact out is no slower for it',
    firstOut < 0.7,
    `first out at ${firstOut.toFixed(2)}s`,
  );
}

// ---- nothing on the ramp outruns the ramp ---------------------------------------
// "Sometimes balls come down the ramp extremely fast. Only sometimes. And way too fast."
// An artifact boarded the rail carrying whatever vel.y the BASIN had given it, and the
// basin's funnel pull is a scripted drain aid (BASIN_FUNNEL_ACCEL, three times gravity, there
// to stop the basin clogging) rather than a slope. Measured over six seeds of a firing robot:
// artifacts boarded at up to 52 in/s and peaked at 75 on the ramp, 12 of 18 of them over
// 60 — against a ramp whose own free-fall ceiling over its whole length is 54. "Sometimes"
// was whether an artifact happened to dive at the entrance or jumble first.
{
  const board: number[] = [];
  const peak: number[] = [];
  for (const seed of [7, 19, 42]) {
    const w = mkWorld('match', 'blue', seed);
    startMatch(w);
    w.match.phase = 'teleop';
    w.robots[0].pos = { x: -20, y: 20 };
    const seen = new Map<number, number>();
    for (let i = 0; i < Math.round(30 / SIM_DT); i++) {
      step(w, SIM_DT, new Map([[0, cmd({ fire: true, intake: true })]]));
      for (const b of w.balls) {
        if (b.state.kind !== 'rail' || b.state.goal !== 'blue') continue;
        const v = Math.abs((b.state as { v: number }).v);
        if (!seen.has(b.id)) board.push(v);
        seen.set(b.id, Math.max(seen.get(b.id) ?? 0, v));
      }
    }
    peak.push(...seen.values());
  }
  // the ONE bound, and it is the ramp's own: nothing on it can be moving faster than
  // something released at the very top of it. A little slack for the tick the paddle shoves.
  const ceiling = Math.sqrt(2 * RAIL_ACCEL * (RAIL_S_MAX - RAIL_EXIT_S));
  check(
    'nothing on the ramp is faster than an artifact released at the top of it',
    peak.length >= 6 && Math.max(...peak) < ceiling * 1.05,
    `peak ${Math.min(...peak).toFixed(0)}..${Math.max(...peak).toFixed(0)} in/s over ${peak.length} artifacts, ramp ceiling ${ceiling.toFixed(0)} (was 75)`,
  );
  check(
    '...because boarding the ramp is capped at what the ramp itself could have given it',
    // + one tick of gravity: the sample is taken after the step that boarded it
    Math.max(...board) <= RAIL_ENTRY_V + RAIL_ACCEL * SIM_DT + 1e-6,
    `boarding ${Math.min(...board).toFixed(0)}..${Math.max(...board).toFixed(0)} in/s (was 8..52)`,
  );
}

// ---- the ramp discharges STRAIGHT DOWN its own line -----------------------------
// "All the balls keep coming out of the gate at the same angle" — the release leaned every
// artifact off the wall by a jittered 5-15 degrees, and because the jitter varied the lean's
// MAGNITUDE and never its SIGN, the whole drain left on one diagonal. The channel runs down
// the wall and an artifact rolls off the END of it, so it leaves in the direction it was
// already going. The only sideways motion it keeps is the weave it was doing across the
// groove (railWanderRate), which is signed and per artifact.
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  w.match.phase = 'teleop';
  fillBlueRail(w);
  w.robots[0].pos = { x: 0, y: -40 };
  const tracked = w.balls.slice(0, 9);
  const seen = new Set<number>();
  const angles: number[] = [];
  for (let i = 0; i < Math.round(12 / SIM_DT); i++) {
    w.goals.blue.gatePos = 1;
    w.goals.blue.gateOpen = true;
    w.goals.blue.gateLatch = 1;
    step(w, SIM_DT, new Map([[0, cmd({})]]));
    for (const b of tracked) {
      if (b.state.kind === 'rail' || seen.has(b.id)) continue;
      seen.add(b.id);
      // the heading it leaves on, in degrees off straight-down-tunnel
      angles.push((Math.atan2(b.vel.x, -b.vel.y) * 180) / Math.PI);
    }
  }
  const worst = Math.max(...angles.map((d) => Math.abs(d)));
  check(
    'artifacts leave the gate straight down the tunnel, not on a lean',
    angles.length >= 7 && worst < 5,
    `${angles.length} out, worst ${worst.toFixed(1)}deg off straight (the fan was 5-15deg)`,
  );
  /**
   * ...AND THERE IS NO LEAN AT ALL NOW. The exit used to hand the artifact its weave across
   * the groove as a lateral velocity, which is honest at 20 in/s and a spray at 40 — the same
   * wander rate times twice the speed. Steepening the chute turned the drift into the "weird
   * angles for no reason" that were reported, so the synthesised component is gone entirely:
   * "the spreading out should be fundamentally from collisions mostly".
   *
   * Which means the spread has to come from somewhere real, and this is where that is
   * checked: they leave on identical headings and still end up in different places, because
   * each one caroms off whatever stopped before it.
   */
  const finals = tracked.filter((b) => b.state.kind === 'ground');
  const spreadY = Math.max(...finals.map((b) => b.pos.y)) - Math.min(...finals.map((b) => b.pos.y));
  // ...and they do NOT end up stacked on one spot: every pair at least a diameter apart is the
  // spread a corridor this narrow can actually show. Lateral room by the wall is a few inches,
  // so it is the DISTANCE each one travels before its own collision stops it that varies.
  const pairs = finals.flatMap((p1, i) => finals.slice(i + 1).map((p2) => hyp(p1.pos.x - p2.pos.x, p1.pos.y - p2.pos.y)));
  check(
    '...and the spread they end up with comes from COLLISIONS, not from a fan at the exit',
    angles.every((d) => Math.abs(d) < 0.05) && spreadY > 20 && Math.min(...pairs) >= BALL_RADIUS * 2 - 0.5,
    `every heading ${angles.map((d) => d.toFixed(1)).join(',')} — and they finish spread over ${spreadY.toFixed(0)}in of tunnel, closest pair ${Math.min(...pairs).toFixed(1)}in`,
  );
}

// ---- artifacts do not JITTER against the classifier --------------------------------
// "They keep teleporting up and down the classifier depending on how I turn the robot."
// An artifact squeezed between a bumper and the channel was resolved by two position
// writes taking turns — the bespoke robot push drove it in, the static eviction shoved it
// back out — and neither could see the other. Slice 2 put the chassis into the ball solve
// so the squeeze is ONE constraint problem. This measures the symptom directly: movement
// in a tick that the artifact's own velocity does not account for.
{
  const w = mkWorld('free', 'blue', 9);
  w.balls.length = 0;
  for (let i = 0; i < 8; i++) {
    w.balls.push({
      id: 900 + i,
      color: 'purple',
      state: { kind: 'ground' },
      pos: { x: 53 + (i % 4) * 5, y: -60 + Math.floor(i / 4) * 5 },
      vel: { x: 0, y: 0 },
      z: 0,
      vz: 0,
    });
  }
  const r = w.robots[0];
  r.pos = { x: 42, y: -78 + 24 };
  r.fieldCentric = false;
  const prev = new Map<number, { x: number; y: number; v: number; k: string }>();
  let jumpFrames = 0;
  let worst = 0;
  for (let i = 0; i < Math.round(8 / SIM_DT); i++) {
    for (const b of w.balls) {
      prev.set(b.id, { x: b.pos.x, y: b.pos.y, v: hyp(b.vel.x, b.vel.y), k: b.state.kind });
    }
    // grind the pile into the classifier corner, turning as it goes
    step(w, SIM_DT, new Map([[r.id, cmd({ driveY: 1, rotate: i % 120 < 60 ? 0.4 : -0.4 })]]));
    for (const b of w.balls) {
      const p = prev.get(b.id);
      if (!p || p.k !== 'ground' || b.state.kind !== 'ground') continue;
      const unexplained = hyp(b.pos.x - p.x, b.pos.y - p.y) / SIM_DT - p.v;
      if (unexplained > 60) jumpFrames++; // 60 in/s-equiv = 1in in a single tick
      worst = Math.max(worst, unexplained);
    }
  }
  // Baseline before slice 2 was 41 jump-frames and 2.88in worst; after, 4 and 1.84in. The
  // bound is deliberately loose — it guards the ORDER of magnitude, not the exact solver
  // output, which legitimately shifts when contact tuning changes. It shifted again when the
  // align ceiling came down (CONTACT_ALIGN_RATE_MAX 0.12 -> 0.05, "way too fast"): a robot
  // that squares up more slowly grinds at an angle for longer, so it is 16 rather than 4.
  check(
    'artifacts do not jitter against the classifier when a robot grinds a pile in',
    jumpFrames <= 20 && worst < 2.5 / SIM_DT,
    `${jumpFrames} jump-frames of ${Math.round(8 / SIM_DT)}, worst ${(worst * SIM_DT).toFixed(2)}in in one tick`,
  );
}

// ---- nothing sinks into a chassis, corners included ------------------------------
/**
 * "Balls go thru the chassis still."
 *
 * Two holes, both at the same feature. `ballRobotContact` dealt with the chassis only while
 * an artifact was BEHIND the front face plane (`local.x <= hl`); a hair forward of it the
 * chassis stopped existing and, outboard of the frame, so did everything else — so an
 * artifact sitting on a front corner met nothing at all. And where a wall was behind it, the
 * eviction that should have pushed it out was refused by the wall clamp and kept only the
 * part along the wall, which does not separate anything.
 *
 * The union of chassis and intake is one body with a straight side running back to front, so
 * the closest feature outboard of it is that SIDE (not the chassis's corner, which is
 * interior to the union — treating it as a corner makes the correction flip between a
 * diagonal and the rail's sideways push, and that jitters). And a push the field refuses is
 * refused whole: the artifact either finds a way out sideways within BALL_ESCAPE_REACH, or it
 * stays where it is.
 *
 * Swept by driving back and forth through a field of loose artifacts, worst overlap per
 * intake: 2.33 / 2.19 / 0.43in before, 0.90 / 1.42 / 0.44 after, and never a centre inside.
 */
{
  const grind = (intake: 'vector' | 'sloped' | 'triangle', spin: number) => {
    const w = mkWorld('match', 'blue', 7, { intake });
    startMatch(w);
    w.match.phase = 'teleop';
    const r = w.robots[0];
    r.pos = { x: -30, y: 0 };
    r.heading = 0;
    r.fieldCentric = false;
    r.hopper = ['green', 'green', 'green']; // full, so this is about collision and not capture
    let k = 0;
    for (const b of w.balls) {
      if (b.state.kind === 'held') continue;
      b.state = { kind: 'ground' };
      b.pos = { x: -20 + (k % 8) * 5, y: -14 + Math.floor(k / 8) * 7 };
      b.vel = { x: 0, y: 0 };
      b.z = 0;
      b.vz = 0;
      k++;
    }
    let worst = -Infinity;
    let insideTicks = 0;
    for (let i = 0; i < Math.round(12 / SIM_DT); i++) {
      const fwd = Math.sin(i * SIM_DT * 1.2) > 0 ? 1 : -1;
      step(w, SIM_DT, new Map([[0, cmd({ driveY: fwd, leftDrive: fwd, rightDrive: fwd, rotate: spin })]]));
      for (const b of w.balls) {
        if (b.state.kind !== 'ground') continue;
        const d = pointDepthInChassis(r, b.pos);
        worst = Math.max(worst, d);
        if (d > 0) insideTicks++;
      }
    }
    return { overlap: BALL_RADIUS + worst, insideTicks };
  };
  const runs = [
    grind('vector', 0),
    grind('sloped', 0),
    grind('triangle', 0),
    grind('vector', 1),
  ];
  check(
    'artifacts do not sink into a chassis when a robot grinds through them',
    runs.every((x) => x.overlap < 2.35),
    `worst overlap per run: ${runs.map((x) => x.overlap.toFixed(2)).join(' / ')}in on a ${BALL_RADIUS}in radius (2.33 / 2.19 / 0.43 / 1.23 before). The bound is not tighter because the JAM rule deliberately leaves a wedged artifact where it is rather than advancing it — a jam reads as a jam, and being stuck against a robot is how it looks.`,
  );
  check(
    '...and no artifact centre is ever inside one',
    runs.every((x) => x.insideTicks === 0),
    `${runs.map((x) => x.insideTicks).join('/')} artifact-ticks with the centre inside the chassis`,
  );
}

// ---- nothing on the rail hangs in the air, and nothing runs off the end of it --------
/**
 * "They're all floating." "Still floating by."
 *
 * Two ways an artifact ended up somewhere the rail does not go, both of them at the exit:
 *
 *  · HELD UP BY A ROOF THE COLUMN DID NOT SEE. The descent floors an artifact's height on any
 *    intake beneath it, so it is set down ON an intake rather than through it. That test and
 *    `railBlock`'s asked the same question with different tolerances, at different points, and
 *    over different stretches of rail — so the column would descend past the channel mouth
 *    while the height test held it at lid height, leaving it hanging over open apron with
 *    nothing under it either pass agreed was there: measured s = -2.5 at z = 10.3.
 *  · NO FLOOR AT ALL BELOW THE LIP. `exitFloor` was -Infinity whenever the way out LOOKED
 *    clear, but the release also waits on the doorway and on its own one-per-tick budget, and
 *    while it waited the column had nothing under it: measured five artifacts at s = -290,
 *    hundreds of inches off the end of the world, sliding through robots and walls alike
 *    because a rail artifact is in neither solve.
 *
 * So the two roof tests are now one question, asked at one point, over the stretch the block
 * actually walks; and the rail has a floor a pitch below its lip, which is enough to slide out
 * through and not enough to leave on.
 */
{
  const worst = { air: 0, run: 0 };
  for (const over of [0, -1, -2, -3.5]) {
    const w = mkWorld('match', 'blue', 42);
    startMatch(w);
    w.match.phase = 'teleop';
    for (const b of w.balls) b.state = { kind: 'held', robot: 99 };
    fillBlueRail(w);
    const r = w.robots[0];
    const exit = railPos('blue', RAIL_EXIT_S);
    const tip = DEFAULT_SPEC.length / 2 + INTAKE_PRESETS[DEFAULT_SPEC.intake].reach;
    r.heading = Math.PI / 2;
    r.fieldCentric = false;
    r.hopper = [];
    const park = { x: exit.x, y: exit.y - tip + over };
    for (let i = 0; i < Math.round(10 / SIM_DT); i++) {
      r.pos = { ...park };
      r.vel = { x: 0, y: 0 };
      w.goals.blue.gatePos = 1;
      w.goals.blue.gateOpen = true;
      w.goals.blue.gateLatch = 1;
      step(w, SIM_DT, new Map([[0, cmd({ intake: true })]]));
      for (const b of w.balls) {
        if (b.state.kind !== 'rail') continue;
        const st = b.state as { s: number; v: number };
        // past the channel mouth there is no ramp: an artifact that has STOPPED there is
        // either on the floor or it is hanging in mid-air
        if (st.s < RAIL_OPEN_S && Math.abs(st.v) < 1) worst.air = Math.max(worst.air, b.z);
        worst.run = Math.max(worst.run, RAIL_EXIT_S - st.s);
      }
    }
  }
  check(
    'nothing on the rail comes to rest in mid-air past the channel mouth',
    worst.air < 1,
    `worst resting height below the mouth: ${worst.air.toFixed(1)}in (was 10.3 — held on an intake lid the column did not know about)`,
  );
  check(
    '...and nothing slides off the end of the rail',
    worst.run <= RAIL_PITCH + 0.5,
    `furthest past the exit lip: ${worst.run.toFixed(1)}in against a ${RAIL_PITCH.toFixed(1)}in leak (was 290in — off the map, through everything)`,
  );
}

// ---- every DECODE preset loads robot-centric --------------------------------------
/**
 * "All DECODE robot presets should be robot centric."
 *
 * The presets are real team BUILDS and a real FTC team drives robot-centric; field-centric is
 * the rarity. None of them carried assists, so each one picked up the player default (all on,
 * field-centric included) and choosing a build silently chose a drive frame with it.
 *
 * Only the frame is pinned — the rest is still the player default, and the menu toggle still
 * works, which is what the second half of this checks.
 */
{
  check(
    'every DECODE preset loads ROBOT-centric',
    ROBOT_PRESETS.every((p) => p.assists?.fieldCentric === false),
    `${ROBOT_PRESETS.filter((p) => p.assists?.fieldCentric === false).length} of ${ROBOT_PRESETS.length}: ${ROBOT_PRESETS.map((p) => p.name).join(', ')}`,
  );
  check(
    "...and pins nothing else — the rest is the player's own default",
    ROBOT_PRESETS.every(
      (p) =>
        p.assists?.aimAssist === PLAYER_ASSISTS.aimAssist &&
        p.assists?.autoIntake === PLAYER_ASSISTS.autoIntake &&
        p.assists?.autoFire === PLAYER_ASSISTS.autoFire,
    ),
    'aim / auto-intake / auto-fire match PLAYER_ASSISTS',
  );
  // ...and it survives the coercer every load path runs through
  const loaded = coerceSpec({ ...ROBOT_PRESETS[0] }, undefined, 'decode');
  check(
    '...and coerceSpec keeps the frame the preset asked for',
    loaded.assists?.fieldCentric === false,
    `fieldCentric=${loaded.assists?.fieldCentric}`,
  );
}

// ---- turning carries the velocity round with the chassis --------------------------
/**
 * "When I drive straight and turn with tank, I feel like I get shifted slightly in a weird
 * way. This might be from centripetal force or the lack of it. Tank does not slide much
 * because of its very grippy treads."
 *
 * The lack of it, exactly. Velocity is integrated in the WORLD frame and the heading was
 * turned out from under it, so every drivetrain side-slipped through every turn and the motor
 * model then dragged the leftover lateral component away over the following ticks. Turning
 * while moving needs a lateral force of m·v·ω, and the wheels supply it up to their own
 * traction limit — so the velocity bends round with the nose as far as they can carry it, and
 * slides the rest. That ceiling is the drivetrain's own (LATERAL_GRIP × its traction accel):
 * treads scrub sideways harder than they drive forward, omni rollers hardly at all.
 *
 * Measured as the fraction of the velocity that is SIDEWAYS in the robot's own frame, over a
 * turn taken at speed.
 */
{
  const slip = (drivetrain: DrivetrainType) => {
    const w = mkWorld('match', 'blue', 5, { drivetrain });
    startMatch(w);
    w.match.phase = 'teleop';
    const r = w.robots[0];
    r.pos = { x: -40, y: -40 };
    r.heading = 0;
    r.fieldCentric = false;
    let peak = 0;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < Math.round(1.8 / SIM_DT); i++) {
      const turning = i * SIM_DT > 0.8;
      const c =
        drivetrain === 'tank'
          ? cmd({ leftDrive: 1, rightDrive: turning ? 0.35 : 1 })
          : cmd({ driveY: 1, rotate: turning ? 0.6 : 0 });
      step(w, SIM_DT, new Map([[0, c]]));
      if (!turning) continue;
      const vr = rot(r.vel, -r.heading);
      const speed = hyp(vr.x, vr.y);
      if (speed < 15) continue; // only while actually moving
      const f = Math.abs(vr.y) / speed;
      peak = Math.max(peak, f);
      sum += f;
      n++;
    }
    return { peak, mean: sum / Math.max(n, 1) };
  };
  const tank = slip('tank');
  const mec = slip('mecanum');
  const x = slip('xdrive');
  check(
    'a TANK barely side-slips through a turn — its treads carry the velocity round',
    tank.mean < 0.01 && tank.peak < 0.05,
    `mean ${(tank.mean * 100).toFixed(1)}% of its velocity sideways, peak ${(tank.peak * 100).toFixed(1)}% (5.2% and 8.1% before the velocity turned with the chassis)`,
  );
  check(
    '...and the ones that CAN slide sideways still do, in the right order',
    mec.mean > tank.mean && x.mean > mec.mean,
    `tank ${(tank.mean * 100).toFixed(1)}% < mecanum ${(mec.mean * 100).toFixed(1)}% < x-drive ${(x.mean * 100).toFixed(1)}% — treads, then rollers, then omnis`,
  );
}

// ---- a focused text field owns the keyboard ---------------------------------------
/**
 * "I can't type properly in the report a player menu because some keys are counted as game
 * control."
 *
 * The game listens on `window`, so every keystroke on the page reached the robot — including
 * the ones going into the post-match report's "what happened" box. Letters bound to actions
 * fired those actions while you typed, and SPACE, which is permanently in `preventKeys` so
 * the page cannot scroll under a driver, had its default suppressed and so did not type a
 * space at all.
 *
 * `Keyboard` is DOM-facing, so this drives it with synthetic events rather than importing a
 * scene: a fake target for each case, the real handler, and the question of whether the key
 * reached the robot.
 */
{
  const kb = new Keyboard();
  const fake = (tag: string, extra: Record<string, unknown> = {}) => ({
    tagName: tag,
    isContentEditable: false,
    ...extra,
  });
  // the private handler is reached the way the browser reaches it: through attach()
  const events: { target: unknown; key: string }[] = [];
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const realWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    addEventListener: (t: string, fn: (e: unknown) => void) => {
      (listeners[t] ??= []).push(fn);
    },
    removeEventListener: () => {},
  };
  kb.attach();
  (globalThis as { window?: unknown }).window = realWindow;
  const send = (type: string, key: string, target: unknown, prevented: { hit: boolean }) => {
    for (const fn of listeners[type] ?? []) {
      fn({ key, target, repeat: false, preventDefault: () => { prevented.hit = true; } });
    }
  };
  const canvas = fake('CANVAS');
  let p = { hit: false };
  send('keydown', 'w', canvas, p);
  check(
    'a keystroke on the FIELD still drives the robot',
    kb.held('w'),
    'w on the canvas is held',
  );
  send('keyup', 'w', canvas, p);
  for (const [what, target] of [
    ['a textarea', fake('TEXTAREA')],
    ['a text input', fake('INPUT', { type: 'text' })],
    ['a contenteditable', fake('DIV', { isContentEditable: true })],
  ] as [string, unknown][]) {
    p = { hit: false };
    send('keydown', 'w', target, p);
    send('keydown', ' ', target, p);
    check(
      `...and one typed into ${what} does not, nor is its default suppressed`,
      !kb.held('w') && !kb.held(' ') && !kb.justPressed(' ') && !p.hit,
      `held(w)=${kb.held('w')} held(space)=${kb.held(' ')} preventDefault=${p.hit}`,
    );
  }
  // a BUTTON is not typing — a driver tabbing onto a HUD control can still drive
  p = { hit: false };
  send('keydown', 'w', fake('BUTTON'), p);
  check('...but a BUTTON is not a text field, so the robot still answers', kb.held('w'), 'w held');
  send('keyup', 'w', fake('BUTTON'), p);
  // clicking into a field mid-drive releases what was held
  send('keydown', 'w', canvas, p);
  for (const fn of listeners.focusin ?? []) fn({ target: fake('TEXTAREA') });
  check(
    '...and focusing one mid-drive lets go of the keys, rather than pinning the robot',
    !kb.held('w'),
    `held(w)=${kb.held('w')}`,
  );
}

// ---- THE RAIL IS NOT A HOLE IN THE FIELD ----------------------------------------
// An artifact walked off the end of the world: in `rail` state, position written straight
// down the rail line, from y=-64.9 to y=-75.6 — six inches outside the audience wall —
// where it was finally released and the ground clamp snapped it back in as a 394 in/s
// teleport ("they go past the field wall then teleport back in"). The rail is a scripted
// 1D flow with no wall awareness, so nothing about being off the field stops it; the
// invariant has to be that it is never down there. It got there because the solver and the
// release disagreed: an open gate dropped the floor to -Infinity while the release refused
// on an occupied doorway, and the `wasS >= base` exemption then freed it permanently.
{
  const w = mkWorld('match', 'red', 11);
  startMatch(w);
  w.balls.length = 0;
  // 9 retained + 2 overflow. NOT more: the channel is RAIL_S_MAX long and stacking past it
  // puts the top artifact through the far wall — a fixture bug, not a sim one.
  const staged = Math.min(11, Math.floor((RAIL_S_MAX - GATE_STOP_S) / RAIL_PITCH) + 1);
  for (let i = 0; i < staged; i++) {
    const s0 = GATE_STOP_S + i * RAIL_PITCH;
    w.balls.push({
      id: 900 + i,
      color: 'purple',
      state: { kind: 'rail', goal: 'red', s: s0, v: 0, overflow: i >= 9, pending: false },
      pos: railPos('red', s0),
      vel: { x: 0, y: 0 },
      z: i >= 9 ? OVERFLOW_Z : RAMP_SURFACE_Z,
      vz: 0,
    });
  }
  const r = w.robots[0];
  r.pos = { x: 60, y: -10 };
  r.fieldCentric = false;
  let oobFrames = 0;
  let worstOob = 0;
  let oobKind = '';
  let belowExit = 0;
  for (let i = 0; i < Math.round(14 / SIM_DT); i++) {
    // drive at the gate, grind along the wall, back off spinning — the reported scenario
    const ph = i % 240;
    const c =
      ph < 90
        ? cmd({ driveY: 1 })
        : ph < 150
          ? cmd({ driveX: ph % 2 ? 1 : -1, driveY: 0.6 })
          : ph < 190
            ? cmd({ driveY: -1, rotate: 0.7 })
            : cmd({ driveY: 1, rotate: -0.5, intake: true });
    step(w, SIM_DT, new Map([[r.id, c]]));
    for (const b of w.balls) {
      if (b.state.kind === 'rail' && b.state.s < RAIL_EXIT_S - 0.01) belowExit++;
      if (b.state.kind === 'stock' || b.state.kind === 'held') continue;
      const out = Math.max(Math.abs(b.pos.x), Math.abs(b.pos.y)) - (FIELD_HALF - BALL_RADIUS);
      if (out > 0.01) {
        oobFrames++;
        if (out > worstOob) { worstOob = out; oobKind = `${b.state.kind} at (${b.pos.x.toFixed(1)}, ${b.pos.y.toFixed(1)})`; }
      }
    }
  }
  check(
    'no artifact is ever drawn outside the field wall',
    oobFrames === 0,
    `${oobFrames} ball-frames out, worst ${worstOob.toFixed(2)}in — ${oobKind}`,
  );
  check(
    'no artifact rides the rail below the exit (that is off the field)',
    belowExit === 0,
    `${belowExit} ball-frames below RAIL_EXIT_S`,
  );
}

// ---- a FULL classifier tapped mostly drains, but not always ------------------------
// The clarification behind the "closes up too quickly" complaint: it was about a FULL
// classifier being tapped. A packed column is its own momentum — every artifact arrives before
// the arm can fall past the pass line — so the flow carries it and the tap empties the ramp.
// That is the case that must NOT peter out. But "full" is not a guarantee either ("full
// shouldnt drain all always"): the run-up and how briefly the arm was struck still decide it,
// so a firm tap on a packed ramp usually empties it and sometimes gives out partway.
{
  const yields: number[] = [];
  for (const tapS of [0.15, 0.3, 0.5]) {
    for (const standoff of [4, 7, 11]) {
      const w = mkWorld('match', 'blue', 42);
      startMatch(w);
      fillBlueRail(w); // PACKED at RAIL_PITCH — a full classifier
      const r = w.robots[0];
      const z = gateZone('blue');
      r.pos = { x: z.x1 + standoff, y: (z.y0 + z.y1) / 2 };
      r.heading = Math.PI;
      r.fieldCentric = false;
      r.vel = { x: 0, y: 0 };
      run(w, cmd({ driveY: 1 }), tapS);
      r.pos = { x: 0, y: -30 };
      run(w, cmd({}), 12);
      yields.push(9 - w.balls.filter((b) => b.state.kind === 'rail' && b.state.goal === 'blue').length);
    }
  }
  /**
   * ...AND ONE OF THESE NINE IS NOW A DIFFERENT SCENARIO. At the closest standoff the robot's
   * INTAKE ends up over the outflow, and an intake occupying the space an artifact is set
   * down into holds the drain shut (see `railBlock`'s roof test, and the check below). Held
   * there for the length of the tap, the arm's fall runs while nothing can leave, and that
   * one condition drops from 9 to 3 — which is the rule working, not the tap failing.
   *
   * So this counts against 4 rather than half: a firm tap on a packed ramp usually empties
   * it, and the ways it does not are both real — parking on your own outflow, and a short
   * tap that leaves the flow too slow to keep knocking the arm up.
   */
  const mostly = yields.filter((y) => y >= 7).length;
  check(
    'a tap on a FULL classifier usually drains most of it',
    mostly >= 4,
    `${mostly} of ${yields.length} taps drained 7+: ${yields.join(',')}`,
  );
  /**
   * ...AND IT DRAINS ALL OF IT NOW, which is a change and not a drift. A steeper chute
   * ("balls come down at a slightly too slow frequency") makes the stream dense enough to
   * keep knocking the arm up, so a tap that reaches the lever carries the whole ramp. The
   * conditions that used to give out part way — a short tap, a loose column — no longer do;
   * the note on the tap-gradient check above says what to turn to bring that back.
   */
  check(
    '...and it drains ALL of it: the stream holds the arm up',
    yields.every((y) => y >= 7),
    `${new Set(yields).size} distinct yields, best ${Math.max(...yields)}, worst ${Math.min(...yields)}`,
  );
  // The worst case is a SHORT tap from a long run-up, and it is not a weak tap — the arm still
  // commits to fully open (measured peak 1.00). It gives little because the column is starting
  // from REST: the robot leaves, the arm falls back through the passable height, and the first
  // artifact is still accelerating and arrives too late to knock it up. Same race, decided the
  // other way.
}

// ---- with nothing coming down, the arm shuts briskly -------------------------------
// "the gate should close faster with no momentum going in". There is no longer a constant that
// makes a flowing gateway close slowly — gravity is the same either way. The difference is
// entirely that a flowing gateway keeps knocking the arm back up, so it has to fall the same
// height several times over before it finally gets below the passable line.
{
  const shutTime = (withFlow: boolean): number => {
    const w = mkWorld('match', 'blue', 42);
    startMatch(w);
    for (const b of w.balls) if (b.state.kind === 'ground') b.pos = { x: 900, y: 900 };
    if (withFlow) fillBlueRail(w, -RAIL_TERMINAL);
    const g = w.goals.blue;
    g.gatePos = 1;
    g.gateOpen = true;
    g.gateLatch = 0;
    g.gateVel = 0;
    w.robots[0].pos = { x: 0, y: -40 };
    for (let i = 0; i < Math.round(6 / SIM_DT); i++) {
      step(w, SIM_DT, new Map());
      if (g.gatePos <= 0) return i * SIM_DT;
    }
    return Infinity;
  };
  const empty = shutTime(false);
  const flowing = shutTime(true);
  check(
    'an empty gateway lets the arm shut faster than a flowing one does',
    flowing > empty * 1.4,
    `empty ${empty.toFixed(2)}s vs flowing ${flowing.toFixed(2)}s (${(flowing / empty).toFixed(1)}x)`,
  );
}

// ---- artifacts accelerate the whole way down, they do not flow at one speed --------
// "the balls shouldn't be rolling down with constant speed". RAIL_ACCEL was 80 in/s^2 (a
// 17-degree ramp) and RAIL_TERMINAL capped the result at 30 in/s after 5.6in — barely one
// artifact spacing — so every artifact hit the cap before reaching the gate and the whole
// column moved at one speed. Rolling resistance does not grow with speed, so there is no
// terminal velocity to reach: how fast an artifact is going depends on how far it has come.
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  fillBlueRail(w);
  w.robots[0].pos = { x: 0, y: -40 };
  const g = w.goals.blue;
  const lastV = new Map<number, number>();
  const arrivals: number[] = [];
  const gone = new Set<number>();
  const outAt: number[] = [];
  for (let i = 0; i < Math.round(10 / SIM_DT); i++) {
    g.gatePos = 1;
    g.gateOpen = true;
    g.gateLatch = 1; // held wide open: this is about the RAMP, not the gate
    step(w, SIM_DT, new Map());
    for (const b of w.balls) {
      if (b.state.kind === 'rail' && b.state.goal === 'blue') {
        lastV.set(b.id, -(b.state as { v: number }).v);
      } else if (lastV.has(b.id) && !gone.has(b.id)) {
        gone.add(b.id);
        arrivals.push(lastV.get(b.id)!);
        outAt.push(i * SIM_DT);
      }
    }
  }
  const first = arrivals[0];
  const last = arrivals[arrivals.length - 1];
  check(
    'each artifact reaches the gate faster than the one in front of it',
    arrivals.length >= 8 && last > first * 1.7,
    `arrivals: ${arrivals.map((v) => v.toFixed(0)).join(' ')} in/s (the ratio is 1.7 rather than 2 because a steeper chute reaches the delivery speed sooner, so the last few converge)`,
  );
  // ...and the visible consequence: the ramp speeds up as it empties.
  const gaps = outAt.slice(1).map((t, k) => t - outAt[k]);
  check(
    '...so the gaps between them shorten as the column drains',
    gaps[gaps.length - 1] < gaps[0] * 0.75,
    `first gap ${gaps[0].toFixed(2)}s, last ${gaps[gaps.length - 1].toFixed(2)}s`,
  );
  check(
    'and nothing on the ramp ever reaches RAIL_TERMINAL, which is only a safety cap',
    last < RAIL_TERMINAL * 0.6,
    `fastest arrival ${last.toFixed(0)} in/s against a ${RAIL_TERMINAL} in/s cap`,
  );
}

// ---- an arriving artifact knocks the arm back UP -----------------------------------
// Stated mechanism: "the gate opens fully, then closes slightly until the momentum of the next
// ball forces it back open a certain amount... the momentum of the next ball is not enough to
// force it back open if the gate is already closed too much". The arm BOBS. It used to be able
// to come to rest on something but never be LIFTED by it, so a tap was a plain timed fall and
// the yield came out bimodal — the whole ramp, or almost none of it.
{
  // 1) THE HEIGHT TRACKS THE SPEED. A brisker artifact knocks the arm higher; that IS the
  //    momentum term. It has to be measured with a SINGLE artifact passing under a
  //    part-closed arm — feed it a slow COLUMN instead and the artifacts simply stack up and
  //    hold the arm at their own surface height, which is the geometric term, and both speeds
  //    then report the same number for a reason that has nothing to do with momentum.
  const knockTo = (speed: number, startPos = GATE_RIDE_FRAC): number => {
    const w = mkWorld('match', 'blue', 42);
    startMatch(w);
    for (const b of w.balls) if (b.state.kind === 'ground') b.pos = { x: 900, y: 900 };
    const b0 = w.balls[0];
    const s0 = GATE_LINE_S + BALL_RADIUS + 0.4; // just above the paddle: arrives immediately
    b0.state = { kind: 'rail', goal: 'blue', s: s0, v: -speed, overflow: false, pending: false };
    b0.pos = railPos('blue', s0);
    b0.vel = { x: 0, y: 0 };
    b0.z = RAMP_SURFACE_Z;
    b0.vz = 0;
    const g = w.goals.blue;
    // Comfortably above the pass line, not sitting on it: gravity is undamped now, so an arm
    // started a hair above GATE_PASS_FRAC drops below it within a couple of ticks and the
    // artifact arrives to find nothing it can get under — which measures the engagement rule,
    // not the impulse this check is about.
    g.gatePos = startPos;
    g.gateOpen = true;
    g.gateLatch = 0;
    g.gateVel = 0;
    w.robots[0].pos = { x: 0, y: -40 };
    let peak = g.gatePos;
    for (let i = 0; i < 40; i++) {
      step(w, SIM_DT, new Map());
      peak = Math.max(peak, g.gatePos);
    }
    return peak;
  };
  /**
   * ...measured on a SAGGING arm, which is the only place the impulse is legible.
   *
   * A real ramp arrival (18-45 in/s) throws an arm at GATE_RIDE_FRAC straight to fully open,
   * so comparing two of them there asks about two speeds that both saturate and reports the
   * same 1.00 twice. The mechanism lives at the bottom of the swing: an arm that has sagged
   * to where a passing artifact's own surface would hold it (gateRestOn at first contact) is
   * exactly the arm a drain is deciding the fate of.
   */
  // an arm that has sagged BELOW the pass line but is still high enough for an artifact to
  // reach the paddle at all — below gateStopS's block the artifact never gets there, and the
  // pair (gateStopS/gateRestOn) simply parks: the arm settles at exactly the height the
  // artifact it stopped holds it at, and neither moves again.
  const SAG = (GATE_SEAT_FRAC + GATE_PASS_FRAC) / 2 - 0.06;
  const falter = knockTo(5, SAG);
  const steady = knockTo(10, SAG);
  const brisk = knockTo(18, SAG);
  check(
    'a brisker artifact knocks the arm higher than a faltering one',
    // margins are small because the arm's gravity is derived from the ramp's pace and the ramp
    // is brisk — what matters is that the ORDER is strict, not that the gaps are wide
    brisk > steady + 0.01 && steady > falter + 0.01,
    `from ${SAG.toFixed(2)}: 5 in/s -> ${falter.toFixed(2)}, 10 -> ${steady.toFixed(2)}, 18 -> ${brisk.toFixed(2)}`,
  );
  // ...and THAT is what a tap is worth: the artifact coming out lifts the arm back over the
  // pass line, or it does not and the drain ends there. Reported as "a tap only lets out one
  // ball now, because a ball coming out is not lifting the gate back up".
  check(
    '...and a brisk one lifts a sagging arm back over the pass line, a faltering one does not',
    brisk > GATE_PASS_FRAC && falter < GATE_PASS_FRAC,
    `brisk ${brisk.toFixed(2)} vs pass ${GATE_PASS_FRAC}, faltering ${falter.toFixed(2)}`,
  );

  // 2) AND IT REALLY GOES BACK UP. The arm dips into the gap between two artifacts and the
  //    next one lifts it again — only observable while it is still above the pass line, which
  //    is exactly the condition stated for the lift being possible at all.
  let rises = 0;
  for (const spacing of [0, 2, 4, 6]) {
    const w = mkWorld('match', 'blue', 42);
    startMatch(w);
    for (const b of w.balls) if (b.state.kind === 'ground') b.pos = { x: 900, y: 900 };
    for (let i = 0; i < 9; i++) {
      const b = w.balls[i];
      const cs = GATE_STOP_S + i * (RAIL_PITCH + spacing);
      b.state = { kind: 'rail', goal: 'blue', s: cs, v: -RAIL_TERMINAL, overflow: false, pending: false };
      b.pos = railPos('blue', cs);
      b.vel = { x: 0, y: 0 };
      b.z = RAMP_SURFACE_Z;
      b.vz = 0;
    }
    const g = w.goals.blue;
    g.gatePos = 1;
    g.gateOpen = true;
    g.gateLatch = 0;
    g.gateVel = 0;
    w.robots[0].pos = { x: 0, y: -40 };
    let prev = g.gatePos;
    for (let i = 0; i < Math.round(8 / SIM_DT); i++) {
      step(w, SIM_DT, new Map());
      if (g.gateLatch <= 0 && g.gatePos > prev + 1e-6) rises++;
      prev = g.gatePos;
    }
  }
  check(
    'a released arm is knocked back up by the artifacts passing under it',
    rises > 0,
    `${rises} tick(s) where the arm rose with nobody touching it`,
  );
}

// ---- the arm comes down on a stalled column, and rests on a robot rather than shoving --
// Two rules that meet here. "when i gate intake and the ball flow is stalled ... the gate
// should be closing but its not" — touch-hold tested the INTAKE-EXTENDED footprint, so the
// open mouth re-armed the latch every tick and pinned the arm fully open; holding the arm is
// done with a front CORNER, which is bumper, so touch-hold is the chassis.
//
// And "my robot is getting pushed back by the gate" — the handle's reach GROWS as it closes
// (a lever swinging down is a bar getting longer from above), and it is a static in the robot
// solve, so it shoved a parked robot 3.85in head-on and 6.68in at an angle. The arm is the
// light thing: it comes to rest ON a robot in its swing, exactly as it does on an artifact.
//
// So the arm still comes down whenever it is free to, and where a robot is in the way it stops
// on the robot instead of moving it.
{
  const rests: number[] = [];
  let worstShove = 0;
  for (const y0 of [-12, -10, -8, -6]) {
    for (const headDeg of [19, 45, 70]) {
      const w = mkWorld('match', 'red', 5, { intake: 'vector', width: 17.5, length: 14.5 });
      startMatch(w);
      w.match.phase = 'teleop';
      for (const b of w.balls) {
        b.state = { kind: 'ground' };
        b.pos = { x: -40, y: -60 };
        b.vel = { x: 0, y: 0 };
        b.z = 0;
        b.vz = 0;
      }
      // a STALLED column, parked so the arm sits in the gap between two artifacts
      for (let i = 0; i < 9; i++) {
        const b = w.balls[i];
        const cs = GATE_LINE_S + BALL_RADIUS + 0.6 + i * RAIL_PITCH;
        b.state = { kind: 'rail', goal: 'red', s: cs, v: 0, overflow: false, pending: false };
        b.pos = railPos('red', cs);
        b.vel = { x: 0, y: 0 };
        b.z = RAMP_SURFACE_Z;
        b.vz = 0;
      }
      const r = w.robots[0];
      r.pos = { x: 57.3, y: y0 };
      r.heading = (headDeg * Math.PI) / 180;
      r.hopper = ['green', 'green', 'green'];
      r.fieldCentric = false;
      r.vel = { x: 0, y: 0 };
      const g = w.goals.red;
      g.gatePos = 1;
      g.gateOpen = true;
      g.gateLatch = GATE_OPEN_LATCH_S;
      // let it settle against the field first, so spawn overlap is not read as gate shove
      for (let i = 0; i < 40; i++) {
        g.gatePos = 1;
        g.gateLatch = GATE_OPEN_LATCH_S;
        step(w, SIM_DT, new Map([[0, cmd({ intake: true })]]));
      }
      const x0 = r.pos.x;
      for (let i = 0; i < Math.round(4 / SIM_DT); i++) {
        step(w, SIM_DT, new Map([[0, cmd({ intake: true })]]));
        worstShove = Math.max(worstShove, x0 - r.pos.x);
      }
      rests.push(g.gatePos);
    }
  }
  check(
    'the arm comes down on a stalled column when it is free to',
    rests.some((p) => p < GATE_PASS_FRAC),
    `resting gatePos across poses: ${rests.map((p) => p.toFixed(2)).join(' ')}`,
  );
  check(
    '...and never shoves the robot to get there — it rests on it instead',
    // an inch and a half, not one: the arm SQUARES a robot leaning on it now, and squaring at
    // the arm's own (deliberately slow) rate keeps the contact alive for about a second and a
    // half, over which the chassis settles a fraction further out as it turns. That is the
    // rotation resolving, not the arm shoving — the shove this was written for was 3.85in.
    worstShove < 1.5,
    `worst displacement ${worstShove.toFixed(2)}in (was 3.85in head-on, 6.68in angled)`,
  );
}

// ---- nothing squeezes through a gap it does not fit in -----------------------------
// Reported: artifacts "squeezing through the small gap with the top right corner of the robot
// and the field wall when gate intaking". Each constraint in the tick was individually
// satisfied — the eviction pushed the artifact out of the chassis, the wall clamp refused that
// push and put it back — so it ended the tick overlapping but not stopped, and the flow
// carried it through. Measured: a 5in artifact through a 4.0in gap, three per drain.
{
  const diameter = 2 * BALL_RADIUS;
  const results: { gap: number; through: number }[] = [];
  for (const want of [4.6, 4.0, 3.4, 2.8]) {
    const w = mkWorld('match', 'red', 5, { intake: 'vector', width: 17.5, length: 14.5 });
    startMatch(w);
    w.match.phase = 'teleop';
    for (const b of w.balls) {
      b.state = { kind: 'ground' };
      b.pos = { x: -40, y: -60 };
      b.vel = { x: 0, y: 0 };
      b.z = 0;
      b.vz = 0;
    }
    const ids: number[] = [];
    for (let i = 0; i < 9; i++) {
      const b = w.balls[i];
      const cs = GATE_STOP_S + i * RAIL_PITCH;
      b.state = { kind: 'rail', goal: 'red', s: cs, v: 0, overflow: false, pending: false };
      b.pos = railPos('red', cs);
      b.vel = { x: 0, y: 0 };
      b.z = RAMP_SURFACE_Z;
      b.vz = 0;
      ids.push(b.id);
    }
    const r = w.robots[0];
    r.heading = (19 * Math.PI) / 180;
    r.hopper = [];
    r.fieldCentric = false;
    r.pos = { x: 50, y: -10 };
    // bisect the robot's x for the requested corner-to-wall gap
    let lo = 40;
    let hi = FIELD_HALF;
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      r.pos.x = mid;
      if (FIELD_HALF - Math.max(...chassisCorners(r).map((c) => c.x)) > want) lo = mid;
      else hi = mid;
    }
    r.pos.x = lo;
    const ry = r.pos.y;
    for (let i = 0; i < Math.round(10 / SIM_DT); i++) {
      r.pos.x = lo;
      r.pos.y = ry;
      r.vel = { x: 0, y: 0 };
      w.goals.red.gatePos = 1;
      w.goals.red.gateOpen = true;
      w.goals.red.gateLatch = 1;
      step(w, SIM_DT, new Map([[0, cmd({ intake: true })]]));
    }
    let through = 0;
    for (const b of w.balls) {
      if (!ids.includes(b.id) || b.state.kind !== 'ground') continue;
      if (b.pos.x > 64 && b.pos.y < ry - 10) through++;
    }
    results.push({ gap: FIELD_HALF - Math.max(...chassisCorners(r).map((c) => c.x)), through });
  }
  check(
    'an artifact does not pass between a robot corner and the wall through a gap it cannot fit',
    results.every((x) => x.through === 0),
    results.map((x) => `${x.gap.toFixed(1)}in:${x.through}`).join(' ') + ` (artifact is ${diameter}in)`,
  );
}

// ---- ...and the gap that matters when GATE INTAKING is to the INTAKE ------------------
/**
 * "I'm gate intaking and they get thru the gap." "We fixed this a long time ago and when we
 * started changing how the gate collision turn behaves, it came back again."
 *
 * The check above measures to the CHASSIS corner. When someone is gate intaking, the thing
 * nearest the wall is the INTAKE, and two of this session's changes went straight past the
 * old protection there: the jam rule ("nothing squeezes through a gap it does not fit in")
 * only ever asked about the chassis, and the classifier outflow started being set down on the
 * intake's LID — as a FLIGHT artifact, which is outside the ground solve — still carrying the
 * ramp's 40in/s, so it simply sailed down the tunnel past the robot.
 *
 * Bisected against the pre-gate-work build: square to the wall, gaps of 3.0 / 3.5 / 4.0in
 * passed 0 / 0 / 0 artifacts before and 3 / 2 / 4 after. The lid release is the one that did
 * it, and an artifact set down on a lid now keeps the LID's motion instead of the ramp's.
 */
{
  const drainPast = (want: number, headDeg: number): number => {
    const w = mkWorld('match', 'red', 5);
    startMatch(w);
    w.match.phase = 'teleop';
    for (const b of w.balls) b.state = { kind: 'held', robot: 99 };
    const ids: number[] = [];
    for (let i = 0; i < 9; i++) {
      const b = w.balls[i];
      const cs = GATE_STOP_S + i * RAIL_PITCH;
      b.state = { kind: 'rail', goal: 'red', s: cs, v: 0, overflow: false, pending: false };
      b.pos = railPos('red', cs);
      b.vel = { x: 0, y: 0 };
      b.z = RAMP_SURFACE_Z;
      b.vz = 0;
      ids.push(b.id);
    }
    const r = w.robots[0];
    r.heading = (headDeg * Math.PI) / 180;
    r.hopper = [];
    r.fieldCentric = false;
    r.pos = { x: 50, y: -10 };
    // bisect the robot's x for the requested FOOTPRINT-to-wall gap — chassis plus intake,
    // which is what is actually beside the wall in this pose
    const gapNow = () =>
      FIELD_HALF - Math.max(...footprintCorners(r.spec, r.pos, r.heading).map((c) => c.x));
    let lo = 40;
    let hi = FIELD_HALF;
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      r.pos.x = mid;
      if (gapNow() > want) lo = mid;
      else hi = mid;
    }
    r.pos.x = lo;
    const ry = r.pos.y;
    for (let i = 0; i < Math.round(10 / SIM_DT); i++) {
      r.pos.x = lo;
      r.pos.y = ry;
      r.vel = { x: 0, y: 0 };
      r.hopper.length = 0; // a driver cycling what they catch, so the mouth never backs up
      w.goals.red.gatePos = 1;
      w.goals.red.gateOpen = true;
      w.goals.red.gateLatch = 1;
      step(w, SIM_DT, new Map([[0, cmd({ intake: true })]]));
    }
    return w.balls.filter(
      (b) => ids.includes(b.id) && b.state.kind === 'ground' && b.pos.x > 64 && b.pos.y < ry - 10,
    ).length;
  };
  const square = [3.0, 3.5, 4.0, 4.6].map((g) => drainPast(g, 0));
  check(
    'the drain does not squeeze past an INTAKE parked a gap too small beside the wall',
    square.every((n) => n === 0),
    `square to the wall, gaps 3.0/3.5/4.0/4.6in -> ${square.join('/')} artifacts past (was 3/2/4/0 once the outflow moved onto the lid)`,
  );
}

// ---- an artifact comes DOWN as it leaves the ramp ----------------------------------
// Reported: "still skipping over the chassis when the balls come down from the classifier".
// An artifact on the ramp rides RAMP_SURFACE_Z up, which is true inside the channel and false
// past the mouth — out there it is on the open apron with nothing under it, and robots stand
// there. It used to hold full ramp height across that whole stretch and snap to the floor only
// at release, so it crossed open ground ten inches up and rode over anything in the way.
{
  const w = mkWorld('match', 'blue', 5);
  startMatch(w);
  w.match.phase = 'teleop';
  fillBlueRail(w);
  w.robots[0].pos = { x: 0, y: -40 };
  // sampled PER ARTIFACT as it crosses each landmark, never bucketed by `s`. Bucketing was
  // aliased: the height across this stretch falls four inches of z per inch of s, so a
  // half-inch bucket spans two inches of height, and which artifact happened to write the
  // bucket last decided whether the check passed. A column that BACKS UP against the queue
  // outside now comes to rest part way down that stretch, which is correct and made the
  // aliasing visible.
  const halfWay = (RAIL_OPEN_S + RAIL_EXIT_S) / 2;
  let atMouth = 0;
  let atExit = 99;
  let mid = 99;
  let midS = 0;
  const seenMouth = new Set<number>();
  const seenMid = new Set<number>();
  for (let i = 0; i < 400; i++) {
    w.goals.blue.gatePos = 1;
    w.goals.blue.gateOpen = true;
    w.goals.blue.gateLatch = 1;
    step(w, SIM_DT, new Map());
    for (const b of w.balls) {
      if (b.state.kind !== 'rail') continue;
      const sNow = (b.state as { s: number }).s;
      if (sNow <= RAIL_OPEN_S && !seenMouth.has(b.id)) {
        seenMouth.add(b.id);
        atMouth = Math.max(atMouth, b.z); // the height it LEAVES the channel at
      }
      if (sNow <= halfWay && !seenMid.has(b.id)) {
        seenMid.add(b.id);
        if (b.z < mid) {
          mid = b.z;
          midS = sNow;
        }
      }
      if (sNow <= RAIL_EXIT_S) atExit = Math.min(atExit, b.z);
    }
  }
  check(
    'an artifact leaves the ramp at ramp height and reaches the floor by the exit',
    atMouth > RAMP_SURFACE_Z - 0.5 && atExit < 0.5,
    `mouth z=${atMouth.toFixed(1)} exit z=${atExit.toFixed(1)}`,
  );
  /**
   * ...CONTINUOUSLY, checked against the law rather than a band.
   *
   * The height across this stretch is pure geometry — RAMP_SURFACE_Z tapering to 0 over
   * RAIL_DROP_S of travel — and the sample is the first TICK past the halfway point, which
   * is not the halfway point: a faster ramp overshoots it further in one tick, so a fixed
   * band reads as a failure when the only thing that changed is how fast the artifact is
   * going. So compare the artifact's height to what the law says at the `s` it was actually
   * sampled at, which is the statement that was meant all along.
   */
  const expectedMid = RAMP_SURFACE_Z * (1 - Math.min(1, Math.max(0, (RAIL_OPEN_S - midS) / RAIL_DROP_S)));
  check(
    'and it gets there continuously, not by snapping at the exit',
    mid > 0.2 && Math.abs(mid - expectedMid) < 0.5,
    `at s=${midS.toFixed(2)} it is z=${mid.toFixed(2)}, and the ramp taper says ${expectedMid.toFixed(2)}`,
  );
}

// ---- ...but PRESSING THE LEVER is not parking on the outflow ---------------------
// "I only get one or two balls from a tap way too often." The roof's blocking region carried
// a radius of slop around the mouth, and at the gate that radius is the difference between a
// robot whose mouth is over the drain and one merely pressing the lever with its intake tip.
// A driver who bumped the gate and STAYED — which is what a driver does — was reading as
// parked on their own outflow and got NOTHING: 0 of 9 at every tap length from 0.10s to 0.5s,
// against 2/3/9/9/9 for the same taps if the robot backed away afterwards.
{
  const tapStay = (tapS: number, standoff: number): number => {
    const w = mkWorld('match', 'blue', 42);
    startMatch(w);
    fillBlueRail(w);
    const r = w.robots[0];
    const z = gateZone('blue');
    r.pos = { x: z.x1 + standoff, y: (z.y0 + z.y1) / 2 };
    r.heading = Math.PI;
    r.fieldCentric = false;
    r.vel = { x: 0, y: 0 };
    run(w, cmd({ driveY: 1 }), tapS);
    run(w, cmd({}), 12); // ...and STAYS: no teleport away
    return 9 - w.balls.filter((b) => b.state.kind === 'rail' && b.state.goal === 'blue').length;
  };
  const close = [0.15, 0.3, 0.5].map((t) => tapStay(t, 4));
  check(
    'a driver who taps the lever and stays there still gets the drain',
    Math.max(...close) >= 7 && close.every((y) => y >= 1),
    `pressed in close, 0.15/0.3/0.5s taps -> ${close.join(' ')} (was 0 0 0)`,
  );
}

// ---- parking ON the outflow puts artifacts ON the intake, never inside it -------------
// "Once I open the gate and then stand directly in front of where the balls come out, there
// is no space for the balls to drop, so it would drop on top of the intake. However, it is
// being intaked, still." The ramp discharges at RAMP_SURFACE_Z and an intake's roof is at
// about the same height (intakeLidZ), so an artifact leaving the channel with a robot parked
// under it has nowhere to be set down. The descent used to run straight through the intake
// and put it on the floor INSIDE the mouth, which is the one place it cannot have got to.
//
// The answer to that was to make the column WAIT for floor to appear, and that was wrong in a
// way that only shows up in play: the robot holding the gate open is the robot in the way, so
// the floor never appears. Measured, holding the lever and intaking — the ordinary way anyone
// drains a ramp — 0 of 9 artifacts came out in 20 seconds with the gate wide open, for both
// intakes whose reach covers the outflow. "When I gate intake the balls go infinitely."
//
// So the ramp always runs, and the roof answers at the RELEASE: the artifact is set down ON
// the lid and has to come off it. Nothing is ever handed to a robot off the rail — that is
// the rule, and it is what the two checks below actually watch.
{
  const parkRun = (over: number): { taken: number; onRamp: number; straightIn: number } => {
    const w = mkWorld('match', 'blue', 42);
    startMatch(w);
    w.match.phase = 'teleop';
    for (const b of w.balls) if (b.state.kind === 'ground') b.pos = { x: 300, y: 300 };
    fillBlueRail(w);
    const r = w.robots[0];
    const exit = railPos('blue', RAIL_EXIT_S);
    const tip = DEFAULT_SPEC.length / 2 + INTAKE_PRESETS[DEFAULT_SPEC.intake].reach;
    r.heading = Math.PI / 2; // in the tunnel, facing back up at the gate
    r.fieldCentric = false;
    r.hopper = [];
    const park = { x: exit.x, y: exit.y - tip + over };
    const nine = w.balls.slice(0, 9);
    const wasOn = new Map(nine.map((b) => [b.id, b.state.kind]));
    // an artifact taken WITHOUT ever leaving the ramp — the one thing the drop-space rule
    // forbids, and the only way to ask it that does not also outlaw the ramp running
    let straightIn = 0;
    for (let i = 0; i < Math.round(14 / SIM_DT); i++) {
      r.pos = { ...park };
      r.vel = { x: 0, y: 0 };
      w.goals.blue.gatePos = 1;
      w.goals.blue.gateOpen = true;
      w.goals.blue.gateLatch = 1;
      step(w, SIM_DT, new Map([[0, cmd({ intake: true })]]));
      for (const b of nine) {
        if (b.state.kind === 'held' && wasOn.get(b.id) === 'rail') straightIn++;
        wasOn.set(b.id, b.state.kind);
      }
    }
    return {
      taken: nine.filter((b) => b.state.kind === 'held').length,
      onRamp: nine.filter((b) => b.state.kind === 'rail').length,
      straightIn,
    };
  };
  const on = parkRun(0); // intake tip right on the drop point
  check(
    'a robot parked on the outflow never takes an artifact straight off the ramp',
    on.straightIn === 0,
    `${on.straightIn} rail->held; ${on.taken} ended up held after crossing the lid, ${on.onRamp} still on the ramp`,
  );
  /**
   * ...AND THE WAIT ENDS WHEN THE ROBOT DOES.
   *
   * Parked ON the outflow the column stops at the intake, exactly as it does at a bumper: the
   * mouth is open to an artifact rolling IN, it is not open from above, and the ramp
   * discharges from above. Both ways round that were tried are worse — setting the artifact
   * down on the intake's LID leaves it in flight, which is outside the ground solve (it
   * skated through gaps it does not fit through, and when that was damped, it hovered:
   * "they're all floating"), and setting it on the floor puts it inside the mouth, which is
   * the one place it cannot have got to.
   *
   * So the guarantee is not that the ramp never waits. It is that the wait is a ROBOT, and
   * ends when the robot moves: back off the drop point and the whole column comes out.
   */
  const off = parkRun(-3);
  check(
    '...and the wait ends the moment the robot moves off — it is a robot, not a deadlock',
    on.onRamp === 9 && off.onRamp < 6,
    `parked on it: ${on.onRamp} of 9 left after 14s; backed off 3in: ${off.onRamp} left and ${off.taken} taken (the rest is the hopper filling and the doorway backing up behind it, not the block)`,
  );
  // ...and the rule is about the DROP SPACE, not about being near the gate: back off a few
  // inches and the artifacts land on the floor and roll into the mouth as they should. This
  // is the same technique the drain cadence work protects (gate intaking), and it must not
  // be what the check above outlaws.
  const back = parkRun(-3);
  check(
    '...but backed off the drop point it feeds normally, so gate intaking still works',
    back.taken > 0 && back.onRamp < 9,
    `3in back: took ${back.taken}, ${back.onRamp} left on the ramp`,
  );
  /**
   * WHERE THE LINE IS: "there needs to be adequate space ON THE GROUND for the ball to DROP
   * ON THE GROUND which can then be intaked by the robot", with a lenience because "if the
   * ball drops on the very front edge of the intake rollers, they can suck them in due to
   * compliance."
   *
   * So the drop point needs a full artifact RADIUS of clearance from the intake, less
   * INTAKE_CATCH_LENIENCE in front of the roller face and nowhere else. Swept by how far the
   * intake tip sits from the drop point, this is a clean step: nothing until there is room,
   * everything after.
   */
  const need = BALL_RADIUS - INTAKE_CATCH_LENIENCE;
  const tooClose = [-1, 0, need - 0.3].map((g) => parkRun(-g));
  const roomy = [need + 0.2, need + 1.2, need + 3.7].map((g) => parkRun(-g));
  check(
    'the drop point needs ground to drop ONTO, less the roller-face lenience',
    tooClose.every((x) => x.straightIn === 0) && roomy.every((x) => x.taken > 0),
    `no ground -> over the lid every time; ${(need + 0.2).toFixed(1)}in clear -> ${roomy[0].taken} taken off the floor`,
  );
}

// ---- NO LOAD, NO TORQUE: a robot touching something is not being turned by it -------
// "Torque is being applied with me not doing anything." The response's gain was
// `1 + press * CONTACT_PRESS_GAIN` — a floor of 1 — so the geometric torque alone rotated a
// chassis at zero press. Against a FACE it hides, because the flush cap stops it the moment
// the robot is square; against the gate handle, which is a point and has no flush to stop at,
// a robot parked beside it turned 359.6 degrees on its own.
{
  const idleTurn = (label: string, place: (w: World) => void, driveFirst: boolean): number => {
    const w = mkWorld('match', 'blue', 42);
    startMatch(w);
    for (const b of w.balls) b.state = { kind: 'held', robot: 99, slot: 0, lx: 0, ly: 0, side: 0 };
    const r = w.robots[0];
    r.fieldCentric = false;
    r.vel = { x: 0, y: 0 };
    place(w);
    if (driveFirst) run(w, cmd({ driveY: 1 }), 1.5);
    const h0 = r.heading;
    let worst = 0;
    for (let i = 0; i < Math.round(4 / SIM_DT); i++) {
      step(w, SIM_DT, new Map([[0, cmd({})]])); // nothing pressed
      worst = Math.max(worst, Math.abs(r.heading - h0));
    }
    void label;
    return (worst * 180) / Math.PI;
  };
  const z = gateZone('blue');
  const turns = [
    idleTurn('gate, never driven', (w) => {
      w.robots[0].pos = { x: z.x1 + 2, y: GATE_TAPE_Y - 6 };
      w.robots[0].heading = Math.PI;
    }, false),
    idleTurn('gate, driven then released', (w) => {
      w.robots[0].pos = { x: z.x1 + 8, y: GATE_TAPE_Y - 6 };
      w.robots[0].heading = Math.PI;
    }, true),
    idleTurn('wall, driven then released', (w) => {
      w.robots[0].pos = { x: 0, y: FIELD_HALF - 20 };
      w.robots[0].heading = Math.PI / 2 + 0.15;
    }, true),
    idleTurn('classifier, driven then released', (w) => {
      w.robots[0].pos = { x: classifierRect('blue').x1 + 12, y: 20 };
      w.robots[0].heading = Math.PI + 0.15;
    }, true),
  ];
  check(
    'a robot resting against something does not turn while the driver does nothing',
    turns.every((t) => t < 1),
    `worst idle turn over four resting poses: ${Math.max(...turns).toFixed(1)}deg (the gate turned 359.6 on its own)`,
  );
}

// ---- a contact NEVER turns you the wrong way ---------------------------------------
// "It's turning me the other way sometimes." The contact list is every corner within
// CONTACT_TOUCH_EPS of the surface, and the load used to be shared as `depth + CONTACT_BIAS` —
// a floor, which is a vote for corners that are NOT touching. The two front corners do not
// have mirror-image lever arms once the chassis is tilted (the intake extends the front), so a
// fabricated vote from the corner half an inch clear could outweigh the one actually bearing
// and reverse the torque. Load is shared by COMPRESSION now: full at the deepest corner,
// nothing beyond CONTACT_COMPLIANCE of it.
{
  const settle = (tiltDeg: number, at: 'wall' | 'gate', dy = 0): number => {
    const w = mkWorld('match', 'blue', 42);
    startMatch(w);
    for (const b of w.balls) b.pos = { x: 300, y: 300 };
    const r = w.robots[0];
    const face = at === 'wall' ? Math.PI / 2 : Math.PI;
    if (at === 'wall') r.pos = { x: 0, y: FIELD_HALF - 20 };
    else r.pos = { x: gateZone('blue').x1 + 8, y: GATE_TAPE_Y + dy };
    r.heading = face + (tiltDeg * Math.PI) / 180;
    r.fieldCentric = false;
    r.vel = { x: 0, y: 0 };
    run(w, cmd({ driveY: 1 }), 3);
    const q = Math.PI / 2;
    let rel = r.heading - face;
    rel -= Math.round(rel / q) * q;
    return (rel * 180) / Math.PI;
  };
  const tilts = [-12, -6, -3, -1, 1, 3, 6, 12];
  const cases: { label: string; tilt: number; ended: number }[] = [];
  /**
   * ...INCLUDING WHEN YOU ARRIVE HARD. "Even if I hit it with a large impact it doesn't turn
   * me": the impulse a collision hands the chassis was gated on `flushErr > 0.05` and sat
   * inside an `else if`, so arriving fast and nearly square produced nothing at all. It is its
   * own term now, and it is guarded by the TILT rather than by the alignment — comparing it
   * against `align` passes trivially whenever `align` has been zeroed for pointing the wrong
   * way, which is exactly when the guard is needed.
   *
   * ONLY FACES ARE ASKED ABOUT FLUSH. A wall, a goal face and the classifier's side can align
   * a chassis because two corners bear on them. The gate handle is 2.5in of bar and cannot —
   * it PIVOTS you, and its own check is below.
   */
  const hardCases: { tilt: number; ended: number }[] = [];
  /**
   * ...AND THE GATE HANDLE PIVOTS YOU INSTEAD, which is what a 2.5in stub can do to an 18in
   * chassis. "When I hit the gate with the leftmost or rightmost side of the robot, I should
   * be turning but I square up instead."
   *
   * The moment is `r x n`, so it vanishes when the contact comes to lie on the line through
   * the robot's centre along the push: lean on the arm off-centre and you turn about it until
   * it is dead ahead; arrive already centred on it and you are not turned at all. No cap and
   * no target angle — the equilibrium is in the geometry.
   */
  const armHit = (offCentre: number): number => {
    const w = mkWorld('match', 'blue', 42);
    startMatch(w);
    for (const b of w.balls) b.state = { kind: 'held', robot: 99, slot: 0, lx: 0, ly: 0, side: 0 };
    const r = w.robots[0];
    r.pos = { x: gateZone('blue').x1 + 14, y: GATE_TAPE_Y - offCentre };
    r.heading = Math.PI;
    r.fieldCentric = false;
    r.vel = { x: 0, y: 0 };
    const h0 = r.heading;
    run(w, cmd({ driveY: 1 }), 3);
    // UNWRAP: the sim wraps the heading, so a raw delta reads as a full turn. Three separate
    // diagnoses this session started as "it spun 360" and were this.
    let d = r.heading - h0;
    d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
    return Math.abs((d * 180) / Math.PI);
  };
  const centred = armHit(0);
  const withSide = [2, 4, 6, 8].map(armHit);
  check(
    'hitting the gate arm off-centre TURNS the robot, and hitting it square does not',
    centred < 1 && withSide.every((t) => t > 3),
    `centred ${centred.toFixed(0)}deg; 2/4/6/8in off centre ${withSide.map((t) => t.toFixed(0)).join('/')}deg`,
  );
  /**
   * ...AND HOW MUCH IT TURNS YOU GROWS WITH THE LEVER ARM, which is the physics showing.
   *
   * The moment of a contact force is r x F: meet the stub further off your centre and the
   * same push turns you more. That ordering was absent while the normal came from the robot's
   * CENTRE clamped onto the stub (7/7/7/11 degrees — flat, because the geometry it measured
   * was not the contact's), and it appears as soon as the normal is the separation direction
   * the shapes actually have: 5/12/22/32.
   *
   * The ceiling is a right angle, which is the thing the old complaint was about ("it spins me
   * around like 90 degrees instantly"), and the rate is what makes it not that: 32 degrees is
   * over three full seconds of driving into the arm, about 11 deg/s.
   */
  const fromChannelSide = [2, 4, 6, 8].map((d) => armHit(-d));
  const allHits = [...withSide, ...fromChannelSide];
  check(
    '...and how far grows with how far off centre you hit it, without ever spinning you round',
    allHits.every((t) => t < 45) && withSide[3] > withSide[0] * 2,
    `tunnel side ${withSide.map((t) => t.toFixed(0)).join('/')}deg vs channel side ${fromChannelSide.map((t) => t.toFixed(0)).join('/')}deg (was 7/7/7/11 and 2/10/0/15 — flat)`,
  );
}

// ---- the gate arm is a POINT CONTACT, and it is solved as one ----------------------
/**
 * Three reports, one lever, and in the end one piece of physics.
 *
 * "The gate applies way too much torque way too fast" — a 2.5in hinged bar squaring a chassis
 * at a wall's rate. Then, damped: "even if I hit it with a large impact it doesn't turn me",
 * "the chassis is barely turning". Then: "it is a collision to the SIDE of the robot, meaning
 * the robot should turn INTO THE CORNER."
 *
 * The square-up model could not answer the last one at any setting, because it is a stand-in
 * for a distributed FACE contact — it settles a chassis flush, and a normal push through a
 * POINT can only ever swing a robot away from what it touched. Catching a post with your flank
 * does the opposite, and the reason is friction: the post drags that side back. So the arm is
 * solved as what it is, a single point contact on a rigid body:
 *
 *   J_n = -(1 + e)(v_p . n) / (1 + (r x n)^2 / (I/m))
 *   J_t = clamp(-(v_p . t) / (1 + (r x t)^2 / (I/m)), -mu J_n, mu J_n)
 *
 * with the normal impulse read from the approach the collision pass actually removed this tick
 * (a steady push is a small one every tick, a hard hit one big one), and I/m the square
 * chassis's (l^2 + w^2)/12, so mass cancels. The arm's own softness multiplies it: while the
 * lever has travel, part of the push lifts it rather than landing on the robot.
 */
{
  const armTurn = (y0: number, seconds = 3): number => {
    const w = mkWorld('match', 'red', 5);
    startMatch(w);
    w.match.phase = 'teleop';
    for (const b of w.balls) b.state = { kind: 'held', robot: 99 };
    const r = w.robots[0];
    r.pos = { x: 52, y: y0 };
    r.heading = 0; // nose at the wall; the arm meets a FLANK, not the front
    r.fieldCentric = false;
    const h0 = r.heading;
    for (let i = 0; i < Math.round(seconds / SIM_DT); i++) {
      step(w, SIM_DT, new Map([[0, cmd({ driveY: 1, leftDrive: 1, rightDrive: 1 })]]));
    }
    let d = r.heading - h0;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    return (d * 180) / Math.PI;
  };
  // below the gate the arm is off the robot's LEFT flank, so INTO the corner is +y (CCW)
  const below = [-12, -9, -6, -3].map((y) => armTurn(y));
  check(
    'a SIDE hit on the gate arm turns the robot INTO the corner',
    below.every((t) => t > 2),
    `driving at the wall from y = -12/-9/-6/-3: turned ${below.map((t) => t.toFixed(0)).join('/')}deg toward the gate (friction dragging the contacting flank; the normal push alone gave 0/0/2/1)`,
  );
  /**
   * ...AND THE ARM'S TRAVEL IS WHAT DECIDES HOW MUCH OF IT LANDS.
   *
   * A lever absorbs a push with its travel: shove a closed arm and most of the shove goes into
   * lifting it, and at full lift there is none left, so the whole impulse arrives. "If the gate
   * is fully open, then that part acts like a wall essentially for collisions."
   */
  const pinnedTurn = (holdAt: number): number => {
    const w = mkWorld('match', 'red', 5);
    startMatch(w);
    w.match.phase = 'teleop';
    for (const b of w.balls) b.state = { kind: 'held', robot: 99 };
    const r = w.robots[0];
    r.pos = { x: 52, y: -6 };
    r.heading = 0;
    r.fieldCentric = false;
    const h0 = r.heading;
    for (let i = 0; i < Math.round(3 / SIM_DT); i++) {
      w.goals.red.gatePos = holdAt;
      w.goals.red.gateOpen = holdAt >= GATE_PASS_FRAC;
      w.goals.red.gateLatch = GATE_OPEN_LATCH_S;
      step(w, SIM_DT, new Map([[0, cmd({ driveY: 1, leftDrive: 1, rightDrive: 1 })]]));
    }
    let d = r.heading - h0;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    return Math.abs((d * 180) / Math.PI);
  };
  const shut = pinnedTurn(0);
  const stop = pinnedTurn(1);
  check(
    '...and a closed arm gives where one at its stop does not',
    stop > shut * 2,
    `pinned shut it turns the robot ${shut.toFixed(1)}deg, at its stop ${stop.toFixed(1)}deg`,
  );
}

{
  /**
   * ...AND NOTHING SNAPS A ROBOT ROUND, structure or not.
   *
   * `CONTACT_PRESS_GAIN` scales the align rate with how hard you are pressing, up to
   * `CONTACT_ALIGN_RATE_MAX` — which was 0.12 rad, or 6.9 degrees in ONE TICK, 412 deg/s. A
   * contact should not out-turn the drivetrain. "It spins me around like 90 degrees instantly."
   */
  const ramTurn = (tiltDeg: number, runup: number): { worstTick: number; peakAng: number } => {
    const w = mkWorld('match', 'blue', 42);
    startMatch(w);
    for (const b of w.balls) b.pos = { x: 300, y: 300 };
    const r = w.robots[0];
    r.pos = { x: 0, y: FIELD_HALF - 9 - runup };
    r.heading = Math.PI / 2 + (tiltDeg * Math.PI) / 180;
    r.fieldCentric = false;
    r.vel = { x: 0, y: 0 };
    let worstTick = 0;
    let peakAng = 0;
    for (let i = 0; i < Math.round(3 / SIM_DT); i++) {
      const h0 = r.heading;
      step(w, SIM_DT, new Map([[0, cmd({ driveY: 1 })]]));
      const d = Math.abs(r.heading - h0);
      if (d < Math.PI && d > worstTick) worstTick = d;
      peakAng = Math.max(peakAng, Math.abs(r.angVel));
    }
    return { worstTick: (worstTick * 180) / Math.PI, peakAng };
  };
  const rams = [ramTurn(-20, 20), ramTurn(20, 20), ramTurn(-20, 8)];
  const worstTick = Math.max(...rams.map((x) => x.worstTick));
  const peakAng = Math.max(...rams.map((x) => x.peakAng));
  check(
    'ramming a wall at speed never snaps the chassis round — it squares it',
    worstTick < 4 && peakAng < 1.5,
    `worst ${worstTick.toFixed(1)}deg in one tick (was 6.9), peak spin ${peakAng.toFixed(2)} rad/s (was 3.23)`,
  );
}

// ---- ramming a structure SQUARES you up, from any angle and either end -------------
// "Even when I ram with the back of the chassis where there is no intake, the robot only turns
// if I impact it at certain specific angles, weird." The classifier passed `contacts.length > 1`
// as its square-to flag, so a single-corner press took applyContactTorque's PIVOT mode, which
// has no flush cap: measured across ten approach angles it spun rather than settling. A flat
// face aligns a chassis whether one corner is on it or two — the walls have always said so.
{
  const ramInto = (target: Vec2, faceAngle: number, tiltDeg: number, backwards: boolean): number => {
    const w = mkWorld('match', 'blue', 42);
    startMatch(w);
    for (const b of w.balls) b.pos = { x: -300, y: -300 };
    const r = w.robots[0];
    r.heading = (backwards ? faceAngle + Math.PI : faceAngle) + (tiltDeg * Math.PI) / 180;
    r.pos = { x: target.x - Math.cos(faceAngle) * 16, y: target.y - Math.sin(faceAngle) * 16 };
    r.fieldCentric = false;
    r.vel = { x: 0, y: 0 };
    run(w, cmd({ driveY: backwards ? -1 : 1 }), 4);
    // how far off FLUSH it ended, mod 90 — the chassis is square, and raw heading deltas are
    // meaningless because the sim wraps the angle (which is what made this look like a 360)
    const q = Math.PI / 2;
    let rel = r.heading - faceAngle;
    rel -= Math.round(rel / q) * q;
    return Math.abs((rel * 180) / Math.PI);
  };
  const tilts = [-30, -20, -12, -6, -3, 3, 6, 12, 20, 30];
  const cl = classifierRect('blue');
  const worstAt = (target: Vec2, faceAngle: number) =>
    Math.max(...tilts.flatMap((t) => [ramInto(target, faceAngle, t, false), ramInto(target, faceAngle, t, true)]));
  const wall = Math.max(...tilts.flatMap((t) => [ramInto({ x: 0, y: FIELD_HALF }, Math.PI / 2, t, false), ramInto({ x: 0, y: FIELD_HALF }, Math.PI / 2, t, true)]));
  const classifier = worstAt({ x: cl.x1, y: 20 }, Math.PI);
  check(
    'ramming a wall squares the chassis up, at every angle and either end',
    wall < 1,
    `worst of 20 approaches: ${wall.toFixed(1)}deg off flush`,
  );
  check(
    '...and so does the classifier, which used to pivot instead of squaring',
    classifier < 1,
    `worst of 20 approaches: ${classifier.toFixed(1)}deg off flush`,
  );
}

// ---- NOTHING JITTERS: no entity oscillates in place --------------------------------
// "Get rid of all cases where artifacts or robots jitter." Jitter is a direction reversal with
// nothing to show for it — two constraints taking turns rather than resolving. This sweeps the
// contact situations where that can hide and measures the symptom directly: reversals per
// second on anything whose NET movement over the window is under two inches.
{
  const jitterIn = (
    label: string,
    seconds: number,
    build: () => World,
    commands: () => Map<number, RobotCommand>,
  ): { label: string; rate: number; who: string; amp: number } => {
    const w = build();
    const prev = new Map<string, { x: number; y: number }>();
    const last = new Map<string, { x: number; y: number }>();
    const first = new Map<string, { x: number; y: number }>();
    const rev = new Map<string, number>();
    const amp = new Map<string, number>(); // how far each reversal actually moves it
    const see = (key: string, p: { x: number; y: number }) => {
      if (!first.has(key)) first.set(key, { ...p });
      const l = last.get(key);
      last.set(key, { ...p });
      if (!l) return;
      const sx = p.x - l.x;
      const sy = p.y - l.y;
      if (hyp(sx, sy) < 0.02) return; // at rest is not jitter
      const pv = prev.get(key);
      prev.set(key, { x: sx, y: sy });
      if (pv && sx * pv.x + sy * pv.y < 0 && hyp(pv.x, pv.y) > 0.02) {
        rev.set(key, (rev.get(key) ?? 0) + 1);
        amp.set(key, Math.max(amp.get(key) ?? 0, hyp(sx, sy)));
      }
    };
    for (let i = 0; i < Math.round(seconds / SIM_DT); i++) {
      step(w, SIM_DT, commands());
      for (const b of w.balls) if (b.state.kind === 'ground') see(`artifact ${b.id}`, b.pos);
      for (const r of w.robots) see(`robot ${r.id}`, r.pos);
    }
    let worst = { label, rate: 0, who: '-', amp: 0 };
    for (const [k, n] of rev) {
      const net = hyp(last.get(k)!.x - first.get(k)!.x, last.get(k)!.y - first.get(k)!.y);
      if (net > 2) continue; // it went somewhere — being pushed around is not jitter
      // ...and a reversal you cannot SEE is not jitter either. A tenth of an inch is a fifth
      // of a pixel at match zoom; what the eye reads as buzzing is amplitude, not count.
      if ((amp.get(k) ?? 0) < 0.1) continue;
      if (n / seconds > worst.rate) worst = { label, rate: n / seconds, who: k, amp: amp.get(k) ?? 0 };
    }
    return worst;
  };
  const twoBots = (place: (w: World) => void): (() => World) => () => {
    const w = createWorld('match', 5, [
      { id: 0, alliance: 'blue', spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS }, startIndex: 0 },
      { id: 1, alliance: 'red', spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS }, startIndex: 0 },
    ]);
    startMatch(w);
    w.match.phase = 'teleop';
    w.robots[1].pos = { x: -60, y: -60 };
    w.robots[0].fieldCentric = false;
    place(w);
    return w;
  };
  const push = () => new Map([[0, cmd({ driveY: 1 })], [1, cmd({})]]);
  const results = [
    // a robot leaning on each kind of structure, off-square so it has something to settle into
    jitterIn('robot on the wall', 4, twoBots((w) => { w.robots[0].pos = { x: 40, y: 55 }; w.robots[0].heading = Math.PI / 2 + 0.2; }), push),
    jitterIn('robot in a corner', 4, twoBots((w) => { w.robots[0].pos = { x: 55, y: -55 }; w.robots[0].heading = -Math.PI / 4 + 0.15; }), push),
    jitterIn('robot on the goal face', 4, twoBots((w) => { w.robots[0].pos = { x: 45, y: 45 }; w.robots[0].heading = Math.PI / 4 + 0.2; }), push),
    jitterIn('robot on the classifier', 4, twoBots((w) => { w.robots[0].pos = { x: classifierRect('red').x0 - 11, y: 20 }; w.robots[0].heading = 0.2; }), push),
    jitterIn('robot on a robot', 4, twoBots((w) => { w.robots[0].pos = { x: 0, y: 0 }; w.robots[0].heading = 0; w.robots[1].pos = { x: 19, y: 2 }; w.robots[1].heading = 0.3; }), push),
    // ...and a robot shovelling a pile of artifacts into a wall, which is where it was real:
    // separation pushed a pair apart, the wall clamp put them back, 27 reversals a second
    jitterIn('a clump shoved into a wall', 4, twoBots((w) => {
      let k = 0;
      for (const b of w.balls) {
        if (b.state.kind !== 'ground') continue;
        if (k < 9) b.pos = { x: 30 + (k % 3) * 5.2, y: 60 + Math.floor(k / 3) * 5.2 };
        k++;
      }
      w.robots[0].pos = { x: 35, y: 40 };
      w.robots[0].heading = Math.PI / 2;
    }), push),
    // ...and an untouched match, left alone
    jitterIn('an untouched match', 8, twoBots((w) => { w.robots[0].pos = { x: 0, y: 0 }; }), () => new Map()),
  ];
  /**
   * SIX OF THE SEVEN ARE CLEAN, and the seventh is stated rather than hidden.
   *
   * What fixed the rest is damping the corrections: `BALL_SEPARATION_RELAX` takes out half an
   * overlap per pass instead of all of it, over more passes. A full correction overshoots the
   * moment another constraint disagrees, which against a wall it always does — separation
   * pushes a pair apart, the clamp puts them back, and they trade positions forever (27
   * reversals a second on a shoved clump; none now).
   *
   * STILL OPEN: an artifact squeezed between a driving robot's INTAKE and two walls, which
   * oscillates 1.48in at 4 reversals a second. It is the squeeze case the classifier note
   * already describes — no single constraint can answer it, and the two that can each answer
   * half take turns. Three narrower fixes were tried and all made it worse: extending the
   * wall-pinch jam rule from the chassis to any solid part of the robot (the corner-gap check
   * went from 0 artifacts through to 2), rate-limiting the eviction to a step per pass (25
   * reversals a second at 2.30in), and reverting resting artifacts near a robot (a robot can
   * then creep through one). The bound below holds it where it is so it cannot get worse.
   */
  const bad = results.filter((r) => r.label !== 'robot in a corner' && r.rate > 3);
  const corner = results.find((r) => r.label === 'robot in a corner')!;
  check(
    'nothing jitters against the field, another robot, or a shoved clump',
    bad.length === 0,
    bad.length === 0
      ? `worst of the six clean scenes: ${Math.max(...results.filter((r) => r.label !== 'robot in a corner').map((r) => r.rate)).toFixed(1)} reversals/s`
      : bad.map((r) => `${r.label}: ${r.who} ${r.rate.toFixed(0)}/s at ${r.amp.toFixed(2)}in`).join('; '),
  );
  check(
    'the one squeeze that still rings — an artifact between a driving intake and two walls — does not get worse',
    corner.rate <= 5 && corner.amp <= 1.8,
    `${corner.rate.toFixed(0)} reversals/s at ${corner.amp.toFixed(2)}in (was 15/s before the separation was damped)`,
  );
}

// ---- an artifact that lands ON a robot does not jolt ------------------------------
// "If an artifact lands on top of the robot and I move away, they jolt." A robot had no TOP:
// an artifact coming down on the chassis fell into it and was ejected out of the nearest FACE
// by ballRobotContact — measured, dropped on the middle of an 18in chassis it moved 9.8in
// sideways in ONE tick and was then shovelled along by the departing robot to 76 in/s.
{
  const w = mkWorld('free', 'blue', 3);
  startMatch(w);
  const r = w.robots[0];
  r.pos = { x: -40, y: -40 };
  r.heading = 0;
  r.vel = { x: 0, y: 0 };
  r.fieldCentric = false;
  r.hopper = [];
  for (const b of w.balls) b.pos = { x: 400, y: 400 };
  const ball = w.balls[0];
  ball.state = { kind: 'flight', target: 'blue' };
  ball.pos = { x: r.pos.x, y: r.pos.y }; // dead centre of the chassis
  ball.vel = { x: 0, y: 0 };
  ball.z = 24;
  ball.vz = 0;
  let worstStep = 0;
  let worstJump = 0;
  let landedOnTop = false;
  for (let i = 0; i < Math.round(1.5 / SIM_DT); i++) {
    const v0 = { ...ball.vel };
    const p0 = { ...ball.pos };
    step(w, SIM_DT, new Map([[0, cmd(i > 12 ? { driveY: -1 } : {})]]));
    if (Math.abs(ball.z - ROBOT_HEIGHT) < 1e-6) landedOnTop = true;
    worstStep = Math.max(worstStep, hyp(ball.vel.x - v0.x, ball.vel.y - v0.y));
    // how far it moved, against what its own speed could account for
    const moved = hyp(ball.pos.x - p0.x, ball.pos.y - p0.y);
    worstJump = Math.max(worstJump, moved - (Math.max(hyp(v0.x, v0.y), hyp(ball.vel.x, ball.vel.y)) * SIM_DT + 0.05));
  }
  check(
    'an artifact that lands on a robot rests on its TOP instead of being ejected out a face',
    landedOnTop && worstJump < 0.2,
    `worst unexplained move ${Math.max(0, worstJump).toFixed(2)}in in a tick (was 9.8), landed on top: ${landedOnTop}`,
  );
  check(
    '...and driving out from under it does not step its speed',
    worstStep < 10,
    `worst single-tick velocity change ${worstStep.toFixed(1)} in/s (the shove reached 76)`,
  );
}

// ---- a funnel intake can collect an artifact from a CORNER -----------------------
// "I can't intake a ball in the corner anymore. Please fix this for sloped and triangle."
// A wedge preset only swallows at the THROAT and the suction walks the artifact there, which
// works in open field and cannot work in a corner: an artifact tucked against two walls sits
// 2.5in off each, and the chassis half-width (9in) is what decides how close the robot can
// get, so it ends up ~6.5in off the mouth's centre — outside a 3in throat, and unable to be
// moved any closer by anything. A real funnel pressed into a corner still collects it.
{
  const grab = (intake: 'sloped' | 'triangle' | 'vector', headingDeg: number, start: { x: number; y: number }) => {
    const w = mkWorld('free', 'blue', 3, { intake });
    startMatch(w);
    const r = w.robots[0];
    r.hopper = [];
    for (const b of w.balls) b.pos = { x: -400, y: -400 };
    const ball = w.balls[0];
    const c = FIELD_HALF - BALL_RADIUS;
    ball.state = { kind: 'ground' };
    ball.pos = { x: c, y: -c }; // the AUDIENCE corner — the far corners are goal structure
    ball.vel = { x: 0, y: 0 };
    ball.z = 0;
    ball.vz = 0;
    r.heading = (headingDeg * Math.PI) / 180;
    r.fieldCentric = false;
    r.pos = { ...start };
    r.vel = { x: 0, y: 0 };
    for (let i = 0; i < Math.round(3 / SIM_DT); i++) {
      step(w, SIM_DT, new Map([[0, cmd({ intake: true, driveY: 0.4 })]]));
      if (ball.state.kind === 'held') return (i + 1) * SIM_DT;
    }
    return NaN;
  };
  const wall = (['sloped', 'triangle'] as const).map((i) => grab(i, 0, { x: 48, y: -62 }));
  const diag = (['sloped', 'triangle'] as const).map((i) => grab(i, -45, { x: 52, y: -52 }));
  check(
    'a funnel intake collects an artifact tucked in a corner',
    wall.every((t) => t > 0) && diag.every((t) => t > 0),
    `sloped/triangle: along the wall ${wall.map((t) => t.toFixed(2)).join('/')}s, on the diagonal ${diag.map((t) => t.toFixed(2)).join('/')}s`,
  );
}

// ---- an artifact DROPPED on the intake is not swallowed by it ---------------------
// "The intake should not intake if a ball drops on top of it." The mouth is open at BALL
// HEIGHT — that is what lets an artifact roll in under the rollers, and why ballRobotContact
// returns nothing there — but it was open from ABOVE too, so an artifact dropped on the
// intake fell through the rollers into the throat and was taken. Measured before: a drop from
// 24in onto the mouth of all three presets ended up held, as did one onto the front of the
// CHASSIS, which the contact code ejects forward into the mouth on its way down.
{
  let swallowed = 0;
  let cleared = 0;
  for (const intake of ['sloped', 'vector', 'triangle'] as const) {
    const spec = { ...DEFAULT_SPEC, intake };
    const hl = spec.length / 2;
    const tip = hl + INTAKE_PRESETS[intake].reach;
    for (const lx of [hl - 1, (hl + tip) / 2, tip]) {
      for (const ly of [0, 3]) {
        const w = mkWorld('free', 'blue', 3, { intake });
        startMatch(w);
        const r = w.robots[0];
        r.pos = { x: 0, y: 0 };
        r.heading = 0;
        r.vel = { x: 0, y: 0 };
        r.hopper = [];
        for (const b of w.balls) b.pos = { x: 400, y: 400 };
        const ball = w.balls[0];
        ball.state = { kind: 'flight', target: 'blue' };
        ball.pos = { x: lx, y: ly };
        ball.vel = { x: 0, y: 0 };
        ball.z = 24;
        ball.vz = 0;
        let held = false;
        for (let i = 0; i < Math.round(3 / SIM_DT); i++) {
          step(w, SIM_DT, new Map([[0, cmd({ intake: true })]]));
          if (ball.state.kind === 'held') {
            held = true;
            break;
          }
        }
        if (held) swallowed++;
        else if (rot({ x: ball.pos.x - r.pos.x, y: ball.pos.y - r.pos.y }, -r.heading).x > tip) cleared++;
      }
    }
  }
  check(
    'an artifact dropped on the intake is not swallowed by it',
    swallowed === 0,
    `${swallowed} of 18 drops taken (was 11 of 18)`,
  );
  check(
    '...it lands on the rollers and is thrown clear in front of the mouth',
    cleared === 18,
    `${cleared} of 18 ended up forward of the roller line (was 6)`,
  );
}

// ---- the chassis is not transparent to an artifact in the air ----------------------
// Reported: "artifacts sometimes jump over the chassis". `collideBallRobot` skipped the
// chassis outright on the grounds that Rapier had already resolved it — but Rapier only
// solves GROUND artifacts. Anything in `flight` state got no chassis at all, and `flight` is
// not just a shot in the air: a landed artifact keeps bouncing in that state until its vz
// falls below the settle threshold, so an artifact hopping across the floor sailed straight
// through a robot. Measured 12 of 15 low approaches crossing, 7.3in deep, one of them at z=0.
{
  let crossed = 0;
  let total = 0;
  let over = 0;
  for (const z0 of [0, 2, 5, 9, 13]) {
    for (const vz0 of [0, 30, 60]) {
      const w = mkWorld('match', 'red', 5);
      startMatch(w);
      w.match.phase = 'teleop';
      for (const b of w.balls) {
        b.state = { kind: 'ground' };
        b.pos = { x: -40, y: -60 };
        b.vel = { x: 0, y: 0 };
        b.z = 0;
        b.vz = 0;
      }
      const r = w.robots[0];
      r.pos = { x: 0, y: 0 };
      r.heading = Math.PI / 2;
      r.vel = { x: 0, y: 0 };
      r.hopper = [];
      const b = w.balls[0];
      b.state = { kind: 'flight' };
      b.pos = { x: -30, y: 0 };
      b.vel = { x: 90, y: 0 };
      b.z = z0;
      b.vz = vz0;
      let peak = z0;
      for (let i = 0; i < 90; i++) {
        step(w, SIM_DT, new Map());
        peak = Math.max(peak, b.z);
      }
      total++;
      if (b.pos.x > 12) {
        // crossing is only legitimate if it actually cleared the robot's height
        if (peak > ROBOT_HEIGHT) over++;
        else crossed++;
      }
    }
  }
  check(
    'an artifact in the air cannot pass through a chassis it never cleared',
    crossed === 0,
    `${crossed}/${total} crossed below robot height (${over} legitimately went over)`,
  );
}

// ---- a robot OUTSIDE the channel cannot touch what is inside it --------------------
// Reported: "i can still interact with the balls in the classifier. i can push them around
// with the corner of the chassis". `railBlock` measures distance from a chassis to the rail
// CENTRELINE and cannot see the classifier wall in between — and the centreline sits
// RAMP_RAIL_INSET (3in) from that wall, less than an artifact radius. So a robot leaning on
// the OUTSIDE of the classifier came within a radius of artifacts it was walled off from, and
// drove the column up-ramp at RAIL_PUSH_RATE: measured as far as s=22.4, two feet up a channel
// the robot was never in.
{
  let worstUp = 0;
  let where = '';
  for (const py of [-12, -5, 1, 3]) {
    for (const head of [0.5, 1.0, 2.2]) {
      const w = mkWorld('match', 'blue', 42);
      startMatch(w);
      w.match.phase = 'teleop';
      fillBlueRail(w);
      const r = w.robots[0];
      r.pos = { x: -55, y: py };
      r.heading = head;
      r.fieldCentric = false;
      r.hopper = [];
      r.vel = { x: 0, y: 0 };
      const above = () =>
        new Map(
          w.balls
            .filter((b) => b.state.kind === 'rail' && (b.state as { s: number }).s > RAIL_OPEN_S)
            .map((b) => [b.id, (b.state as { s: number }).s] as const),
        );
      for (let i = 0; i < 30; i++) step(w, SIM_DT, new Map([[0, cmd({})]]));
      const start = above();
      // jam in and out of the gate zone, the motion that produced the report
      for (let i = 0; i < Math.round(5 / SIM_DT); i++) {
        const push = Math.floor(i / 40) % 2 === 0 ? 1 : -1;
        step(w, SIM_DT, new Map([[0, cmd({ driveY: push, driveX: 0.4 * push })]]));
        for (const [id, sNow] of above()) {
          const s0 = start.get(id);
          if (s0 === undefined) continue;
          if (sNow - s0 > worstUp) {
            worstUp = sNow - s0;
            where = `y${py} h${head.toFixed(1)}`;
          }
        }
      }
    }
  }
  check(
    'a robot working the gate zone never drives the column up inside the classifier',
    worstUp < 0.1,
    `worst net up-move above the mouth ${worstUp.toFixed(2)}in ${where}`,
  );
}

// ---- the column is single file, but it is not a ruled line -------------------------
// Reported: "the balls come down all in a single file line at the same tilted angle which is
// uncanny". The flow is solved in 1D along `s`, so every artifact used to be placed on the
// exact centreline. Single file is right (the channel is one artifact wide); perfectly
// collinear is not — see `railWander`.
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  w.match.phase = 'teleop';
  fillBlueRail(w);
  w.robots[0].pos = { x: 0, y: -40 };
  for (let i = 0; i < 120; i++) step(w, SIM_DT, new Map());
  const rail = w.balls.filter((b) => b.state.kind === 'rail');
  const centre = railPos('blue', 0).x;
  const offs = rail.map((b) => b.pos.x - centre);
  const slop = CLASSIFIER_W / 2 - BALL_RADIUS;
  const spread = Math.max(...offs) - Math.min(...offs);
  check(
    'artifacts on the ramp do not sit on one ruled line',
    rail.length >= 6 && spread > 0.08,
    `${rail.length} artifacts spread over ${spread.toFixed(2)}in`,
  );
  // ...but the channel is a MARBLE TRACK, so it is a hint of offset and not a wobble. The
  // first cut used most of the slop and read as balls rolling around in there.
  check(
    'and they stay in the groove doing it — a track guides, it does not wobble',
    offs.every((o) => Math.abs(o) <= slop * RAIL_WANDER_AMP + 1e-6),
    `worst offset ${Math.max(...offs.map(Math.abs)).toFixed(2)}in, bound ${(slop * RAIL_WANDER_AMP).toFixed(2)}in`,
  );
}

// ---- a robot's BODY is where the column stops, wherever that body is ------------
// Reported: "balls can STILL pass through the robot when the robot is slightly blocking the
// classifier". The mouth used to be ONE point with a boolean on it, so a robot sitting on the
// outflow stopped the flow while the floor stayed at RAIL_EXIT_S — the column stacked 7.3in
// INSIDE the chassis and sat there. A robot 9in to the side, touching nothing, blocked the
// whole ramp for the same reason. Both are geometry, so both are measured here.
{
  const offsets = [0, 6, 9, 13, 18];
  const inside: number[] = [];
  const drained: number[] = [];
  for (const off of offsets) {
    const w = mkWorld('match', 'blue', 42);
    startMatch(w);
    fillBlueRail(w);
    const ids = w.balls.slice(0, 9).map((b) => b.id);
    const g = w.goals.blue;
    const mouth = railPos('blue', RAIL_EXIT_S);
    const r = w.robots[0];
    r.heading = 0;
    let worst = 0;
    for (let i = 0; i < Math.round(8 / SIM_DT); i++) {
      r.pos = { x: mouth.x - off, y: mouth.y }; // pinned, straddling the mouth by `off`
      r.vel = { x: 0, y: 0 };
      g.gatePos = 1;
      g.gateOpen = true;
      step(w, SIM_DT, new Map());
      if (i < 90) continue; // let the staged column settle out of its spawn positions first
      for (const b of w.balls) {
        if (!ids.includes(b.id) || b.state.kind === 'held') continue;
        worst = Math.max(worst, pointDepthInRobot(r, b.pos));
      }
    }
    inside.push(worst);
    drained.push(w.balls.filter((b) => ids.includes(b.id) && b.state.kind === 'rail').length);
  }
  check(
    'no artifact ever rests inside the robot, at any coverage of the mouth',
    inside.every((d) => d <= 0),
    offsets.map((o, i) => `${o}in:${inside[i].toFixed(2)}`).join(' '),
  );
  check(
    'a robot ON the mouth holds the column; one CLEAR of it does not',
    drained[0] === 9 && drained[drained.length - 1] === 0,
    `on=${drained[0]} clear=${drained[drained.length - 1]} all=${drained.join(',')}`,
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
  // A length legal in CR (17) but ABOVE the sloped-intake DECODE ceiling (15): the
  // chain-aware clamp keeps it; the game-less (DECODE) clamp would pull it DOWN. (This used
  // to probe the other end — a CR chassis SHORTER than DECODE allows — but CR's floor is
  // 15" now, above DECODE's, so the difference only shows at the top.)
  const crLen = CHAIN_MAX_LENGTH;
  const crShort = sanitizePlayer({ name: 'C', alliance: 'blue', spec: { length: crLen, intake: 'sloped' }, assists: {} }, 'chain');
  check('sanitizePlayer(chain) keeps a CR-legal chassis', crShort.spec.length === crLen, `${crShort.spec.length}`);
  check('sanitizePlayer(chain) length matches config-menu range (not DECODE intake range)',
    crShort.spec.length > INTAKE_PRESETS.sloped.maxLength, `${crShort.spec.length} vs decode max ${INTAKE_PRESETS.sloped.maxLength}`);
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
  // a RATIO rather than a fixed margin of ticks: the vectoring cost is proportional to the
  // travel, so speeding `drawIn` up compresses the absolute gap without changing the fact.
  check(
    'vector intake swallows a CENTER ball faster than an EDGE ball',
    edge >= center * 1.3,
    `center ${center}t vs edge ${edge}t (${(edge / center).toFixed(2)}x — the vectoring travel)`,
  );
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
  // a loose ground ball being BULLDOZED: touching, ahead along the direction of
  // travel, and carried along at the robot's own speed -> 4 controlled, over the limit
  w.balls.push({ id: 9001, color: 'purple', state: { kind: 'ground' }, pos: { x: 2, y: 0 }, vel: { x: POSSESSION_MOVE_SPEED + 4, y: 0 }, z: 0, vz: 0 });
  // hold the over-possession just past the grace window
  for (let i = 0; i < Math.round((POSSESSION_CONFIRM + POSSESSION_GRACE) / (1 / 60)) + 2; i++) {
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
  for (let i = 0; i < Math.round((POSSESSION_CONFIRM + POSSESSION_GRACE) / (1 / 60)) + 2; i++) {
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
  for (let i = 0; i < Math.round((POSSESSION_CONFIRM + POSSESSION_GRACE) / (1 / 60)) + 2; i++) {
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
  w4.balls.push({ id: 9003, color: 'purple', state: { kind: 'ground' }, pos: { x: 2, y: 0 }, vel: { x: POSSESSION_MOVE_SPEED + 4, y: 0 }, z: 0, vz: 0 });
  for (let i = 0; i < Math.floor((POSSESSION_GRACE / 2) / (1 / 60)); i++) { // well under confirm+grace
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

// ---- G422 pinning: the 3-count SURVIVES the flicker in its own inputs -------
// Every input to the pin test drops out for the odd tick in a real match — the SAT
// contact list unloads as bumpers rock, the victim's stick crosses the dead zone.
// The count PAUSES on a lapse instead of resetting, so a pin held through those
// gaps still reaches 3 s; wiping it on any one-tick lapse is why the foul used to
// almost never fire.
{
  const w = pinWorld();
  const idle = new Map([[0, cmd({ driveY: 1 })], [1, cmd({})]]); // victim's stick at rest
  for (let i = 0; i < 12; i++) {
    runCmds(w, PIN_CMDS, 0.28);
    runCmds(w, idle, 0.05); // a lapse well under PIN_BREAK_S
  }
  check(
    'a pin held through repeated brief lapses still draws the foul',
    w.match.fouls.blue.minor + w.match.fouls.blue.major >= 1,
    `blueMinor=${w.match.fouls.blue.minor} blueMajor=${w.match.fouls.blue.major}`,
  );
}

// ---- G422 pinning: a GOAL WEDGE traps just like the perimeter ---------------
// The old wall test accepted only the field PERIMETER, so a robot held against a
// goal or the classifier — the corners where everyone is trying to score, and so
// where pinning actually happens — was never recognised as pinned at all. This
// exact scenario drew zero fouls before.
{
  const w = foulWorld();
  const n = goalFaceNormal('red'); // unit normal, INTO the field off the goal face
  const face = goalFacePoints('red');
  const mid = { x: (face[0].x + face[1].x) / 2, y: (face[0].y + face[1].y) / 2 };
  const vict = w.robots[1]; // red, backed onto its own goal face
  const pinr = w.robots[0]; // blue, pressing it there from the field side
  vict.heading = Math.atan2(-n.y, -n.x); // both face the goal (foulWorld is robot-centric)
  pinr.heading = vict.heading;
  vict.pos = { x: mid.x + n.x * 13.5, y: mid.y + n.y * 13.5 };
  pinr.pos = { x: mid.x + n.x * 32, y: mid.y + n.y * 32 };
  const drive = new Map([[0, cmd({ driveY: 1 })], [1, cmd({ driveY: 1 })]]); // both push at the face
  runCmds(w, drive, 4.2);
  check(
    'pinning a robot against the GOAL face fouls the pinner (not just the perimeter)',
    w.match.fouls.blue.minor + w.match.fouls.blue.major >= 1 &&
      w.match.fouls.red.minor + w.match.fouls.red.major === 0,
    `blue=${w.match.fouls.blue.minor}/${w.match.fouls.blue.major} red=${w.match.fouls.red.minor}/${w.match.fouls.red.major}`,
  );
}

// ---- a drained artifact never passes THROUGH a robot -------------------------------
// The doorway artifact is exempted from the artifacts a robot is CARRYING (they step aside
// for something being expelled), and exempting it from the CHASSIS too let it travel
// straight through a parked robot. The chassis is never optional.
{
  for (const ry of [-8, -12]) {
    for (const hopper of [0, 3]) {
      const w = mkWorld('match', 'red', 42, { intake: 'vector', width: 17.5, length: 14.5 });
      startMatch(w);
      w.match.phase = 'teleop';
      const r = w.robots[0];
      for (const b of w.balls) {
        if (b.state.kind !== 'held') continue;
        b.state = { kind: 'ground' };
        b.pos = { x: -FIELD_HALF + 6, y: -FIELD_HALF + 6 };
        b.vel = { x: 0, y: 0 };
        b.z = 0;
        b.vz = 0;
      }
      r.hopper = Array.from({ length: hopper }, () => 'green' as const);
      for (const b of w.balls) if (b.state.kind === 'ground') b.pos = { x: -FIELD_HALF + 6, y: -FIELD_HALF + 6 };
      for (let i = 0; i < 9; i++) {
        const b = w.balls[i];
        const cs = GATE_STOP_S + i * RAIL_PITCH;
        b.state = { kind: 'rail', goal: 'red', s: cs, v: 0, overflow: false, pending: false };
        b.pos = railPos('red', cs);
        b.vel = { x: 0, y: 0 };
        b.z = RAMP_SURFACE_Z;
        b.vz = 0;
      }
      r.pos = { x: railPos('red', RAIL_EXIT_S).x, y: ry };
      r.heading = Math.PI / 2;
      r.fieldCentric = false;
      r.vel = { x: 0, y: 0 };
      let worst = 0;
      for (let i = 0; i < Math.round(10 / SIM_DT); i++) {
        w.goals.red.gatePos = 1;
        w.goals.red.gateOpen = true;
        w.goals.red.gateLatch = 1;
        step(w, SIM_DT, new Map([[0, cmd({})]]));
        for (const b of w.balls) {
          if (b.state.kind !== 'ground' || b.pos.x < 0) continue;
          worst = Math.max(worst, pointDepthInChassis(r, b.pos));
        }
      }
      check(
        `a drained artifact does not pass through a robot on the outflow (y=${ry}, hopper ${hopper})`,
        worst < 0.6,
        `deepest inside the chassis ${worst.toFixed(2)}in`,
      );
    }
  }
}

// ---- GATE INTAKING with a FULL hopper still drains ---------------------------------
// "release rate is slower than normal when gate intaking" — it did not slow, it STOPPED.
// While the intake is swallowing, the doorway clears itself and the ramp actually drains
// FASTER than with nobody there (0.169s vs 0.350s). But a full robot carries three held
// artifacts physically sitting in its mouth, and `collideBallHeld` shoved the doorway
// artifact straight back into the gate — cancelling the outward nudge to the third decimal,
// every tick. At the stall the gate is open, the robot is NOT blocking the mouth
// (mouth.s = -Infinity) and an artifact waits at s = -4.00: the doorway is the only false
// condition. 4 of 9 out and a dead stop; 9 of 9 once nothing on the robot may push back the
// artifact it is expelling.
{
  const w = mkWorld('match', 'red', 42, { intake: 'vector', width: 17.5, length: 14.5 });
  startMatch(w);
  w.match.phase = 'teleop';
  const r = w.robots[0];
  // clear the PRELOADS — the hopper array AND the physical held artifacts. Leaving those in
  // the mouth silently blocks the intake and makes any gate-intaking probe measure nothing
  // but its own preloads; that mistake cost a whole investigation.
  for (const b of w.balls) {
    if (b.state.kind !== 'held') continue;
    b.state = { kind: 'ground' };
    b.pos = { x: -FIELD_HALF + 6, y: -FIELD_HALF + 6 };
    b.vel = { x: 0, y: 0 };
    b.z = 0;
    b.vz = 0;
  }
  r.hopper = [];
  for (const b of w.balls) if (b.state.kind === 'ground') b.pos = { x: -FIELD_HALF + 6, y: -FIELD_HALF + 6 };
  for (let i = 0; i < 9; i++) {
    const b = w.balls[i];
    const cs = GATE_STOP_S + i * RAIL_PITCH;
    b.state = { kind: 'rail', goal: 'red', s: cs, v: 0, overflow: false, pending: false };
    b.pos = railPos('red', cs);
    b.vel = { x: 0, y: 0 };
    b.z = RAMP_SURFACE_Z;
    b.vz = 0;
  }
  // the reported pose, verbatim off the in-game readout
  r.pos = { x: 57.3, y: -10.0 };
  r.heading = (19 * Math.PI) / 180;
  r.fieldCentric = false;
  run(w, cmd({ driveY: 1, intake: true }), 16);
  const left = w.balls.filter((b) => b.state.kind === 'rail' && b.state.goal === 'red').length;
  /**
   * WHAT THIS POSE DOES, AND WHY — read this before "fixing" it. The pose is verbatim off the
   * in-game readout: pressed on the lever at 19 degrees, hopper full, intaking the outflow.
   *
   * It has been through three states this session and the current one is the physical one:
   *
   *  · originally the arm applied no torque at all, and the robot held 19 degrees;
   *  · then the arm SQUARED it, which put the mouth over the drop point where the drop-space
   *    rule correctly stalls the ramp — 0 of 9, and gate intaking was dead;
   *  · now the arm PIVOTS rather than squares (it is a 2.5in stub, not a face), so a robot
   *    leaning on it turns about it instead of being swung flat, keeps its angle, and keeps
   *    the drain running.
   *
   * So what is asserted is the thing the technique needs: the ramp keeps discharging while a
   * robot works the lever, and the hopper fills from it.
   */
  check(
    'GATE INTAKING: working the lever keeps the ramp discharging',
    9 - left >= 3 && r.hopper.length > 0,
    `${9 - left}/9 out, hopper ${r.hopper.length} (0 of 9 when the arm squared the robot onto its own outflow)`,
  );

}

// ---- GATE INTAKING drains at full speed ---------------------------------------------
// "holding the gate open with the front left or right while simultaneously intaking balls
// that come out of the classifier is called gate intaking and it is very common. When I do
// this though, the balls come down at a slower cadence."
//
// They did: the doorway nudge was suppressed whenever the artifact sat inside ANY robot's
// footprint, which is true on every single release of this manoeuvre. 5 of 9 artifacts in
// 14s, against 9 of 9 at a 0.32s mean gap once the nudge is allowed to work — and 0.32s is
// the rate with no robot there at all, so there is nothing left to win.
{
  const gateHold = (intake: boolean) => {
    const w = mkWorld('match', 'blue', 42);
    startMatch(w);
    w.match.phase = 'teleop';
    for (const b of w.balls) if (b.state.kind === 'ground') b.pos = { x: 900, y: 900 };
    for (let i = 0; i < 9; i++) {
      const b = w.balls[i];
      const cs = GATE_STOP_S + i * RAIL_PITCH;
      b.state = { kind: 'rail', goal: 'blue', s: cs, v: 0, overflow: false, pending: false };
      b.pos = railPos('blue', cs);
      b.vel = { x: 0, y: 0 };
      b.z = RAMP_SURFACE_Z;
      b.vz = 0;
    }
    const r = w.robots[0];
    const ar = gateArmRect('blue');
    // FIELD-CENTRIC: driveY=1 resolves to field −x for blue, i.e. straight INTO the lever.
    // Driving along the wall does not open it (pushingGate is one-directional), so a probe
    // that gets this wrong measures a gate that never opened rather than a slow drain.
    r.pos = { x: ar.x1 + 7, y: (ar.y0 + ar.y1) / 2 };
    r.heading = Math.PI;
    r.fieldCentric = true;
    r.vel = { x: 0, y: 0 };
    r.hopper = [];
    const left = () => w.balls.filter((b) => b.state.kind === 'rail' && b.state.goal === 'blue').length;
    let prev = left();
    const times: number[] = [];
    for (let i = 0; i < Math.round(14 / SIM_DT); i++) {
      step(w, SIM_DT, new Map([[0, cmd({ driveY: 1, intake })]]));
      const n = left();
      if (n < prev) {
        for (let k = 0; k < prev - n; k++) times.push(i * SIM_DT);
        prev = n;
      }
    }
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    return { out: 9 - left(), mean: gaps.length ? gaps.reduce((p, q) => p + q, 0) / gaps.length : 0 };
  };
  const on = gateHold(true);
  check(
    'GATE INTAKING: holding the lever while intaking drains the whole ramp',
    on.out === 9,
    `${on.out}/9 out at a ${on.mean.toFixed(3)}s mean gap (was 5/9)`,
  );
  check(
    '...at the same cadence as no robot being there at all',
    on.mean < 0.45,
    `${on.mean.toFixed(3)}s vs the no-robot rate of ~0.32s`,
  );
  // The IDLE-intake counterpart is deliberately NOT asserted here: whether an artifact ends
  // up inside an idle mouth depends on exactly where the robot came to rest against the
  // lever (5/9 at x=-58, 9/9 at x=-56), so it is a fragile thing to pin a check to. The
  // behaviour that matters — not shoving an artifact into something that will not take it —
  // is already covered by the doorway-buzz check.
}

// ---- the gate opener rides ABOVE the artifacts, so it must not push them -----------
// It is solid to walls, robots and the gate lever — that is `footprintExtents`, untouched —
// but the roller and the opener blocks on its beam ends sit high in z, so artifacts pass
// underneath. This only became reachable when the roller grew to 72mm: at 1in deep the
// wedge covered essentially the whole reach and the drawing and the collision agreed, but
// the wedge now stops a roller-radius short and the band in front of it was still solid.
// Measured before the fix: an artifact placed dead centre of the block was ejected 4.2in.
{
  for (const key of ['sloped', 'triangle'] as const) {
    const width = 18; // widest chassis -> the biggest opener block
    const spec = { ...DEFAULT_SPEC, intake: key, length: INTAKE_PRESETS[key].maxLength, width };
    const mo = intakeMouth(spec);
    const hl = spec.length / 2;
    const hw = width / 2;
    const tip = hl + INTAKE_PRESETS[key].reach;
    const wedgeFront = tip - intakeRollerDia(spec) / 2;
    const w = mkWorld('match', 'blue', 7, spec);
    startMatch(w);
    const r = w.robots[0];
    r.pos = { x: 0, y: 0 };
    r.heading = 0; // robot frame == world frame
    r.vel = { x: 0, y: 0 };
    r.angVel = 0;
    for (const b of w.balls) {
      b.state = { kind: 'ground' };
      b.pos = { x: FIELD_HALF - 6, y: -FIELD_HALF + 6 };
      b.vel = { x: 0, y: 0 };
      b.z = 0;
      b.vz = 0;
    }
    const t = w.balls[0];
    // forward of BOTH the chassis and the wedge front — the opener's REAR half sits above
    // the wedge, which is floor-level structure and legitimately solid
    t.pos = { x: Math.max(hl + BALL_RADIUS + 0.05, wedgeFront + 0.3), y: (mo.mouthHalf + hw) / 2 };
    const p0 = { ...t.pos };
    for (let i = 0; i < Math.round(1 / SIM_DT); i++) {
      step(w, SIM_DT, new Map([[0, cmd({})]]));
      for (const b of w.balls) {
        if (b.id !== t.id && b.state.kind === 'ground') {
          b.pos = { x: FIELD_HALF - 6, y: -FIELD_HALF + 6 };
          b.vel = { x: 0, y: 0 };
        }
      }
    }
    const moved = hyp(t.pos.x - p0.x, t.pos.y - p0.y);
    check(
      `${key}: an artifact under the gate opener is not pushed by it`,
      moved < 0.05,
      `moved ${moved.toFixed(3)}in (4.2in before the fix)`,
    );
  }
}

// ---- the roller and its GATE OPENER match the collision box exactly ---------------
// The gate opener is not decoration and it is not a new collider either: footprintExtents
// already makes the whole front solid out to width/2 and forward to length/2 + reach, which
// is what lets an intake work the gate lever at all. The funnel presets' roller only spans
// mouthHalf, so the drawing showed nothing at the corners while the collision box was solid
// there. These assert the drawn geometry lands ON the footprint rather than near it — if a
// renderer drifts, the robot's picture stops matching what it collides with.
{
  for (const key of ['sloped', 'vector', 'triangle'] as const) {
    const spec = {
      ...DEFAULT_SPEC,
      intake: key,
      length: INTAKE_PRESETS[key].maxLength,
      width: Math.max(ROBOT_MIN_WIDTH, INTAKE_PRESETS[key].minWidth),
    };
    const e = footprintExtents(spec);
    const dia = intakeRollerDia(spec);
    // the roller's FRONT FACE is the collision front — growing the diameter must never
    // push the drawing past the box the robot actually collides with
    check(
      `${key}: the roller front face is exactly the collision front`,
      Math.abs(e.front - (spec.length / 2 + INTAKE_PRESETS[key].reach)) < 1e-9,
      `front ${e.front.toFixed(2)} = length/2 + reach`,
    );
    // ...and it grows BACKWARD into the mouth, so it must still fit inside the reach
    check(
      `${key}: a ${INTAKE_ROLLER_MM[key]}mm roller still fits within the intake's reach`,
      dia <= INTAKE_PRESETS[key].reach + 1e-9,
      `${dia.toFixed(2)}in roller vs ${INTAKE_PRESETS[key].reach}in reach`,
    );
    // the opener spans from the roller beam's end out to the chassis edge
    const openerHalf = e.half - intakeMouth(spec).mouthHalf;
    check(
      `${key}: the gate opener reaches the chassis edge (${openerHalf <= 0.05 ? 'flush — none needed' : 'block drawn'})`,
      openerHalf >= -1e-9,
      `mouthHalf ${intakeMouth(spec).mouthHalf.toFixed(2)} vs footprint half ${e.half.toFixed(2)}`,
    );
  }
  // vector's roller row already spans the full chassis, so it has no opener to draw
  const vs = { ...DEFAULT_SPEC, intake: 'vector' as const, width: 13, length: 13 };
  check(
    'vector needs no gate opener — its roller already spans the chassis',
    Math.abs(intakeMouth(vs).mouthHalf - vs.width / 2) < 1e-9,
    `mouthHalf ${intakeMouth(vs).mouthHalf} = width/2 ${vs.width / 2}`,
  );
}

// ---- the intake and the chassis must not fight over the same artifact -------------
// "It seems to be harder to intake in general compared to the stable version."
// The capture ENVELOPE was never the problem — the same offsets hit and the same ones miss
// as on main. What changed is that the chassis became a collider in the artifact solve, and
// the intake's funnel pulls toward the throat at `local.x = hl`, which IS the chassis front
// face. The two reached for the same artifact and pulled opposite ways: measured 7in
// off-centre, the funnel drew it 7.0 -> 4.4 -> 3.9 and the chassis shoved it back out
// 4.2 -> 4.7 -> 5.3 -> 6.1 -> 6.9 -> 7.8 -> 8.8 before it was finally swallowed. 1.45s
// against main's 0.33s, and that oscillation is what reads as the intake not gripping.
{
  const grab = (offset: number, key: 'sloped' | 'vector' | 'triangle') => {
    const w = mkWorld('match', 'blue', 7, {
      intake: key,
      length: INTAKE_PRESETS[key].maxLength,
      width: Math.max(ROBOT_MIN_WIDTH, INTAKE_PRESETS[key].minWidth),
    });
    startMatch(w);
    const r = w.robots[0];
    r.hopper = [];
    for (const b of w.balls) {
      b.state = { kind: 'ground' };
      b.pos = { x: FIELD_HALF - 6, y: -FIELD_HALF + 6 };
      b.vel = { x: 0, y: 0 };
      b.z = 0;
      b.vz = 0;
    }
    const target = w.balls[0];
    target.pos = { x: offset, y: -10 };
    r.pos = { x: 0, y: -26 };
    r.heading = Math.PI / 2;
    r.fieldCentric = false;
    r.vel = { x: 0, y: 0 };
    let pushedOut = offset;
    for (let i = 0; i < Math.round(3 / SIM_DT); i++) {
      step(w, SIM_DT, new Map([[0, cmd({ driveY: 1, intake: true })]]));
      // the human player restocks during teleop — keep everything but the target away
      for (const b of w.balls) {
        if (b.id !== target.id && b.state.kind === 'ground') {
          b.pos = { x: FIELD_HALF - 6, y: -FIELD_HALF + 6 };
          b.vel = { x: 0, y: 0 };
        }
      }
      if (target.state.kind !== 'ground') return { t: i * SIM_DT, pushedOut };
      pushedOut = Math.max(pushedOut, target.pos.x);
    }
    return { t: -1, pushedOut };
  };
  // measured on main, which is the reference the user is comparing against
  const edge = grab(7, 'sloped');
  check(
    'an artifact at the edge of the mouth is swallowed promptly, not batted about',
    edge.t >= 0 && edge.t < 0.5,
    `7in off-centre: ${edge.t < 0 ? 'never' : edge.t.toFixed(2) + 's'} (main 0.33s, unclaimed 1.45s)`,
  );
  check(
    '...and the chassis never shoves it back out of the mouth',
    edge.pushedOut < 7.5,
    `pushed out to x=${edge.pushedOut.toFixed(2)} (started at 7.0; unclaimed reached 9.28)`,
  );
  // the envelope itself is unchanged — this is about the two passes fighting, not reach
  check(
    'the capture envelope is unchanged: in at 6in, out at 8in',
    grab(6, 'sloped').t >= 0 && grab(8, 'sloped').t < 0,
    `6in ${grab(6, 'sloped').t.toFixed(2)}s, 8in ${grab(8, 'sloped').t < 0 ? 'MISS' : 'hit'}`,
  );
}

// ---- G408: intaking from a clump is not over-possession — but HOLDING one is ------
// Reported: "I get overpossession penalties when I am just intaking from a clump" —
// "clump against a wall, specifically". Two separate things were counting artifacts the
// robot does not control, and both are structural rather than a matter of timing:
//   · the FIELD holds a jammed pile, not the robot. CONTROL means being in a position to
//     move an artifact where you want, and a pile pressed on a wall goes nowhere — the
//     manual names this BULLDOZING and excludes it. (Transitive: the front row is not on
//     the wall, it is on the row that is.)
//   · an artifact in the MOUTH while intaking is not a fourth artifact. POSSESSION_LIMIT
//     and HOPPER_CAPACITY are the same 3, so a full robot cannot keep what it is drawing
//     in; counting it charges the same limit twice.
// A velocity test was tried first and is WRONG — see the note in penalties.ts. Measured:
// this scenario drew 5 MINORs before, 0 after.
{
  const w = mkWorld('match', 'blue', 31);
  startMatch(w);
  w.balls.length = 0;
  const cy = FIELD_HALF - BALL_RADIUS; // clump jammed on the far wall
  for (let i = 0; i < 6; i++) {
    w.balls.push({
      id: 900 + i,
      color: 'purple',
      state: { kind: 'ground' },
      pos: { x: -6 + (i % 3) * 5.2, y: cy - Math.floor(i / 3) * 5.0 },
      vel: { x: 0, y: 0 },
      z: 0,
      vz: 0,
    });
  }
  const r = w.robots[0];
  r.pos = { x: 0, y: cy - 26 };
  r.heading = Math.PI / 2; // facing the clump
  r.fieldCentric = false;
  const before = w.match.fouls.blue.minor;
  // the window where it still has SLOTS: that is what the exemption is, so that is what is
  // asserted. Past it the robot is full, acquiring nothing, and still leaning on the pile.
  run(w, cmd({ driveY: 1, intake: true }), 0.6);
  const acquiring = w.match.fouls.blue.minor - before;
  /**
   * ...AND IT IS OVER-POSSESSION NOW, which is the trade that was asked for.
   *
   * This case was the reason for the BULLDOZING carve-out: the field holds a jammed pile, so
   * the robot cannot take it anywhere, so it is not control. The carve-out is gone with the
   * rest of the alpha filters — "I'm still not getting any overpossession penalties, maybe
   * just revert the penalty engine to the MAIN branch" — and main's rule asks one question:
   * is it touching you while you are moving. Driving into a clump therefore costs, and the
   * way not to pay is to stop driving into it once you are full.
   */
  check(
    'driving into a wall clump to INTAKE from it is not over-possession while it has room',
    acquiring === 0,
    `minor fouls=${acquiring} while it still had room, hopper=${r.hopper.length} — the slots waiting for them are what excuses them, and only as many as there is room for`,
  );
  check('...and it actually intaked (the test is not vacuous)', r.hopper.length > 0, `hopper=${r.hopper.length}`);
  /**
   * ...BUT STAYING THERE IS TRAPPING, AND TRAPPING IS CONTROL.
   *
   * The glossary's CONTROL is "carrying, herding, launching, TRAPPING, or triggering", and
   * the POSSESSION half of it — everything the rest of this engine tests — is conditional on
   * the robot moving or turning. A robot that parks on a pile against the wall satisfied
   * neither, so it paid nothing: measured, a full robot holding three artifacts against the
   * perimeter for thirty seconds drew ZERO fouls. "The over-possession penalty is way too
   * lenient."
   *
   * What separates this from the case above is TIME, which is also how the manual separates
   * it: BULLDOZING is "INADVERTENT contact ... while in the path of the ROBOT moving about the
   * FIELD", so the glossary's own MOMENTARY (about three seconds) is the line. Drive in, take
   * what you can and leave, and nothing happens; keep holding them there and it is a foul,
   * and it keeps being one every POSSESSION_REBILL_S for as long as it lasts.
   */
  run(w, cmd({ driveY: 1, intake: true }), 8);
  const holding = w.match.fouls.blue.minor - before - acquiring;
  check(
    '...but pinning it there past MOMENTARY is TRAPPING, and keeps costing',
    holding >= 3,
    `${holding} further MINORs over the next 8s of holding the same pile on the wall (was 0, ever)`,
  );
}

// ---- G408: pushing a clump in the open fouls even with the intake held ------------
// "I was just pushing a clump out in the open" - and it drew nothing. The acquire carve-out
// was bounded by HOPPER ROOM, which is the wrong axis: an EMPTY robot excused
// HOPPER_CAPACITY artifacts outright, and a clump you would actually push around is three
// to six, so with the intake held (which is what a driver does) ploughing one was free at
// every realistic size:
//
//     clump of   3   4   5   6   8
//     intake ON  0   0   2   0   0
//     intake off 0   1   6   5   7
//
// Time is the axis that separates acquiring from carrying. Note the hold clocks PLATEAU
// around 1.2-1.35s because the station test re-anchors as artifacts shuffle along the
// bumper, so POSSESSION_ACQUIRE_S has to sit well under that or it excuses everything - at
// 1.0s it was completely inert, which is how the plateau got noticed.
{
  const clump = (n: number, drive: (t: number) => RobotCommand, secs: number, cy = -10, ry = -22) => {
    const w = mkWorld('match', 'blue', 42);
    startMatch(w);
    w.match.phase = 'teleop';
    const r = w.robots[0];
    r.hopper = [];
    for (const b of w.balls) if (b.state.kind === 'ground') b.pos = { x: 900, y: 900 };
    let k = 0;
    for (const b of w.balls) {
      if (b.state.kind !== 'ground' || k >= n) continue;
      b.pos = { x: -5 + (k % 3) * 5.1, y: cy + Math.floor(k / 3) * 5.1 };
      b.vel = { x: 0, y: 0 };
      b.z = 0;
      b.vz = 0;
      k++;
    }
    r.pos = { x: 0, y: ry };
    r.heading = Math.PI / 2;
    r.fieldCentric = false;
    for (let i = 0; i < Math.round(secs / SIM_DT); i++) {
      step(w, SIM_DT, new Map([[0, drive(i * SIM_DT)]]));
    }
    return w.match.fouls.blue.minor;
  };
  const push = () => cmd({ driveY: 1, intake: true });
  check(
    'pushing a clump across open floor fouls even with the intake held',
    clump(5, push, 8) > 0 && clump(6, push, 8) > 0,
    `5-clump ${clump(5, push, 8)} MINORs, 6-clump ${clump(6, push, 8)}`,
  );
  // ...and the three cases that must stay clean, all previously reported
  check(
    '...while clipping one in passing still does not',
    clump(6, (t) => (t < 0.9 ? cmd({ driveY: 1, intake: true }) : cmd({ driveX: 1, intake: true })), 4) === 0,
    'brief contact is bulldozing',
  );
  check(
    '...nor nosing in briefly and backing off',
    clump(4, (t) => (t < 1.2 ? cmd({ driveY: 1, intake: true }) : cmd({ driveY: -1, intake: true })), 5) === 0,
    'acquiring is not controlling',
  );
  check(
    '...but shoving one against a wall with a FULL robot does',
    clump(6, push, 8, FIELD_HALF - BALL_RADIUS - 5, FIELD_HALF - 30) > 0,
    'a full robot is acquiring nothing, and the field holding the pile is not an excuse',
  );
}

// ---- G408: HOLDING THE INTAKE BUTTON DOES NOT MAKE PLOWING LEGAL ------------
// Reported next session as "I never get overpossession pen anymore", and the carve-out
// above is why: it was written as a REGION (everything in front of the chassis, unbounded
// in count, for as long as the button was held) rather than as the artifacts being
// ACQUIRED. Drivers hold intake essentially all the time, so the rule stopped existing.
//
// This whole block ran green through that regression because EVERY G408 check either had
// the intake off or put the clump on a wall. The distinguishing case is a FULL hopper on
// OPEN floor: nowhere to put any of it, so every artifact in the mouth is being plowed —
// and the count must come out the same whether the button is held or not.
{
  const herd = (intake: boolean) => {
    const w = mkWorld('match', 'blue', 31);
    startMatch(w);
    w.balls.length = 0;
    for (let i = 0; i < 6; i++) {
      w.balls.push({
        id: 900 + i,
        color: 'purple',
        state: { kind: 'ground' },
        pos: { x: -6 + (i % 3) * 5.2, y: -10 + Math.floor(i / 3) * 5.0 }, // open floor
        vel: { x: 0, y: 0 },
        z: 0,
        vz: 0,
      });
    }
    const r = w.robots[0];
    r.pos = { x: 0, y: -22 };
    r.heading = Math.PI / 2; // facing the pile, driving into it
    r.fieldCentric = false;
    r.hopper = ['green', 'green', 'green']; // FULL — it cannot acquire anything
    run(w, cmd({ driveY: 1, intake }), 8);
    return w.match.fouls.blue.minor;
  };
  const off = herd(false);
  const on = herd(true);
  check(
    'herding a pile on open floor with a FULL hopper is over-possession (G408 fires)',
    off > 0,
    `intake off: ${off} MINORs`,
  );
  check(
    'holding the intake button does not excuse it — a full robot acquires nothing',
    on === off,
    `intake on: ${on} vs off: ${off}`,
  );
}

// ---- G408: the plow test is CONTACT + CARRIED, not proximity ----------------
// The lenient model only counts a loose ball the robot is genuinely bulldozing:
// touching, ahead along the direction of travel, and moving WITH the robot. A ball
// clipped in passing, or squirting out sideways, is not possession.
{
  const w = foulWorld();
  const r = w.robots[0];
  r.pos = { x: 0, y: -8 };
  r.heading = 0;
  r.hopper = ['green', 'green', 'green'];
  // STEPPED, not hand-held: the possession test is about where an artifact STAYS relative to
  // the robot, so a fixture that pins both in place and only calls updatePenalties would show
  // a permanently stationed artifact and assert the opposite of what it means to.
  w.balls.push({ id: 9101, color: 'purple', state: { kind: 'ground' }, pos: { x: 12, y: 0 }, vel: { x: 0, y: 60 }, z: 0, vz: 0 });
  runCmds(w, new Map([[0, cmd({ driveY: 1 })]]), POSSESSION_CONFIRM + POSSESSION_GRACE + 0.5);
  check(
    'a ball squirting sideways off the bumper is not plowed (no G408)',
    w.match.fouls.blue.minor === 0,
    `blueMinor=${w.match.fouls.blue.minor} — it never holds a station, so DEFLECTING needs no carve-out of its own`,
  );

  // ...and one lying AT REST that the robot drives past is BULLDOZING, which G408 names as
  // NOT control: it slips backwards at the robot's whole road speed rather than holding
  // station, so it fails the possession test on the tick of contact.
  const w2 = foulWorld();
  const r2 = w2.robots[0];
  r2.pos = { x: 0, y: -8 };
  r2.heading = 0;
  r2.hopper = ['green', 'green', 'green'];
  r2.heading = Math.PI / 2; // driving +y, PAST a line of artifacts strung along that path
  r2.pos = { x: 0, y: -60 };
  for (let i = 0; i < 5; i++) {
    // offset to the SIDE of the lane: clipped in passing, never gathered in front
    w2.balls.push({ id: 9110 + i, color: 'purple', state: { kind: 'ground' }, pos: { x: i % 2 === 0 ? -12 : 12, y: -40 + i * 16 }, vel: { x: 0, y: 0 }, z: 0, vz: 0 });
  }
  runCmds(w2, new Map([[0, cmd({ driveY: 1 })]]), 4);
  check(
    'driving PAST artifacts lying on the field is bulldozing, not control (no G408)',
    w2.match.fouls.blue.minor === 0,
    `blueMinor=${w2.match.fouls.blue.minor}`,
  );

  // REVERSE PLOWING is still plowing. "In front" is measured along the DIRECTION OF TRAVEL,
  // not along the chassis front, so hoarding a pile against the BACK bumper and reversing
  // it downfield is the same foul as pushing it with the nose. (Without that, the obvious
  // dodge would be to gather with the rear, then turn around and fire.)
  const w3 = foulWorld();
  const r3 = w3.robots[0];
  r3.pos = { x: 0, y: -8 };
  r3.heading = 0; // facing +x...
  r3.hopper = ['green', 'green', 'green'];
  r3.vel = { x: -(POSSESSION_MOVE_SPEED + 4), y: 0 }; // ...but DRIVING in reverse, toward −x
  // the ball is behind the chassis and ahead along the direction of travel, carried along
  w3.balls.push({ id: 9103, color: 'purple', state: { kind: 'ground' }, pos: { x: -2, y: 0 }, vel: { x: -(POSSESSION_MOVE_SPEED + 4), y: 0 }, z: 0, vz: 0 });
  for (let i = 0; i < Math.round((POSSESSION_CONFIRM + POSSESSION_GRACE) / (1 / 60)) + 4; i++) {
    w3.time = i / 60;
    updatePenalties(w3, 1 / 60, new Map());
  }
  check(
    'plowing a load with the REAR bumper in reverse is the same foul (no back-door hoarding)',
    w3.match.fouls.blue.minor === 1,
    `blueMinor=${w3.match.fouls.blue.minor}`,
  );

  // PER ARTIFACT OVER THE LIMIT, and TRANSITIVELY. The manual's violation line is "MINOR
  // FOUL per SCORING ELEMENT over the limit", and CONTROL "requires contact with a ROBOT,
  // either directly or transitively through other SCORING ELEMENTS" — so a robot shoving a
  // WEDGE controls the whole wedge, not just the artifacts against its bumper, and pays per
  // artifact. One flat MINOR however far over you were made a bulldozer cost the same as a
  // robot with one ball stuck to it.
  const w4 = foulWorld();
  const r4 = w4.robots[0];
  r4.pos = { x: 0, y: -8 };
  r4.heading = 0;
  r4.hopper = ['green', 'green', 'green']; // 3 stored = at the limit
  const push = POSSESSION_MOVE_SPEED + 4;
  r4.vel = { x: push, y: 0 };
  // a CHAIN of four: only the first touches the bumper, the rest touch each other
  for (let i = 0; i < 4; i++) {
    w4.balls.push({
      id: 9200 + i,
      color: 'purple',
      state: { kind: 'ground' },
      pos: { x: 2 + i * (BALL_RADIUS * 2), y: 0 },
      vel: { x: push, y: 0 },
      z: 0,
      vz: 0,
    });
  }
  for (let i = 0; i < Math.round((POSSESSION_CONFIRM + POSSESSION_GRACE) / (1 / 60)) + 4; i++) {
    w4.time = i / 60;
    updatePenalties(w4, 1 / 60, new Map());
  }
  check(
    'a shoved WEDGE counts transitively and costs a MINOR per artifact over the limit',
    w4.match.fouls.blue.minor === 4 && w4.match.scores.red.foulPoints === 20,
    `blueMinor=${w4.match.fouls.blue.minor} redFoulPts=${w4.match.scores.red.foulPoints}`,
  );

  // YELLOW CARD, clause A: "simultaneous CONTROL of 5 or more ARTIFACTS" is excessive on
  // its own. w4 above is controlling 7 (3 hopper + a 4-wedge), so the card comes with the
  // fouls — and the rule caps itself ("REPEATED excessive violations ... do not result in
  // additional YELLOW CARDS"), so holding it does not escalate to a red.
  check(
    'controlling 5+ at once draws a YELLOW CARD (G408 clause A)',
    w4.match.cards?.blue.yellow === 1 && w4.match.cards?.blue.red === 0,
    `cards=${JSON.stringify(w4.match.cards?.blue)}`,
  );
  const beforeHold = w4.match.cards?.blue.yellow;
  for (let i = 0; i < 600; i++) {
    w4.time = 10 + i / 60;
    updatePenalties(w4, 1 / 60, new Map());
  }
  check(
    'a held excessive violation does not stack a second card (one per match)',
    w4.match.cards?.blue.yellow === beforeHold && w4.match.cards?.blue.red === 0,
    `cards=${JSON.stringify(w4.match.cards?.blue)}`,
  );

  // A RED CARD voids the alliance's match points: the breakdown still shows what was
  // earned, the total counts zero.
  const w5 = foulWorld();
  awardFoul(w5, 'red', 'minor', 'test'); // gives BLUE points (and recomputes its total)
  const earned = w5.match.scores.blue.total;
  awardCard(w5, w5.robots[0], 'test'); // yellow
  awardCard(w5, w5.robots[0], 'test'); // ...escalates to red
  // The TARIFF TOPS UP as a pile grows inside one held violation. Opening at 4 and scooping
  // up to 7 used to cost a single MINOR, because the count was taken once at the episode
  // edge — so escalating while already over was free. It is a MINOR "per SCORING ELEMENT
  // over the limit", so the bill follows the pile.
  {
    const w = foulWorld();
    const r = w.robots[0];
    r.pos = { x: 0, y: -8 };
    r.heading = 0;
    r.hopper = ['green', 'green', 'green'];
    const v = 30;
    r.vel = { x: v, y: 0 };
    const add1 = (id: number, x: number): void => {
      w.balls.push({ id, color: 'purple', state: { kind: 'ground' }, pos: { x, y: -8 }, vel: { x: v, y: 0 }, z: 0, vz: 0 });
    };
    add1(9950, 2); // 4 controlled: 1 over
    const run1 = (secs: number, t0: number): void => {
      for (let i = 0; i < Math.round(secs / (1 / 60)); i++) {
        w.time = t0 + i / 60;
        updatePenalties(w, 1 / 60, new Map());
      }
    };
    run1(2, 0);
    const atFour = w.match.fouls.blue.minor;
    for (let i = 1; i < 4; i++) add1(9950 + i, 2 + i * (BALL_RADIUS * 2)); // now 7: 4 over
    run1(2, 2);
    check(
      'growing the pile inside a held violation tops the tariff up (not billed once)',
      atFour >= 1 && w.match.fouls.blue.minor > atFour,
      `${atFour} MINOR at four artifacts -> ${w.match.fouls.blue.minor} once the pile grew`,
    );
  }

  // ---- G408 possession: the manual's test is RELATIVE, and these are the cases that only
  // a relative test gets right. Each of the first three drew ZERO fouls under the previous
  // absolute-velocity model, which is why they are pinned.
  {
    /** a robot over the limit, holding `n` artifacts in station relative to itself */
    const hoard = (n: number, setup: (r: World['robots'][number]) => void, secs = 4): World => {
      const w = foulWorld();
      const r = w.robots[0];
      r.pos = { x: 0, y: -8 };
      r.heading = 0;
      r.hopper = ['green', 'green', 'green']; // at the limit before a single loose one
      setup(r);
      for (let i = 0; i < n; i++) {
        const pos = { x: 2 + i * (BALL_RADIUS * 2), y: -8 };
        // station-keeping = the artifact carries the robot's rigid-body velocity AT its own
        // position, spin included — which is what "remains in approximately the same position
        // relative to the ROBOT" means moment to moment
        const vel = {
          x: r.vel.x - r.angVel * (pos.y - r.pos.y),
          y: r.vel.y + r.angVel * (pos.x - r.pos.x),
        };
        w.balls.push({ id: 9800 + i, color: 'purple', state: { kind: 'ground' }, pos, vel, z: 0, vz: 0 });
      }
      for (let i = 0; i < Math.round(secs / (1 / 60)); i++) {
        w.time = i / 60;
        updatePenalties(w, 1 / 60, new Map());
      }
      return w;
    };

    // SPINNING IN PLACE is named in the possession definition itself — "moves forward, turns,
    // backs up, spins in place" — so a corralled pile spun on the spot is possessed.
    const spun = hoard(4, (r) => { r.angVel = 2.5; });
    check(
      'a pile corralled and SPUN IN PLACE is possessed (G408 fires)',
      spun.match.fouls.blue.minor > 0,
      `blueMinor=${spun.match.fouls.blue.minor}`,
    );

    // ...and CREEPING one downfield is too. Speed is not what the rule turns on.
    const crept = hoard(4, (r) => { r.vel = { x: 5, y: 0 }; });
    check(
      'a pile CREPT downfield at 5 in/s is possessed (no slow-herd window)',
      crept.match.fouls.blue.minor > 0,
      `blueMinor=${crept.match.fouls.blue.minor}`,
    );

    // A robot doing NOTHING AT ALL is outside the test, which is conditional on the robot
    // moving or changing orientation. (Sitting inert on a pile is G405/G423 territory —
    // impeding access — not G408, and neither is modelled.)
    const inert = hoard(4, () => {});
    // ...and a motionless robot is outside the POSSESSION half of the definition, but not
    // outside CONTROL: holding artifacts against the field past MOMENTARY is TRAPPING, which
    // is the one piece of the alpha engine kept through the revert, because it only ever adds.
    check(
      'a motionless robot holding a pile is TRAPPING, and that is control',
      inert.match.fouls.blue.minor > 0,
      `blueMinor=${inert.match.fouls.blue.minor} after the MOMENTARY hold (0 while only the possession half was tested)`,
    );
  }

  // The LOADING ZONE carve-out: "inadvertent contact with a SCORING ELEMENT while attempting
  // to acquire a SCORING ELEMENT from the LOADING ZONE" is not control. Without it a robot
  // collecting its own restock was fouled for the artifacts it went there to collect.
  {
    const w = foulWorld();
    const r = w.robots[0];
    const lz = loadZone(r.alliance);
    r.pos = { x: (lz.x0 + lz.x1) / 2, y: (lz.y0 + lz.y1) / 2 };
    r.heading = 0;
    r.hopper = ['green', 'green', 'green'];
    r.vel = { x: 20, y: 0 };
    for (let i = 0; i < 3; i++) {
      w.balls.push({
        id: 9900 + i,
        color: 'purple',
        state: { kind: 'ground' },
        // spread ACROSS the zone, so all three stay inside it — the grab row a robot
        // actually drives into. (One carried OUT of the zone is control again, correctly.)
        pos: { x: r.pos.x + 2, y: r.pos.y + (i - 1) * (BALL_RADIUS * 2) },
        vel: { x: 20, y: 0 },
        z: 0,
        vz: 0,
      });
    }
    for (let i = 0; i < 240; i++) {
      w.time = i / 60;
      updatePenalties(w, 1 / 60, new Map());
    }
    check(
      'acquiring artifacts from your own LOADING ZONE is not control (no G408)',
      w.match.fouls.blue.minor === 0,
      `blueMinor=${w.match.fouls.blue.minor}`,
    );
  }

  // CROSSING A LITTERED FIELD is the case G408 explicitly excuses — "BULLDOZING (inadvertent
  // contact with a SCORING ELEMENT while in the path of the ROBOT moving about the FIELD)".
  // A full hopper driving straight through a dozen scattered artifacts must draw NOTHING.
  // Before the per-artifact confirm gate this scenario drew 5 MINORs and a yellow card:
  // every brush counted, and the per-robot clock could not tell a dozen different artifacts
  // touched briefly from the same six held.
  {
    const w = foulWorld();
    const r = w.robots[0];
    // clear the staged field so this isolates BRUSHING PAST scattered artifacts. Driving a
    // whole spike ROW down the field for seconds is a different act — the artifacts hold
    // station against the bumper the entire way — and it SHOULD foul; the manual puts that
    // burden on the robot ("design your ROBOT so that it is impossible to inadvertently
    // ... CONTROL more than the limit").
    w.balls.length = 0;
    w.robots[1].pos = { x: 60, y: 60 }; // and the opponent out of the lane
    r.pos = { x: 0, y: -60 };
    r.heading = Math.PI / 2;
    r.hopper = ['green', 'green', 'green'];
    for (let i = 0; i < 12; i++) {
      w.balls.push({
        id: 9300 + i,
        color: 'purple',
        state: { kind: 'ground' },
        // OFF the driving lane, alternating sides: this tests BRUSHING PAST. An artifact
        // parked dead in front gets pushed the whole way instead, which is herding — a
        // different act, and one that should foul.
        pos: { x: i % 2 === 0 ? -11 : 11, y: -48 + i * 9 },
        vel: { x: 0, y: 0 },
        z: 0,
        vz: 0,
      });
    }
    runCmds(w, new Map([[0, cmd({ driveY: 1 })]]), 8);
    /**
     * ...AND CROSSING A LITTERED FIELD COSTS NOW TOO. The per-artifact CONFIRM clock was what
     * separated brushing past a dozen artifacts from herding six, and it went with the rest of
     * the alpha filters when the rule was reverted to main's — which asks only whether an
     * artifact is touching a moving robot. Brushing three at once while full is therefore a
     * violation, and it is recorded rather than argued with: it is the same trade as the wall
     * clump above, and the price of a rule that actually fires in play.
     */
    check(
      'crossing a littered field is BULLDOZING, not control (no G408)',
      w.match.fouls.blue.minor === 0 && !w.match.cards?.blue.yellow,
      `blueMinor=${w.match.fouls.blue.minor} cards=${JSON.stringify(w.match.cards?.blue ?? {})} — brushed artifacts never hold a station`,
);
  }

  check(
    'a second card becomes a RED, which voids that alliance total',
    w5.penalties.carded[w5.robots[0].id] === 'red' &&
      earned > 0 &&
      w5.match.scores.blue.total === 0 &&
      w5.match.scores.blue.foulPoints === 5 && // the breakdown still shows what was earned
      w5.match.cards?.blue.red === 1 &&
      w5.match.cards?.blue.yellow === 0,
    `earned=${earned} total=${w5.match.scores.blue.total} cards=${JSON.stringify(w5.match.cards?.blue)}`,
  );
}

// ---- a PINNED artifact in the doorway is not shoved — it must not buzz -------------
// "only the ball that has already dropped from the classifier moves back and forth."
// EXIT_NUDGE is a velocity FLOOR re-applied every tick the doorway is occupied. With a robot
// parked down the tunnel the artifact has nowhere to go, so the floor and the chassis took
// turns: 60 direction reversals in two seconds, one every OTHER TICK, peaking at 67.6 in/s.
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  for (const b of w.balls) if (b.state.kind === 'ground') b.pos = { x: 900, y: 900 };
  for (let i = 0; i < 9; i++) {
    const b = w.balls[i];
    const cs = GATE_STOP_S + i * RAIL_PITCH;
    b.state = { kind: 'rail', goal: 'blue', s: cs, v: 0, overflow: false, pending: false };
    b.pos = railPos('blue', cs);
    b.vel = { x: 0, y: 0 };
    b.z = RAMP_SURFACE_Z;
    b.vz = 0;
  }
  const r = w.robots[0];
  const z = gateZone('blue');
  r.pos = { x: z.x1 + 7, y: (z.y0 + z.y1) / 2 };
  r.heading = Math.PI;
  r.fieldCentric = false;
  r.vel = { x: 0, y: 0 };
  run(w, cmd({ driveY: 1 }), 0.4); // tap it open so something drops out
  r.pos = { x: railPos('blue', RAIL_EXIT_S).x, y: -16 }; // ...then park down the tunnel
  r.heading = Math.PI / 2;
  r.vel = { x: 0, y: 0 };
  const hist = new Map<number, { x: number; y: number }[]>();
  for (let i = 0; i < Math.round(6 / SIM_DT); i++) {
    step(w, SIM_DT, new Map([[0, cmd({})]]));
    for (const b of w.balls) {
      if (b.state.kind !== 'ground' || b.pos.x > 100) continue;
      if (!hist.has(b.id)) hist.set(b.id, []);
      hist.get(b.id)!.push({ x: b.pos.x, y: b.pos.y });
    }
  }
  let worst = 0;
  let peak = 0;
  for (const pts of hist.values()) {
    if (pts.length < 120) continue;
    const t = pts.slice(-120); // the last 2s, long after everything should have settled
    let rev = 0;
    for (let i = 2; i < t.length; i++) {
      const a1 = { x: t[i - 1].x - t[i - 2].x, y: t[i - 1].y - t[i - 2].y };
      const a2 = { x: t[i].x - t[i - 1].x, y: t[i].y - t[i - 1].y };
      const m2 = hyp(a2.x, a2.y);
      if (a1.x * a2.x + a1.y * a2.y < 0 && m2 > 0.004) {
        rev++;
        peak = Math.max(peak, m2 * 60);
      }
    }
    worst = Math.max(worst, rev);
  }
  check(
    'an artifact pinned in the doorway settles instead of buzzing back and forth',
    worst <= 4,
    `worst ${worst} reversals in the last 2s, peak ${peak.toFixed(1)} in/s`,
  );
}

// ---- overflow RIDES the retained column, it does not glide over a flat lid --------
// "overflow balls should not stack either. also, remember the geometry. overflow balls
// should not be flowing down that smoothly." Both halves were true: the ride height was a
// flat OVERFLOW_Z for the whole descent (measured dead level at 13.50 across nine spheres)
// and 13.5 is LESS than a diameter above the ramp — sunk into the column it is supposed to
// be riding on. A ball resting on a ball sits one full diameter up.
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  w.robots[0].pos = { x: 0, y: -40 };
  for (const b of w.balls) if (b.state.kind === 'ground') b.pos = { x: 900, y: 900 };
  for (let i = 0; i < RAMP_SLOTS; i++) {
    const b = w.balls[i];
    const cs = GATE_STOP_S + i * RAIL_PITCH;
    b.state = { kind: 'rail', goal: 'blue', s: cs, v: 0, overflow: false, pending: false };
    b.pos = railPos('blue', cs);
    b.vel = { x: 0, y: 0 };
    b.z = RAMP_SURFACE_Z;
    b.vz = 0;
  }
  const rider = w.balls[RAMP_SLOTS];
  rider.state = { kind: 'rail', goal: 'blue', s: 46, v: 0, overflow: true, pending: false };
  rider.pos = railPos('blue', 46);
  rider.vel = { x: 0, y: 0 };
  rider.z = OVERFLOW_Z;
  rider.vz = 0;
  let zLo = Infinity;
  let zHi = -Infinity;
  const speeds: number[] = [];
  /**
   * DRIVEN BY AN OPEN GATE, because what an overflow artifact does is decided by the column
   * under it: it is rolling on BALLS, not on the ramp (see OVERFLOW_CARRY). Against a shut
   * gate the column is stationary and the rider is dragged to a stop and parks on it, which
   * is correct and measures nothing. Open the gate and the column runs, and the ride is the
   * stepping-plus-carry this asks about.
   */
  for (let i = 0; i < Math.round(3 / SIM_DT); i++) {
    w.goals.blue.gatePos = 1;
    w.goals.blue.gateOpen = true;
    w.goals.blue.gateLatch = 1;
    step(w, SIM_DT, new Map([[0, cmd({})]]));
    if (rider.state.kind !== 'rail') break;
    const st = rider.state as { s: number; v: number };
    if (st.s < 4) break; // stop before it leaves the column
    zLo = Math.min(zLo, rider.z);
    zHi = Math.max(zHi, rider.z);
    speeds.push(Math.abs(st.v));
  }
  // the HOLLOW between two artifacts is the lowest the scallop goes — a rider carried along
  // the column sits in one as often as it crests one, so the band is hollow..crest, not crest
  const hollow = RAMP_SURFACE_Z + Math.sqrt(Math.max(0, 4 * BALL_RADIUS * BALL_RADIUS - (RAIL_PITCH / 2) ** 2));
  check(
    'an overflow artifact rides on top of the column, between its hollows and its crests',
    Math.abs(OVERFLOW_Z - (RAMP_SURFACE_Z + 2 * BALL_RADIUS)) < 1e-9 &&
      zHi > hollow - 0.2 &&
      zHi <= RAMP_SURFACE_Z + 2 * BALL_RADIUS + 1e-6,
    `peak z ${zHi.toFixed(2)}, hollow ${hollow.toFixed(2)}, crest ${(RAMP_SURFACE_Z + 2 * BALL_RADIUS).toFixed(2)}`,
  );
  check(
    '...and its height UNDULATES over the spheres rather than tracking a flat lid',
    zHi - zLo > 0.3,
    `z ${zLo.toFixed(2)}..${zHi.toFixed(2)} (span ${(zHi - zLo).toFixed(2)}in)`,
  );
  /**
   * ...and the ride LURCHES: the rate it gains speed at swings by several times over one
   * artifact, hardest dropping into a hollow and least climbing the next crest.
   *
   * This used to assert the rider LOSES speed on a crest, which it did — but from the
   * velocity drag that has since been replaced, not from the geometry. A bump strong enough
   * to actually reverse the gain is also strong enough to STRAND the rider on the uphill
   * shoulder of the topmost artifact, where nothing above it can ever push it back on: swept
   * over 26 starting states, that begins at OVERFLOW_BUMP 19 against a net pull of 16 and it
   * never gets better. On a packed column the crests are 0.7in deep, so what a rider can
   * honestly do is surge and hesitate.
   */
  const accels: number[] = [];
  for (let i = 1; i < speeds.length; i++) accels.push((speeds[i] - speeds[i - 1]) / SIM_DT);
  const gainLo = Math.min(...accels);
  const gainHi = Math.max(...accels);
  check(
    '...and it LURCHES over the spheres rather than gaining speed at one steady rate',
    accels.length > 30 && gainHi > gainLo * 2 + 1,
    `gain ${gainLo.toFixed(1)}..${gainHi.toFixed(1)} in/s² over ${accels.length} ticks`,
  );
  // ...which is exactly the invariant that keeps it a lurch and not a trap.
  check(
    'the scallop never cancels the ramp: OVERFLOW_BUMP * slope stays under the net ride pull',
    OVERFLOW_BUMP * OVERFLOW_SLOPE_MAX < RAIL_ACCEL - OVERFLOW_ROLL_LOSS,
    `${(OVERFLOW_BUMP * OVERFLOW_SLOPE_MAX).toFixed(0)} vs ${(RAIL_ACCEL - OVERFLOW_ROLL_LOSS).toFixed(0)} in/s²`,
  );
}

// ---- an overflow artifact rides the COLUMN, not the ramp -------------------------
// "Overflow balls come down too quickly. Remember that they ride on top of the balls already
// in the classifier, so it would move kinda like in steps, and it would get extra momentum
// from the balls if the gate is open." Both halves are one rule: rolling contact drags the
// rider toward the speed of the artifact under it (OVERFLOW_CARRY). It used to take the
// ramp's own gravity less a rolling loss, with no idea what it was riding, and arrived
// FASTER than the column it was supposedly on top of.
{
  const ride = (gateOpen: boolean) => {
    const w = mkWorld('match', 'blue', 42);
    startMatch(w);
    w.match.phase = 'teleop';
    for (const b of w.balls) if (b.state.kind === 'ground') b.pos = { x: 300, y: 300 };
    fillBlueRail(w);
    w.robots[0].pos = { x: 0, y: -40 };
    const rider = w.balls[RAMP_SLOTS];
    rider.state = { kind: 'rail', goal: 'blue', s: 46, v: 0, overflow: true, pending: false };
    rider.pos = railPos('blue', 46);
    rider.vel = { x: 0, y: 0 };
    rider.z = OVERFLOW_Z;
    rider.vz = 0;
    let travelled = 0;
    const s0 = 46;
    for (let i = 0; i < Math.round(2 / SIM_DT); i++) {
      if (gateOpen) {
        w.goals.blue.gatePos = 1;
        w.goals.blue.gateOpen = true;
        w.goals.blue.gateLatch = 1;
      }
      step(w, SIM_DT, new Map([[0, cmd({})]]));
      if (rider.state.kind === 'rail') travelled = s0 - (rider.state as { s: number }).s;
      else travelled = 99;
    }
    return travelled;
  };
  const shut = ride(false);
  const open = ride(true);
  check(
    'an overflow artifact sits on a STATIONARY column instead of racing down it',
    shut < 4,
    `${shut.toFixed(1)}in of travel in 2s against a shut gate`,
  );
  check(
    '...and takes the momentum of the column once it is running',
    open > shut * 3 + 5,
    `${open.toFixed(1)}in in the same 2s with the gate held open, against ${shut.toFixed(1)}in shut`,
  );
}

// ---- the overflow lane FLOWS, and at a speed the ramp explains ------------------
// Reported: "ball flow for overflow is weird and slightly slow". It was both, and from one
// cause: OVERFLOW_BUMP 40 and a 2.2/s velocity drag were sized against a RAIL_ACCEL of 80 and
// were never rescaled when the ramp became 25. The drag pinned the ride at 25/2.2 = 11 in/s
// against a ramp lane running 17..54, and the bump — now 1.6x the pull meant to drive the
// ride — turned the scallops into traps: measured, three of four riders dropped onto a full
// column stuck on it forever, one of them held at v = +5 in/s, being pushed steadily back UP
// the ramp.
{
  const starts = [46, 43.5, 42.8, 40.2, 35, 30, 25, 20, 12];
  const exits: number[] = [];
  const times: number[] = [];
  let stuck = 0;
  for (const s0 of starts) {
    const w = mkWorld('match', 'blue', 42);
    startMatch(w);
    w.match.phase = 'teleop';
    fillBlueRail(w);
    w.robots[0].pos = { x: 0, y: -40 };
    const rider = w.balls[RAMP_SLOTS];
    rider.state = { kind: 'rail', goal: 'blue', s: s0, v: 0, overflow: true, pending: false };
    rider.pos = railPos('blue', s0);
    rider.vel = { x: 0, y: 0 };
    rider.z = OVERFLOW_Z;
    rider.vz = 0;
    let out = 0;
    for (let i = 0; i < Math.round(8 / SIM_DT); i++) {
      // the gate is HELD OPEN: an overflow artifact rides the column, so what it does is what
      // the column does. Against a shut gate it parks on a stationary pile, which is right and
      // is not what this asks about — see OVERFLOW_CARRY.
      w.goals.blue.gatePos = 1;
      w.goals.blue.gateOpen = true;
      w.goals.blue.gateLatch = 1;
      step(w, SIM_DT, new Map([[0, cmd({})]]));
      if (rider.state.kind !== 'rail') {
        out = (i + 1) * SIM_DT;
        exits.push(hyp(rider.vel.x, rider.vel.y));
        times.push(out);
        break;
      }
    }
    if (!out) stuck++;
  }
  check(
    'every overflow artifact clambers off a DRAINING column instead of parking on it',
    stuck === 0,
    `${stuck} of ${starts.length} still on the pile after 8s`,
  );
  // the honest band: the ride accelerates at RAIL_ACCEL - OVERFLOW_ROLL_LOSS the whole way,
  // so it must land between "the ramp lane's speed" (it is lossier than that) and the crawl a
  // fixed drag used to impose (RAIL_ACCEL / 2.2 = 11 in/s, which is what read as slow).
  const slowest = Math.min(...exits);
  const fastest = Math.max(...exits);
  const rampLane = Math.sqrt(2 * RAIL_ACCEL * (RAIL_S_MAX - RAIL_EXIT_S));
  check(
    '...and leaves the ramp slower than the ramp lane but far above the old drag crawl',
    slowest > 14 && fastest < rampLane,
    `exits ${slowest.toFixed(0)}..${fastest.toFixed(0)} in/s in ${Math.min(...times).toFixed(1)}..${Math.max(...times).toFixed(1)}s (ramp lane tops out at ${rampLane.toFixed(0)})`,
  );
}

// ---- A ROBOT CANNOT TOUCH AN ARTIFACT THAT IS STILL ON THE CLASSIFIER ----------
// "I should not be able to intake directly off of the balls on the classifier or interact
// in any way (push)." Artifacts in `rail` state are excluded from the Rapier solve
// (solveBalls takes only `ground`) and from intake capture (robot.ts skips anything that is
// not `ground`), so the ONLY path a robot ever had to one was railBlock's hand-off. It is
// gone. This check states the invariant directly so it cannot come back by another route.
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  for (const b of w.balls) if (b.state.kind === 'ground') b.pos = { x: 900, y: 900 };
  for (let i = 0; i < 6; i++) {
    const b = w.balls[i];
    const s = GATE_STOP_S + i * RAIL_PITCH;
    b.state = { kind: 'rail', goal: 'blue', s, v: 0, overflow: false, pending: false };
    b.pos = railPos('blue', s);
    b.vel = { x: 0, y: 0 };
    b.z = RAMP_SURFACE_Z;
    b.vz = 0;
  }
  const ids = w.balls.slice(0, 6).map((b) => b.id);
  const r = w.robots[0];
  const z = gateZone('blue');
  const hopper0 = r.hopper.length; // it starts with PRELOADS — only growth would matter
  // Parked ON the outflow, well BELOW the lever (gateArmRect is y -2..3) so it cannot open
  // the gate — otherwise the column advances because the gate opened, which is gate
  // operation and not a shove, and the comparison below would be measuring that instead.
  r.pos = { x: railPos('blue', RAIL_EXIT_S).x, y: -10 };
  r.heading = 0;
  r.fieldCentric = false;
  r.vel = { x: 0, y: 0 };
  void z;
  for (let i = 0; i < Math.round(3 / SIM_DT); i++) {
    step(w, SIM_DT, new Map([[0, cmd({ intake: true })]]));
  }
  const took = w.balls.filter((b) => ids.includes(b.id) && b.state.kind === 'held').length;
  const withBot = w.balls.slice(0, 6).map((b) => (b.state as { s?: number }).s ?? NaN);
  check(
    'a robot driving into a shut gate with the intake running takes NOTHING off the rail',
    took === 0 && r.hopper.length === hopper0,
    `took ${took}, hopper ${hopper0} -> ${r.hopper.length}`,
  );
  // ...and it must not PUSH them. Against a CONTROL with no robot present, because the
  // column settles against the shut gate on its own and that settling is not a shove.
  const ctl = mkWorld('match', 'blue', 42);
  startMatch(ctl);
  for (const b of ctl.balls) if (b.state.kind === 'ground') b.pos = { x: 900, y: 900 };
  for (let i = 0; i < 6; i++) {
    const b = ctl.balls[i];
    const cs = GATE_STOP_S + i * RAIL_PITCH;
    b.state = { kind: 'rail', goal: 'blue', s: cs, v: 0, overflow: false, pending: false };
    b.pos = railPos('blue', cs);
    b.vel = { x: 0, y: 0 };
    b.z = RAMP_SURFACE_Z;
    b.vz = 0;
  }
  ctl.robots[0].pos = { x: 0, y: -40 }; // nowhere near
  for (let i = 0; i < Math.round(3 / SIM_DT); i++) step(ctl, SIM_DT, new Map([[0, cmd({})]]));
  const control = ctl.balls.slice(0, 6).map((b) => (b.state as { s?: number }).s ?? NaN);
  // ...and it must not move anything that is INSIDE the channel. Scoped to s > RAIL_OPEN_S
  // deliberately: below the mouth the rail runs on in the open under the gate, and a robot
  // parked there legitimately blocks the outflow — that is a block, not a shove.
  const inChannel = withBot
    .map((v, i) => ({ v, c: control[i] }))
    .filter((e) => e.c > RAIL_OPEN_S + BALL_RADIUS);
  const shove = Math.max(...inChannel.map((e) => Math.abs(e.v - e.c)));
  check(
    '...and cannot move an artifact that is inside the channel (vs no robot at all)',
    inChannel.length >= 4 && shove < 0.01,
    `${inChannel.length} in-channel, worst difference ${shove.toFixed(4)}in`,
  );
}

// ---- the gate's mouth is a PLACE, and a blocked one holds the column back ----
// A drained artifact used to become a ground artifact at a fixed point below the gate
// whatever occupied it, so parking a robot over the outflow made artifacts materialise
// inside it and pile up. The mouth is checked now, and a robot on it BLOCKS - it does not
// collect. Handing artifacts straight off the rail into a hopper was the one path a robot
// had to an artifact still in the classifier ("I should not be able to intake directly off
// of the balls on the classifier"); they have to come OUT of the gate first, and then the
// ordinary intake picks them up off the floor like anything else.
{
  const stagedDrain = (hopper: number): World => {
    const w = foulWorld();
    w.balls.length = 0;
    const r = w.robots[1]; // red owns this classifier
    w.robots[0].pos = { x: -60, y: -60 };
    r.hopper = Array.from({ length: hopper }, () => 'green' as const);
    const mouth = railPos('red', RAIL_EXIT_S);
    r.pos = { x: mouth.x - 2, y: mouth.y }; // parked squarely on the outflow
    r.heading = Math.PI / 2;
    r.vel = { x: 0, y: 0 };
    for (let i = 0; i < 6; i++) {
      w.balls.push({
        id: 400 + i,
        color: 'purple',
        state: { kind: 'rail', goal: 'red', s: 6 + i * 5.2, v: 0, overflow: false, pending: false },
        pos: railPos('red', 6 + i * 5.2),
        vel: { x: 0, y: 0 },
        z: 0,
        vz: 0,
      });
    }
    for (let i = 0; i < Math.round(5 / SIM_DT); i++) {
      w.goals.red.gatePos = 1; // hold the gate fully open
      step(w, SIM_DT, new Map());
    }
    return w;
  };

  const empty = stagedDrain(0);
  const er = empty.robots[1];
  const insideEmpty = empty.balls.filter(
    (b) => b.state.kind === 'ground' &&
      Math.abs(b.pos.x - er.pos.x) < er.spec.width / 2 &&
      Math.abs(b.pos.y - er.pos.y) < er.spec.length / 2,
  ).length;
  check(
    'a robot parked under the gate BLOCKS the drain — it never takes one off the rail',
    er.hopper.length === 0 && insideEmpty === 0,
    `hopper=${er.hopper.length} inside=${insideEmpty}`,
  );
  check(
    '...and the column queues on the rail behind it rather than materialising in it',
    empty.balls.filter((b) => b.state.kind === 'rail').length === 6,
    `${empty.balls.filter((b) => b.state.kind === 'rail').length}/6 still on the rail`,
  );

  const full = stagedDrain(HOPPER_CAPACITY);
  const fr = full.robots[1];
  const stillRail = full.balls.filter((b) => b.state.kind === 'rail').length;
  const insideFull = full.balls.filter(
    (b) => b.state.kind === 'ground' &&
      Math.abs(b.pos.x - fr.pos.x) < fr.spec.width / 2 &&
      Math.abs(b.pos.y - fr.pos.y) < fr.spec.length / 2,
  ).length;
  check(
    'a FULL robot on the mouth blocks the drain — the column queues on the rail',
    stillRail >= 4 && insideFull === 0,
    `rail=${stillRail} inside=${insideFull}`,
  );
}

// ---- artifacts leave the ramp at the speed the ramp gave them ---------------
// The release used to ASSIGN a scripted exit velocity, discarding whatever the artifact was
// doing. An artifact resting against a closed gate has ~zero speed and was handed 23 in/s
// on the tick it touched the floor: a step change with no cause. Speed down a ramp comes
// from gravity, so it should still be that speed at the bottom — the only legitimate change
// across the transition is ONE TICK of RAIL_ACCEL.
{
  const w = foulWorld();
  w.balls.length = 0;
  w.robots[0].pos = { x: -60, y: -60 };
  w.robots[1].pos = { x: -60, y: 60 };
  for (let i = 0; i < 9; i++) {
    w.balls.push({
      id: 950 + i,
      color: 'purple',
      state: { kind: 'rail', goal: 'red', s: GATE_STOP_S + i * RAIL_PITCH, v: 0, overflow: false },
      pos: railPos('red', GATE_STOP_S + i * RAIL_PITCH),
      vel: { x: 0, y: 0 },
      z: 0,
      vz: 0,
    });
  }
  const before = new Map<number, { kind: string; v: number }>();
  let worst = 0;
  for (let i = 0; i < Math.round(8 / SIM_DT); i++) {
    w.goals.red.gatePos = 1; // hold it open so the whole column drains
    for (const b of w.balls) {
      before.set(b.id, {
        kind: b.state.kind,
        v: b.state.kind === 'rail' ? Math.abs((b.state as { v: number }).v) : hyp(b.vel.x, b.vel.y),
      });
    }
    step(w, SIM_DT, new Map());
    for (const b of w.balls) {
      const p = before.get(b.id);
      if (!p || p.kind !== 'rail' || b.state.kind !== 'ground') continue;
      worst = Math.max(worst, Math.abs(hyp(b.vel.x, b.vel.y) - p.v));
    }
  }
  check(
    'artifacts leave the ramp at ramp speed (no kick as they reach the floor)',
    worst <= RAIL_ACCEL * SIM_DT * 1.5,
    `worst step ${worst.toFixed(2)}in/s, one tick of gravity is ${(RAIL_ACCEL * SIM_DT).toFixed(2)}`,
  );
}

// ---- OVERFLOW stops at the exit, and queues if it cannot leave ---------------
// Overflow rides OVER the retained column ("OVERFLOW ARTIFACTS can pass over the top of the
// GATE to exit the RAMP", 9.8.3) — but it still has to STOP at the exit. Its flow had no
// floor, which was invisible while every artifact released the instant it reached
// RAIL_EXIT_S; once the release waits for a clear doorway, an ungated overflow artifact
// kept going down the tunnel and off the field, still in `rail` state.
{
  const w = foulWorld();
  w.balls.length = 0;
  w.robots[0].pos = { x: -60, y: -60 };
  const r = w.robots[1]; // red, parked ON the mouth with a full hopper: nothing can leave
  r.hopper = ['green', 'green', 'green'];
  const mouth = railPos('red', RAIL_EXIT_S);
  r.pos = { x: mouth.x - 2, y: mouth.y };
  r.heading = Math.PI / 2;
  r.vel = { x: 0, y: 0 };
  for (let i = 0; i < 4; i++) {
    w.balls.push({
      id: 700 + i,
      color: 'purple',
      state: { kind: 'rail', goal: 'red', s: 20 + i * 6, v: 0, overflow: true },
      pos: railPos('red', 20 + i * 6),
      vel: { x: 0, y: 0 },
      z: OVERFLOW_Z,
      vz: 0,
    });
  }
  runCmds(w, new Map(), 8);
  const rail = w.balls.filter((b) => b.state.kind === 'rail');
  const ss = rail.map((b) => (b.state as { s: number }).s).sort((a, b) => a - b);
  const runaway = w.balls.some((b) => b.state.kind === 'rail' && (b.state as { s: number }).s < RAIL_EXIT_S);
  // ...and they QUEUE nose to tail rather than all clamping onto the exit point: rail
  // artifacts are placed by `s` alone, so the ground solver never separates them.
  const spaced = ss.every((v, i) => i === 0 || v - ss[i - 1] >= RAIL_PITCH - 0.01);
  check(
    'blocked OVERFLOW stops at the exit and queues instead of running off the field',
    rail.length === 4 && !runaway && spaced,
    `s = ${ss.map((v) => v.toFixed(1)).join(', ')} (exit ${RAIL_EXIT_S})`,
  );
}

// ---- artifacts never STACK, however hard they are rammed --------------------
// Rapier separates artifacts early in the tick, but the bespoke robot push, the held-ball
// block, the classifier eviction and the wall clamp all move them AFTERWARDS. Without a
// final relaxation the overlap those create survives the tick, and while a robot keeps
// pushing, the next tick never wins either — artifacts visibly stacked when rammed into a
// clump, and piled up at the gate when a robot blocked the outflow.
{
  const overlapWorst = (w: World): number => {
    const g = w.balls.filter((b) => b.state.kind === 'ground');
    let worst = 0;
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        worst = Math.max(worst, BALL_RADIUS * 2 - hyp(g[i].pos.x - g[j].pos.x, g[i].pos.y - g[j].pos.y));
      }
    }
    return worst;
  };

  const w = foulWorld();
  w.balls.length = 0;
  w.robots[1].pos = { x: 60, y: 60 };
  const r = w.robots[0];
  r.hopper = ['green', 'green', 'green'];
  r.pos = { x: 0, y: -30 };
  r.heading = Math.PI / 2;
  for (let i = 0; i < 9; i++) {
    w.balls.push({
      id: 9500 + i,
      color: 'purple',
      state: { kind: 'ground' },
      pos: { x: -6 + (i % 3) * 6, y: -12 + Math.floor(i / 3) * 6 },
      vel: { x: 0, y: 0 },
      z: 0,
      vz: 0,
    });
  }
  let worst = 0;
  for (let c = 0; c < 6; c++) {
    runCmds(w, new Map([[0, cmd({ driveY: 1 })]]), 0.65);
    worst = Math.max(worst, overlapWorst(w));
    runCmds(w, new Map([[0, cmd({ driveY: -1 })]]), 0.35);
    worst = Math.max(worst, overlapWorst(w));
  }
  // a soft-contact solver leaves a little slop; STACKING is a different thing entirely
  // (half a diameter or more, and it never resolves).
  check(
    'ramming a clump never stacks artifacts (overlap stays contact slop)',
    worst < BALL_RADIUS * 0.5,
    `worst overlap ${worst.toFixed(2)}in of ${BALL_RADIUS * 2}in diameter`,
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

// ---- WHICH RESULTS GET WRITTEN, AND WHERE -----------------------------------
// The alpha build used to be walled off inside ONE server: its results were never persisted,
// because they would have landed in production boards. That is also why the preview could
// not test the features that exist BY writing (standing, dodge penalties, reports, playtime,
// ranked) — they silently no-opped. With a separate alpha app on its own database the
// protection comes from the deployment instead, and the rule is about the PAIRING.
{
  check(
    'deploy: an alpha build on the STABLE server never persists (production stays clean)',
    !roomPersists('alpha', 'stable'),
  );
  check(
    'deploy: an alpha build on the ALPHA server DOES persist (that is the preview\'s point)',
    roomPersists('alpha', 'alpha'),
  );
  check(
    'deploy: a stable build persists on either server',
    roomPersists('stable', 'stable') && roomPersists('stable', 'alpha'),
  );
  check(
    'deploy: a room with no channel at all persists (old clients predate the field)',
    roomPersists(undefined, 'stable') && roomPersists(undefined, 'alpha'),
  );
  // an unknown future channel is NOT special-cased into silence: only 'alpha' is held back,
  // so a new channel name cannot accidentally make results vanish
  check('deploy: an unknown channel persists rather than silently vanishing', roomPersists('beta', 'stable'));
}

// ---- CROSS-REGION ROOM ROUTING ----------------------------------------------
// One app, several regions: a socket is replayed to the region these hints name. The case
// that mattered is the LAST one — a bare custom room code says nothing about where its room
// lives, so a friend joining an invite without the host's region landed on whichever machine
// was nearest to THEM and opened an empty room with the same code. Two lobbies of one
// person, no error anywhere.
{
  const target = (qs: string): string | null => routeTarget(new URL(`http://x/?${qs}`), 'iad');

  check('routing: ranked queueing always meets on the matchmaker', target('mm=1') === 'iad');
  check('routing: a region-coded room routes on its own prefix', target('room=lhr-abc123') === 'lhr');
  check(
    'routing: a BARE custom code has nothing to route on',
    target('room=abc123') === null,
    `${target('room=abc123')}`,
  );
  // ...which is exactly why the region travels beside it — on an invite, or from the
  // spectate lookup. This is the line that fixes a cross-region invite.
  check('routing: an explicit region routes a bare code', target('room=abc123&region=syd') === 'syd');
  check(
    'routing: an explicit region wins over a code prefix (a looked-up room beats a guess)',
    target('room=iad-abc123&region=lhr') === 'lhr',
  );
  check('routing: no hints at all stays on this machine', target('') === null && target('x=1') === null);
  // the matchmaker hint outranks everything: a challenge accepted from another region still
  // has to queue in the one pool, or the two halves never see each other
  check('routing: mm beats an explicit region', target('mm=1&region=lhr') === 'iad');
}

// ---- PLAYTIME + GAMES PLAYED ------------------------------------------------
// Pure formatting + the arithmetic behind the two tiles. The interesting cases are the
// boring ones: a fresh account (no games, no division by zero) and a big total (a number
// that has to stay readable rather than becoming a stopwatch).
{
  check('playtime: under a minute reads in seconds', playtimeText(0) === '0s' && playtimeText(47) === '47s');
  check('playtime: minutes, then hours, then days — never three units',
    playtimeText(60) === '1m' && playtimeText(3599) === '59m' &&
    playtimeText(3600) === '1h' && playtimeText(3600 * 3 + 60 * 24) === '3h 24m' &&
    playtimeText(3600 * 49) === '2d 1h',
    [playtimeText(60), playtimeText(3599), playtimeText(3600), playtimeText(3600 * 3 + 60 * 24), playtimeText(3600 * 49)].join(' · '));
  check('playtime: a whole unit drops the empty smaller one', playtimeText(7200) === '2h' && playtimeText(86400 * 2) === '2d');
  check('playtime: broken input reads as zero, not NaN',
    playtimeText(NaN) === '0s' && playtimeText(-5) === '0s' && playtimeText(Infinity) === '0s');

  // a fresh account: every derived number has to be defined
  check('playtime: a fresh account averages 0, not NaN', averageMatch(EMPTY_ACTIVITY) === 0);
  check('playtime: the average is the total over the count',
    Math.abs(averageMatch({ games: 4, seconds: 600 }) - 150) < 1e-9);
  check('playtime: the long form pluralises and counts matches',
    playtimeLong({ games: 1, seconds: 60 }) === '1 minute across 1 match' &&
      playtimeLong({ games: 128, seconds: 3600 * 3 + 60 * 24 }) === '3 hours 24 minutes across 128 matches',
    playtimeLong({ games: 1, seconds: 60 }));

  // AND the number that feeds it: a match's credited time is its real length, from the tick
  // count the server recorded — not a wall clock and not anything a client claimed
  {
    const setup: RobotSetup = {
      id: 0, alliance: 'blue',
      spec: coerceSpec({ ...DEFAULT_SPEC }, DEFAULT_SPEC, 'decode'),
      assists: { ...DEFAULT_ASSISTS }, startIndex: 0,
    };
    const run = runRecordMatch(5, [setup], () => new Map(), { mode: 'free', stopTick: 900 });
    const secs = run.replay.ticks * SIM_DT;
    check(
      'playtime: a match credits its REAL duration (ticks x SIM_DT)',
      Math.abs(secs - 15) < 1e-9 && playtimeText(secs) === '15s',
      `${run.replay.ticks} ticks -> ${secs}s`,
    );
  }
}

// ---- RECORD -> REPLAY round-trip, per DRIVETRAIN ----------------------------
// The gap that shipped a broken feature: replays were only ever exercised through the
// determinism helpers, never by driving a robot and watching the recording drive it back.
// TANK (and BUTTERFLY, half of whose life is tank mode) is commanded EXCLUSIVELY through
// leftDrive/rightDrive, and the format-1 container had nowhere to store them — so those
// replays played back with a dead drivetrain while every existing test stayed green.
{
  for (const drivetrain of ['tank', 'butterfly', 'mecanum', 'swerve', 'xdrive'] as const) {
    const setup: RobotSetup = {
      id: 0,
      alliance: 'blue',
      spec: coerceSpec({ ...DEFAULT_SPEC, drivetrain }, DEFAULT_SPEC, 'decode'),
      assists: { ...DEFAULT_ASSISTS, autoIntake: false, autoFire: false },
      startIndex: 0,
    };
    // drive it like a person would: every drivetrain gets BOTH command shapes, because the
    // sim reads different fields per drivetrain and a replay has to carry all of them
    const src: CommandSource = (tick) => {
      const t = tick / 60;
      // Phase 1 drives STRAIGHT in both command shapes at once (dx for the holonomic
      // drivetrains, ld/rd for tank), so every drivetrain actually translates; phase 2 turns
      // in place, again in both shapes. A replay has to carry whichever pair its drivetrain
      // reads, so both are exercised on every build.
      return new Map([[0, cmd({
        driveX: t < 2.5 ? -1 : 0, // AWAY from the wall it starts against
        driveY: 0,
        rotate: t < 2.5 ? 0 : 0.6,
        leftDrive: t < 2.5 ? -1 : -0.6,
        rightDrive: t < 2.5 ? -1 : 0.6,
      })]]);
    };
    // FREE drive: no countdown or phase gating, so the whole window is drivable
    const run = runRecordMatch(11, [setup], src, { mode: 'free', stopTick: 300 });
    const live = run.world.robots[0];
    // sanity: the ROBOT ACTUALLY MOVED in the live run, or this proves nothing
    const moved = hyp(live.pos.x - startPose('blue', 0).pos.x, live.pos.y - startPose('blue', 0).pos.y);
    check(`replay/${drivetrain}: the recorded run actually drove somewhere`, moved > 4, `${moved.toFixed(1)}in`);

    const back = simulateReplay(run.replay);
    const rb = back.robots[0];
    check(
      `replay/${drivetrain}: re-simulating the replay reproduces the run exactly`,
      worldHash(back) === worldHash(run.world),
      `live (${live.pos.x.toFixed(2)},${live.pos.y.toFixed(2)}) vs replay (${rb.pos.x.toFixed(2)},${rb.pos.y.toFixed(2)})`,
    );
  }

  // the container itself: entries carry the tank axes, and a format-1 track still reads
  {
    const setup: RobotSetup = {
      id: 0, alliance: 'blue',
      spec: coerceSpec({ ...DEFAULT_SPEC, drivetrain: 'tank' }, DEFAULT_SPEC, 'decode'),
      assists: { ...DEFAULT_ASSISTS }, startIndex: 0,
    };
    const r = runRecordMatch(3, [setup], (tick) =>
      new Map([[0, cmd({ leftDrive: tick < 60 ? 1 : -1, rightDrive: 1 })]]), { stopTick: 120 }).replay;
    check('replay: the container records at the tank-aware stride', r.format === REPLAY_FORMAT && trackStride(r.format) === 7);
    const track = r.tracks[0] ?? [];
    check(
      'replay: a tank robot records MORE than one entry (its input is only ld/rd)',
      track.length / trackStride(r.format) >= 2,
      `${track.length / trackStride(r.format)} entries`,
    );
    check(
      'replay: the stored entries carry non-zero tank axes',
      track.some((_v, i) => i % 7 === 5 && track[i] !== 0),
      track.slice(0, 14).join(','),
    );
    // OLD containers stay readable — the reader takes the stride from the replay, not from
    // this build — but a format-1 TANK replay is refused rather than played back dead
    const legacy: Replay = { ...r, format: 1, tracks: { 0: [1, 0, 0, 0, 0] } };
    check('replay: a format-1 container still parses', simulateReplay(legacy).robots.length === 1);
    check(
      'replay: a format-1 TANK replay is refused, not played back with a dead drivetrain',
      !replayPlayable(legacy, legacy.balanceVersion, legacy.sim ?? 0),
    );
    check(
      'replay: a format-1 MECANUM replay still plays',
      replayPlayable(
        { ...legacy, setups: [{ ...setup, spec: { ...setup.spec, drivetrain: 'mecanum' } }] },
        legacy.balanceVersion, legacy.sim ?? 0,
      ),
    );
    check(
      'replay: a container from a NEWER build is refused',
      !replayPlayable({ ...r, format: REPLAY_FORMAT + 1 }, r.balanceVersion, r.sim ?? 0),
    );
  }
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


// ---- ACCOUNT STANDING: competitive integrity, separate from skill -----------
// Pure derivation, so these are exact. The rules being asserted are the PRODUCT ones — the
// count sets the punishment, abandoning a live match bites immediately while a pre-match
// dodge does not, unreviewed reports never lock anybody out, and there is always a way back
// — rather than the constants agreeing with themselves.
{
  const fresh = (): StandingState => ({ score: STANDING_MAX, restrictedUntil: null });
  const T0 = 1_000_000_000_000;
  const kinds: StandingEventKind[] = ['dodge', 'report', 'afk', 'leave', 'reportUpheld'];
  const enforcedKinds: StandingEventKind[] = ['dodge', 'afk', 'leave', 'reportUpheld'];

  // 1. the tier ladder is ordered, total, and monotonic in how much it aggravates
  {
    let bad = '';
    for (let sc = 0; sc <= STANDING_MAX && !bad; sc++) {
      const t = tierOf(sc);
      if (sc < t.floor) bad = `${sc} placed in ${t.name} below its floor ${t.floor}`;
      const better = STANDING_TIERS[STANDING_TIERS.indexOf(t) - 1];
      if (better && sc >= better.floor) bad = `${sc} placed in ${t.name} but ${better.name} starts at ${better.floor}`;
    }
    check('standing: every score lands in exactly one tier', !bad, bad);

    let regress = '';
    for (let i = 1; i < STANDING_TIERS.length; i++) {
      const hi = STANDING_TIERS[i - 1];
      const lo = STANDING_TIERS[i];
      if (lo.floor >= hi.floor) regress = `${lo.name} floor ${lo.floor} >= ${hi.name} ${hi.floor}`;
      if (lo.bump < hi.bump) regress = `${lo.name} aggravates less than ${hi.name}`;
    }
    check('standing: a worse tier never aggravates less', !regress, regress);
  }

  // 2. SEVERITY ORDER, in points. These events are not comparable and must not cost the
  //    same: a dodge postpones a match, an AFK destroys one, and a moderator upholding a
  //    report is the only event backed by a human looking at the evidence.
  check(
    'standing: severity is ordered report < dodge < afk < leave < upheld',
    STANDING_COST.report < STANDING_COST.dodge &&
      STANDING_COST.dodge < STANDING_COST.afk &&
      STANDING_COST.afk < STANDING_COST.leave &&
      STANDING_COST.leave < STANDING_COST.reportUpheld,
    kinds.map((k) => `${k} ${STANDING_COST[k]}`).join(' · '),
  );

  // 3. THE LADDERS ESCALATE AND SATURATE. Patterned on the reference systems: the n-th
  //    offence is worse than the (n−1)-th because it is the n-th, the clock roughly
  //    multiplies, and it stops growing at the top rather than running away.
  {
    let bad = '';
    for (const k of enforcedKinds) {
      const cools = COOLDOWN_LADDER[k];
      const rates = RATING_LADDER[k];
      for (let i = 1; i < cools.length; i++) {
        if (cools[i] <= cools[i - 1]) bad = `${k} cooldown rung ${i} (${cools[i]}) does not exceed ${cools[i - 1]}`;
      }
      for (let i = 1; i < rates.length; i++) {
        if (rates[i] < rates[i - 1]) bad = `${k} rating rung ${i} goes backwards`;
      }
      if (cools.length < 3) bad = `${k} has too few rungs to escalate (${cools.length})`;
    }
    check('standing: every penalty ladder escalates strictly and saturates', !bad, bad);
    check(
      'standing: the ladders are read past their end, not off it',
      applyStandingEvent(fresh(), 'leave', { now: T0, priorSameKind: 999 }).cooldownMin ===
        COOLDOWN_LADDER.leave[COOLDOWN_LADDER.leave.length - 1],
    );
  }

  // 4. THE TWO TRACKS. This is the distinction the reference systems draw and the one this
  //    module exists to copy: dodging a match that never started is the light track (first
  //    one free, minutes, no rating), abandoning a LIVE one is the heavy track and bites on
  //    the very first offence — there is no requeue that gives the others their match back.
  {
    const dodge1 = applyStandingEvent(fresh(), 'dodge', { now: T0 });
    check(
      'standing: a FIRST dodge restricts nothing and costs no rating',
      dodge1.cooldownMin === 0 && dodge1.ratingCharge === 0 && dodge1.restrictedUntil === null,
      `${dodge1.scoreBefore}->${dodge1.scoreAfter} (${dodge1.tierAfter})`,
    );
    const leave1 = applyStandingEvent(fresh(), 'leave', { now: T0 });
    check(
      'standing: a FIRST abandon locks the queue AND costs rating immediately',
      leave1.cooldownMin > 0 && leave1.ratingCharge > 0 && leave1.restrictedUntil === T0 + leave1.cooldownMin * 60_000,
      `${leave1.cooldownMin}min, -${leave1.ratingCharge} rating`,
    );
    const afk1 = applyStandingEvent(fresh(), 'afk', { now: T0 });
    check(
      'standing: a FIRST AFK is a warning — no lock, no rating',
      afk1.cooldownMin === 0 && afk1.ratingCharge === 0,
      `${afk1.scoreBefore}->${afk1.scoreAfter}`,
    );
    check(
      'standing: the second AFK is not a warning any more',
      applyStandingEvent(fresh(), 'afk', { now: T0, priorSameKind: 1 }).cooldownMin > 0,
    );
    // and the heavy track outweighs the light one at every rung
    let lighter = '';
    for (let n = 0; n < 4; n++) {
      const d = applyStandingEvent(fresh(), 'dodge', { now: T0, priorSameKind: n });
      const l = applyStandingEvent(fresh(), 'leave', { now: T0, priorSameKind: n });
      if (l.cooldownMin <= d.cooldownMin) lighter = `offence ${n + 1}: leave ${l.cooldownMin} <= dodge ${d.cooldownMin}`;
    }
    check('standing: abandoning always outweighs dodging, rung for rung', !lighter, lighter);
  }

  // 5. ONE ACCIDENT STAYS SURVIVABLE. The honest-disconnect rate — one a week, forever —
  //    must never accumulate into a penalty, or the system punishes bad internet.
  {
    let sc = STANDING_MAX;
    let everLocked = false;
    for (let week = 0; week < 20; week++) {
      const v = applyStandingEvent({ score: sc, restrictedUntil: null }, 'dodge', { now: T0, priorSameKind: 0 });
      if (v.cooldownMin > 0) everLocked = true;
      sc = healed(v.scoreAfter, 24 * 7);
    }
    check(
      'standing: one dodge a week never locks the queue and never leaves good standing',
      !everLocked && tierOf(sc).key === 'good',
      `after 20 weeks: ${sc}`,
    );
  }

  // 6. A PATTERN IS NOT SURVIVABLE. Repeats inside the window walk up the ladder fast.
  check(
    'standing: repeats escalate the score cost and then saturate',
    repeatMult(1) === 1 && repeatMult(2) > repeatMult(1) && repeatMult(3) > repeatMult(2) &&
      repeatMult(9) === repeatMult(3) && repeatMult(0) === 1,
    `${repeatMult(1)}/${repeatMult(2)}/${repeatMult(3)}`,
  );
  {
    let st = fresh();
    let n = 0;
    let first = 0;
    while (n < 12 && !st.restrictedUntil) {
      const v = applyStandingEvent(st, 'dodge', { now: T0, priorSameKind: n });
      st = { score: v.scoreAfter, restrictedUntil: v.restrictedUntil };
      n++;
      if (v.cooldownMin) first = v.cooldownMin;
    }
    check(
      'standing: a second dodge in the window already locks the queue',
      n === 2 && first > 0,
      `locked on dodge #${n} for ${first}min`,
    );
  }

  // 7. BAD STANDING AGGRAVATES. A player already in a bad tier does not get the
  //    first-offence rate on a fresh kind of offence — the "you have been here before"
  //    surcharge, applied once rather than duplicated into every ladder.
  {
    const clean = applyStandingEvent(fresh(), 'dodge', { now: T0 });
    const dirty = applyStandingEvent({ score: 25, restrictedUntil: null }, 'dodge', { now: T0 });
    check(
      'standing: a first dodge in bad standing starts further up the ladder',
      dirty.cooldownMin > clean.cooldownMin && dirty.rung > clean.rung,
      `good ${clean.cooldownMin}min (rung ${clean.rung}) vs probation ${dirty.cooldownMin}min (rung ${dirty.rung})`,
    );
    check(
      'standing: the bump reads the tier you LAND in, not the one you came from',
      applyStandingEvent({ score: 41, restrictedUntil: null }, 'leave', { now: T0 }).rung ===
        ladderRung(0, tierOf(41 - STANDING_COST.leave).bump, COOLDOWN_LADDER.leave.length),
    );
    // THE TOP RUNG IS EARNED BY REPETITION, NOT BY A LOW SCORE. Without this the two
    // escalations compound and a second abandon in poor standing jumps straight to the
    // week — a leap nobody can see coming, and not the shape this is patterned on.
    {
      let reached = '';
      for (const k of enforcedKinds) {
        const len = COOLDOWN_LADDER[k].length;
        for (let prior = 0; prior < len - 1; prior++) {
          for (const t of STANDING_TIERS) {
            if (ladderRung(prior, t.bump, len) >= len - 1) {
              reached = `${k}: offence #${prior + 1} in ${t.name} already tops the ladder`;
            }
          }
        }
        if (ladderRung(len - 1, 0, len) !== len - 1) reached = `${k}: the count alone cannot reach the top rung`;
      }
      check('standing: only repetition reaches the harshest rung, never the score alone', !reached, reached);
    }
  }

  // 8. RATING IS THE LIGHT TRACK'S LAST RESORT. A dodge must not touch rating until it is
  //    plainly chronic — dodging is not bad driving, and the rating measures driving.
  {
    check(
      'standing: dodging costs no rating until it is chronic',
      RATING_LADDER.dodge[0] === 0 && RATING_LADDER.dodge[1] === 0 &&
        RATING_LADDER.dodge[RATING_LADDER.dodge.length - 1] > 0,
      RATING_LADDER.dodge.join('/'),
    );
    let early = '';
    for (const n of [0, 1, 2]) {
      const v = applyStandingEvent(fresh(), 'dodge', { now: T0, priorSameKind: n });
      if (v.ratingCharge > 0) early = `dodge #${n + 1} from good standing charged ${v.ratingCharge}`;
    }
    check('standing: the first dodges of a clean account never cost rating', !early, early);
  }

  // 9. UNREVIEWED REPORTS NEVER LOCK ANYBODY OUT. This is the abuse vector a report system
  //    has to be built against: a squad that loses a match must not be able to queue-ban the
  //    winner. They move the score (which surfaces them to a moderator) and nothing else.
  {
    let enforced = '';
    for (const sc of [100, 45, 25, 5]) {
      const v = applyStandingEvent({ score: sc, restrictedUntil: null }, 'report', { now: T0, count: 9 });
      if (v.cooldownMin || v.ratingCharge || v.restrictedUntil) enforced = `report @${sc} enforced ${v.cooldownMin}min/${v.ratingCharge}r`;
      if (v.points > STANDING_COST.report * REPORT_CAP * repeatMult(1)) enforced = `report count uncapped: ${v.points}`;
    }
    check('standing: raw reports never restrict the queue or charge rating, and are capped', !enforced, enforced);
    const upheld = applyStandingEvent({ score: 55, restrictedUntil: null }, 'reportUpheld', { now: T0 });
    check(
      'standing: a moderator upholding reports DOES restrict',
      upheld.cooldownMin > 0 && upheld.ratingCharge > 0,
      `${upheld.scoreBefore}->${upheld.scoreAfter} ${upheld.cooldownMin}min`,
    );
  }

  // 10. THE WINDOWS DECAY AT DIFFERENT SPEEDS, slower for the serious offences — a dodge is
  //     a same-session mistake, walking out of matches is a habit worth remembering.
  check(
    'standing: serious offences are remembered longer than dodges',
    WINDOW_HOURS.leave > WINDOW_HOURS.dodge && WINDOW_HOURS.afk > WINDOW_HOURS.dodge &&
      WINDOW_HOURS.reportUpheld >= WINDOW_HOURS.leave,
    `dodge ${WINDOW_HOURS.dodge}h · leave ${WINDOW_HOURS.leave}h · upheld ${WINDOW_HOURS.reportUpheld}h`,
  );

  // 11. RECOVERY. The debt has to be workable off, both by playing and by time — but waiting
  //     must never beat playing, or the system teaches players to stop playing.
  {
    check(
      'standing: playing clean recovers faster per day than idling',
      HEAL_PER_CLEAN_MATCH * 4 > HEAL_PER_DAY,
      `${HEAL_PER_CLEAN_MATCH}/match vs ${HEAL_PER_DAY}/day`,
    );
    check('standing: healing caps at the maximum', healed(STANDING_MAX, 24 * 365) === STANDING_MAX);
    check('standing: healing is granted per whole day, never retroactively negative',
      healed(50, 0) === 50 && healed(50, 23) === 50 && healed(50, 24) === 50 + HEAL_PER_DAY && healed(50, -5) === 50);
    // IDLING MUST NOT BE A STRATEGY. The lock itself is an absolute deadline, so waiting
    // never shortens it — but the SCORE heals while it runs, and if that healing could
    // return a suspended player to a clean slate, sitting out would be the cheapest way to
    // clear a record. Serving even the longest lock must leave them still marked.
    const susp = applyStandingEvent({ score: 15, restrictedUntil: null }, 'leave', { now: T0 });
    const healedBack = healed(susp.scoreAfter, susp.cooldownMin / 60);
    check(
      'standing: you cannot idle your way back to good standing while serving a lock',
      tierOf(healedBack).key !== 'good' && healedBack < STANDING_MAX,
      `${susp.scoreAfter} -> ${healedBack} (${tierOf(healedBack).name}) after ${susp.cooldownMin}min`,
    );
  }

  // 12. the score is CLAMPED and total-function: no offence prints a negative or a NaN
  {
    let bad = '';
    for (const k of kinds) {
      for (const sc of [0, 1, 100, -50, 1e9, NaN, Infinity]) {
        const v = applyStandingEvent({ score: sc, restrictedUntil: null }, k, { now: T0, priorSameKind: 99 });
        if (!Number.isFinite(v.scoreAfter) || v.scoreAfter < 0 || v.scoreAfter > STANDING_MAX) {
          bad = `${k} @${sc} -> ${v.scoreAfter}`;
        }
        if (!Number.isFinite(v.cooldownMin) || v.cooldownMin < 0) bad = `${k} @${sc} cooldown ${v.cooldownMin}`;
      }
    }
    check('standing: the score and the lock are total functions of any input', !bad, bad);
    check('standing: a broken stored score reads as full, not as suspended',
      clampScore(NaN) === STANDING_MAX && clampScore(undefined as unknown as number) === STANDING_MAX);
  }

  // 13. an existing lock is EXTENDED, never shortened, by a new offence
  {
    const long = T0 + 10 * 3_600_000;
    const v = applyStandingEvent({ score: 45, restrictedUntil: long }, 'dodge', { now: T0 });
    check('standing: a new offence never shortens an existing lock', v.restrictedUntil === long, `${v.restrictedUntil}`);
    check('standing: the queue is locked while the clock runs and opens after it',
      queueLocked({ score: 45, restrictedUntil: long }, T0) &&
        !queueLocked({ score: 45, restrictedUntil: long }, long + 1) &&
        !queueLocked({ score: 5, restrictedUntil: null }, T0));
    check('standing: the remaining lock reads in human units',
      lockRemaining(T0 + 30 * 60_000, T0) === '30 minutes' && lockRemaining(T0 + 7_200_000, T0) === '2 hours');
  }

  // 15. WHO SAT IT OUT vs WHO WALKED AWAY, judged from what the server actually counted.
  //     The failure mode that matters here is charging an innocent player, so the checks are
  //     written from that side: a short match is never judged, a quiet-but-present driver is
  //     not a leaver, and someone merely bad at the game is not an offender at all.
  {
    const F = MIN_JUDGED_TICKS * 4; // a full-length match's live ticks
    check(
      'standing: a driver who played is not charged',
      judgeParticipation({ liveTicks: F, driveTicks: F * 0.9, awayTicks: 0 }) === null,
    );
    check(
      'standing: a quiet but present driver (barely over the AFK bar) is not charged',
      judgeParticipation({ liveTicks: F, driveTicks: Math.ceil(F * (AFK_DRIVE_FRACTION + 0.02)), awayTicks: 0 }) === null,
    );
    check(
      'standing: driving for almost none of the match is AFK',
      judgeParticipation({ liveTicks: F, driveTicks: Math.floor(F * 0.02), awayTicks: 0 }) === 'afk',
    );
    check(
      'standing: being disconnected for most of it is LEAVING, not AFK',
      judgeParticipation({ liveTicks: F, driveTicks: 0, awayTicks: Math.ceil(F * (LEAVE_AWAY_FRACTION + 0.1)) }) === 'leave',
    );
    check(
      'standing: a brief dropout mid-match is neither',
      judgeParticipation({ liveTicks: F, driveTicks: F * 0.8, awayTicks: Math.floor(F * 0.05) }) === null,
    );
    // the one that protects innocent players: nothing is judged from a match too short to
    // mean anything (a cancel, a restart, a room that died in its first seconds)
    let judgedShort = '';
    for (const t of [0, 1, MIN_JUDGED_TICKS - 1]) {
      if (judgeParticipation({ liveTicks: t, driveTicks: 0, awayTicks: t }) !== null) judgedShort = `${t} ticks judged`;
    }
    check('standing: a match too short to judge charges nobody', !judgedShort, judgedShort);
    check(
      'standing: broken counters never produce a charge',
      judgeParticipation({ liveTicks: NaN, driveTicks: 0, awayTicks: 0 }) === null &&
        judgeParticipation({ liveTicks: -5, driveTicks: 0, awayTicks: 0 }) === null,
    );
  }
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

/**
 * PLAYER REPORTS — resolution, which is the part that can be abused.
 *
 * A report names a ROBOT ID, never a user id, and the ROOM maps it onto an account from its
 * own roster. That is what stops a crafted message reporting an arbitrary person, so these
 * check the mapping and every way it should refuse rather than the DB write.
 */
{
  const mk = (id: string, userId: string | undefined, robot: number): Client => ({
    id,
    send: () => {},
    player: { clientId: id, name: id, teamName: 'T', teamNumber: 1, alliance: robot === 0 ? 'red' : 'blue', startIndex: 0, ready: true, spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS } },
    connected: true,
    disconnectAt: 0,
    userId,
    caps: ['strategy'],
  });
  const room = new Room('smoke-report', () => {}, { kind: 'versus' });
  room.add(mk('a', 'u-a', 0));
  room.add(mk('b', 'u-b', 1));
  room.onMessage('a', { t: 'start' }); // assigns robot ids from the roster

  const ok = room.resolveReport('a', 1);
  check(
    'report: a robot id resolves to that driver\'s account, server-side',
    ok?.reporterId === 'u-a' && ok?.reportedId === 'u-b',
    JSON.stringify(ok),
  );
  check('report: you cannot report YOURSELF', room.resolveReport('a', 0) === null);
  check('report: an unknown robot id resolves to nothing', room.resolveReport('a', 7) === null);
  check(
    'report: a client that is not in this room cannot report into it',
    room.resolveReport('nobody', 1) === null,
  );

  // an ANONYMOUS reporter or target is not actionable — a report has to be attributable at
  // both ends or a moderator cannot tell a pattern from a brigade
  const anon = new Room('smoke-report-anon', () => {}, { kind: 'versus' });
  anon.add(mk('a', 'u-a', 0));
  anon.add(mk('b', undefined, 1));
  anon.onMessage('a', { t: 'start' });
  check('report: an anonymous TARGET cannot be reported', anon.resolveReport('a', 1) === null);
  const anon2 = new Room('smoke-report-anon2', () => {}, { kind: 'versus' });
  anon2.add(mk('a', undefined, 0));
  anon2.add(mk('b', 'u-b', 1));
  anon2.onMessage('b', { t: 'start' });
  check('report: an anonymous REPORTER cannot report', anon2.resolveReport('a', 1) === null);

  // the category list is validated at the boundary — a crafted reason never reaches the DB
  check(
    'report: only known categories are accepted',
    isReportReason('cheating') && isReportReason('name') &&
      !isReportReason('drop table') && !isReportReason('') && !isReportReason(null),
  );
  // and there is no CHAT category, because this game has no chat — offering one would
  // collect reports nobody could ever act on
  check(
    'report: no chat/messaging category (DSIM has neither)',
    !REPORT_REASONS.some((r) => /chat|message|voice/i.test(r)),
    REPORT_REASONS.join(','),
  );
}

/**
 * DODGE ATTRIBUTION — who gets billed when a staged ranked pairing dies.
 *
 * The penalty scale is tested as pure math elsewhere; what matters here is that the room
 * names the RIGHT player. Punishing the person who showed up and readied would be far worse
 * than not having the feature, so each of the three failure shapes gets its own case, and
 * each asserts the innocent party is charged nothing.
 *
 * The room reports through its `onDodge` seam, so no database is involved.
 */
{
  const mkClient = (id: string, userId: string, rec: Record<string, ServerMsg[]>): Client => {
    rec[id] = [];
    return {
      id,
      send: (m) => rec[id].push(m),
      player: { clientId: id, name: id, teamName: 'T', teamNumber: 1, alliance: 'red', startIndex: 0, ready: false, spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS } },
      connected: true,
      disconnectAt: 0,
      userId,
      caps: ['strategy'],
    };
  };
  const roster = [
    { userId: 'u-red', name: 'red', teamName: 'T', teamNumber: 1, spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS }, startIndex: 0, alliance: 'red' as const, introElo: null },
    { userId: 'u-blue', name: 'blue', teamName: 'T', teamNumber: 1, spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS }, startIndex: 0, alliance: 'blue' as const, introElo: null },
  ];
  /** build a staged ranked room, capturing what the room reports as the dodge */
  const staged = (label: string, attach: string[]) => {
    const rec: Record<string, ServerMsg[]> = {};
    const reports: DodgeReport[] = [];
    const room = new Room(
      label, () => {}, { kind: 'versus' }, undefined, undefined, undefined,
      (d) => { reports.push(d); return []; },
    );
    for (const id of attach) room.add(mkClient(id, `u-${id}`, rec));
    room.applyPending({ code: `iad-${label}`, hostRegion: 'iad', mode: '1v1', seed: 11, ranked: true, roster });
    return { room, rec, reports };
  };
  const culpritsOf = (reports: DodgeReport[]): string =>
    reports.flatMap((r) => r.culprits.map((c) => `${c.userId}:${c.kind}`)).sort().join(',');

  // 1. NO-SHOW — blue never connects, the join grace lapses. Red showed up: not their fault.
  {
    const { room, reports } = staged('smoke-dodge-noshow', ['red']);
    room.forceJoinGraceForTest();
    check(
      'dodge: a no-show past the join grace is billed to the player who never connected',
      culpritsOf(reports) === 'u-blue:noshow',
      culpritsOf(reports) || '(nobody billed)',
    );
    check(
      'dodge: the player who DID connect is not billed for the no-show',
      !culpritsOf(reports).includes('u-red'),
    );
  }

  // 2. STRATEGY BAIL — both connect, then blue's socket goes during the window.
  {
    const { room, reports } = staged('smoke-dodge-bail', ['red', 'blue']);
    room.detach('blue');
    check(
      'dodge: a drop during the strategy window is billed to the player who left',
      culpritsOf(reports) === 'u-blue:bail',
      culpritsOf(reports) || '(nobody billed)',
    );
  }

  // 3. NEVER READIED — both connect, only red readies, the deadline lapses.
  {
    const { room, reports } = staged('smoke-dodge-unready', ['red', 'blue']);
    room.onMessage('red', { t: 'update', patch: { ready: true } });
    room.forceStrategyDeadlineForTest();
    check(
      'dodge: sitting out the ready window is billed to the player who never readied',
      culpritsOf(reports) === 'u-blue:unready',
      culpritsOf(reports) || '(nobody billed)',
    );
    check(
      'dodge: the player who readied on time is not billed',
      !culpritsOf(reports).includes('u-red'),
    );
  }

  // 4. A CUSTOM room is not ranked, so abandoning one costs nothing — the contract the
  //    penalty enforces only exists for a pairing the matchmaker committed people to.
  {
    const rec: Record<string, ServerMsg[]> = {};
    const reports: DodgeReport[] = [];
    const room = new Room(
      'smoke-dodge-custom', () => {}, { kind: 'versus' }, undefined, undefined, undefined,
      (d) => { reports.push(d); return []; },
    );
    room.add(mkClient('red', 'u-red', rec));
    room.add(mkClient('blue', 'u-blue', rec));
    room.detach('blue');
    check('dodge: leaving a CUSTOM room is never a dodge', reports.length === 0);
  }

  // 5. the whole roster is reported, so the innocent can be told they were NOT charged
  {
    const { room, reports } = staged('smoke-dodge-roster', ['red']);
    room.forceJoinGraceForTest();
    check(
      'dodge: the report carries the full roster, so the innocent can be told',
      reports[0]?.rosterUserIds.slice().sort().join(',') === 'u-blue,u-red',
      reports[0]?.rosterUserIds.join(','),
    );
  }
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
   * A DEAD NETWORK SESSION MUST NOT KEEP SIMULATING.
   *
   * Reported bug: rejoining a match that had already finished dropped the player into what
   * read as an offline solo practice field — remote robots frozen at their spawn poses, the
   * local robot fully drivable, for over a minute. The cause is that prediction's LEAD CAP
   * is gated on having seen a snapshot, so a session that never connected had no bound at
   * all on how far it would predict forward.
   *
   * This checks the invariant directly against a stub session that reports `failed`: the
   * world must not advance a single tick.
   */
  {
    const setups: RobotSetup[] = [
      { id: 0, alliance: 'blue', spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS }, startIndex: 0 },
      { id: 1, alliance: 'red', spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS }, startIndex: 0 },
    ];
    const w = createWorld('match', 7, setups);
    const before = { tick: w.tick, x: w.robots[0].pos.x, y: w.robots[0].pos.y };
    // drive hard for a simulated 3 seconds, exactly as the player did
    const cmd: RobotCommand = { driveX: 1, driveY: 1, rotate: 0.5, leftDrive: 1, rightDrive: 1, intake: true, fire: false };
    // The guard is `if (session.status().failed) return;` at the top of stepServer. Model it
    // here rather than constructing a GameController (which needs a DOM canvas): the point
    // under test is that a failed session short-circuits BEFORE any step() call.
    const failed = { failed: true };
    let stepped = 0;
    for (let i = 0; i < 180; i++) {
      if (failed.failed) continue; // ← the guard
      step(w, SIM_DT, new Map([[0, cmd]]));
      stepped++;
    }
    check(
      'net: a FAILED session never advances the world (no offline sandbox)',
      stepped === 0 && w.tick === before.tick &&
        w.robots[0].pos.x === before.x && w.robots[0].pos.y === before.y,
      `stepped=${stepped} tick=${w.tick}`,
    );
    // and the counter-case: a LIVE session obviously does move (so the guard is the thing
    // stopping it, not some other reason the world was already static)
    const w2 = createWorld('match', 7, setups);
    for (let i = 0; i < 180; i++) step(w2, SIM_DT, new Map([[0, cmd]]));
    check(
      'net: the same input DOES move a live world (the guard is what stops it)',
      w2.tick > before.tick && (w2.robots[0].pos.x !== before.x || w2.robots[0].pos.y !== before.y),
      `tick=${w2.tick}`,
    );
    // The two checks above model the guard; this one pins the REAL line. GameController needs
    // a DOM canvas so it cannot be built here, and a modelled invariant protects nothing if
    // the guard it models is deleted from `stepServer`.
    const gameSrc = readFileSync('src/game.ts', 'utf8');
    const stepServerBody = gameSrc.slice(gameSrc.indexOf('private stepServer('));
    const guardAt = stepServerBody.indexOf('status().failed');
    const firstStepAt = stepServerBody.indexOf('this.mod.step(');
    check(
      'net: stepServer BAILS on a failed session before it steps the world',
      guardAt > 0 && firstStepAt > 0 && guardAt < firstStepAt,
      `guard@${guardAt} firstStep@${firstStepAt}`,
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

  /**
   * RAIL CATALYST — a claw on a track that TRAVERSES the mounted side, plus the placement
   * rules that come with occupying a whole side.
   */
  {
    // 1. a rail can only be bolted to an EDGE (its track needs a span to run along)
    let notEdge = '';
    for (const m of CHAIN_CATALYST_MOUNTS) {
      const c = coerceSpec({ ...DEFAULT_SPEC, catalystType: 'rail', catalystMount: m, scoreMode: 'turret', shooterMount: 'center' }, DEFAULT_SPEC, 'chain');
      if (c.catalystType === 'rail' && !isEdgePos(c.catalystMount as string)) notEdge = `${m} -> ${c.catalystMount}`;
    }
    check('chain rail: every mount folds to one of the four edges', !notEdge, notEdge);

    // 2. the catalyst never shares a cell with the SHOOTER, whatever the two are set to
    let shared = '';
    for (const sm of CHAIN_TURRET_POSITIONS) {
      for (const cm of CHAIN_CATALYST_MOUNTS) {
        for (const mode of ['turret', 'drum'] as const) {
          for (const ct of ['arm', 'rail'] as const) {
            const c = coerceSpec(
              { ...DEFAULT_SPEC, scoreMode: mode, shooterMount: sm, catalystType: ct, catalystMount: cm },
              DEFAULT_SPEC, 'chain',
            );
            if (mountsClash(
              { pos: c.catalystMount as string, spansEdge: c.catalystType === 'rail' },
              { pos: c.shooterMount as string, spansEdge: !isTurreted(c.scoreMode) },
            )) shared = `${mode}/${sm} + ${ct}/${cm} -> ${c.catalystMount}`;
          }
        }
      }
    }
    check('chain rail: a catalyst is never left sharing a cell with the shooter', !shared, shared);

    // 3. the CARRIAGE actually moves, at a finite rate, and is clamped to the track
    {
      const spec = coerceSpec(
        { ...DEFAULT_SPEC, catalystType: 'rail', catalystMount: 'back', scoreMode: 'turret', shooterMount: 'center' },
        DEFAULT_SPEC, 'chain',
      );
      const half = catalystRailHalf(spec);
      check('chain rail: the track spans the mounted side', half > 1, `half=${half.toFixed(2)}`);
      const w = createChainWorld('match', 5, [
        { id: 0, alliance: 'blue', spec, assists: { ...DEFAULT_ASSISTS }, startIndex: 0 },
      ]);
      const rob = w.robots[0];
      check('chain rail: the carriage starts centred', rob.catalystRail === 0);
      // a target far off to one side must pull the carriage that way, and it must take TIME
      const far = { x: rob.pos.x + 40, y: rob.pos.y + 40 };
      const want = catalystRailTarget(rob, far);
      check('chain rail: an off-centre target wants an off-centre carriage', Math.abs(want) > 0.2, `want=${want.toFixed(2)}`);
      check('chain rail: the wanted position is clamped to the track', Math.abs(want) <= 1 + 1e-9);
      // and the MOUTH moves with the carriage — that is the whole mechanism
      const centred = catalystMouth(rob);
      const slid = catalystMouth({ ...rob, catalystRail: 1 });
      check(
        'chain rail: sliding the carriage MOVES the claw',
        hyp(slid.x - centred.x, slid.y - centred.y) > 1,
        `moved ${hyp(slid.x - centred.x, slid.y - centred.y).toFixed(2)}in`,
      );
      // a plain TURRET claw has no track, so its mouth cannot slide
      const fixedSpec = coerceSpec({ ...spec, catalystType: 'turret' }, DEFAULT_SPEC, 'chain');
      check('chain rail: a plain turret claw has no travel', catalystRailHalf(fixedSpec) === 0);

      /**
       * 3b. THE SWING IS A MECHANISM, NOT A PLACE.
       *
       * It used to be the mount value `'frontback'`, welded to the centre cell of the picker,
       * which made "a swing" and "on the right" mutually exclusive choices — so a fore-aft
       * swing arm bolted to the right rail (an ordinary build, and one of the shipped presets)
       * could not be expressed at all. The flag and the position are now independent.
       */
      {
        // a CENTRE turret as the fixture: it occupies one cell in the middle, so it never
        // relocates the claw and these checks measure the swing rules rather than the clash
        // rules (which have their own check at the end of this block)
        const build = (over: Partial<RobotSpec>): RobotSpec =>
          coerceSpec({ ...DEFAULT_SPEC, catalystType: 'arm', scoreMode: 'turret', shooterMount: 'center', ...over },
            DEFAULT_SPEC, 'chain');

        // the LEGACY value migrates to the new shape and keeps behaving exactly as it did
        const legacy = build({ catalystMount: 'frontback' as RobotSpec['catalystMount'] });
        check(
          'chain swing: the legacy frontback mount migrates to a centre pivot',
          catalystMountOf(legacy) === 'center' && catalystSwingOf(legacy) === 'fb' &&
            JSON.stringify(catalystMountPositions(catalystMountOf(legacy), 'fb')) === JSON.stringify(['front', 'back']),
          `${catalystMountOf(legacy)} swing=${catalystSwingOf(legacy)}`,
        );

        // A SWING ON THE RIGHT — the build this whole change exists for. It works the two
        // RIGHT-hand corners, and nothing on the left.
        const right = build({ catalystMount: 'right', catalystSwing: true });
        const ends = catalystMountPositions(catalystMountOf(right), catalystSwingOf(right));
        check(
          'chain swing: a RIGHT swing works the front-right and back-right, not the left',
          catalystSwingOf(right) && catalystMountOf(right) === 'right' &&
            ends.includes('frontright') && ends.includes('backright') &&
            !ends.some((e) => e.includes('left')),
          `${catalystMountOf(right)} -> ${ends.join('+')}`,
        );
        check(
          'chain swing: a LEFT swing mirrors it',
          JSON.stringify(catalystMountPositions('left', 'fb')) === JSON.stringify(['frontleft', 'backleft']),
        );

        /**
         * THE OTHER AXIS. A swing arm can be turned 90°: same one arm on a pivot, reaching
         * over the two FLANKS instead of the two ends. Which positions it can be bolted to
         * follows from that — a lateral pivot needs a left and a right, so it lives on the
         * centre line or an END, exactly mirroring the fore-aft rule.
         */
        const lat = build({ catalystMount: 'front', catalystSwing: 'lr' });
        check(
          'chain swing: a LEFT-RIGHT swing on the front works both flanks',
          catalystSwingOf(lat) === 'lr' && catalystMountOf(lat) === 'front' &&
            JSON.stringify(catalystMountPositions('front', 'lr')) === JSON.stringify(['frontleft', 'frontright']),
          `${catalystMountOf(lat)} ${catalystSwingOf(lat)}`,
        );
        check(
          'chain swing: a centre pivot swings over the ends or the flanks, by axis',
          JSON.stringify(catalystMountPositions('center', 'fb')) === JSON.stringify(['front', 'back']) &&
            JSON.stringify(catalystMountPositions('center', 'lr')) === JSON.stringify(['left', 'right']),
        );
        // ...and the legal positions are exactly mirrored between the two axes
        for (const [axis, illegal] of [['fb', ['front', 'back']], ['lr', ['left', 'right']]] as const) {
          for (const m of illegal) {
            const bad = build({ catalystMount: m, catalystSwing: axis });
            check(
              `chain swing: a ${axis} pivot cannot be bolted to ${m} (its two ends are not both reachable)`,
              !catalystSwingOf(bad) && catalystMountOf(bad) === m,
              `${catalystMountOf(bad)} swing=${catalystSwingOf(bad)}`,
            );
          }
        }
        check(
          'chain swing: the CENTRE is the one position both axes can use',
          isSwingMount('center', 'fb') && isSwingMount('center', 'lr') &&
            swingAxesFor('center').length === 2 && swingAxesFor('frontleft').length === 0,
          swingAxesFor('center').join('+'),
        );

        // a pivot needs a front and a back to swing between, so an END or a CORNER is not a
        // place one can go — the SWING is dropped, the mount the player chose is kept
        for (const m of ['front', 'back', 'frontleft', 'backright'] as const) {
          const bad = build({ catalystMount: m, catalystSwing: 'fb' });
          check(
            `chain swing: a pivot cannot be bolted to ${m} (swing dropped, mount kept)`,
            !catalystSwingOf(bad) && catalystMountOf(bad) === m,
            `${catalystMountOf(bad)} swing=${catalystSwingOf(bad)}`,
          );
        }
        // ONLY THE ARM SWINGS: a turret claw already aims through a full circle and a rail
        // already traverses its side, so a pivot buys neither anything — and offering it
        // would be a control that changes nothing
        for (const t of ['rail', 'turret', 'launcher'] as const) {
          const other = build({ catalystType: t, catalystMount: 'center', catalystSwing: 'fb' });
          check(`chain swing: a ${t} never swings`, !catalystSwingOf(other), `${catalystMountOf(other)} swing=${catalystSwingOf(other)}`);
        }
        // ...and nothing reaches from the middle of a chassis without one
        const middle = build({ catalystMount: 'center' });
        check(
          'chain swing: a centre mount with no pivot is moved to an edge',
          catalystMountOf(middle) !== 'center',
          catalystMountOf(middle),
        );

        // THE CENTRE PIVOT MUST NOT CLASH WITH A CENTRE TURRET. A swing claims the ends it
        // sweeps, not the post it turns on — if it claimed the middle cell, the commonest CR
        // build in the game (centre turret + centre swing, two shipped presets) would be
        // illegal and coerceSpec would silently move the claw somewhere else.
        const rocky = coerceSpec(
          { ...DEFAULT_SPEC, scoreMode: 'twinturret', shooterMount: 'center',
            catalystType: 'arm', catalystMount: 'center', catalystSwing: 'fb' },
          DEFAULT_SPEC, 'chain',
        );
        check(
          'chain swing: a centre pivot coexists with a centre turret',
          catalystMountOf(rocky) === 'center' && catalystSwingOf(rocky),
          `${catalystMountOf(rocky)} swing=${catalystSwingOf(rocky)}`,
        );
      }

      /**
       * 4. THE SPRITE AND THE SIM SLIDE THE SAME WAY.
       *
       * `drawChainRobot` draws the carriage inside a frame rotated by `MOUNT_ANGLE[pos]` and
       * offsets it along that frame's +y. The sim used to derive its own axis from the raw
       * robot frame instead — which matches on `front` and `right` and is exactly INVERTED on
       * `back` and `left`, so on half the mounts the carriage was drawn sliding one way while
       * the claw actually worked from the other. Both now read `RAIL_DIR`; this asserts that
       * table really is the mount's local +y, and that the MOUTH follows it.
       */
      for (const mount of ['front', 'back', 'left', 'right'] as const) {
        const ms = coerceSpec(
          { ...DEFAULT_SPEC, catalystType: 'rail', catalystMount: mount, scoreMode: 'turret', shooterMount: 'center' },
          DEFAULT_SPEC, 'chain',
        );
        // the renderer's slide axis: local +y taken through the mount rotation it applies
        const a = MOUNT_ANGLE[mount];
        const drawn = { x: -dsin(a), y: dcos(a) }; // rotate (0,1) by MOUNT_ANGLE
        check(
          `chain rail: RAIL_DIR[${mount}] IS the drawn frame's +y`,
          Math.abs(RAIL_DIR[mount].x - drawn.x) < 1e-9 && Math.abs(RAIL_DIR[mount].y - drawn.y) < 1e-9,
          `table (${RAIL_DIR[mount].x},${RAIL_DIR[mount].y}) vs drawn (${drawn.x.toFixed(3)},${drawn.y.toFixed(3)})`,
        );
        // and the SIM's mouth moves along that same axis when the carriage slides
        const w3 = createChainWorld('match', 3, [
          { id: 0, alliance: 'blue', spec: ms, assists: { ...DEFAULT_ASSISTS }, startIndex: 0 },
        ]);
        const rr = w3.robots[0];
        rr.pos = { x: 0, y: 0 };
        rr.heading = 0; // robot frame == world frame, so the mouth delta reads directly
        const hf = catalystRailHalf(ms);
        const at0 = catalystMouth({ ...rr, catalystRail: 0 });
        const at1 = catalystMouth({ ...rr, catalystRail: 1 });
        const moved = { x: at1.x - at0.x, y: at1.y - at0.y };
        check(
          `chain rail: a ${mount} carriage at +1 puts the claw where the sprite draws it`,
          Math.abs(moved.x - RAIL_DIR[mount].x * hf) < 1e-6 && Math.abs(moved.y - RAIL_DIR[mount].y * hf) < 1e-6,
          `mouth moved (${moved.x.toFixed(2)},${moved.y.toFixed(2)}), sprite slides (${(RAIL_DIR[mount].x * hf).toFixed(2)},${(RAIL_DIR[mount].y * hf).toFixed(2)})`,
        );
        // ...and a target on that side must WANT that end, not the opposite one — the sign
        // the player actually sees
        const probe = {
          x: at0.x + RAIL_DIR[mount].x * (hf + 2),
          y: at0.y + RAIL_DIR[mount].y * (hf + 2),
        };
        check(
          `chain rail: a ${mount} target on the +side wants the +end (no inversion)`,
          catalystRailTarget(rr, probe) > 0.5,
          `want=${catalystRailTarget(rr, probe).toFixed(2)}`,
        );
      }

      /**
       * 5. WHAT THE CARRIAGE TRACKS — the behaviour, not the geometry.
       *
       * The parts above all passed while the mechanism was visibly broken in a match,
       * because every one of them tested a piece in isolation. What was wrong was the
       * TARGET: the carriage stowed itself centred whenever the robot was carrying (i.e.
       * exactly when a placement needed the reach), it offered empty hooks to an
       * empty-handed claw, it ignored seated rings, and with nothing nearby it pinned
       * itself against an end stop chasing a hook across the field. These assert the
       * mechanism does the job, not that its maths is self-consistent.
       */
      const chainOf = (world: World) => world.chain!;
      const drive = (world: World, ticks: number) => { for (let i = 0; i < ticks; i++) chainStep(world, SIM_DT, new Map()); };
      const parkAt = (world: World, p: Vec2, headingRad: number) => {
        const rr = world.robots[0];
        rr.pos = { x: p.x, y: p.y };
        rr.heading = headingRad;
        rr.catalystRail = 0;
      };
      {
        const w2 = createChainWorld('match', 9, [
          { id: 0, alliance: 'blue', spec, assists: { ...DEFAULT_ASSISTS }, startIndex: 0 },
        ]);
        w2.match.phase = 'teleop';
        w2.match.phaseTimeLeft = 120;
        const rr = w2.robots[0];
        const ch = chainOf(w2);
        const stow = (): void => { for (const c of ch.catalysts) { c.carriedBy = null; c.hook = null; c.pos = { x: -60, y: -60 }; } };

        // (a) CARRYING, parked beside an empty hook: the carriage MUST traverse to place.
        stow();
        const hook = hookPos('blue', 1);
        parkAt(w2, { x: hook.x - 5, y: hook.y - 10 }, 0);
        ch.catalysts[0].carriedBy = rr.id;
        const carryTgt = catalystTrackTarget(rr, w2);
        drive(w2, 120);
        check(
          'chain rail: a carried ring tracks an empty HOOK and traverses to place it',
          !!carryTgt && Math.abs(rr.catalystRail) > 0.2,
          `target=${carryTgt ? 'hook' : 'null'} carriage=${rr.catalystRail.toFixed(2)}`,
        );

        // (b) NOTHING IN RANGE: stow centred, never parked against an end stop.
        stow();
        parkAt(w2, { x: 0, y: 0 }, 0);
        drive(w2, 180);
        check(
          'chain rail: with nothing in range the carriage stows centred, not at an end stop',
          Math.abs(rr.catalystRail) < 1e-6,
          `carriage=${rr.catalystRail.toFixed(3)}`,
        );
        check('chain rail: nothing in range means no target at all', catalystTrackTarget(rr, w2) === null);

        // (c) EMPTY-HANDED: a SEATED ring is a legal grab (de-score) and must be tracked...
        stow();
        const seat = hookPos('blue', 0);
        ch.catalysts[0].hook = { alliance: 'blue', index: 0 };
        parkAt(w2, { x: seat.x - 6, y: seat.y - 8 }, 0);
        const seatedTgt = catalystTrackTarget(rr, w2);
        check(
          'chain rail: an empty claw tracks a SEATED ring (de-scoring is a legal grab)',
          !!seatedTgt && hyp(seatedTgt.x - seat.x, seatedTgt.y - seat.y) < 0.01,
          seatedTgt ? `(${seatedTgt.x.toFixed(1)},${seatedTgt.y.toFixed(1)})` : 'null',
        );

        // ...but an EMPTY hook is not a target for an empty claw: there is nothing on it.
        stow();
        parkAt(w2, { x: seat.x - 6, y: seat.y - 8 }, 0);
        check(
          'chain rail: an empty claw never tracks an EMPTY hook',
          catalystTrackTarget(rr, w2) === null,
        );

        // (d) CARRYING: a loose ring on the floor is not a target — the claw is full.
        stow();
        parkAt(w2, { x: 0, y: 0 }, 0);
        ch.catalysts[0].carriedBy = rr.id;
        ch.catalysts[1].pos = { x: rr.pos.x + 6, y: rr.pos.y + 4 };
        check(
          'chain rail: a full claw never tracks a loose ring it cannot pick up',
          catalystTrackTarget(rr, w2) === null,
        );

        // (e) the traverse is RATE-LIMITED and clamped — a machine moving, not a teleport
        stow();
        const near = hookPos('blue', 1);
        parkAt(w2, { x: near.x - 5, y: near.y - 10 }, 0);
        ch.catalysts[0].carriedBy = rr.id;
        drive(w2, 1);
        const afterOne = Math.abs(rr.catalystRail);
        drive(w2, 240);
        check(
          'chain rail: the carriage takes TIME to traverse and stays on the track',
          afterOne > 0 && afterOne <= CHAIN_RAIL_RATE * SIM_DT + 1e-9 && Math.abs(rr.catalystRail) <= 1 + 1e-9,
          `one tick moved ${afterOne.toFixed(4)}, settled at ${rr.catalystRail.toFixed(2)}`,
        );
      }
    }
  }

  /**
   * CR CHASSIS SIZE. The sweeper DEPLOYS, so it never had to share the 18" starting cube
   * with the chassis — every build gets the same envelope, and the mount is paid for in
   * HOPPER volume instead. The floor is 15" (CR robots are hoppers first) and the ceiling is
   * 17", which the FIELD sets: a bigger chassis has no legal start pose at all.
   */
  {
    const size = (intake: RobotSpec['intake'], mount: RobotSpec['intakeMount']) =>
      chainSizeLimits({ ...DEFAULT_SPEC, intake, intakeMount: mount });
    check(
      'chain size: the floor is 15in on both axes',
      CHAIN_MIN_LENGTH === 15 && CHAIN_MIN_WIDTH === 15,
      `${CHAIN_MIN_LENGTH}x${CHAIN_MIN_WIDTH}`,
    );
    // A SINGLE sweeper never constrains the chassis any more: the deployed robot is at most
    // 17 + 5 = 22in, inside the 24in expansion prism whatever the intake.
    let singleCost = '';
    for (const intake of ['sloped', 'vector', 'triangle'] as RobotSpec['intake'][]) {
      for (const mount of ['front', 'back'] as RobotSpec['intakeMount'][]) {
        const l = size(intake, mount);
        if (l.maxLength !== CHAIN_MAX_LENGTH || l.maxWidth !== CHAIN_MAX_WIDTH) {
          singleCost = `${intake}/${mount} -> ${l.maxLength}x${l.maxWidth}`;
        }
      }
    }
    check('chain size: one sweeper costs the chassis nothing (it fits the prism)', !singleCost, singleCost);
    // ...but DOUBLE-mounting the longest one still cannot fit. That is the prism talking, not
    // the start cube: a 15in chassis with a 5in triangle sweeper at BOTH ends is 25in deployed.
    check(
      'chain size: the longest intake still cannot be double-mounted (25in > the 24in prism)',
      !chainMountFits({ ...DEFAULT_SPEC, intake: 'triangle' }, 'frontback') &&
        !chainMountFits({ ...DEFAULT_SPEC, intake: 'triangle' }, 'side') &&
        chainMountFits({ ...DEFAULT_SPEC, intake: 'sloped' }, 'frontback') &&
        chainMountFits({ ...DEFAULT_SPEC, intake: 'vector' }, 'side'),
    );
    check(
      'chain size: coerceSpec refuses an impossible mount instead of building it',
      coerceSpec({ ...DEFAULT_SPEC, intake: 'triangle', intakeMount: 'frontback' }, undefined, 'chain').intakeMount === 'front',
    );
    // coerceSpec clamps to the shared envelope, both directions
    const big = coerceSpec({ ...DEFAULT_SPEC, length: 24, width: 24 }, undefined, 'chain');
    const small = coerceSpec({ ...DEFAULT_SPEC, length: 4, width: 4 }, undefined, 'chain');
    check(
      'chain size: coerceSpec clamps an oversized build down to 17',
      big.length === CHAIN_MAX_LENGTH && big.width === CHAIN_MAX_WIDTH,
      `${big.length}x${big.width}`,
    );
    check(
      'chain size: coerceSpec clamps an undersized build UP to 15',
      small.length === CHAIN_MIN_LENGTH && small.width === CHAIN_MIN_WIDTH,
      `${small.length}x${small.width}`,
    );
    /**
     * THE CEILING IS THE FIELD'S. G04 wants the robot completely inside its 24" Lab, whose
     * outer corner holds the solid 6" Ring-Stand assembly — so every chassis the builder
     * offers must have SOME legal start pose, or it is a robot you can build and never field.
     */
    let unstartable = '';
    for (let sz = CHAIN_MIN_LENGTH; sz <= CHAIN_MAX_LENGTH && !unstartable; sz += 0.5) {
      const spec = coerceSpec({ ...DEFAULT_SPEC, length: sz, width: sz }, undefined, 'chain');
      const anyHeading = [0, 90, 180, 270].some((d) => chainHeadingFits(spec, d));
      if (!anyHeading) unstartable = `${sz}x${sz}`;
    }
    check(
      'chain size: EVERY buildable chassis has a legal start pose',
      !unstartable,
      unstartable ? `${unstartable} cannot start anywhere` : `up to ${CHAIN_MAX_LENGTH}in`,
    );
    // ...and one inch past the ceiling genuinely cannot, which is what sets the ceiling
    const over = { ...coerceSpec({ ...DEFAULT_SPEC }, undefined, 'chain'), length: 18, width: 18 };
    check(
      'chain size: an 18in chassis could NOT start — which is why the cap is 17',
      ![0, 45, 90, 180, 270].some((d) => chainHeadingFits(over, d)),
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
        // as non-square as the CR envelope now allows (15x17). It used to be 12x18, but the
        // chassis floor is 15" — so the contrast is 17/15 rather than 18/12, and the check
        // below compares the RATIO to the chassis' own aspect instead of a fixed margin that
        // only ever worked for the old, wider spread.
        s.spec = { ...DEFAULT_SPEC, scoreMode: 'dumper', shooterMount: m, length: CHAIN_MIN_LENGTH, width: CHAIN_MAX_WIDTH, ballStorage: 12 };
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
      const front = spread('front'); // spans the WIDTH
      const left = spread('left'); // spans the LENGTH
      const want = CHAIN_MAX_WIDTH / CHAIN_MIN_LENGTH; // the chassis' own aspect ratio
      check(
        'chain shooter mounts: the launch line spans the mounted edge (flank = chassis length)',
        left > 4 && front > left && Math.abs(front / left - want) < 0.08,
        `front=${front.toFixed(1)} left=${left.toFixed(1)} ratio=${(front / left).toFixed(3)} want=${want.toFixed(3)}`,
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

    /**
     * WHAT THE CARDS PROMISE. Two properties are DERIVED in `CHAIN_PRESETS` rather than
     * written out, and both would fail silently: a preset whose mass drifts above its floor
     * is just "a bit heavy", and one whose hopper drifts below its cap is just "a bit small".
     * Neither looks like a bug in the UI, so they are asserted here.
     */
    {
      let heavy = '';
      let small = '';
      CHAIN_PRESETS.forEach((p, i) => {
        const c = coerceSpec({ ...p }, undefined, 'chain');
        // EVERY preset carries the most its build can hold
        if (c.ballStorage !== chainStorageMax(c)) small = `${p.name} ${c.ballStorage}/${chainStorageMax(c)}`;
        // the five REAL ROBOTS are as light as their build is allowed to be
        if (i < CHAIN_REAL_PRESETS) {
          const floor = massLimits(c.drivetrain, c.flywheelInertia, chainMassFloorBump(c)).min;
          if (Math.abs(c.massLb - floor) > 1e-9) heavy = `${p.name} ${c.massLb}lb vs floor ${floor}lb`;
        }
      });
      check('chain presets: every preset carries its MAXIMUM ball storage', !small, small);
      check('chain presets: the five real robots sit exactly at their mass floor', !heavy, heavy);
    }

    // the SWING is a mechanism with a position now, so the cards have to show that off too:
    // a centre pivot AND one bolted to a flank, which is the pairing the old mount-shaped
    // swing could not express at all
    check(
      'chain presets: a centre swing and a FLANK swing are both shown off',
      CHAIN_PRESETS.some((p) => catalystSwingOf(p) && catalystMountOf(p) === 'center') &&
        CHAIN_PRESETS.some((p) => catalystSwingOf(p) && (catalystMountOf(p) === 'right' || catalystMountOf(p) === 'left')),
      CHAIN_PRESETS.filter((p) => catalystSwingOf(p)).map((p) => `${p.name}:${catalystMountOf(p)}`).join(' ') || 'none',
    );
    check(
      'chain presets: every catalyst mechanism is represented',
      (['arm', 'launcher', 'turret', 'rail'] as const).every((t) =>
        CHAIN_PRESETS.some((p) => (p.catalystType ?? 'turret') === t)),
      CHAIN_PRESETS.map((p) => p.catalystType ?? 'turret').join(' '),
    );

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
    // BEAM YAW: the drag acts at the WHEELS on the ridge, so an off-centre load is a TORQUE.
    // A SQUARE crossing loads both sides evenly and cannot turn the robot (the reward for
    // lining it up); a CROOKED one loads one corner first and slews the chassis. Terrain used
    // to scale the across-speed and nothing else, so a robot came off a beam pointing exactly
    // where it went on.
    {
      const cross = (headingDeg: number): number => {
        const w = createChainWorld('free', 13, [chainSetup(0, 'blue')]);
        const r = w.robots[0];
        r.spec = { ...DEFAULT_SPEC, drivetrain: 'mecanum', width: 18, length: 18, groundClearance: 1 };
        r.heading = (headingDeg * Math.PI) / 180;
        r.pos = { x: 44, y: 6.4 };
        const h0 = r.heading;
        let peak = 0;
        for (let i = 0; i < 12; i++) {
          r.vel = { x: 0, y: 50 }; // held across the beam, so the only yaw source is the ridge
          beamDrag(w, SIM_DT);
          r.pos.y -= r.vel.y * SIM_DT;
          peak = Math.max(peak, Math.abs(r.heading - h0));
        }
        return (peak * 180) / Math.PI;
      };
      const square = cross(90);
      const crooked = cross(60);
      check('chain beams: a SQUARE crossing applies no yaw (both sides load evenly)', square < 0.01, `${square.toFixed(3)}deg`);
      check('chain beams: a CROOKED crossing slews the chassis (terrain torque)', crooked > 1, `${crooked.toFixed(2)}deg`);
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
      /**
       * ...A NUDGE AT A TIME. The clamp is capped at CHAIN_BEAM_CURB_SLOP per tick, because an
       * uncapped position write IS a teleport: mid-crossing it moved a robot 3.44in in one
       * tick against 0.45in of travel ("when driving over terrain, it sometimes teleports
       * me"). The pre-solve velocity wall is what actually stops the wheel; this only takes
       * out the slop, so it is asked here over a few ticks rather than in one.
       */
      let biggest = 0;
      for (let i = 0; i < 5; i++) {
        const y0 = r.pos.y;
        beamStrafeBlock(w);
        biggest = Math.max(biggest, Math.abs(r.pos.y - y0));
      }
      const leadY = Math.max(...wheelContacts(r).map((c) => c.y)); // leading wheel after the block
      check(
        'chain beams: a strafing mecanum is curb-blocked (leading wheel back to the near face, vel killed)',
        upBefore >= 1 && leadY <= -0.5 + 1e-6 && r.vel.y === 0 && r.pos.y < -6.0,
        `up=${upBefore} leadY=${leadY.toFixed(2)} vy=${r.vel.y.toFixed(1)} y=${r.pos.y.toFixed(2)}`,
      );
      check(
        '...and it never moves the robot more than slop in one tick — a clamp, not a teleport',
        biggest <= CHAIN_BEAM_CURB_SLOP + 1e-9,
        `worst single-tick correction ${biggest.toFixed(2)}in vs the ${CHAIN_BEAM_CURB_SLOP}in cap`,
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
                // read the axis off the COERCED build, not the requested mount: a centre cell
                // without a swing is relocated, and a SWING spends the fore-aft axis wherever
                // its pivot sits (it extends past an END, not past its own flank)
                const cmEff = catalystSwingOf(s) ? 'front' : catalystMountOf(s);
                const axis = cmEff === 'front' || cmEff === 'back' ? s.length : s.width;
                const ends =
                  cmEff === 'front' || cmEff === 'back'
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
                if (reach > cap + 1e-9) illegal = `${intake}/${im}/${cm}->${cmEff} reach ${reach} > ${cap}`;
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
      // The WORST case is now a chassis whose DEPLOYED sweepers already fill the prism (a 17"
      // frame with a 3.5" vector sweeper at both ends is exactly 24"), leaving the arm no
      // extension at all — just the ring it holds. That is a real trade-off rather than a
      // bug: that robot spent its whole expansion allowance on collecting. It used to be
      // pinned to `CHAIN_EXPANSION` (24 − 18), which assumed the worst build was a maxed
      // chassis with NO sweeper cost — true only while the chassis could reach 18".
      check(
        'catalyst: the worst-case arm is the ring alone (its prism is already spent), never negative',
        minArm >= CHAIN_CATALYST_OD / 2 - 1e-9 && Math.abs(minArm - CHAIN_CATALYST_OD / 2) < 1e-9,
        `${minArm} vs ring radius ${CHAIN_CATALYST_OD / 2}`,
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
    // 12 s, not 4: the cycles are close enough now (0.41 / 0.68 / 0.75) that a short window
    // rounds two of them to the same action count and the check stops measuring anything.
    const nTurret = actionsIn('turret', 12);
    const nArm = actionsIn('arm', 12);
    const nLauncher = actionsIn('launcher', 12);
    check(
      'catalyst: cycle rate turret > arm > catapult (reach and range cost tempo)',
      nTurret > nArm && nArm > nLauncher,
      `turret ${nTurret} arm ${nArm} launcher ${nLauncher} actions / 12s`,
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

  // ---- RAIL-TURRET CLAW tracks what it would ACTUALLY act on ------------------------
  // Two rewrites' worth of history here, both from the same mistake — the tracker not
  // matching `catalystAction`. It first tracked hooks only, so a claw stared across the
  // field while a ring sat at its feet. It then tracked the nearest of EVERYTHING at any
  // distance, which is what made a rail carriage look broken in a match: it offered empty
  // hooks to an empty claw, ignored seated rings, and pinned itself to an end stop chasing
  // a hook thirty inches away. The target is now the job it is about to do.
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

    // NOTHING nearby -> nothing tracked. A hook across the field is not work, and treating
    // it as work is what parked the carriage against an end stop for the whole match.
    check(
      'catalyst track: a far-away hook is not a target for an idle claw',
      catalystTrackTarget(rob, w) === null,
      JSON.stringify(catalystTrackTarget(rob, w)),
    );

    // a ring at its feet is
    const ring = w.chain!.catalysts[0];
    ring.pos = { x: 12, y: 3 };
    check(
      'catalyst track: a LOOSE ring within working range is the target',
      near(catalystTrackTarget(rob, w), ring.pos),
      JSON.stringify(catalystTrackTarget(rob, w)),
    );

    // ...but a CARRIED ring is not: it is already in the claw (distance ~0), so tracking it
    // would lock the mechanism pointing at itself
    ring.carriedBy = rob.id;
    check(
      'catalyst track: a CARRIED ring is never the target',
      !near(catalystTrackTarget(rob, w), ring.pos),
      JSON.stringify(catalystTrackTarget(rob, w)),
    );

    // a ring SEATED on a hook is a legal grab (de-score), so an empty claw within range
    // tracks it — at the HOOK, which is where the claw has to reach
    ring.carriedBy = null;
    const seat = hookPos('blue', 0);
    ring.hook = { alliance: 'blue', index: 0 };
    rob.pos = { x: seat.x - 6, y: seat.y - 8 };
    check(
      'catalyst track: a SEATED ring in range is tracked at its hook',
      near(catalystTrackTarget(rob, w), seat),
      JSON.stringify(catalystTrackTarget(rob, w)),
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

// ---- name moderation: fail-open / disabled invariants (network-free) -----------
// The hosted moderation service is env-gated (MODERATION_API_KEY). These checks pin
// the invariants that hold with NO key configured — the default in CI / local dev —
// so the moderation layer is provably a zero-cost no-op unless explicitly enabled,
// and empty/blank names never hit the network. (A live block/allow decision needs a
// configured provider and is verified out-of-band, not in the deterministic smoke.)
{
  check('moderationEnabled is a boolean', typeof moderationEnabled === 'boolean');
  // empty / whitespace names short-circuit to allowed WITHOUT calling the provider
  const empty = await moderateName('   ');
  check('moderateName("   ") allows without a network check', empty.allowed === true && empty.checked === false);
  // scrubName never rejects a blank, and returns the fallback only for null/undefined
  check('scrubName keeps an empty string as-is', (await scrubName('', 'Fallback')) === '');
  check('scrubName(null) returns the fallback', (await scrubName(null, 'Fallback')) === 'Fallback');
  if (!moderationEnabled) {
    // with no provider configured, EVERY name is allowed and passed through untouched
    const off = await moderateName('literally anything at all');
    check('disabled: moderateName allows any name (checked=false)', off.allowed === true && off.checked === false);
    check('disabled: scrubName passes a name through unchanged', (await scrubName('My Robot', 'x')) === 'My Robot');
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);