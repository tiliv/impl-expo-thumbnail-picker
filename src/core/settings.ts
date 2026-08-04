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
import type { SendEditsPolicy } from './edits';

export const STATE_THUMBNAIL = 'app.envelope.thumbnail';
export const STATE_STAGING = 'app.envelope.staging';

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

/**
 * The staging sheet's policy.
 *
 * Separate from `ThumbnailSettings` because it answers a different question —
 * that one is "what thumbnail does this video get", this one is "what must be
 * true of an attachment before it can be sent".
 */
export interface StagingSettings {
  /** `required` blocks the send button; `warn` surfaces it; `off` says nothing. */
  requireAltText: Resolved<'off' | 'warn' | 'required'>;
  altTextMaxChars: Resolved<number>;
  allowFilters: Resolved<boolean>;
  /** Whether edits travel as a reversible list or are flattened first. */
  sendEdits: Resolved<SendEditsPolicy>;
  maxAttachments: Resolved<number>;
}

export interface SettingsWarning {
  setting: keyof ThumbnailSettings | keyof StagingSettings;
  severity: 'info' | 'warn' | 'danger';
  message: string;
}

export interface ResolvedThumbnailSettings {
  settings: ThumbnailSettings;
  staging: StagingSettings;
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

/**
 * Picking a frame means decoding the video anyway.
 *
 * The original chain led with `library` to avoid a decode. That reasoning does
 * not survive a scrubber: the moment someone drags, we are decoding, and the
 * library thumbnail has saved us exactly one frame. So the default now leads
 * with the author's own choice and falls back to sampling — both of which
 * decode, deliberately.
 *
 * `library` stays in the chain, last before the placeholder, for the case that
 * still matters: an attachment nobody opened the sheet for. It is a cheap
 * `unavailable` when the native module is missing.
 */
export const DEFAULT_ORDER: ThumbnailStrategy[] = [
  'user_pick',
  'scored_sample',
  'frame_at',
  'library',
  'placeholder',
];

/** What the chain used to be, kept so the two are comparable in the panel. */
export const DECODE_AVERSE_ORDER: ThumbnailStrategy[] = ['library', 'embedded', 'frame_at', 'placeholder'];

const DEFAULTS = {
  // 0 is still the worst single guess, but it is now the third fallback rather
  // than the primary path, so it costs a lot less.
  defaultFrameMs: 0,
  allowUserPick: true,
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
  const stagingEvent = store.get(STATE_STAGING);

  type Event = typeof event;

  const sourceOf = (from: Event): SettingSource =>
    from
      ? { kind: 'state_event', type: from.type, eventId: from.eventId, sender: from.sender, originTs: from.originTs }
      : DEFAULT_SOURCE;

  function read<T>(
    setting: SettingsWarning['setting'],
    field: string,
    fallback: T,
    validate: (raw: unknown) => T | null,
    from: Event = event,
  ): Resolved<T> {
    if (!from || !(field in from.content)) return { value: fallback, source: DEFAULT_SOURCE };
    const raw = from.content[field];
    if (raw === null || raw === undefined) return { value: fallback, source: DEFAULT_SOURCE };
    const ok = validate(raw);
    if (ok === null) {
      warnings.push({
        setting,
        severity: 'warn',
        message: `${from.type}.${field} = ${JSON.stringify(raw)} is not usable; using default`,
      });
      return { value: fallback, source: DEFAULT_SOURCE };
    }
    return { value: ok, source: sourceOf(from) };
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
    return { value: parsed, source: sourceOf(event) };
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

  const staging: StagingSettings = {
    requireAltText: read(
      'requireAltText',
      'require_alt_text',
      'warn' as const,
      (raw) => (raw === 'off' || raw === 'warn' || raw === 'required' ? raw : null),
      stagingEvent,
    ),
    altTextMaxChars: read('altTextMaxChars', 'alt_text_max_chars', 1000, int(40, 4000), stagingEvent),
    allowFilters: read('allowFilters', 'allow_filters', true, bool, stagingEvent),
    sendEdits: read(
      'sendEdits',
      'send_edits',
      'baked' as SendEditsPolicy,
      (raw) => (raw === 'baked' || raw === 'with_original' ? raw : null),
      stagingEvent,
    ),
    maxAttachments: read('maxAttachments', 'max_attachments', 10, int(1, 32), stagingEvent),
  };

  // The combination that makes a privacy affordance decorative. Redactive
  // edits get force-baked regardless (see `bakeRequirement`), but a room
  // configured this way is asking for the unsafe thing and should hear about it.
  if (staging.sendEdits.value === 'with_original') {
    warnings.push({
      setting: 'sendEdits',
      severity: 'danger',
      message:
        'Edits are sent alongside the original, which makes them reversible. ' +
        'Anything blurred to hide it is force-baked, but this is the wrong default for a room where people redact.',
    });
  }

  if (settings.strategyOrder.value.includes('user_pick') && !settings.allowUserPick.value) {
    warnings.push({
      setting: 'allowUserPick',
      severity: 'warn',
      message: 'user_pick is in the chain but allow_user_pick is off; it will always skip.',
    });
  }

  return { settings, staging, warnings };
}

export function describeSource(source: SettingSource): string {
  return source.kind === 'default' ? 'default' : `${source.type} by ${source.sender}`;
}
