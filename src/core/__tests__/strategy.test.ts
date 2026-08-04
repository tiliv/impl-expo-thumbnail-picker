import { clampToUsable, edgeInsetMs, offsetAtTime, sampleTimes, snapToSample, timeAtOffset } from '../filmstrip';
import { FLAT_CONTRAST_THRESHOLD, isFlat, pickBestFrame, rankFrame } from '../scoring';
import { RoomStateStore, stateEvent } from '../roomState';
import { DEFAULT_ORDER, resolveThumbnailSettings, STATE_THUMBNAIL } from '../settings';
import { resolveThumbnail } from '../strategy';
import type { FrameSample, FrameScore } from '../types';
import { createFakeProvider, DEFAULT_CAPABILITIES, frameQualityAt } from '../../experiment/fakeProvider';
import { clip, ExperimentWorld } from '../../experiment/world';
import { SCENARIOS } from '../../experiment/scenarios';

const settingsFrom = (content?: Record<string, unknown>) => {
  const store = new RoomStateStore();
  if (content) store.send(stateEvent(STATE_THUMBNAIL, content));
  return resolveThumbnailSettings(store);
};

/** Monotonic fake clock so elapsed times are deterministic. */
const fakeNow = () => {
  let t = 0;
  return () => (t += 1);
};

describe('sampleTimes', () => {
  it('never samples the very first or very last frame', () => {
    const times = sampleTimes(20_000, 7);
    expect(times[0]).toBeGreaterThan(0);
    expect(times[times.length - 1]).toBeLessThan(20_000);
  });

  it('caps the edge inset so long recordings do not lose minutes', () => {
    expect(edgeInsetMs(10_000)).toBe(300);
    expect(edgeInsetMs(2 * 60 * 60 * 1000)).toBe(1500);
  });

  it('returns exactly `count` entries, always', () => {
    for (const count of [1, 2, 5, 9, 24]) {
      expect(sampleTimes(15_000, count)).toHaveLength(count);
    }
  });

  it('degrades sanely on a clip too short to inset', () => {
    expect(sampleTimes(200, 5)).toEqual([100, 100, 100, 100, 100]);
    expect(sampleTimes(0, 3)).toEqual([0, 0, 0]);
  });

  it('is evenly spaced inside the window', () => {
    const times = sampleTimes(10_000, 5);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
  });
});

describe('scrub maths', () => {
  it('maps drag offsets to times and back', () => {
    expect(timeAtOffset(10_000, 0, 300)).toBe(clampToUsable(10_000, 0));
    expect(timeAtOffset(10_000, 300, 300)).toBe(clampToUsable(10_000, 10_000));
    expect(Math.round(offsetAtTime(10_000, 5_000, 300))).toBe(150);
  });

  it('clamps out-of-range drags instead of extrapolating', () => {
    expect(timeAtOffset(10_000, -500, 300)).toBe(clampToUsable(10_000, 0));
    expect(timeAtOffset(10_000, 9999, 300)).toBe(clampToUsable(10_000, 10_000));
  });

  it('survives a zero-width track', () => {
    expect(timeAtOffset(10_000, 50, 0)).toBe(0);
    expect(offsetAtTime(0, 500, 300)).toBe(0);
  });

  it('snaps to a nearby sample but leaves distant positions alone', () => {
    const times = [1000, 2000, 3000];
    expect(snapToSample(times, 2080, 250)).toBe(2000);
    expect(snapToSample(times, 2500, 250)).toBe(2500);
  });
});

describe('frame ranking', () => {
  const flat: FrameScore = { contrast: 0.04, sharpness: 0.9, brightness: 0.02 };
  const good: FrameScore = { contrast: 0.7, sharpness: 0.85, brightness: 0.5 };
  const blownOut: FrameScore = { contrast: 0.08, sharpness: 0.95, brightness: 0.97 };

  it('ranks a well-exposed frame above a sharp but flat one', () => {
    expect(rankFrame(good)).toBeGreaterThan(rankFrame(flat));
    expect(rankFrame(good)).toBeGreaterThan(rankFrame(blownOut));
  });

  it('treats blown-out and black as equally bad on brightness', () => {
    const black = rankFrame({ contrast: 0.5, sharpness: 0.5, brightness: 0 });
    const white = rankFrame({ contrast: 0.5, sharpness: 0.5, brightness: 1 });
    expect(black).toBeCloseTo(white, 6);
  });

  it('detects flatness at both ends', () => {
    expect(isFlat(flat)).toBe(true);
    expect(isFlat(blownOut)).toBe(true);
    expect(isFlat(good)).toBe(false);
    expect(FLAT_CONTRAST_THRESHOLD).toBeGreaterThan(0);
  });

  it('refuses to pick when everything is flat and rejection is on', () => {
    const samples: FrameSample[] = [
      { atMs: 0, uri: 'a', score: flat },
      { atMs: 500, uri: 'b', score: flat },
    ];
    expect(pickBestFrame(samples, true).best).toBeNull();
    expect(pickBestFrame(samples, true).reason).toMatch(/flat/);
    expect(pickBestFrame(samples, false).best).not.toBeNull();
  });
});

