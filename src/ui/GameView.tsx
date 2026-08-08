import { Fragment, useEffect, useRef, useState } from 'react';
import {
  GameController,
  type GameSettings,
  type HudSnapshot,
  type IntroPlayer,
  type EloResultRow,
} from '../game';
import { keyLabel, padButtonLabel } from '../input/bindings';
import { appChannel } from '../net/env';
import { ENDGAME_START, PTS_FOUL_MINOR, PTS_FOUL_MAJOR, POWER_DRAW_MAX } from '../config';
import { MobileControls } from './MobileControls';
import { AdSlot, ResultsAd, useAdUnitActive } from './AdSlot';
import { DEFAULT_MOBILE_LAYOUT } from '../settings';
import type { MatchResultInfo, NetSession, NetStatus } from '../net/session';
import { clearActiveGame } from '../net/activeGame';
import { RankBadge } from './RankBadge';
import { ReportDialog } from './ReportDialog';
import { standingFor, tierChange } from '../ranks';
import type { RecordRankInfo } from '../net/protocol';
import type { Replay } from '../sim/replay';
import { CHAIN_MODE_LABELS } from '../games/chain/labels';
import type { Alliance, DrivetrainType, ScoreBreakdown } from '../types';

/** top-right connection-quality readout (multiplayer only): a coloured signal dot
 * + live RTT / snapshot-rate / jitter, so a laggy player can see AT A GLANCE whether
 * it's their link (high ping/jitter) or the game. Colour tracks `net.quality`; the
 * tooltip spells the three numbers out. */
function NetQuality({ net, open, onToggle }: { net: NetStatus; open: boolean; onToggle: () => void }) {
  const q = net.quality; // 'good' | 'fair' | 'poor' | null (measuring)
  const cls = q === 'good' ? 'on' : q === 'fair' ? 'warn' : q === 'poor' ? 'off' : '';
  const dot = q === 'good' ? '#3ad17a' : q === 'fair' ? '#e5b567' : q === 'poor' ? '#e5636b' : '#93a1ad';
  const label =
    q === 'good' ? 'SMOOTH' : q === 'fair' ? 'OK' : q === 'poor' ? 'CHOPPY' : 'MEASURING';
  const ping = net.rttMs === null ? '-' : `${net.rttMs}ms`;
  const hz = net.snapHz === null ? '-' : `${net.snapHz}Hz`;
  const jit = net.jitterMs === null ? '-' : `±${net.jitterMs}ms`;
  const title =
    `Connection: ${label.toLowerCase()}\n` +
    `Round-trip ping: ${ping} (you ↔ server)\n` +
    `Server updates: ${hz} (target 30)\n` +
    `Jitter: ${jit} (unevenness - the main cause of choppiness)\n` +
    `Click to ${open ? 'hide' : 'show'} the ping graph`;
  return (
    <span
      className={`chip net-quality clickable ${cls} ${open ? 'active' : ''}`}
      title={title}
      onClick={onToggle}
      role="button"
    >
      <span className="net-dot" style={{ background: dot, boxShadow: `0 0 6px ${dot}` }} />
      {ping} · {hz} · {jit} <span className="net-caret">📈</span>
    </span>
  );
}

/** expandable ping GRAPH — a sparkline of the RAW round-trip samples so spikes the
 * smoothed number hides are visible. min/avg/max + a spike count over the window. */
