import type { Artifact, GameId, RobotCommand, RobotSpec } from '../types';
import type { RobotSetup } from '../sim/spawn';
import type { MatchResultInfo, NetSession, NetStatus, Snapshot } from './session';
import type { Transport } from './transport';
import { setServerNotice } from './notice';
import { regionLabel, isKnownRegion, selectedServer } from './env';
import {
  encodeMsg,
  decodeServerMsg,
  quantizeCommand,
  dequantizeCommand,
  applyBallDelta,
  unslimWorld,
  type EloDelta,
  type PlayerIntro,
  type RecordRankInfo,
} from './protocol';

/** monotonic wall clock (ms). performance.now() in the browser; Date.now() as a
 * fallback for any non-DOM context. Diagnostics only — never touches the sim. */
const nowMs = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

/** the display label for the server/region a match runs on. Prefer the region the
 * server reported at matchStart; else infer it from a region-coded room code
 * (`iad-…`); else fall back to the picked server's label. Blank ⇒ HUD hides it. */
function deriveServerLabel(reportedRegion: string | undefined, room: string): string {
  if (reportedRegion) return regionLabel(reportedRegion);
  const prefix = /^([a-z]{3})-/.exec(room)?.[1];
  if (prefix && isKnownRegion(prefix)) return regionLabel(prefix);
  return selectedServer()?.label ?? '';
}

/** how often to probe latency. Faster than the old 1 Hz so the ping GRAPH can
 * actually resolve sub-second spikes (the smoothed RTT number can't). ~3 Hz is a
 * trivial number of tiny frames. */
const PING_INTERVAL_MS = 300;
/** window of snapshot inter-arrival gaps kept for the rate + jitter estimate */
const SNAP_WINDOW = 30;
/** raw RTT samples retained for the ping graph (~36 s at PING_INTERVAL_MS) */
const RTT_HISTORY = 120;

/**
 * Client half of the server-authoritative netcode. Constructed AFTER the server
 * sends `matchStart` (so seed/setups/robotId are known), it takes over the
 * transport from the LobbyClient and:
 *   - `sendInput` forwards each tick's quantized command to the server,
 *   - `takeSnapshot` hands the GameController the freshest authoritative world to
 *     reconcile against,
 *   - `matchStart` arriving again (a host restart) fires `onRestart`.
 *
 * A dropped socket flips `waitingFor` to 'server' (the HUD shows reconnecting);
 * prediction means the local robot keeps responding meanwhile.
 */
export class ServerSession implements NetSession {
  /** which game the match plays (from matchStart; DECODE by default). Mutable so a
   * host restart can carry a new game, but never written by consumers. */
  game: GameId;
  readonly localRobotId: number;
  /** read-only spectator session (no local robot; input suppressed) */
  readonly spectator: boolean;
  seed: number;
  setups: RobotSetup[];
  ranked: boolean;
  intros: PlayerIntro[];
  /** the Fly region hosting this match (raw, for reconnect routing) */
  readonly region?: string;
  /** per-driver overall-ELO change, arrives shortly after matchResult (ranked) */
  eloResults: EloDelta[] = [];

  private snapshot: Snapshot | null = null;
  private matchResult: MatchResultInfo | null = null;
  /** record run's leaderboard standing, arrives shortly after matchResult */
  private recordResult: RecordRankInfo | null = null;
  private restartCb: (() => void) | null = null;
  private connected = true;
  /** reconnection budget exhausted — the server likely restarted; prompt a refresh */
  private failed = false;
  /** other robots in the match (for the HUD "N players" chip) */
  private readonly otherRobots: number;
  /** human-readable label of the server/region hosting this match (HUD) */
  private readonly serverLabel: string;
  /** running ball baseline the delta-encoded snapshots patch (keyed by id) */
  private readonly baseBalls = new Map<number, Artifact>();
  /** newest authoritative `serverTick` we've APPLIED — the baseline we ACK back to
   * the server, and the guard that discards a stale/duplicate snapshot (a no-op on
   * the ordered WebSocket, required once snapshots can arrive out of order on the
   * unreliable QUIC lane). Reset to -1 on a host restart (new world, tick 0). */
  private appliedTick = -1;

  // ---- connection-quality diagnostics (for the HUD net readout) --------------
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** smoothed round-trip time (EWMA over pong samples), null until the first pong */
  private rttMs: number | null = null;
  /** RAW round-trip samples (oldest→newest) for the ping graph — un-smoothed so a
   * spike shows as a spike */
  private readonly rttSamples: number[] = [];
  /** wall-clock of the previous snapshot, to time inter-arrival gaps */
  private lastSnapAt: number | null = null;
  /** recent snapshot inter-arrival gaps (ms) — feeds snapHz + jitter */
  private readonly snapGaps: number[] = [];

