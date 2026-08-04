/**
 * A staged draft, packed for the wire.
 *
 * The other sandboxes' packing files are mostly about content shape. This one is
 * about **what gets uploaded**, and it found two things that constrain the feature.
 *
 * ## 1. A redactive edit cannot ship as a rendering hint
 *
 * The tempting design is to upload the original bytes and put the edit list in the
 * envelope, so the recipient applies it. That is fine for `brightness` and
 * `sepia`. It is a privacy hole for `blur`: if someone blurs a face and we ship
 * the original plus `{ blur: 0.8 }`, the face is in the ciphertext, and every
 * recipient — plus anyone who ever gets that room key — can simply not apply the
 * hint.
 *
 * `edits.isRedactive()` already draws this line. `uploadPlan()` reads it and says
 * which items must be **flattened before upload**. Getting this backwards produces
 * a feature that appears to work perfectly and silently ships exactly what the
 * user thought they had removed.
 *
 * ## 2. A custom thumbnail is a second upload, and it counts against the cap
 *
 * A chosen video frame is its own encrypted blob with its own `mediaId`. So a
 * video with an author-picked thumbnail costs **two** of the ten `mediaIds` a
 * revocation can cover. Five such videos and the envelope is already at the
 * ceiling — a limit that reads as "10 attachments" but is really "10 blobs".
 *
 * `uploadPlan()` counts blobs, not items, for exactly this reason.
 */

import {
  asNumber,
  asString,
  decodeWire,
  isRecord,
  makeTxnId,
  MEDIA_IDS_PER_REVOCATION,
  wireTimestampMs,
  type DecodedEnvelope,
  type EncryptedFileRef,
  type OutgoingEnvelope,
  type WireEvent,
} from './envelope';
import { isNeutral, isRedactive, type Edit, type EditList } from './edits';
import type { Draft, StagedItem } from './draft';
import type { UserId } from './types';

export const MESSAGE_EVENT_TYPE = 'm.room.message';
export const MULTI_MSGTYPE = 'app.envelope.multi';

// ── Deciding what to upload ─────────────────────────────────────────────────

/** How an item's pixels must reach the server. */
export type UploadMode =
  /**
   * Upload the original; ship the edit list as a hint the recipient applies.
   * Only safe when every edit is cosmetic and reversible.
   */
  | 'original_with_hints'
  /**
   * Render the edits into the bytes and upload *that*. Required when any edit
   * removes information the author meant to remove.
   */
  | 'flatten_before_upload';

export interface ItemUploadPlan {
  itemId: string;
  mode: UploadMode;
  /** The edits that forced flattening. Empty for `original_with_hints`. */
  redactive: Edit[];
  /** How many encrypted blobs this item needs. 2 when it has a custom thumbnail. */
  blobCount: number;
}

export interface UploadPlan {
  items: ItemUploadPlan[];
  /** Total encrypted blobs — the number that matters against the revoke cap. */
  blobCount: number;
  /** True when every blob can be revoked with the message. */
  fullyRevocable: boolean;
  /** Items that must be flattened. Non-empty means real work before send. */
  mustFlatten: string[];
}

/**
 * What sending this draft actually requires.
 *
 * Deliberately computed before any upload happens, because both findings above
 * are decisions that have to be made *before* bytes leave: flattening cannot be
 * retrofitted onto an upload, and discovering the blob cap after uploading twelve
 * files means twelve orphans.
 */
export function uploadPlan(draft: Draft): UploadPlan {
  const items: ItemUploadPlan[] = draft.items.map((item) => {
    const redactive = item.edits.filter((e) => !isNeutral(e) && isRedactive(e));
    return {
      itemId: item.id,
      mode: redactive.length > 0 ? ('flatten_before_upload' as const) : ('original_with_hints' as const),
      redactive,
      // The custom thumbnail is a separate blob. This is the line that turns
      // "10 attachments" into "10 blobs".
      blobCount: 1 + (item.thumbnail !== null && item.thumbnail.chosenByUser ? 1 : 0),
    };
  });

  const blobCount = items.reduce((n, i) => n + i.blobCount, 0);
  return {
    items,
    blobCount,
    fullyRevocable: blobCount <= MEDIA_IDS_PER_REVOCATION,
    mustFlatten: items.filter((i) => i.mode === 'flatten_before_upload').map((i) => i.itemId),
  };
}

