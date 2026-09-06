import { muxWebm, type WebmFrame } from './webm';

/**
 * Recording a replay to a VIDEO FILE.
 *
 * A replay is an input log, and `replayRefusal` retires one the moment SIM_VERSION moves —
 * deliberately, because a changed sim re-simulates the same inputs into a different game. So the
 * container is a perishable artifact: exact today, refused after the next patch.
 *
 * A video is the opposite. It stops being a re-simulation and becomes a recording, which means
 * it outlives every patch, needs no sim to watch, and can be shared with someone who does not
 * have DSIM at all.
 *
 * TWO PATHS, and the difference is the whole reason this file is interesting.
 *
 * The FAST one is `VideoEncoder` (WebCodecs) plus the little WebM muxer next door. It encodes
 * frames the caller hands it, each carrying its own timestamp, so the replay can be simulated
 * and drawn as fast as the machine manages while the file still comes out the right LENGTH.
 * Measured on this box: 10-19× real time, so a 2:30 match saves in ten seconds or so.
 *
 * The SLOW one is `MediaRecorder` over `canvas.captureStream()`, which is what this used to do
 * exclusively. It cannot go faster than real time and never will, because it stamps frames by
 * when they ARRIVE rather than by the timestamp they carry: measured, 300 frames explicitly
 * stamped for 5.00s of video came out as files of 1.39s and 0.05s depending only on how quickly
 * they were written. It is kept for MP4, which needs a muxer this file does not have, and as
 * the fallback wherever WebCodecs is missing.
 */

export type VideoFormatId = 'webm-vp9' | 'webm-vp8' | 'mp4';

export interface VideoFormat {
  id: VideoFormatId;
  label: string;
  /** what picking it costs or buys, in the words the menu shows */
  note: string;
  ext: string;
  /** false ⇒ MediaRecorder, i.e. the recording takes as long as the match */
  fast: boolean;
}

/**
 * WHY THESE THREE. VP9 is the default because it is the best size/quality per encode second
 * and every current browser plays it. VP8 is there because it is faster still and the widest
 * WebM any old player will open. MP4 is there because it is the one everybody's phone, editor
 * and messaging app takes without thinking — and it is slow purely because muxing H.264 is a
 * second container format, not a second encoder.
 */
const FORMATS: VideoFormat[] = [
  {
    id: 'webm-vp9',
    label: 'WebM · VP9',
    note: 'Best quality for the size. Saves in seconds.',
    ext: 'webm',
    fast: true,
  },
  {
    id: 'webm-vp8',
    label: 'WebM · VP8',
    note: 'Fastest, and the most widely playable WebM.',
    ext: 'webm',
    fast: true,
  },
  {
    id: 'mp4',
    label: 'MP4 · H.264',
    note: 'For phones and video editors — but records in real time, so it takes the whole match.',
    ext: 'mp4',
    fast: false,
  },
];

const VP9 = 'vp09.00.10.08';
const MP4_MIMES = ['video/mp4;codecs=avc1', 'video/mp4'];

const hasWebCodecs = (): boolean =>
  typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';

const mp4Mime = (): string | null =>
  typeof MediaRecorder === 'undefined'
    ? null
    : (MP4_MIMES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null);

/**
 * The formats this browser can actually produce, best first — feature-detected rather than
 * sniffed, because "will this produce a file" has no other honest answer. Empty means no video
 * export at all and the caller should fall back to the JSON one.
 */
export function availableVideoFormats(): VideoFormat[] {
  const out: VideoFormat[] = [];
  if (hasWebCodecs()) out.push(...FORMATS.filter((f) => f.fast));
  if (mp4Mime()) out.push(...FORMATS.filter((f) => f.id === 'mp4'));
  return out;
}

export const videoFormat = (id: VideoFormatId): VideoFormat =>
  FORMATS.find((f) => f.id === id) ?? FORMATS[0];

/**
 * Hand the event loop back WITHOUT `setTimeout`.
 *
 * A background or unpainted tab clamps `setTimeout(…, 0)` to about a second, so a capture loop
 * that yields that way stops dead the moment the tab is not in front — which is exactly when
 * somebody leaves it to encode. It cost a benchmark before it was noticed: the same VP9 encode
 * read 0.6× real time on a hidden tab and 13× once the yield stopped being throttled. A
 * MessageChannel message is an ordinary task and is not clamped.
 */
export const yieldToBrowser = (): Promise<void> =>
  new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });

/**
 * Longest edge of the encoded video.
 *
 * The replay canvas is sized by LAYOUT × devicePixelRatio, which on an ordinary desktop is
 * 2496×1074 — 2.7 megapixels, encoded 9,724 times for one match. Measured, that is what turned
 * a ten-second job into one that had not finished after two and a half minutes. Nothing about a
 * top-down field needs that: 1280 on the long edge is sharp for the scoreboard text and about a
 * quarter of the pixels. The source is still drawn at full size and scaled on the way in, so
 * what is encoded is a clean downsample rather than a coarser render.
 */
const MAX_EDGE = 1280;

/** the encoded size for a given canvas: capped, aspect kept, both edges EVEN (codecs prefer it) */
export function encodeSize(w: number, h: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const even = (n: number): number => Math.max(2, Math.round(n * scale / 2) * 2);
  return { width: even(w), height: even(h) };
}

export interface FastRecordOpts {
  format: VideoFormatId;
  /** the SOURCE canvas size; the encode is `encodeSize` of it */
  width: number;
  height: number;
  fps: number;
  /** total frames to encode — the caller's replay length */
  frames: number;
  /** draw frame `i`; the caller owns the sim and the canvas */
  draw: (i: number) => void;
  /** the canvas `draw` renders into */
  source: HTMLCanvasElement;
  /** called with 0..1 so the UI can show progress; also the abort point */
  onProgress?: (done: number) => void;
  /** return true to stop early and throw away the partial file */
  cancelled?: () => boolean;
}

/**
 * Encode a replay as fast as the machine will go.
 *
 * The caller drives the SIM (it owns the player and the renderer); this owns the encoder, the
 * pacing and the container. Frame `i` is stamped at exactly `i / fps`, which is what makes the
 * output the true length of the match no matter how quickly it was produced.
 */
export async function recordFast(opts: FastRecordOpts): Promise<Blob | null> {
  const fmt = videoFormat(opts.format);
  const vp9 = fmt.id === 'webm-vp9';
  const frames: WebmFrame[] = [];
  let failed: unknown = null;
  // the downsample target, plus the scratch canvas every frame is drawn into on the way to the
  // encoder. One `drawImage` per frame buys back three quarters of the pixels.
  const { width, height } = encodeSize(opts.width, opts.height);
  // A canvas with no SIZE has nothing to encode, and the failure is otherwise silent: the
  // encoder accepts a 2×2 config quite happily, every frame comes out empty, and the caller
  // quietly downloads the JSON instead. It happens whenever the viewer has not been laid out.
  if (width < 16 || height < 16) return null;
  const scratch = new OffscreenCanvas(width, height);
  const sctx = scratch.getContext('2d')!;

  const encoder = new VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      frames.push({ data, timestamp: chunk.timestamp, keyframe: chunk.type === 'key' });
    },
    error: (e) => {
      failed = e;
    },
  });
  const config: VideoEncoderConfig = {
    codec: vp9 ? VP9 : 'vp8',
    width,
    height,
    bitrate: 6_000_000,
    framerate: opts.fps,
    // the field is flat colour with hard edges, and this is a batch encode with nobody
    // waiting on any single frame — but realtime keeps the encoder from hoarding a deep
    // lookahead, which is what makes progress move smoothly instead of in lurches
    latencyMode: 'realtime',
  };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) {
    encoder.close();
    return null;
  }
  encoder.configure(config);

  try {
    for (let i = 0; i < opts.frames; i++) {
      if (opts.cancelled?.()) {
        encoder.close();
        return null;
      }
      opts.draw(i);
      sctx.drawImage(opts.source, 0, 0, width, height);
      const frame = new VideoFrame(scratch, {
        timestamp: Math.round((i * 1e6) / opts.fps),
        duration: Math.round(1e6 / opts.fps),
      });
      // a keyframe every two seconds: it is what a player seeks to, and the muxer starts a
      // new cluster on one
      encoder.encode(frame, { keyFrame: i % (opts.fps * 2) === 0 });
      frame.close();
      // never let the queue run away — an unbounded encode queue is unbounded memory, and
      // yielding here is also what lets the progress bar repaint
      if (encoder.encodeQueueSize > 20) await yieldToBrowser();
      if (i % 15 === 0) opts.onProgress?.(i / opts.frames);
    }
    await encoder.flush();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  if (failed || frames.length === 0) return null;
  opts.onProgress?.(1);
  return muxWebm(frames, { width, height, codec: vp9 ? 'V_VP9' : 'V_VP8' });
}

/** the MediaRecorder mime for the real-time path (MP4 only now) */
export const realtimeMime = (): string | null => mp4Mime();

/**
 * Hand a finished blob to the browser as a download.
 *
 * Shared by the video and the JSON export so the object-URL lifetime is handled in ONE place:
 * the URL pins the blob in memory until revoked, and `a.click()` is synchronous only as far as
 * STARTING the download — revoking immediately can cut it off before the browser has taken the
 * handle, so it waits a tick.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