  constructor(
    private readonly transport: Transport,
    private readonly host: boolean,
    start: {
      seed: number;
      setups: RobotSetup[];
      yourRobotId: number;
      game?: GameId;
      ranked?: boolean;
      intros?: PlayerIntro[];
      region?: string;
    },
    readonly clientId: string,
    readonly room: string,
    spectator = false,
  ) {
    this.spectator = spectator;
    this.game = start.game ?? 'decode';
    this.seed = start.seed;
    this.setups = start.setups;
    this.ranked = start.ranked ?? false;
    this.intros = start.intros ?? [];
    this.region = start.region;
    this.localRobotId = start.yourRobotId;
    this.otherRobots = Math.max(0, start.setups.length - 1);
    this.serverLabel = deriveServerLabel(start.region, room);
    // take over routing + reconnection handling from the LobbyClient
    transport.onMessage((d) => this.onMessage(d));
    transport.onDown(() => {
      this.connected = false; // HUD shows "reconnecting"; prediction keeps running
    });
    transport.onReopen(() => {
      // reclaim our in-match slot on the fresh socket; a snapshot resyncs us
      this.failed = false;
      transport.send(encodeMsg({ t: 'rejoin', room: this.room, clientId: this.clientId }));
    });
    transport.onFail(() => {
      this.connected = false; // retries exhausted (the server likely restarted)
      this.failed = true;
    });
    // probe latency continuously while the match is live (a no-op send when the
    // socket is down); each pong updates the smoothed RTT for the HUD. Hot-path
    // lane: a lost ping is simply superseded by the next 300 ms probe — no reason
    // to head-of-line block the control stream behind it.
    this.pingTimer = setInterval(() => {
      transport.send(encodeMsg({ t: 'ping', ts: nowMs() }), { reliable: false });
    }, PING_INTERVAL_MS);
  }

  isHost(): boolean {
    return this.host;
  }

  requestRestart(): void {
    if (this.host) this.transport.send(encodeMsg({ t: 'restart' }));
  }

  onRestart(cb: () => void): void {
    this.restartCb = cb;
  }

  sendInput(tick: number, cmd: RobotCommand): void {
    if (this.spectator) return; // a spectator controls nothing
    // Hot-path lane: inputs are sent every tick and the server holds-last, so a
    // dropped input is superseded by the next one within ~16 ms. Sending it
    // unreliable is exactly what stops one lost/late input from stalling the
    // whole stream behind it (the head-of-line win we're after).
    // Piggyback the snapshot ACK (newest applied serverTick) so the server knows
    // which baseline we hold — free here, drivers send input every tick.
    const ack = this.appliedTick >= 0 ? this.appliedTick : undefined;
    this.transport.send(encodeMsg({ t: 'input', tick, q: quantizeCommand(cmd), ack }), {
      reliable: false,
    });
  }

  takeSnapshot(): Snapshot | null {
    const s = this.snapshot;
    this.snapshot = null;
    return s;
  }

  getMatchResult(): MatchResultInfo | null {
    return this.matchResult;
  }

  getRecordResult(): RecordRankInfo | null {
    return this.recordResult;
  }

  status(): NetStatus {
    // snapshot rate + jitter from the recent inter-arrival gaps (mean + mean-abs-dev)
    let snapHz: number | null = null;
    let jitterMs: number | null = null;
    if (this.snapGaps.length >= 3) {
      const mean = this.snapGaps.reduce((a, b) => a + b, 0) / this.snapGaps.length;
      if (mean > 0) snapHz = Math.round(1000 / mean);
      jitterMs = Math.round(
        this.snapGaps.reduce((a, b) => a + Math.abs(b - mean), 0) / this.snapGaps.length,
      );
    }
    const rttMs = this.rttMs === null ? null : Math.round(this.rttMs);
    // smoothness bucket: jitter dominates the visual feel, latency is secondary.
    // reconnecting ⇒ always poor; unmeasured ⇒ null (HUD shows "measuring…")
    let quality: NetStatus['quality'] = null;
    if (!this.connected) {
      quality = 'poor';
    } else if (rttMs !== null && jitterMs !== null) {
      if (rttMs < 90 && jitterMs < 12) quality = 'good';
      else if (rttMs < 180 && jitterMs < 28) quality = 'fair';
      else quality = 'poor';
    }
    return {
      waitingFor: this.connected ? null : 'server',
      desync: false,
      peers: this.otherRobots,
      failed: this.failed,
      rttMs,
      snapHz,
      jitterMs,
      quality,
      rttHistory: this.rttSamples.length ? this.rttSamples.slice() : null,
      server: this.serverLabel || null,
    };
  }

