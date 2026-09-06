import { useEffect, useRef, useState } from 'react';
import { fetchReplay } from '../net/api';
import {
  ReplayPlayer,
  replayRefusal,
  replayViewpoint,
  type Replay,
  type ReplayRefusal,
} from '../sim/replay';
import { moduleFor } from '../games';
import { Renderer } from '../render/renderer';
import { rangeFill } from './rangeFill';
import {
  availableVideoFormats,
  videoFormat,
  recordFast,
  realtimeMime,
  saveBlob,
  type VideoFormatId,
} from './replayVideo';
import { SIM_DT, BALANCE_VERSION, SIM_VERSION } from '../config';
import type { MatchPhase } from '../types';

/** m:ss from seconds. Rounds ONCE, before splitting — rounding the two halves separately
 *  prints "1:00" for 119.7 s, because the minutes half floors the unrounded value. */
const mmss = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * WHY this build won't play that replay, said in the terms the watcher cares about.
 *
 * Each `ReplayRefusal` is a different situation and only one of them is "it got old" — a
 * FUTURE container means THEY are behind and a refresh fixes it, and an UNSTAMPED one means
 * nobody knows. The old copy said "recorded on an older version of the sim (Season N)" for
 * every case, using `balanceVersion`, which is not the season at all: the season is the
 * leaderboard period, and in the replays table it is the `balance_version` COLUMN that holds
 * it while `sim_version` holds this (see repo.ts + migration 0031).
 */
