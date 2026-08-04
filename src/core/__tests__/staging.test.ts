import { announcement, altIssues, stripRedundantPrefix } from '../altText';
import {
  bakeRequirement,
  EDIT_SPECS,
  hasEdits,
  isRedactive,
  matchPreset,
  PRESETS,
  removeEdit,
  setEdit,
  toFilterOps,
  valueOf,
  type EditList,
} from '../edits';
import { draftReadiness, draftReducer, emptyDraft, stage, type Draft } from '../draft';
import {
  beginScrub,
  extractionWorthwhile,
  precisionForDy,
  PRECISION_LEVELS,
  stepFrame,
  updateScrub,
} from '../scrub';
import { RoomStateStore, stateEvent } from '../roomState';
import { resolveThumbnailSettings, STATE_STAGING } from '../settings';

const stagingFrom = (content?: Record<string, unknown>) => {
  const store = new RoomStateStore();
  if (content) store.send(stateEvent(STATE_STAGING, content));
  return resolveThumbnailSettings(store);
};

// --- edits ----------------------------------------------------------------

describe('edit list', () => {
  it('drops an edit when it returns to neutral rather than keeping a no-op', () => {
    let edits: EditList = setEdit([], 'contrast', 0.3);
    expect(edits).toHaveLength(1);
    edits = setEdit(edits, 'contrast', 0);
    expect(edits).toHaveLength(0);
    expect(hasEdits(edits)).toBe(false);
  });

  it('keeps position when adjusting, so a slider drag does not reorder the stack', () => {
    let edits: EditList = setEdit(setEdit(setEdit([], 'brightness', 0.2), 'blur', 5), 'saturate', 0.4);
    expect(edits.map((e) => e.kind)).toEqual(['brightness', 'blur', 'saturate']);
    edits = setEdit(edits, 'blur', 9);
    expect(edits.map((e) => e.kind)).toEqual(['brightness', 'blur', 'saturate']);
    expect(valueOf(edits, 'blur')).toBe(9);
  });

  it('clamps to the spec range', () => {
    expect(valueOf(setEdit([], 'contrast', 99), 'contrast')).toBe(EDIT_SPECS.contrast.max);
    expect(valueOf(setEdit([], 'contrast', -99), 'contrast')).toBe(EDIT_SPECS.contrast.min);
  });

  it('is non-destructive: removing an edit leaves the rest alone', () => {
    const edits = setEdit(setEdit(setEdit([], 'brightness', 0.2), 'blur', 6), 'sepia', 0.5);
    const without = removeEdit(edits, 'blur');
    expect(without.map((e) => e.kind)).toEqual(['brightness', 'sepia']);
    expect(valueOf(without, 'brightness')).toBe(0.2);
  });

  it('recognises a preset it produced, and stops recognising it after a nudge', () => {
    const punch = PRESETS.find((p) => p.id === 'punch')!;
    expect(matchPreset(punch.edits)?.id).toBe('punch');
    expect(matchPreset(setEdit(punch.edits, 'contrast', 0.9))?.id).toBeUndefined();
  });

  it('maps to filter ops, skipping neutral entries', () => {
    const ops = toFilterOps([
      { kind: 'brightness', value: 0.25 },
      { kind: 'contrast', value: 0 },
      { kind: 'blur', value: 4 },
    ]);
    expect(ops).toEqual([
      { fn: 'brightness', amount: 1.25 },
      { fn: 'blur', amount: 4 },
    ]);
  });

  it('expands warmth into two ops, since there is no warmth primitive', () => {
    const ops = toFilterOps([{ kind: 'warmth', value: 0.5 }]);
    expect(ops.map((o) => o.fn)).toEqual(['hueRotate', 'saturate']);
  });
});

