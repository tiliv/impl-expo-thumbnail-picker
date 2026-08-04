/**
 * Where to sample a video.
 *
 * Pure, and more opinionated than it looks. Evenly dividing a duration into N
 * points sounds obviously right and is not: it puts the first sample at 0 and
 * the last at the final frame, which are the two worst frames in most clips.
 * Fades, autoexposure settling and the moment a hand reaches for the stop
 * button all live at the ends.
 *
 * So samples are taken from an inset window, and the inset is proportional
 * with an absolute cap — 3% of a ten-second clip is 300ms, which is about
 * right; 3% of a two-hour recording is over three minutes, which is not.
 */

const EDGE_FRACTION = 0.03;
const MAX_EDGE_MS = 1500;
/** Below this, insetting would leave nothing; take the middle and stop. */
const MIN_USABLE_MS = 400;

export function edgeInsetMs(durationMs: number): number {
  return Math.min(MAX_EDGE_MS, Math.floor(durationMs * EDGE_FRACTION));
}

/**
 * `count` evenly spaced times inside the usable window, inclusive of both
 * inset ends. Always returns exactly `count` entries for count >= 1, so the
 * filmstrip's layout can be computed before extraction finishes.
 */
export function sampleTimes(durationMs: number, count: number): number[] {
  if (count <= 0) return [];
  if (durationMs <= 0) return Array.from({ length: count }, () => 0);

  if (durationMs < MIN_USABLE_MS) {
    const mid = Math.floor(durationMs / 2);
    return Array.from({ length: count }, () => mid);
  }

  const edge = edgeInsetMs(durationMs);
  const start = edge;
  const end = durationMs - edge;
  const span = Math.max(0, end - start);

  if (count === 1) return [Math.floor(start + span / 2)];

  return Array.from({ length: count }, (_, i) => Math.floor(start + (span * i) / (count - 1)));
}

/** Keeps a scrub position inside the window we are willing to extract from. */
export function clampToUsable(durationMs: number, atMs: number): number {
  if (durationMs <= 0) return 0;
  if (durationMs < MIN_USABLE_MS) return Math.floor(durationMs / 2);
  const edge = edgeInsetMs(durationMs);
  return Math.min(durationMs - edge, Math.max(edge, Math.round(atMs)));
}

/**
 * Maps a horizontal drag to a time.
 *
 * Separate from the component so the scrub maths is testable without a
 * gesture, which is the part that is actually easy to get subtly wrong.
 */
export function timeAtOffset(durationMs: number, offsetX: number, trackWidth: number): number {
  if (trackWidth <= 0) return 0;
  const fraction = Math.min(1, Math.max(0, offsetX / trackWidth));
  return clampToUsable(durationMs, fraction * durationMs);
}

export function offsetAtTime(durationMs: number, atMs: number, trackWidth: number): number {
  if (durationMs <= 0) return 0;
  return Math.min(trackWidth, Math.max(0, (atMs / durationMs) * trackWidth));
}

/**
 * Snap to the nearest already-extracted frame when close enough.
 *
 * Without this the preview flickers between the filmstrip's cached frames and
 * freshly extracted ones as you drag, which reads as jitter rather than
 * precision. `toleranceMs` should be roughly half the filmstrip's spacing.
 */
export function snapToSample(times: number[], atMs: number, toleranceMs: number): number {
  let best = atMs;
  let bestDistance = toleranceMs;
  for (const t of times) {
    const distance = Math.abs(t - atMs);
    if (distance < bestDistance) {
      best = t;
      bestDistance = distance;
    }
  }
  return best;
}
