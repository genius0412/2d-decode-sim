import type {
  Alliance,
  ArtifactColor,
  ChainScoreMode,
  DrivetrainType,
  GameId,
  GameMode,
  MatchPhase,
  Motif,
  RobotCommand,
  RobotState,
  ScoreBreakdown,
  World,
  GameSettings,
} from './types';
import * as C from './config';
import { DEFAULT_ASSISTS, DEFAULT_SPEC, type RobotSetup } from './sim/spawn';
import { moduleFor, gameOf } from './games';
import type { GameModule } from './games';
import { accelMultiplier as chainAccelMultiplier, type EndgameState } from './games/chain/state';
import { chainHopperCap } from './games/chain/config';
import { chainCatalystPrompt } from './games/chain/play';
import { startMatch, robotsEnabled } from './sim/match';
import { robotInLaunchZone } from './sim/robot';
import { InputManager } from './input/input';
import { Renderer } from './render/renderer';
import { MatchAudio } from './audio';
import type { MatchResultInfo, NetSession, NetStatus, Snapshot } from './net/session';
import { localizeCommand } from './net/protocol';
import { clamp } from './math';
import type { RecordRankInfo } from './net/protocol';

// GameSettings is defined canonically in ./types; re-exported here because many
// modules import it from './game'.
export type { GameSettings };

// Visual error-smoothing for the LOCAL robot on reconcile (it stays predicted for
// zero input lag; the snap correction is eased in over ~SMOOTH_HALFLIFE, or SNAPs
// past SMOOTH_MAX_DIST — a real desync, not jitter).
const SMOOTH_HALFLIFE = 0.06; // s — the offset halves every 60ms (~gone in 200ms)
const SMOOTH_MAX_DIST = 16; // in — larger corrections snap instead of floating

// Minecraft-style entity INTERPOLATION for REMOTE robots + balls: render them a
// couple snapshots in the PAST and lerp between the two authoritative states that
// bracket the render clock — buttery smooth at any FPS regardless of tick rate.
const INTERP_DELAY_TICKS = 5; // render remotes ~5 ticks (~83ms) behind latest: one
// extra tick of cushion over the old 4 so a single 30 Hz snapshot gap (33ms) no
// longer drains the interpolation buffer and freezes/warps remotes (a stutter source)
const INTERP_BUFFER = 8; // authoritative snapshots kept for interpolation

// PREDICTION LEAD CAP. During a snapshot stall (a ping spike / a dropped burst) the
// client keeps predicting and buffering its own inputs. Without a bound, the input
// buffer grows unboundedly and the NEXT snapshot triggers a single synchronous
// reconcile that replays hundreds of full sim steps at once — a multi-hundred-ms
// hitch that also re-simulates balls/remotes from a stale state, so everything
// "flies around" on recovery. Cap how far prediction runs ahead of the newest
// authoritative tick: past this the local robot pauses (honest "you're lagging")
// instead of building a replay bomb. ~667ms of headroom covers legitimately high
// latency; beyond it the link is unplayable anyway.
const MAX_PREDICT_LEAD = 40; // ticks
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** shortest-arc angle lerp */
const lerpAngle = (a: number, b: number, t: number): number =>
  a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

export interface Toast {
  id: number;
  text: string;
  at: number; // performance.now() ms
}

/** one driver's overall-ELO change on the results screen (ranked matches only) */
export interface EloResultRow {
  robotId: number;
  name: string;
  alliance: Alliance;
  before: number;
  after: number;
  isLocal: boolean;
  /** Glicko rating deviation after the game — high ⇒ provisional rating */
  provisional: boolean;
}

/** one driver's pre-match intro card (ranked matches only) */
export interface IntroPlayer {
  robotId: number;
  name: string;
  teamName: string;
  teamNumber: number;
  drivetrain: DrivetrainType;
  alliance: Alliance;
  /** current ranked ELO, or null if unranked / signed out */
  elo: number | null;
  isLocal: boolean;
}

export interface HudSnapshot {
  /** which game is being played — drives which score HUD GameView renders */
  game: GameId;
  /** Chain Reaction scoring readout (present only for CR) */
  chain?: {
    /** your alliance's particles scored (count) */
    scored: number;
    oppScored: number;
    /** your accelerator's points-per-particle (1 + catalysts on your hooks) */
    mult: number;
    oppMult: number;
    /** catalysts your alliance has seated on hooks */
    catalysts: number;
    oppCatalysts: number;
    /** particle POINTS (catalyst multiplier folded in) — for the results breakdown */
    particlePts: number;
    oppParticlePts: number;
    /** your robot's endgame status */
    endgame: EndgameState;
    /** your robot is carrying a catalyst */
    carrying: boolean;
    /** a catalyst action is available RIGHT NOW at your position (in range) */
    ringAction: 'pickup' | 'place' | null;
    /** your robot's ball-storage capacity (the builder slider) */
    storage: number;
    /** your robot's scoring archetype (turret shooter / dumper) */
    mode: ChainScoreMode;
    /** foul POINTS your alliance has been AWARDED (opponent's violations) */
    foulPts: number;
    oppFoulPts: number;
  };
  mode: GameMode;
  phase: MatchPhase;
  timeLeft: number;
  alliance: Alliance;
  motif: Motif;
  score: ScoreBreakdown;
  oppTotal: number;
  /** the opponent alliance's full breakdown (for the match-results screen) */
  oppScore: ScoreBreakdown;
  provisionalPattern: number;
  /** fouls committed BY each alliance (counts, for the HUD chip) */
  fouls: Record<Alliance, { minor: number; major: number }>;
  fieldCentric: boolean;
  aimAssist: boolean;
  autoIntake: boolean;
  autoFire: boolean;
  hopper: ArtifactColor[];
  /** local robot's current drive power draw (0..POWER_DRAW_MAX) — flywheel
   * spin-up + intake pulling current off the drive motors; shown as the HUD gauge */
  powerDraw: number;
  inLaunchZone: boolean;
  gamepadConnected: boolean;
  /** drive controls reversed so the shooter side leads (robot-centric only) */
  frontFlipped: boolean;
  /** park mode active (speed capped to parkSpeedPct); only activatable in
   * endgame / free drive, per canPark() */
  parked: boolean;
  /** can park mode be TURNED ON right now (endgame or free drive)? drives the
   * HUD hint so the driver knows why the button isn't doing anything yet */
  canPark: boolean;
  gateOpen: boolean;
  rampCount: number;
  classifiedCount: number;
  overflowCount: number;
  /** pre-match "3-2-1" countdown value, or null when not counting down */
  countdown: number | null;
  /** performance.now() ms at which the end-of-match fanfare (whoosh) fires and
   * the results reveal should land; null except during phase 'post' */
  resultRevealAt: number | null;
  toasts: Toast[];
  /** multiplayer status (null in solo): stall target + desync + connection quality */
  net: NetStatus | null;
}

