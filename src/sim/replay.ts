import type { Alliance, GameId, GameMode, RobotCommand, RobotSpec, World, AutoPathData, StartPose } from '../types';
import * as C from '../config';
import { DEFAULT_ASSISTS, type RobotSetup } from './spawn';
import { simModuleFor } from '../games/sim';
import {
  dequantizeCommand,
  localizeCommand,
  quantizeCommand,
  type QCommand,
} from '../net/protocol';
import { worldHash } from '../net/checksum';

/**
 * Deterministic REPLAYS + record-chasing (score-attack) scaffolding — Phase 3
 * foundation (docs/netcodeplan.md). A replay is NOT video/snapshots: it is the
 * seed + robot setups + a hold-last-compressed per-tick command log. Because the
 * sim is a pure, command-driven state machine, re-running `step()` over that log
 * reproduces the match byte-for-byte — which makes replays (a) tiny (~10–30 KB),
 * (b) a continuous determinism check, and (c) the server's anti-cheat verifier
 * (re-simulate a submitted replay, trust only the score IT computes).
 *
 * Determinism rule (from net/protocol.ts): the sim must step on the value the
 * wire round-trips (`localizeCommand`), so a captured command re-simulates to
 * the same result. `runRecordMatch`/`ReplayRecorder` localize + quantize on the
 * same lattice, so record → simulate is exact. A record run is fully SIM-DRIVEN
 * (preCountdown → auto → transition → teleop → post), so no controller state
 * leaks in — {seed, setups, commands} alone reproduce it.
 */

const ZERO_CMD: RobotCommand = { driveX: 0, driveY: 0, rotate: 0, leftDrive: 0, rightDrive: 0, intake: false, fire: false };
const ZERO_Q: QCommand = { dx: 0, dy: 0, rot: 0, buttons: 0 };

/**
 * Bump on a change to the replay container schema.
 *
 * 2: command entries carry the TANK AXES (`ld`/`rd`). Format 1 stored only
 *    `[tick, dx, dy, rot, buttons]`, and tank drive is commanded EXCLUSIVELY through
 *    leftDrive/rightDrive (see robot.ts `saturation === 'tank'`) — so a tank or butterfly
 *    robot's entire drive input was thrown away and its replay played back with a dead
 *    drivetrain. The READER still understands format 1, so old replays keep playing.
 */
export const REPLAY_FORMAT = 2;

/** numbers per command entry, by container format. 1: [tick,dx,dy,rot,buttons] ·
 *  2: + [ld,rd] */
export const trackStride = (format: number): number => (format >= 2 ? 7 : 5);

/**
 * One robot's command timeline, HOLD-LAST compressed: a flat number array of
 * 5-tuples `[tick, dx, dy, rot, buttons]`, one entry only when the quantized
 * command CHANGES. The command in effect at any tick is the newest entry with
 * `entry.tick <= tick` (ZERO before the first). Flat numbers (not objects) keep
 * it compact and JSON-trivial.
 */
export type CommandTrack = number[];

export interface Replay {
  format: number; // REPLAY_FORMAT
  /** C.BALANCE_VERSION when recorded — a replay only re-sims exactly under its
   * own balance version's sim build (see config.ts BALANCE_VERSION) */
  balanceVersion: number;
  /**
   * C.SIM_VERSION when recorded — which sim BEHAVIOUR this log was captured
   * against. Separate from `balanceVersion` on purpose: a determinism fix moves
   * what `step()` produces without being a balance decision, and without this the
   * only options are resetting the competitive season over a bug fix or letting
   * stored replays re-simulate into a different game than the one that was
   * played. ABSENT ⇒ 0 (recorded before this existed), correctly read as "cannot
   * be replayed accurately on this build".
   */
  sim?: number;
  /** which game this replay is of — picks the sim module to re-simulate it (createWorld
   * + step). Absent on old replays ⇒ DECODE. */
  game?: GameId;
  mode: GameMode;
  seed: number;
  setups: RobotSetup[];
  /** total ticks recorded (== the final world.tick) */
  ticks: number;
  /** per-robot-id command track (absent id ⇒ ZERO the whole match) */
  tracks: Record<number, CommandTrack>;
}