describe('bakeRequirement', () => {
  const cosmetic: EditList = [{ kind: 'contrast', value: 0.3 }];
  const redaction: EditList = [{ kind: 'blur', value: 8 }];

  it('treats a light blur as a look and a heavy one as a redaction', () => {
    expect(isRedactive({ kind: 'blur', value: 1 })).toBe(false);
    expect(isRedactive({ kind: 'blur', value: 8 })).toBe(true);
    expect(isRedactive({ kind: 'contrast', value: 1 })).toBe(false);
  });

  it('forces a bake for redactive edits even when the room says otherwise', () => {
    const requirement = bakeRequirement(redaction, 'with_original');
    expect(requirement.required).toBe(true);
    expect(requirement.overridesPolicy).toBe(true);
    expect(requirement.redactive).toHaveLength(1);
    expect(requirement.reason).toMatch(/undo/);
  });

  it('lets cosmetic edits travel as a list when the room allows it', () => {
    const requirement = bakeRequirement(cosmetic, 'with_original');
    expect(requirement.required).toBe(false);
    expect(requirement.overridesPolicy).toBe(false);
  });

  it('bakes everything when the room asks for baked', () => {
    expect(bakeRequirement(cosmetic, 'baked').required).toBe(true);
    expect(bakeRequirement([], 'baked').required).toBe(false);
  });

  it('warns at the room level about the reversible policy', () => {
    const { warnings } = stagingFrom({ send_edits: 'with_original' });
    expect(warnings.some((w) => w.setting === 'sendEdits' && w.severity === 'danger')).toBe(true);
    expect(stagingFrom({ send_edits: 'baked' }).warnings.some((w) => w.setting === 'sendEdits')).toBe(false);
  });
});

// --- alt text -------------------------------------------------------------

describe('announcement', () => {
  it('prefixes with the type the platform already announces', () => {
    expect(announcement({ kind: 'image' }, 'A blue door')).toBe('Image. A blue door');
    expect(announcement({ kind: 'video', durationMs: 14_000 }, 'A cat')).toBe('Video, 14 seconds. A cat');
  });

  it('shows the doubling that makes "Image of" wrong', () => {
    expect(announcement({ kind: 'image' }, 'Image of a blue door')).toBe('Image. Image of a blue door');
  });

  it('says out loud when there is no description', () => {
    expect(announcement({ kind: 'image', filename: 'IMG_1.HEIC' }, '  ')).toContain('No description');
  });
});

describe('altIssues', () => {
  const policy = { requirement: 'warn' as const, maxChars: 1000 };

  it('blocks only when the room requires a description', () => {
    expect(altIssues('', { kind: 'image' }, { ...policy, requirement: 'required' })[0].level).toBe('error');
    expect(altIssues('', { kind: 'image' }, policy)[0].level).toBe('suggestion');
    expect(altIssues('', { kind: 'image' }, { ...policy, requirement: 'off' })).toHaveLength(0);
  });

  it('catches a pasted filename', () => {
    const issues = altIssues('IMG_4471', { kind: 'image', filename: 'IMG_4471.HEIC' }, policy);
    expect(issues.map((i) => i.code)).toContain('filename');
  });

  it('catches a redundant opener and can trim it', () => {
    const issues = altIssues('Photo of a blue door', { kind: 'image' }, policy);
    expect(issues.map((i) => i.code)).toContain('redundant_prefix');
    expect(stripRedundantPrefix('Photo of a blue door')).toBe('A blue door');
    expect(stripRedundantPrefix('A blue door')).toBe('A blue door');
  });

  it('never blocks on a suggestion', () => {
    const issues = altIssues('cat', { kind: 'image' }, policy);
    expect(issues.every((i) => i.level === 'suggestion')).toBe(true);
  });

  it('blocks on length, which is a real limit rather than advice', () => {
    const issues = altIssues('x'.repeat(200), { kind: 'image' }, { ...policy, maxChars: 100 });
    expect(issues.find((i) => i.code === 'too_long')?.level).toBe('error');
  });
});

// --- scrub ----------------------------------------------------------------

