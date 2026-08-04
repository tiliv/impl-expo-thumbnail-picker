/**
 * Scrubbing, as distinct from playing.
 *
 * A player's playhead has its own intention — it wants to keep moving, and you
 * are trying to hold it still on one frame. That is two behaviours fighting,
 * and it is why picking a thumbnail out of a video player is unpleasant. So
 * there is no transport here, no autoplay, no play button: **the playhead moves
 * only while a finger is on it, and stays exactly where it was left.**
 *
 * The interesting mechanic is precision. Drag your finger away from the track
 * and the same horizontal movement covers less time, so you can land on a
 * specific frame without a magnifier or a nudge button.
 *
 * That mechanic forces one non-obvious decision, which is most of why this file
 * exists: **position is integrated from deltas, not mapped from absolute x.**
 *
 * The tempting implementation maps the finger's x across the track directly to
 * a timestamp. It is simpler, and it breaks the moment precision changes: at
 * quarter speed the finger and the playhead are no longer in the same place, so
 * recomputing from absolute x snaps the playhead back under the finger and
 * throws away the fine adjustment that was the entire point. Integrating
 * deltas, scaled by the current ratio, means changing precision mid-drag is
 * seamless — which is what makes sliding down feel like leaning in rather than
 * like switching modes.
 */

import { clampToUsable } from './filmstrip';

export interface ScrubPrecision {
  id: 'full' | 'half' | 'quarter' | 'fine';
  label: string;
  /** Fraction of normal travel. 1 = finger and playhead move together. */
  ratio: number;
  /** Vertical distance from the track at which this level takes over. */
  fromDy: number;
}

/**
 * Four levels rather than a continuous ramp: a continuous one is impossible to
 * feel your way back to, and people navigate this by muscle memory. Discrete
 * detents can be re-found, and can be announced with a haptic.
 */
export const PRECISION_LEVELS: ScrubPrecision[] = [
  { id: 'full', label: 'Full', ratio: 1, fromDy: 0 },
  { id: 'half', label: 'Half', ratio: 0.45, fromDy: 60 },
  { id: 'quarter', label: 'Quarter', ratio: 0.18, fromDy: 130 },
  { id: 'fine', label: 'Fine', ratio: 0.06, fromDy: 210 },
];

/**
 * Vertical distance to precision.
 *
 * Distance is absolute, so dragging above the track works as well as below —
 * whichever way there is room on screen. Punishing one direction because of
 * where the track happens to sit is the sort of thing that only shows up on a
 * small phone.
 */
export function precisionForDy(dy: number): ScrubPrecision {
  const distance = Math.abs(dy);
  let current = PRECISION_LEVELS[0];
  for (const level of PRECISION_LEVELS) {
    if (distance >= level.fromDy) current = level;
  }
  return current;
}

export interface ScrubSession {
  atMs: number;
  /** Last x we integrated from. Not a mapping origin. */
  lastX: number;
  precision: ScrubPrecision;
  /** Set for one update when the level changed, so the UI can buzz once. */
  precisionChanged: boolean;
}

export function beginScrub(atMs: number, x: number, dy = 0): ScrubSession {
  return { atMs, lastX: x, precision: precisionForDy(dy), precisionChanged: false };
}

export interface ScrubGeometry {
  durationMs: number;
  trackWidth: number;
}

/**
 * Integrate one movement.
 *
 * `lastX` advances every call even when the ratio changes, which is what keeps
 * a precision change from producing a jump: the next delta is measured from
 * where the finger actually is, and only the *scale* of that delta changes.
 */
export function updateScrub(
  session: ScrubSession,
  x: number,
  dy: number,
  geometry: ScrubGeometry,
): ScrubSession {
  const precision = precisionForDy(dy);
  const { durationMs, trackWidth } = geometry;

  if (trackWidth <= 0 || durationMs <= 0) {
    return { ...session, lastX: x, precision, precisionChanged: precision.id !== session.precision.id };
  }

  const msPerPixel = durationMs / trackWidth;
  const deltaMs = (x - session.lastX) * msPerPixel * precision.ratio;

  return {
    atMs: clampToUsable(durationMs, session.atMs + deltaMs),
    lastX: x,
    precision,
    precisionChanged: precision.id !== session.precision.id,
  };
}

/** A tap on the track is an absolute jump; only dragging integrates. */
export function jumpTo(atMs: number, x: number, durationMs: number): ScrubSession {
  return { atMs: clampToUsable(durationMs, atMs), lastX: x, precision: PRECISION_LEVELS[0], precisionChanged: false };
}

/**
 * Step one frame.
 *
 * Not transport controls — this moves a still, it does not start anything. It
 * exists because the last 30ms of a hunt is faster to tap than to drag, and
 * because it gives the interaction a keyboard/switch-accessible equivalent that
 * a bare drag surface does not have.
 */
export function stepFrame(atMs: number, direction: -1 | 1, durationMs: number, fps = 30): number {
  return clampToUsable(durationMs, atMs + direction * (1000 / fps));
}

/**
 * How far apart two scrub positions have to be before re-extracting is worth
 * it. Below one frame the decode produces a visually identical image, and the
 * request is pure cost.
 */
export const extractionWorthwhile = (fromMs: number, toMs: number, fps = 30): boolean =>
  Math.abs(toMs - fromMs) >= 1000 / fps;
