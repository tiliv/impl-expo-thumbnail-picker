/**
 * Permission states, and the affordance each one earns.
 *
 * ## Why this is not a boolean
 *
 * This file replaces `requestPermission(): Promise<boolean>`. A boolean collapses
 * four situations that need four different things on screen, and one of the
 * collapses produces the specific confusion this file exists to prevent:
 *
 * | Situation | What a boolean says | What it needs |
 * |---|---|---|
 * | Never asked | `false` | a button that asks |
 * | Refused, can ask again (Android) | `false` | a button that asks again |
 * | Refused, cannot ask again | `false` | a button that opens **Settings** |
 * | Partial access (iOS 14+, Android 14+) | `false` **or** `true`, pick your poison | a button that widens the selection |
 *
 * **Row three is the one that bites.** On iOS the system prompt is shown once,
 * ever. On Android a second refusal sets "don't ask again". After that, calling
 * `request()` resolves immediately with the same denial and *no sheet appears*.
 * A button labelled "Allow microphone access" that does nothing when tapped is
 * worse than no button, because the person concludes the app is broken rather
 * than that the setting is theirs to change. `affordanceFor` will not emit a
 * `request` action in that state — it emits `open_settings`, with a label that
 * says so.
 *
 * ## The shape rule
 *
 * > A big area with a single button in it is clear. A tiny button hiding on the
 * > screen is not clear.
 *
 * Encoded rather than described. An `Affordance` is `none`, `block` or
 * `notice`, and **there is no shape in this file that renders as a small
 * control**:
 *
 * - `block` — the region cannot work. It fills the region it guards.
 * - `notice` — the region works, partially. Full width, above the region.
 * - `none` — nothing to fix. Draw no permission UI at all.
 *
 * Each carries **at most one** action. Making the confusing option
 * unrepresentable is cheaper than remembering not to build it.
 *
 * ## Fail softly
 *
 * An affordance guards a *region*, never a screen. Losing the microphone must
 * not stop somebody typing. That is a property of where the caller mounts this,
 * so `core/` cannot enforce it — but `guards` names the region, which at least
 * makes a screen-wide gate obvious in review.
 */

/** What is being asked for. Extend per sandbox; the model does not care. */
export type PermissionKind = 'microphone' | 'photo_library' | 'camera';

export type PermissionState =
  /** Never asked. The only state in which a first prompt is possible. */
  | { status: 'undetermined' }
  /** Full access. */
  | { status: 'granted' }
  /**
   * Partial access — iOS 14+ limited photo library, Android 14+
   * `READ_MEDIA_VISUAL_USER_SELECTED`.
   *
   * **Not a failure, and the most commonly mishandled state in the set.**
   * Treating it as denied nags somebody who has already made a deliberate
   * choice; treating it as granted means the picker looks broken when their
   * photo is not in it. It gets its own affordance and its own words.
   */
  | { status: 'limited'; selectedCount?: number }
  /**
   * Refused. `canAskAgain` is the whole difference between a button that works
   * and a button that lies.
   */
  | { status: 'denied'; canAskAgain: boolean }
  /**
   * Blocked by something the person does not control — parental controls, MDM,
   * a managed device. Asking is pointless and Settings will not offer the
   * toggle either, so this state gets an explanation and no action.
   */
  | { status: 'restricted' }
  /** No hardware, or a simulator. Carries the platform's own words. */
  | { status: 'unavailable'; reason: string };

export type PermissionStatus = PermissionState['status'];

export type ActionEffect =
  /** Show the system prompt. Only ever emitted when a prompt can actually appear. */
  | 'request'
  /** Deep-link to the app's settings page. The only route once asking is spent. */
  | 'open_settings'
  /** iOS `presentLimitedLibraryPickerAsync`, or the Android equivalent. */
  | 'expand_selection';

export interface Action {
  label: string;
  effect: ActionEffect;
}

export interface Affordance {
  kind: 'none' | 'block' | 'notice';
  /** Which region this guards. Never a whole screen — see the header. */
  guards: string;
  headline: string;
  /** Why the region is in this state, in the person's terms rather than the API's. */
  body: string;
  /** At most one. `null` when there is genuinely nothing to tap. */
  action: Action | null;
}

const NOTHING: Affordance = {
  kind: 'none',
  guards: '',
  headline: '',
  body: '',
  action: null,
};

/** Human words for each kind, used in both headline and body. */
interface Vocabulary {
  /** "the microphone", "your photos" — reads after "access to". */
  noun: string;
  /** What the region is for: "record a voice memo". */
  purpose: string;
  /** Where the toggle lives, named so the sentence can point at it. */
  settingsPath: string;
}

export const VOCABULARY: Record<PermissionKind, Vocabulary> = {
  microphone: {
    noun: 'the microphone',
    purpose: 'record a voice memo',
    settingsPath: 'Settings',
  },
  photo_library: {
    noun: 'your photos',
    purpose: 'attach a photo or video',
    settingsPath: 'Settings',
  },
  camera: {
    noun: 'the camera',
    purpose: 'take a photo',
    settingsPath: 'Settings',
  },
};

/**
 * The one function. State plus what it guards, in; what to draw, out.
 *
 * Pure, total, and every branch returns something a person can act on or a
 * reason they cannot. There is deliberately no `else` that produces a bare
 * "permission denied".
 */
