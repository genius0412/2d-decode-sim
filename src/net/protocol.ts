import type {
  Alliance,
  Artifact,
  AssistConfig,
  GameId,
  RobotCommand,
  RobotSpec,
  RobotState,
  World,
  AutoPathData, // Import AutoPathData
  StartPose,
  StartCat,
} from '../types';
import type { RobotSetup } from '../sim/spawn';
import type { Replay, ReplayResult } from '../sim/replay';
import { clamp } from '../math';
import { flywheelSpinTarget } from '../sim/field';

/**
 * Wire protocol for the SERVER-AUTHORITATIVE netcode (Phase 0). All messages are
 * JSON over a single WebSocket per client — binary/delta encoding is a Phase 1
 * optimization. Two directions:
 *   - ClientMsg (browser → server): lobby ops + per-tick `input`.
 *   - ServerMsg (server → browser): roster, `matchStart`, `snapshot`, `drop`.
 *
 * Determinism note (narrower than the old lockstep rule): the server is the sole
 * authority, so cross-machine float determinism is NOT required. What IS required
 * is that the value the client PREDICTS with matches the value the server steps:
 * the client quantizes its command (`quantizeCommand`) before sending AND predicts
 * on the round-tripped value (`localizeCommand`); the server dequantizes the same
 * bytes. Never predict on a raw command while sending a quantized one.
 */

/** a RobotCommand packed into 3 signed axes + a button bitfield (4 bytes) */
export interface QCommand {
  dx: number; // int8, -127..127  (driveX * 127)
  dy: number; // int8
  rot: number; // int8
  buttons: number; // uint8 bitfield: bit0 intake, bit1 fire, bit2 catalyst
  // TANK drive steers via leftDrive/rightDrive (NOT dx/dy) — these MUST be on the
  // wire or a networked tank robot gets zero drive and sits frozen at spawn. Optional
  // so a packet from an older client still decodes (missing ⇒ 0, the old behavior).
  ld?: number; // int8 (leftDrive * 127)
  rd?: number; // int8 (rightDrive * 127)
}

const BTN_INTAKE = 1;
const BTN_FIRE = 2;
const BTN_CATALYST = 4;

export function quantizeCommand(c: RobotCommand): QCommand {
  return {
    dx: Math.round(clamp(c.driveX, -1, 1) * 127),
    dy: Math.round(clamp(c.driveY, -1, 1) * 127),
    rot: Math.round(clamp(c.rotate, -1, 1) * 127),
    buttons: (c.intake ? BTN_INTAKE : 0) | (c.fire ? BTN_FIRE : 0) | (c.catalyst ? BTN_CATALYST : 0),
    ld: Math.round(clamp(c.leftDrive ?? 0, -1, 1) * 127),
    rd: Math.round(clamp(c.rightDrive ?? 0, -1, 1) * 127),
  };
}

export function dequantizeCommand(q: QCommand): RobotCommand {
  return {
    driveX: q.dx / 127,
    driveY: q.dy / 127,
    rotate: q.rot / 127,
    leftDrive: (q.ld ?? 0) / 127, // ?? 0: tolerate an older client's ld/rd-less packet
    rightDrive: (q.rd ?? 0) / 127,
    intake: (q.buttons & BTN_INTAKE) !== 0,
    fire: (q.buttons & BTN_FIRE) !== 0,
    catalyst: (q.buttons & BTN_CATALYST) !== 0,
  };
}

/** the exact command the client must PREDICT with (quantize round-trip), so its
 * local sim matches what the server computes from the same wire bytes */
export function localizeCommand(c: RobotCommand): RobotCommand {
  return dequantizeCommand(quantizeCommand(c));
}

// ---- lobby model ------------------------------------------------------------

/** max drivers per room (2v2) */
export const ROOM_CAPACITY = 4;

/** what a room runs. 'versus' = the existing PvP match (ELO). 'record' =
 * opponent-free score-attack for the record boards; solo = 1 robot (1v0), duo =
 * 2 co-op robots on one alliance (2v0). A duo may mix drivetrains — a mixed pair
 * ranks the OVERALL board only, a matched pair also ranks that drivetrain's. */
