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
