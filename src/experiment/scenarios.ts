/**
 * Scenarios: arrange a clip and a policy, then watch which strategy wins and
 * why the others did not.
 *
 * The base-case group exists to make one point concretely: the two-line
 * version of this feature — library thumbnail, else first frame — produces a
 * black square on a majority of real camera-roll footage, and on Expo today
 * the library half does not run at all.
 */

import { stateEvent } from '../core/roomState';
import { STATE_STAGING, STATE_THUMBNAIL } from '../core/settings';
import { clip, type ExperimentWorld } from './world';

export interface Scenario {
  id: string;
  title: string;
  question: string;
  group: 'base-case' | 'sampling' | 'picker' | 'failure' | 'staging';
  arrange(world: ExperimentWorld): void;
  expect: string[];
  tryNext?: string[];
}

const config = (content: Record<string, unknown>) =>
  stateEvent(STATE_THUMBNAIL, content, { sender: '@admin:example.org' });

const stagingConfig = (content: Record<string, unknown>) =>
  stateEvent(STATE_STAGING, content, { sender: '@admin:example.org' });

export const SCENARIOS: Scenario[] = [
  {
    id: 'base-case',
    title: 'The stated base case',
    group: 'base-case',
    question: 'What does "library thumbnail, else first frame" actually produce?',
    arrange(w) {
      w.add(clip('fade_in', 12_000, 210), clip('well_lit', 9_000, 40));
    },
    expect: [
      'library is attempted and reports unavailable — Expo exposes no system thumbnail.',
      'embedded is attempted and reports unavailable — no container-metadata reader.',
      'frame_at wins at 0ms, which on the fade-in clip is two seconds of black.',
      'The attempt log shows all four steps. Nothing is skipped silently.',
    ],
    tryNext: [
      'Turn on the "native library module" capability and watch library win instantly instead.',
      'Set default_frame_ms to 3000 and compare.',
    ],
  },

  {
    id: 'library-available',
    title: 'If the native module existed',
    group: 'base-case',
    question: 'What is the fallback actually costing?',
    arrange(w) {
      w.setCapabilities({ hasLibraryThumbnails: true });
      w.add(clip('fade_in', 12_000, 210), clip('screen_recording', 40_000, 120));
    },
    expect: [
      'library wins first, for both clips, without decoding anything.',
      'Its candidate has no atMs — the OS does not say which frame it used.',
      'This is roughly two orders of magnitude cheaper than extraction, which is the argument for writing it.',
    ],
  },

  {
    id: 'splash-screen',
    title: 'Screen recording with a splash',
    group: 'base-case',
    question: 'Is a fixed frame time ever the right answer?',
    arrange(w) {
      w.stateStore.send(config({ default_frame_ms: 3000 }));
      w.add(clip('screen_recording', 40_000, 120));
    },
    expect: [
      'Moving to 3000ms fixes the fade-in case and still lands on the splash screen here.',
      'A flat white frame scores as badly as a flat black one; only the direction differs.',
      'No single fixed time is right across clips. That is the case for sampling.',
    ],
  },

  {
    id: 'scored-sample',
    title: 'Sample and rank',
    group: 'sampling',
    question: 'Can we pick a good frame without asking the user?',
    arrange(w) {
      w.stateStore.send(
        config({
          strategy_order: ['library', 'scored_sample', 'frame_at', 'placeholder'],
          sample_count: 7,
        }),
      );
      w.add(clip('fade_in', 12_000, 210), clip('screen_recording', 40_000, 120), clip('shaky', 20_000, 300));
    },
    expect: [
      'Seven frames are extracted from an inset window — never 0ms, never the final frame.',
      'The fade-in clip settles on a frame after the fade; the splash clip on one after the splash.',
      'The shaky clip picks from its middle third, where sharpness peaks.',
      'The ranked list is shown with each frame\'s score, so the weights are arguable rather than magic.',
    ],
    tryNext: ['Open the weights in core/scoring.ts and disagree with them; they are a starting position.'],
  },

  {
    id: 'all-black',
    title: 'A clip with no good frame',
    group: 'sampling',
    question: 'What should happen when every frame is bad?',
    arrange(w) {
      w.stateStore.send(
        config({
          strategy_order: ['scored_sample', 'frame_at', 'placeholder'],
          reject_flat_frames: true,
        }),
      );
      w.add(clip('all_black', 8_000, 0));
    },
    expect: [
      'Every sample is flat, so scored_sample fails rather than returning the least-bad black frame.',
      'The chain falls through to frame_at, which succeeds — a black thumbnail is still a thumbnail.',
      'Turn reject_flat_frames off and scored_sample "succeeds" with something indistinguishable from failure.',
      'Which of those two you want is a product decision the log makes visible.',
    ],
  },

  {
    id: 'user-pick',
    title: 'Pick a frame off the timeline',
    group: 'picker',
    question: 'What does the stretch goal feel like?',
    arrange(w) {
      w.stateStore.send(
        config({
          strategy_order: ['user_pick', 'scored_sample', 'frame_at', 'placeholder'],
          allow_user_pick: true,
          filmstrip_frames: 12,
        }),
      );
      w.add(clip('well_lit', 24_000, 40), clip('shaky', 20_000, 300));
    },
    expect: [
      'Tap a video to open the scrubber; drag the filmstrip and the preview follows.',
      'user_pick sits first in the chain but reports unavailable until you actually choose.',
      'Once chosen it wins, and the log shows the automatic strategies were never run.',
      'Scrub positions snap to already-extracted frames when close, so dragging does not flicker.',
    ],
  },

  {
    id: 'picker-disabled',
    title: 'Room forbids user picking',
    group: 'picker',
    question: 'Can a room insist nobody hand-picks a frame?',
    arrange(w) {
      w.stateStore.send(
        config({
          strategy_order: ['user_pick', 'scored_sample', 'placeholder'],
          allow_user_pick: false,
        }),
      );
      w.add(clip('well_lit', 24_000, 40));
    },
    expect: [
      'user_pick reports skipped, with the room as the reason — distinct from "not chosen yet".',
      'A resolver warning points out the chain contains a strategy that can never run.',
      'The scrubber does not open at all.',
    ],
  },

  {
    id: 'extraction-broken',
    title: 'Decoder refuses the file',
    group: 'failure',
    question: 'What does a genuinely broken video look like?',
    arrange(w) {
      w.setCapabilities({ extractionBroken: true });
      w.stateStore.send(config({ strategy_order: ['library', 'scored_sample', 'frame_at', 'placeholder'] }));
      w.add(clip('well_lit', 15_000, 40));
    },
    expect: [
      'Every extraction fails with the decoder\'s own words, kept rather than flattened.',
      'scored_sample reports that all samples failed, listing the first few.',
      'The placeholder wins and the result is marked degraded.',
      'degraded is the flag worth surfacing in a real app — it means retry might help.',
    ],
  },

  {
    id: 'no-placeholder',
    title: 'Chain with no placeholder',
    group: 'failure',
    question: 'Can a room configure videos into having no thumbnail at all?',
    arrange(w) {
      w.setCapabilities({ extractionBroken: true });
      w.stateStore.send(config({ strategy_order: ['library', 'frame_at'] }));
      w.add(clip('well_lit', 15_000, 40));
    },
    expect: [
      'Yes — the resolution ends with a null candidate.',
      'An info-level warning flags the missing placeholder at resolve time.',
      'The renderer has to handle null; there is no safe default hiding behind it.',
    ],
  },

  {
    id: 'bad-config',
    title: 'Room sends nonsense config',
    group: 'failure',
    question: 'Can a bad state event break thumbnails?',
    arrange(w) {
      w.stateStore.send(
        config({
          strategy_order: ['telepathy', 'frame_at', 'vibes'],
          sample_count: 999,
          quality: 'high',
          default_frame_ms: -400,
        }),
      );
      w.add(clip('well_lit', 15_000, 40));
    },
    expect: [
      'Unknown strategies are dropped individually; frame_at survives and runs.',
      'sample_count clamps to 16, quality falls back to 0.8, default_frame_ms clamps to 0.',
      'A list with nothing usable in it falls back to the default chain entirely.',
    ],
  },
];

