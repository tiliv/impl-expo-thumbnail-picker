/**
 * Non-destructive edits.
 *
 * The original URI is never touched. An item carries an ordered list of edits,
 * every one of which is individually removable, and the rendered result is the
 * original plus the list. That is what lets someone fiddle with an image while
 * still drafting and back out of any of it.
 *
 * The part worth reading is `bakeRequirement`.
 *
 * A non-destructive edit list is, by construction, *reversible*. That is the
 * whole point while drafting and a serious problem at send time: if someone
 * blurs out a house number and we transmit original + "blur 8px", the recipient
 * has the house number. The privacy affordance the user thinks they applied is
 * decoration.
 *
 * So edits are classified. Cosmetic ones (warmth, contrast) can travel as a
 * list — it is smaller, and it lets a recipient render at their own resolution.
 * Redactive ones must be baked into pixels before the thing leaves the device,
 * and the original must not go with it. This is not a preference.
 */

export type EditKind =
  | 'brightness'
  | 'contrast'
  | 'saturate'
  | 'warmth'
  | 'grayscale'
  | 'sepia'
  | 'invert'
  | 'blur';

export interface Edit {
  kind: EditKind;
  /** Normalised. See `EDIT_SPECS` for what the range means per kind. */
  value: number;
}

export type EditList = Edit[];

export interface EditSpec {
  kind: EditKind;
  label: string;
  min: number;
  max: number;
  /** The value at which this edit does nothing. */
  neutral: number;
  step: number;
  /**
   * True when this edit can hide information. Above `redactiveAbove` it is
   * being used to obscure something, and the result must be baked before send.
   */
  redactiveAbove?: number;
}

export const EDIT_SPECS: Record<EditKind, EditSpec> = {
  brightness: { kind: 'brightness', label: 'Brightness', min: -1, max: 1, neutral: 0, step: 0.05 },
  contrast: { kind: 'contrast', label: 'Contrast', min: -1, max: 1, neutral: 0, step: 0.05 },
  saturate: { kind: 'saturate', label: 'Saturation', min: -1, max: 1, neutral: 0, step: 0.05 },
  warmth: { kind: 'warmth', label: 'Warmth', min: -1, max: 1, neutral: 0, step: 0.05 },
  grayscale: { kind: 'grayscale', label: 'Black & white', min: 0, max: 1, neutral: 0, step: 0.05 },
  sepia: { kind: 'sepia', label: 'Sepia', min: 0, max: 1, neutral: 0, step: 0.05 },
  // Inversion is not redaction, but it is destructive enough to legibility
  // that shipping it unbaked would surprise people. Kept cosmetic; revisit.
  invert: { kind: 'invert', label: 'Invert', min: 0, max: 1, neutral: 0, step: 0.05 },
  // The one that actually hides things. A light blur is a look; a heavy blur
  // is a redaction, and the threshold is where we stop treating it as a look.
  blur: { kind: 'blur', label: 'Blur', min: 0, max: 20, neutral: 0, step: 0.5, redactiveAbove: 3 },
};

export const isNeutral = (edit: Edit): boolean =>
  Math.abs(edit.value - EDIT_SPECS[edit.kind].neutral) < 1e-6;

export const isRedactive = (edit: Edit): boolean => {
  const threshold = EDIT_SPECS[edit.kind].redactiveAbove;
  return threshold !== undefined && edit.value > threshold;
};

// --- list operations, all pure and non-destructive -----------------------

/** Sets a kind's value, adding or removing it from the list as needed. */
export function setEdit(edits: EditList, kind: EditKind, value: number): EditList {
  const spec = EDIT_SPECS[kind];
  const clamped = Math.min(spec.max, Math.max(spec.min, value));
  const without = edits.filter((e) => e.kind !== kind);
  if (Math.abs(clamped - spec.neutral) < 1e-6) return without;

  // Preserve position when adjusting an existing edit, so a slider drag does
  // not reorder the stack under the user.
  const index = edits.findIndex((e) => e.kind === kind);
  const next: Edit = { kind, value: clamped };
  if (index === -1) return [...edits, next];
  const copy = [...edits];
  copy[index] = next;
  return copy;
}

export const removeEdit = (edits: EditList, kind: EditKind): EditList =>
  edits.filter((e) => e.kind !== kind);

export const valueOf = (edits: EditList, kind: EditKind): number =>
  edits.find((e) => e.kind === kind)?.value ?? EDIT_SPECS[kind].neutral;

export const hasEdits = (edits: EditList): boolean => edits.some((e) => !isNeutral(e));

// --- presets --------------------------------------------------------------

export interface Preset {
  id: string;
  label: string;
  edits: EditList;
}

