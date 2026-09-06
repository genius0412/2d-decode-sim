/**
 * A MINIMAL WEBM (MATROSKA) MUXER — enough for one video track, and nothing else.
 *
 * It exists because `MediaRecorder` cannot record faster than real time. It stamps frames by
 * when they ARRIVE, not by the timestamp the frame carries, so a replay pushed through it at
 * 10× comes out a tenth as long: measured, 300 frames explicitly stamped for 5.00s of video
 * produced files of 1.39s and 0.05s depending only on how fast they were written. A full match
 * therefore took a full match to save.
 *
 * `VideoEncoder` (WebCodecs) does honour the timestamp on every frame, so the sim can be run as
 * fast as it computes and each frame stamped at its true 1/60s position. What WebCodecs does
 * NOT do is produce a file — it hands back raw encoded chunks — so something has to wrap them
 * in a container. That is all this is.
 *
 * WHY NOT A LIBRARY: the client bundle is React + Rapier and nothing else (see CLAUDE.md), and
 * a muxer is the kind of thing that is small when you only need one track, no seeking index, no
 * audio, and no live streaming. Everything below is the WebM subset that Chrome, Firefox and
 * VLC will open; it is deliberately not a general-purpose Matroska writer.
 *
 * The format, briefly: a WebM file is nested EBML elements, each `[id][size][payload]`. Ids are
 * pre-encoded byte strings here because they are constants. Sizes use a variable-length integer
 * where the first set bit marks the width. Frames go in SimpleBlocks inside Clusters, each
 * block carrying a timecode RELATIVE to its cluster as a signed 16-bit value — which is the one
 * real constraint on the writer: a new cluster has to start before that can overflow.
 */

/** EBML element ids, pre-encoded (they are constants, so there is nothing to compute) */
const ID = {
  EBML: [0x1a, 0x45, 0xdf, 0xa3],
  EBMLVersion: [0x42, 0x86],
  EBMLReadVersion: [0x42, 0xf7],
  EBMLMaxIDLength: [0x42, 0xf2],
  EBMLMaxSizeLength: [0x42, 0xf3],
  DocType: [0x42, 0x82],
  DocTypeVersion: [0x42, 0x87],
  DocTypeReadVersion: [0x42, 0x85],
  Segment: [0x18, 0x53, 0x80, 0x67],
  Info: [0x15, 0x49, 0xa9, 0x66],
  TimecodeScale: [0x2a, 0xd7, 0xb1],
  MuxingApp: [0x4d, 0x80],
  WritingApp: [0x57, 0x41],
  Duration: [0x44, 0x89],
  Tracks: [0x16, 0x54, 0xae, 0x6b],
  TrackEntry: [0xae],
  TrackNumber: [0xd7],
  TrackUID: [0x73, 0xc5],
  TrackType: [0x83],
  CodecID: [0x86],
  Video: [0xe0],
  PixelWidth: [0xb0],
  PixelHeight: [0xba],
  Cluster: [0x1f, 0x43, 0xb6, 0x75],
  Timecode: [0xe7],
  SimpleBlock: [0xa3],
} as const;

/** EBML variable-length size. The first set bit marks the width, so 7 bits fit in one byte,
 *  14 in two, and so on — the same encoding the ids above already use. */
function vint(value: number): number[] {
  for (let width = 1; width <= 8; width++) {
    const max = 2 ** (7 * width) - 1;
    if (value < max) {
      const out = new Array<number>(width).fill(0);
      let v = value;
      for (let i = width - 1; i >= 0; i--) {
        out[i] = v & 0xff;
        v = Math.floor(v / 256);
      }
      out[0] |= 1 << (8 - width); // the length marker
      return out;
    }
  }
  throw new Error('webm: size too large');
}

/** big-endian unsigned integer, in as few bytes as it needs */
function uint(value: number): number[] {
  const out: number[] = [];
  let v = Math.max(0, Math.round(value));
  do {
    out.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return out;
}

/** IEEE-754 double, which is what Matroska's float elements are here */
function float64(value: number): number[] {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, false);
  return [...new Uint8Array(buf)];
}

/**
 * Everything is assembled as a LIST OF BYTE RUNS and joined once at the end, never as one
 * growing `number[]`. A video frame is tens of kilobytes and a match is thousands of them, so
 * the obvious `parts.push(...bytes)` overflows the call stack on the first real recording — it
 * spreads the whole frame into arguments. Measured: it threw on a five-second test clip.
 */
type Bytes = Uint8Array;
const u8 = (n: number[]): Bytes => new Uint8Array(n);
const size = (parts: Bytes[]): number => parts.reduce((n, p) => n + p.length, 0);