SCENARIOS.push(
  {
    id: 'staging-basic',
    title: 'Staging a draft',
    group: 'staging',
    question: 'What can you still change after attaching?',
    arrange(w) {
      w.add(clip('fade_in', 14_000, 210), clip('well_lit', 22_000, 40));
    },
    expect: [
      'Both clips land in the tray with "no description" badges and auto frames.',
      'Tapping one opens its sheet: describe, adjust, thumbnail.',
      'Everything stays editable until send — reopen the sheet as often as you like.',
      'The READS AS line shows what a screen reader will actually announce.',
    ],
    tryNext: ['Type "Photo of the whiteboard" and watch the announcement read "Image. Photo of…".'],
  },

  {
    id: 'staging-alt-required',
    title: 'Room requires descriptions',
    group: 'staging',
    question: 'Can a room insist attachments are described?',
    arrange(w) {
      w.stateStore.send(stagingConfig({ require_alt_text: 'required' }));
      w.add(clip('well_lit', 18_000, 90), clip('shaky', 12_000, 300));
    },
    expect: [
      'Send is blocked until every attachment has a description.',
      'The blocking issues name which item, so a tray of eight is navigable.',
      'Set it back to warn and send unblocks while the nudge stays.',
    ],
  },

  {
    id: 'staging-redaction',
    title: 'Blurring something out',
    group: 'staging',
    question: 'Is a non-destructive blur actually private?',
    arrange(w) {
      w.stateStore.send(stagingConfig({ send_edits: 'with_original' }));
      w.add(clip('well_lit', 16_000, 120));
    },
    expect: [
      'A room-level danger warning fires immediately: edits sent with the original are reversible.',
      'Push blur past 3 and the slider marks it "hides detail · will be flattened".',
      'The sheet says the image will be baked anyway, overriding the room policy.',
      'That override is not a preference — a reversible redaction is a decoration.',
    ],
    tryNext: ['Set send_edits back to baked and watch the wording change but the outcome stay safe.'],
  },

  {
    id: 'staging-scrub',
    title: 'Fine scrubbing',
    group: 'staging',
    question: 'Can you land on one specific frame without a player?',
    arrange(w) {
      w.stateStore.send(config({ filmstrip_frames: 14 }));
      w.add(clip('fade_in', 30_000, 260), clip('screen_recording', 45_000, 120));
    },
    expect: [
      'No play button anywhere. The playhead moves only under your finger.',
      'Drag away from the strip and the pill shows Half, Quarter, Fine — each with a haptic.',
      'Position integrates from deltas, so changing precision mid-drag never snaps the playhead.',
      'Tapping the strip is an absolute jump; dragging is relative. Same surface, different gesture.',
    ],
  },
);

export const DEFAULT_SCENARIO = SCENARIOS.find((s) => s.id === 'staging-basic') ?? SCENARIOS[0];

export function loadScenario(world: ExperimentWorld, scenario: Scenario): void {
  world.reset();
  scenario.arrange(world);
}