describe('clip profiles', () => {
  it('makes the first frame of a fade-in genuinely bad', () => {
    const video = clip('fade_in', 12_000, 10);
    expect(isFlat(frameQualityAt(video, 0))).toBe(true);
    expect(isFlat(frameQualityAt(video, 6000))).toBe(false);
  });

  it('makes a splash screen flat despite being sharp and bright', () => {
    const video = clip('screen_recording', 40_000, 10);
    const splash = frameQualityAt(video, 1000);
    expect(splash.sharpness).toBeGreaterThan(0.9);
    expect(isFlat(splash)).toBe(true);
  });
});

describe('resolveThumbnail', () => {
  const provider = createFakeProvider(DEFAULT_CAPABILITIES);

  it('logs every strategy it tried, including the ones that could not run', async () => {
    const video = clip('fade_in', 12_000, 20);
    const result = await resolveThumbnail(video, provider, settingsFrom().settings, { now: fakeNow() });

    expect(result.attempts.map((a) => a.strategy)).toEqual(DEFAULT_ORDER.slice(0, 3));
    expect(result.attempts[0].outcome.status).toBe('unavailable');
    expect(result.attempts[0].outcome).toMatchObject({
      reason: expect.stringContaining('expo-media-library'),
    });
    expect(result.candidate?.strategy).toBe('frame_at');
  });

  it('produces the black first frame the base case is famous for', async () => {
    const video = clip('fade_in', 12_000, 21);
    const result = await resolveThumbnail(video, provider, settingsFrom().settings, { now: fakeNow() });
    expect(result.candidate?.atMs).toBe(0);
    expect(isFlat(frameQualityAt(video, result.candidate!.atMs!))).toBe(true);
  });

  it('lets the library win when the native module exists', async () => {
    const withLibrary = createFakeProvider({ ...DEFAULT_CAPABILITIES, hasLibraryThumbnails: true });
    const result = await resolveThumbnail(clip('fade_in', 12_000, 22), withLibrary, settingsFrom().settings, {
      now: fakeNow(),
    });
    expect(result.candidate?.strategy).toBe('library');
    expect(result.candidate?.atMs).toBeNull();
    expect(result.attempts).toHaveLength(1);
  });

  it('finds a non-flat frame by sampling where a fixed time cannot', async () => {
    const settings = settingsFrom({
      strategy_order: ['scored_sample', 'frame_at', 'placeholder'],
      sample_count: 7,
    }).settings;

    const fade = clip('fade_in', 12_000, 23);
    const result = await resolveThumbnail(fade, provider, settings, { now: fakeNow() });
    expect(result.candidate?.strategy).toBe('scored_sample');
    expect(result.candidate!.atMs!).toBeGreaterThan(3000);
    expect(isFlat(frameQualityAt(fade, result.candidate!.atMs!))).toBe(false);
  });

  it('skips past the splash screen on a screen recording', async () => {
    const settings = settingsFrom({
      strategy_order: ['scored_sample', 'placeholder'],
      sample_count: 9,
    }).settings;
    const recording = clip('screen_recording', 40_000, 24);
    const result = await resolveThumbnail(recording, provider, settings, { now: fakeNow() });
    expect(result.candidate!.atMs!).toBeGreaterThan(4000);
  });

  it('falls through when every frame is flat and rejection is on', async () => {
    const settings = settingsFrom({
      strategy_order: ['scored_sample', 'frame_at', 'placeholder'],
      reject_flat_frames: true,
    }).settings;
    const result = await resolveThumbnail(clip('all_black', 8_000, 25), provider, settings, { now: fakeNow() });
    expect(result.attempts[0].outcome.status).toBe('failed');
    expect(result.candidate?.strategy).toBe('frame_at');
  });

  it('keeps the decoder\'s own words when extraction fails', async () => {
    const broken = createFakeProvider({ ...DEFAULT_CAPABILITIES, extractionBroken: true });
    const result = await resolveThumbnail(clip('well_lit', 9_000, 26), broken, settingsFrom().settings, {
      now: fakeNow(),
    });
    const frameAttempt = result.attempts.find((a) => a.strategy === 'frame_at');
    expect(frameAttempt?.outcome).toMatchObject({ status: 'failed', reason: expect.stringContaining('codec') });
    expect(result.degraded).toBe(true);
    expect(result.candidate?.strategy).toBe('placeholder');
  });

  it('can end with no candidate when the room omits a placeholder', async () => {
    const broken = createFakeProvider({ ...DEFAULT_CAPABILITIES, extractionBroken: true });
    const settings = settingsFrom({ strategy_order: ['library', 'frame_at'] }).settings;
    const result = await resolveThumbnail(clip('well_lit', 9_000, 27), broken, settings, { now: fakeNow() });
    expect(result.candidate).toBeNull();
    expect(result.degraded).toBe(true);
  });

  it('distinguishes "not chosen yet" from "the room forbids choosing"', async () => {
    const video = clip('well_lit', 9_000, 28);

    const allowed = settingsFrom({ strategy_order: ['user_pick', 'placeholder'], allow_user_pick: true }).settings;
    const notChosen = await resolveThumbnail(video, provider, allowed, { now: fakeNow() });
    expect(notChosen.attempts[0].outcome.status).toBe('unavailable');

    const forbidden = settingsFrom({ strategy_order: ['user_pick', 'placeholder'], allow_user_pick: false }).settings;
    const skipped = await resolveThumbnail(video, provider, forbidden, { now: fakeNow() });
    expect(skipped.attempts[0].outcome.status).toBe('skipped');

    const chosen = await resolveThumbnail(video, provider, allowed, {
      now: fakeNow(),
      userPick: { uri: 'synthetic://28/4200', atMs: 4200 },
    });
    expect(chosen.candidate).toMatchObject({ strategy: 'user_pick', atMs: 4200 });
    expect(chosen.attempts).toHaveLength(1);
  });

  it('reports scored_sample as unavailable with no pixel scorer', async () => {
    const unscored = createFakeProvider({ ...DEFAULT_CAPABILITIES, hasFrameScorer: false });
    const settings = settingsFrom({ strategy_order: ['scored_sample', 'placeholder'] }).settings;
    const result = await resolveThumbnail(clip('well_lit', 9_000, 29), unscored, settings, { now: fakeNow() });
    expect(result.attempts[0].outcome).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('pixel access'),
    });
  });
});

