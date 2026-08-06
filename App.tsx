import React, { useCallback, useMemo, useReducer, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';

import {
  draftReadiness,
  draftReducer,
  emptyDraft,
  stage,
  type StagedSource,
} from './src/core/draft';
import { ControlPanel } from './src/experiment/ControlPanel';
import { ExperimentProvider, useExperiment } from './src/experiment/ExperimentContext';
import { ItemSheet } from './src/ui/ItemSheet';
import { PermissionArea } from './src/ui/PermissionArea';
import { useLibraryPermission } from './src/ui/useLibraryPermission';
import { ScrubDeck } from './src/ui/ScrubDeck';
import { StagingTray } from './src/ui/StagingTray';
import { ThumbnailCard } from './src/ui/ThumbnailCard';
import { theme } from './src/ui/theme';

type Mode = 'staging' | 'resolution';

/**
 * The draft/staging view.
 *
 * This is the composer side: media that has been attached but not sent, still
 * fully editable. Tapping an item reopens its sheet, which is the whole point
 * of staging rather than a one-shot picker — nothing decided at attach time is
 * final.
 */
function Staging() {
  const { world, settings, staging } = useExperiment();
  const [draft, dispatch] = useReducer(draftReducer, undefined, () => {
    const items = world.videos().map((video) =>
      stage({
        kind: 'video',
        uri: video.uri,
        filename: video.filename,
        width: video.width,
        height: video.height,
        durationMs: video.durationMs,
      }),
    );
    return { ...emptyDraft(), items };
  });

  const library = useLibraryPermission('attaching media');
  const { canSend, issues } = draftReadiness(draft, staging, staging.sendEdits.value);
  const open = draft.items.find((i) => i.id === draft.openItemId) ?? null;

  const attach = useCallback(async () => {
    // No alert on refusal. An alert says its piece, gets dismissed, and leaves
    // nothing on screen — while the attach button still looks like it works.
    // The block below carries the state instead, and it stays.
    if (!library.usable) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: true,
      selectionLimit: staging.maxAttachments.value,
      quality: 1,
    });
    if (result.canceled) return;

    const items = result.assets.map((asset) => {
      const source: StagedSource = {
        kind: asset.type === 'video' ? 'video' : 'image',
        uri: asset.uri,
        filename: asset.fileName ?? undefined,
        width: asset.width,
        height: asset.height,
        durationMs: asset.duration ?? undefined,
      };
      return stage(source);
    });
    dispatch({ type: 'attach', items });
  }, [staging.maxAttachments, library.usable]);

  return (
    <>
      <ScrollView style={styles.flex} contentContainerStyle={styles.stagingBody}>
        <Text style={styles.blurb}>
          Attachments stay editable until the message is sent. Tap one to describe it, adjust it, or
          pick the frame that represents it.
        </Text>
        {draft.items.length === 0 && (
          <Text style={styles.empty}>Nothing attached. Use + to add something.</Text>
        )}
      </ScrollView>

      {/*
        Above the tray rather than replacing it: the tray still holds whatever
        was already staged, and a person with limited access can still work with
        it. Only the *attach* affordance is gone, so only that region is covered.
      */}
      <PermissionArea affordance={library.affordance} onAct={(e) => void library.act(e)} />

      <StagingTray
        draft={draft}
        issues={issues}
        canSend={canSend}
        onOpen={(id) => dispatch({ type: 'open', id })}
        onAttach={attach}
        onSend={() =>
          Alert.alert(
            'Send',
            `${draft.items.length} attachment(s) would go now, with edits ${staging.sendEdits.value === 'baked' ? 'flattened' : 'as a list'}.`,
          )
        }
      />

      {open && (
        <ItemSheet
          item={open}
          settings={settings}
          staging={staging}
          provider={world.providerFor(open.id)}
          onChangeAlt={(alt) => dispatch({ type: 'set_alt', id: open.id, alt })}
          onChangeEdits={(edits) => dispatch({ type: 'set_edits', id: open.id, edits })}
          onChangeThumbnail={(choice) =>
            dispatch({
              type: 'set_thumbnail',
              id: open.id,
              thumbnail: { ...choice, chosenByUser: true },
            })
          }
          onRemove={() => dispatch({ type: 'remove', id: open.id })}
          onClose={() => dispatch({ type: 'close' })}
        />
      )}
    </>
  );
}