function PingGraph({ net }: { net: NetStatus }) {
  const data = net.rttHistory ?? [];
  const W = 240;
  const H = 64;
  if (data.length < 2) {
    return (
      <div className="ping-graph">
        <div className="ping-graph-empty">measuring ping…</div>
      </div>
    );
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const avg = data.reduce((a, b) => a + b, 0) / data.length;
  // a "spike" = a sample well above the running average (jitter, not steady latency)
  const spikeThresh = Math.max(avg * 1.8, avg + 40);
  const spikes = data.filter((v) => v > spikeThresh).length;
  // scale to the graph box (pad the top so the peak isn't clipped)
  const top = Math.max(max * 1.1, 20);
  const x = (i: number): number => (i / (data.length - 1)) * W;
  const y = (v: number): number => H - (v / top) * H;
  const pts = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const avgY = y(avg);
  const spikeColor = spikes > 0 ? '#e5636b' : '#3ad17a';
  return (
    <div className="ping-graph">
      <div className="ping-graph-head">
        <span>PING (ms)</span>
        <span className="ping-graph-stats">
          <span>min {Math.round(min)}</span>
          <span>avg {Math.round(avg)}</span>
          <span>max {Math.round(max)}</span>
          <span style={{ color: spikeColor }}>spikes {spikes}</span>
        </span>
      </div>
      <svg
        className="ping-graph-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        width={W}
        height={H}
      >
        <line x1="0" y1={avgY} x2={W} y2={avgY} className="ping-graph-avg" />
        <polyline points={pts} className="ping-graph-line" />
      </svg>
      <div className="ping-graph-foot">
        last {data.length} samples · newest → right
      </div>
    </div>
  );
}

/** top-right drive power-draw gauge: how much current the flywheel spin-up + intake
 * are pulling off the drive motors right now (0 → POWER_DRAW_MAX). The bar fills
 * toward the cap and shifts green→amber→red; the number is the actual % the drive is
 * slowed at that instant. */
function PowerGauge({ draw }: { draw: number }) {
  const frac = Math.max(0, Math.min(1, draw / POWER_DRAW_MAX)); // 0..1 of the cap
  const pct = Math.round(draw * 100); // actual drive slowdown right now
  const cls = frac > 0.75 ? 'hot' : frac > 0.4 ? 'warm' : '';
  return (
    <span
      className="power-gauge"
      title={`Drive power draw - flywheel spin-up + intake pulling current off the drive motors (${pct}% slower right now)`}
    >
      <span className="pg-label">PWR</span>
      <span className="pg-bar">
        <span className={`pg-fill ${cls}`} style={{ width: `${frac * 100}%` }} />
      </span>
      <span className="pg-num">{pct}%</span>
    </span>
  );
}

const DT_LABEL: Record<DrivetrainType, string> = {
  mecanum: 'Mecanum',
  tank: 'Tank',
  swerve: 'Swerve',
  xdrive: 'X-Drive',
  butterfly: 'Butterfly',
};

/** count an integer from `from` to `target` over `duration` ms once `active` flips
 * true (ease-out cubic). Used for the results score reveal (from 0) and the ELO
 * change (from the old rating, so the delta ticks in). */
function useCountUp(target: number, active: boolean, duration = 900, from = 0): number {
  const [val, setVal] = useState(from);
  useEffect(() => {
    if (!active) {
      setVal(from);
      return;
    }
    let raf = 0;
    let t0 = 0;
    const tick = (t: number): void => {
      if (!t0) t0 = t;
      const p = Math.min(1, (t - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(Math.round(from + (target - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, active, duration, from]);
  return active ? val : from;
}

interface Props {
  settings: GameSettings;
  onExit: () => void;
  /** null in solo; a live lockstep session in multiplayer */
  session?: NetSession | null;
  /** watch the just-played run's replay (server matches only) */
  onWatchReplay?: (replay: Replay) => void;
  /** whether the player is signed in — drives the record results "sign in to
   * save & rank" prompt vs the live PB / WR / rank line */
  signedIn?: boolean;
  /** persist a settings change from in-game (currently: the mobile control layout) */
  onSettingsChange?: (s: GameSettings) => void;
  /** start in mobile-control-layout EDIT mode (launched from the Controls menu) */
  editLayout?: boolean;
  /** solo RECORD runs only: abandon this run and start a fresh one. Tears the
   * session down and re-enters the record flow rather than rebuilding the world
   * in place — an in-place reset desyncs against a server that is still running
   * the old match (that is what made the drivetrain stick/jitter before). */
  onRestartRun?: () => void;
  /** CO-OP (duo record): restarting is a mutual vote rather than one driver's
   *  decision. Drives the rematch control and the R binding's behaviour. */
  coop?: boolean;
}

export function GameView({
  settings,
  onExit,
  session = null,
  onWatchReplay,
  signedIn = false,
  onSettingsChange,
  editLayout = false,
  onRestartRun,
  coop = false,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<GameController | null>(null);
  const [hud, setHud] = useState<HudSnapshot | null>(null);
  const [intro, setIntro] = useState<IntroPlayer[] | null>(null);
  const [editingLayout, setEditingLayout] = useState(editLayout);
  // gates the flanking ad columns. When false the <aside>s are not rendered at all
  // (not merely empty), so an unconfigured or supporter build leaves the field
  // exactly where it was. GameController watches the canvas with a ResizeObserver,
  // so the camera re-fits the moment this flips.
  const ads = useAdUnitActive('game');
  // `?perf=1` — a frame-time readout, off by default and never chrome a player
  // sees by accident. It is how the in-game ad columns get signed off: measure
  // p95 with them off, then on. Read ONCE (not per render) since a query string
  // cannot change without a reload.
  const [perf] = useState(
    () => typeof location !== 'undefined' && new URLSearchParams(location.search).has('perf'),
  );
  const [frames, setFrames] = useState<{ p50: number; p95: number; fps: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const controller = new GameController(canvas, settings, session);
    controllerRef.current = controller;
    setIntro(controller.getIntro()); // ranked matches only; null otherwise
    const hudTimer = window.setInterval(() => setHud(controller.getHud()), 100);
    const onKey = (e: KeyboardEvent) => {
      // Escape is reserved (never rebindable); restart is handled by the
      // InputManager through the user's bindings
      if (e.key === 'Escape') onExit();
    };
    window.addEventListener('keydown', onKey);
    // once a networked match is DECIDED (phase 'post') or its slot is gone (failed),
    // there's nothing to rejoin — forget the saved active-game record so Home stops
    // offering "rejoin your match" for a finished/dead game.
    const clearTimer = window.setInterval(() => {
      if (!session) return;
      const h = controller.getHud();
      if (h && (h.phase === 'post' || h.net?.failed)) clearActiveGame();
    }, 250);
    // sampled at 2 Hz, and ONLY when the flag is on — a per-frame React state
    // update to display a frame-time number would itself be the slowest thing on
    // the page, which is a memorably useless way to measure performance.
    const perfTimer = perf
      ? window.setInterval(() => setFrames(controller.getFrameStats()), 500)
      : 0;
    return () => {
      window.clearInterval(hudTimer);
      window.clearInterval(clearTimer);
      if (perfTimer) window.clearInterval(perfTimer);
      window.removeEventListener('keydown', onKey);
      // Check ONCE MORE on the way out. The poll above runs every 250ms, so leaving
      // promptly after the final buzzer could beat it — and the cost of losing that race
      // is Home still offering to rejoin a match that has already been decided.
      if (session) {
        const h = controller.getHud();
        if (h && (h.phase === 'post' || h.net?.failed)) clearActiveGame();
      }
      controller.dispose();
      controllerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the restart binding pointed at the CURRENT callback. The controller is
  // built in a mount-only effect, so registering it there would capture a stale
  // closure; this re-registers whenever the prop changes and clears it (null) when
  // the screen isn't a record run, leaving the binding inert in a versus match.
  useEffect(() => {
    controllerRef.current?.setRestartRequest(onRestartRun ?? null);
    controllerRef.current?.setCoop(coop);
  }, [onRestartRun, coop]);

  // MOBILE zoom/select guard: iOS Safari ignores `user-scalable=no`, so a two-finger
  // pinch still zooms and a two-finger touch can pop the text-selection callout. Kill
  // the iOS `gesture*` events and any multi-touch default while the game is up, plus
  // the double-tap zoom. (touch-action:none on .game-root covers scroll-zoom.)
  useEffect(() => {
    const prevent = (e: Event): void => e.preventDefault();
    let lastTouchEnd = 0;
    const onTouchEnd = (e: TouchEvent): void => {
      const now = Date.now();
      if (now - lastTouchEnd <= 300) e.preventDefault(); // double-tap zoom
      lastTouchEnd = now;
    };
    // passive:false is required for preventDefault to take effect
    document.addEventListener('gesturestart', prevent, { passive: false });
    document.addEventListener('gesturechange', prevent, { passive: false });
    document.addEventListener('gestureend', prevent, { passive: false });
    document.addEventListener('touchend', onTouchEnd, { passive: false });
    return () => {
      document.removeEventListener('gesturestart', prevent);
      document.removeEventListener('gesturechange', prevent);
      document.removeEventListener('gestureend', prevent);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  return (
    /* `.game-shell` is a flex row: ad column | field | ad column. `.game-root` stays
       the stage and the containing block for every absolutely-positioned overlay
       (.hud is inset:0, .scorebar is left:50%, .status-wrap is right:12px) — if the
       ads were siblings of those instead, the scorebar would centre on the window
       rather than the field and the status chips would land on the right-hand ad.

       The columns cost the field NOTHING. `camera.ts` fits with
       `min(w / spanW, usableH / spanH)` and DECODE's field is square, so on any
       landscape desktop the HEIGHT term binds and the horizontal slack is already
       going unused. The CSS gate below only reveals the columns at widths where
       that still holds — see the media query in styles.css. */
    <div className="game-shell">
      {/* NOT aria-hidden. It was, and that hid the "Advertisement" label along
          with the unit — the label exists precisely so an ad is distinguishable
          from content, and hiding it from the one group that cannot see the
          visual difference defeats it. `aria-label` names the region instead, so
          a screen-reader user can skip past it knowingly. */}
      {ads && (
        <aside className="game-ad" aria-label="Advertisement">
          <AdSlot unit="game" />
        </aside>
      )}
      <div className="game-root">
      {perf && frames && (
        <div className="perf-readout" role="status">
          {frames.fps.toFixed(0)} fps · p50 {frames.p50.toFixed(1)}ms · p95{' '}
          {frames.p95.toFixed(1)}ms · ads {ads ? 'ON' : 'off'}
        </div>
      )}
      {/* A screen-reader-playable driving sim is out of scope (see the Phase 6 audit,
          F7). The label at least stops this being an unlabelled interactive region;
          score/timer/gate state is announced by the live regions below. */}
      <canvas
        ref={canvasRef}
        className="game-canvas"
        role="img"
        aria-label={`${hud?.game === 'chain' ? 'Chain Reaction' : 'DECODE'} field, top-down view. Match state is announced in the event log.`}
      />
      {window.matchMedia('(pointer: coarse)').matches && controllerRef.current && (
        <MobileControls
          inputManager={controllerRef.current.getInputManager()}
          game={hud?.game}
          layout={settings.mobileLayout}
          editing={editingLayout}
          onLayoutChange={(l) => onSettingsChange?.({ ...settings, mobileLayout: l })}
        />
      )}
      {editingLayout && (
        <div className="mobile-edit-bar">
          <span className="meb-hint">Drag the sticks &amp; buttons to reposition</span>
          <button onClick={() => onSettingsChange?.({ ...settings, mobileLayout: DEFAULT_MOBILE_LAYOUT })}>
            Reset
          </button>
          <button className="primary" onClick={() => setEditingLayout(false)}>
            Done
          </button>
        </div>
      )}
      {hud?.net && (hud.net.failed || hud.net.waitingFor === 'server') && (
        <div className="net-overlay">
          <div className="net-overlay-card">
            {hud.net.failed ? (
              <>
                <h3>Connection lost</h3>
                <p>The server may have restarted. Refresh the page to reconnect.</p>
                <div className="overlay-buttons">
                  <button onClick={() => window.location.reload()}>REFRESH</button>
                  <button onClick={onExit}>MENU</button>
                </div>
              </>
            ) : (
              <>
                <div className="net-spinner" />
                <h3>Reconnecting…</h3>
                <p>Restoring your connection - your run keeps going.</p>
              </>
            )}
          </div>
        </div>
      )}
      {hud && <Hud hud={hud} showEventLog={settings.showEventLog} />}
      <div className="game-buttons">
        <button className="game-btn" onClick={onExit} title="Menu (Esc)">
          ◄ MENU
        </button>
        {/* RESET is a LOCAL rebuild — meaningless (and desyncing) in lockstep, so
            solo only. In multiplayer use REMATCH on the results screen (host). */}
        {!session && (
          <button
            className="game-btn"
            onClick={() => controllerRef.current?.restart()}
            title="Restart"
          >
            ⟲ RESET
          </button>
        )}
        {/* CO-OP (duo record): restarting is a VOTE — the run belongs to both
            drivers, so neither can pull it out from under the other. Available
            MID-MATCH as well as on the results screen, and the R binding does
            exactly this. */}
        {session && hud?.rematch && hud.rematch.need > 1 && (
          <button
            className={`game-btn${hud.rematch.mine ? ' on' : ''}`}
            onClick={() => controllerRef.current?.toggleRematch()}
            title={
              hud.rematch.mine
                ? 'You want a rematch — press again to take it back'
                : 'Vote to restart this run (both drivers must agree)'
            }
          >
            ⟲ REMATCH {hud.rematch.votes}/{hud.rematch.need}
          </button>
        )}
        {/* a SOLO record run is server-hosted, so RESET's local rebuild is unsafe
            here; this starts a whole fresh run instead (new room, new seed). */}
        {session && onRestartRun && !hud?.rematch?.need && (
          <button className="game-btn" onClick={onRestartRun} title="Start a new run">
            ⟲ NEW RUN
          </button>
        )}
      </div>
      {hud?.phase === 'pre' && hud.countdown === null && !session && (
        <div className="overlay">
          <div className="overlay-panel">
            <h2>{hud.alliance.toUpperCase()} ALLIANCE</h2>
            {hud.game === 'decode' && (
              <p>
                MOTIF{' '}
                {hud.motif.map((c, i) => (
                  <span key={i} className={`motif-dot ${c}`} />
                ))}
              </p>
            )}
            {!window.matchMedia('(pointer: coarse)').matches && (
              <p className="big">
                Press {keyLabel(settings.bindings.keys.start[0] ?? 'enter')} or{' '}
                {padButtonLabel(settings.bindings.pad.buttons.start[0] ?? 9)} to start
              </p>
            )}
            {window.matchMedia('(pointer: coarse)').matches && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'center' }}>
                <button
                  className="ds-cta"
                  onClick={() => controllerRef.current?.startMatch()}
                >
                  START MATCH
                </button>
                <button
                  className="ds-cta ghost"
                  onClick={onExit}
                >
                  BACK TO MENU
                </button>
              </div>
            )}
            <p className="ds-hint">
              Esc · menu &nbsp;·&nbsp; {keyLabel(settings.bindings.keys.restart[0] ?? '?')} · restart
            </p>
          </div>
        </div>
      )}
      {intro && hud?.phase === 'pre' && (
        <RankedIntro players={intro} viewAlliance={hud.alliance} />
      )}
      {hud?.phase === 'pre' && hud.countdown !== null && (
        <div
          className={hud.countdown > 3 ? 'countdown-text' : 'countdown-num'}
          key={hud.countdown}
        >
          {hud.countdown > 3 ? 'MATCH BEGINS IN' : hud.countdown}
        </div>
      )}
      {hud?.phase === 'post' && (
        <Results
          hud={hud}
          revealAt={hud.resultRevealAt}
          ranked={!!session?.ranked}
          eloResults={controllerRef.current?.getEloResults() ?? null}
          canRematch={!session}
          onRematch={() => controllerRef.current?.rematch()}
          coopRematch={hud.rematch && hud.rematch.need > 1 ? hud.rematch : null}
          onCoopRematch={() => controllerRef.current?.toggleRematch()}
          onExit={onExit}
          /* every OTHER driver in this match, by robot id + the name they played under.
             Built from the session's own roster, so it is exactly the set the server will
             accept a report for. */
          reportable={
            session && signedIn
              ? session.setups
                  .filter((su) => su.id !== session.localRobotId)
                  .map((su) => ({ robotId: su.id, name: su.spec.name || `Driver ${su.id}` }))
              : []
          }
          onReport={
            session?.sendReport
              ? (rid, reason, detail) => session.sendReport?.(rid, reason, detail)
              : undefined
          }
          matchResult={controllerRef.current?.getMatchResult() ?? null}
          recordResult={controllerRef.current?.getRecordResult() ?? null}
          signedIn={signedIn}
          onWatchReplay={onWatchReplay}
        />
      )}
      </div>
      {/* NOT aria-hidden. It was, and that hid the "Advertisement" label along
          with the unit — the label exists precisely so an ad is distinguishable
          from content, and hiding it from the one group that cannot see the
          visual difference defeats it. `aria-label` names the region instead, so
          a screen-reader user can skip past it knowingly. */}
      {ads && (
        <aside className="game-ad" aria-label="Advertisement">
          <AdSlot unit="game" />
        </aside>
      )}
    </div>
  );
}

function fmtTime(s: number): string {
  const total = Math.max(0, Math.ceil(s));
  const m = Math.floor(total / 60);
  return `${m}:${String(total % 60).padStart(2, '0')}`;
}

const PHASE_LABEL: Record<string, string> = {
  pre: 'PRE-MATCH',
  auto: 'AUTONOMOUS',
  transition: 'TRANSITION',
  teleop: 'DRIVER-CONTROLLED',
  post: 'FINAL',
  freeplay: 'FREE DRIVE',
};

/** styled after the FTC live scoring audience display: red panel | timer | blue panel */
function Hud({ hud, showEventLog }: { hud: HudSnapshot; showEventLog: boolean }) {
  const [pingGraph, setPingGraph] = useState(false);
  const urgent = hud.timeLeft <= 10 && (hud.phase === 'auto' || hud.phase === 'teleop');
  const endgame = hud.timeLeft <= ENDGAME_START && hud.phase === 'teleop';
  const redScore = hud.alliance === 'red' ? hud.score.total : hud.oppTotal;
  const blueScore = hud.alliance === 'blue' ? hud.score.total : hud.oppTotal;
  // Chain Reaction is scored (its own breakdown); DECODE shows motif + its breakdown.
  const cr = hud.game === 'chain';

  return (
    <div className="hud">
      {hud.mode === 'match' ? (
        <div className="scorebar">
          <div className={`score-panel red ${hud.alliance === 'red' ? 'mine' : ''}`}>
            {hud.alliance === 'red' && <span className="you-tag">YOU</span>}
            <span className="panel-score">{redScore}</span>
          </div>
          <div className={`timer-panel ${urgent ? 'urgent' : endgame ? 'warning' : ''}`}>
            {/* status on the PHASE only — the digits beside it retick every frame and
                would flood a screen reader. This changes ~4 times a match. */}
            <span className="timer-phase" role="status">
              {endgame ? 'END GAME' : PHASE_LABEL[hud.phase]}
            </span>
            <span className="timer-time">
              {hud.phase === 'post' ? '0:00' : fmtTime(hud.timeLeft)}
            </span>
            {!cr && (
              <span className="timer-motif">
                {hud.motif.map((c, i) => (
                  <span key={i} className={`motif-dot ${c}`} />
                ))}
              </span>
            )}
          </div>
          <div className={`score-panel blue ${hud.alliance === 'blue' ? 'mine' : ''}`}>
            {hud.alliance === 'blue' && <span className="you-tag">YOU</span>}
            <span className="panel-score">{blueScore}</span>
          </div>
        </div>
      ) : (
        <div className="scorebar">
          <div className="timer-panel">
            <span className="timer-phase">FREE DRIVE</span>
            {!cr && (
              <span className="timer-motif">
                {hud.motif.map((c, i) => (
                  <span key={i} className={`motif-dot ${c}`} />
                ))}
              </span>
            )}
          </div>
        </div>
      )}

      {hud.mode === 'match' && !cr && (
        <div className="breakdown-row">
          {/* artifact COUNTS, not points (points live in the score panels).
              PATTERN shows only BANKED points — it is assessed solely at the
              end of AUTO and the end of the match, never live. */}
          <span>CLASSIFIED {hud.classifiedCount}</span>
          <span>OVERFLOW {hud.overflowCount}</span>
          <span>
            PATTERN{' '}
            {hud.score.autoPattern + (hud.phase === 'post' ? hud.score.telePattern : 0)} PTS
          </span>
          <span>RAMP {hud.rampCount}/9</span>
        </div>
      )}

      {hud.mode === 'match' && cr && hud.chain && (
        <div className="breakdown-row">
          <span>PARTICLES {hud.chain.scored}</span>
          <span>MULT ×{hud.chain.mult}</span>
          <span>CATALYSTS {hud.chain.catalysts}/4</span>
          {hud.chain.endgame !== 'none' && (
            <span>{hud.chain.endgame === 'ascended' ? 'ASCENDED' : 'PARKED'}</span>
          )}
        </div>
      )}

      {(!window.matchMedia('(pointer: coarse)').matches) && (
        <div className="status-wrap">
          <div className="robot-status">
            {!cr && (
              <>
                <div className="hopper">
                  {[0, 1, 2].map((i) => (
                    <span key={i} className={`hopper-pip ${hud.hopper[i] ?? 'empty'}`} />
                  ))}
                </div>
                <PowerGauge draw={hud.powerDraw} />
                {hud.gateOpen && <span className="chip on">GATE OPEN</span>}
              </>
            )}
            {cr && hud.chain && (
              <>
                <span className="chip">{CHAIN_MODE_LABELS[hud.chain.mode].toUpperCase()}</span>
                <span className="chip">HOPPER {hud.hopper.length}/{hud.chain.storage}</span>
                <span className={`chip ${hud.chain.mult > 1 ? 'on' : ''}`}>×{hud.chain.mult}</span>
                {hud.chain.carrying && <span className="chip on">◍ CARRYING RING</span>}
                {hud.chain.ringAction === 'pickup' && <span className="chip prompt">◎ PICK UP RING ▸</span>}
                {hud.chain.ringAction === 'place' && <span className="chip prompt">◎ PLACE RING ▸</span>}
                {/* the catapult's throw is on its OWN key, so name it — otherwise the only
                    discoverable action is the claw button, which just puts the ring down */}
                {hud.chain.ringAction === 'fling' && <span className="chip prompt">◎ THROW RING ▸</span>}
                {hud.chain.endgame === 'ascended' && <span className="chip on">▲ ASCENDED</span>}
                {hud.chain.endgame === 'parked' && <span className="chip on">■ PARKED</span>}
              </>
            )}
            {!cr && hud.mode === 'match' &&
              (hud.fouls[hud.alliance].minor > 0 || hud.fouls[hud.alliance].major > 0) && (
                <span className="chip warn">
                  FOULS {hud.fouls[hud.alliance].minor}m {hud.fouls[hud.alliance].major}M
                </span>
              )}
            {hud.frontFlipped && <span className="chip warn">REVERSED</span>}
            {/* BUTTERFLY: name the set that is DOWN. It changes handling AND whether strafe
                exists at all, so it can't be invisible state. */}
            {hud.butterflyMode && (
              <span className="chip">{hud.butterflyMode === 'tank' ? 'TRACTION' : 'MECANUM'}</span>
            )}
            <span className={`chip ${hud.gamepadConnected ? 'on' : 'off'}`}>🎮</span>
            {hud.net && (
              <span className={`chip ${hud.net.peers > 0 ? 'on' : 'warn'}`}>
                NET {hud.net.peers + 1}P
              </span>
            )}
            {hud.net?.server && (
              <span className="chip on" title={`This match is hosted on the ${hud.net.server} server`}>
                🌐 {hud.net.server}
              </span>
            )}
            {/* who is watching. Shown only when somebody IS: a standing "0 watching"
                is noise on an already-busy chip row, and the moment worth surfacing
                is the one where the number stops being zero. */}
            {hud.spectators > 0 && (
              <span
                className="chip on"
                title={`${hud.spectators} ${hud.spectators === 1 ? 'person is' : 'people are'} watching this match live`}
              >
                👁 {hud.spectators}
              </span>
            )}
            {hud.net && !hud.net.waitingFor && (
              <NetQuality
                net={hud.net}
                open={pingGraph}
                onToggle={() => setPingGraph((v) => !v)}
              />
            )}
            {hud.net?.waitingFor && (
              <span className="chip warn">WAITING · {hud.net.waitingFor}</span>
            )}
            {hud.net?.desync && <span className="chip off">⚠ DESYNC</span>}
          </div>
          {hud.net && pingGraph && <PingGraph net={hud.net} />}
        </div>
      )}

      {/* polite: match events shouldn't interrupt, but they are the only non-visual
          channel for scoring/gate/penalty state. Hideable — some drivers want the
          field corner clear, and nothing here is actionable. */}
      {showEventLog && (
        <div className="eventlog" aria-live="polite">
          {hud.toasts.map((t) => (
            <div key={t.id} className="eventlog-line">
              {t.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** one driver card in the ranked intro (team/name, drivetrain badge, count-up ELO) */
function IntroCard({ p, index }: { p: IntroPlayer; index: number }) {
  const elo = useCountUp(p.elo ?? 0, true, 1100);
  return (
    <div
      className={`intro-card ${p.alliance} ${p.isLocal ? 'you' : ''}`}
      style={{ animationDelay: `${0.15 + index * 0.12}s` }}
    >
      <div className="intro-card-head">
        <span className="intro-team">{p.teamNumber ? `#${p.teamNumber}` : '-'}</span>
        {p.isLocal && <span className="intro-you">YOU</span>}
      </div>
      <div className="intro-name">{p.name || 'Unnamed'}</div>
      <div className="intro-sub">{p.teamName || 'No team'}</div>
      <div className="intro-meta">
        <span className="intro-dt">{DT_LABEL[p.drivetrain]}</span>
        <span className="intro-elo">{p.elo === null ? 'UNRANKED' : elo}</span>
      </div>
    </div>
  );
}

/** ranked pre-match intro: RED vs BLUE cards fly in from their sides, drivetrains
 * shown, ELO counting up. Runs during the ~4s pre-match countdown (the "MATCH
 * BEGINS IN" / 3-2-1 digits render on top). */
function RankedIntro({
  players,
  viewAlliance,
}: {
  players: IntroPlayer[];
  viewAlliance: Alliance;
}) {
  const red = players.filter((p) => p.alliance === 'red');
  const blue = players.filter((p) => p.alliance === 'blue');
  // put the local player's alliance on the left so it reads as "us vs them"
  const [left, leftName, right, rightName] =
    viewAlliance === 'blue'
      ? ([blue, 'BLUE', red, 'RED'] as const)
      : ([red, 'RED', blue, 'BLUE'] as const);
  return (
    <div className="intro-overlay">
      <div className="intro-eyebrow">RANKED MATCH</div>
      <div className="intro-cols">
        <div className="intro-col">
          <div className={`intro-side-label ${leftName.toLowerCase()}`}>{leftName}</div>
          {left.map((p, i) => (
            <IntroCard key={p.robotId} p={p} index={i} />
          ))}
        </div>
        <div className="intro-vs">VS</div>
        <div className="intro-col right">
          <div className={`intro-side-label ${rightName.toLowerCase()}`}>{rightName}</div>
          {right.map((p, i) => (
            <IntroCard key={p.robotId} p={p} index={i} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** one driver's ELO change row. Rows reveal in a stagger; the rating rolls from
 * `before` up/down to `after` while the delta chip slams in and pulses. */
function EloRow({ r, index }: { r: EloResultRow; index: number }) {
  const delta = r.after - r.before;
  // stagger each row, then run the count-up (and the CSS pop keys off `.in`)
  const [live, setLive] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setLive(true), 120 + index * 260);
    return () => window.clearTimeout(id);
  }, [index]);
  const after = useCountUp(r.after, live, 1100, r.before);
  const dir = delta >= 0 ? 'up' : 'down';
  const promo = tierChange(r.before, r.after, r.games);
  return (
    <div className={`elo-row ${r.alliance} ${r.isLocal ? 'you' : ''} ${live ? 'in' : ''}`}>
      <span className="elo-name">
        {r.name}
        {r.isLocal && <span className="elo-you">YOU</span>}
        {r.provisional && (
          <span className="elo-prov" title="In placements - finish your placement matches to join the leaderboard">
            ?
          </span>
        )}
      </span>
      <span className="elo-nums">
        <span className="elo-before">{r.before}</span>
        <span className="elo-arrow">→</span>
        <span className={`elo-after ${live ? dir : ''}`}>
          {after}
          {r.provisional && <span className="elo-prov-mark">?</span>}
        </span>
        <span className={`elo-delta ${dir} ${live ? 'pop' : ''}`}>
          <span className="elo-delta-caret">{delta >= 0 ? '▲' : '▼'}</span>
          {delta >= 0 ? `+${delta}` : delta}
        </span>
      </span>
      {/* THE STANDING, for the local player only. Every driver's rating change is worth
          showing — that is the scoreboard — but a tier badge per row would turn the
          results into a wall of shields. The question "where did that leave ME" is the
          one worth answering here, and a promotion is the moment the ladder earns an
          interruption. */}
      {r.isLocal && (
        <span className="elo-standing">
          <RankBadge rating={r.after} games={r.games} size="sm" />
          {promo && <span className={`ds-rank-change ${promo === 'promoted' ? 'up' : 'down'}`}>
            {promo === 'promoted' ? '▲ Promoted' : '▼ Demoted'} — {standingFor(r.after, r.games).tier.name}
          </span>}
        </span>
      )}
    </div>
  );
}

/** ranked ELO change section on the results screen. `rows` is null until the
 * server's scored eloResult lands (a beat after the score), so we show a short
 * "Updating ELO…" placeholder — but never hang: if nothing arrives within a few
 * seconds (e.g. a match that couldn't be rated), fall back to a clear message. */
function EloResults({ rows }: { rows: EloResultRow[] | null }) {
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (rows !== null) return;
    const id = window.setTimeout(() => setTimedOut(true), 9000);
    return () => window.clearTimeout(id);
  }, [rows]);
  // alpha builds never persist — the server sends no eloResult, so say so up front
  // instead of spinning on "Updating ELO…"
  if (appChannel() === 'alpha' && rows === null) {
    return (
      <div className="elo-block">
        <div className="elo-head">RANKED · ELO</div>
        <p className="ds-hint elo-wait">Not rated on this test build.</p>
      </div>
    );
  }
  return (
    <div className="elo-block">
      <div className="elo-head">RANKED · ELO</div>
      {rows === null ? (
        <p className="ds-hint elo-wait">{timedOut ? 'No rating change this match.' : 'Updating ELO…'}</p>
      ) : (
        rows.map((r, i) => <EloRow key={r.robotId} r={r} index={i} />)
      )}
    </div>
  );
}

/** final match results — RED | category | BLUE, like the FTC audience board.
 * Foul rows show the fouls each alliance COMMITTED (its own count) — the POINTS
 * for those go to the OPPONENT's total (see the footnote), so a foul always
 * benefits the fouled alliance. */
/** the shared duo-record rematch control. Reads its pressed state from the SERVER
 *  tally rather than a local guess, so both drivers always see the same count. */
function RematchVote({
  vote,
  onToggle,
}: {
  vote: { votes: number; need: number; mine: boolean };
  onToggle: () => void;
}) {
  const waiting = vote.mine && vote.votes < vote.need;
  return (
    <button className={vote.mine ? 'primary' : ''} onClick={onToggle}>
      {waiting ? 'WAITING…' : '⟲ REMATCH'} {vote.votes}/{vote.need}
    </button>
  );
}

function Results({
  hud,
  revealAt,
  ranked,
  eloResults,
  canRematch,
  onRematch,
  coopRematch,
  onCoopRematch,
  onExit,
  matchResult,
  recordResult,
  signedIn,
  onWatchReplay,
  reportable,
  onReport,
}: {
  hud: HudSnapshot;
  /** performance.now() ms the whoosh fires — the reveal (count-up + winner slam)
   * lands here; null ⇒ reveal immediately */
  revealAt: number | null;
  /** ranked match? shows the ELO-change section */
  ranked: boolean;
  /** per-driver ELO changes, or null until the server's eloResult lands */
  eloResults: EloResultRow[] | null;
  canRematch: boolean;
  onRematch: () => void;
  /** duo-record co-op vote (null unless this run has one) */
  coopRematch: { votes: number; need: number; mine: boolean } | null;
  onCoopRematch: () => void;
  onExit: () => void;
  matchResult: MatchResultInfo | null;
  /** record run's leaderboard standing, or null until the server's recordResult
   * lands (or forever if anonymous) */
  recordResult: RecordRankInfo | null;
  signedIn: boolean;
  onWatchReplay?: (replay: Replay) => void;
  /** the OTHER drivers in this match, reportable by robot id (empty in solo) */
  reportable?: { robotId: number; name: string }[];
  /** send a report; absent in solo / on an older session */
  onReport?: (robotId: number, reason: string, detail: string) => void;
}) {
  const [reporting, setReporting] = useState(false);
  const red = hud.alliance === 'red' ? hud.score : hud.oppScore;
  const blue = hud.alliance === 'blue' ? hud.score : hud.oppScore;
  const winner: Alliance | 'tie' =
    red.total > blue.total ? 'red' : blue.total > red.total ? 'blue' : 'tie';

  // RECORD runs are opponent-free score attacks: no winner, and the player's own
  // fouls (which are "awarded" to the empty opposing alliance) SUBTRACT from the
  // net score shown + saved.
  const isRecord = matchResult?.kind === 'record';
  const mine = hud.score; // the player's own breakdown
  const penaltyPts = hud.oppScore.foulPoints; // points the player's fouls handed the empty opponent
  const netScore = Math.max(0, mine.total - penaltyPts);

  // hold the reveal until the whoosh fires, then count up + slam the winner
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (revealAt === null) {
      setRevealed(true);
      return;
    }
    const delay = Math.max(0, revealAt - performance.now());
    const id = window.setTimeout(() => setRevealed(true), delay);
    return () => window.clearTimeout(id);
  }, [revealAt]);
  const redTotal = useCountUp(red.total, revealed, 900);
  const blueTotal = useCountUp(blue.total, revealed, 900);
  const netTotal = useCountUp(netScore, revealed, 900);

  if (isRecord) {
    return (
      <RecordResults
        hud={hud}
        mine={mine}
        penaltyPts={penaltyPts}
        netScore={netScore}
        netTotal={netTotal}
        revealed={revealed}
        recordResult={recordResult}
        signedIn={signedIn}
        matchResult={matchResult}
        canRematch={canRematch}
        onRematch={onRematch}
        coopRematch={coopRematch}
        onCoopRematch={onCoopRematch}
        onExit={onExit}
        onWatchReplay={onWatchReplay}
      />
    );
  }

  const cr = hud.game === 'chain';
  const f = hud.fouls; // fouls COMMITTED by each alliance
  const val = (get: (s: ScoreBreakdown) => number): [number, number] => [get(red), get(blue)];

  // Chain Reaction has its own scoring: Particle points (catalyst multiplier folded in) +
  // End Game (park 5 / ascend 100) + penalty points awarded from the OPPONENT's fouls.
  const crSections = (): [string, [string, number, number][]][] => {
    const c = hud.chain;
    if (!c) return [];
    const isRed = hud.alliance === 'red';
    const redP = isRed ? c.particlePts : c.oppParticlePts;
    const blueP = isRed ? c.oppParticlePts : c.particlePts;
    const redF = isRed ? c.foulPts : c.oppFoulPts;
    const blueF = isRed ? c.oppFoulPts : c.foulPts;
    return [
      ['SCORING', [['Particles ×mult', redP, blueP]]],
      ['RING STAND / PARK', [['Descend / Ascend / Park', red.total - redP - redF, blue.total - blueP - blueF]]],
      ['PENALTIES', [['Fouls awarded', redF, blueF]]],
    ];
  };

  const sections: [string, [string, number, number][]][] = cr
    ? crSections()
    : [
        [
          'AUTONOMOUS',
          [
            ['Leave', ...val((s) => s.leave)],
            ['Classified', ...val((s) => s.autoClassified)],
            ['Overflow', ...val((s) => s.autoOverflow)],
            ['Pattern', ...val((s) => s.autoPattern)],
          ],
        ],
        [
          'DRIVER-CONTROLLED',
          [
            ['Classified', ...val((s) => s.teleClassified)],
            ['Overflow', ...val((s) => s.teleOverflow)],
            ['Pattern', ...val((s) => s.telePattern)],
          ],
        ],
        [
          'END OF MATCH',
          [
            ['Depot', ...val((s) => s.depot)],
            ['Base return', ...val((s) => s.base)],
          ],
        ],
        [
          // penalty POINTS awarded to each alliance (from the OPPONENT's fouls) —
          // shown as points, not counts, so the breakdown reconciles with each TOTAL
          'PENALTIES',
          [
            ['Minor', f.blue.minor * PTS_FOUL_MINOR, f.red.minor * PTS_FOUL_MINOR],
            ['Major', f.blue.major * PTS_FOUL_MAJOR, f.red.major * PTS_FOUL_MAJOR],
          ],
        ],
      ];

  return (
    <div className="overlay">
      <div className={`overlay-panel results ${revealed ? 'revealed' : 'tallying'}`}>
        <h2>{revealed ? 'MATCH RESULTS' : 'FINAL SCORE'}</h2>
        <div className={`results-head ${revealed ? 'reveal' : ''}`}>
          <div className={`res-side red ${revealed && winner === 'red' ? 'win' : ''}`}>
            <span>RED</span>
            <strong>{revealed ? redTotal : '-'}</strong>
          </div>
          <div className="res-verdict">
            {revealed ? (winner === 'tie' ? 'TIE' : `${winner.toUpperCase()} WINS`) : '···'}
          </div>
          <div className={`res-side blue ${revealed && winner === 'blue' ? 'win' : ''}`}>
            <span>BLUE</span>
            <strong>{revealed ? blueTotal : '-'}</strong>
          </div>
        </div>
        {!revealed && <p className="ds-hint results-wait">Tallying the score…</p>}
        {revealed && (
          <>
        <table className="score-table results-table">
          <thead>
            <tr>
              <th className="rv red">RED</th>
              <th className="cat" />
              <th className="bv blue">BLUE</th>
            </tr>
          </thead>
          <tbody>
            {sections.map(([title, rows]) => (
              <Fragment key={title}>
                <tr className="section-row">
                  <td colSpan={3}>{title}</td>
                </tr>
                {rows.map(([label, rv, bv]) => (
                  <tr key={label}>
                    <td className="rv">{rv}</td>
                    <td className="cat">{label}</td>
                    <td className="bv">{bv}</td>
                  </tr>
                ))}
              </Fragment>
            ))}
            <tr className="total-row">
              <td className="rv">{red.total}</td>
              <td className="cat">TOTAL</td>
              <td className="bv">{blue.total}</td>
            </tr>
          </tbody>
        </table>
        {ranked && <EloResults rows={eloResults} />}
        {matchResult && (
          <p className="ds-hint" style={{ color: 'var(--ds-accent)' }}>
            {matchResult.kind === 'record'
              ? '✓ Recorded - sign in to save it to the leaderboard.'
              : '✓ Match recorded.'}
          </p>
        )}
        <div className="overlay-buttons">
          {matchResult && onWatchReplay && (
            <button onClick={() => onWatchReplay(matchResult.replay)}>▶ WATCH REPLAY</button>
          )}
          {canRematch && <button onClick={onRematch}>REMATCH</button>}
          {coopRematch && <RematchVote vote={coopRematch} onToggle={onCoopRematch} />}
          <button onClick={onExit}>MENU</button>
        </div>
        {/* REPORT is deliberately not in the button row. It is a rare, deliberate action and
            the row is where REMATCH and MENU live — the two things every player reaches for
            every match. A quiet link below keeps it available without putting it under a
            thumb aiming for the exit. */}
        {onReport && reportable && reportable.length > 0 && !reporting && (
          <button className="ds-linkbtn results-report" onClick={() => setReporting(true)}>
            ⚑ Report a player
          </button>
        )}
        {reporting && onReport && reportable && (
          <ReportDialog
            drivers={reportable}
            onSubmit={(rid, reason, detail) => onReport(rid, reason, detail)}
            onClose={() => setReporting(false)}
          />
        )}
        {/* AFTER the buttons, deliberately. The results screen is a good place
            for an ad — the match is over and the player is reading rather than
            driving — but REMATCH and MENU must stay the first things reachable,
            by mouse and by tab order. An ad between the score and the exit is
            the pattern that generates accidental clicks. */}
        <ResultsAd />
          </>
        )}
      </div>
    </div>
  );
}

const DRIVETRAIN_LABEL: Record<string, string> = {
  mecanum: 'Mecanum',
  xdrive: 'X-Drive',
  butterfly: 'Butterfly',
  tank: 'Tank',
  swerve: 'Swerve',
  // sentinel for a mixed-drivetrain duo run (overall board only, no dt-specific)
  overall: 'Mixed',
};
const prettyDrivetrain = (d: string): string => DRIVETRAIN_LABEL[d] ?? d;

/** the PB / WR / rank line on a record run's results screen. Null info ⇒ either
 * the run is still being scored (signed in) or it was anonymous (prompt to sign
 * in — anonymous runs are never persisted, so no rank exists). */
function RecordStanding({ info, signedIn }: { info: RecordRankInfo | null; signedIn: boolean }) {
  if (!info) {
    // alpha builds are not persisted server-side (no recordResult ever arrives) —
    // don't leave a signed-in player spinning on "Saving…"
    if (appChannel() === 'alpha') {
      return <p className="ds-hint record-standing pending">Not saved on this test build.</p>;
    }
    return signedIn ? (
      <p className="ds-hint record-standing pending">Saving · computing your rank…</p>
    ) : (
      <p className="record-standing signin">Sign in to save this run &amp; see your rank →</p>
    );
  }
  const cat = `${info.mode === 'duo' ? 'Duo' : 'Solo'} · ${prettyDrivetrain(info.drivetrain)}`;
  if (info.isWR) {
    return (
      <div className="record-standing wr">
        <strong>🏆 WORLD RECORD</strong>
        <span>{cat} · #1 of {info.total}</span>
      </div>
    );
  }
  if (info.isPB) {
    return (
      <div className="record-standing pb">
        <strong>★ NEW PERSONAL BEST</strong>
        <span>{cat} · #{info.rank} of {info.total}</span>
      </div>
    );
  }
  return (
    <div className="record-standing rank">
      <strong>#{info.rank}</strong>
      <span>of {info.total} · {cat}</span>
    </div>
  );
}

/** opponent-free record-run results: one net score (own penalties subtracted),
 * a PB / WR / rank line, and a single-column breakdown. No opponent, no winner. */
function RecordResults({
  hud,
  mine,
  penaltyPts,
  netScore,
  netTotal,
  revealed,
  recordResult,
  signedIn,
  matchResult,
  canRematch,
  onRematch,
  coopRematch,
  onCoopRematch,
  onExit,
  onWatchReplay,
}: {
  hud: HudSnapshot;
  mine: ScoreBreakdown;
  penaltyPts: number;
  netScore: number;
  netTotal: number;
  revealed: boolean;
  recordResult: RecordRankInfo | null;
  signedIn: boolean;
  matchResult: MatchResultInfo | null;
  canRematch: boolean;
  onRematch: () => void;
  /** duo-record co-op vote (null unless this run has one) */
  coopRematch: { votes: number; need: number; mine: boolean } | null;
  onCoopRematch: () => void;
  onExit: () => void;
  onWatchReplay?: (replay: Replay) => void;
}) {
  const cr = hud.game === 'chain';
  const f = hud.fouls[hud.alliance]; // fouls the PLAYER committed
  const sections: [string, [string, number][]][] =
    cr && hud.chain
      ? [
          ['SCORING', [['Particles ×mult', hud.chain.particlePts]]],
          ['END GAME', [['Park / Ascend', mine.total - hud.chain.particlePts - hud.chain.foulPts]]],
        ]
      : [
          ['AUTONOMOUS', [
            ['Leave', mine.leave],
            ['Classified', mine.autoClassified],
            ['Overflow', mine.autoOverflow],
            ['Pattern', mine.autoPattern],
          ]],
          ['DRIVER-CONTROLLED', [
            ['Classified', mine.teleClassified],
            ['Overflow', mine.teleOverflow],
            ['Pattern', mine.telePattern],
          ]],
          ['END OF MATCH', [
            ['Depot', mine.depot],
            ['Base return', mine.base],
          ]],
        ];

  return (
    <div className="overlay">
      <div className={`overlay-panel results record ${revealed ? 'revealed' : 'tallying'}`}>
        <h2>{revealed ? 'RUN COMPLETE' : 'FINAL SCORE'}</h2>
        <div className={`record-scoreline ${revealed ? 'reveal' : ''}`}>
          <strong className="record-total">{revealed ? netTotal : '-'}</strong>
          <span className="record-total-label">POINTS</span>
        </div>
        {!revealed && <p className="ds-hint results-wait">Tallying the score…</p>}
        {revealed && (
          <>
            <RecordStanding info={recordResult} signedIn={signedIn} />
            <table className="score-table results-table record-table">
              <tbody>
                {sections.map(([title, rows]) => (
                  <Fragment key={title}>
                    <tr className="section-row"><td colSpan={2}>{title}</td></tr>
                    {rows.map(([label, v]) => (
                      <tr key={label}>
                        <td className="cat">{label}</td>
                        <td className="bv">{v}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
                {!cr && (
                  <>
                    <tr className="section-row"><td colSpan={2}>PENALTIES</td></tr>
                    <tr className="penalty-row">
                      <td className="cat">
                        Fouls committed ({f.minor} minor · {f.major} major)
                      </td>
                      <td className="bv">{penaltyPts > 0 ? `−${penaltyPts}` : 0}</td>
                    </tr>
                  </>
                )}
                <tr className="total-row">
                  <td className="cat">{cr ? 'TOTAL' : 'NET SCORE'}</td>
                  <td className="bv">{netScore}</td>
                </tr>
              </tbody>
            </table>
            <div className="overlay-buttons">
              {matchResult && onWatchReplay && (
                <button onClick={() => onWatchReplay(matchResult.replay)}>▶ WATCH REPLAY</button>
              )}
              {canRematch && <button onClick={onRematch}>RUN AGAIN</button>}
              {/* CO-OP: the run belongs to both drivers, so restarting is a vote —
                  the same control (and the same R binding) as mid-match. */}
              {coopRematch && <RematchVote vote={coopRematch} onToggle={onCoopRematch} />}
              <button onClick={onExit}>MENU</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