/**
 * The edits that are safe to transmit as hints.
 *
 * Neutral edits are dropped — shipping `{ brightness: 1.0 }` is noise, and a
 * recipient applying a no-op is a wasted decode. Redactive ones are dropped too,
 * because when the mode is `flatten_before_upload` they are already baked into the
 * pixels; sending them again would apply them twice.
 */
export const transmissibleEdits = (edits: EditList): Edit[] =>
  edits.filter((e) => !isNeutral(e) && !isRedactive(e));

// ── Packing ─────────────────────────────────────────────────────────────────

/** One staged item plus the blobs it produced. */
export interface PackableStagedItem {
  item: StagedItem;
  /** The item's own pixels — flattened when the plan said so. */
  file: EncryptedFileRef;
  /** The author's chosen thumbnail, when there is one. Its own blob. */
  thumbnail?: EncryptedFileRef;
}

export interface PackStagedInput {
  items: PackableStagedItem[];
  caption?: string;
  seed: string | number;
}

export interface PackedStaged extends OutgoingEnvelope {
  /** Blobs past the tenth: shipped, but not revocable with the message. */
  overflow: string[];
}

export function packStaged(input: PackStagedInput): PackedStaged {
  const items = input.items.map(({ item, file, thumbnail }) => {
    const entry: Record<string, unknown> = {
      msgtype: item.source.kind === 'video' ? 'm.video' : 'm.image',
      file,
      info: infoFor(item, thumbnail),
    };
    // Alt text is the author's, and it is the one field here that has to survive
    // even when the pixels do not — a screen reader on a 410'd image still wants it.
    if (item.alt.trim() !== '') entry['app.envelope.alt'] = item.alt.trim();

    const hints = transmissibleEdits(item.edits);
    if (hints.length > 0) {
      entry['app.envelope.edits'] = hints.map((e) => ({ kind: e.kind, value: e.value }));
    }
    return entry;
  });

  // Item blob first, then its thumbnail, so the order matches `uploadPlan`'s
  // blob count and a truncated revoke drops thumbnails before originals.
  const mediaIds: string[] = [];
  for (const { file, thumbnail } of input.items) {
    mediaIds.push(file.mediaId);
    if (thumbnail) mediaIds.push(thumbnail.mediaId);
  }

  const content: Record<string, unknown> = {
    msgtype: MULTI_MSGTYPE,
    body: input.caption?.trim() || `${input.items.length} attachment${input.items.length === 1 ? '' : 's'}`,
    'app.envelope.items': items,
  };
  if (input.caption?.trim()) content['app.envelope.caption'] = input.caption.trim();

  return {
    eventType: MESSAGE_EVENT_TYPE,
    content,
    txnId: makeTxnId(input.seed),
    mediaIds,
    overflow: mediaIds.slice(MEDIA_IDS_PER_REVOCATION),
  };
}

function infoFor(item: StagedItem, thumbnail?: EncryptedFileRef): Record<string, unknown> {
  const info: Record<string, unknown> = { mimetype: mimetypeFor(item) };
  if (item.source.width !== undefined) info['w'] = item.source.width;
  if (item.source.height !== undefined) info['h'] = item.source.height;
  if (item.source.durationMs !== undefined) info['duration'] = item.source.durationMs;
  if (thumbnail !== undefined) {
    // The thumbnail is a full encrypted file, not a URL — it needs its own key,
    // and a recipient who cannot decrypt it must still be able to show the video.
    info['thumbnail_file'] = thumbnail;
    if (item.thumbnail !== null) {
      // Kept so a recipient can tell a deliberate frame from a fallback, and so a
      // re-extract lands on the same frame.
      info['app.envelope.thumbnail_at_ms'] = item.thumbnail.atMs;
      info['app.envelope.thumbnail_chosen'] = item.thumbnail.chosenByUser;
    }
  }
  return info;
}

