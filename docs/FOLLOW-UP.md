# Follow-up

Reviewed while planning `impl-expo-message-composer`. No change of direction.

## This repo's `ItemSheet` is the composer's per-item sheet

The scope here widened once already — from "extract a thumbnail" to "stage media
before it is sent: description, filters, and which frame represents a video" —
and that widening landed it exactly on the composer's per-attachment editing
surface. `Staging` in `App.tsx` is a small composer with no text field.

So when `impl-expo-message-composer` is built, **it lifts this repo's staging
model rather than rewriting it**:

| Lift | From here |
| --- | --- |
| The per-item sheet | `ui/ItemSheet.tsx`, `ui/ScrubDeck.tsx`, `ui/StagingTray.tsx` |
| Item edit state | `core/edits.ts`, `core/altText.ts`, `core/draft.ts` |
| Thumbnail resolution | `core/strategy.ts`, `core/scoring.ts`, `core/filmstrip.ts` |

The composer adds what is not here: text drafting alongside, the preparation
queue, upload state, the cap, and failure injection. It does not add a second
opinion about what a staged item is.

One boundary to draw when that happens: this repo's `draft.ts` and the
composer's `draft.ts` are the same concept at two sizes. The composer's is the
superset. When the composer exists, this repo's is the one that should be
treated as the excerpt, not the other way round.

## The negative finding needs re-verifying on 56

`expo-media-library` exposes no system video thumbnail. That is a statement
about **Expo 57**, which is a full SDK major ahead of the app (Expo 56 /
RN 0.85.3). The standing caveat for every sandbox in this family applies with
most force to this one, because its findings are platform-capability findings
and a negative result is exactly the kind that gets built around.

Before the app builds a fallback chain on the strength of it: re-check on 56.

## Not changing

The strategy chain leading with the author's own pick rather than optimising to
avoid a decode. Once scrubbing is the interaction, the decode is already paid
for, and `decode-averse` is kept in the panel purely as a comparison. That
reasoning is recorded in `ControlPanel.tsx` and should survive the lift.
