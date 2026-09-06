/**
 * A MINIMAL MP4 (ISO BMFF) MUXER — one H.264 video track, and nothing else.
 *
 * It is the twin of `webm.ts`, and it exists for the same reason: `VideoEncoder` hands back
 * raw encoded chunks, not a file, so something has to wrap them in a container. WebM covered
 * VP8/VP9; this is what lets MP4 stop being the slow format.
 *
 * MP4 was the one export still going through `MediaRecorder`, which cannot beat real time —
 * it stamps frames by when they ARRIVE rather than by the timestamp they carry, so a 2:42
 * match took 2:42 to save. Nothing about H.264 required that. The ENCODER was always fast
 * (browsers ship an H.264 encoder to `VideoEncoder`, usually a hardware one); the only thing
 * missing was a second CONTAINER, which is this file.
 *
 * WHY NOT A LIBRARY: the client bundle is React + Rapier and nothing else (CLAUDE.md), and a
 * muxer is small when you need exactly one track, no fragments, no audio and no streaming.
 *
 * The format, briefly: an MP4 is nested BOXES, each `[u32 size][4-char type][payload]`. The
 * bytes of the video live in one `mdat`; everything needed to find them lives in `moov`, which
 * is a set of parallel TABLES over the samples — how long each lasts (`stts`), how big it is
 * (`stsz`), which ones are seekable (`stss`), and where the chunks start (`stco`).
 *
 * TWO THINGS ARE EASY TO GET WRONG HERE, and both fail silently:
 *
 *  1. `stco` holds ABSOLUTE FILE OFFSETS, so it cannot be written until the size of the `moov`
 *     in front of it is known. `moov` is therefore built TWICE — once to measure, once for
 *     real. The two passes are the same length because the offset is a fixed-width field,
 *     which is the thing that makes the trick safe rather than merely lucky.
 *  2. Chunks come out of an encoder in DECODE order, and with B-frames that is not
 *     presentation order. Writing the timestamps as if it were produces a file whose frames
 *     play out of sequence. `ctts` carries the difference; it is emitted only when there
 *     actually is one, which for today's browser encoders is never — but "never today" is not
 *     something to bake into a file format.
 */

type Bytes = Uint8Array;

const size = (parts: Bytes[]): number => parts.reduce((n, p) => n + p.byteLength, 0);
const bytes = (...n: number[]): Bytes => new Uint8Array(n);
const zeros = (n: number): Bytes => new Uint8Array(n);
const TEXT = new TextEncoder();

const u16 = (v: number): Bytes => {
  const a = new Uint8Array(2);
  new DataView(a.buffer).setUint16(0, v);
  return a;
};

const u32 = (v: number): Bytes => {
  const a = new Uint8Array(4);
  new DataView(a.buffer).setUint32(0, v >>> 0);
  return a;
};

/** many big-endian u32s in ONE run — the sample tables are thousands of entries long, and a
 *  separate array per entry (or a spread into arguments) is how that falls over on a real
 *  recording rather than on a five-second test */
const u32s = (vals: ArrayLike<number>): Bytes => {
  const a = new Uint8Array(vals.length * 4);
  const d = new DataView(a.buffer);
  for (let i = 0; i < vals.length; i++) d.setUint32(i * 4, vals[i] >>> 0);
  return a;
};

/** 16.16 fixed point, which is how MP4 writes every dimension and rate */
const fixed = (v: number): Bytes => u32(Math.round(v * 65536));

/** `[size][type][payload]` */
function box(type: string, payload: Bytes[]): Bytes[] {
  const head = new Uint8Array(8);
  new DataView(head.buffer).setUint32(0, 8 + size(payload));
  head.set(TEXT.encode(type), 4);
  return [head, ...payload];
}

/** a box whose payload opens with a version byte and 24 bits of flags */
const full = (type: string, version: number, flags: number, payload: Bytes[]): Bytes[] =>
  box(type, [bytes(version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff), ...payload]);

/** the unity transform every single-track file writes */
const MATRIX = u32s([0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]);

export interface Mp4Frame {
  data: Uint8Array;
  /** microseconds, as WebCodecs reports them; the array is in DECODE order */
  timestamp: number;
  keyframe: boolean;
}

export interface Mp4Opts {
  width: number;
  height: number;
  fps: number;
  /** the AVCDecoderConfigurationRecord, straight off the encoder's first `decoderConfig`.
   *  Without it a decoder has no SPS/PPS and the file is unplayable, which is why the caller
   *  must configure the encoder with `avc: { format: 'avc' }` and keep what it hands back. */
  description: Uint8Array;
}

/**
 * Mux encoded H.264 samples into a progressive MP4.
 *
 * `moov` is written BEFORE `mdat` ("faststart"), which costs nothing here — every sample is
 * already in hand, so the tables can be complete before a byte is written — and is what makes
 * the file usable by something streaming it rather than only by something holding all of it.
 */
