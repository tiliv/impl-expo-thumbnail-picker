/**
 * The draft, and the staging tray over it.
 *
 * Attaching media does not commit to anything. Items sit in a draft, each
 * carrying its own description, edit list and chosen thumbnail, and stay
 * editable until the message is sent. Tapping one opens its sheet again — which
 * is the point of a staging view rather than a one-shot picker: nothing you did
 * at attach time is final.
 *
 * The reducer is pure and the state is serialisable, so a draft survives the
 * app being killed. That matters more than it sounds: someone who has written
 * four descriptions and lost them to a backgrounded app does not write them
 * again.
 */

import { bakeRequirement, hasEdits, type EditKind, type EditList, type SendEditsPolicy } from './edits';
import { setEdit } from './edits';
import { altIssues, blockingAltIssues, type AltIssue, type Describable } from './altText';
import type { StagingSettings } from './settings';
import type { VideoAsset } from './types';

export type StagedItemId = string;

export interface StagedSource {
  kind: 'image' | 'video';
  uri: string;
  filename?: string;
  width?: number;
  height?: number;
  /** Videos only. */
  durationMs?: number;
}

export interface ChosenThumbnail {
  uri: string;
  atMs: number;
  /** Distinguishes a deliberate pick from whatever the chain produced. */
  chosenByUser: boolean;
}

export interface StagedItem {
  id: StagedItemId;
  source: StagedSource;
  alt: string;
  edits: EditList;
  /** Videos only. null means "whatever the resolution chain decides". */
  thumbnail: ChosenThumbnail | null;
}

export interface Draft {
  items: StagedItem[];
  /** The item whose sheet is open, if any. */
  openItemId: StagedItemId | null;
}

export const emptyDraft = (): Draft => ({ items: [], openItemId: null });

export type DraftAction =
  | { type: 'attach'; items: StagedItem[] }
  | { type: 'remove'; id: StagedItemId }
  | { type: 'reorder'; id: StagedItemId; toIndex: number }
  | { type: 'open'; id: StagedItemId }
  | { type: 'close' }
  | { type: 'set_alt'; id: StagedItemId; alt: string }
  | { type: 'set_edit'; id: StagedItemId; kind: EditKind; value: number }
  | { type: 'set_edits'; id: StagedItemId; edits: EditList }
  | { type: 'clear_edits'; id: StagedItemId }
  | { type: 'set_thumbnail'; id: StagedItemId; thumbnail: ChosenThumbnail | null };

export function draftReducer(draft: Draft, action: DraftAction): Draft {
  const mapItem = (id: StagedItemId, fn: (item: StagedItem) => StagedItem): Draft => ({
    ...draft,
    items: draft.items.map((item) => (item.id === id ? fn(item) : item)),
  });

  switch (action.type) {
    case 'attach':
      return { ...draft, items: [...draft.items, ...action.items] };

    case 'remove': {
      const items = draft.items.filter((i) => i.id !== action.id);
      return { items, openItemId: draft.openItemId === action.id ? null : draft.openItemId };
    }

    case 'reorder': {
      const from = draft.items.findIndex((i) => i.id === action.id);
      if (from === -1) return draft;
      const items = [...draft.items];
      const [moved] = items.splice(from, 1);
      items.splice(Math.min(items.length, Math.max(0, action.toIndex)), 0, moved);
      return { ...draft, items };
    }

    case 'open':
      return { ...draft, openItemId: action.id };

    case 'close':
      return { ...draft, openItemId: null };

    case 'set_alt':
      return mapItem(action.id, (item) => ({ ...item, alt: action.alt }));

    case 'set_edit':
      return mapItem(action.id, (item) => ({ ...item, edits: setEdit(item.edits, action.kind, action.value) }));

    case 'set_edits':
      return mapItem(action.id, (item) => ({ ...item, edits: action.edits }));

    case 'clear_edits':
      return mapItem(action.id, (item) => ({ ...item, edits: [] }));

    case 'set_thumbnail':
      return mapItem(action.id, (item) => ({ ...item, thumbnail: action.thumbnail }));
  }
}

// --- readiness ------------------------------------------------------------

export type ReadinessCode =
  | 'alt_missing'
  | 'alt_invalid'
  | 'no_items'
  | 'thumbnail_auto'
  | 'will_bake'
  | 'edits_reversible';

export interface ReadinessIssue {
  code: ReadinessCode;
  level: 'error' | 'notice';
  itemId?: StagedItemId;
  message: string;
}

export const describableOf = (item: StagedItem): Describable => ({
  kind: item.source.kind,
  filename: item.source.filename,
  durationMs: item.source.durationMs,
});

/**
 * Everything standing between this draft and the send button.
 *
 * Same split as the reporting template: errors block, notices inform. A video
 * with no hand-picked thumbnail is not a problem — it is a fact worth stating,
 * because the automatic answer is frequently a black frame and the author is
 * one tap from fixing it.
 */
export function draftReadiness(
  draft: Draft,
  settings: StagingSettings,
  sendPolicy: SendEditsPolicy,
): { canSend: boolean; issues: ReadinessIssue[] } {
  const issues: ReadinessIssue[] = [];

  if (draft.items.length === 0) {
    return { canSend: false, issues: [{ code: 'no_items', level: 'error', message: 'Nothing attached.' }] };
  }

  for (const item of draft.items) {
    const alt = altIssues(item.alt, describableOf(item), {
      requirement: settings.requireAltText.value,
      maxChars: settings.altTextMaxChars.value,
    });

    for (const issue of blockingAltIssues(alt)) {
      issues.push({
        code: issue.code === 'missing' ? 'alt_missing' : 'alt_invalid',
        level: 'error',
        itemId: item.id,
        message: issue.message,
      });
    }

    if (item.source.kind === 'video' && item.thumbnail === null) {
      issues.push({
        code: 'thumbnail_auto',
        level: 'notice',
        itemId: item.id,
        message: 'No thumbnail chosen — one will be picked automatically.',
      });
    }

    if (hasEdits(item.edits)) {
      const bake = bakeRequirement(item.edits, sendPolicy);
      if (bake.required) {
        issues.push({
          code: 'will_bake',
          level: 'notice',
          itemId: item.id,
          message: bake.reason,
        });
      } else if (sendPolicy === 'with_original') {
        issues.push({
          code: 'edits_reversible',
          level: 'notice',
          itemId: item.id,
          message: 'Edits are sent as a list, so the recipient can see the unedited original.',
        });
      }
    }
  }

  return { canSend: !issues.some((i) => i.level === 'error'), issues };
}

export const issuesFor = (issues: ReadinessIssue[], id: StagedItemId): ReadinessIssue[] =>
  issues.filter((i) => i.itemId === id);

// --- interop with the resolution chain -----------------------------------

/** A staged video, in the shape the thumbnail chain expects. */
export function assetOf(item: StagedItem): VideoAsset {
  return {
    id: item.id,
    uri: item.source.uri,
    durationMs: item.source.durationMs ?? 0,
    width: item.source.width,
    height: item.source.height,
    filename: item.source.filename,
  };
}

let stagedSeq = 0;

export function stage(source: StagedSource, over: Partial<StagedItem> = {}): StagedItem {
  stagedSeq += 1;
  return { id: `staged-${stagedSeq}`, source, alt: '', edits: [], thumbnail: null, ...over };
}