describe('scrub precision', () => {
  it('steps down through the levels as the finger moves away', () => {
    expect(precisionForDy(0).id).toBe('full');
    expect(precisionForDy(80).id).toBe('half');
    expect(precisionForDy(150).id).toBe('quarter');
    expect(precisionForDy(400).id).toBe('fine');
  });

  it('treats up and down the same', () => {
    expect(precisionForDy(-220).id).toBe(precisionForDy(220).id);
  });

  it('covers less time per pixel as precision increases', () => {
    const ratios = PRECISION_LEVELS.map((l) => l.ratio);
    expect(ratios).toEqual([...ratios].sort((a, b) => b - a));
  });
});

describe('updateScrub', () => {
  const geometry = { durationMs: 30_000, trackWidth: 300 };

  it('integrates deltas rather than mapping absolute position', () => {
    let session = beginScrub(15_000, 100);
    session = updateScrub(session, 130, 0, geometry);
    // 30px of a 300px track across 30s = 3s at full ratio.
    expect(session.atMs).toBeCloseTo(18_000, -2);
  });

  it('does not jump the playhead when precision changes mid-drag', () => {
    let session = beginScrub(15_000, 100);
    session = updateScrub(session, 150, 0, geometry);
    const beforeChange = session.atMs;

    // Same x, but the finger has moved away from the track. Position must not
    // move at all: no horizontal travel means no time change, whatever the ratio.
    session = updateScrub(session, 150, 300, geometry);
    expect(session.atMs).toBe(beforeChange);
    expect(session.precision.id).toBe('fine');
    expect(session.precisionChanged).toBe(true);
  });

  it('covers proportionally less time at finer precision', () => {
    const coarse = updateScrub(beginScrub(15_000, 100), 160, 0, geometry);
    const fine = updateScrub(beginScrub(15_000, 100, 400), 160, 400, geometry);
    const coarseTravel = Math.abs(coarse.atMs - 15_000);
    const fineTravel = Math.abs(fine.atMs - 15_000);
    expect(fineTravel).toBeLessThan(coarseTravel / 8);
  });

  it('reports a precision change exactly once', () => {
    let session = beginScrub(15_000, 100);
    session = updateScrub(session, 110, 300, geometry);
    expect(session.precisionChanged).toBe(true);
    session = updateScrub(session, 120, 300, geometry);
    expect(session.precisionChanged).toBe(false);
  });

  it('stays inside the usable window', () => {
    let session = beginScrub(15_000, 100);
    for (let i = 0; i < 40; i++) session = updateScrub(session, 100 + i * 100, 0, geometry);
    expect(session.atMs).toBeLessThan(geometry.durationMs);
    expect(session.atMs).toBeGreaterThan(0);
  });

  it('survives a zero-width track without producing NaN', () => {
    const session = updateScrub(beginScrub(5_000, 0), 50, 0, { durationMs: 30_000, trackWidth: 0 });
    expect(Number.isFinite(session.atMs)).toBe(true);
    expect(session.atMs).toBe(5_000);
  });
});

describe('frame stepping and extraction', () => {
  it('steps by one frame at the given rate', () => {
    // Positions are whole milliseconds, so a 30fps step lands on 33, not 33.33.
    expect(stepFrame(5_000, 1, 30_000, 30)).toBe(5_033);
    expect(stepFrame(5_000, -1, 30_000, 30)).toBe(4_967);
    expect(stepFrame(5_000, 1, 30_000, 60)).toBe(5_017);
  });

  it('does not re-extract for a sub-frame move', () => {
    expect(extractionWorthwhile(5_000, 5_010, 30)).toBe(false);
    expect(extractionWorthwhile(5_000, 5_100, 30)).toBe(true);
  });
});

// --- draft ----------------------------------------------------------------

