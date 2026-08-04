/**
 * Getting a thumbnail out of a video.
 *
 * The base case sounds like one line — use whatever the photo library already
 * has, else take the first frame — and it is not, for two reasons this model
 * is shaped around:
 *
 *  1. The library's own thumbnail is frequently *not reachable*. On Expo today
 *     `expo-media-library` exposes no system-generated video thumbnail at all.
 *     So "if that's available" is a real branch that fails often, and the app
 *     needs to know which source it actually got.
 *  2. The first frame is very often black. Fade-ins, autoexposure settling,
 *     and a lens cap's worth of camera-roll reality mean frame zero is the
 *     worst single guess available.
 *
 * So a thumbnail is never just a URI. It is a URI plus which strategy produced
 * it, and a log of what was tried before it.
 */

export type AssetId = string;
export type EventId = string;
export type UserId = string;

export interface VideoAsset {
  id: AssetId;
  uri: string;
  durationMs: number;
  width?: number;
  height?: number;
  filename?: string;
  /** Set when the asset came from the device library rather than a file. */
  libraryAssetId?: string;
}

export type ThumbnailStrategy =
  /** Whatever the OS photo library already generated. */
  | 'library'
  /** A poster frame embedded in the container by the recorder. */
  | 'embedded'
  /** Extract at a fixed time, room-configured. The classic "first frame". */
  | 'frame_at'
  /** Sample several frames and rank them. */
  | 'scored_sample'
  /** The user picked one off the timeline. */
  | 'user_pick'
  /** Nothing worked; draw something rather than a broken image box. */
  | 'placeholder';

export interface ThumbnailCandidate {
  uri: string;
  strategy: ThumbnailStrategy;
  /** Position in the video, when the strategy knows one. */
  atMs: number | null;
  width?: number;
  height?: number;
  /** 0..1, only set by strategies that rank frames. */
  score?: number;
}

export type AttemptOutcome =
  | { status: 'ok'; candidate: ThumbnailCandidate }
  /** The strategy cannot run here at all — no library asset, no native support. */
  | { status: 'unavailable'; reason: string }
  /** It ran and failed. Corrupt file, seek past end, decoder refused. */
  | { status: 'failed'; reason: string }
  /** Policy said not to try. */
  | { status: 'skipped'; reason: string };

export interface Attempt {
  strategy: ThumbnailStrategy;
  outcome: AttemptOutcome;
  elapsedMs: number;
}

export interface ThumbnailResolution {
  /** null only if even the placeholder was disabled. */
  candidate: ThumbnailCandidate | null;
  /** Every strategy tried, in order, with why each one did not win. */
  attempts: Attempt[];
  /** True when we fell all the way through to a placeholder. */
  degraded: boolean;
  totalElapsedMs: number;
}

/** A frame offered to the user in the filmstrip. */
export interface FrameSample {
  atMs: number;
  uri: string;
  score?: FrameScore;
}

/**
 * How good a frame is as a thumbnail.
 *
 * Producing these needs pixel access, which is an adapter concern — see
 * `adapters/index.ts`. Turning them into a ranking is policy, and lives in
 * `scoring.ts` where it can be argued with and tested.
 */
export interface FrameScore {
  /** 0..1. Low means flat: a black frame, a white flash, a fade. */
  contrast: number;
  /** 0..1. Low means motion blur or out of focus. */
  sharpness: number;
  /** 0..1, mid-range is best. 0 is black, 1 is blown out. */
  brightness: number;
  /** 0..1 confidence a face is present, if the scorer can tell. */
  faceConfidence?: number;
}

export const formatTimecode = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
