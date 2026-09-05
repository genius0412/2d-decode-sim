/**
 * Recording a replay to a VIDEO FILE.
 *
 * A replay is an input log, and `replayPlayable` retires one the moment SIM_VERSION moves —
 * deliberately, because a changed sim re-simulates the same inputs into a different game. So
 * the container is a perishable artifact: exact today, refused after the next patch.
 *
 * A video is the opposite. It stops being a re-simulation and becomes a recording, which means
 * it outlives every patch, needs no sim to watch, and can be shared with someone who does not
 * have DSIM at all. That is the point of offering it exactly while the replay still plays: the
 * pixels are captured from a playback this build can still prove is the real match.
 *
 * `MediaRecorder` over `canvas.captureStream()` is the whole implementation — no dependency,
 * which matters here (CLAUDE.md: the client bundle is React + Rapier and nothing else). The
 * cost is that it captures in REAL TIME off the live canvas, so a full match takes a full
 * match to record, and anything that starves rAF (a backgrounded tab) starves the capture too.
 */

/** container/codec preferences, best first. WebM/VP9 everywhere Chromium runs; the mp4 entry is
 *  for Safari, which only learned `MediaRecorder` late and speaks h264 rather than VP9. */
const CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4;codecs=avc1',
  'video/mp4',
] as const;

/**
 * The best container this browser will actually record, or NULL if it records none.
 *
 * Feature-detected rather than sniffed, and the null is a real branch — `MediaRecorder` is
 * absent in some embedded webviews entirely, and `isTypeSupported` is the only honest answer
 * to "will this produce a file". Callers fall back to the JSON export.
 */
export function pickVideoMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

/** the file extension a recorded blob should carry, derived from the mime we recorded with */
export function videoExt(mime: string): string {
  return mime.startsWith('video/mp4') ? 'mp4' : 'webm';
}

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