describe('draftReducer', () => {
  const build = (): Draft => ({
    ...emptyDraft(),
    items: [
      stage({ kind: 'image', uri: 'a', filename: 'a.jpg' }),
      stage({ kind: 'video', uri: 'b', filename: 'b.mp4', durationMs: 10_000 }),
    ],
  });

  it('edits one item without touching the others', () => {
    const draft = build();
    const next = draftReducer(draft, { type: 'set_alt', id: draft.items[0].id, alt: 'A blue door' });
    expect(next.items[0].alt).toBe('A blue door');
    expect(next.items[1].alt).toBe('');
  });

  it('closes the sheet when the open item is removed', () => {
    const draft = { ...build(), openItemId: '' };
    const withOpen = draftReducer(draft, { type: 'open', id: draft.items[0].id });
    const removed = draftReducer(withOpen, { type: 'remove', id: draft.items[0].id });
    expect(removed.openItemId).toBeNull();
    expect(removed.items).toHaveLength(1);
  });

  it('reorders without losing anything', () => {
    const draft = build();
    const next = draftReducer(draft, { type: 'reorder', id: draft.items[0].id, toIndex: 1 });
    expect(next.items.map((i) => i.id)).toEqual([draft.items[1].id, draft.items[0].id]);
  });

  it('is a no-op for unknown ids', () => {
    const draft = build();
    expect(draftReducer(draft, { type: 'set_alt', id: 'nope', alt: 'x' })).toEqual(draft);
    expect(draftReducer(draft, { type: 'reorder', id: 'nope', toIndex: 0 })).toEqual(draft);
  });
});

describe('draftReadiness', () => {
  const draftWith = (alt: string): Draft => ({
    ...emptyDraft(),
    items: [stage({ kind: 'image', uri: 'a', filename: 'a.jpg' }, { alt })],
  });

  it('blocks the send when the room requires descriptions and one is missing', () => {
    const { staging } = stagingFrom({ require_alt_text: 'required' });
    const draft = draftWith('');
    const result = draftReadiness(draft, staging, 'baked');
    expect(result.canSend).toBe(false);
    expect(result.issues[0].code).toBe('alt_missing');
    // The issue names its item, so a tray of eight is navigable.
    expect(result.issues[0].itemId).toBe(draft.items[0].id);
  });

  it('lets it through once described', () => {
    const { staging } = stagingFrom({ require_alt_text: 'required' });
    expect(draftReadiness(draftWith('A blue door'), staging, 'baked').canSend).toBe(true);
  });

  it('notices an auto thumbnail without blocking', () => {
    const { staging } = stagingFrom();
    const draft: Draft = {
      ...emptyDraft(),
      items: [stage({ kind: 'video', uri: 'v', durationMs: 8_000 }, { alt: 'A cat' })],
    };
    const result = draftReadiness(draft, staging, 'baked');
    expect(result.canSend).toBe(true);
    expect(result.issues.map((i) => i.code)).toContain('thumbnail_auto');
    expect(result.issues.every((i) => i.level === 'notice')).toBe(true);
  });

  it('says when edits will be reversible, and when they will be flattened', () => {
    const { staging } = stagingFrom();
    const cosmetic: Draft = {
      ...emptyDraft(),
      items: [stage({ kind: 'image', uri: 'a' }, { alt: 'x', edits: [{ kind: 'contrast', value: 0.3 }] })],
    };
    expect(draftReadiness(cosmetic, staging, 'with_original').issues.map((i) => i.code)).toContain(
      'edits_reversible',
    );

    const redacted: Draft = {
      ...emptyDraft(),
      items: [stage({ kind: 'image', uri: 'a' }, { alt: 'x', edits: [{ kind: 'blur', value: 9 }] })],
    };
    expect(draftReadiness(redacted, staging, 'with_original').issues.map((i) => i.code)).toContain('will_bake');
  });

  it('refuses an empty draft', () => {
    const { staging } = stagingFrom();
    expect(draftReadiness(emptyDraft(), staging, 'baked').canSend).toBe(false);
  });
});
