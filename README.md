# impl-expo-thumbnail-picker

A contained, runnable experiment for **staging media before it is sent** —
describing it, adjusting it, and choosing which frame represents a video.

Expo SDK 57, dev client.

```bash
npm install
npx expo run:ios      # or run:android — dev client, not Expo Go
npm test              # 86 tests, no device needed
npm run typecheck
```

Two modes, switchable in the header:

- **staging** — the draft view. Attachments you can still change: description,
  filters, thumbnail. This is the main event.
- **resolution** — the strategy chain, for the attachments nobody opened a
  sheet for.

## The premise changed, deliberately

The original chain led with `library` — use the OS's cached thumbnail, avoid a
decode. **That reasoning does not survive a scrubber.** The moment someone
drags a timeline we are decoding frames anyway, and the library thumbnail has
saved us exactly one. So the default order now leads with the author's own
choice and falls back to sampling — both of which decode, on purpose:

```
user_pick → scored_sample → frame_at → library → placeholder
```

`library` stays at the back for the case that still matters: an attachment
nobody opened. `DECODE_AVERSE_ORDER` is kept and selectable in the panel so the
two are comparable, and the tests assert both.

The platform finding still stands and is still worth knowing. As of
`expo-media-library` 57, the JS API exposes no system-generated video
thumbnail on either platform — `getAssetInfoAsync` returns `localUri`,
dimensions, EXIF and location, nothing else. Reaching the OS's own thumbnails
means native (`PHImageManager` / `ContentResolver.loadThumbnail`). It is just
no longer on the critical path.

**Frame zero is still usually the worst guess.** Fade-ins, autoexposure
settling and splash screens all live at t=0 — which is now the third fallback
rather than the primary answer, so it costs a lot less.

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

## The scrubber is not a player

A player's playhead has its own intention — it wants to keep moving, and you
are trying to hold it on one frame. That is two behaviours fighting, and it is
why picking a thumbnail out of a video player is unpleasant.

So there is no play button, no transport, no autoplay, no timeline that runs on
its own. **The playhead moves while a finger is on it and stays where it was
left.** Scrubbing is the interaction, not a mode grafted onto playback.

What replaces playback is **precision**. Drag away from the strip — up or down,
whichever way there is room — and the same horizontal travel covers less time:

| Distance from strip | Ratio |
| --- | --- |
| 0 | Full |
| 60 | Half |
| 130 | Quarter |
| 210 | Fine (6%) |

Four discrete detents rather than a continuous ramp, because a continuous one
is impossible to feel your way back to and people navigate this by muscle
memory. Each detent fires a haptic and thickens the playhead, so you can feel
it without looking away from the preview.

That mechanic forces the one non-obvious decision in `core/scrub.ts`:
**position integrates from deltas, it is not mapped from absolute x.**

The tempting version maps the finger's x across the track straight to a
timestamp. It is simpler, and it breaks the instant precision changes: at
quarter speed the finger and the playhead are no longer in the same place, so
recomputing from absolute x snaps the playhead back under the finger and throws
away the fine adjustment that was the entire point. Integrating scaled deltas
means changing precision mid-drag is seamless — which is what makes sliding
away feel like leaning in rather than like switching modes. There is a test
that holds x still, changes dy, and asserts the position does not move at all.

Also: tapping the strip is an absolute jump, dragging is relative. Same
surface, and the difference is which gesture you did. Frame-step buttons exist
because the last 30ms of a hunt is faster to tap than to drag — and because a
bare drag surface has no switch-accessible equivalent.

Built on `PanResponder` and RN's `Animated`. Finger tracking is JS-bound either
way, so Reanimated would buy the settle animations rather than the drag; if the
scrub ever needs to leave the JS thread, only `ScrubDeck.tsx` changes and the
maths does not move.

## The staging sheet

Attaching is not committing. Items sit in a draft carrying their own
description, edit list and chosen thumbnail, and tapping one reopens its sheet
— as often as you like, right up until send.