export class GameController {
  private world: World;
  private readonly input: InputManager;
  private readonly renderer = new Renderer();
  private readonly ctx: CanvasRenderingContext2D;
  private readonly audio = new MatchAudio();
  private raf = 0;
  private lastT = 0;
  private acc = 0;
  private lastCmd: RobotCommand | null = null;
  private toasts: Toast[] = [];
  private toastId = 0;
  private disposed = false;
  private prevPhase: MatchPhase;
  private warningPlayed = false;
  /** performance.now() ms when the match entered phase 'post' (drives the
   * whoosh-synced results reveal); null until the match ends */
  private matchOverAt: number | null = null;
  /** world.time when the pre-match countdown began (null = not started) */
  private countdownStart: number | null = null;
  private lastBeepAt = -1;
  private lastTransitionBeep = -1;
  private hudCountdown: number | null = null;
  /** drive controls reversed so the shooter side leads (robot-centric only) */
  private frontFlipped = false;
  /** park mode: caps drive command magnitude to settings.parkSpeedPct while on */
  private parked = false;
  // action-SFX edge trackers per robot id (seeded in seedActionAudio)
  private prevFireAt: Record<number, number> = {};
  private prevIntakeAt: Record<number, number> = {};
  private prevGateOpen: Record<Alliance, boolean> = { red: false, blue: false };

  /** which game this controller builds its INITIAL world for (solo: the player's
   * setting; networked: DECODE for now). Once running, the STEP/DRAW/HUD always
   * resolve the module from `this.world.game` via `this.mod` — a reconciled server
   * world carries its own game, so prediction/replay never use the wrong step. */
  private readonly gameId: GameId;
  /** the active game module, resolved from the CURRENT world (hot-path safe). */
  private get mod(): GameModule {
    return gameOf(this.world);
  }
  /** the local player's robot id (slot 0 in solo; assigned by the lobby in
   * multiplayer) */
  readonly localRobotId: number;
  /** read-only spectator (watching someone else's match): no local robot / input */
  private readonly spectator: boolean = false;
  /** null in solo; the server-authoritative session in multiplayer */
  private readonly session: NetSession | null;
  /** multiplayer sim-step timer (survives tab backgrounding); 0 = solo */
  private simTimer = 0;
  private lastSimT = 0;
  /** predict/reconcile input buffer: local commands not yet folded into a server
   * snapshot, replayed forward after each reconcile (keyed by the tick produced) */
  private inputBuf: { tick: number; cmd: RobotCommand }[] = [];
  /** VISUAL-only offset for the local robot, set on each reconcile so a snapshot
   * correction is eased in (render loop decays it) instead of snapping — hides
   * rubberbanding from jittery snapshots. Never affects `this.world`. */
  private localSmooth = { x: 0, y: 0, heading: 0 };
  /** set by the UI for a RECORD run: the restart binding asks for a whole new run
   * (session teardown + fresh room) instead of an in-place rebuild. Null elsewhere,
   * which is what keeps the binding inert in a versus match. */
  private restartRequestCb: (() => void) | null = null;
  /** authoritative REMOTE-robot poses per received snapshot, for interpolating them
   * between snapshots. Captured BEFORE reconcile mutates the snapshot world. (Balls
   * are NOT interpolated — see displayWorld.) */
  private snapBuf: {
    tick: number;
    robots: { id: number; x: number; y: number; heading: number }[];
  }[] = [];
  /** the interpolation render clock (in server ticks), lagging the latest snapshot
   * by ~INTERP_DELAY_TICKS; eased forward each frame for smooth playback */
  private renderTick = 0;
  /** each remote robot's latest command (from the newest snapshot), held to
   * PREDICT it forward so its collisions are simulated, not faked */
  private remoteCmds = new Map<number, RobotCommand>();
  /** newest authoritative tick reconciled to; prediction is capped MAX_PREDICT_LEAD
   * ticks past it so a snapshot stall can't build an unbounded replay buffer */
  private lastServerTick = 0;
  /** MULTIPLAYER event feed. `world.events` rides in every snapshot and the server
   * appends to it without clearing (a monotonic per-match log), so the SAME event
   * arrives in snapshot after snapshot — and the local predict/reconcile re-runs the
   * phase machine, re-emitting transition events speculatively. Surfacing `world.events`
   * directly therefore showed each event ~5× (the `slice(-5)` toast cap). Instead we
   * track how many authoritative events we've already shown and queue only the NEW tail
   * from each snapshot (prediction events are ignored). Solo is unaffected (it drains
   * `world.events` straight, once per frame). */
  private shownEventCount = 0;
  private netEvents: string[] = [];
  /** true once the first snapshot has arrived — the lead cap only applies after that
   * (before it, the sim-driven pre-match countdown must predict freely from tick 0) */
  private gotSnapshot = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private settings: GameSettings,
    session: NetSession | null = null,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.session = session;
    // which game this controller builds its INITIAL world for. A networked
    // session's game is authoritative (from matchStart); solo uses the setting.
    // Once running, STEP/DRAW/HUD resolve from this.world.game (this.mod).
    this.gameId = session ? session.game : settings.game;
    this.localRobotId = session ? session.localRobotId : 0;
    // read-only spectator: no local robot, no input — every robot renders from snapshots
    this.spectator = session?.spectator ?? false;
    this.audio.masterVolume = settings.audio.volume.master;
    this.audio.gameVolume = settings.audio.volume.game;
    this.audio.sfxVolume = settings.audio.volume.sfx;
    this.audio.voiceVolume = settings.audio.volume.voice;
    this.input = new InputManager(settings.bindings);

