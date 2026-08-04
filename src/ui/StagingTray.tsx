/**
 * The staging tray: everything attached to this draft.
 *
 * Each tile shows the two things that are easy to forget and expensive to
 * discover after sending — whether it has a description, and whether a video's
 * thumbnail was chosen or guessed. Tapping a tile reopens its sheet.
 */

import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { issuesFor, type Draft, type ReadinessIssue, type StagedItem } from '../core/draft';
import { hasEdits } from '../core/edits';
import { formatTimecode } from '../core/types';
import { EditedImage } from './EditedImage';
import { theme } from './theme';

export function StagingTray({
  draft,
  issues,
  canSend,
  onOpen,
  onAttach,
  onSend,
}: {
  draft: Draft;
  issues: ReadinessIssue[];
  canSend: boolean;
  onOpen(id: string): void;
  onAttach(): void;
  onSend(): void;
}) {
  const errors = issues.filter((i) => i.level === 'error');
  const notices = issues.filter((i) => i.level === 'notice');

  return (
    <View style={styles.root}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
        {draft.items.map((item) => (
          <Tile
            key={item.id}
            item={item}
            issues={issuesFor(issues, item.id)}
            onPress={() => onOpen(item.id)}
          />
        ))}
        <Pressable style={styles.attach} onPress={onAttach}>
          <Text style={styles.attachGlyph}>+</Text>
        </Pressable>
      </ScrollView>

      {errors.map((issue, i) => (
        <Text key={`e${i}`} style={styles.error}>
          {issue.message}
        </Text>
      ))}
      {notices.slice(0, 3).map((issue, i) => (
        <Text key={`n${i}`} style={styles.notice}>
          {issue.message}
        </Text>
      ))}

      <Pressable style={[styles.send, !canSend && styles.sendDisabled]} disabled={!canSend} onPress={onSend}>
        <Text style={styles.sendText}>
          Send {draft.items.length} attachment{draft.items.length === 1 ? '' : 's'}
        </Text>
      </Pressable>
    </View>
  );
}

function Tile({
  item,
  issues,
  onPress,
}: {
  item: StagedItem;
  issues: ReadinessIssue[];
  onPress(): void;
}) {
  const missingAlt = issues.some((i) => i.code === 'alt_missing');
  const autoThumbnail = issues.some((i) => i.code === 'thumbnail_auto');
  const uri = item.source.kind === 'video' ? (item.thumbnail?.uri ?? item.source.uri) : item.source.uri;

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}>
      <EditedImage uri={uri} edits={item.edits} style={styles.tileImage} radius={10} />

      <View style={styles.badges}>
        {/* Present and quiet when described, loud when not — the absence is
            what needs to catch the eye, not the presence. */}
        <View style={[styles.badge, missingAlt ? styles.badgeMissing : styles.badgeOk]}>
          <Text style={[styles.badgeText, missingAlt ? styles.badgeTextMissing : styles.badgeTextOk]}>
            {missingAlt ? 'no description' : 'ALT'}
          </Text>
        </View>
        {hasEdits(item.edits) && (
          <View style={[styles.badge, styles.badgeEdited]}>
            <Text style={styles.badgeTextOk}>edited</Text>
          </View>
        )}
      </View>

      {item.source.kind === 'video' && (
        <View style={styles.videoRow}>
          <Text style={styles.videoText}>
            {item.thumbnail?.chosenByUser
              ? `frame ${formatTimecode(item.thumbnail.atMs)}`
              : autoThumbnail
                ? 'auto frame'
                : 'video'}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: 8,
    padding: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
    backgroundColor: theme.surface,
  },
  strip: { gap: 8, alignItems: 'center' },
  tile: { width: 104 },
  tilePressed: { opacity: 0.7 },
  tileImage: { width: 104, height: 104 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  badge: { paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4 },
  badgeOk: { backgroundColor: theme.border },
  badgeEdited: { backgroundColor: theme.accentDim },
  badgeMissing: { backgroundColor: '#4a2b30' },
  badgeText: { fontSize: 9, fontWeight: '700' },
  badgeTextOk: { color: theme.textDim, fontSize: 9, fontWeight: '700' },
  badgeTextMissing: { color: '#e0a0a6' },
  videoRow: { marginTop: 2 },
  videoText: { color: theme.textFaint, fontSize: 9, fontVariant: ['tabular-nums'] },
  attach: {
    width: 104,
    height: 104,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachGlyph: { color: theme.textDim, fontSize: 28 },
  error: { color: '#e0a0a6', fontSize: 11, lineHeight: 15 },
  notice: { color: theme.textFaint, fontSize: 11, lineHeight: 15 },
  send: {
    paddingVertical: 13,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: theme.accentDim,
  },
  sendDisabled: { opacity: 0.35 },
  sendText: { color: theme.text, fontSize: 14, fontWeight: '700' },
});
