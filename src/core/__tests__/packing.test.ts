/**
 * What actually gets uploaded, and what a revoke can take back.
 *
 * Two findings drive this file: a redactive edit must be baked into the bytes
 * before upload, and a custom thumbnail is a second blob that counts against the
 * ten-media revocation cap.
 */

import { isFullyRevocable, MEDIA_IDS_PER_REVOCATION, revocationPlan, type EncryptedFileRef, type WireEvent } from '../envelope';
import { emptyDraft, stage, type Draft, type StagedItem } from '../draft';
import { setEdit } from '../edits';
import { packStaged, transmissibleEdits, unpackStaged, uploadPlan, type PackableStagedItem } from '../packing';

const file = (mediaId: string): EncryptedFileRef => ({
  mediaId,
  key: { alg: 'A256CTR', ext: true, k: 'k'.repeat(43), key_ops: ['encrypt', 'decrypt'], kty: 'oct' },
  iv: 'aXY=',
  hashes: { sha256: 'c2hh' },
  v: 'v2',
  mimetype: 'image/jpeg',
  sizeBytes: 4096,
});

const photo = (id: string, over: Partial<StagedItem> = {}): StagedItem =>
  stage({ kind: 'image', uri: `file://${id}.jpg`, width: 1290, height: 2796 }, { id, ...over });

const clip = (id: string, over: Partial<StagedItem> = {}): StagedItem =>
  stage({ kind: 'video', uri: `file://${id}.mp4`, width: 1920, height: 1080, durationMs: 14_000 }, { id, ...over });

const draftOf = (items: StagedItem[]): Draft => ({ ...emptyDraft(), items });

const wireOf = (content: Record<string, unknown>, over: Partial<WireEvent> = {}): WireEvent => ({
  eventId: '$evt-1',
  txnId: 'n-1',
  senderUserId: '@alice:noodles',
  eventType: 'm.room.message',
  content,
  createdAt: '2026-08-04T12:00:00.000Z',
  revoked: false,
  ...over,
});

describe('redactive edits must be flattened before upload', () => {
  it('ships cosmetic edits as hints on the original', () => {
    const item = photo('i1', { edits: setEdit([], 'sepia', 0.6) });
    const plan = uploadPlan(draftOf([item]));

    expect(plan.items[0]!.mode).toBe('original_with_hints');
    expect(plan.mustFlatten).toEqual([]);
  });

  it('requires flattening when an edit removes information', () => {
    // A blur strong enough to redact. Uploading the original plus `{ blur: 0.9 }`
    // puts the unblurred pixels in the ciphertext, and every recipient can simply
    // not apply the hint.
    const item = photo('i1', { edits: setEdit([], 'blur', 8) });
    const plan = uploadPlan(draftOf([item]));

    expect(plan.items[0]!.mode).toBe('flatten_before_upload');
    expect(plan.items[0]!.redactive.map((e) => e.kind)).toEqual(['blur']);
    expect(plan.mustFlatten).toEqual(['i1']);
  });

  it('never transmits a redactive edit as a hint', () => {
    // It is already in the pixels by then; sending it again would apply it twice.
    const edits = setEdit(setEdit([], 'blur', 8), 'sepia', 0.4);
    const hints = transmissibleEdits(edits);

    expect(hints.map((e) => e.kind)).toEqual(['sepia']);
  });

  it('drops neutral edits rather than shipping no-ops', () => {
    const edits = setEdit(setEdit([], 'brightness', 0), 'contrast', 0.6);
    expect(transmissibleEdits(edits).map((e) => e.kind)).toEqual(['contrast']);
  });

  it('leaves the edits key off entirely when there is nothing to send', () => {
    const out = packStaged({ items: [{ item: photo('i1'), file: file('m_1') }], seed: 1 });
    const items = out.content['app.envelope.items'] as Record<string, unknown>[];
    expect('app.envelope.edits' in items[0]!).toBe(false);
  });

  it('refuses to apply an incoming redactive hint even if a sender sends one', () => {
    // Belt and braces, and the asymmetry is the point: we cannot un-see pixels,
    // only decline to un-blur them.
    const out = packStaged({ items: [{ item: photo('i1'), file: file('m_1') }], seed: 2 });
    const items = out.content['app.envelope.items'] as Record<string, unknown>[];
    items[0]!['app.envelope.edits'] = [
      { kind: 'blur', value: 8 },
      { kind: 'sepia', value: 0.5 },
    ];

    const decoded = unpackStaged(wireOf(out.content));
    if (!decoded.ok) throw new Error('expected ok');
    expect(decoded.value.items[0]!.edits.map((e) => e.kind)).toEqual(['sepia']);
  });

  it('ignores an edit kind it does not recognise', () => {
    const out = packStaged({ items: [{ item: photo('i1'), file: file('m_1') }], seed: 3 });
    const items = out.content['app.envelope.items'] as Record<string, unknown>[];
    items[0]!['app.envelope.edits'] = [{ kind: 'deepfry', value: 9 }];

    const decoded = unpackStaged(wireOf(out.content));
    if (decoded.ok) expect(decoded.value.items[0]!.edits).toEqual([]);
  });
});