export const PRESETS: Preset[] = [
  { id: 'none', label: 'Original', edits: [] },
  { id: 'punch', label: 'Punch', edits: [{ kind: 'contrast', value: 0.28 }, { kind: 'saturate', value: 0.3 }] },
  { id: 'faded', label: 'Faded', edits: [{ kind: 'contrast', value: -0.22 }, { kind: 'brightness', value: 0.12 }, { kind: 'saturate', value: -0.25 }] },
  { id: 'warm', label: 'Warm', edits: [{ kind: 'warmth', value: 0.45 }, { kind: 'saturate', value: 0.12 }] },
  { id: 'cool', label: 'Cool', edits: [{ kind: 'warmth', value: -0.4 }] },
  { id: 'mono', label: 'Mono', edits: [{ kind: 'grayscale', value: 1 }, { kind: 'contrast', value: 0.15 }] },
];

/** Which preset a list matches exactly, if any. Lets the rail show selection. */
export function matchPreset(edits: EditList): Preset | undefined {
  const active = edits.filter((e) => !isNeutral(e));
  return PRESETS.find((preset) => {
    if (preset.edits.length !== active.length) return false;
    return preset.edits.every((pe) => Math.abs(valueOf(active, pe.kind) - pe.value) < 1e-6);
  });
}

// --- rendering ------------------------------------------------------------

/**
 * A renderer-neutral description of the filter stack.
 *
 * Core does not import React Native, so this returns plain data and the UI maps
 * it onto whatever it draws with. It happens to line up with RN 0.76+'s
 * `filter` style prop and with CSS, which is not a coincidence — both take the
 * same well-trodden function list.
 */
export interface FilterOp {
  fn: 'brightness' | 'contrast' | 'saturate' | 'grayscale' | 'sepia' | 'invert' | 'blur' | 'hueRotate';
  /** Multiplier for the ratio filters, px for blur, degrees for hueRotate. */
  amount: number;
}

/**
 * Warmth has no filter primitive, so it is approximated as a hue rotation plus
 * a saturation nudge. It is the one edit whose preview is a stand-in rather
 * than the real transform — a proper implementation is a colour matrix, which
 * needs the GPU pass that baking needs anyway.
 */
export function toFilterOps(edits: EditList): FilterOp[] {
  const ops: FilterOp[] = [];
  for (const edit of edits) {
    if (isNeutral(edit)) continue;
    switch (edit.kind) {
      case 'brightness':
        ops.push({ fn: 'brightness', amount: 1 + edit.value });
        break;
      case 'contrast':
        ops.push({ fn: 'contrast', amount: 1 + edit.value });
        break;
      case 'saturate':
        ops.push({ fn: 'saturate', amount: 1 + edit.value });
        break;
      case 'warmth':
        ops.push({ fn: 'hueRotate', amount: edit.value * -12 });
        ops.push({ fn: 'saturate', amount: 1 + Math.abs(edit.value) * 0.15 });
        break;
      case 'grayscale':
        ops.push({ fn: 'grayscale', amount: edit.value });
        break;
      case 'sepia':
        ops.push({ fn: 'sepia', amount: edit.value });
        break;
      case 'invert':
        ops.push({ fn: 'invert', amount: edit.value });
        break;
      case 'blur':
        ops.push({ fn: 'blur', amount: edit.value });
        break;
    }
  }
  return ops;
}

// --- the send-time decision ----------------------------------------------

export type SendEditsPolicy =
  /** Flatten to pixels before sending. Safe, larger, loses the original. */
  | 'baked'
  /** Send original plus the list. Smaller and re-renderable, and reversible. */
  | 'with_original';

export interface BakeRequirement {
  required: boolean;
  /** Set when the room's policy would have leaked something. */
  overridesPolicy: boolean;
  reason: string;
  redactive: Edit[];
}

export function bakeRequirement(edits: EditList, policy: SendEditsPolicy): BakeRequirement {
  const redactive = edits.filter(isRedactive);

  if (redactive.length > 0) {
    return {
      required: true,
      overridesPolicy: policy === 'with_original',
      reason:
        policy === 'with_original'
          ? 'This image has been blurred to hide something. Sending the original alongside ' +
            'the edit list would let anyone undo it, so it will be flattened before sending.'
          : 'Blur is applied to hide something, so the image is flattened before sending.',
      redactive,
    };
  }

  if (policy === 'baked') {
    return {
      required: hasEdits(edits),
      overridesPolicy: false,
      reason: 'This room sends flattened images.',
      redactive: [],
    };
  }

  return {
    required: false,
    overridesPolicy: false,
    reason: 'Cosmetic edits travel as a list, so the recipient renders at their own resolution.',
    redactive: [],
  };
}
