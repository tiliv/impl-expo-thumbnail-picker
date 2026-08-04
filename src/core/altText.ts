/**
 * Describing an item for someone who will not see it.
 *
 * Framing matters here and it is a UI decision as much as a data one. A field
 * labelled "alt text" gets filenames pasted into it. A field that shows you
 * what a screen reader will actually say gets sentences, because the author can
 * see that "IMG_4471.HEIC" is not an answer to anything.
 *
 * So `announcement()` is the centre of this file, not the validation: the sheet
 * renders it verbatim, and the writing improves on its own.
 *
 * The checks below are lint, not gatekeeping. They catch the four things people
 * reliably do wrong and are worded as suggestions, because a mediocre
 * description is worth more than a blocked send and an annoyed author.
 */

export type DescribableKind = 'image' | 'video';

export interface Describable {
  kind: DescribableKind;
  filename?: string;
  durationMs?: number;
}

export type AltIssueCode =
  | 'missing'
  | 'too_short'
  | 'filename'
  | 'redundant_prefix'
  | 'too_long';

export interface AltIssue {
  code: AltIssueCode;
  level: 'error' | 'suggestion';
  message: string;
}

const formatDuration = (ms: number): string => {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s} second${s === 1 ? '' : 's'}`;
  return `${m} minute${m === 1 ? '' : 's'} ${s} second${s === 1 ? '' : 's'}`;
};

/**
 * What a screen reader will say.
 *
 * The type and duration come from the platform, so a description that opens
 * with "Image of…" makes the announcement read "Image. Image of a…". That is
 * the single most common alt-text mistake and showing the doubled words is a
 * better teacher than a warning is.
 */
export function announcement(item: Describable, alt: string): string {
  const trimmed = alt.trim();
  const prefix =
    item.kind === 'video'
      ? `Video, ${item.durationMs ? formatDuration(item.durationMs) : 'unknown length'}.`
      : 'Image.';

  if (trimmed.length === 0) {
    return `${prefix} No description. ${item.filename ?? 'Unlabelled attachment'}`;
  }
  return `${prefix} ${trimmed}`;
}

const REDUNDANT_PREFIXES = [
  'image of',
  'an image of',
  'a image of',
  'picture of',
  'a picture of',
  'photo of',
  'a photo of',
  'photograph of',
  'video of',
  'a video of',
  'screenshot of',
];

export interface AltTextPolicy {
  /** `required` blocks sending; `warn` surfaces it; `off` says nothing. */
  requirement: 'off' | 'warn' | 'required';
  maxChars: number;
}

export function altIssues(alt: string, item: Describable, policy: AltTextPolicy): AltIssue[] {
  const trimmed = alt.trim();
  const issues: AltIssue[] = [];

  if (trimmed.length === 0) {
    if (policy.requirement === 'required') {
      issues.push({
        code: 'missing',
        level: 'error',
        message: 'This room asks for a description on every attachment.',
      });
    } else if (policy.requirement === 'warn') {
      issues.push({
        code: 'missing',
        level: 'suggestion',
        message: 'Nobody using a screen reader will know what this is.',
      });
    }
    return issues;
  }

  if (trimmed.length > policy.maxChars) {
    issues.push({
      code: 'too_long',
      level: 'error',
      message: `Descriptions are capped at ${policy.maxChars} characters here.`,
    });
  }

  if (trimmed.length < 8) {
    issues.push({
      code: 'too_short',
      level: 'suggestion',
      message: 'A few more words will do more work than this one.',
    });
  }

  // Filenames are the classic non-description: technically populated, useless
  // read aloud.
  if (item.filename && trimmed.toLowerCase() === item.filename.toLowerCase().replace(/\.[^.]+$/, '')) {
    issues.push({
      code: 'filename',
      level: 'suggestion',
      message: 'That is the filename. Say what is in it instead.',
    });
  }

  const lower = trimmed.toLowerCase();
  const prefix = REDUNDANT_PREFIXES.find((p) => lower.startsWith(`${p} `));
  if (prefix) {
    issues.push({
      code: 'redundant_prefix',
      level: 'suggestion',
      message: `Screen readers already say "${item.kind}". Starting with "${prefix}" says it twice.`,
    });
  }

  return issues;
}

export const blockingAltIssues = (issues: AltIssue[]): AltIssue[] =>
  issues.filter((i) => i.level === 'error');

/** Drops the redundant opener, for a one-tap fix in the sheet. */
export function stripRedundantPrefix(alt: string): string {
  const trimmed = alt.trim();
  const lower = trimmed.toLowerCase();
  const prefix = REDUNDANT_PREFIXES.find((p) => lower.startsWith(`${p} `));
  if (!prefix) return trimmed;
  const remainder = trimmed.slice(prefix.length + 1);
  return remainder.charAt(0).toUpperCase() + remainder.slice(1);
}