describe('a custom thumbnail is a second blob', () => {
  it('costs one blob for an item with no chosen thumbnail', () => {
    const plan = uploadPlan(draftOf([clip('v1')]));
    expect(plan.items[0]!.blobCount).toBe(1);
    expect(plan.blobCount).toBe(1);
  });

  it('costs two blobs when the author picked a frame', () => {
    const item = clip('v1', { thumbnail: { uri: 'file://frame.jpg', atMs: 4200, chosenByUser: true } });
    const plan = uploadPlan(draftOf([item]));

    expect(plan.items[0]!.blobCount).toBe(2);
  });

  it('does not charge for a thumbnail the chain produced rather than the author', () => {
    // A fallback frame is derivable on the receiving side; only a deliberate pick
    // has to travel.
    const item = clip('v1', { thumbnail: { uri: 'file://frame.jpg', atMs: 0, chosenByUser: false } });
    expect(uploadPlan(draftOf([item])).items[0]!.blobCount).toBe(1);
  });

  it('hits the revocation ceiling at five videos, not ten', () => {
    // This is the finding: the cap reads as "10 attachments" and is really
    // "10 blobs". Five videos with picked thumbnails is exactly ten.
    const items = Array.from({ length: 5 }, (_, i) =>
      clip(`v${i}`, { thumbnail: { uri: 'file://f.jpg', atMs: 1000, chosenByUser: true } }),
    );
    const plan = uploadPlan(draftOf(items));

    expect(plan.blobCount).toBe(MEDIA_IDS_PER_REVOCATION);
    expect(plan.fullyRevocable).toBe(true);

    const sixth = uploadPlan(
      draftOf([...items, clip('v5', { thumbnail: { uri: 'file://f.jpg', atMs: 1, chosenByUser: true } })]),
    );
    expect(sixth.blobCount).toBe(12);
    expect(sixth.fullyRevocable).toBe(false);
  });

  it('is computed before anything is uploaded', () => {
    // Both findings are pre-upload decisions: flattening cannot be retrofitted,
    // and discovering the cap after uploading twelve files means twelve orphans.
    const plan = uploadPlan(draftOf([photo('i1', { edits: setEdit([], 'blur', 8) })]));
    expect(plan.mustFlatten).toEqual(['i1']);
    expect(plan.blobCount).toBe(1);
  });
});