/** one EBML element: id, then its payload's length as a vint, then the payload */
const el = (id: readonly number[], payload: Bytes[]): Bytes[] => [
  u8([...id]),
  u8(vint(size(payload))),
  ...payload,
];
const str = (s: string): Bytes => new TextEncoder().encode(s);

function join(parts: Bytes[]): Uint8Array {
  const out = new Uint8Array(size(parts));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * The frames of a cluster, plus the machinery to start a new one.
 *
 * A SimpleBlock's timecode is a SIGNED 16-BIT offset from its cluster, so a cluster cannot span
 * more than ~32s even in principle. Real files start one every second or so anyway, because a
 * cluster is also the unit a player seeks to and a decoder resynchronises on — one enormous
 * cluster is a file you cannot scrub.
 */
const CLUSTER_MS = 1000;

export interface WebmFrame {
  data: Uint8Array;
  /** microseconds, as WebCodecs reports them */
  timestamp: number;
  keyframe: boolean;
}

/**
 * Mux encoded VP8/VP9 frames into a WebM blob.
 *
 * `frames` must be in presentation order and start at (or near) zero — which is what the
 * caller gets for free by stamping frame `i` at `i / fps`. The first frame must be a keyframe;
 * `VideoEncoder` always makes it one.
 */
export function muxWebm(
  frames: WebmFrame[],
  opts: { width: number; height: number; codec: 'V_VP8' | 'V_VP9' },
): Blob {
  if (frames.length === 0) throw new Error('webm: nothing to mux');
  const durationMs = frames[frames.length - 1].timestamp / 1000;

  const header = el(ID.EBML, [
    ...el(ID.EBMLVersion, [u8(uint(1))]),
    ...el(ID.EBMLReadVersion, [u8(uint(1))]),
    ...el(ID.EBMLMaxIDLength, [u8(uint(4))]),
    ...el(ID.EBMLMaxSizeLength, [u8(uint(8))]),
    ...el(ID.DocType, [str('webm')]),
    ...el(ID.DocTypeVersion, [u8(uint(2))]),
    ...el(ID.DocTypeReadVersion, [u8(uint(2))]),
  ]);

  // TimecodeScale 1e6 ns = 1 ms, so every timecode below is plain milliseconds
  const info = el(ID.Info, [
    ...el(ID.TimecodeScale, [u8(uint(1_000_000))]),
    ...el(ID.MuxingApp, [str('DSIM')]),
    ...el(ID.WritingApp, [str('DSIM')]),
    ...el(ID.Duration, [u8(float64(durationMs))]),
  ]);

  const tracks = el(ID.Tracks, [
    ...el(ID.TrackEntry, [
      ...el(ID.TrackNumber, [u8(uint(1))]),
      ...el(ID.TrackUID, [u8(uint(1))]),
      ...el(ID.TrackType, [u8(uint(1))]), // 1 = video
      ...el(ID.CodecID, [str(opts.codec)]),
      ...el(ID.Video, [
        ...el(ID.PixelWidth, [u8(uint(opts.width))]),
        ...el(ID.PixelHeight, [u8(uint(opts.height))]),
      ]),
    ]),
  ]);

  const clusters: Bytes[] = [];
  let i = 0;
  while (i < frames.length) {
    const baseMs = Math.round(frames[i].timestamp / 1000);
    const blocks: Bytes[] = [];
    /**
     * Keep filling this cluster while the relative timecode still fits and its span is not up.
     * A new cluster must begin on a KEYFRAME, or a player that seeks to it has nothing to start
     * decoding from; the 32000 guard is the signed-16-bit ceiling on that relative timecode,
     * which applies whatever the keyframes are doing.
     */
    while (i < frames.length) {
      const f = frames[i];
      const rel = Math.round(f.timestamp / 1000) - baseMs;
      if (rel > CLUSTER_MS && f.keyframe) break;
      if (rel > 32000) break;
      // appended one at a time: `push(...parts)` is thousands of arguments over a full match,
      // which is the same spread-into-arguments overflow this file already documents
      for (const part of el(ID.SimpleBlock, [
        u8([...vint(1), (rel >> 8) & 0xff, rel & 0xff, f.keyframe ? 0x80 : 0x00]),
        f.data,
      ])) blocks.push(part);
      i++;
    }
    for (const part of el(ID.Cluster, [...el(ID.Timecode, [u8(uint(baseMs))]), ...blocks])) {
      clusters.push(part);
    }
  }

  const segment = el(ID.Segment, [...info, ...tracks, ...clusters]);
  // `.buffer` is exact — `join` allocates the precise length — and Blob wants an ArrayBuffer
  return new Blob([join([...header, ...segment]).buffer as ArrayBuffer], { type: 'video/webm' });
}