export type RoomKind = 'versus' | 'record';
export type RecordKind = 'solo' | 'duo';
/** ranked matchmaking bucket */
export type QueueMode = '1v1' | '2v2';
export const QUEUE_NEED: Record<QueueMode, number> = { '1v1': 2, '2v2': 4 };

export interface RoomConfig {
  kind: RoomKind;
  /** set when kind === 'record' */
  record?: RecordKind;
  /** which game the room plays. Absent ⇒ 'decode' (old clients / back-compat).
   * The server resolves the game module from this; matchmaking buckets by it. */
  game?: GameId;
}

export const DEFAULT_ROOM_CONFIG: RoomConfig = { kind: 'versus' };

/** roster cap for a room kind (record rooms are opponent-free + small) */
export function roomCapacity(config: RoomConfig): number {
  if (config.kind === 'record') return config.record === 'duo' ? 2 : 1;
  return ROOM_CAPACITY;
}

/** a driver in a room (server-authoritative — no presence/mesh bookkeeping) */
export interface LobbyPlayer {
  clientId: string;
  name: string;
  teamName: string;
  teamNumber: number;
  alliance: Alliance;
  /** index into START_POSES (mirrored per alliance) — the quick-pick fallback */
  startIndex: number;
  /** a fully-placed CUSTOM start pose (canonical goalSide=+1 frame). Overrides
   * startIndex when present; the server + createWorld snap it G304-legal. */
  startPose?: StartPose | null;
  /** 2v2 start ROLE (which start category this robot may pick). Absent ⇒ derived
   * from alliance join order. Set explicitly only after a consented role swap. */
  startRole?: StartCat;
  /** true while this player has an outstanding / accepted role-swap request. When
   * BOTH alliance members set it, each flips its own role and clears the flag. */
  swapReq?: boolean;
  ready: boolean;
  spec: RobotSpec;
  assists: AssistConfig;
  autoPath?: AutoPathData; // Add autoPath
  autoPathEnabled?: boolean; // Add autoPathEnabled
  // ---- server-authored, set only during the ranked pre-match STRATEGY phase ----
  // (never accepted from a client patch). `slot` is this player's roster/robot
  // index so its card can look up its `PlayerIntro` ELO; `hidden` marks an OPPONENT
  // card the server has redacted (name/team/ELO only — its `spec`/`assists` are
  // neutralized placeholders so an opponent can't be counter-picked pre-match).
  slot?: number;
  hidden?: boolean;
}

/** a driver's pre-match ranked intro data (ELO, keyed by the robot id the server
 * assigns at matchStart). Sent only for ranked rooms; drives the intro overlay.
 * Name / team / drivetrain come from the matching `RobotSetup`, so only the
 * per-driver ELO travels here. */
export interface PlayerIntro {
  /** the robot id assigned in `matchStart.setups` */
  id: number;
  /** current overall ranked ELO, or null if the driver is signed out / unrated */
  elo: number | null;
}

/** one driver's overall-ELO change, sent after a ranked match is scored so the
 * results screen can show before → after (+delta). Keyed by robot id. */
export interface EloDelta {
  robotId: number;
  before: number;
  after: number;
  /** new Glicko rating deviation (kept for reference; no longer drives the "?") */
  rd: number;
  /** overall-board games AFTER this match — < PLACEMENT_GAMES ⇒ still in
   * placements, shown with a "?" on the results screen */
  games: number;
}

/** fields a client may change about itself while in the room */
export type PlayerPatch = Partial<
  Pick<
    LobbyPlayer,
    'name' | 'teamName' | 'teamNumber' | 'alliance' | 'startIndex' | 'startPose' | 'startRole' | 'swapReq' | 'ready' | 'spec' | 'assists' | 'autoPath' | 'autoPathEnabled'
  >
>;

// ---- client → server --------------------------------------------------------

/** capabilities THIS client build understands, sent on `join`/`queue` so ONE server
 * can serve mixed client versions (alpha/beta/main all point at it). A staged ranked
 * room opens the pre-match strategy window only when EVERY member advertises
 * 'strategy'; otherwise it starts immediately (the pre-strategy behavior), so an old
 * client is never stranded waiting for a `strategyStart` it can't render. Absent/old
 * clients send nothing ⇒ treated as no caps. Add new capability strings here as the
 * protocol grows. */