describe('packing', () => {
  const packable = (item: StagedItem, ids: [string, string?]): PackableStagedItem => ({
    item,
    file: file(ids[0]),
    ...(ids[1] === undefined ? {} : { thumbnail: file(ids[1]) }),
  });

  it('orders mediaIds so a truncated revoke drops thumbnails before originals', () => {
    const items = [
      packable(clip('v0', { thumbnail: { uri: 'x', atMs: 1, chosenByUser: true } }), ['m_v0', 'm_t0']),
      packable(clip('v1', { thumbnail: { uri: 'x', atMs: 1, chosenByUser: true } }), ['m_v1', 'm_t1']),
    ];
    const out = packStaged({ items, seed: 4 });

    expect(out.mediaIds).toEqual(['m_v0', 'm_t0', 'm_v1', 'm_t1']);
  });

  it('reports overflow past ten blobs', () => {
    const items = Array.from({ length: 6 }, (_, i) =>
      packable(clip(`v${i}`, { thumbnail: { uri: 'x', atMs: 1, chosenByUser: true } }), [`m_v${i}`, `m_t${i}`]),
    );
    const out = packStaged({ items, seed: 5 });

    expect(out.mediaIds).toHaveLength(12);
    expect(out.overflow).toEqual(['m_v5', 'm_t5']);
    expect(isFullyRevocable(out)).toBe(false);
    expect(revocationPlan(out).mediaIds).toHaveLength(10);
  });

  it('sends the thumbnail as a full encrypted file, not a URL', () => {
    // It needs its own key. A recipient who cannot decrypt the thumbnail must
    // still be able to play the video.
    const out = packStaged({
      items: [packable(clip('v0', { thumbnail: { uri: 'x', atMs: 4200, chosenByUser: true } }), ['m_v0', 'm_t0'])],
      seed: 6,
    });
    const info = (out.content['app.envelope.items'] as Record<string, unknown>[])[0]!['info'] as Record<string, unknown>;

    expect((info['thumbnail_file'] as EncryptedFileRef).mediaId).toBe('m_t0');
    expect((info['thumbnail_file'] as EncryptedFileRef).key.alg).toBe('A256CTR');
    expect(info['app.envelope.thumbnail_at_ms']).toBe(4200);
    expect(info['app.envelope.thumbnail_chosen']).toBe(true);
  });

  it('carries alt text, which has to outlive the pixels', () => {
    const out = packStaged({ items: [packable(photo('i1', { alt: '  a red door  ' }), ['m_1'])], seed: 7 });
    const items = out.content['app.envelope.items'] as Record<string, unknown>[];
    expect(items[0]!['app.envelope.alt']).toBe('a red door');
  });
});

describe('unpacking', () => {
  it('round-trips a video with a chosen thumbnail', () => {
    const out = packStaged({
      items: [
        {
          item: clip('v0', { alt: 'the gig', thumbnail: { uri: 'x', atMs: 4200, chosenByUser: true } }),
          file: file('m_v0'),
          thumbnail: file('m_t0'),
        },
      ],
      caption: 'last night',
      seed: 8,
    });
    const decoded = unpackStaged(wireOf(out.content));

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const item = decoded.value.items[0]!;
    expect(item.kind).toBe('video');
    expect(item.durationMs).toBe(14_000);
    expect(item.alt).toBe('the gig');
    expect(item.thumbnail).toEqual({ mediaId: 'm_t0', atMs: 4200, chosenByUser: true });
    expect(decoded.value.caption).toBe('last night');
    // Both blobs come back, in send order.
    expect(decoded.value.files.map((f) => f.mediaId)).toEqual(['m_v0', 'm_t0']);
  });

  it('refuses a revoked envelope before reading any item', () => {
    const out = packStaged({ items: [{ item: photo('i1'), file: file('m_1') }], seed: 9 });
    const decoded = unpackStaged(wireOf(out.content, { revoked: true }));

    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toBe('revoked');
  });

  it('skips an item with no file rather than discarding the envelope', () => {
    const out = packStaged({ items: [{ item: photo('i1'), file: file('m_1') }], seed: 10 });
    (out.content['app.envelope.items'] as unknown[]).push({ msgtype: 'm.image', info: {} });

    const decoded = unpackStaged(wireOf(out.content));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.items).toHaveLength(1);
  });

  it('rejects content that is not a multi envelope', () => {
    expect(unpackStaged(wireOf({ msgtype: 'm.text', body: 'hi' })).ok).toBe(false);
    expect(unpackStaged(wireOf({ msgtype: 'app.envelope.multi', 'app.envelope.items': [] })).ok).toBe(false);
  });
});