export function muxMp4(frames: Mp4Frame[], opts: Mp4Opts): Blob {
  if (frames.length === 0) throw new Error('mp4: nothing to mux');
  if (opts.description.byteLength === 0) throw new Error('mp4: no decoder configuration');

  const n = frames.length;
  /**
   * The media timescale is `fps × 1000`, so one frame lasts EXACTLY 1000 ticks at any integer
   * frame rate and the track duration is exact. A microsecond timescale is the obvious choice
   * and the wrong one: 1/60 s is 16666.67 µs, and rounding that into a single `stts` entry
   * drifts by about a tenth of a second over a match.
   */
  const timescale = Math.max(1, Math.round(opts.fps)) * 1000;
  const delta = 1000;
  const MOVIE_SCALE = 1000;
  const movieDuration = Math.round((n * delta * MOVIE_SCALE) / timescale);

  const sizes = new Uint32Array(n);
  const syncs: number[] = [];
  for (let i = 0; i < n; i++) {
    sizes[i] = frames[i].data.byteLength;
    if (frames[i].keyframe) syncs.push(i + 1); // sample numbers are 1-based
  }

  // presentation-minus-decode, run-length encoded, and written only if it is ever non-zero
  const offsets: { count: number; offset: number }[] = [];
  let anyOffset = false;
  for (let i = 0; i < n; i++) {
    const pts = Math.round((frames[i].timestamp * timescale) / 1e6);
    const off = pts - i * delta;
    if (off !== 0) anyOffset = true;
    const last = offsets[offsets.length - 1];
    if (last && last.offset === off) last.count++;
    else offsets.push({ count: 1, offset: off });
  }
  const ctts = (): Bytes[] => {
    const body = new Uint8Array(offsets.length * 8);
    const d = new DataView(body.buffer);
    offsets.forEach((e, i) => {
      d.setUint32(i * 8, e.count);
      d.setInt32(i * 8 + 4, e.offset); // version 1: SIGNED, so a lagging PTS is expressible
    });
    return full('ctts', 1, 0, [u32(offsets.length), body]);
  };

  const compressor = new Uint8Array(32); // a Pascal string: a length byte, then the name
  compressor[0] = 4;
  compressor.set(TEXT.encode('DSIM'), 1);

  const avc1 = box('avc1', [
    zeros(6), u16(1), // reserved, data_reference_index
    zeros(16), // pre_defined, reserved, pre_defined[3]
    u16(opts.width), u16(opts.height),
    u32(0x00480000), u32(0x00480000), // 72 dpi, horizontal and vertical
    zeros(4), u16(1), // reserved, frame_count
    compressor,
    u16(0x0018), u16(0xffff), // bit depth, pre_defined (-1)
    ...box('avcC', [opts.description]),
  ]);

  /**
   * Everything but the chunk offset, which is the one value that depends on how long this
   * comes out. ONE chunk holds every sample: they are contiguous in `mdat` and `stsz` already
   * gives each length, so splitting them into chunks would add a table and buy nothing.
   */
  const buildMoov = (chunkOffset: number): Bytes[] =>
    box('moov', [
      ...full('mvhd', 0, 0, [
        u32(0), u32(0), u32(MOVIE_SCALE), u32(movieDuration),
        fixed(1), u16(0x0100), zeros(2), zeros(8), // rate, volume, reserved
        MATRIX, zeros(24), u32(2), // pre_defined[6], next_track_ID
      ]),
      ...box('trak', [
        // flags 3 = the track is enabled and part of the presentation
        ...full('tkhd', 0, 3, [
          u32(0), u32(0), u32(1), zeros(4), u32(movieDuration),
          zeros(8), u16(0), u16(0), u16(0), zeros(2), // layer, alternate_group, volume
          MATRIX, fixed(opts.width), fixed(opts.height),
        ]),
        ...box('mdia', [
          ...full('mdhd', 0, 0, [
            u32(0), u32(0), u32(timescale), u32(n * delta),
            u16(0x55c4), u16(0), // 'und' packed as five-bit letters, pre_defined
          ]),
          ...full('hdlr', 0, 0, [
            u32(0), TEXT.encode('vide'), zeros(12), TEXT.encode('VideoHandler\0'),
          ]),
          ...box('minf', [
            ...full('vmhd', 0, 1, [u16(0), zeros(6)]), // graphicsmode, opcolor
            ...box('dinf', [
              // one data reference, flagged self-contained: the samples are in THIS file
              ...full('dref', 0, 0, [u32(1), ...full('url ', 0, 1, [])]),
            ]),
            ...box('stbl', [
              ...full('stsd', 0, 0, [u32(1), ...avc1]),
              ...full('stts', 0, 0, [u32(1), u32(n), u32(delta)]),
              ...(anyOffset ? ctts() : []),
              ...full('stss', 0, 0, [u32(syncs.length), u32s(syncs)]),
              ...full('stsc', 0, 0, [u32(1), u32(1), u32(n), u32(1)]),
              ...full('stsz', 0, 0, [u32(0), u32(n), u32s(sizes)]),
              ...full('stco', 0, 0, [u32(1), u32(chunkOffset)]),
            ]),
          ]),
        ]),
      ]),
    ]);

  const ftyp = box('ftyp', [
    TEXT.encode('isom'), u32(0x200),
    TEXT.encode('isom'), TEXT.encode('iso2'), TEXT.encode('avc1'), TEXT.encode('mp41'),
  ]);

  // pass one measures, pass two writes: the offset is a fixed-width field, so the length the
  // first pass reports is the length the second one has
  const moovLen = size(buildMoov(0));
  const mdatSize = size(frames.map((f) => f.data));
  const dataOffset = size(ftyp) + moovLen + 8;
  if (dataOffset + mdatSize > 0xffffffff) throw new Error('mp4: too large for 32-bit offsets');

  const mdatHead = new Uint8Array(8);
  new DataView(mdatHead.buffer).setUint32(0, 8 + mdatSize);
  mdatHead.set(TEXT.encode('mdat'), 4);

  // handed to Blob as separate runs rather than joined: the samples run to hundreds of
  // megabytes on a long match and there is no reason to hold a second contiguous copy
  const parts = [...ftyp, ...buildMoov(dataOffset), mdatHead, ...frames.map((f) => f.data)];
  return new Blob(parts as unknown as BlobPart[], { type: 'video/mp4' });
}
