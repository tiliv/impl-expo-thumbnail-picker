/**
 * A deterministic provider, so every branch of the chain is reachable without
 * a device and without a real video file.
 *
 * This fakes the *platform*, not the policy: the strategy order, the scoring
 * weights and the settings resolution are all the real thing. What is faked is
 * "can this device hand me a library thumbnail", which is exactly the sort of
 * environmental fact you cannot arrange on a simulator anyway.
 *
 * Synthetic clips carry a `profile` describing what the video is actually
 * like — a fade-in, a screen recording with a splash, a clip that is black all
 * the way through — and the fake provider answers accordingly. That is what
 * makes "frame zero is the worst guess" something you can watch rather than
 * something you have to believe.
 */

import type { ProviderResult, ThumbnailProvider } from '../core/strategy';
import type { FrameScore, ThumbnailCandidate, VideoAsset } from '../core/types';

export type ClipProfile =
  /** Two seconds of black, then the actual content. The common case. */
  | 'fade_in'
  /** Splash screen for the first four seconds, then a UI recording. */
  | 'screen_recording'
  /** Well exposed throughout. Frame zero is fine. */
  | 'well_lit'
  /** Black start to finish. Nothing here is a good thumbnail. */
  | 'all_black'
  /** Handheld: sharp only in the middle third. */
  | 'shaky';

export interface FakeCapabilities {
  /** Pretend the native library-thumbnail module exists. */
  hasLibraryThumbnails: boolean;
  hasEmbeddedPoster: boolean;
  /** Pretend a pixel scorer exists. */
  hasFrameScorer: boolean;
  /** Extraction fails outright, e.g. an unsupported codec. */
  extractionBroken: boolean;
}

export const DEFAULT_CAPABILITIES: FakeCapabilities = {
  // False by default because that is the truth on Expo today, and the default
  // experiment should show the real chain, not an aspirational one.
  hasLibraryThumbnails: false,
  hasEmbeddedPoster: false,
  hasFrameScorer: true,
  extractionBroken: false,
};

export interface FakeVideo extends VideoAsset {
  profile: ClipProfile;
  /** Base hue for the synthetic frames, so clips are visually distinguishable. */
  hue: number;
}

/** Deterministic per (clip, time), so a scenario looks the same every run. */
export function frameQualityAt(video: FakeVideo, atMs: number): FrameScore {
  const t = video.durationMs > 0 ? atMs / video.durationMs : 0;

  switch (video.profile) {
    case 'fade_in': {
      // Black for the first 2s, ramping to fully exposed by 3s.
      const ramp = clamp01((atMs - 2000) / 1000);
      return { contrast: 0.05 + 0.7 * ramp, sharpness: 0.55 + 0.3 * ramp, brightness: 0.06 + 0.44 * ramp };
    }
    case 'screen_recording': {
      const onSplash = atMs < 4000;
      return onSplash
        ? { contrast: 0.09, sharpness: 0.95, brightness: 0.93 } // flat white splash
        : { contrast: 0.62, sharpness: 0.93, brightness: 0.52 };
    }
    case 'well_lit':
      return { contrast: 0.68, sharpness: 0.82, brightness: 0.5, faceConfidence: t > 0.3 ? 0.7 : 0.1 };
    case 'all_black':
      return { contrast: 0.03, sharpness: 0.2, brightness: 0.03 };
    case 'shaky': {
      // Sharp in the middle third, smeared at both ends.
      const centred = 1 - Math.abs(t - 0.5) * 2;
      return { contrast: 0.5 + 0.2 * centred, sharpness: 0.15 + 0.75 * centred, brightness: 0.48 };
    }
  }
}

export function createFakeProvider(capabilities: FakeCapabilities): ThumbnailProvider {
  const provider: ThumbnailProvider = {
    async libraryThumbnail(asset: VideoAsset): Promise<ProviderResult> {
      if (!capabilities.hasLibraryThumbnails) {
        return {
          ok: false,
          kind: 'unavailable',
          reason:
            'expo-media-library exposes no system thumbnail; needs a native module ' +
            '(PHImageManager / ContentResolver.loadThumbnail)',
        };
      }
      // What it would look like if the native module existed: instant, and
      // with no idea which frame it came from.
      return { ok: true, uri: `synthetic://${hueOf(asset)}/library`, atMs: null };
    },

    async embeddedPoster(asset: VideoAsset): Promise<ProviderResult> {
      if (!capabilities.hasEmbeddedPoster) {
        return { ok: false, kind: 'unavailable', reason: 'no container-metadata reader' };
      }
      return { ok: true, uri: `synthetic://${hueOf(asset)}/poster`, atMs: 0 };
    },

    async frameAt(asset: VideoAsset, atMs: number): Promise<ProviderResult> {
      if (capabilities.extractionBroken) {
        return { ok: false, kind: 'failed', reason: 'decoder refused the file (unsupported codec)' };
      }
      if (atMs > asset.durationMs) {
        return { ok: false, kind: 'failed', reason: `seek past end (${atMs}ms of ${asset.durationMs}ms)` };
      }
      return { ok: true, uri: `synthetic://${hueOf(asset)}/${Math.round(atMs)}`, atMs };
    },

    placeholder(asset: VideoAsset): ThumbnailCandidate {
      return { uri: `placeholder://${asset.id}`, strategy: 'placeholder', atMs: null };
    },
  };

  if (capabilities.hasFrameScorer) {
    provider.scoreFrame = async (uri: string) => scoreFromUri(uri);
  }

  return provider;
}

// --- synthetic frame identity -------------------------------------------

/**
 * Frames are addressed by `synthetic://<hue>/<time>`, so a URI is enough to
 * both draw the frame and recover which clip and moment it came from. Keeps
 * the fake provider stateless.
 */
const registry = new Map<number, FakeVideo>();

export function registerFake(video: FakeVideo): FakeVideo {
  registry.set(video.hue, video);
  return video;
}

const hueOf = (asset: VideoAsset): number => (asset as FakeVideo).hue ?? 0;

export function parseSyntheticUri(uri: string): { hue: number; atMs: number | null } | null {
  if (!uri.startsWith('synthetic://')) return null;
  const [hue, part] = uri.slice('synthetic://'.length).split('/');
  const atMs = Number(part);
  return { hue: Number(hue) || 0, atMs: Number.isFinite(atMs) ? atMs : null };
}

/**
 * What a synthetic frame should look like on screen.
 *
 * This is what makes the whole point watchable: the fade-in clip's frame at
 * 0ms really does render black, so "the first frame is the worst guess" is
 * something you see rather than something the README asserts.
 */
export function frameAppearance(uri: string): { hue: number; brightness: number; contrast: number } | null {
  const parsed = parseSyntheticUri(uri);
  if (!parsed) return null;
  const video = registry.get(parsed.hue);
  if (!video || parsed.atMs === null) {
    return { hue: parsed.hue, brightness: 0.45, contrast: 0.5 };
  }
  const score = frameQualityAt(video, parsed.atMs);
  return { hue: parsed.hue, brightness: score.brightness, contrast: score.contrast };
}

function scoreFromUri(uri: string): FrameScore {
  const parsed = parseSyntheticUri(uri);
  const video = parsed ? registry.get(parsed.hue) : undefined;
  if (!parsed || !video || parsed.atMs === null) {
    return { contrast: 0.5, sharpness: 0.5, brightness: 0.5 };
  }
  return frameQualityAt(video, parsed.atMs);
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