function packKey(q: QCommand): number {
  // dx/dy/rot/ld/rd ∈ [-127,127] (8 bits signed), buttons ∈ [0,3]; pack for cheap
  // change-detection (not stored — just an equality key).
  //
  // MULTIPLICATION, not bit shifts: six bytes is 48 bits and JS bitwise operators truncate
  // to 32, which would silently fold ld/rd out of the key. That is not a hypothetical — the
  // key omitted them entirely before, so a TANK robot (whose only drive input IS ld/rd) had
  // every change after its first look identical, and the recorder skipped all of them.
  const b = (n: number): number => n & 0xff;
  return ((((b(q.dx) * 256 + b(q.dy)) * 256 + b(q.rot)) * 256 + (q.buttons & 0xff)) * 256 +
    b(q.ld ?? 0)) * 256 + b(q.rd ?? 0);
}

/**
 * Captures a replay while a match is stepped. Feed it the SAME command map you
 * pass to `step()` each tick (already localized — see the determinism rule); it
 * records only the quantized changes per robot.
 */
export class ReplayRecorder {
  private readonly tracks = new Map<number, CommandTrack>();
  private readonly last = new Map<number, number>(); // robotId -> last recorded packKey
  private ticks = 0;

  constructor(
    readonly seed: number,
    readonly setups: RobotSetup[],
    readonly mode: GameMode = 'match',
    readonly game: GameId = 'decode',
  ) {}

  /** record the command map applied at `tick` (1-based, == world.tick after the
   * step it drove). Only stores an entry when a robot's quantized command differs
   * from its last stored one (hold-last). */
  record(tick: number, commands: Map<number, RobotCommand>): void {
    this.ticks = tick;
    for (const s of this.setups) {
      const cmd = commands.get(s.id);
      const q = cmd ? quantizeCommand(cmd) : ZERO_Q;
      const key = packKey(q);
      if (this.last.get(s.id) === key) continue;
      this.last.set(s.id, key);
      let track = this.tracks.get(s.id);
      if (!track) {
        track = [];
        this.tracks.set(s.id, track);
      }
      track.push(tick, q.dx, q.dy, q.rot, q.buttons, q.ld ?? 0, q.rd ?? 0);
    }
  }

  finish(): Replay {
    const tracks: Record<number, CommandTrack> = {};
    for (const [id, t] of this.tracks) tracks[id] = t;
    return {
      format: REPLAY_FORMAT,
      balanceVersion: C.BALANCE_VERSION,
      sim: C.SIM_VERSION,
      game: this.game,
      mode: this.mode,
      seed: this.seed,
      setups: this.setups.map((s) => ({
        ...s,
        spec: { ...s.spec },
        assists: { ...s.assists },
        autoPath: s.autoPath, // Include autoPath
        autoPathEnabled: s.autoPathEnabled, // Include autoPathEnabled
      })),
      ticks: this.ticks,
      tracks,
    };
  }
}

/**
 * Can THIS build re-simulate that container at all?
 *
 * Two different questions, kept apart on purpose:
 *  • can we PARSE it — any format up to ours, since the reader still understands the older
 *    strides. A newer one from a future build we cannot read.
 *  • can we REPRODUCE it — the balance + sim versions have to match, or `step()` produces a
 *    different game than the one that was played.
 *
 * Plus one honest refusal: a FORMAT-1 replay of a tank-steered robot never had its drive
 * input recorded at all (the container had nowhere to put `ld`/`rd`). It parses and it
 * re-simulates, but it re-simulates a robot that sits still — so it is refused as stale
 * rather than played back looking broken, which is indistinguishable from a bug in the sim.
 */
export function replayPlayable(
  r: Pick<Replay, 'format' | 'balanceVersion' | 'sim' | 'setups'>,
  balanceVersion: number,
  simVersion: number,
): boolean {
  return replayReadable(r) && replayExact(r, balanceVersion, simVersion);
}

