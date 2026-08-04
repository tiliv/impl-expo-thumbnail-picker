/**
 * Room state -> thumbnail policy.
 *
 * Thumbnail selection looks like a client detail until you notice the room has
 * opinions about it: a room that must not surface a frame nobody reviewed
 * wants `allow_user_pick` off and a fixed frame time; a room full of long
 * screen recordings wants sampling, because frame zero is a splash screen.
 *
 * Same discipline as the rest of the set — state events in, typed values with
 * provenance out, bad input clamped or defaulted with a warning.
 */

import type { RoomStateStore } from './roomState';
import type { ThumbnailStrategy } from './types';

export const STATE_THUMBNAIL = 'app.envelope.thumbnail';

export type SettingSource =
  | { kind: 'default' }
  | { kind: 'state_event'; type: string; eventId: string; sender: string; originTs: number };

export interface Resolved<T> {
  value: T;
  source: SettingSource;
}

export interface ThumbnailSettings {
  /** Tried in order. First success wins. */
  strategyOrder: Resolved<ThumbnailStrategy[]>;
  /** Where `frame_at` seeks. 0 is the classic first frame, and often black. */
  defaultFrameMs: Resolved<number>;
  /** Gate on the whole timeline picker. */
  allowUserPick: Resolved<boolean>;
  /** How many frames the filmstrip offers. */
  filmstripFrames: Resolved<number>;
  /** How many frames `scored_sample` extracts before ranking. */
  sampleCount: Resolved<number>;
  maxDimension: Resolved<number>;
  /** JPEG quality for extracted frames, 0..1. */
  quality: Resolved<number>;
  /** Refuse a frame the scorer says is flat, rather than shipping a black tile. */
  rejectFlatFrames: Resolved<boolean>;
}

export interface SettingsWarning {
  setting: keyof ThumbnailSettings;
  severity: 'info' | 'warn' | 'danger';
  message: string;
}

export interface ResolvedThumbnailSettings {
  settings: ThumbnailSettings;
  warnings: SettingsWarning[];
}

const ALL_STRATEGIES: ThumbnailStrategy[] = [
  'library',
  'embedded',
  'frame_at',
  'scored_sample',
  'user_pick',
  'placeholder',
];

/** The stated base case: library if we can get it, else the first frame. */
export const DEFAULT_ORDER: ThumbnailStrategy[] = ['library', 'embedded', 'frame_at', 'placeholder'];

const DEFAULTS = {
  defaultFrameMs: 0,
  allowUserPick: false,
  filmstripFrames: 9,
  sampleCount: 7,
  maxDimension: 720,
  quality: 0.8,
  rejectFlatFrames: false,
};

export const DEFAULT_SOURCE: SettingSource = { kind: 'default' };