const REFUSAL_TEXT: Record<ReplayRefusal, (r: Replay) => string> = {
  future: () =>
    'This match was recorded by a NEWER version of DSIM than the one you are running. ' +
    'Refresh the page to update, then open it again.',
  balance: (r) =>
    `This match was played under balance v${r.balanceVersion}; this build runs v${BALANCE_VERSION}. ` +
    'Robots accelerate, push and shoot differently now, so replaying the same inputs would ' +
    'produce a different match than the one that happened.',
  behaviour: (r) =>
    `This match was played on sim behaviour v${r.sim}; this build runs v${SIM_VERSION}. ` +
    'The physics or the rules have changed since, so replaying the same inputs would produce ' +
    'a different match than the one that happened.',
  unstamped: () =>
    'This match was recorded before DSIM stamped which sim behaviour produced a replay, so ' +
    'there is no way to tell whether it would play back accurately. Rather than guess, it is ' +
    'not played.',
  tank: () =>
    'This match was recorded in an early replay format that had nowhere to store tank drive ' +
    'input, so the robot would sit still for the whole match.',
};

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
  // WHICH refusal, so the stale screen can give the real reason instead of one guess
  const [refusal, setRefusal] = useState<ReplayRefusal | null>(null);
  /** a real-time canvas capture is running; playback controls are locked while it is */
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<BlobPart[]>([]);
  /** set when the user cancels, so `onstop` throws the partial file away instead of saving it */
  const discard = useRef(false);
  /** detaches the visibilitychange listener that pauses the encoder with the render loop */
  const stopVisibility = useRef<(() => void) | null>(null);
  /** the download menu, and the byte count measured when it opened (see `openMenu`) */
  const [menuOpen, setMenuOpen] = useState(false);
  const [dataBytes, setDataBytes] = useState(0);
  const menuRoot = useRef<HTMLDivElement>(null);
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
  /** measured ONCE: what this browser can actually encode decides what the menu offers, and
   *  this component re-renders 10 times a second off the progress readout. */
  const [formats] = useState(() => availableVideoFormats());
  /** 0..1 while a FAST capture runs; the real-time path uses the replay's own progress */
  const [capturePct, setCapturePct] = useState(0);
  /** the format being written, so the bar can say what it is doing and how long it will take */
  const [capturing, setCapturing] = useState<VideoFormatId | null>(null);
  /** set to stop a fast capture between frames */
  const abortCapture = useRef(false);
  /** read by the render loop, which cannot see `capturing` through its mount-time closure */
  const capturingRef = useRef(false);

  // fetch the replay (or use a preloaded one) + build the player
  useEffect(() => {
    let dead = false;
    setStatus('loading');
    setError('');
    const use = (r: Replay): void => {
      replay.current = r;
      // A replay is a deterministic INPUT log — it only re-simulates to its original
      // outcome under the exact sim build that recorded it. `replayRefusal` owns the whole
      // decision (see it for the container-vs-behaviour split): an OLDER container is still
      // readable and still plays, a mismatched balance/sim version cannot, and a format-1
      // replay of a tank robot is refused because its drive input was never stored.
      const why = replayRefusal(r, BALANCE_VERSION, SIM_VERSION);
      if (why) {
        setRefusal(why);
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
      // a FAST capture draws its OWN world to this same canvas; letting the playback loop
      // repaint between its frames just makes the screen flicker between two matches
      if (!abortCapture.current && !capturingRef.current) rend.render(ctx, p.world, null, localId);
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

  /** The menu closes on Escape and on a press anywhere outside it. A popover that only closes
   *  by re-clicking its own button is one people leave open by accident — and this one covers
   *  the corner of the field. */
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent): void => {
      if (!menuRoot.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

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
  /**
   * SAVE THE REPLAY WHILE IT IS STILL EXACT — as a VIDEO, mainly.
   *
   * `replayRefusal` retires a replay the moment SIM_VERSION moves, deliberately: a changed sim
   * re-simulates the same inputs into a different game. So the container is perishable, and the
   * only moment it is provably the real match is while this build can still play it. Both
   * exports therefore live on `status === 'ready'`, which IS playable — neither is ever offered
   * for something we could not reproduce anyway.
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

  /**
   * SAVE AS A VIDEO, as fast as the machine will go.
   *
   * The FAST path does not touch the live playback at all: it builds its OWN `ReplayPlayer`,
   * steps it frame by frame, draws each frame to the canvas and hands it to `VideoEncoder`
   * stamped at its true 1/60s position. Because the timestamp is carried on the frame rather
   * than taken from the clock, the file comes out the real length of the match however quickly
   * it was produced — measured at 10-19× real time, so a full match saves in about ten seconds.
   *
   * That also deletes the whole class of problem the old capture had. It never used
   * `requestAnimationFrame`, so a backgrounded tab cannot starve it (there is no
   * `visibilitychange` dance any more), and it is not a recording OF the visible canvas, so
   * scrubbing or pausing while it runs cannot end up in the file.
   */
  const startCapture = async (id: VideoFormatId): Promise<void> => {
    const canvas = canvasRef.current;
    const r = replay.current;
    const fmt = videoFormat(id);
    if (!canvas || !r) return;

    // MP4 has no fast path — muxing H.264 is a second container, not a second encoder — so it
    // still records the visible canvas in real time.
    if (!fmt.fast) {
      startRealtime(id);
      return;
    }

    abortCapture.current = false;
    capturingRef.current = true;
    setCapturing(id);
    setCapturePct(0);
    setRecording(true);
    playingRef.current = false;
    setPlaying(false);

    // its OWN player and renderer, so the capture is the whole match from tick 0 regardless of
    // where the viewer had scrubbed to, and the one on screen is left alone
    const shot = new ReplayPlayer(r);
    const rend = new Renderer();
    const { robotId: localId, alliance } = replayViewpoint(r.setups, viewerRobotId);
    rend.camera.configure(canvas, alliance, moduleFor(r.game).bounds);
    const ctx = canvas.getContext('2d')!;

    let blob: Blob | null = null;
    try {
      blob = await recordFast({
        format: id,
        width: canvas.width,
        height: canvas.height,
        fps: Math.round(1 / SIM_DT),
        frames: Math.max(1, r.ticks),
        source: canvas,
        draw: () => {
          shot.stepOnce();
          rend.render(ctx, shot.world, null, localId);
        },
        onProgress: setCapturePct,
        cancelled: () => abortCapture.current,
      });
    } catch {
      blob = null;
    }

    capturingRef.current = false;
    setCapturing(null);
    setRecording(false);
    setCapturePct(0);
    // a cancelled capture is not a failure and must not claim to be one
    if (blob) saveBlob(blob, filename(fmt.ext));
    else if (!abortCapture.current) downloadData();
    rebuild();
  };

  /** the REAL-TIME path, for MP4 — `MediaRecorder` over the live canvas. It cannot go faster:
   *  it stamps frames by when they arrive, not by the timestamp they carry. */
  const startRealtime = (id: VideoFormatId): void => {
    const canvas = canvasRef.current;
    const mime = realtimeMime();
    if (!canvas || !mime) {
      downloadData();
      return;
    }
    const fmt = videoFormat(id);
    const rec = new MediaRecorder(canvas.captureStream(60), {
      mimeType: mime,
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
      setCapturing(null);
      if (!discard.current && parts.length) saveBlob(new Blob(parts, { type: mime }), filename(fmt.ext));
    };
    /**
     * HIDE THE TAB AND A REAL-TIME CAPTURE STARVES — so pause the encoder with it.
     *
     * The render loop is `requestAnimationFrame`, which a browser stops for a background tab.
     * The sim stops advancing but the RECORDER keeps running on the wall clock, holding the
     * last painted frame — measured, a capture of a canvas whose rAF never fired produced a
     * 110-byte file with zero frames in it. Only this path can suffer it; the fast one drives
     * its own loop and never yields to rAF at all.
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
    setCapturing(id);
    setRecording(true);
    rebuild(); // record the whole match, not from wherever the viewer is paused
    rec.start();
    playingRef.current = true;
    setPlaying(true);
  };

  const cancelRecording = (): void => {
    abortCapture.current = true;
    discard.current = true;
    const cur = recorder.current;
    // a PAUSED recorder still has to be stopped to fire `onstop` and release the stream
    if (cur && cur.state !== 'inactive') cur.stop();
    playingRef.current = false;
    setPlaying(false);
  };

  /** Measure the container ONCE, on open. Stringifying it is cheap, but this component
   *  re-renders 10 times a second off the progress readout, and a menu that re-serializes the
   *  whole replay on every one of those is a menu that stutters while it is open. */
  const openMenu = (): void => {
    const r = replay.current;
    if (r && !menuOpen) setDataBytes(new Blob([JSON.stringify(r)]).size);
    setMenuOpen((v) => !v);
  };
  const pick = (fn: () => void): void => {
    setMenuOpen(false);
    fn();
  };

  // a record run has one alliance on the field — showing "0" for an opponent that
  // never existed reads as a shutout, so those get a single score instead.
  const alliances = new Set((replay.current?.setups ?? []).map((s) => s.alliance));
  const solo = alliances.size < 2;
  const soloSide = solo ? ([...alliances][0] ?? 'blue') : null;
  const done = phase === 'post' || (player.current?.done ?? false);
  const clock = `${Math.floor(timeLeft / 60)}:${String(timeLeft % 60).padStart(2, '0')}`;
  // the REAL-TIME capture runs at 1×, so what is left of the replay is what is left of it
  const runtime = total * SIM_DT;
  const remaining = Math.max(0, total - tick) * SIM_DT;
  // ...while a FAST capture has its own progress, since it is not tied to playback at all
  const fastCapture = capturing !== null && videoFormat(capturing).fast;
  const recPct = fastCapture ? Math.round(capturePct * 100) : pct;

  return (
    <div className="ds-replay">
      <div className="ds-replay-top">
        <button className="ds-btn ghost" onClick={onClose}>← Leaderboard</button>
        <span className="ds-panel-title">Replay</span>
        {/* DOWNLOAD BELONGS HERE, not in the transport row below: it is an action on the
            replay, not on playback, and two ghost buttons wedged between the seek bar and the
            clock read as two more transport controls. The spacer keeps the title centred on
            the screens where there is nothing to download. */}
        {status === 'ready' ? (
          <div className="ds-dl" ref={menuRoot}>
            <button
              className={`ds-btn${menuOpen ? ' primary' : ''}`}
              onClick={openMenu}
              disabled={recording}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              ↓ Download
            </button>
            {menuOpen && (
              <div className="ds-dl-pop" role="menu">
                {/* Each option states its COST as well as its name — the formats differ by how
                    long they take and where they will play, and a menu of bare nouns hides
                    exactly the difference that decides which you want. */}
                {formats.length === 0 && (
                  <p className="ds-dl-note">
                    This browser cannot encode video. Chrome, Edge and Firefox can — the replay
                    data below works anywhere.
                  </p>
                )}
                {formats.map((f) => (
                  <button
                    key={f.id}
                    className="ds-dl-opt"
                    role="menuitem"
                    onClick={() => pick(() => void startCapture(f.id))}
                  >
                    <span className="dl-h">
                      {f.label}
                      <em>{f.fast ? '~10s' : mmss(runtime)}</em>
                    </span>
                    <span className="dl-d">{f.note}</span>
                  </button>
                ))}
                <button className="ds-dl-opt" role="menuitem" onClick={() => pick(downloadData)}>
                  <span className="dl-h">
                    Replay data
                    <em>{dataBytes ? `${Math.max(1, Math.round(dataBytes / 1024))} KB` : '.json'}</em>
                  </span>
                  <span className="dl-d">
                    Instant. The input log itself — re-playable in DSIM at full fidelity, but
                    only by a build running balance v{BALANCE_VERSION} and sim v{SIM_VERSION}.
                  </span>
                </button>
                <p className="ds-dl-note">
                  A replay is an input log, so it only plays on the sim that recorded it. This
                  one still matches this build — which is why it can be saved now.
                </p>
              </div>
            )}
          </div>
        ) : (
          <span style={{ width: 90 }} />
        )}
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
          {refusal && replay.current ? REFUSAL_TEXT[refusal](replay.current) : ''}
          {/* a FUTURE container is not a retired one — the score line would read as consolation
              for something a refresh fixes */}
          {refusal !== 'future' && ' The score on the leaderboard still stands.'}
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

      {/* RECORDING REPLACES THE TRANSPORT ROW rather than greying it out — a row of dead
          controls beside a "● REC 12%" label does not explain itself. What it says depends on
          which path is running: the FAST one is encoding off its own copy of the replay and is
          done in seconds, the real-time one is filming this canvas and needs the tab in front. */}
      {status === 'ready' && recording && (
        <div className="ds-replay-rec">
          <span className="rec-dot" aria-hidden="true" />
          <span className="rec-label">
            {fastCapture ? `Encoding ${videoFormat(capturing!).label}` : 'Recording video'}
          </span>
          <div
            className="rec-track"
            role="progressbar"
            aria-label="Recording progress"
            aria-valuenow={recPct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="rec-fill" style={{ width: `${recPct}%` }} />
          </div>
          <span className="rec-eta">{fastCapture ? `${recPct}%` : `${mmss(remaining)} left`}</span>
          <button className="ds-btn ghost" onClick={cancelRecording}>Cancel</button>
          <p className="rec-note">
            {fastCapture
              ? 'Encoding the whole match as fast as this machine manages — far quicker than watching it. The file saves itself when it finishes, and you can leave this tab.'
              : 'The match is being filmed off the screen in real time, so playback is locked until it finishes. Keep this tab in front — a hidden tab stops drawing, and the recording pauses with it. The file saves itself when the match ends.'}
          </p>
        </div>
      )}

      {status === 'ready' && !recording && (
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
