/**
 * The experiment's stand-in for a room that sends videos.
 *
 * The clips are synthetic and carry a `profile` describing what the footage is
 * actually like, so the classic failures — a fade-in, a splash screen, a clip
 * that is black throughout — are arrangeable rather than hypothetical.
 */

import { RoomStateStore } from '../core/roomState';
import { resolveThumbnailSettings } from '../core/settings';
import { resolveThumbnail } from '../core/strategy';
import type { ThumbnailProvider } from '../core/strategy';
import type { AssetId, ThumbnailResolution, VideoAsset } from '../core/types';
import {
  createFakeProvider,
  DEFAULT_CAPABILITIES,
  registerFake,
  type ClipProfile,
  type FakeCapabilities,
  type FakeVideo,
} from './fakeProvider';

export class ExperimentWorld {
  readonly stateStore = new RoomStateStore();
  capabilities: FakeCapabilities = { ...DEFAULT_CAPABILITIES };

  private videoList: VideoAsset[] = [];
  private resolutions = new Map<AssetId, ThumbnailResolution>();
  private picks = new Map<AssetId, { uri: string; atMs: number }>();
  private listeners = new Set<() => void>();
  /** Set when a real device video has been added; it uses the real provider. */
  private realAssets = new Set<AssetId>();

  revision = 0;

  constructor(private realProvider?: ThumbnailProvider) {
    this.stateStore.subscribe(() => {
      this.resolutions.clear();
      this.emit();
    });
  }

  reset(): void {
    this.videoList = [];
    this.resolutions.clear();
    this.picks.clear();
    this.realAssets.clear();
    this.capabilities = { ...DEFAULT_CAPABILITIES };
    this.stateStore.reset([]);
    this.emit();
  }

  add(...videos: VideoAsset[]): this {
    this.videoList.push(...videos);
    this.emit();
    return this;
  }

  addReal(video: VideoAsset): void {
    this.realAssets.add(video.id);
    this.add(video);
  }

  videos(): VideoAsset[] {
    return this.videoList;
  }

  isReal(id: AssetId): boolean {
    return this.realAssets.has(id);
  }

  providerFor(id: AssetId): ThumbnailProvider {
    return this.realAssets.has(id) && this.realProvider
      ? this.realProvider
      : createFakeProvider(this.capabilities);
  }

  setCapabilities(patch: Partial<FakeCapabilities>): void {
    this.capabilities = { ...this.capabilities, ...patch };
    this.resolutions.clear();
    this.emit();
  }

  pick(id: AssetId, choice: { uri: string; atMs: number } | null): void {
    if (choice) this.picks.set(id, choice);
    else this.picks.delete(id);
    this.resolutions.delete(id);
    this.emit();
  }

  pickFor(id: AssetId): { uri: string; atMs: number } | null {
    return this.picks.get(id) ?? null;
  }

  resolution(id: AssetId): ThumbnailResolution | undefined {
    return this.resolutions.get(id);
  }

  /** Runs the real chain. Cached until settings, capabilities or the pick change. */
  async resolve(video: VideoAsset): Promise<void> {
    const settings = resolveThumbnailSettings(this.stateStore).settings;
    const result = await resolveThumbnail(video, this.providerFor(video.id), settings, {
      userPick: this.picks.get(video.id) ?? null,
    });
    this.resolutions.set(video.id, result);
    this.emit();
  }

  invalidate(): void {
    this.resolutions.clear();
    this.emit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getRevision = (): number => this.revision;

  private emit(): void {
    this.revision += 1;
    this.listeners.forEach((l) => l());
  }
}

let videoSeq = 0;

export function clip(
  profile: ClipProfile,
  durationMs: number,
  hue: number,
  extra: Partial<FakeVideo> = {},
): FakeVideo {
  videoSeq += 1;
  return registerFake({
    id: `clip-${videoSeq}`,
    uri: `synthetic://${hue}`,
    durationMs,
    width: 1920,
    height: 1080,
    filename: `${profile}-${videoSeq}.mp4`,
    profile,
    hue,
    ...extra,
  });
}
