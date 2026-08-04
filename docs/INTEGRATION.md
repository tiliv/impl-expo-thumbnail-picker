# Wiring this into the real app

## 1. Copy `src/core`

Pure TypeScript, no React, no React Native.

| File | What it owns |
| --- | --- |
| `types.ts` | `VideoAsset`, `ThumbnailCandidate`, the attempt log shape |
| `roomState.ts` | `RoomStateStore` |
| `settings.ts` | State events → policy, with provenance and warnings |
| `filmstrip.ts` | Sample times, scrub maths, snapping |
| `scoring.ts` | The ranking policy |
| `strategy.ts` | The chain and `ThumbnailProvider` |

`src/adapters/expoProvider.ts` comes too, and is the file to read before
deciding what to build.

## 2. Decide about the native library-thumbnail module

This is the main call this repo exists to inform.

Writing it means a config plugin with one method per platform:

```
iOS      PHImageManager.default().requestImage(
           for: asset, targetSize: size, contentMode: .aspectFill, options: opts)
Android  contentResolver.loadThumbnail(uri, Size(w, h), null)
```

Both return quickly from a cache the OS already maintains. Skipping it means
every video thumbnail costs a decode, which on a scrolling grid is the
difference between instant and janky.

If you skip it, keep the `library` strategy in the chain anyway. It costs one
`unavailable` entry in the log, and it means adding the module later is a
provider change rather than a chain change.

## 3. Implement `ThumbnailProvider`

`expoProvider` is a working implementation with two honest holes. Whatever you
build, keep these properties:

- **`frameAt` returns failures, does not throw.** Seek-past-end and unsupported
  codec both land in the same catch and want different fixes, so keep the
  platform's own message.
- **`placeholder` cannot fail.** It is the chain's floor.
- **`scoreFrame` is optional.** Its absence must degrade `scored_sample` to
  `unavailable`, not crash it.

For `scoreFrame`, the cheapest real implementation is a downscale to ~32×32 and
a histogram: contrast from the luma spread, brightness from the mean, sharpness
from a Laplacian variance. It does not need to be good, it needs to be
consistent — the ranking is comparative.

## 4. Cache the results

`resolveThumbnail` has no cache and should not grow one; caching is the app's
problem because only the app knows the invalidation rules. Key on the asset id
plus the settings that can change the answer:

```ts
const key = `${asset.id}:${settings.strategyOrder.value.join(',')}` +
            `:${settings.defaultFrameMs.value}:${userPick?.atMs ?? 'none'}`;
```

Invalidate on room state change, on a new user pick, and on capability change.
The experiment's `ExperimentWorld` does exactly this and is a reasonable
starting shape.

Persist the winning URI, not the whole resolution — but keep the attempt log
in memory for the session, because it is what makes a support report useful.

## 5. Extraction is slow; treat it that way

Sequential extraction of nine samples on a long clip takes seconds. Before this
ships on a scrolling list:

- Cap concurrency, and cancel on scroll-away. `resolveThumbnail` takes no
  abort signal — adding one is a small change to the chain's loop and a
  parameter on `frameAt`.
- Resolve visible items first.
- Consider `frame_at` inline and `scored_sample` in the background, upgrading
  the thumbnail when it lands. The `strategy` field on the candidate is what
  lets you tell whether an upgrade is still pending.

## 6. Wire the scrubber, or do not

`allow_user_pick` gates the whole picker. If the first sprint ships without it,
leave `user_pick` out of the default `strategy_order` rather than shipping it
disabled — a strategy that always skips is noise in every log line.

If you do ship it, `core/filmstrip.ts` is the part that matters and
`FrameScrubber.tsx` is replaceable. Swapping `PanResponder` for
gesture-handler + Reanimated touches only the component.

## Decisions still to make

1. **Whether the picked frame is stored as a time or an image.** A time is tiny
   and re-derivable; an image survives the source video being deleted. If
   thumbnails outlive their videos — likely, given the retention work in the
   sibling templates — store the image.
2. **What `max_dimension` should actually do.** It resolves and nothing reads
   it, because `expo-video-thumbnails` takes quality rather than a target size.
   Downscaling needs a separate image op.
3. **Whether a degraded result should retry.** `resolution.degraded` marks a
   placeholder win, which is often transient (a video still copying from
   iCloud). Nothing retries.
4. **Whether the room should be able to force a re-pick** when policy changes —
   a room that turns on `reject_flat_frames` arguably wants existing black
   thumbnails re-resolved, and nothing currently invalidates them.

---

# Staging (second pass)

## 7. The bake path is the one thing that must exist before shipping

`bakeRequirement()` decides *that* an edit list must be flattened. Nothing
flattens it. RN's `filter` prop renders on the GPU; it has no export.

This matters more than a normal TODO because of what it is protecting. A user
who blurs a house number and sends it is making a privacy claim. Today the sheet
tells them it will be flattened and nothing does the flattening — so the
guarantee is currently written but not kept.

Options, cheapest first:

- **`react-native-view-shot`** — `captureRef` over the filtered view. Smallest
  change, works today, resolution is bounded by what you rendered.
- **Skia** — `@shopify/react-native-skia` offscreen surface with a colour
  matrix. Exact, full resolution, heaviest dependency.
- **Server-side** — send the original plus the list to a trusted transform.
  Fine for cosmetic edits; wrong for redaction, because the original leaves the
  device.

Wire it where `draftReadiness` reports `will_bake`:

```ts
for (const item of draft.items) {
  const bake = bakeRequirement(item.edits, staging.sendEdits.value);
  const source = bake.required ? await baker.flatten(item) : item.source;
  await transport.send({ ...item, source, edits: bake.required ? [] : item.edits });
}
```

Note the `edits: []` on the baked branch. Sending both the flattened pixels
*and* the list would defeat the point.

## 8. Persist the draft

`draftReducer` is pure and `Draft` is JSON-serialisable on purpose. Persist on
every action, restore on launch, drop on send. Descriptions are the expensive
part of a draft and the part users will not retype.

The one thing not serialisable is a picked thumbnail's `uri`, which points at a
cache file that may be evicted. Store `atMs` as the source of truth and
re-extract on restore — `chosenByUser` is what distinguishes a real choice from
a resolved default, and it must survive.

## 9. Where the scrub numbers came from

`PRECISION_LEVELS` in `core/scrub.ts` are tuned for short clips, which is the
stated constraint — attachment size limits mean the timeline is never so long
that a full-ratio drag cannot reach any timestamp.

If that assumption changes, the levels are the thing to revisit, not the
mechanic. On a long clip, full ratio becomes too coarse to be useful and the
fine detent becomes unreachable in one gesture. The fix is scaling `ratio` by
duration rather than adding levels.

`extractionWorthwhile()` assumes 30fps. Real assets carry a frame rate;
threading it through is a parameter, not a redesign.

## 10. Alt text is not the same field as a caption

`StagedItem.alt` is what a screen reader announces. If the envelope also has a
visible caption, that is a *different* string with a different audience, and
collapsing them produces captions that read like descriptions or descriptions
that assume you can see the image.

The sibling media-message template has both `alt` and `note` on its items for
this reason. Keep them separate when these merge.
