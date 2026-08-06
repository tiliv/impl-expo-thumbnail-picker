/**
 * The photo-library permission, as a hook.
 *
 * Two places in this repo pick media — the composer's attach button and the
 * panel's "add a real video" — and before this they each ran their own
 * `requestMediaLibraryPermissionsAsync()` and each raised an `Alert` on
 * refusal. Two problems with that, and the second is the one that matters:
 *
 * 1. **Two copies drift.** One of them will grow a fix the other does not.
 * 2. **An alert is transient.** It says "Library access needed", the person
 *    taps OK, and now there is nothing on screen at all — no explanation, no
 *    way back, and the attach button still looks like it should work. That is
 *    the tiny-hidden-button problem in its purest form: the affordance is not
 *    small, it is *gone*.
 *
 * So the state lives here, the affordance is derived from it, and
 * `PermissionArea` draws the one shape allowed to carry it.
 *
 * ## Why the probe is not the hook from expo-image-picker
 *
 * `useMediaLibraryPermissions()` exists and would be shorter. It is not used
 * because its response has to be translated anyway — `accessPrivileges` is the
 * only signal for iOS limited access and it is `'limited'` while `granted` is
 * **true** — and because the foreground re-probe wants an explicit call rather
 * than a hook's own lifecycle. Keeping both in one place makes the sequence
 * legible.
 */

import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

import {
  affordanceFor,
  fromExpoResponse,
  isUsable,
  canPrompt,
  type ActionEffect,
  type Affordance,
  type PermissionState,
} from '../core/permission';

export interface LibraryPermission {
  state: PermissionState;
  /** True when picking is worth attempting. `limited` counts — see the model. */
  usable: boolean;
  affordance: Affordance;
  act: (effect: ActionEffect) => Promise<void>;
  /** Probe without prompting. Safe anywhere. */
  refresh: () => Promise<PermissionState>;
}

export function useLibraryPermission(guards: string): LibraryPermission {
  // Starts `granted` rather than `undetermined`, deliberately. Before the first
  // probe answers we do not know, and "we have not looked yet" drawn as "never
  // asked" is a grant prompt flashing on launch — the same class of bug as a
  // cold-start auth bounce.
  const [state, setState] = useState<PermissionState>({ status: 'granted' });

  const refresh = useCallback(async (): Promise<PermissionState> => {
    const next = fromExpoResponse(await ImagePicker.getMediaLibraryPermissionsAsync());
    setState(next);
    return next;
  }, []);

  useEffect(() => {
    void refresh();
    // Unconditional on every foreground. Not just after a denial: a revocation
    // matters as much as a grant, and a stale `granted` is the worse of the two
    // — the picker opens empty and the failure looks like a bug in the picker.
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  const act = useCallback(
    async (effect: ActionEffect): Promise<void> => {
      if (effect === 'open_settings') {
        await Linking.openSettings();
        // Nothing optimistic. What happened there is unknown until the
        // foreground listener above re-probes.
        return;
      }
      if (effect === 'request') {
        // Guarded, so a spent prompt is never fired. Past that point the call
        // resolves with the same denial and shows nothing.
        const current = await refresh();
        if (!canPrompt(current)) return;
        setState(fromExpoResponse(await ImagePicker.requestMediaLibraryPermissionsAsync()));
        return;
      }
      if (effect === 'expand_selection') {
        // ⚠️ Not implementable with this repo's dependencies, and that is the
        // finding. `expo-image-picker` *reports* limited access but exposes no
        // way to widen it — `presentLimitedLibraryPickerAsync` lives in
        // `expo-media-library`, a separate native module.
        //
        // Re-probing and returning the truth leaves the notice up, which is
        // honest. Faking a grant would be worse than a button that is plainly
        // unavailable.
        //
        // VERIFY on device: whether `launchImageLibraryAsync` under limited
        // access surfaces iOS's own "Select More Photos" row. If it does, the
        // notice can point at the picker and the dependency is avoidable.
        await refresh();
      }
    },
    [refresh],
  );

  return {
    state,
    usable: isUsable(state),
    affordance: affordanceFor('photo_library', state, guards),
    act,
    refresh,
  };
}