describe('resolveThumbnailSettings', () => {
  it('drops unknown strategies but keeps the usable ones', () => {
    const { settings, warnings } = settingsFrom({ strategy_order: ['telepathy', 'frame_at', 'vibes'] });
    expect(settings.strategyOrder.value).toEqual(['frame_at']);
    expect(warnings.filter((w) => w.setting === 'strategyOrder')).toHaveLength(3);
  });

  it('falls back when the order has nothing usable, so videos still get thumbnails', () => {
    const { settings, warnings } = settingsFrom({ strategy_order: ['telepathy'] });
    expect(settings.strategyOrder.value).toEqual(DEFAULT_ORDER);
    expect(warnings.some((w) => w.severity === 'danger')).toBe(true);
  });

  it('clamps and defaults bad scalars', () => {
    const { settings } = settingsFrom({ sample_count: 999, quality: 'high', default_frame_ms: -400 });
    expect(settings.sampleCount.value).toBe(16);
    expect(settings.quality.value).toBe(0.8);
    expect(settings.defaultFrameMs.value).toBe(0);
  });

  it('warns about the combination that produces black thumbnails', () => {
    const { warnings } = settingsFrom({ strategy_order: ['frame_at'], default_frame_ms: 0 });
    expect(warnings.some((w) => w.setting === 'defaultFrameMs')).toBe(true);
  });

  it('warns when user_pick can never run', () => {
    const { warnings } = settingsFrom({ strategy_order: ['user_pick', 'placeholder'], allow_user_pick: false });
    expect(warnings.some((w) => w.setting === 'allowUserPick')).toBe(true);
  });
});

describe('scenarios', () => {
  it.each(SCENARIOS.map((s) => [s.id, s] as const))('%s resolves every clip', async (_id, scenario) => {
    const world = new ExperimentWorld();
    scenario.arrange(world);
    const settings = resolveThumbnailSettings(world.stateStore).settings;
    for (const video of world.videos()) {
      const result = await resolveThumbnail(video, world.providerFor(video.id), settings, { now: fakeNow() });
      expect(result.attempts.length).toBeGreaterThan(0);
    }
    expect(scenario.expect.length).toBeGreaterThan(0);
  });
});
