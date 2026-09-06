import { muxWebm, type WebmFrame } from './webm';
import { muxMp4 } from './mp4';

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
 * ONE PATH NOW, and it is `VideoEncoder` (WebCodecs) plus the two little muxers next door. It
 * encodes frames the caller hands it, each carrying its own timestamp, so the replay can be
 * simulated and drawn as fast as the machine manages while the file still comes out the right
 * LENGTH. All three formats go through it, MP4 included.
 *
 * `MediaRecorder` survives ONLY as the fallback for a browser with no H.264 in WebCodecs. It
 * cannot go faster than real time and never will, because it stamps frames by when they ARRIVE
 * rather than by the timestamp they carry: measured, 300 frames explicitly stamped for 5.00s of
 * video came out as files of 1.39s and 0.05s depending only on how quickly they were written.
 *
 * ⚠️ THE QUALITY PROBLEM WAS RESOLUTION, NOT BITRATE — measured, against every guess.
 *
 * Reported as "video quality is horrible", the obvious suspects were the rate control and the
 * `latencyMode: 'realtime'` this used to ship. Both turned out to be nearly irrelevant. Encoding
 * the same 7s of match and scoring each result against the scene re-rendered at 1920 (PSNR over
 * three sampled frames):
 *
 *   old path, 2× render downsampled to 1280, realtime  1.84 Mbps   **35.5 dB**
 *   1920 native, quantizer 34                          1.52 Mbps   42.25 dB
 *   1920 native, quantizer 22                          1.88 Mbps   42.40 dB
 *   1920 native, quantizer 10                          2.47 Mbps   42.55 dB
 *
 * Nearly SEVEN dB, all of it from drawing the frame at the size it is encoded at instead of
 * shrinking a bigger one — while sweeping the quantizer across its whole useful range moves
 * 0.3 dB and 1.6× the file size. (The ~42.5 dB ceiling is 4:2:0 chroma subsampling, which no
 * encoder setting here can buy back.) The rate control is set deliberately anyway, because
 * "barely matters on this content" is not "cannot matter on any", but the ORDER of the two
 * facts is the point: a bitrate argued about in the abstract cost real time here.
 *
 * `latencyMode` is `'quality'` regardless, because it is simply the truthful description: every
 * frame is in hand and the file is written at the end, so there is no deadline to trade against.
 */

export type VideoFormatId = 'webm-vp9' | 'webm-vp8' | 'mp4';

export interface VideoFormat {
  id: VideoFormatId;
  label: string;
  /** what picking it costs or buys, in the words the menu shows */
  note: string;
  ext: string;
  /** false ⇒ this browser can only reach the format through `MediaRecorder`, i.e. the
   *  recording takes as long as the match. Resolved by `availableVideoFormats`. */
  fast: boolean;
}

/**
 * MP4 IS FIRST, AND THAT IS THE POINT: it is the format every platform can both produce and
 * play, so a replay saved on one machine is the same file as a replay saved on another. The
 * menu is ordered, and `availableVideoFormats` preserves that order, so the top entry is what
 * people take unless they have a reason not to — and if that entry varied by browser, so would
 * everybody's archive.
 *
 * The WebM pair stay for the people who want them: VP9 is a smaller file at the same quality,
 * VP8 opens in older players. Both are browser formats, which is exactly why neither is the
 * default — a phone or a video editor is where these end up.
 */
const FORMATS: VideoFormat[] = [
  {
    id: 'mp4',
    label: 'MP4 · H.264',
    note: 'Plays on any device. Use this one unless you need something else.',
    ext: 'mp4',
    fast: true,
  },
  {
    id: 'webm-vp9',
    label: 'WebM · VP9',
    note: 'Smaller file, same picture. Plays in browsers.',
    ext: 'webm',
    fast: true,
  },
  {
    id: 'webm-vp8',
    label: 'WebM · VP8',
    note: 'Older WebM, for players that will not open VP9.',
    ext: 'webm',
    fast: true,
  },
];

/** what the MP4 option has to say for itself where WebCodecs has no H.264 encoder */
const MP4_SLOW_NOTE =
  'Plays on any device, but this browser can only film it in real time, so it takes the full match.';