const mimetypeFor = (item: StagedItem): string =>
  item.source.kind === 'video' ? 'video/mp4' : 'image/jpeg';

// ── Unpacking ───────────────────────────────────────────────────────────────

export interface ReceivedItem {
  mediaId: string;
  kind: 'image' | 'video';
  mimetype: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  alt: string | null;
  /** Cosmetic edits the sender asked us to apply. Never redactive. */
  edits: Edit[];
  thumbnail: { mediaId: string; atMs: number | null; chosenByUser: boolean } | null;
}

export interface ReceivedStaged {
  eventId: string;
  sender: UserId;
  originTs: number;
  caption: string | null;
  items: ReceivedItem[];
  files: EncryptedFileRef[];
}

export function unpackStaged(wire: WireEvent): DecodedEnvelope<ReceivedStaged> {
  return decodeWire<ReceivedStaged>(
    wire,
    (_eventType, content) => {
      if (asString(content['msgtype']) !== MULTI_MSGTYPE) return null;
      const raw = content['app.envelope.items'];
      if (!Array.isArray(raw) || raw.length === 0) return null;

      const items: ReceivedItem[] = [];
      const files: EncryptedFileRef[] = [];
      for (const entry of raw) {
        if (!isRecord(entry)) continue;
        const file = isRecord(entry['file']) ? (entry['file'] as unknown as EncryptedFileRef) : null;
        if (file === null || typeof file.mediaId !== 'string') continue;

        const info = isRecord(entry['info']) ? entry['info'] : {};
        const thumbFile = isRecord(info['thumbnail_file'])
          ? (info['thumbnail_file'] as unknown as EncryptedFileRef)
          : null;

        items.push({
          mediaId: file.mediaId,
          kind: asString(entry['msgtype']) === 'm.video' ? 'video' : 'image',
          mimetype: asString(info['mimetype']) ?? 'application/octet-stream',
          width: asNumber(info['w']),
          height: asNumber(info['h']),
          durationMs: asNumber(info['duration']),
          alt: asString(entry['app.envelope.alt']),
          edits: readEdits(entry['app.envelope.edits']),
          thumbnail:
            thumbFile === null || typeof thumbFile.mediaId !== 'string'
              ? null
              : {
                  mediaId: thumbFile.mediaId,
                  atMs: asNumber(info['app.envelope.thumbnail_at_ms']),
                  chosenByUser: info['app.envelope.thumbnail_chosen'] === true,
                },
        });
        files.push(file);
        if (thumbFile !== null && typeof thumbFile.mediaId === 'string') files.push(thumbFile);
      }
      if (items.length === 0) return null;

      return {
        eventId: wire.eventId,
        sender: wire.senderUserId as UserId,
        originTs: wireTimestampMs(wire),
        caption: asString(content['app.envelope.caption']),
        items,
        files,
      };
    },
    (eventType) => eventType === MESSAGE_EVENT_TYPE,
  );
}

/**
 * Read incoming edit hints, dropping anything redactive.
 *
 * The sender should never have transmitted a redactive hint, and a receiver that
 * trusts them to have flattened is a receiver that renders an unblurred face the
 * day a sender gets it wrong. So the filter runs on both sides — cheap, and the
 * asymmetry is the point: we cannot un-see pixels, only decline to un-blur them.
 */
function readEdits(raw: unknown): Edit[] {
  if (!Array.isArray(raw)) return [];
  const out: Edit[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const kind = asString(entry['kind']);
    const value = asNumber(entry['value']);
    if (kind === null || value === null) continue;
    const edit = { kind, value } as Edit;
    try {
      if (isRedactive(edit) || isNeutral(edit)) continue;
    } catch {
      // Unknown kind — `EDIT_SPECS` has no entry, so we cannot judge it. Drop it
      // rather than apply something we do not understand.
      continue;
    }
    out.push(edit);
  }
  return out;
}