export function resolveThumbnailSettings(store: RoomStateStore): ResolvedThumbnailSettings {
  const warnings: SettingsWarning[] = [];
  const event = store.get(STATE_THUMBNAIL);

  const sourceOf = (): SettingSource =>
    event
      ? { kind: 'state_event', type: event.type, eventId: event.eventId, sender: event.sender, originTs: event.originTs }
      : DEFAULT_SOURCE;

  function read<T>(
    setting: keyof ThumbnailSettings,
    field: string,
    fallback: T,
    validate: (raw: unknown) => T | null,
  ): Resolved<T> {
    if (!event || !(field in event.content)) return { value: fallback, source: DEFAULT_SOURCE };
    const raw = event.content[field];
    if (raw === null || raw === undefined) return { value: fallback, source: DEFAULT_SOURCE };
    const ok = validate(raw);
    if (ok === null) {
      warnings.push({
        setting,
        severity: 'warn',
        message: `${event.type}.${field} = ${JSON.stringify(raw)} is not usable; using default`,
      });
      return { value: fallback, source: DEFAULT_SOURCE };
    }
    return { value: ok, source: sourceOf() };
  }

  const int = (min: number, max: number) => (raw: unknown): number | null =>
    typeof raw === 'number' && Number.isFinite(raw) ? Math.min(max, Math.max(min, Math.round(raw))) : null;
  const num = (min: number, max: number) => (raw: unknown): number | null =>
    typeof raw === 'number' && Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : null;
  const bool = (raw: unknown): boolean | null => (typeof raw === 'boolean' ? raw : null);

  /**
   * The order is validated rather than trusted: unknown names are dropped, and
   * a list that ends up empty falls back, because a room must not be able to
   * leave every video without a thumbnail.
   */
  const strategyOrder = ((): Resolved<ThumbnailStrategy[]> => {
    if (!event || !Array.isArray(event.content.strategy_order)) {
      if (event && event.content.strategy_order !== undefined) {
        warnings.push({
          setting: 'strategyOrder',
          severity: 'warn',
          message: 'strategy_order is not an array; using default',
        });
      }
      return { value: DEFAULT_ORDER, source: DEFAULT_SOURCE };
    }

    const seen = new Set<string>();
    const parsed: ThumbnailStrategy[] = [];
    for (const raw of event.content.strategy_order as unknown[]) {
      if (typeof raw !== 'string' || !ALL_STRATEGIES.includes(raw as ThumbnailStrategy)) {
        warnings.push({
          setting: 'strategyOrder',
          severity: 'warn',
          message: `unknown strategy ${JSON.stringify(raw)}; dropped`,
        });
        continue;
      }
      if (seen.has(raw)) continue;
      seen.add(raw);
      parsed.push(raw as ThumbnailStrategy);
    }

    if (parsed.length === 0) {
      warnings.push({
        setting: 'strategyOrder',
        severity: 'danger',
        message: 'strategy_order had nothing usable in it; falling back to the default chain',
      });
      return { value: DEFAULT_ORDER, source: DEFAULT_SOURCE };
    }

    if (!parsed.includes('placeholder')) {
      warnings.push({
        setting: 'strategyOrder',
        severity: 'info',
        message: 'No placeholder at the end of the chain: videos can resolve to no thumbnail at all.',
      });
    }
    return { value: parsed, source: sourceOf() };
  })();

  const settings: ThumbnailSettings = {
    strategyOrder,
    defaultFrameMs: read('defaultFrameMs', 'default_frame_ms', DEFAULTS.defaultFrameMs, int(0, 60 * 60_000)),
    allowUserPick: read('allowUserPick', 'allow_user_pick', DEFAULTS.allowUserPick, bool),
    filmstripFrames: read('filmstripFrames', 'filmstrip_frames', DEFAULTS.filmstripFrames, int(3, 24)),
    sampleCount: read('sampleCount', 'sample_count', DEFAULTS.sampleCount, int(2, 16)),
    maxDimension: read('maxDimension', 'max_dimension', DEFAULTS.maxDimension, int(120, 2048)),
    quality: read('quality', 'quality', DEFAULTS.quality, num(0.1, 1)),
    rejectFlatFrames: read('rejectFlatFrames', 'reject_flat_frames', DEFAULTS.rejectFlatFrames, bool),
  };

  // The combination that produces the classic black thumbnail.
  if (
    settings.defaultFrameMs.value === 0 &&
    settings.strategyOrder.value.includes('frame_at') &&
    !settings.strategyOrder.value.includes('scored_sample') &&
    !settings.rejectFlatFrames.value
  ) {
    warnings.push({
      setting: 'defaultFrameMs',
      severity: 'info',
      message:
        'frame_at is seeking to 0 with no scoring and no flat-frame rejection. ' +
        'Fade-ins and autoexposure make frame zero the worst single guess available.',
    });
  }

  if (settings.strategyOrder.value.includes('user_pick') && !settings.allowUserPick.value) {
    warnings.push({
      setting: 'allowUserPick',
      severity: 'warn',
      message: 'user_pick is in the chain but allow_user_pick is off; it will always skip.',
    });
  }

  return { settings, warnings };
}

export function describeSource(source: SettingSource): string {
  return source.kind === 'default' ? 'default' : `${source.type} by ${source.sender}`;
}