const VP9 = 'vp09.00.10.08';
/**
 * H.264 profile/level candidates, best first. The LEVEL has to cover the frame size and rate
 * (5.1 carries 4K60, so it covers anything this exports) and the PROFILE decides how much the
 * encoder is allowed to do with the bits — High is worth real quality over Baseline on flat
 * synthetic content like a field mat. Every one of them is ordinary H.264 that a decade-old
 * phone decodes; the list is a fallback chain, not a compatibility gamble.
 */
const H264_CODECS = ['avc1.640033', 'avc1.4d0033', 'avc1.640028', 'avc1.4d0028', 'avc1.42e01f'];
const MP4_MIMES = ['video/mp4;codecs=avc1', 'video/mp4'];

const hasWebCodecs = (): boolean =>
  typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';

const mp4Mime = (): string | null =>
  typeof MediaRecorder === 'undefined'
    ? null
    : (MP4_MIMES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null);

/**
 * BITS PER PIXEL PER FRAME, which is the only honest way to write a bitrate down: the number
 * that matters is how many bits each pixel gets, and a fixed Mbps means something different at
 * every resolution the viewer can be laid out at.
 *
 * Read these as a CEILING rather than a target. On synthetic content — flat fills, hard edges,
 * small text — every encoder here settles well under what it is offered and self-regulates on
 * quality instead: VP9 handed 20 Mbps at 1920 spent 1.7 of them. So the budget's job is only to
 * stay out of the way, and it is set generously for that. VP8 gets the most because it is the
 * oldest codec here and the least able to spend a bit well, and it is also the one that cannot
 * be quantizer-locked (below), so the budget is the only control it has.
 */
const BITS_PER_PIXEL: Record<VideoFormatId, number> = {
  'webm-vp9': 0.12,
  'webm-vp8': 0.20,
  mp4: 0.15,
};

/**
 * RATE CONTROL, per format. `quantizer` mode fixes the QUALITY and lets the size fall where it
 * may, which is the right shape for an export nobody is streaming — and, unlike the bitrate, it
 * is a knob the encoder demonstrably RESPONDS to (sweeping it moved the file 1.5→2.5 Mbps while
 * the same sweep of `bitrate` moved nothing at all).
 *
 * The values sit at the flat end of the quality curve rather than at its floor, because past
 * this point the extra bits buy tenths of a dB. VP8 is absent because Chrome refuses
 * `bitrateMode: 'quantizer'` for it outright — it falls through to the budget above, which
 * lands it in the same place.
 */
const QUANTIZER: Partial<Record<VideoFormatId, number>> = {
  'webm-vp9': 22,
  mp4: 20,
};

/** the encode budget for a given frame size and rate, floored so a small window still looks
 *  right and capped so a big one cannot write a gigabyte */
export function videoBitrate(id: VideoFormatId, w: number, h: number, fps: number): number {
  const want = w * h * fps * BITS_PER_PIXEL[id];
  return Math.round(Math.min(24_000_000, Math.max(5_000_000, want)));
}

/** a settled encoder configuration, plus the per-frame quantizer it wants (null ⇒ this
 *  browser would not take quantizer mode and the config is running on its bitrate) */
interface Encoding {
  config: VideoEncoderConfig;
  quantizer: number | null;
}

/**
 * The encoder config for a format at a size, or null if this browser will not take it at all.
 *
 * TWO fallback chains, and both exist because a browser answers "no" by producing nothing
 * rather than by complaining. The CODEC chain walks H.264 profiles down from High, so an
 * encoder that will not do High still gets an MP4. The RATE chain drops quantizer mode for the
 * plain budget, because `bitrateMode: 'quantizer'` is not everywhere — Chrome itself refuses it
 * for VP8 — and the measurements say the two land within a few tenths of a dB of each other.
 */
