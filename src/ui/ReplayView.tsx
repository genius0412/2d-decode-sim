import { useEffect, useRef, useState } from 'react';
import { fetchReplay } from '../net/api';
import { ReplayPlayer, replayPlayable, replayViewpoint, type Replay } from '../sim/replay';
import { moduleFor } from '../games';
import { Renderer } from '../render/renderer';
import { rangeFill } from './rangeFill';
import { pickVideoMime, videoExt, saveBlob } from './replayVideo';
import { SIM_DT, BALANCE_VERSION, SIM_VERSION } from '../config';
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
  /** a real-time canvas capture is running; playback controls are locked while it is */
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<BlobPart[]>([]);
  /** set when the user cancels, so `onstop` throws the partial file away instead of saving it */
  const discard = useRef(false);
  /** detaches the visibilitychange listener that pauses the encoder with the render loop */
  const stopVisibility = useRef<(() => void) | null>(null);
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
      // A replay is a deterministic INPUT log — it only re-simulates to its original
      // outcome under the exact sim build that recorded it. `replayPlayable` owns the whole
      // decision (see it for the container-vs-behaviour split): an OLDER container is still
      // readable and still plays, a mismatched balance/sim version cannot, and a format-1
      // replay of a tank robot is refused because its drive input was never stored.
      if (!replayPlayable(r, BALANCE_VERSION, SIM_VERSION)) {
        setStaleVersion(r.balanceVersion ?? null);
        setStatus('stale');
        return;
      }
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
          // the END of the replay is what ends the recording — a ref, not the `recording`
          // state, because this loop closes over the render that started it
          if (recorder.current?.state === 'recording') recorder.current.stop();
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

  /**
   * A RECORDING MUST NOT OUTLIVE THE SCREEN THAT STARTED IT. Leaving the viewer mid-capture
   * would otherwise leave a live `MediaRecorder` holding a stream off a canvas that no longer
   * exists, plus a document-level listener with nothing to detach it. Discard, don't save: a
   * video of a match the watcher walked out of is not a file anyone asked for.
   */
  useEffect(
    () => () => {
      discard.current = true;
      const cur = recorder.current;
      if (cur && cur.state !== 'inactive') cur.stop();
      stopVisibility.current?.();
      stopVisibility.current = null;
    },
    [],
  );

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
  /**
   * SAVE THE REPLAY WHILE IT IS STILL EXACT — as a VIDEO, mainly.
   *
   * `replayPlayable` retires a replay the moment SIM_VERSION moves, deliberately: a changed sim
   * re-simulates the same inputs into a different game. So the container is perishable, and the
   * only moment it is provably the real match is while this build can still play it. Both
   * exports therefore live on `status === 'ready'`, which IS `replayPlayable` — neither is ever
   * offered for something we could not reproduce anyway.
   *
   * The VIDEO is the one that lasts: it stops being a re-simulation and becomes a recording, so
   * it outlives every patch, needs no sim to watch, and can be sent to someone without DSIM.
   * It is captured off the live canvas in REAL TIME (see `replayVideo.ts`), so a full match
   * takes a full match — the replay restarts from tick 0 and plays through while it records.
   *
   * The JSON stays as the secondary export because it is the only form that is still a REPLAY:
   * re-playable in-sim at full fidelity by any build whose versions match, and the shape the
   * server stores. A video cannot be stepped, seeked in-sim, or verified.
   */
  const filename = (ext: string): string => {
    const r = replay.current;
    const id = replayId ?? r?.seed ?? 0;
    return `dsim-${r?.game ?? 'decode'}-s${r?.balanceVersion ?? 0}-v${r?.sim ?? 0}-${id}.${ext}`;
  };

  const downloadData = (): void => {
    const r = replay.current;
    if (!r) return;
    saveBlob(new Blob([JSON.stringify(r)], { type: 'application/json' }), filename('json'));
  };

  const startRecording = (): void => {
    const canvas = canvasRef.current;
    const mime = pickVideoMime();
    // no MediaRecorder (some embedded webviews) or no container it will encode ⇒ the data
    // export is the honest fallback rather than a button that silently does nothing
    if (!canvas || !mime) {
      downloadData();
      return;
    }
    const rec = new MediaRecorder(canvas.captureStream(60), {
      mimeType: mime,
      // the field is flat colour with hard edges, which compresses well; this is generous
      // enough that the scoreboard text stays legible after encoding
      videoBitsPerSecond: 8_000_000,
    });
    chunks.current = [];
    discard.current = false;
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.current.push(e.data);
    };
    rec.onstop = () => {
      const parts = chunks.current;
      chunks.current = [];
      recorder.current = null;
      stopVisibility.current?.();
      stopVisibility.current = null;
      setRecording(false);
      if (!discard.current && parts.length) {
        saveBlob(new Blob(parts, { type: mime }), filename(videoExt(mime)));
      }
    };
    /**
     * HIDE THE TAB AND THE CAPTURE STARVES — so pause the encoder with it.
     *
     * The render loop is `requestAnimationFrame`, which a browser stops for a background tab.
     * The sim stops advancing (so the replay never reaches its end) but the RECORDER keeps
     * running on the wall clock, holding the last painted frame — measured directly: a capture
     * of a canvas whose rAF never fired produced a 110-byte file with zero frames in it. Left
     * alone, switching tabs for a minute would bake a minute of frozen field into the middle of
     * a two-and-a-half-minute match and leave the video longer than the run it recorded.
     *
     * `pause`/`resume` keeps the encoded timeline aligned with the sim's: both stop together
     * and both start together, so the file is the match and nothing else.
     */
    const onVisibility = (): void => {
      const cur = recorder.current;
      if (!cur) return;
      if (document.hidden && cur.state === 'recording') cur.pause();
      else if (!document.hidden && cur.state === 'paused') cur.resume();
    };
    document.addEventListener('visibilitychange', onVisibility);
    stopVisibility.current = () => document.removeEventListener('visibilitychange', onVisibility);

    recorder.current = rec;
    setRecording(true);
    // record the whole match, not from wherever the viewer happens to be paused
    rebuild();
    rec.start();
    playingRef.current = true;
    setPlaying(true);
  };

  const cancelRecording = (): void => {
    discard.current = true;
    const cur = recorder.current;
    // a PAUSED recorder still has to be stopped to fire `onstop` and release the stream
    if (cur && cur.state !== 'inactive') cur.stop();
    playingRef.current = false;
    setPlaying(false);
  };

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
          <button className="ds-btn primary" onClick={() => setPlay(!playing)} disabled={recording}>
            {playing ? '❚❚ Pause' : player.current?.done ? '⟲ Replay' : '▶ Play'}
          </button>
          <button className="ds-btn" onClick={rebuild} disabled={recording}>⟲ Restart</button>
          {/* every playback control is locked while recording: the capture is of THIS canvas,
              so pausing or scrubbing mid-record would be pausing or scrubbing in the file */}
          <input
            type="range"
            className="ds-replay-seek"
            min={0}
            max={total}
            value={tick}
            style={rangeFill(tick, 0, total)}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="Seek"
            disabled={recording}
          />
          <span className="ds-replay-time">{recording ? `● REC ${pct}%` : `${pct}%`}</span>
          {recording ? (
            <button className="ds-btn ghost" onClick={cancelRecording}>Cancel</button>
          ) : (
            <>
              <button
                className="ds-btn ghost"
                onClick={startRecording}
                title="Play the match through and save it as a video file"
              >
                ↓ Video
              </button>
              <button className="ds-btn ghost" onClick={downloadData} title="Save the replay data (re-playable in DSIM)">
                ↓ Data
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
