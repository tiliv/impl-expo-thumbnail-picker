/**
 * Control panel.
 *
 * ROOM sends state events. PLATFORM fakes device capabilities — which native
 * modules exist, whether the decoder works — because those are environmental
 * facts you cannot arrange on a simulator, and the whole chain is about how it
 * behaves when they are absent.
 */

import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

import { stateEvent } from '../core/roomState';
import {
  DECODE_AVERSE_ORDER,
  DEFAULT_ORDER,
  describeSource,
  STATE_STAGING,
  STATE_THUMBNAIL,
  type Resolved,
} from '../core/settings';
import type { SendEditsPolicy } from '../core/edits';
import type { ThumbnailStrategy } from '../core/types';
import { theme } from '../ui/theme';
import { PermissionArea } from '../ui/PermissionArea';
import { useLibraryPermission } from '../ui/useLibraryPermission';
import { SCENARIOS } from './scenarios';
import { useExperiment } from './ExperimentContext';

function Chip({ label, active, onPress }: { label: string; active?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.chip, active && styles.chipActive, pressed && styles.chipPressed]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

function Row({ label, source, children }: { label: string; source?: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowControls}>{children}</View>
      {source && <Text style={styles.provenance}>← {source}</Text>}
    </View>
  );
}

const src = <T,>(r: Resolved<T>) => describeSource(r.source);

const ORDERS: { label: string; order: ThumbnailStrategy[] }[] = [
  { label: 'default', order: DEFAULT_ORDER },
  // The original chain, kept for comparison: it led with `library` to dodge a
  // decode, which stops being worth optimising once scrubbing is the interaction.
  { label: 'decode-averse', order: DECODE_AVERSE_ORDER },
  { label: 'sampled only', order: ['scored_sample', 'frame_at', 'placeholder'] },
  { label: 'no fallback', order: ['library', 'frame_at'] },
];