async function encoderConfig(
  id: VideoFormatId,
  width: number,
  height: number,
  fps: number,
): Promise<Encoding | null> {
  if (!hasWebCodecs()) return null;
  const base: VideoEncoderConfig = {
    codec: '',
    width,
    height,
    bitrate: videoBitrate(id, width, height, fps),
    framerate: fps,
    // a BATCH encode, with the whole file written at the end and nobody waiting on any single
    // frame — so let the encoder search properly rather than to a deadline
    latencyMode: 'quality',
  };
  const codecs = id === 'mp4' ? H264_CODECS : [id === 'webm-vp9' ? VP9 : 'vp8'];
  const q = QUANTIZER[id];
  const rates: { mode: VideoEncoderBitrateMode; quantizer: number | null }[] =
    q == null
      ? [{ mode: 'variable', quantizer: null }]
      : [
          { mode: 'quantizer', quantizer: q },
          { mode: 'variable', quantizer: null },
        ];
  for (const rate of rates) {
    for (const codec of codecs) {
      // MP4 needs LENGTH-PREFIXED NAL units and the AVC decoder record as a `description`;
      // annex-B (the default on some builds) has neither, and the muxer cannot use it
      const config: VideoEncoderConfig = {
        ...base,
        codec,
        bitrateMode: rate.mode,
        ...(id === 'mp4' ? { avc: { format: 'avc' as const } } : {}),
      };
      try {
        if ((await VideoEncoder.isConfigSupported(config)).supported) {
          return { config, quantizer: rate.quantizer };
        }
      } catch {
        /* an unparseable codec string throws rather than answering false — try the next */
      }
    }
  }
  return null;
}

/**
 * The quantizer option is CODEC-SCOPED, not a flat field — `{ vp9: { quantizer } }`, not
 * `{ quantizer }`. Passing it flat is accepted silently and ignored completely, which reads
 * exactly like an encoder that does not honour the setting; it cost a whole measurement round
 * before the sweep's three identical file sizes gave it away.
 */
const quantizerOption = (id: VideoFormatId, q: number): VideoEncoderEncodeOptions =>
  (id === 'mp4' ? { avc: { quantizer: q } } : { vp9: { quantizer: q } }) as VideoEncoderEncodeOptions;

/** probed once: what this browser can encode does not change under it */
let probed: VideoFormat[] | null = null;

/**
 * The formats this browser can actually produce, best first — feature-detected rather than
 * sniffed, because "will this produce a file" has no other honest answer, and the answer
 * includes HOW LONG it will take. Empty means no video export at all and the caller should
 * fall back to the JSON one.
 *
 * It is async because `isConfigSupported` is: whether a codec is present is a cheap `typeof`,
 * but whether the encoder will accept a profile at a size is a question only the browser can
 * answer, and guessing it is how a menu ends up offering a button that produces nothing.
 */
export async function availableVideoFormats(): Promise<VideoFormat[]> {
  if (probed) return probed;
  const out: VideoFormat[] = [];
  for (const f of FORMATS) {
    // a nominal probe size: the real one is re-checked in `recordFast`, which falls back
    if (await encoderConfig(f.id, 1280, 720, 60)) out.push(f);
    else if (f.id === 'mp4' && mp4Mime()) out.push({ ...f, fast: false, note: MP4_SLOW_NOTE });
  }
  probed = out;
  return out;
}

export const videoFormat = (id: VideoFormatId): VideoFormat =>
  probed?.find((f) => f.id === id) ?? FORMATS.find((f) => f.id === id) ?? FORMATS[0];

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
 * This is a RENDER size, not a downsample target — the caller draws the replay straight into a
 * canvas of exactly this size, at whatever device-pixel ratio that works out to. It used to
 * render at the viewer's own 2496×1074 and shrink each frame with `drawImage`, which was both
 * slower (2.7 megapixels rasterised 9,724 times and then thrown away) and, as the header
 * records, the entire quality problem: a >2× canvas downscale is a cheap bilinear filter, and
 * what it turns to mush is exactly the thin white tape lines and the small scoreboard type.
 * Drawing at the target is a real render at that resolution, so the text is laid out for the
 * pixels it gets.
 *
 * 1920 rather than more: it is the size H.264 is certain to take (2496 came back UNSUPPORTED
 * from the same encoder that accepted 1920), it is what everything plays, and the encode cost
 * is real — 5.3× real time here against 5.7× at 1280, i.e. a 2:42 match in about half a minute.
 */
const MAX_EDGE = 1920;

/**
 * The encoded size for a canvas's LAYOUT (in CSS pixels): the long edge lands on `MAX_EDGE`,
 * the aspect is kept, and both edges come out EVEN — every codec here wants even dimensions
 * and some quietly refuse odd ones.
 *
 * It scales UP as readily as down, which is the whole point and was worth getting wrong once:
 * clamped at 1× it produced a 1280-wide video on a 1280-wide window, i.e. exactly the
 * resolution the header blames for the quality complaint. The layout is in CSS units and the
 * device-pixel ratio is the only thing tying those to pixels, so raising it renders the SAME
 * layout with more pixels in it — the text keeps its size on screen and gains detail.
 */