/**
 * CAN THIS BUILD STEP THE CONTAINER AT ALL? — the question that decides whether a replay is
 * WATCHABLE, and the one that must keep answering yes across a patch.
 *
 * A replay is an input log, so a sim change means it re-simulates into a different game than
 * the one that was played. That is unavoidable and it is what `replayExact` reports. What does
 * NOT follow is that the log should be thrown away: it still describes real inputs, from a real
 * match, and playing it back with a warning is far better than a stored archive that every
 * patch silently empties. Records are unaffected either way — the server stores the score it
 * computed at the time and never re-derives it from the replay.
 *
 * Only two things make a container genuinely unplayable:
 *  • a FORMAT from the future, which we cannot parse;
 *  • a FORMAT-1 replay of a tank-steered robot, whose drive input was never stored at all (the
 *    container had nowhere to put `ld`/`rd`). It parses and it steps, but it steps a robot that
 *    sits still — indistinguishable, to the person watching, from the sim being broken.
 */
export function replayReadable(r: Pick<Replay, 'format' | 'setups'>): boolean {
  if (r.format > REPLAY_FORMAT) return false;
  if (r.format < 2 && r.setups.some((s) => tankSteered(s.spec.drivetrain))) return false;
  return true;
}

/**
 * WILL IT REPRODUCE THE MATCH THAT WAS PLAYED? — the accuracy question, kept separate so the
 * viewer can play a replay it cannot promise is exact and say so, instead of refusing it.
 *
 * `sim` ABSENT means the recording build never stamped one, so the behaviour it ran is
 * genuinely unknown — that is a "cannot promise", not a match against 0.
 */
export function replayExact(
  r: Pick<Replay, 'balanceVersion' | 'sim'>,
  balanceVersion: number,
  simVersion: number,
): boolean {
  return r.balanceVersion === balanceVersion && r.sim === simVersion;
}

/** drivetrains commanded through the TANK AXES — the ones a format-1 replay lost. Butterfly
 *  counts: half its life is tank mode, and that half was recorded as zeros. */
const tankSteered = (dt: RobotSpec['drivetrain']): boolean => dt === 'tank' || dt === 'butterfly';

/**
 * Plays a replay forward one tick at a time, rebuilding the exact world and
 * feeding the recorded (hold-last) commands. `world` is live for rendering; the
 * UI replay viewer drives this at 60 Hz, the verifier runs it to completion.
 */
export class ReplayPlayer {
  readonly world: World;
  private readonly cursor: Record<number, number> = {}; // robotId -> next entry index
  private readonly current = new Map<number, RobotCommand>();
  private readonly mod; // CR vs DECODE re-sim module (createWorld/step)

  constructor(private readonly replay: Replay) {
    this.mod = simModuleFor(replay.game);
    this.world = this.mod.createWorld(replay.mode, replay.seed, replay.setups);
    if (replay.mode === 'match') this.world.match.preCountdown = C.PRE_COUNTDOWN;
    for (const s of this.replay.setups) this.current.set(s.id, { ...ZERO_CMD });
  }

  get done(): boolean {
    return this.world.tick >= this.replay.ticks;
  }

  /** advance exactly one tick; false once fully played */
  stepOnce(): boolean {
    if (this.done) return false;
    const tick = this.world.tick + 1;
    for (const s of this.replay.setups) {
      const track = this.replay.tracks[s.id];
      if (!track) continue;
      let ei = this.cursor[s.id] ?? 0;
      // the stride is the CONTAINER's, not this build's — a format-1 replay has no tank
      // axes stored and reads them as zero, which is exactly what it recorded
      const stride = trackStride(this.replay.format);
      const entries = Math.floor(track.length / stride);
      // apply every entry that has come due (normally 0 or 1 per tick)
      while (ei < entries && track[ei * stride] <= tick) {
        const q: QCommand = {
          dx: track[ei * stride + 1],
          dy: track[ei * stride + 2],
          rot: track[ei * stride + 3],
          buttons: track[ei * stride + 4],
          ld: stride >= 7 ? track[ei * stride + 5] : 0,
          rd: stride >= 7 ? track[ei * stride + 6] : 0,
        };
        this.current.set(s.id, dequantizeCommand(q));
        ei++;
      }
      this.cursor[s.id] = ei;
    }
    this.mod.step(this.world, C.SIM_DT, this.current);
    return true;
  }
}