  dispose(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.transport.close();
  }

  /** a robot's static spec, re-injected into slimmed snapshots (from setups) */
  private specById = (id: number): RobotSpec =>
    this.setups.find((s) => s.id === id)?.spec ?? this.setups[0].spec;

  private onMessage(data: string): void {
    const m = decodeServerMsg(data);
    if (m.t === 'snapshot') {
      // discard a stale/duplicate snapshot: the client reconciles to the NEWEST
      // authoritative world, and a delta is keyed to a baseline at-or-before this
      // one, so applying an older frame after a newer one would regress the balls.
      // A no-op on the ordered WebSocket (ticks arrive monotonic); the guard the
      // out-of-order QUIC-datagram lane will need.
      if (m.serverTick <= this.appliedTick) return;
      // patch the running ball baseline + rebuild the array in the authoritative
      // order (shared codec so it can't drift from the server's encoder)
      const balls = applyBallDelta(this.baseBalls, m.balls);
      const world = unslimWorld(m.w, balls, this.specById);
      // each robot's command this tick, so the controller can predict remotes.
      // tolerate an older server that doesn't send cmds (remotes just won't be
      // predicted forward — no crash) so a version mismatch degrades gracefully
      const cmds = new Map<number, RobotCommand>();
      const qc = m.cmds ?? [];
      m.w.robots.forEach((r, i) => {
        if (qc[i]) cmds.set(r.id, dequantizeCommand(qc[i]));
      });
      // keep only the freshest — the controller reconciles to the newest world
      this.snapshot = { serverTick: m.serverTick, world, cmds, ackInputTick: m.ackInputTick };
      this.appliedTick = m.serverTick; // this is now our baseline; ACK it on next input
      this.connected = true; // snapshots flowing ⇒ we're synced
      // time the gap since the last snapshot for the rate + jitter readout. A huge
      // gap (backgrounded tab / a reconnect keyframe) is discarded so it can't
      // poison the jitter estimate — start a fresh window instead.
      const t = nowMs();
      if (this.lastSnapAt !== null) {
        const gap = t - this.lastSnapAt;
        if (gap < 1000) {
          this.snapGaps.push(gap);
          if (this.snapGaps.length > SNAP_WINDOW) this.snapGaps.shift();
        } else {
          this.snapGaps.length = 0;
        }
      }
      this.lastSnapAt = t;
    } else if (m.t === 'pong') {
      // round-trip sample → exponentially-weighted moving average (favour recent)
      const sample = nowMs() - m.ts;
      this.rttMs = this.rttMs === null ? sample : this.rttMs * 0.6 + sample * 0.4;
      // also keep the RAW sample for the ping graph (spikes the EWMA would smooth away)
      this.rttSamples.push(sample);
      if (this.rttSamples.length > RTT_HISTORY) this.rttSamples.shift();
    } else if (m.t === 'matchResult') {
      this.matchResult = { kind: m.kind, record: m.record, result: m.result, replay: m.replay };
    } else if (m.t === 'eloResult') {
      this.eloResults = m.results;
    } else if (m.t === 'recordResult') {
      this.recordResult = m.info;
    } else if (m.t === 'serverNotice') {
      setServerNotice(m.message ? { kind: m.kind, message: m.message, until: m.until } : null);
    } else if (m.t === 'matchStart') {
      // a host restart: adopt the new seed/setups/game and rebuild
      this.seed = m.seed;
      this.setups = m.setups;
      if (m.game) this.game = m.game;
      this.ranked = m.ranked ?? false;
      this.intros = m.intros ?? [];
      this.eloResults = [];
      this.snapshot = null;
      this.matchResult = null;
      this.recordResult = null;
      this.baseBalls.clear();
      this.appliedTick = -1; // fresh world starts at tick 0; don't reject its snapshots
      this.restartCb?.();
    } else if (m.t === 'rejoined' && !m.ok) {
      // the grace window lapsed / the match is gone — the held slot can't be
      // reclaimed. Surface it as a hard failure so the HUD shows the "connection
      // lost" panel (MENU/refresh) instead of spinning "reconnecting" forever.
      this.connected = false;
      this.failed = true;
      this.transport.close();
    }
    // 'drop' is reflected in the next snapshot already; nothing to do here
  }
}
