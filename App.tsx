import React, { useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ControlPanel } from './src/experiment/ControlPanel';
import { ExperimentProvider, useExperiment } from './src/experiment/ExperimentContext';
import { FrameScrubber } from './src/ui/FrameScrubber';
import { ThumbnailCard } from './src/ui/ThumbnailCard';
import { theme } from './src/ui/theme';

function Gallery() {
  const { world, settings } = useExperiment();
  const [scrubbing, setScrubbing] = useState<string | null>(null);

  const target = world.videos().find((v) => v.id === scrubbing) ?? null;

  return (
    <>
      <ScrollView style={styles.gallery} contentContainerStyle={styles.galleryContent}>
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
            <FrameScrubber
              video={target}
              provider={world.providerFor(target.id)}
              settings={settings}
              onUse={(choice) => {
                world.pick(target.id, choice);
                setScrubbing(null);
              }}
              onCancel={() => setScrubbing(null)}
            />
          )}
        </View>
      </Modal>
    </>
  );
}

function Screen() {
  const insets = useSafeAreaInsets();
  const { scenario } = useExperiment();

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>{scenario.title}</Text>
        <Text style={styles.subtitle}>{scenario.group}</Text>
      </View>
      <Gallery />
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
  header: {
    paddingHorizontal: 14,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  title: { color: theme.text, fontSize: 17, fontWeight: '700' },
  subtitle: { color: theme.textFaint, fontSize: 11, marginTop: 2, textTransform: 'uppercase', letterSpacing: 1 },
  gallery: { flex: 1 },
  galleryContent: { padding: 10, gap: 10 },
  scrubRoot: { flex: 1, backgroundColor: theme.bg, paddingTop: 60, paddingHorizontal: 16 },
  empty: { color: theme.textFaint, textAlign: 'center', marginTop: 40, fontSize: 13 },
});