/**
 * WHOSE VIEW a replay is watched from: the robot to highlight as "yours", and the
 * alliance whose driver station the camera sits behind.
 *
 * This is not cosmetic polish. The camera rotates a full 180° between alliances
 * (`viewAngleOf`: red +π/2, blue −π/2), so watching your own match from the other
 * side shows every robot on the wrong end of the field driving the wrong way —
 * indistinguishable, to the person who played it, from the replay having
 * diverged. The viewer defaulted to `setups[0]`, and a matchmaker-staged roster
 * always puts red at index 0, so it was right for exactly half the players in
 * every 1v1 and wrong for the other half — including which robot got labelled as
 * theirs. Two people watching the same replay saw mirror images of each other.
 *
 * `viewerRobotId` is the robot the watcher actually drove. Absent (a leaderboard
 * replay by someone who wasn't in the match, an old link) falls back to the first
 * setup, which is correct for the opponent-free record runs that make up the
 * boards — those have one alliance on the field.
 */
export function replayViewpoint(
  setups: RobotSetup[],
  viewerRobotId?: number | null,
): { robotId: number; alliance: Alliance } {
  const me =
    (viewerRobotId != null ? setups.find((s) => s.id === viewerRobotId) : undefined) ?? setups[0];
  return { robotId: me?.id ?? 0, alliance: me?.alliance ?? 'blue' };
}

/** re-simulate a replay to completion and return the final world (playback +
 * verification share this). Deterministic: identical to the recorded run on the
 * same balance version. */
export function simulateReplay(replay: Replay): World {
  const p = new ReplayPlayer(replay);
  while (p.stepOnce());
  return p.world;
}

export interface ReplayResult {
  /** each alliance's final total (the record score is the run alliance's) */
  score: Record<Alliance, number>;
  /** each alliance's penalty POINTS (points it was AWARDED from the opponent's
   * fouls). In an opponent-free record run these belong to the empty opposing
   * alliance and represent the fouls the PLAYER committed — subtracted from the
   * player's score by `recordScore()`. */
  foulPoints: Record<Alliance, number>;
  hash: number;
  ticks: number;
}

/** the net leaderboard score for an opponent-free record run by `alliance`: the
 * alliance's earned total MINUS the penalty points it handed the (empty) opponent
 * — i.e. its own committed fouls. Clamped at 0 (a run can't score negative). */
export function recordScore(result: ReplayResult, alliance: Alliance): number {
  const opp: Alliance = alliance === 'blue' ? 'red' : 'blue';
  return Math.max(0, result.score[alliance] - result.foulPoints[opp]);
}

/** the server's anti-cheat entry point: re-simulate a submitted replay and
 * return the authoritative score it produces — never trust a client-posted one */
export function verifyReplay(replay: Replay): ReplayResult {
  return worldResult(simulateReplay(replay));
}

/** the record/score of a finished world — read directly, no re-simulation (the
 * server already holds the authoritative world at phase 'post') */
export function worldResult(world: World): ReplayResult {
  return {
    score: { red: world.match.scores.red.total, blue: world.match.scores.blue.total },
    foulPoints: { red: world.match.scores.red.foulPoints, blue: world.match.scores.blue.foulPoints },
    hash: worldHash(world),
    ticks: world.tick,
  };
}

// ---- record-chasing (score-attack) setups -----------------------------------

/** solo = 1 robot alone (1v0); duo = 2 co-op robots, same alliance, one field
 * (2v0). Both are OPPONENT-FREE — the record is the alliance's total score. */
export type RecordMode = 'solo' | 'duo';

