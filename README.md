# impl-expo-thumbnail-picker

A contained, runnable experiment for **getting a thumbnail out of a video** —
the base case, and the timeline picker it eventually wants to become.

Expo SDK 57, dev client.

```bash
npm install
npx expo run:ios      # or run:android — dev client, not Expo Go
npm test              # 40 tests, no device needed
npm run typecheck
```

## Read this bit first

The base case as stated — *use whatever the photo library had for it, if that's
available, or the first frame* — has a problem in each half.

**The library half does not run.** As of `expo-media-library` 57, the JS API
exposes no system-generated video thumbnail on either platform.
`getAssetInfoAsync` returns `localUri`, dimensions, EXIF and location, and
nothing else. The thumbnails the OS already generated — the ones Photos scrolls
through instantly — are reachable only from native:

| | |
| --- | --- |
| iOS | `PHImageManager.requestImage(for:targetSize:contentMode:options:)` |
| Android | `ContentResolver.loadThumbnail(uri, size, signal)` |

That is a small config-plugin module: one method, takes an asset id and a
target size, returns a file URI. **Worth writing.** Falling through to
extraction means decoding the video, which is roughly two orders of magnitude
slower than handing back a thumbnail the OS made at import time — on a grid of
videos that is the difference between instant and visibly janky.

**The first-frame half is usually the worst available guess.** Fade-ins,
autoexposure settling, and splash screens on screen recordings all live at
t=0. Frame zero is black more often than not.

Neither of these is a reason not to ship the base case. They are reasons the
code needs an attempt log, so the answer to "why is this video grey" is on
screen instead of in a debugging session.

## The chain

`resolveThumbnail()` tries strategies in room-configured order and stops at the
first success, recording why each earlier one did not win.

| Strategy | Does |
| --- | --- |
| `library` | OS photo-library thumbnail — currently always `unavailable`, with the reason above |
| `embedded` | Container poster atom — needs native parsing, also `unavailable` |
| `frame_at` | Extract at `default_frame_ms`. The workhorse |
| `scored_sample` | Extract N frames, rank them, take the best |
| `user_pick` | A frame the user chose off the timeline |
| `placeholder` | Never fails. Leave it at the end |

Every attempt records `ok` / `unavailable` / `failed` / `skipped` with a
reason, and those four are meaningfully different:

- `unavailable` — cannot run here (no native module, no library asset, user has
  not picked yet)
- `failed` — ran and broke, keeping the decoder's own words
- `skipped` — policy said no

"The user has not picked a frame yet" and "this room forbids picking" are both
reasons `user_pick` does not produce a thumbnail, and they need different
words. That distinction is tested.

## Sampling, and why the ends are excluded

`sampleTimes()` never samples the very first or very last frame. Evenly
dividing a duration sounds obviously right and puts samples exactly where the
fades, the autoexposure settle and the reach-for-the-stop-button live.

The inset is proportional with an absolute cap — 3% of a ten-second clip is
300ms, about right; 3% of a two-hour recording is over three minutes, not.

## Scoring is policy, and it is in one file

Producing a `FrameScore` needs pixel access and is an adapter concern. Turning
scores into a choice is policy, and it lives in `core/scoring.ts` where it can
be argued with:

```
contrast 0.45   sharpness 0.30   brightness 0.15   face 0.10
```

Three claims worth disagreeing with. Contrast leads because the failure this
exists to prevent is the flat frame, and contrast catches black *and* blown-out
white. Brightness is scored as distance from mid, not "more is better" — a
white splash screen and a black fade rank identically badly, which is correct
and is tested.

`reject_flat_frames` decides what happens when every sample is flat: fail
honestly and let the chain continue, or return the least-bad black frame and
call it a success. A clip where every sample is flat is usually a black video
or a failed extraction, and both want a different answer than "pick one
anyway". The template surfaces the choice rather than making it.

**No pixel scorer ships here.** Nothing in Expo's JS surface reads pixels out
of a JPEG on disk. The options, in ascending effort: a Skia/GL offscreen draw
plus readback, an image-processing native module, or a downscale-and-histogram
in a worklet. Until one exists `scored_sample` reports `unavailable` on device.
The experiment ships a synthetic scorer so the ranking policy is still
exercisable — and fully tested.

## The stretch goal

`allow_user_pick` gates a filmstrip scrubber. Drag the strip, the preview
follows, "use this frame" wins the chain outright.

Two details that separate it from a slider, both in `core/filmstrip.ts` so they
are testable without a gesture:

- **Snapping.** Dragging generates far more positions than can be extracted.
  Snapping to the filmstrip's already-extracted times stops the preview
  flickering between cached and fresh frames, which otherwise reads as jitter
  rather than precision.
- **Debounced extraction.** The filmstrip is the immediate feedback; the sharp
  preview catches up ~120ms later.

Built on `PanResponder` rather than gesture-handler — one fewer native module
to reconcile when this lands in the real app. If the scrub needs to run off the
JS thread, swapping in gesture-handler and Reanimated touches only
`FrameScrubber.tsx`; the maths does not move.

## Synthetic clips

Fixtures carry a `profile` describing what the footage is actually like —
`fade_in`, `screen_recording`, `well_lit`, `all_black`, `shaky` — and the fake
provider answers accordingly. Frames render from that profile, so **the
fade-in clip really does draw black at 0ms.** The claim that the first frame is
a bad guess is something you watch rather than something this README asserts.

The panel's **+ add a real video from the library** button runs a real device
video through the real provider, which is the only way to find out what your
actual camera roll does to the extraction path.

## Room settings

`app.envelope.thumbnail`: `strategy_order`, `default_frame_ms`,
`allow_user_pick`, `filmstrip_frames`, `sample_count`, `max_dimension`,
`quality`, `reject_flat_frames`.

Room-controlled because rooms have opinions: one that must not surface an
unreviewed frame wants `allow_user_pick` off and a fixed time; one full of long
screen recordings wants sampling.

Unknown strategy names are dropped individually; an order with nothing usable
falls back to the default chain, because a room must not be able to leave every
video without a thumbnail. Omitting `placeholder` from the chain is allowed and
raises a warning — resolution can then legitimately end with `null`, and the
renderer has to handle it.

## Layout

```
src/core/           strategy chain, scoring policy, filmstrip maths, settings
src/adapters/       expoProvider — the real one, and where the honest notes live
src/ui/             thumbnail card with attempt log, filmstrip scrubber
src/experiment/     synthetic clips, fake provider, scenarios, control panel
```

See [`docs/INTEGRATION.md`](docs/INTEGRATION.md).

## Known edges

- No caching or persistence. Every resolve re-extracts; a real app wants a
  content-addressed thumbnail cache, and `resolveThumbnail` has no cache hook.
- `max_dimension` resolves but nothing downscales — `expo-video-thumbnails`
  takes `quality`, not a target size.
- The scrubber does not play the video. Swapping in `expo-video`'s seek for a
  live preview is the obvious upgrade and would remove the extraction debounce
  entirely.
- Extraction is sequential. Sampling nine frames on a long clip is slow enough
  to want a concurrency limit and a cancel path, and has neither.