export const CLIENT_CAPS: string[] = ['strategy', 'startpose', 'game'];

export type ClientMsg =
  // `authToken` is the Neon Auth JWT; the server verifies it to attribute the
  // run to a real user (absent/invalid ⇒ anonymous). See server/auth.ts.
  // `caps` (optional) advertises this client build's protocol capabilities.
  | {
      t: 'join';
      room: string;
      player: Omit<LobbyPlayer, 'clientId'>;
      config?: RoomConfig;
      authToken?: string;
      caps?: string[];
      /** this client build's release channel ('alpha' | 'stable' | …). Absent ⇒
       * 'stable'. Alpha rooms are segregated + never persisted (see server). */
      channel?: string;
    }
  // reclaim an in-match slot after a transient socket drop (within the grace
  // window) — the server rebinds the robot to the new connection and resyncs
  | { t: 'rejoin'; room: string; clientId: string }
  // SPECTATE a live match: join a room read-only. The server adds a spectator (no
  // robot slot, never counted toward capacity/roster/persistence), sends the current
  // `matchStart`, and streams the same `snapshot`s the drivers get. Input is ignored.
  | { t: 'spectate'; room: string; caps?: string[] }
  | { t: 'update'; patch: PlayerPatch }
  | { t: 'start' } // host only: build + broadcast the match world
  | { t: 'restart' } // host only: re-author the match with a fresh seed
  // `ack` (optional) is the newest authoritative snapshot `serverTick` this client
  // has APPLIED as its ball baseline — a client→server snapshot ACK piggybacked on
  // the per-tick input (drivers send input every tick, so it costs nothing). The
  // server uses it to know which baseline the client actually holds. Over the
  // reliable WebSocket the happy-path delta is still against the last broadcast;
  // the ack only drives a self-healing keyframe when a client's CONFIRMED baseline
  // falls too far behind (a wedged/way-behind client resyncs instead of drifting).
  // It is ALSO the seam the future unreliable (QUIC-datagram) lane needs: there a
  // dropped snapshot means last-sent != last-received, so the delta must be keyed
  // to this ack. Absent from older clients ⇒ the server simply never force-resyncs
  // them (unchanged behaviour).
  | { t: 'input'; tick: number; q: QCommand; ack?: number }
  // ranked matchmaking: enter/leave a queue. Sent over a `?mm=1` connection that
  // fly-replay pins to the designated matchmaker machine. `homeRegion` is the region
  // Fly routed this client to (from the /health x-region header) and `accessMs` is
  // its measured RTT there; the matchmaker estimates cross-region latency from these
  // to pick a fair host. `noWiden` ⇒ never widen past my own region (stay local
  // forever). On a match the server sends `matchAssigned` (not `matchStart`): the
  // client reconnects to the assigned host region, where the real match is built.
  | {
      t: 'queue';
      mode: QueueMode;
      player: Omit<LobbyPlayer, 'clientId'>;
      authToken?: string;
      homeRegion: string;
      accessMs: number;
      noWiden?: boolean;
      caps?: string[];
      /** which game to queue for. Absent ⇒ 'decode'. The matchmaker buckets by it
       * so a Chain-Reaction queuer never pairs into a DECODE authoritative room. */
      game?: GameId;
      /** release channel (see `join.channel`): alpha queues only pair with alpha */
      channel?: string;
      /** this client's build id (git sha). The matchmaker segregates the queue by
       * build so two DIFFERENT builds never share an authoritative match — the exact
       * "same code" invariant (channel is only a coarse, manual proxy). Absent ⇒ the
       * server falls back to channel-only separation. */
      build?: string;
    }
  // widen my search radius NOW (impatient player), instead of waiting for the timed
  // auto-widen. Idempotent; ignored once the ceiling is already at max.
  | { t: 'expandSearch' }
  | { t: 'leaveQueue' }
  // latency probe: the server echoes `ts` straight back in a `pong`, so the client
  // measures round-trip time for the connection-quality HUD (no server clock needed)
  | { t: 'ping'; ts: number };