/**
 * Build the RobotSetup[] for a record-chasing run. Score-attack has no opponent,
 * so a single (blue) alliance holds the run robot(s); alliance is viewpoint-only.
 * A DUO has TWO drivers, each with their OWN build — pass `partnerSpec` for slot 1
 * (it falls back to `spec` only when a second build isn't supplied). Distinct start
 * poses keep the two robots from spawning on top of each other. (In production the
 * server builds a duo's setups from each client's spec; this helper is for
 * headless runs + tests.)
 */
export function recordSetups(
  spec: RobotSpec,
  mode: RecordMode,
  assists = DEFAULT_ASSISTS,
  autoPath?: AutoPathData, // Add autoPath parameter
  autoPathEnabled?: boolean, // Add autoPathEnabled parameter
  startPose?: StartPose, // custom start pose (applied to slot 0 only)
  partnerSpec?: RobotSpec, // duo slot 1's own build (defaults to `spec`)
): RobotSetup[] {
  const alliance: Alliance = 'blue';
  const slot = (id: number, startIndex: number, robotSpec: RobotSpec, pose?: StartPose): RobotSetup => ({
    id,
    alliance,
    spec: { ...robotSpec },
    assists: { ...assists },
    startIndex,
    startPose: pose,
    autoPath: autoPath, // Pass autoPath
    autoPathEnabled: autoPathEnabled, // Pass autoPathEnabled
  });
  // slot 1 stays on a preset so a duo can't spawn both robots on one custom spot
  return mode === 'solo'
    ? [slot(0, 0, spec, startPose)]
    : [slot(0, 0, spec, startPose), slot(1, 1, partnerSpec ?? spec)];
}

/** the alliance a record run scores for (the run robots' alliance) */
export function recordAlliance(setups: RobotSetup[]): Alliance {
  return setups[0]?.alliance ?? 'blue';
}

// ---- headless record runner (verifier / tooling / tests) --------------------

/** per-tick command provider: returns the RAW intended command map for `tick`
 * (localization is applied by the runner). Absent robot ⇒ ZERO that tick. */
export type CommandSource = (tick: number, world: World) => Map<number, RobotCommand>;

export interface RecordRun {
  world: World; // final world (phase 'post' unless stopped early)
  replay: Replay;
  result: ReplayResult;
}

/** upper bound on a full match's ticks (+ slack), so a runaway can't spin forever */
export function maxMatchTicks(): number {
  const secs =
    C.PRE_COUNTDOWN + C.AUTO_DURATION + C.TRANSITION_DURATION + C.TELEOP_DURATION + C.MATCH_SETTLE_S + 2;
  return Math.ceil(secs / C.SIM_DT);
}

/**
 * Run a full, deterministic, SIM-DRIVEN record-chasing match headlessly and
 * capture its replay. Commands from `src` are localized (quantize round-trip)
 * before BOTH stepping and recording, so `simulateReplay(run.replay)` reproduces
 * `run.world` exactly. Stops at phase 'post' (or `opts.stopTick` for a short run).
 */
export function runRecordMatch(
  seed: number,
  setups: RobotSetup[],
  src: CommandSource,
  opts: { mode?: GameMode; stopTick?: number; game?: GameId } = {},
): RecordRun {
  const mode = opts.mode ?? 'match';
  const game = opts.game ?? 'decode';
  const mod = simModuleFor(game);
  const world = mod.createWorld(mode, seed, setups);
  if (mode === 'match') world.match.preCountdown = C.PRE_COUNTDOWN;
  const rec = new ReplayRecorder(seed, setups, mode, game);
  const cap = opts.stopTick ?? maxMatchTicks();
  while (world.match.phase !== 'post' && world.tick < cap) {
    const tick = world.tick + 1;
    const raw = src(tick, world);
    const local = new Map<number, RobotCommand>();
    for (const s of setups) {
      const c = raw.get(s.id);
      local.set(s.id, c ? localizeCommand(c) : { ...ZERO_CMD });
    }
    mod.step(world, C.SIM_DT, local);
    rec.record(tick, local);
  }
  return { world, replay: rec.finish(), result: worldResult(world) };
}