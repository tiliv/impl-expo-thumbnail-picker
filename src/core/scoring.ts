/**
 * Ranking frames.
 *
 * Producing a `FrameScore` needs pixel access and is an adapter concern.
 * Turning scores into a choice is *policy*, and policy belongs somewhere it
 * can be argued with, tested, and changed without touching a native module.
 *
 * The weights below are a starting position, not a result. They encode three
 * claims worth disagreeing with:
 *
 *  - Contrast matters most, because the failure this exists to prevent is the
 *    flat black or blown-white frame, and contrast is what detects both.
 *  - Sharpness matters next: a blurry but well-exposed frame is a bad
 *    thumbnail, just less obviously bad than a black one.
 *  - Brightness is scored as *distance from mid*, not "more is better".
 */

import { type FrameSample, type FrameScore } from './types';

export const WEIGHTS = {
  contrast: 0.45,
  sharpness: 0.3,
  brightness: 0.15,
  face: 0.1,
} as const;

/** Below this, a frame is flat enough that we would rather not ship it. */
export const FLAT_CONTRAST_THRESHOLD = 0.12;

export function rankFrame(score: FrameScore): number {
  // Mid-grey is ideal; both ends are equally bad, so fold the range in half.
  const brightnessFit = 1 - Math.abs(score.brightness - 0.5) * 2;

  return (
    WEIGHTS.contrast * clamp01(score.contrast) +
    WEIGHTS.sharpness * clamp01(score.sharpness) +
    WEIGHTS.brightness * clamp01(brightnessFit) +
    WEIGHTS.face * clamp01(score.faceConfidence ?? 0)
  );
}

export const isFlat = (score: FrameScore): boolean => score.contrast < FLAT_CONTRAST_THRESHOLD;

export interface BestFrameResult {
  best: FrameSample | null;
  /** All candidates with their computed ranks, best first. Shown in the UI. */
  ranked: { sample: FrameSample; rank: number; flat: boolean }[];
  /** Why nothing was chosen, when `best` is null. */
  reason?: string;
}

export function pickBestFrame(samples: FrameSample[], rejectFlat: boolean): BestFrameResult {
  const ranked = samples
    .map((sample) => ({
      sample,
      rank: sample.score ? rankFrame(sample.score) : 0,
      flat: sample.score ? isFlat(sample.score) : false,
    }))
    .sort((a, b) => b.rank - a.rank);

  if (ranked.length === 0) return { best: null, ranked, reason: 'no frames were sampled' };

  const eligible = rejectFlat ? ranked.filter((r) => !r.flat) : ranked;
  if (eligible.length === 0) {
    return {
      best: null,
      ranked,
      // Worth surfacing rather than silently shipping the least-bad frame: a
      // video where every sample is flat is usually a black clip or a failed
      // extraction, and both want a different answer than "pick one anyway".
      reason: 'every sampled frame was flat and reject_flat_frames is on',
    };
  }

  return { best: eligible[0].sample, ranked };
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