export function ControlPanel() {
  const { world, settings, staging, warnings, scenario, setScenario } = useExperiment();
  const [tab, setTab] = useState<'scenario' | 'room' | 'platform'>('scenario');
  const library = useLibraryPermission('adding a real video');

  const send = (patch: Record<string, unknown>) => {
    const current = world.stateStore.get(STATE_THUMBNAIL)?.content ?? {};
    world.stateStore.send(stateEvent(STATE_THUMBNAIL, { ...current, ...patch }));
  };

  const sendStaging = (patch: Record<string, unknown>) => {
    const current = world.stateStore.get(STATE_STAGING)?.content ?? {};
    world.stateStore.send(stateEvent(STATE_STAGING, { ...current, ...patch }));
  };

  /**
   * Real device video, through the real provider. Worth doing at least once:
   * the synthetic clips cannot tell you what your actual camera roll does to
   * the extraction path.
   */
  const addRealVideo = async () => {
    // Gated on the same state the composer uses, rather than a second copy of
    // the request-and-alert dance. Two copies of a permission flow is two
    // places for one of them to grow a fix the other does not.
    if (!library.usable) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'],
      quality: 1,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) return;

    world.addReal({
      id: `real-${Date.now()}`,
      uri: asset.uri,
      durationMs: asset.duration ?? 0,
      width: asset.width,
      height: asset.height,
      filename: asset.fileName ?? 'from library',
      libraryAssetId: asset.assetId ?? undefined,
    });
  };

  return (
    <View style={styles.panel}>
      <View style={styles.tabs}>
        {(['scenario', 'room', 'platform'] as const).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={[styles.tab, tab === t && styles.tabActive]}>
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>{t.toUpperCase()}</Text>
          </Pressable>
        ))}
      </View>

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
        {tab === 'scenario' && (
          <>
            <Text style={styles.question}>{scenario.question}</Text>
            {(['staging', 'base-case', 'sampling', 'picker', 'failure'] as const).map((group) => (
              <View key={group}>
                <Text style={styles.sectionLabel}>{group}</Text>
                <View style={styles.chipWrap}>
                  {SCENARIOS.filter((s) => s.group === group).map((s) => (
                    <Chip key={s.id} label={s.title} active={s.id === scenario.id} onPress={() => setScenario(s)} />
                  ))}
                </View>
              </View>
            ))}
            <Text style={styles.sectionLabel}>Expected</Text>
            {scenario.expect.map((line, i) => (
              <Text key={i} style={styles.expectLine}>
                • {line}
              </Text>
            ))}
            {scenario.tryNext?.map((line, i) => (
              <Text key={i} style={styles.tryLine}>
                → {line}
              </Text>
            ))}
            <View style={{ marginTop: 12 }}>
              {library.affordance.kind === 'none' ? (
                <Chip label="+ add a real video from the library" onPress={addRealVideo} />
              ) : (
                // Replaces the chip rather than sitting beside it. A disabled
                // chip next to an explanation is two things saying the same
                // thing, and the one that can be tapped is the wrong one.
                <PermissionArea
                  affordance={library.affordance}
                  onAct={(e) => void library.act(e)}
                  minHeight={132}
                />
              )}
            </View>
          </>
        )}

        {tab === 'room' && (
          <>
            <Text style={styles.hint}>Every control here sends a room state event.</Text>

            <Row label="strategy_order" source={src(settings.strategyOrder)}>
              {ORDERS.map(({ label, order }) => (
                <Chip
                  key={label}
                  label={label}
                  active={settings.strategyOrder.value.join(',') === order.join(',')}
                  onPress={() => send({ strategy_order: order })}
                />
              ))}
            </Row>
            <Text style={styles.currentOrder}>{settings.strategyOrder.value.join(' → ')}</Text>

            <Row label="default_frame_ms" source={src(settings.defaultFrameMs)}>
              {[0, 1000, 3000, 5000].map((ms) => (
                <Chip
                  key={ms}
                  label={`${ms}ms`}
                  active={settings.defaultFrameMs.value === ms}
                  onPress={() => send({ default_frame_ms: ms })}
                />
              ))}
            </Row>

            <Row label="allow_user_pick" source={src(settings.allowUserPick)}>
              {[true, false].map((v) => (
                <Chip
                  key={String(v)}
                  label={v ? 'on' : 'off'}
                  active={settings.allowUserPick.value === v}
                  onPress={() => send({ allow_user_pick: v })}
                />
              ))}
            </Row>

            <Row label="sample_count / filmstrip_frames">
              {[3, 7, 12].map((n) => (
                <Chip
                  key={`s${n}`}
                  label={`sample ${n}`}
                  active={settings.sampleCount.value === n}
                  onPress={() => send({ sample_count: n })}
                />
              ))}
              {[6, 12, 18].map((n) => (
                <Chip
                  key={`f${n}`}
                  label={`strip ${n}`}
                  active={settings.filmstripFrames.value === n}
                  onPress={() => send({ filmstrip_frames: n })}
                />
              ))}
            </Row>

            <Row label="reject_flat_frames" source={src(settings.rejectFlatFrames)}>
              {[true, false].map((v) => (
                <Chip
                  key={String(v)}
                  label={v ? 'on' : 'off'}
                  active={settings.rejectFlatFrames.value === v}
                  onPress={() => send({ reject_flat_frames: v })}
                />
              ))}
            </Row>

            <Text style={styles.sectionLabel}>app.envelope.staging</Text>

            <Row label="require_alt_text" source={src(staging.requireAltText)}>
              {(['off', 'warn', 'required'] as const).map((v) => (
                <Chip
                  key={v}
                  label={v}
                  active={staging.requireAltText.value === v}
                  onPress={() => sendStaging({ require_alt_text: v })}
                />
              ))}
            </Row>

            <Row label="send_edits" source={src(staging.sendEdits)}>
              {(['baked', 'with_original'] as SendEditsPolicy[]).map((v) => (
                <Chip
                  key={v}
                  label={v.replace('_', ' ')}
                  active={staging.sendEdits.value === v}
                  onPress={() => sendStaging({ send_edits: v })}
                />
              ))}
            </Row>

            <Row label="allow_filters" source={src(staging.allowFilters)}>
              {[true, false].map((v) => (
                <Chip
                  key={String(v)}
                  label={v ? 'on' : 'off'}
                  active={staging.allowFilters.value === v}
                  onPress={() => sendStaging({ allow_filters: v })}
                />
              ))}
            </Row>

            <Text style={styles.sectionLabel}>Send a bad value</Text>
            <View style={styles.chipWrap}>
              <Chip label="order: [telepathy]" onPress={() => send({ strategy_order: ['telepathy'] })} />
              <Chip label="quality: high" onPress={() => send({ quality: 'high' })} />
              <Chip label="sample_count: 999" onPress={() => send({ sample_count: 999 })} />
            </View>
          </>
        )}

        {tab === 'platform' && (
          <>
            <Text style={styles.hint}>
              Device capabilities, not room policy. All off by default because that is the truth on
              Expo today.
            </Text>
            <Row label="native library-thumbnail module">
              {[true, false].map((v) => (
                <Chip
                  key={String(v)}
                  label={v ? 'exists' : 'absent'}
                  active={world.capabilities.hasLibraryThumbnails === v}
                  onPress={() => world.setCapabilities({ hasLibraryThumbnails: v })}
                />
              ))}
            </Row>
            <Row label="container poster reader">
              {[true, false].map((v) => (
                <Chip
                  key={String(v)}
                  label={v ? 'exists' : 'absent'}
                  active={world.capabilities.hasEmbeddedPoster === v}
                  onPress={() => world.setCapabilities({ hasEmbeddedPoster: v })}
                />
              ))}
            </Row>
            <Row label="pixel frame scorer">
              {[true, false].map((v) => (
                <Chip
                  key={String(v)}
                  label={v ? 'exists' : 'absent'}
                  active={world.capabilities.hasFrameScorer === v}
                  onPress={() => world.setCapabilities({ hasFrameScorer: v })}
                />
              ))}
            </Row>
            <Row label="decoder">
              {[false, true].map((v) => (
                <Chip
                  key={String(v)}
                  label={v ? 'broken' : 'working'}
                  active={world.capabilities.extractionBroken === v}
                  onPress={() => world.setCapabilities({ extractionBroken: v })}
                />
              ))}
            </Row>
            <Row label="cache">
              <Chip label="↺ re-resolve everything" onPress={() => world.invalidate()} />
            </Row>
          </>
        )}

        {warnings.length > 0 && (
          <View style={styles.warnings}>
            <Text style={styles.warningTitle}>Resolver warnings</Text>
            {warnings.map((w, i) => (
              <Text key={i} style={[styles.warningLine, w.severity === 'danger' && styles.warningDanger]}>
                {w.setting}: {w.message}
              </Text>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { backgroundColor: theme.surface, borderTopWidth: 1, borderTopColor: theme.border, maxHeight: '50%' },
  tabs: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: theme.border },
  tab: { flex: 1, paddingVertical: 9, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2, borderBottomColor: theme.accent },
  tabText: { color: theme.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  tabTextActive: { color: theme.accent },
  body: { flexGrow: 0 },
  bodyContent: { padding: 12, paddingBottom: 24 },
  question: { color: theme.text, fontSize: 14, fontWeight: '600', marginBottom: 10, lineHeight: 19 },
  hint: { color: theme.textDim, fontSize: 11, marginBottom: 10, lineHeight: 15, fontStyle: 'italic' },
  sectionLabel: {
    color: theme.textFaint,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 12,
    marginBottom: 5,
  },
  expectLine: { color: theme.textDim, fontSize: 12, lineHeight: 17, marginBottom: 3 },
  tryLine: { color: theme.accent, fontSize: 12, lineHeight: 17, marginTop: 3 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: theme.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.border,
  },
  chipActive: { backgroundColor: theme.accentDim, borderColor: theme.accent },
  chipPressed: { opacity: 0.6 },
  chipText: { color: theme.textDim, fontSize: 11 },
  chipTextActive: { color: theme.text, fontWeight: '700' },
  currentOrder: { color: theme.accent, fontSize: 11, marginTop: -4, marginBottom: 10 },
  row: { marginBottom: 10 },
  rowLabel: { color: theme.text, fontSize: 11, fontWeight: '600', marginBottom: 5 },
  rowControls: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  provenance: { color: theme.textFaint, fontSize: 10, marginTop: 4, fontStyle: 'italic' },
  warnings: {
    marginTop: 12,
    padding: 9,
    borderRadius: theme.radiusSm,
    backgroundColor: '#2a1a1d',
    borderWidth: 1,
    borderColor: '#4a2b30',
  },
  warningTitle: { color: theme.danger, fontSize: 11, fontWeight: '700', marginBottom: 4 },
  warningLine: { color: '#e0a0a6', fontSize: 11, lineHeight: 15 },
  warningDanger: { color: theme.danger, fontWeight: '700' },
});