export function encodeSize(w: number, h: number): { width: number; height: number } {
  const scale = MAX_EDGE / Math.max(w, h);
  const even = (n: number): number => Math.max(2, Math.round((n * scale) / 2) * 2);
  return { width: even(w), height: even(h) };
}

export interface FastRecordOpts {
  format: VideoFormatId;
  /** the size to encode — the caller must have sized its canvas to exactly this */
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

/** one encoded frame, plus whether it can be seeked to */
interface Chunked {
  data: Uint8Array;
  timestamp: number;
  keyframe: boolean;
}

/**
 * Encode a replay as fast as the machine will go.
 *
 * The caller drives the SIM (it owns the player and the renderer); this owns the encoder, the
 * pacing and the container. Frame `i` is stamped at exactly `i / fps`, which is what makes the
 * output the true length of the match no matter how quickly it was produced.
 *
 * Returns null when this browser cannot encode the format at this size — the caller falls back,
 * to the real-time path for MP4 and to the JSON export otherwise.
 */
export async function recordFast(opts: FastRecordOpts): Promise<Blob | null> {
  const mp4 = opts.format === 'mp4';
  const { width, height } = opts;
  // A canvas with no SIZE has nothing to encode, and the failure is otherwise silent: the
  // encoder accepts a 2×2 config quite happily, every frame comes out empty, and the caller
  // quietly downloads the JSON instead. It happens whenever the viewer has not been laid out.
  if (width < 16 || height < 16) return null;

  const encoding = await encoderConfig(opts.format, width, height, opts.fps);
  if (!encoding) return null;
  const qopt = encoding.quantizer == null ? {} : quantizerOption(opts.format, encoding.quantizer);

  const frames: Chunked[] = [];
  let failed: unknown = null;
  /** H.264's SPS/PPS, which the MP4 muxer cannot write a playable file without. WebCodecs
   *  hands it over on the FIRST chunk's metadata and never again. */
  let description: Uint8Array | null = null;

  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const desc = metadata?.decoderConfig?.description;
      // COPIED, not referenced: the encoder owns that buffer and it may be shared memory
      if (desc && !description) {
        description = (
          ArrayBuffer.isView(desc)
            ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength)
            : new Uint8Array(desc)
        ).slice();
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      frames.push({ data, timestamp: chunk.timestamp, keyframe: chunk.type === 'key' });
    },
    error: (e) => {
      failed = e;
    },
  });
  encoder.configure(encoding.config);

  try {
    for (let i = 0; i < opts.frames; i++) {
      if (opts.cancelled?.()) {
        encoder.close();
        return null;
      }
      opts.draw(i);
      const frame = new VideoFrame(opts.source, {
        timestamp: Math.round((i * 1e6) / opts.fps),
        duration: Math.round(1e6 / opts.fps),
      });
      // a keyframe every two seconds: it is what a player seeks to, and the WebM muxer starts
      // a new cluster on one
      encoder.encode(frame, { keyFrame: i % (opts.fps * 2) === 0, ...qopt });
      frame.close();
      // never let the queue run away — an unbounded encode queue is unbounded memory, and
      // yielding here is also what lets the progress bar repaint
      if (encoder.encodeQueueSize > 8) await yieldToBrowser();
      if (i % 15 === 0) opts.onProgress?.(i / opts.frames);
    }
    await encoder.flush();
  } catch {
    if (encoder.state !== 'closed') encoder.close();
    return null;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  if (failed || frames.length === 0) return null;
  opts.onProgress?.(1);

  if (mp4) {
    // no decoder record ⇒ no playable MP4. Better to hand back null and let the caller film it
    // in real time than to save a file that opens as a black rectangle.
    if (!description) return null;
    return muxMp4(frames, { width, height, fps: opts.fps, description });
  }
  return muxWebm(frames as WebmFrame[], {
    width,
    height,
    codec: opts.format === 'webm-vp9' ? 'V_VP9' : 'V_VP8',
  });
}

/** the MediaRecorder mime for the real-time fallback (MP4 only, and only where WebCodecs has
 *  no H.264 encoder) */
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
