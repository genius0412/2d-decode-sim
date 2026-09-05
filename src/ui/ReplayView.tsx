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
import { pickVideoMime, videoExt, saveBlob } from './replayVideo';
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
  /** measured ONCE: whether this browser can encode video at all decides what the menu offers,
   *  and this component re-renders 10 times a second off the progress readout. */
  const [videoMime] = useState<string | null>(() => pickVideoMime());

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

  const startRecording = (): void => {
    const canvas = canvasRef.current;
    const mime = videoMime;
    // no MediaRecorder (some embedded webviews) or no container it will encode ⇒ the data
    // export is the honest fallback rather than a button that silently does nothing. The menu
    // already says so and disables the option; this is the belt to that braces.
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
  // the capture runs at 1×, so what is left of the REPLAY is what is left of the recording
  const runtime = total * SIM_DT;
  const remaining = Math.max(0, total - tick) * SIM_DT;

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
                {/* Each option states its COST as well as its name — one takes the length of
                    the match and one is instant, and a menu of two nouns hides exactly the
                    difference that decides which you want. */}
                <button
                  className="ds-dl-opt"
                  role="menuitem"
                  onClick={() => pick(startRecording)}
                  disabled={!videoMime}
                >
                  <span className="dl-h">
                    Video<em>{videoMime ? `.${videoExt(videoMime)}` : 'unsupported'}</em>
                  </span>
                  <span className="dl-d">
                    {videoMime
                      ? `Plays the match through and records the screen, so it takes the full ${mmss(runtime)} in real time. Watchable anywhere, by anyone, and it keeps working after DSIM updates.`
                      : 'This browser cannot record video. Chrome, Edge and Firefox can.'}
                  </span>
                </button>
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

      {/* RECORDING REPLACES THE TRANSPORT, it does not sit inside it. Every playback control is
          locked while a capture runs — the video is of THIS canvas, so pausing or scrubbing
          mid-record would pause or scrub the FILE — and a row of four dead controls beside a
          "● REC 12%" label does not say that. This says what is happening, how much longer it
          takes, why the tab has to stay in front, and offers the one action still available. */}
      {status === 'ready' && recording && (
        <div className="ds-replay-rec">
          <span className="rec-dot" aria-hidden="true" />
          <span className="rec-label">Recording video</span>
          <div
            className="rec-track"
            role="progressbar"
            aria-label="Recording progress"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="rec-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="rec-eta">{mmss(remaining)} left</span>
          <button className="ds-btn ghost" onClick={cancelRecording}>Cancel</button>
          <p className="rec-note">
            The match is being captured off the screen in real time, so playback is locked until
            it finishes. Keep this tab in front — a hidden tab stops drawing, and the recording
            pauses with it. The file saves itself when the match ends.
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
