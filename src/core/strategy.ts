/**
 * The resolution chain.
 *
 * Try each strategy the room lists, in order, and stop at the first success.
 * The part that earns its keep is the **attempt log**: every strategy that did
 * not win records why, so "why is this video showing a grey placeholder" has
 * an answer on screen instead of a debugging session.
 *
 * That matters more than usual here because the most likely answer is not a
 * bug. `library` — the stated base case, "whatever the photo library had for
 * it" — is simply not reachable from Expo's JS API today, and an app that
 * skips it silently looks like it never tried.
 */

import { pickBestFrame, rankFrame } from './scoring';
import type { ThumbnailSettings } from './settings';
import type {
  Attempt,
  FrameSample,
  ThumbnailCandidate,
  ThumbnailResolution,
  ThumbnailStrategy,
  VideoAsset,
} from './types';
import { sampleTimes } from './filmstrip';

/**
 * What the chain needs from the platform. Implemented by
 * `adapters/expoProvider.ts` on device and by a deterministic fake in the
 * experiment, so every branch of the chain is reachable in a test.
 */
export interface ThumbnailProvider {
  /** The OS photo library's own thumbnail, if it can be had. */
  libraryThumbnail(asset: VideoAsset): Promise<ProviderResult>;
  /** A poster frame the recorder embedded in the container. */
  embeddedPoster(asset: VideoAsset): Promise<ProviderResult>;
  /** Extract a frame at a time. The workhorse. */
  frameAt(asset: VideoAsset, atMs: number, settings: ThumbnailSettings): Promise<ProviderResult>;
  /** Pixel-level scoring. Optional: without it, `scored_sample` cannot rank. */
  scoreFrame?(uri: string): Promise<FrameSample['score']>;
  /** A drawn stand-in. Never fails. */
  placeholder(asset: VideoAsset): ThumbnailCandidate;
}

export type ProviderResult =
  | { ok: true; uri: string; atMs: number | null; width?: number; height?: number }
  | { ok: false; kind: 'unavailable' | 'failed'; reason: string };

export interface ResolveOptions {
  /** A frame the user already chose, for the `user_pick` strategy. */
  userPick?: { uri: string; atMs: number } | null;
  /** Injected so timings are deterministic in tests. */
  now?: () => number;
}

export async function resolveThumbnail(
  asset: VideoAsset,
  provider: ThumbnailProvider,
  settings: ThumbnailSettings,
  options: ResolveOptions = {},
): Promise<ThumbnailResolution> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const attempts: Attempt[] = [];

  for (const strategy of settings.strategyOrder.value) {
    const attemptStart = now();
    const outcome = await runStrategy(strategy, asset, provider, settings, options);
    attempts.push({ strategy, outcome, elapsedMs: now() - attemptStart });

    if (outcome.status === 'ok') {
      return {
        candidate: outcome.candidate,
        attempts,
        degraded: strategy === 'placeholder',
        totalElapsedMs: now() - startedAt,
      };
    }
  }

  return { candidate: null, attempts, degraded: true, totalElapsedMs: now() - startedAt };
}

async function runStrategy(
  strategy: ThumbnailStrategy,
  asset: VideoAsset,
  provider: ThumbnailProvider,
  settings: ThumbnailSettings,
  options: ResolveOptions,
): Promise<Attempt['outcome']> {
  switch (strategy) {
    case 'user_pick': {
      if (!settings.allowUserPick.value) {
        return { status: 'skipped', reason: 'allow_user_pick is off in this room' };
      }
      if (!options.userPick) {
        return { status: 'unavailable', reason: 'the user has not chosen a frame' };
      }
      return {
        status: 'ok',
        candidate: {
          uri: options.userPick.uri,
          strategy: 'user_pick',
          atMs: options.userPick.atMs,
        },
      };
    }

    case 'library':
      return fromProvider(strategy, await provider.libraryThumbnail(asset));

    case 'embedded':
      return fromProvider(strategy, await provider.embeddedPoster(asset));

    case 'frame_at': {
      const atMs = Math.min(settings.defaultFrameMs.value, Math.max(0, asset.durationMs - 1));
      return fromProvider(strategy, await provider.frameAt(asset, atMs, settings));
    }

    case 'scored_sample': {
      if (!provider.scoreFrame) {
        return {
          status: 'unavailable',
          reason: 'no frame scorer on this platform; scoring needs pixel access',
        };
      }

      const times = sampleTimes(asset.durationMs, settings.sampleCount.value);
      const samples: FrameSample[] = [];
      const failures: string[] = [];

      for (const atMs of times) {
        const result = await provider.frameAt(asset, atMs, settings);
        if (!result.ok) {
          failures.push(`${atMs}ms: ${result.reason}`);
          continue;
        }
        samples.push({ atMs, uri: result.uri, score: await provider.scoreFrame(result.uri) });
      }

      if (samples.length === 0) {
        return { status: 'failed', reason: `every sample failed (${failures.slice(0, 3).join('; ')})` };
      }

      const { best, reason } = pickBestFrame(samples, settings.rejectFlatFrames.value);
      if (!best) return { status: 'failed', reason: reason ?? 'no frame was good enough' };

      return {
        status: 'ok',
        candidate: {
          uri: best.uri,
          strategy: 'scored_sample',
          atMs: best.atMs,
          score: best.score ? Number(rankFrame(best.score).toFixed(3)) : undefined,
        },
      };
    }

    case 'placeholder':
      return { status: 'ok', candidate: provider.placeholder(asset) };
  }
}

function fromProvider(strategy: ThumbnailStrategy, result: ProviderResult): Attempt['outcome'] {
  if (result.ok) {
    return {
      status: 'ok',
      candidate: {
        uri: result.uri,
        strategy,
        atMs: result.atMs,
        width: result.width,
        height: result.height,
      },
    };
  }
  return { status: result.kind, reason: result.reason };
}

/** Human-readable one-liner per attempt, for the log view. */
export function describeAttempt(attempt: Attempt): string {
  switch (attempt.outcome.status) {
    case 'ok':
      return attempt.outcome.candidate.atMs !== null
        ? `won at ${attempt.outcome.candidate.atMs}ms`
        : 'won';
    case 'skipped':
      return `skipped — ${attempt.outcome.reason}`;
    case 'unavailable':
      return `unavailable — ${attempt.outcome.reason}`;
    case 'failed':
      return `failed — ${attempt.outcome.reason}`;
  }
}
