import type { GameId, RobotCommand, World } from '../types';
import type { RobotSetup } from '../sim/spawn';
import type { Replay, ReplayResult } from '../sim/replay';
import type { EloDelta, PlayerIntro, RecordKind, RecordRankInfo, RoomKind } from './protocol';

/** the server's authoritative end-of-match payload (score + recorded replay) */
export interface MatchResultInfo {
  kind: RoomKind;
  record?: RecordKind;
  result: ReplayResult;
  replay: Replay;
}

/**
 * The entire networking boundary the GameController sees. In solo play the
 * controller holds `null` here and the code path is bit-identical to a
 * single-player game. In multiplayer a `ServerSession` (server-authoritative +
 * client-side prediction) implements this.
 *
 * Reconcile contract: the controller PREDICTS its own robot locally each tick,
 * sending inputs via `sendInput`, and CORRECTS to authoritative `Snapshot`s
 * pulled with `takeSnapshot` (replaying its buffered inputs past `serverTick`).
 * This replaced the old input-delay lockstep (produce/canStep/commandsForTick/
 * checkpoint), whose head-of-line blocking froze every peer on one client's
 * jitter.
 */

/** an authoritative world state from the server */
export interface Snapshot {
  /** the server's sim tick this world is at */
  serverTick: number;
  world: World;
  /** the command each robot ran this tick (by robot id) — the client holds these
   * to PREDICT remote robots forward, so their collisions are actually simulated */
  cmds: Map<number, RobotCommand>;
  /** newest input tick from this client the server had applied (diagnostic) */
  ackInputTick: number;
}

export interface NetStatus {
  /** what a stall is waiting on (null when healthy) — e.g. 'server' while
   * reconnecting; the HUD surfaces it */
  waitingFor: string | null;
  desync: boolean;
  peers: number;
  /** reconnection budget exhausted (server likely restarted) — prompt a refresh */
  failed: boolean;
  // ---- connection-quality diagnostics (null until measured / solo path) -------
  /** smoothed round-trip time to the server in ms (ping → pong) */
  rttMs: number | null;
  /** measured authoritative-snapshot arrival rate in Hz (server sends ~30) */
  snapHz: number | null;
  /** snapshot inter-arrival jitter in ms (mean absolute deviation) — the single
   * best predictor of visible choppiness */
  jitterMs: number | null;
  /** overall smoothness bucket derived from rtt + jitter (drives the HUD colour) */
  quality: 'good' | 'fair' | 'poor' | null;
  /** recent RAW round-trip samples (ms, oldest→newest) for the ping GRAPH — the
   * smoothed `rttMs` hides sub-second spikes, so this raw series is what surfaces
   * them. null until the first pong / solo path. */
  rttHistory: number[] | null;
  /** human-readable label of the server/region hosting the match (e.g. 'US East'),
   * or null on a single-region / unknown deploy. Shown in the HUD. */
  server: string | null;
}

/** the duo-record rematch tally, as the server reports it */
export interface RematchVote {
  votes: number;
  need: number;
  /** is THIS client's vote currently in? */
  mine: boolean;
}

export interface NetSession {
  /** which game the match plays (from matchStart / the first snapshot; DECODE by
   * default). The GameController builds its initial predicted world for this game. */
  readonly game: GameId;
  /** the local player's robot id (assigned by the server at match start; -1 when
   * spectating — there is no local robot) */
  readonly localRobotId: number;
  /** read-only SPECTATOR session: no local robot, no input sent — the GameController
   * renders every robot from the authoritative snapshot stream. */
  readonly spectator?: boolean;
  /** the room code + our clientId + hosting region (ServerSession only) — used to
   * persist an "active game" record so the player can REJOIN this same match later */
  readonly room?: string;
  readonly clientId?: string;
  readonly region?: string;
  /** the match seed the world was built from (updated on a host restart) */
  seed: number;
  /** the robot slots in the match (updated on a host restart) */
  setups: RobotSetup[];
  /** ranked matchmaking match? gates the pre-match ELO intro overlay */
  ranked: boolean;
  /** per-driver ELO for the intro overlay (empty unless ranked) */
  intros: PlayerIntro[];
  /** per-driver overall-ELO change for the results screen (populated shortly
   * after phase 'post' in ranked matches; empty otherwise) */
  eloResults: EloDelta[];
  /** does this client hold start/restart authority? */
  isHost(): boolean;
  /** host only: ask the server to re-author the match (server picks the seed) */
  requestRestart(): void;
  /** subscribe to server-authored restarts (rebuild the world) */
  onRestart(cb: () => void): void;
  /** send the local command for `tick` (quantized on the wire) */
  sendInput(tick: number, cmd: RobotCommand): void;
  /** pull the freshest unconsumed snapshot, or null if none arrived */
  takeSnapshot(): Snapshot | null;
  /** the server's end-of-match result (score + recorded replay), or null before
   * phase 'post' — drives the Results screen's "recorded / watch replay" */
  getMatchResult(): MatchResultInfo | null;
  /** a record run's leaderboard standing (PB / WR / rank), or null until the
   * server's `recordResult` lands after persistence — record runs only */
  getRecordResult?(): RecordRankInfo | null;
  status(): NetStatus;
  /** how many people are watching this match, as the SERVER reports it to players
   *  (hidden admin observers excluded). 0 until the first update arrives. */
  spectatorCount?(): number;
  /** duo-record rematch tally (votes / how many are needed / whether ours is in) */
  rematchVote?(): RematchVote;
  /** toggle our rematch vote — the server restarts only on unanimity */
  setRematch?(on: boolean): void;
  dispose(): void;
}
