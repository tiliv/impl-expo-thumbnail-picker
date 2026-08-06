/**
 * The permission model.
 *
 * The assertions worth reading are the ones about *shape*: that no state can
 * produce a small hidden control, and that no state can produce a button which
 * does nothing when tapped. Those are the two failures the file exists to make
 * unrepresentable, so they are tested over every state rather than by example.
 */

import {
  affordanceFor,
  canPrompt,
  isUsable,
  shouldRecheckOnForeground,
  VOCABULARY,
  type PermissionKind,
  type PermissionState,
} from '../permission';

const KINDS: PermissionKind[] = ['microphone', 'photo_library', 'camera'];

const ALL_STATES: PermissionState[] = [
  { status: 'undetermined' },
  { status: 'granted' },
  { status: 'limited' },
  { status: 'limited', selectedCount: 1 },
  { status: 'limited', selectedCount: 12 },
  { status: 'denied', canAskAgain: true },
  { status: 'denied', canAskAgain: false },
  { status: 'restricted' },
  { status: 'unavailable', reason: 'no microphone on this device' },
];

const every = (fn: (kind: PermissionKind, state: PermissionState) => void): void => {
  for (const kind of KINDS) for (const state of ALL_STATES) fn(kind, state);
};

describe('the shape rule', () => {
  it('never produces a control smaller than the region it guards', () => {
    // "A big area with a single button in it is clear. A tiny button hiding on
    // the screen is not clear." There is no `inline` kind, so the confusing
    // option cannot be built — this asserts the enum has not grown one.
    every((kind, state) => {
      expect(['none', 'block', 'notice']).toContain(affordanceFor(kind, state, 'recorder').kind);
    });
  });

  it('offers at most one action, always', () => {
    every((kind, state) => {
      const { action } = affordanceFor(kind, state, 'recorder');
      // The type says `Action | null`; this pins that nobody widens it to a
      // list, which is how a clear area becomes a row of competing buttons.
      expect(action === null || typeof action.label === 'string').toBe(true);
    });
  });

  it('gives every actionable affordance a label somebody could read aloud', () => {
    every((kind, state) => {
      const { action } = affordanceFor(kind, state, 'recorder');
      if (action !== null) {
        expect(action.label.length).toBeGreaterThan(2);
        expect(action.label).not.toMatch(/permission|denied|granted|undetermined/i);
      }
    });
  });
});

describe('the button never lies', () => {
  it('only emits `request` where a system prompt can actually appear', () => {
    // The headline failure this file prevents. On iOS the sheet is shown once
    // ever; on Android a second refusal sets "don't ask again". After that a
    // request resolves instantly with the same denial and nothing is drawn.
    every((kind, state) => {
      const { action } = affordanceFor(kind, state, 'recorder');
      if (action?.effect === 'request') expect(canPrompt(state)).toBe(true);
    });
  });

  it('routes a spent denial to Settings instead', () => {
    const { action, kind } = affordanceFor('microphone', { status: 'denied', canAskAgain: false }, 'recorder');
    expect(action).toEqual({ label: 'Open Settings', effect: 'open_settings' });
    expect(kind).toBe('block');
  });

  it('asks again where asking again works', () => {
    const { action } = affordanceFor('microphone', { status: 'denied', canAskAgain: true }, 'recorder');
    expect(action?.effect).toBe('request');
  });

  it('says where the button is about to take you', () => {
    // A button that leaves the app without warning is its own small betrayal.
    const { body } = affordanceFor('camera', { status: 'denied', canAskAgain: false }, 'scanner');
    expect(body).toContain(VOCABULARY.camera.settingsPath);
  });

  it('explains itself when there is nothing to tap', () => {
    // A big empty area with no button and no reason is the dead end the whole
    // file is trying to avoid, so an actionless affordance must say why.
    every((kind, state) => {
      const affordance = affordanceFor(kind, state, 'recorder');
      if (affordance.kind !== 'none' && affordance.action === null) {
        expect(affordance.body.length).toBeGreaterThan(20);
      }
    });
  });
});

describe('granted draws nothing', () => {
  it('produces no affordance at all', () => {
    for (const kind of KINDS) {
      expect(affordanceFor(kind, { status: 'granted' }, 'recorder').kind).toBe('none');
    }
  });

  it('is the only state that draws nothing', () => {
    // A banner that persists after the permission is held is the other half of
    // this problem, and it is the half that survives review because it only
    // looks wrong to somebody who granted access.
    every((kind, state) => {
      const drawn = affordanceFor(kind, state, 'recorder').kind !== 'none';
      expect(drawn).toBe(state.status !== 'granted');
    });
  });
});

describe('limited is not denied', () => {
  it('is usable, and says so by being a notice rather than a block', () => {
    const affordance = affordanceFor('photo_library', { status: 'limited' }, 'picker');
    expect(affordance.kind).toBe('notice');
    expect(isUsable({ status: 'limited' })).toBe(true);
  });

  it('offers to widen the selection rather than to grant anything', () => {
    // Nagging somebody about a choice they made deliberately is how an app
    // teaches people to ignore its banners.
    const { action } = affordanceFor('photo_library', { status: 'limited', selectedCount: 3 }, 'picker');
    expect(action?.effect).toBe('expand_selection');
  });

  it('counts in words that survive the singular', () => {
    expect(affordanceFor('photo_library', { status: 'limited', selectedCount: 1 }, 'p').headline).toContain(
      '1 photo is',
    );
    expect(affordanceFor('photo_library', { status: 'limited', selectedCount: 4 }, 'p').headline).toContain(
      '4 photos are',
    );
  });

  it('still says something useful when the count is unknown', () => {
    // Some platforms report limited access without a count. Rendering
    // "undefined photos are shared" is the kind of thing that ships.
    const { headline } = affordanceFor('photo_library', { status: 'limited' }, 'p');
    expect(headline).not.toContain('undefined');
    expect(headline).not.toContain('NaN');
  });

  it('warns that the picker will look incomplete, because that is the real confusion', () => {
    const { body } = affordanceFor('photo_library', { status: 'limited' }, 'picker');
    expect(body).toMatch(/not shared will not appear/i);
  });
});

describe('usability', () => {
  it('counts granted and limited as usable and nothing else', () => {
    for (const state of ALL_STATES) {
      expect(isUsable(state)).toBe(state.status === 'granted' || state.status === 'limited');
    }
  });

  it('restricted is not askable, because Settings will not offer it either', () => {
    expect(canPrompt({ status: 'restricted' })).toBe(false);
    expect(affordanceFor('camera', { status: 'restricted' }, 'scanner').action).toBeNull();
  });

  it('unavailable carries the platform’s own words rather than ours', () => {
    const reason = 'no camera on this simulator';
    expect(affordanceFor('camera', { status: 'unavailable', reason }, 'scanner').body).toBe(reason);
  });
});

describe('re-probing', () => {
  it('re-checks on every foreground, including after a grant', () => {
    // The tempting optimisation — only re-probe when we last saw a denial — is
    // wrong in the other direction. A stale `granted` is worse than a stale
    // `denied`: the person taps record, the OS refuses underneath, and it
    // surfaces as a recorder error rather than as the permission change it was.
    for (const state of ALL_STATES) expect(shouldRecheckOnForeground(state)).toBe(true);
  });
});

describe('the affordance names the region it guards', () => {
  it('carries it through unchanged, so a screen-wide gate is visible in review', () => {
    every((kind, state) => {
      const affordance = affordanceFor(kind, state, 'the recorder');
      if (affordance.kind !== 'none') expect(affordance.guards).toBe('the recorder');
    });
  });
});
