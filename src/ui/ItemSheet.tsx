/**
 * The per-item staging sheet.
 *
 * One item, everything you can still change about it: how it will be described,
 * how it looks, and — for video — which frame represents it. Reachable by
 * tapping the item in the tray, as many times as you like, right up until the
 * message is sent.
 *
 * Order is deliberate. The picture is first because that is what you tapped;
 * the description is second because it is the thing people skip and burying it
 * under the filters guarantees they skip it; filters and thumbnail are last
 * because they are the fun part and nobody needs prompting to find them.
 */

import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { bakeRequirement, hasEdits } from '../core/edits';
import { describableOf, type StagedItem } from '../core/draft';
import type { StagingSettings, ThumbnailSettings } from '../core/settings';
import type { ThumbnailProvider } from '../core/strategy';
import { assetOf } from '../core/draft';
import { formatTimecode } from '../core/types';
import { AltTextField } from './AltTextField';
import { EditedImage } from './EditedImage';
import { FilterRail } from './FilterRail';
import { ScrubDeck } from './ScrubDeck';
import { theme } from './theme';

type Tab = 'describe' | 'adjust' | 'thumbnail';

interface Props {
  item: StagedItem;
  settings: ThumbnailSettings;
  staging: StagingSettings;
  provider: ThumbnailProvider;
  onChangeAlt(alt: string): void;
  onChangeEdits(edits: StagedItem['edits']): void;
  onChangeThumbnail(choice: { uri: string; atMs: number }): void;
  onRemove(): void;
  onClose(): void;
}

export function ItemSheet({
  item,
  settings,
  staging,
  provider,
  onChangeAlt,
  onChangeEdits,
  onChangeThumbnail,
  onRemove,
  onClose,
}: Props) {
  const isVideo = item.source.kind === 'video';
  const [tab, setTab] = useState<Tab>('describe');

  const tabs: Tab[] = ['describe', ...(staging.allowFilters.value ? (['adjust'] as Tab[]) : []), ...(isVideo ? (['thumbnail'] as Tab[]) : [])];

  const bake = bakeRequirement(item.edits, staging.sendEdits.value);
  const heroUri = isVideo ? (item.thumbnail?.uri ?? item.source.uri) : item.source.uri;

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <View style={styles.root}>
        <View style={styles.header}>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={styles.close}>Done</Text>
          </Pressable>
          <Text style={styles.title} numberOfLines={1}>
            {item.source.filename ?? (isVideo ? 'Video' : 'Image')}
          </Text>
          <Pressable onPress={onRemove} hitSlop={12}>
            <Text style={styles.remove}>Remove</Text>
          </Pressable>
        </View>

        <View style={styles.tabs}>
          {tabs.map((t) => (
            <Pressable key={t} onPress={() => setTab(t)} style={[styles.tab, tab === t && styles.tabActive]}>
              <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>{t.toUpperCase()}</Text>
            </Pressable>
          ))}
        </View>

        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {tab !== 'thumbnail' && (
            <EditedImage uri={heroUri} edits={item.edits} style={styles.hero} radius={12} />
          )}

          {tab === 'describe' && (
            <AltTextField
              item={describableOf(item)}
              value={item.alt}
              settings={staging}
              onChange={onChangeAlt}
            />
          )}

          {tab === 'adjust' && (
            <>
              <FilterRail uri={heroUri} edits={item.edits} onChange={onChangeEdits} />
              {hasEdits(item.edits) && (
                <View style={[styles.bakeNote, bake.overridesPolicy && styles.bakeNoteStrong]}>
                  <Text style={[styles.bakeText, bake.overridesPolicy && styles.bakeTextStrong]}>
                    {bake.reason}
                  </Text>
                </View>
              )}
            </>
          )}

          {tab === 'thumbnail' && isVideo && (
            <>
              <ScrubDeck
                video={assetOf(item)}
                provider={provider}
                settings={settings}
                initialAtMs={item.thumbnail?.atMs}
                onChange={onChangeThumbnail}
              />
              <Text style={styles.thumbnailNote}>
                {item.thumbnail?.chosenByUser
                  ? `Using your frame at ${formatTimecode(item.thumbnail.atMs)}.`
                  : 'Drag to choose a frame. Until you do, one is picked automatically.'}
              </Text>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 10,
  },
  close: { color: theme.accent, fontSize: 15, fontWeight: '700' },
  title: { color: theme.text, fontSize: 14, fontWeight: '600', flex: 1, textAlign: 'center' },
  remove: { color: theme.danger, fontSize: 13 },
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2, borderBottomColor: theme.accent },
  tabText: { color: theme.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  tabTextActive: { color: theme.accent },
  body: { padding: 16, gap: 16 },
  hero: { width: '100%', aspectRatio: 4 / 3 },
  bakeNote: { backgroundColor: theme.surfaceAlt, borderRadius: 8, padding: 10 },
  bakeNoteStrong: { backgroundColor: '#2a1a1d', borderWidth: 1, borderColor: '#4a2b30' },
  bakeText: { color: theme.textDim, fontSize: 11, lineHeight: 16 },
  bakeTextStrong: { color: '#e0a0a6' },
  thumbnailNote: { color: theme.textDim, fontSize: 12, lineHeight: 17 },
});