/** The original view: what the chain resolves when nobody opened a sheet. */
function Resolution() {
  const { world, settings } = useExperiment();
  const [scrubbing, setScrubbing] = useState<string | null>(null);
  const target = world.videos().find((v) => v.id === scrubbing) ?? null;

  return (
    <>
      <ScrollView style={styles.flex} contentContainerStyle={styles.galleryContent}>
        {world.videos().map((video) => (
          <ThumbnailCard
            key={video.id}
            video={video}
            resolution={world.resolution(video.id)}
            canPick={settings.allowUserPick.value}
            hasPick={world.pickFor(video.id) !== null}
            onPick={() => setScrubbing(video.id)}
            onClearPick={() => world.pick(video.id, null)}
          />
        ))}
        {world.videos().length === 0 && <Text style={styles.empty}>No videos in this arrangement.</Text>}
      </ScrollView>

      <Modal visible={target !== null} animationType="slide" onRequestClose={() => setScrubbing(null)}>
        <View style={styles.scrubRoot}>
          {target && (
            <>
              <ScrubDeck
                video={target}
                provider={world.providerFor(target.id)}
                settings={settings}
                initialAtMs={world.pickFor(target.id)?.atMs}
                onChange={(choice) => world.pick(target.id, choice)}
              />
              <Pressable style={styles.done} onPress={() => setScrubbing(null)}>
                <Text style={styles.doneText}>Done</Text>
              </Pressable>
            </>
          )}
        </View>
      </Modal>
    </>
  );
}

function Screen() {
  const insets = useSafeAreaInsets();
  const { scenario } = useExperiment();
  const [mode, setMode] = useState<Mode>('staging');

  const modes = useMemo(() => ['staging', 'resolution'] as Mode[], []);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View style={styles.modeRow}>
          {modes.map((m) => (
            <Pressable key={m} onPress={() => setMode(m)} style={[styles.mode, mode === m && styles.modeActive]}>
              <Text style={[styles.modeText, mode === m && styles.modeTextActive]}>{m}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.subtitle}>{scenario.title}</Text>
      </View>

      {mode === 'staging' ? <Staging /> : <Resolution />}

      <View style={{ paddingBottom: insets.bottom }}>
        <ControlPanel />
      </View>
      <StatusBar style="light" />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ExperimentProvider>
        <Screen />
      </ExperimentProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  flex: { flex: 1 },
  header: {
    paddingHorizontal: 14,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
    gap: 6,
  },
  modeRow: { flexDirection: 'row', gap: 6 },
  mode: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: theme.surfaceAlt,
  },
  modeActive: { backgroundColor: theme.accentDim },
  modeText: { color: theme.textDim, fontSize: 12, textTransform: 'capitalize' },
  modeTextActive: { color: theme.text, fontWeight: '700' },
  subtitle: { color: theme.textFaint, fontSize: 11 },
  stagingBody: { padding: 14, gap: 10 },
  blurb: { color: theme.textDim, fontSize: 13, lineHeight: 18 },
  galleryContent: { padding: 10, gap: 10 },
  scrubRoot: { flex: 1, backgroundColor: theme.bg, paddingTop: 60, paddingHorizontal: 16, gap: 16 },
  done: { paddingVertical: 13, borderRadius: 10, alignItems: 'center', backgroundColor: theme.accentDim },
  doneText: { color: theme.text, fontSize: 14, fontWeight: '700' },
  empty: { color: theme.textFaint, textAlign: 'center', marginTop: 40, fontSize: 13 },
});
