/**
 * The real provider, on device.
 *
 * Read `libraryThumbnail` first — it is the honest answer to the base case and
 * the most useful thing this repo found out.
 */

import * as VideoThumbnails from 'expo-video-thumbnails';

import type { ProviderResult, ThumbnailProvider } from '../core/strategy';
import type { ThumbnailSettings } from '../core/settings';
import type { ThumbnailCandidate, VideoAsset } from '../core/types';

export const expoProvider: ThumbnailProvider = {
  /**
   * "Whatever the photo library had for it, if that's available."
   *
   * It is not available. As of expo-media-library 57, the JS API exposes no
   * system-generated video thumbnail on either platform: `getAssetInfoAsync`
   * returns `localUri`, dimensions, EXIF and location, and nothing else. The
   * thumbnails the OS has already generated — the ones Photos scrolls through
   * instantly — are reachable only from native:
   *
   *   iOS      PHImageManager.requestImage(for:targetSize:contentMode:options:)
   *   Android  ContentResolver.loadThumbnail(uri, size, signal)
   *
   * Both are a small config-plugin module: one method, takes an asset id and a
   * target size, returns a file URI. Until that exists this attempt records
   * `unavailable` with the reason, the chain falls through to extraction, and
   * the log says so on screen rather than making it look like nothing tried.
   *
   * Worth knowing what falling through costs: extraction decodes the video,
   * which is roughly two orders of magnitude slower than handing back a
   * thumbnail the OS generated at import time. On a grid of videos that is the
   * difference between instant and visibly janky, which is the argument for
   * writing the native module rather than living with the fallback.
   */
  async libraryThumbnail(asset: VideoAsset): Promise<ProviderResult> {
    if (!asset.libraryAssetId) {
      return { ok: false, kind: 'unavailable', reason: 'not a device-library asset' };
    }
    return {
      ok: false,
      kind: 'unavailable',
      reason:
        'expo-media-library exposes no system thumbnail; needs a native module ' +
        '(PHImageManager on iOS, ContentResolver.loadThumbnail on Android)',
    };
  },

  /**
   * Container poster frames are likewise not exposed. Left in the chain
   * deliberately: it is cheap, it is the right second choice, and when someone
   * does add the native side the chain does not need rewriting.
   */
  async embeddedPoster(): Promise<ProviderResult> {
    return {
      ok: false,
      kind: 'unavailable',
      reason: 'no container-metadata reader; a poster atom would need native parsing',
    };
  },

  async frameAt(asset: VideoAsset, atMs: number, settings: ThumbnailSettings): Promise<ProviderResult> {
    try {
      const { uri, width, height } = await VideoThumbnails.getThumbnailAsync(asset.uri, {
        time: atMs,
        quality: settings.quality.value,
      });
      return { ok: true, uri, atMs, width, height };
    } catch (error) {
      // Seeking past the end and unsupported codecs both land here, and they
      // want different fixes, so keep the platform's own words.
      return {
        ok: false,
        kind: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  },

  /**
   * No `scoreFrame`.
   *
   * Scoring needs pixel access, and nothing in the Expo JS surface will read
   * pixels out of a JPEG on disk. The options, in order of how much work they
   * are: a GL/Skia offscreen draw plus a readback, an image-processing native
   * module, or a downscale-and-histogram in a worklet. Until one exists,
   * `scored_sample` reports `unavailable` and the chain moves on — the
   * experiment ships a synthetic scorer so the ranking policy is still
   * exercisable and testable.
   */

  placeholder(asset: VideoAsset): ThumbnailCandidate {
    return { uri: `placeholder://${asset.id}`, strategy: 'placeholder', atMs: null };
  },
};