export function affordanceFor(
  kind: PermissionKind,
  state: PermissionState,
  guards: string,
): Affordance {
  const { noun, purpose, settingsPath } = VOCABULARY[kind];

  switch (state.status) {
    case 'granted':
      // Nothing to fix, so nothing to draw. Worth stating as a branch rather
      // than leaving to the caller: a permission banner that persists after the
      // permission is held is the other half of this problem.
      return NOTHING;

    case 'undetermined':
      return {
        kind: 'block',
        guards,
        headline: `Allow access to ${noun}`,
        body: `We ask only when you ${purpose}, and only for that.`,
        action: { label: 'Continue', effect: 'request' },
      };

    case 'denied':
      return state.canAskAgain
        ? {
            kind: 'block',
            guards,
            headline: `Allow access to ${noun}`,
            body: `You can change this later in ${settingsPath}.`,
            action: { label: 'Try again', effect: 'request' },
          }
        : {
            kind: 'block',
            guards,
            headline: `${capitalise(noun)} is turned off`,
            // Says where it is going, because a button that leaves the app
            // without warning is its own small betrayal.
            body: `This is now changed in ${settingsPath} rather than here.`,
            action: { label: `Open ${settingsPath}`, effect: 'open_settings' },
          };

    case 'limited':
      // The region *works*. A block here would be a lie about the state of the
      // feature, and nagging somebody about a choice they made deliberately.
      return {
        kind: 'notice',
        guards,
        headline:
          state.selectedCount === undefined
            ? 'Some photos are shared'
            : `${state.selectedCount} ${state.selectedCount === 1 ? 'photo is' : 'photos are'} shared`,
        body: 'Anything not shared will not appear here.',
        action: { label: 'Choose photos', effect: 'expand_selection' },
      };

    case 'restricted':
      return {
        kind: 'block',
        guards,
        headline: `Access to ${noun} is not available`,
        // No action, and the body has to carry the reason — otherwise this is
        // the dead end the whole file is trying to avoid.
        body: 'A device restriction is blocking this, so it cannot be turned on from Settings either.',
        action: null,
      };

    case 'unavailable':
      return {
        kind: 'block',
        guards,
        headline: `${capitalise(noun)} is not available on this device`,
        body: state.reason,
        action: null,
      };
  }
}

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Whether the region can do its job right now.
 *
 * `limited` is usable — that is the point of it being a separate state.
 */
export const isUsable = (state: PermissionState): boolean =>
  state.status === 'granted' || state.status === 'limited';

/**
 * Whether calling `request()` can produce a system prompt.
 *
 * Guarding on this rather than on `!isUsable` is what stops the app firing a
 * request that resolves instantly with the same answer and shows nothing.
 */
export const canPrompt = (state: PermissionState): boolean =>
  state.status === 'undetermined' || (state.status === 'denied' && state.canAskAgain);

/**
 * Expo's permission response, translated. The same translation everywhere, so
 * it lives here rather than being re-derived per adapter.
 *
 * Two fields carry all of it, and both are easy to get wrong:
 *
 * - **`canAskAgain`** means opposite things per platform despite being the same
 *   field. iOS reports `false` straight after the *first* refusal, because the
 *   sheet is shown once per install. Android reports `true` until the person
 *   picks "don't ask again". So the same `denied` wants a different button on
 *   each platform, and this flag is the only thing that says which.
 * - **`accessPrivileges`** is iOS-only and is the sole signal for limited photo
 *   access. Crucially it is `'limited'` while `granted` is **true**, so an
 *   implementation reading `granted` alone reports full access and then shows a
 *   picker containing four photos.
 *
 * `expires` is ignored on purpose: Android's `'never'` versus a timestamp is
 * about the grant's lifetime, not about what to draw now, and the foreground
 * re-probe covers expiry without anybody reasoning about it.
 */
export function fromExpoResponse(response: {
  granted: boolean;
  canAskAgain: boolean;
  status: string;
  accessPrivileges?: string;
}): PermissionState {
  if (response.accessPrivileges === 'limited') return { status: 'limited' };
  if (response.granted) return { status: 'granted' };
  // `undetermined` and a refusal are both "not granted" and are not the same
  // thing — the first has never shown a prompt, so its button says something
  // different. Expo distinguishes them only in `status`.
  if (response.status === 'undetermined') return { status: 'undetermined' };
  // Parental controls or an MDM profile. Settings will not offer the toggle
  // either, so sending somebody there is another dead end.
  if (response.status === 'restricted') return { status: 'restricted' };
  return { status: 'denied', canAskAgain: response.canAskAgain };
}

/**
 * Re-probe on every foreground, unconditionally.
 *
 * The tempting optimisation is to re-probe only when we last saw a denial,
 * since that is the case where somebody went to Settings. It is wrong in the
 * other direction: permissions are revocable while backgrounded, and a stale
 * `granted` is worse than a stale `denied` — the person taps record, the OS
 * refuses underneath, and the failure surfaces as a recorder error rather than
 * as the permission change it actually was.
 *
 * A function rather than a comment so the reasoning has somewhere to live and
 * a test has something to pin.
 */
export const shouldRecheckOnForeground = (_previous: PermissionState): boolean => true;
