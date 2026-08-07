import { useEffect, useRef, useState } from 'react';
import { fetchReplay } from '../net/api';
import { ReplayPlayer, replayViewpoint, replayPlayability, type Replay } from '../sim/replay';
import { moduleFor } from '../games';
import { Renderer } from '../render/renderer';
import { rangeFill } from './rangeFill';
import { SIM_DT } from '../config';
import type { MatchPhase } from '../types';

/**
 * Replay viewer: fetches a deterministic input-log replay and re-simulates it in
 * the browser, drawing with the same Renderer the live game uses. Physics WASM is
 * already inited (main.tsx) before any screen renders, so `ReplayPlayer` is safe.
 * Playback is cosmetic — the authoritative score lives on the board — so cross-
 * machine float drift (if any) can't move standings.
 */
export function ReplayView({
  replayId,
  preloadReplay,
  viewerRobotId,
  onClose,
}: {
  replayId?: string;
  /** a replay already in hand (just-played run) — skips the fetch */
  preloadReplay?: Replay;
  /** the robot the WATCHER drove, so the camera sits behind their own driver
   * station rather than whichever alliance happens to be first on the roster.
   * See `replayViewpoint` — getting this wrong mirrors the whole field. */
  viewerRobotId?: number | null;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'stale'>('loading');
  const [error, setError] = useState('');
  // the version a stale replay was recorded under (for the message)
  const [staleVersion, setStaleVersion] = useState<number | null>(null);
  /** playable, but recorded before a sim fix landed — the ending may differ slightly
   *  from the saved score, which is worth saying rather than quietly showing */
  const [drift, setDrift] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [tick, setTick] = useState(0);
  const [total, setTotal] = useState(1);
  // live scoreboard, sampled with the progress readout (never per frame)
  const [score, setScore] = useState({ red: 0, blue: 0 });
  const [phase, setPhase] = useState<MatchPhase>('pre');
  const [timeLeft, setTimeLeft] = useState(0);

  const renderer = useRef<Renderer | null>(null);
  const player = useRef<ReplayPlayer | null>(null);
  const replay = useRef<Replay | null>(null);
  const playingRef = useRef(true);

  // fetch the replay (or use a preloaded one) + build the player
  useEffect(() => {
    let dead = false;
    setStatus('loading');
    setError('');
    const use = (r: Replay): void => {
      replay.current = r;
      // A replay is a deterministic INPUT log. Whether this build can re-run it —
      // exactly, approximately, or not at all — is `replayPlayability`, which is
      // deliberately three-valued: a float-level determinism fix must NOT make every
      // match recorded before it vanish, it just means the ending may not land on
      // precisely the saved number. Only an unreadable container or a different
      // SEASON is a refusal.
      const play = replayPlayability(r);
      if (play === 'stale') {
        setStaleVersion(r.balanceVersion ?? null);
        setStatus('stale');
        return;
      }
      setDrift(play === 'drift');
      player.current = new ReplayPlayer(r);
      renderer.current = new Renderer();
      setTotal(Math.max(1, r.ticks));
      setTick(0);
      setStatus('ready');
    };
    if (preloadReplay) {
      use(preloadReplay);
      return;
    }
    if (!replayId) {
      setError('No replay specified.');
      setStatus('error');
      return;
    }
    fetchReplay(replayId)
      .then((r) => {
        if (!dead) use(r);
      })
      .catch((e: unknown) => {
        if (dead) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      });
    return () => {
      dead = true;
    };
  }, [replayId, preloadReplay]);

  // render loop + a 10 Hz progress readout (no per-frame React churn)
  useEffect(() => {
    if (status !== 'ready') return;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const r = replay.current!;
    const rend = renderer.current!;
    // watch it from the seat the WATCHER actually sat in — see `replayViewpoint`
    const { robotId: localId, alliance } = replayViewpoint(r.setups, viewerRobotId);
    // CR's field is larger (protruding goals) — configure the camera with the game's
    // bounds so a CR replay isn't cropped to DECODE's field.
    const bounds = moduleFor(r.game).bounds;

    const resize = (): void => rend.camera.configure(canvas, alliance, bounds);
    resize();
    window.addEventListener('resize', resize);

    let raf = 0;
    let lastT = performance.now();
    let acc = 0;
    const loop = (t: number): void => {
      const p = player.current!;
      const dt = Math.min((t - lastT) / 1000, 0.25);
      lastT = t;
      if (playingRef.current) {
        acc += dt;
        let n = 0;
        while (acc >= SIM_DT && n < 8 && !p.done) {
          p.stepOnce();
          acc -= SIM_DT;
          n++;
        }
        if (p.done && playingRef.current) {
          playingRef.current = false;
          setPlaying(false);
        }
      }
      rend.render(ctx, p.world, null, localId);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const readout = window.setInterval(sync, 100);

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(readout);
      window.removeEventListener('resize', resize);
    };
  }, [status, viewerRobotId]);

  /** pull tick + scoreboard off the sim in one go, so seeking/restarting can't
   *  leave the score showing a different moment than the field does. */
  const sync = (): void => {
    const w = player.current?.world;
    if (!w) return;
    setTick(w.tick);
    setScore({ red: w.match.scores.red.total, blue: w.match.scores.blue.total });
    setPhase(w.match.phase);
    setTimeLeft(Math.max(0, Math.round(w.match.phaseTimeLeft)));
  };

  const setPlay = (v: boolean): void => {
    // replaying from the end restarts
    if (v && player.current?.done) rebuild();
    playingRef.current = v;
    setPlaying(v);
  };
  const rebuild = (): void => {
    if (!replay.current) return;
    player.current = new ReplayPlayer(replay.current);
    sync();
  };
  const seek = (target: number): void => {
    const r = replay.current;
    if (!r) return;
    let p = player.current!;
    if (target < p.world.tick) {
      p = new ReplayPlayer(r);
      player.current = p;
    }
    while (p.world.tick < target && !p.done) p.stepOnce();
    sync();
  };

  const pct = Math.round((tick / total) * 100);
  // a record run has one alliance on the field — showing "0" for an opponent that
  // never existed reads as a shutout, so those get a single score instead.
  const alliances = new Set((replay.current?.setups ?? []).map((s) => s.alliance));
  const solo = alliances.size < 2;
  const soloSide = solo ? ([...alliances][0] ?? 'blue') : null;
  const done = phase === 'post' || (player.current?.done ?? false);
  const clock = `${Math.floor(timeLeft / 60)}:${String(timeLeft % 60).padStart(2, '0')}`;

  return (
    <div className="ds-replay">
      <div className="ds-replay-top">
        <button className="ds-btn ghost" onClick={onClose}>← Leaderboard</button>
        <span className="ds-panel-title">Replay · Season {replay.current?.balanceVersion ?? '-'}</span>
        <span style={{ width: 90 }} />
      </div>

      {status === 'loading' && <div className="ds-loading" style={{ margin: 'auto' }}>Loading replay…</div>}
      {status === 'error' && (
        <div className="ds-empty" style={{ margin: 'auto' }}>
          <div className="big">Couldn’t load the replay</div>
          {error}
        </div>
      )}
      {status === 'stale' && (
        <div className="ds-empty" style={{ margin: 'auto' }}>
          <div className="big">Replay unavailable</div>
          This match was recorded on an older version of the sim
          {staleVersion !== null ? ` (Season ${staleVersion})` : ''}. Physics and balance have
          changed since, so it can no longer be played back accurately. The score on the
          leaderboard still stands.
        </div>
      )}
      {status === 'ready' && drift && (
        <p className="ds-replay-drift">
          Recorded earlier this season, before a small physics correction. It plays, but the
          ending may not land on exactly the saved score - the leaderboard figure is the real one.
        </p>
      )}
      {status === 'ready' && (
        <div className={`ds-replay-score${done ? ' final' : ''}`}>
          {solo ? (
            <>
              <span className={`rs-side ${soloSide}`}>{soloSide === 'red' ? 'RED' : 'BLUE'}</span>
              <b className="rs-num">{soloSide === 'red' ? score.red : score.blue}</b>
            </>
          ) : (
            <>
              <span className="rs-side red">RED</span>
              <b className="rs-num">{score.red}</b>
              <span className="rs-mid">{done ? 'FINAL' : clock}</span>
              <b className="rs-num">{score.blue}</b>
              <span className="rs-side blue">BLUE</span>
            </>
          )}
          {solo && <span className="rs-mid">{done ? 'FINAL' : clock}</span>}
        </div>
      )}
      <canvas ref={canvasRef} className="ds-replay-canvas" style={{ display: status === 'ready' ? 'block' : 'none' }} />

      {status === 'ready' && (
        <div className="ds-replay-controls">
          <button className="ds-btn primary" onClick={() => setPlay(!playing)}>
            {playing ? '❚❚ Pause' : player.current?.done ? '⟲ Replay' : '▶ Play'}
          </button>
          <button className="ds-btn" onClick={rebuild}>⟲ Restart</button>
          <input
            type="range"
            className="ds-replay-seek"
            min={0}
            max={total}
            value={tick}
            style={rangeFill(tick, 0, total)}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="Seek"
          />
          <span className="ds-replay-time">{pct}%</span>
        </div>
      )}
    </div>
  );
}
