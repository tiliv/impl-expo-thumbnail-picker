/**
 * Describing the attachment.
 *
 * The announcement preview is the whole design. A field labelled "alt text"
 * collects filenames; a field that shows you what a screen reader will read out
 * collects sentences, because "Image. IMG_4471" is visibly not an answer.
 *
 * Suggestions are shown as suggestions and never block. A mediocre description
 * is worth more than a blocked send and an annoyed author.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { announcement, altIssues, stripRedundantPrefix, type Describable } from '../core/altText';
import type { StagingSettings } from '../core/settings';
import { theme } from './theme';

export function AltTextField({
  item,
  value,
  settings,
  onChange,
}: {
  item: Describable;
  value: string;
  settings: StagingSettings;
  onChange(next: string): void;
}) {
  const policy = {
    requirement: settings.requireAltText.value,
    maxChars: settings.altTextMaxChars.value,
  };
  const issues = altIssues(value, item, policy);
  const hasRedundantPrefix = issues.some((i) => i.code === 'redundant_prefix');

  return (
    <View style={styles.root}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>Description</Text>
        {settings.requireAltText.value === 'required' && <Text style={styles.required}>required here</Text>}
      </View>

      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        multiline
        placeholder="What would you tell someone who cannot see this?"
        placeholderTextColor={theme.textFaint}
        maxLength={policy.maxChars + 200}
      />

      <View style={styles.announcement}>
        <Text style={styles.announcementLabel}>READS AS</Text>
        <Text style={styles.announcementText}>{announcement(item, value)}</Text>
      </View>

      {issues.map((issue) => (
        <View key={issue.code} style={[styles.issue, issue.level === 'error' && styles.issueError]}>
          <Text style={[styles.issueText, issue.level === 'error' && styles.issueTextError]}>
            {issue.message}
          </Text>
          {issue.code === 'redundant_prefix' && hasRedundantPrefix && (
            <Pressable onPress={() => onChange(stripRedundantPrefix(value))}>
              <Text style={styles.fix}>Trim it</Text>
            </Pressable>
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 8 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { color: theme.text, fontSize: 13, fontWeight: '600' },
  required: {
    color: theme.warn,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: '700',
  },
  input: {
    backgroundColor: theme.surfaceAlt,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.border,
    color: theme.text,
    fontSize: 14,
    padding: 11,
    minHeight: 76,
    textAlignVertical: 'top',
  },
  announcement: {
    backgroundColor: theme.bg,
    borderRadius: 8,
    borderLeftWidth: 3,
    borderLeftColor: theme.accent,
    padding: 9,
  },
  announcementLabel: { color: theme.textFaint, fontSize: 9, fontWeight: '700', letterSpacing: 1, marginBottom: 3 },
  announcementText: { color: theme.textDim, fontSize: 13, lineHeight: 18, fontStyle: 'italic' },
  issue: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    backgroundColor: '#2a2318',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  issueError: { backgroundColor: '#2a1a1d' },
  issueText: { color: theme.warn, fontSize: 11, lineHeight: 15, flex: 1 },
  issueTextError: { color: '#e0a0a6' },
  fix: { color: theme.accent, fontSize: 11, fontWeight: '700' },
});