/** a live match summarised for the "Watch Live" list (`GET /api/live`). */
export interface LiveRoom {
  /** the room code to spectate (region-coded, e.g. `iad-abc123`) */
  room: string;
  game: GameId;
  /** '1v1' | '2v2' (versus) — record/solo rooms are not listed */
  mode: string;
  /** match clock phase ('auto' | 'transition' | 'teleop' | 'post') */
  phase: string;
  /** seconds left in the current phase (rounded) */
  timeLeft: number;
  ranked: boolean;
  /** the drivers (name + team + alliance), for the card */
  players: { name: string; teamName?: string; teamNumber?: number; alliance: 'red' | 'blue' }[];
  /** live alliance scores (red/blue totals) */
  score: { red: number; blue: number };
  /** how many people are already watching */
  spectators: number;
}

// ---- server → client --------------------------------------------------------

export type ServerMsg =
  | { t: 'welcome'; clientId: string }
  | { t: 'roster'; players: LobbyPlayer[]; hostId: string }
  | { t: 'error'; message: string }
  // reply to a 'rejoin': ok ⇒ slot reclaimed (a snapshot follows); !ok ⇒ the
  // grace window lapsed / slot is gone, stop trying
  | { t: 'rejoined'; ok: boolean }
  // `ranked` + `intros` are present only for ranked matchmaking rooms; they
  // drive the pre-match intro overlay (ELO reveal). Optional so custom rooms and
  // older servers omit them and the client simply shows no intro.
  | {
      t: 'matchStart';
      seed: number;
      setups: RobotSetup[];
      yourRobotId: number;
      /** which game to build the world for. Absent ⇒ 'decode' (old servers); the
       * client also falls back to the first snapshot's `world.game`. */
      game?: GameId;
      ranked?: boolean;
      intros?: PlayerIntro[];
      /** the Fly region actually hosting this match (e.g. 'iad'). The client shows
       * it in the HUD so a player always knows which server they were matched on.
       * Absent from older servers ⇒ the client falls back to the room-code prefix
       * or the picked server label. */
      region?: string;
    }
  // authoritative world at `serverTick`, slimmed (spec-stripped robots) with the
  // balls delta-encoded; the client reassembles a full World via `unslimWorld`.
  // `cmds[i]` is the command robot `w.robots[i]` ran this tick — the client holds
  // it to PREDICT that robot forward (so remote collisions are actually simulated,
  // not faked at render time). `ackInputTick` is the newest input tick from THIS
  // client the server folded in (diagnostic — the client reconciles off `serverTick`).
  | {
      t: 'snapshot';
      serverTick: number;
      w: SlimWorld;
      balls: BallDelta;
      cmds: QCommand[];
      ackInputTick: number;
    }
  // matchmaking status: how many are queued for your bucket + how many are needed
  | { t: 'queued'; mode: QueueMode; size: number; need: number }
  // ranked match found: the matchmaker picked a fair host region and staged the
  // roster (in Postgres). The client must DROP this matchmaker connection and open a
  // new one to `?room=<room>` (fly-replay routes it to `hostRegion`), where the host
  // machine builds the authoritative match and sends `matchStart`. `room` is already
  // region-coded (`<hostRegion>-<code>`).
  | { t: 'matchAssigned'; mode: QueueMode; room: string; hostRegion: string }
  // ranked pre-match STRATEGY phase (server-authoritative rooms only): every paired
  // player has connected, so instead of starting immediately the room opens a
  // coordination window. The client switches to the strategy screen; live changes
  // (re-pick spec / claim a start pose / ready) flow through the existing
  // `update`/`roster` messages (the roster is REDACTED per-recipient so opponents
  // show name/team/ELO only). The match begins (a `matchStart` follows) once every
  // player readies, or the room CANCELS (an `error`) if not everyone readies by
  // `deadline` (epoch ms). `yourRobotId` = this client's roster slot; `intros`
  // carry per-slot ELO for the opponent/teammate cards.
  | { t: 'strategyStart'; deadline: number; yourRobotId: number; mode: QueueMode; intros: PlayerIntro[]; game?: GameId }
  // a robot left: the server runs it on ZERO from `tick`; snapshots already
  // reflect this, so it is informational (drives the HUD)
  | { t: 'drop'; robotId: number; tick: number }
  // the match reached phase 'post': the SERVER's authoritative final score + the
  // full deterministic replay it recorded (input log). The server persists this
  // to the leaderboard (Phase 3 DB); clients render the results screen + can
  // replay it. `kind`/`record` say which board it belongs to.
  | {
      t: 'matchResult';
      kind: RoomKind;
      record?: RecordKind;
      result: ReplayResult;
      replay: Replay;
    }
  // ranked only: each driver's overall-ELO change, sent shortly after matchResult
  // once the match is scored + persisted (async DB write). Drives the results
  // screen's ELO reveal. Absent for custom/anonymous/DB-off matches.
  | { t: 'eloResult'; results: EloDelta[] }
  // record runs only: the run's standing on the leaderboard (its mode×drivetrain×
  // season bucket), sent shortly after matchResult once persisted. Drives the solo
  // results screen's PB / WR / rank line. Absent for anonymous/DB-off runs.
  | { t: 'recordResult'; info: RecordRankInfo }
  // an admin broadcast to EVERY connected client: a scheduled server restart (with
  // a countdown to `until`, epoch ms) or a general info message. Shown as a banner
  // so players aren't caught off guard by a restart mid-session.
  | { t: 'serverNotice'; kind: 'restart' | 'info'; message: string; until?: number }
  // echo of a client `ping` (same `ts`); the client computes RTT = now − ts
  | { t: 'pong'; ts: number };