Sheet order is deliberate: **picture, description, filters, thumbnail.** The
picture is first because that is what you tapped. The description is second
because it is the thing people skip, and burying it under the fun part
guarantees they skip it.

### Describing it

The centre of this is not the validation, it is the **READS AS** line:

```
READS AS   Image. Photo of a blue door
```

A field labelled "alt text" collects filenames. A field that shows what a
screen reader will actually say collects sentences, because the doubling in
"Image. Photo of…" is visible and "Image. IMG_4471" is visibly not an answer.

The checks are lint, not gatekeeping — missing, too short, pasted filename,
redundant opener (with a one-tap trim). Only a room that sets
`require_alt_text: required`, or a genuine length overrun, blocks the send. A
mediocre description beats a blocked send and an annoyed author.

### Adjusting it

Non-destructive: the original URI is never touched, an item carries an ordered
edit list, and every edit is individually removable. Presets are just sets of
slider values, so nudging one afterwards does not drop you into a "custom"
mode — there is nothing to fall out of.

Previews are **real**, not approximate. RN 0.76+ ships a `filter` style prop
backed by the platform compositor — brightness, contrast, saturate, grayscale,
sepia, hueRotate, invert, blur — so this is the same pipeline a browser uses,
on the GPU, with no extra dependency. Warmth is the one stand-in: there is no
warmth primitive, so it is approximated as a hue rotation.

### The bit that matters

**A non-destructive edit list is, by construction, reversible.** That is the
point while drafting and a serious problem at send time.

If someone blurs out a house number and we transmit original + `blur 8px`, the
recipient has the house number. The privacy affordance the user thinks they
applied is decoration.

So edits are classified. Cosmetic ones can travel as a list — smaller, and the
recipient renders at their own resolution. **Redactive ones are force-baked**,
and `bakeRequirement` overrides `send_edits: with_original` when it sees one.
That is not a preference the room gets to hold. The blur slider marks itself
"hides detail · will be flattened" the moment it crosses the threshold, so the
reclassification is visible while you are dragging rather than at send.

A room configured `with_original` also raises a danger-level warning at resolve
time, because it is the wrong default for anywhere people redact.

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

`app.envelope.staging`: `require_alt_text` (`off` / `warn` / `required`),
`alt_text_max_chars`, `allow_filters`, `send_edits` (`baked` /
`with_original`), `max_attachments`.

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
src/core/           scrub maths, edit list, alt-text policy, draft reducer,
                    strategy chain, scoring policy, settings
src/adapters/       expoProvider — the real one, and where the honest notes live
src/ui/             staging tray, item sheet, scrub deck, filter rail,
                    alt-text field, thumbnail card with attempt log
src/experiment/     synthetic clips, fake provider, scenarios, control panel
```

See [`docs/INTEGRATION.md`](docs/INTEGRATION.md).

## Known edges

- **Baking is not implemented.** `bakeRequirement` returns a requirement;
  nothing flattens pixels. RN's `filter` renders, it does not export. The bake
  path is `react-native-view-shot`'s `captureRef` over the filtered view, Skia,
  or a server-side transform — an adapter, and the one real gap between this
  and shipping. A redactive edit currently *says* it will be flattened and
  nothing flattens it.
- **The draft is not persisted.** The reducer is pure and the state is
  serialisable specifically so it can be, and it is not wired up. Someone who
  has written four descriptions and lost them to a backgrounded app does not
  write them again.
- Warmth's preview is a hue-rotate stand-in. A real warmth control is a colour
  matrix, which needs the same GPU pass baking needs.
- No caching. Every resolve re-extracts; `resolveThumbnail` has no cache hook,
  deliberately — see `docs/INTEGRATION.md`.
- `max_dimension` resolves but nothing downscales — `expo-video-thumbnails`
  takes `quality`, not a target size.
- Extraction is sequential with no cancel path. Sampling nine frames on a long
  clip is slow enough to want a concurrency limit and an abort signal.
- Reordering exists in the reducer and is tested, but the tray has no drag
  handle wired to it.