    // Mobile Mode: enable assists by default if touch-capable
    if (window.matchMedia('(pointer: coarse)').matches) {
      this.settings.assists.aimAssist = true;
      this.settings.assists.autoFire = true;
      this.settings.assists.autoIntake = true;
    }

    this.world = this.makeWorld();
    this.prevPhase = this.world.match.phase;
    this.seedActionAudio();
    session?.onRestart(() => this.rebuildFromNet());
    this.input.attach();
    window.addEventListener('resize', this.onResize);
    this.onResize();
    // Multiplayer must keep simulating + producing inputs even when the tab is
    // unfocused (else every peer stalls waiting on it), so drive the sim from a
    // timer (+ audio keepalive to defeat background throttling) and use rAF for
    // RENDER only. Solo stays on the plain rAF loop.
    if (session) {
      this.audio.startKeepAlive();
      this.lastSimT = performance.now();
      this.simTimer = window.setInterval(this.simStep, 1000 * C.SIM_DT);
    }
    this.raf = requestAnimationFrame(this.loop);
  }

  /** expose input manager for mobile controls */
  getInputManager() {
    return this.input;
  }

  private localRobot() {
    return this.world.robots.find((r) => r.id === this.localRobotId) ?? this.world.robots[0];
  }

  /** the alliance whose viewpoint the camera + HUD use — the LOCAL robot's
   * alliance (in multiplayer this is the lobby pick, which can differ from the
   * menu's settings.alliance; in solo they are the same) */
  private viewAlliance(): Alliance {
    return this.localRobot().alliance;
  }

  private makeWorld(): World {
    // multiplayer: everyone builds the identical world the host authored and
    // runs a SIM-DRIVEN countdown (transition lives in stepMatch, so it fires
    // on the same tick for every peer — no controller-local start/seed)
    const build = moduleFor(this.gameId).createWorld;
    if (this.session) {
      const w = build('match', this.session.seed, this.session.setups, this.settings);
      w.match.preCountdown = C.PRE_COUNTDOWN;
      return w;
    }
    const seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    const s = this.settings;
    const setups: RobotSetup[] = [
      {
        id: 0,
        alliance: s.alliance,
        spec: s.spec,
        assists: s.assists,
        startIndex: s.startIndex,
        startPose: s.startPose ?? undefined,
        autoPath: s.autoPath ?? undefined,
        autoPathEnabled: s.autoPathEnabled,
      },
    ];
    if (s.mode === 'free' && s.practiceDummies) {
      // three idle default robots as physical obstacles / parking practice
      const opp: Alliance = s.alliance === 'blue' ? 'red' : 'blue';
      const dummy = (id: number, alliance: Alliance, startIndex: number): RobotSetup => ({
        id,
        alliance,
        spec: { ...DEFAULT_SPEC, name: `Dummy ${id}`, teamName: 'Practice', teamNumber: 0 },
        // inert: aim assist OFF (no per-tick shot solve) + passive so the sim skips ALL
        // their action compute — they only ever exist to be bumped into.
        assists: { ...DEFAULT_ASSISTS, aimAssist: false, autoIntake: false, autoFire: false },
        startIndex,
        passive: true,
      });
      setups.push(
        // the partner dummy takes the OTHER preset so it never overlaps the player
        dummy(1, s.alliance, s.startIndex === 1 ? 0 : 1),
        dummy(2, opp, 0),
        dummy(3, opp, 1),
      );
    }
    return build(s.mode, seed, setups, this.settings);
  }

  private onResize = (): void => {
    this.renderer.camera.configure(this.canvas, this.viewAlliance(), this.mod.bounds);
  };

  private handlePhaseAudio(): void {
    const phase = this.world.match.phase;
    if (phase !== this.prevPhase) {
      if (phase === 'auto') this.audio.play('start');
      if (phase === 'transition') this.audio.play('end');
      if (phase === 'teleop' && this.prevPhase === 'transition') this.audio.play('resume');
      if (phase === 'post') {
        this.audio.play('end');
        // record the moment the match ended so the results screen can hold its
        // score reveal until the whoosh lands (both use MATCH_RESULT_REVEAL_MS)
        this.matchOverAt = performance.now();
        window.setTimeout(() => {
          if (!this.disposed && this.world.match.phase === 'post') this.audio.play('match_result');
        }, C.MATCH_RESULT_REVEAL_MS);
      }
      this.prevPhase = phase;
    }
    if (
      phase === 'teleop' &&
      !this.warningPlayed &&
      this.world.match.phaseTimeLeft <= C.ENDGAME_START
    ) {
      this.warningPlayed = true;
      this.audio.play('warning');
    }
    // announcer during the transition, like a real event:
    // "Drivers, pick up your controllers" ... "3, 2, 1" -> firebell
    if (phase === 'transition') {
      const left = this.world.match.phaseTimeLeft;
      if (left <= 6.5 && this.lastTransitionBeep === -1) {
        this.lastTransitionBeep = 4;
        this.audio.say('Drivers, pick up your controllers');
      }
      const n = Math.ceil(left);
      if (n <= 3 && n >= 1 && n < this.lastTransitionBeep) {
        this.lastTransitionBeep = n;
        this.audio.say(String(n), true); // interrupt: land exactly on the beat
      }
    } else {
      this.lastTransitionBeep = -1;
    }
  }

  /** align the SFX edge trackers with a freshly created world so world
   * creation/restart never plays a phantom shoot/intake/gate cue */
  private seedActionAudio(): void {
    this.prevFireAt = {};
    this.prevIntakeAt = {};
    for (const r of this.world.robots) {
      this.prevFireAt[r.id] = r.lastFireAt;
      this.prevIntakeAt[r.id] = r.lastIntakeAt;
    }
    this.prevGateOpen = {
      red: this.world.goals.red.gateOpen,
      blue: this.world.goals.blue.gateOpen,
    };
  }

  /** shoot / intake / gate effects, edge-detected from world state (the sim
   * core stays event-free for these — same pattern as handlePhaseAudio).
   * All robots share the small field, so everyone's actions are audible. */
  private handleActionAudio(): void {
    for (const r of this.world.robots) {
      if (r.lastFireAt !== this.prevFireAt[r.id]) {
        this.prevFireAt[r.id] = r.lastFireAt;
        this.audio.sfxShoot();
      }
      if (r.lastIntakeAt !== this.prevIntakeAt[r.id]) {
        this.prevIntakeAt[r.id] = r.lastIntakeAt;
        this.audio.sfxIntake();
      }
    }
    for (const a of ['red', 'blue'] as Alliance[]) {
      const open = this.world.goals[a].gateOpen;
      if (open && !this.prevGateOpen[a]) this.audio.sfxGate();
      this.prevGateOpen[a] = open;
    }
  }

  /** announcer: "Match begins in 3, 2, 1". Multiplayer mirrors the deterministic
   * sim countdown (world.match.preCountdown); solo runs off a keypress. */
  private updateCountdown(): number | null {
    if (this.world.match.phase !== 'pre') return null;

    // multiplayer: the sim owns the countdown + the pre→auto transition; the
    // controller only voices/announces it (audio is non-authoritative)
    if (this.session) {
      const left = this.world.match.preCountdown;
      if (left == null) return null;
      return this.voiceCountdown(left);
    }

    // solo: controller-driven, transitions the match itself
    if (this.countdownStart === null) return null;
    const remaining = C.PRE_COUNTDOWN - (this.world.time - this.countdownStart);
    if (remaining <= 0) {
      this.countdownStart = null;
      startMatch(this.world);
      return null;
    }
    return this.voiceCountdown(remaining);
  }

  /** shared: emit the spoken count on each new digit, return the HUD value */
  private voiceCountdown(remaining: number): number {
    const n = Math.ceil(remaining);
    if (n !== this.lastBeepAt) {
      this.lastBeepAt = n;
      // numbers interrupt any in-flight speech so the spoken count always
      // lands exactly on the visual digit
      if (n >= C.PRE_COUNTDOWN) this.audio.say('Match begins in');
      else this.audio.say(String(n), true);
    }
    return n; // > 3 means the "Match begins in" lead-in
  }

  /** can park mode be turned ON right now? Any time the robot can actually move —
   * auto, teleop, or free drive — so precision/slow-drive is available throughout
   * a match, not only in the endgame window. */
  private canPark(): boolean {
    return robotsEnabled(this.world);
  }

  /** everything a frame does EXCEPT render: sample input, step, audio, toasts */
  private frameLogic(dtMs: number): void {
    const cmd = this.input.poll();
    // "flip front": reverse robot-centric drive so the shooter side leads.
    // Meaningless in field-centric (translation is driver-frame there).
    if (!this.localRobot().fieldCentric) {
      if (this.input.flipPressed) this.frontFlipped = !this.frontFlipped;
      if (this.frontFlipped) {
        cmd.driveX = -cmd.driveX;
        cmd.driveY = -cmd.driveY;
      }
    }
    // park mode: toggle on press. Turning it ON is gated to when the robot can
    // drive (auto/teleop/free drive); turning it back OFF is always allowed. While
    // on, cap the drive command's magnitude to the configured percentage for
    // precision, low-speed control.
    if (this.input.parkPressed) {
      if (this.parked) this.parked = false;
      else if (this.canPark()) this.parked = true;
    }
    if (this.parked) {
      const k = Math.max(0, Math.min(100, this.settings.parkSpeedPct)) / 100;
      cmd.driveX *= k;
      cmd.driveY *= k;
      cmd.rotate *= k;
    }
    // Tank control style is a PER-DRIVER input preference (not a shared world
    // setting), so resolve it here: "Normal" tank derives side-drive from arcade
    // driveY/rotate, "Traditional" keeps the raw separate-stick leftDrive/rightDrive.
    // The sim's tank branch then always reads leftDrive/rightDrive, so the choice
    // works identically in solo and multiplayer (the server never sees these
    // settings). Runs after flip/park so both still apply in Normal tank.
    if (this.localRobot().spec.drivetrain === 'tank' && this.settings.tankControlMode === 'normal') {
      cmd.leftDrive = clamp(cmd.driveY - cmd.rotate, -1, 1);
      cmd.rightDrive = clamp(cmd.driveY + cmd.rotate, -1, 1);
    }
    this.lastCmd = cmd;

    this.acc += Math.min(dtMs / 1000, 0.25);
    if (this.session) this.stepServer(cmd);
    else this.stepSolo(cmd);

    this.hudCountdown = this.updateCountdown();
    this.handlePhaseAudio();
    this.handleActionAudio();

    // SOLO drains world.events directly; MULTIPLAYER drains netEvents (the de-duped
    // authoritative tail collected at reconcile), ignoring prediction/replay events.
    const drain = this.session ? this.netEvents : this.world.events;
    for (const e of drain) {
      this.toasts.push({ id: ++this.toastId, text: e, at: performance.now() });
    }
    this.toasts = this.toasts.filter((x) => performance.now() - x.at < 2500).slice(-5);
    drain.length = 0;
  }

  /** rAF loop: solo advances + renders here; multiplayer only RENDERS (the sim
   * is driven by simStep so it survives tab backgrounding — rAF pauses then) */
  private loop = (t: number): void => {
    if (this.disposed) return;
    const dtMs = this.lastT ? t - this.lastT : 16;
    this.lastT = t;
    if (!this.session) this.frameLogic(dtMs);
    // decay the local robot's error-smoothing offset toward 0 (frame-rate independent)
    const dtSec = Math.min(dtMs / 1000, 0.1);
    const k = Math.pow(2, -dtSec / SMOOTH_HALFLIFE);
    this.localSmooth.x *= k;
    this.localSmooth.y *= k;
    this.localSmooth.heading *= k;
    // solo renders the predicted world directly; the networked path renders remote
    // robots + balls INTERPOLATED (smooth) with the local robot predicted
    const world = this.session ? this.displayWorld(dtMs) : this.world;
    this.renderer.render(this.ctx, world, this.lastCmd, this.localRobotId);
    this.raf = requestAnimationFrame(this.loop);
  };

  /** multiplayer sim driver — a timer (not rAF) so a backgrounded tab keeps
   * stepping and feeding inputs to its peers instead of freezing the match */
  private simStep = (): void => {
    if (this.disposed) return;
    const now = performance.now();
    const dtMs = this.lastSimT ? now - this.lastSimT : 8;
    this.lastSimT = now;
    this.frameLogic(dtMs);
  };

  /** solo stepping: local keypress start/restart, one local command per tick */
  private stepSolo(cmd: RobotCommand): void {
    if (
      this.input.startPressed &&
      this.world.match.phase === 'pre' &&
      this.countdownStart === null
    ) {
      this.countdownStart = this.world.time;
      this.lastBeepAt = -1;
    }
    if (this.input.restartPressed) this.restart();

    let steps = 0;
    const commands = new Map<number, RobotCommand>([[this.localRobotId, cmd]]);
    while (this.acc >= C.SIM_DT && steps < C.MAX_STEPS_PER_FRAME) {
      this.mod.step(this.world, C.SIM_DT, commands);
      this.acc -= C.SIM_DT;
      steps++;
    }
    if (steps === C.MAX_STEPS_PER_FRAME) this.acc = 0;
  }

  /** server-authoritative stepping (predict + reconcile): every tick we apply
   * our OWN command locally for instant response and send it to the server; when
   * an authoritative snapshot arrives we snap the world to it and replay the
   * local inputs it hadn't folded in yet. A dropped/laggy peer never blocks us —
   * only our own robot is predicted, remote robots are corrected by snapshots. */
  private stepServer(cmd: RobotCommand): void {
    const s = this.session!;
    // NOTE: no IN-PLACE restart in multiplayer — a local or host-authored rebuild
    // desynced everyone (post-restart stuck/jitter). Players return to the lobby to
    // start a fresh match instead.
    // A record run is the exception: it is single-player, so the restart binding
    // asks the UI to tear the session down and open a NEW run (a fresh room). We
    // only forward the request — nothing here rebuilds `this.world`, which is what
    // made the drivetrain stick against a server still running the old match.
    if (this.input.restartPressed && this.restartRequestCb) {
      this.restartRequestCb();
      return; // the session is going away this frame; don't predict into it
    }

    // reconcile to the freshest server snapshot BEFORE predicting this frame
    const snap = s.takeSnapshot();
    if (snap) {
      this.bufferSnapshot(snap); // capture authoritative poses BEFORE reconcile mutates them
      this.remoteCmds = snap.cmds; // hold each robot's command to predict it forward
      this.reconcile(snap);
    }

    // SPECTATOR: no local robot to predict + nothing to send. Advance the world with the
    // authoritative per-robot commands so balls animate between snapshots; every robot is
    // then corrected each snapshot + interpolated for display (displayWorld). No inputBuf.
    if (this.spectator) {
      if (this.acc > 0.25) this.acc = 0.25;
      let n = 0;
      while (this.acc >= C.SIM_DT && n < 30) {
        if (this.gotSnapshot && this.world.tick - this.lastServerTick >= MAX_PREDICT_LEAD) {
          this.acc = 0;
          break;
        }
        this.mod.step(this.world, C.SIM_DT, new Map(this.remoteCmds));
        this.acc -= C.SIM_DT;
        n++;
      }
      return;
    }

    // predict a small amount ahead in real time (the local robot stays responsive;
    // the server accepts our slightly-late inputs by applying our latest command,
    // so we do NOT fast-forward the whole world — that flung the balls around)
    if (this.acc > 0.25) this.acc = 0.25;
    let steps = 0;
    while (this.acc >= C.SIM_DT && steps < 30) {
      // LEAD CAP: don't predict more than MAX_PREDICT_LEAD ticks past the newest
      // authoritative tick. During a snapshot stall this holds the local robot at
      // the lead edge instead of building an unbounded input buffer that reconcile
      // then replays in one giant hitch (the "everything flies on recovery" bug).
      // Drain the accumulator so we don't burst-catch-up when snapshots resume.
      if (this.gotSnapshot && this.world.tick - this.lastServerTick >= MAX_PREDICT_LEAD) {
        this.acc = 0;
        break;
      }
      const tick = this.world.tick + 1;
      const local = localizeCommand(cmd);
      s.sendInput(tick, cmd);
      this.inputBuf.push({ tick, cmd: local });
      this.mod.step(this.world, C.SIM_DT, this.cmdMap(local));
      this.acc -= C.SIM_DT;
      steps++;
    }
    // bound the buffer (only recent, unacked inputs ever matter)
    if (this.inputBuf.length > 600) this.inputBuf.splice(0, this.inputBuf.length - 600);
  }

  /** the command map to step: the local robot's live command + every remote
   * robot's held command (so remotes move + collide in the predicted world) */
  private cmdMap(local: RobotCommand): Map<number, RobotCommand> {
    const m = new Map(this.remoteCmds);
    m.set(this.localRobotId, local);
    return m;
  }

  /** record an authoritative snapshot's entity poses for interpolation. Copies the
   * poses (not the world) — the snapshot world is mutated by reconcile right after. */
  private bufferSnapshot(snap: Snapshot): void {
    const w = snap.world;
    this.snapBuf.push({
      tick: snap.serverTick,
      robots: w.robots.map((r) => ({ id: r.id, x: r.pos.x, y: r.pos.y, heading: r.heading })),
    });
    if (this.snapBuf.length > INTERP_BUFFER) this.snapBuf.shift();
  }

  /** the world to RENDER (networked path): the local robot stays predicted (+ eased
   * error offset) for responsiveness; remote robots + balls are INTERPOLATED between
   * the two authoritative snapshots bracketing the render clock — Minecraft-style, so
   * they glide smoothly regardless of the 30 Hz snapshot rate or network jitter. */
  private displayWorld(dtMs: number): World {
    const local = (r: RobotState): RobotState =>
      ({
        ...r,
        pos: { x: r.pos.x + this.localSmooth.x, y: r.pos.y + this.localSmooth.y },
        heading: r.heading + this.localSmooth.heading,
      });

    const buf = this.snapBuf;
    if (buf.length < 2) {
      // not enough history to interpolate yet — just apply local smoothing
      return { ...this.world, robots: this.world.robots.map((r) => (r.id === this.localRobotId ? local(r) : r)) };
    }

    // advance the interpolation clock at real-time rate, then gently pull it toward
    // (latest - delay) to absorb clock drift + snapshot jitter; clamp to the buffer
    const latest = buf[buf.length - 1].tick;
    const oldest = buf[0].tick;
    this.renderTick += Math.min(dtMs / 1000, 0.1) / C.SIM_DT;
    this.renderTick += (latest - INTERP_DELAY_TICKS - this.renderTick) * 0.1;
    this.renderTick = Math.max(oldest, Math.min(this.renderTick, latest));

    // find the pair of snapshots bracketing the render clock
    let s0 = buf[0];
    let s1 = buf[1];
    for (let i = buf.length - 2; i >= 0; i--) {
      if (buf[i].tick <= this.renderTick) {
        s0 = buf[i];
        s1 = buf[i + 1];
        break;
      }
    }
    const span = s1.tick - s0.tick;
    const a = span > 0 ? Math.max(0, Math.min(1, (this.renderTick - s0.tick) / span)) : 0;
    const r0 = new Map(s0.robots.map((r) => [r.id, r] as const));
    const r1 = new Map(s1.robots.map((r) => [r.id, r] as const));

    // ONLY remote robots interpolate. Balls are rendered straight from the predicted
    // sim: they're fast, spawn/despawn (launches), and collide — interpolating them
    // ghosts a freshly-spawned ball between its predicted and past positions and lerps
    // colliding balls THROUGH each other (the "blend"). Predicted balls stay accurate.
    const robots = this.world.robots.map((r) => {
      if (r.id === this.localRobotId) return local(r); // predicted, responsive
      const p = r0.get(r.id);
      const q = r1.get(r.id);
      if (!p || !q) return r; // just spawned/left the buffer — fall back to predicted
      return {
        ...r,
        pos: { x: lerp(p.x, q.x, a), y: lerp(p.y, q.y, a) },
        heading: lerpAngle(p.heading, q.heading, a),
      };
    });
    return { ...this.world, robots };
  }

  /** adopt the authoritative world, discard inputs it already reflects, and
   * re-predict forward by replaying the local inputs (and held remote commands)
   * past the snapshot tick */
  /** queue the authoritative NEW events from a reconciled snapshot (see `netEvents`).
   * The snapshot's `events` is the full monotonic server log; show only the tail past
   * what we've already surfaced. On the FIRST snapshot we adopt the history silently
   * (a mid-match joiner/spectator shouldn't get a burst of past phase banners), and a
   * shrink means a fresh match/server → resync from zero. */
  private collectNetEvents(first: boolean): void {
    const evs = this.world.events;
    if (evs.length < this.shownEventCount) this.shownEventCount = 0;
    if (first) {
      this.shownEventCount = evs.length;
      return;
    }
    for (let i = this.shownEventCount; i < evs.length; i++) this.netEvents.push(evs[i]);
    this.shownEventCount = evs.length;
  }

  private reconcile(snap: Snapshot): void {
    const firstSnap = !this.gotSnapshot;
    // VISUAL error smoothing (rubberbanding fix): capture where the LOCAL robot is
    // currently rendered (predicted pos + the decaying offset). After we snap to
    // the authoritative world below, we set `localSmooth` so the RENDERED position
    // stays continuous, then it eases to the real position over ~1 decay in the
    // render loop — so a late/uneven snapshot glides instead of teleporting. Purely
    // cosmetic: it never touches `this.world`, so determinism/anti-cheat are intact.
    const pre = this.world.robots.find((r) => r.id === this.localRobotId);
    const preX = pre ? pre.pos.x + this.localSmooth.x : 0;
    const preY = pre ? pre.pos.y + this.localSmooth.y : 0;
    const preH = pre ? pre.heading + this.localSmooth.heading : 0;

    this.world = snap.world;
    this.collectNetEvents(firstSnap); // authoritative events, BEFORE replay re-emits any
    this.lastServerTick = snap.serverTick;
    this.gotSnapshot = true;
    this.inputBuf = this.inputBuf.filter((b) => b.tick > snap.serverTick);
    // Defensive replay bound: with the lead cap the buffer stays small, but never
    // replay more than MAX_PREDICT_LEAD ticks synchronously (a stale/duplicate old
    // snapshot must not stall the frame). Older inputs are already reflected.
    if (this.inputBuf.length > MAX_PREDICT_LEAD) {
      this.inputBuf.splice(0, this.inputBuf.length - MAX_PREDICT_LEAD);
    }
    for (const b of this.inputBuf) {
      this.mod.step(this.world, C.SIM_DT, this.cmdMap(b.cmd));
    }

    const post = this.world.robots.find((r) => r.id === this.localRobotId);
    if (pre && post) {
      let dx = preX - post.pos.x;
      let dy = preY - post.pos.y;
      let dh = Math.atan2(Math.sin(preH - post.heading), Math.cos(preH - post.heading));
      // a genuinely large correction (desync/teleport) should SNAP, not float far
      // behind for a beat — only smooth sub-robot-scale errors
      if (Math.hypot(dx, dy) > SMOOTH_MAX_DIST) {
        dx = 0;
        dy = 0;
        dh = 0;
      }
      this.localSmooth = { x: dx, y: dy, heading: dh };
    }
  }

  /** host-authored restart arrived over the net: rebuild from the new seed */
  private rebuildFromNet(): void {
    this.audio.stopSpeech();
    this.world = this.makeWorld();
    this.prevPhase = this.world.match.phase;
    this.warningPlayed = false;
    this.matchOverAt = null;
    this.countdownStart = null;
    this.hudCountdown = null;
    this.frontFlipped = false;
    this.parked = false;
    this.acc = 0;
    this.inputBuf = [];
    this.remoteCmds = new Map();
    this.lastServerTick = 0;
    this.gotSnapshot = false;
    this.shownEventCount = 0;
    this.netEvents = [];
    this.snapBuf = [];
    this.renderTick = 0;
    this.localSmooth = { x: 0, y: 0, heading: 0 };
    this.seedActionAudio();
    this.toasts = [];
  }

  /** RECORD runs: route the restart binding to a full new run. Passing null (the
   * default) leaves it inert, so a versus match can't reach it. */
  setRestartRequest(cb: (() => void) | null): void {
    this.restartRequestCb = cb;
  }

  /** trigger the pre-match countdown (e.g. from a UI button) */
  startMatch(): void {
    if (this.world.match.phase === 'pre' && this.countdownStart === null) {
      this.countdownStart = this.world.time;
      this.lastBeepAt = -1;
    }
  }

  /** restart with the same settings (new random seed / motif) */
  restart(): void {
    this.audio.stopSpeech();
    if (this.world.match.phase === 'auto' || this.world.match.phase === 'teleop') {
      this.audio.play('abort');
    }
    this.world = this.makeWorld();
    this.prevPhase = this.world.match.phase;
    this.warningPlayed = false;
    this.matchOverAt = null;
    this.countdownStart = null;
    this.hudCountdown = null;
    this.frontFlipped = false;
    this.parked = false;
    this.seedActionAudio();
    this.toasts = [];
  }

  /** REMATCH: SOLO only — rebuild locally with a fresh seed/motif. Multiplayer has
   * no rematch (it re-authored the match for everyone and desynced on rebuild);
   * networked players return to the lobby to queue a fresh match. */
  rematch(): void {
    if (this.session) return; // multiplayer: no-op (UI hides the button)
    this.restart();
  }

  /** multiplayer session? (UI gates RESET / host-only REMATCH on this) */
  isNetworked(): boolean {
    return this.session !== null;
  }

  /** the server's authoritative end-of-match result (score + recorded replay),
   * or null in solo / before phase 'post' */
  getMatchResult(): MatchResultInfo | null {
    return this.session?.getMatchResult() ?? null;
  }

  /** a record run's leaderboard standing (PB / WR / rank), or null until the
   * server's recordResult lands (record runs only) */
  getRecordResult(): RecordRankInfo | null {
    return this.session?.getRecordResult?.() ?? null;
  }

  /** ranked pre-match intro roster (name/team/drivetrain + ELO per driver), or
   * null for solo / free drive / non-ranked custom rooms. Drives the RankedIntro
   * overlay. Static after matchStart, so the UI reads it once. */
  getIntro(): IntroPlayer[] | null {
    const s = this.session;
    if (!s || !s.ranked) return null;
    return s.setups.map((su) => ({
      robotId: su.id,
      name: su.spec.name,
      teamName: su.spec.teamName,
      teamNumber: su.spec.teamNumber,
      drivetrain: su.spec.drivetrain,
      alliance: su.alliance,
      elo: s.intros.find((it) => it.id === su.id)?.elo ?? null,
      isLocal: su.id === this.localRobotId,
    }));
  }

  /** ranked results-screen ELO changes (before → after per driver), or null until
   * the server's `eloResult` lands after the match is scored. Sorted red-then-blue
   * to match the intro/results layout. */
  getEloResults(): EloResultRow[] | null {
    const s = this.session;
    if (!s || !s.ranked || s.eloResults.length === 0) return null;
    const rows = s.eloResults.map((d) => {
      const su = s.setups.find((x) => x.id === d.robotId);
      return {
        robotId: d.robotId,
        name: su?.spec.name ?? 'Driver',
        alliance: su?.alliance ?? ('red' as Alliance),
        before: d.before,
        after: d.after,
        isLocal: d.robotId === this.localRobotId,
        provisional: d.games < C.PLACEMENT_GAMES, // still in placements (games-based)
      };
    });
    return rows.sort((a, b) => (a.alliance === b.alliance ? 0 : a.alliance === 'red' ? -1 : 1));
  }

  getHud(): HudSnapshot {
    const w = this.world;
    const r = this.localRobot();
    const a = this.viewAlliance();
    const opp: Alliance = a === 'blue' ? 'red' : 'blue';
    const goal = w.goals[a];
    // Chain Reaction scoring readout (present only for CR worlds)
    const chain: HudSnapshot['chain'] = w.chain
      ? {
          scored: w.chain.scored[a],
          oppScored: w.chain.scored[opp],
          mult: chainAccelMultiplier(w.chain, a),
          oppMult: chainAccelMultiplier(w.chain, opp),
          catalysts: w.chain.catalysts.filter((c) => c.hook?.alliance === a).length,
          oppCatalysts: w.chain.catalysts.filter((c) => c.hook?.alliance === opp).length,
          particlePts: w.chain.particlePoints[a],
          oppParticlePts: w.chain.particlePoints[opp],
          endgame: w.chain.endgame[this.localRobotId] ?? 'none',
          carrying: w.chain.catalysts.some((c) => c.carriedBy === this.localRobotId),
          ringAction: chainCatalystPrompt(w.chain, r)?.action ?? null,
          storage: chainHopperCap(r.spec),
          mode: r.spec.scoreMode ?? 'turret',
          foulPts: w.match.scores[a].foulPoints,
          oppFoulPts: w.match.scores[opp].foulPoints,
        }
      : undefined;
    return {
      game: w.game ?? 'decode',
      chain,
      mode: w.mode,
      phase: w.match.phase,
      timeLeft: Math.max(0, w.match.phaseTimeLeft),
      alliance: a,
      motif: w.motif,
      score: w.match.scores[a],
      oppTotal: w.match.scores[opp].total,
      oppScore: w.match.scores[opp],
      provisionalPattern: w.match.provisionalPattern[a],
      fouls: { red: { ...w.match.fouls.red }, blue: { ...w.match.fouls.blue } },
      fieldCentric: r.fieldCentric,
      aimAssist: r.aimAssist,
      autoIntake: r.autoIntake,
      autoFire: r.autoFire,
      hopper: [...r.hopper],
      powerDraw: r.powerDraw,
      inLaunchZone: w.mode === 'free' || robotInLaunchZone(r),
      gamepadConnected: this.input.gamepadConnected,
      frontFlipped: this.frontFlipped,
      parked: this.parked,
      canPark: this.canPark(),
      gateOpen: goal.gateOpen,
      rampCount: w.balls.filter(
        (b) => b.state.kind === 'rail' && b.state.goal === a && !b.state.overflow,
      ).length,
      classifiedCount: goal.classifiedCount,
      overflowCount: goal.overflowCount,
      countdown: this.hudCountdown,
      resultRevealAt:
        w.match.phase === 'post' && this.matchOverAt !== null
          ? this.matchOverAt + C.MATCH_RESULT_REVEAL_MS
          : null,
      toasts: [...this.toasts],
      net: this.session ? this.session.status() : null,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.audio.stopSpeech();
    this.audio.stopKeepAlive();
    cancelAnimationFrame(this.raf);
    if (this.simTimer) window.clearInterval(this.simTimer);
    this.input.detach();
    window.removeEventListener('resize', this.onResize);
  }
}