/** a finished record run's leaderboard standing (its mode×drivetrain×season
 * bucket). `score` is the NET score (earned − own penalties). */
export interface RecordRankInfo {
  mode: RecordKind;
  drivetrain: string;
  score: number;
  rank: number; // 1-based position in the bucket
  total: number; // number of ranked players in the bucket
  isPB: boolean; // this run beat the player's previous best in the bucket
  isWR: boolean; // rank === 1
}

export const encodeMsg = (m: ClientMsg | ServerMsg): string => JSON.stringify(m);
export const decodeClientMsg = (s: string): ClientMsg => JSON.parse(s) as ClientMsg;
export const decodeServerMsg = (s: string): ServerMsg => JSON.parse(s) as ServerMsg;

// ---- snapshot slimming + ball delta -----------------------------------------

/**
 * Wire snapshots drop bandwidth two ways without any determinism risk:
 *  1. STRIP the static `spec` from each robot — it never changes after
 *     matchStart, so the client re-injects it from `setups` (worldHash ignores
 *     spec, so parity is unaffected).
 *  2. DELTA the balls — send the authoritative id ORDER every frame (cheap, a
 *     few dozen ints) but only the DATA for balls that changed since the last
 *     snapshot. The client rebuilds the array in the sent order from its
 *     baseline, so it is byte-identical to the server's `world.balls`.
 *
 * Sending the order every frame is what keeps it deterministic: array position
 * drives collision/scoring iteration + `worldHash`, so it must match exactly.
 * (Over the reliable+ordered WebSocket no ack is needed — the client's baseline
 * is always the previous snapshot. A reconnect re-primes with a full keyframe.)
 */
export type SlimWorld = Omit<World, 'balls' | 'robots'> & {
  robots: Omit<RobotState, 'spec'>[];
};

/** the authoritative ball id ORDER + full data for only the changed balls */
export interface BallDelta {
  order: number[];
  upd: Artifact[];
}

function stripSpec(r: RobotState): Omit<RobotState, 'spec'> {
  const c: Partial<RobotState> = { ...r };
  delete c.spec;
  return c as Omit<RobotState, 'spec'>;
}

/** world for the wire: balls removed, robots stripped of their static spec */
export function slimWorld(world: World): SlimWorld {
  const { robots, ...rest } = world; // `rest` still carries balls
  const slim = { ...rest, robots: robots.map(stripSpec) };
  delete (slim as { balls?: unknown }).balls;
  return slim as SlimWorld;
}

/** finite number or a fallback — guards against a field that arrived undefined
 * (an older server never sent it) or as `null` (JSON serializes NaN/Infinity to
 * null). Bare arithmetic on either poisons the sim to NaN. */
const finiteOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/**
 * BACKWARD-COMPAT SHIM: the shared `src/sim` grows new per-tick RobotState fields
 * over time (e.g. the power-draw model added `flywheelSpin` / `flywheelSpinRate` /
 * `powerDraw`). ONE Fly app serves every client version, so a NEWER client can
 * receive a snapshot from an OLDER server whose RobotState predates those fields —
 * they arrive `undefined`. The newer client's `step()` then does
 * `POWER_DRAW_FLYWHEEL_HOLD * undefined` → NaN, which propagates into the drive
 * params and blows the robot's position to NaN (it renders at the camera origin /
 * field centre and freezes). Re-seed any missing/non-finite dynamic field to a
 * sane value (mirrors `createWorld`'s spawn seeding) so an old→new skew degrades
 * gracefully instead of NaN-ing. Harmless when the server DOES send them.
 */
function backfillRobot(r: RobotState): RobotState {
  return {
    ...r,
    // flywheel spin is DERIVED from distance to the robot's own goal; seed it at
    // the position target (like spawn) so there's no phantom spin-up spike.
    flywheelSpin: finiteOr(r.flywheelSpin, flywheelSpinTarget(r.alliance, r.pos)),
    flywheelSpinRate: finiteOr(r.flywheelSpinRate, 0),
    powerDraw: finiteOr(r.powerDraw, 0),
    moduleAngles:
      Array.isArray(r.moduleAngles) && r.moduleAngles.length === 4
        ? r.moduleAngles.map((a) => finiteOr(a, 0))
        : [0, 0, 0, 0],
    moduleTargets:
      Array.isArray(r.moduleTargets) && r.moduleTargets.length === 4
        ? r.moduleTargets.map((a) => finiteOr(a, 0))
        : [0, 0, 0, 0],
  };
}

/**
 * Ball-delta codec — ONE tested encode/decode pair used by both ends so the
 * server's encoder and the client's decoder can never silently drift apart.
 *
 * `encodeBallDelta` diffs the live balls against a `baseline` (id → the ball the
 * client is known to hold); `applyBallDelta` reconstructs the array from a running
 * baseline the client mutates in place. The `order` (every id, every frame) is what
 * keeps it deterministic — array position drives collision/scoring iteration and
 * `worldHash`, so it must match the server exactly. A `null` baseline (or one that
 * has been reset) yields a full KEYFRAME (`upd` == every ball).
 *
 * The reconstruction is baseline-agnostic in a way the unreliable lane relies on:
 * any ball NOT in `upd` is, by construction, byte-identical between the baseline
 * and now, so a client holding ANY intermediate state for it rebuilds correctly —
 * which is why a delta keyed to an older ACKed baseline survives a dropped frame.
 */
export function encodeBallDelta(
  baseline: Map<number, Artifact> | null,
  balls: Artifact[],
): BallDelta {
  const order = balls.map((b) => b.id);
  if (!baseline) return { order, upd: balls.slice() };
  const upd: Artifact[] = [];
  for (const b of balls) {
    const prev = baseline.get(b.id);
    if (prev === undefined || JSON.stringify(prev) !== JSON.stringify(b)) upd.push(b);
  }
  return { order, upd };
}

/** Reconstruct the ball array from a running `baseline` (MUTATED in place: patched
 * with `upd`, then pruned to exactly `order`). Byte-identical to the server's
 * `world.balls`. Returns the rebuilt array in the authoritative order. */
export function applyBallDelta(baseline: Map<number, Artifact>, delta: BallDelta): Artifact[] {
  for (const b of delta.upd) baseline.set(b.id, b);
  const keep = new Set(delta.order);
  for (const id of baseline.keys()) if (!keep.has(id)) baseline.delete(id);
  return delta.order
    .map((id) => baseline.get(id))
    .filter((b): b is Artifact => b !== undefined);
}

/** rebuild a full World from a slim world + reconstructed ball array, re-injecting
 * each robot's spec by id (and back-filling any dynamic fields an older server
 * omitted — see `backfillRobot`) */
export function unslimWorld(
  w: SlimWorld,
  balls: Artifact[],
  specById: (id: number) => RobotSpec,
): World {
  return {
    ...w,
    // old servers omit `game`; default it so gameOf/moduleFor resolve to DECODE
    game: w.game ?? 'decode',
    robots: w.robots.map((r) => backfillRobot({ ...r, spec: specById(r.id) })),
    balls,
  };
}