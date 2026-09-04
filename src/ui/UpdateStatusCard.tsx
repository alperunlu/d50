/**
 * Hangi JS sürümünün çalıştığını gösteren kart + elle güncelleme indirme.
 *
 * Neden var: TestFlight build'i sabit kalırken içindeki JS bundle'ı OTA ile
 * değişiyor (bkz. plan, Kısıt #2). "Güncellemeyi aldım mı?" sorusunun
 * arabaya gitmeden, bakarak cevaplanabilmesi gerekiyor — yoksa eski kodla
 * yola çıkıp bir araç ziyaretini boşa harcamak çok kolay.
 *
 * `isEmbeddedLaunch` bu sorunun tam cevabı: true ise build'in içine gömülü
 * orijinal bundle çalışıyor (hiç OTA uygulanmamış), false ise indirilmiş bir
 * güncelleme aktif.
 */

import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Alert } from 'react-native';
import * as Updates from 'expo-updates';
import { theme, spacing } from './theme';

/**
 * Her OTA yayınında ELLE değiştirilen etiket.
 *
 * `Updates.updateId` / `isEmbeddedLaunch` platforma göre farklı davranabiliyor;
 * bu etiket ise yalnızca JS bundle'ıyla birlikte değiştiği için "doğru sürüm
 * indi mi?" sorusunun tartışmasız cevabı. Arabaya çıkmadan önce buraya bakıp
 * beklenen değerle karşılaştırmak yeterli.
 */
export const JS_BUILD_TAG = '2026-09-05 · js-7 (sensors+logs)';

export function UpdateStatusCard() {
  const [busy, setBusy] = useState(false);

  const handleCheck = useCallback(async () => {
    if (!Updates.isEnabled) {
      Alert.alert('Development mode', 'OTA updates only work in a real build.');
      return;
    }
    setBusy(true);
    try {
      const check = await Updates.checkForUpdateAsync();
      if (!check.isAvailable) {
        Alert.alert('Up to date', 'You are already running the latest version.');
        return;
      }
      await Updates.fetchUpdateAsync();
      Alert.alert(
        'Update downloaded',
        'The app will now restart.',
        [{ text: 'OK', onPress: () => void Updates.reloadAsync() }],
      );
    } catch (e) {
      Alert.alert('Update failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const running = !Updates.isEnabled
    ? 'Development mode (OTA disabled)'
    : Updates.isEmbeddedLaunch
      ? 'Original build bundle (no OTA applied)'
      : 'OTA update active';

  const runningColor = !Updates.isEnabled
    ? theme.textDim
    : Updates.isEmbeddedLaunch
      ? theme.warning
      : theme.ok;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Running version</Text>
      <Text style={styles.buildTag}>{JS_BUILD_TAG}</Text>
      <Text style={[styles.running, { color: runningColor }]}>{running}</Text>

      <Row label="Update ID" value={shortId(Updates.updateId)} />
      <Row label="Published" value={formatDate(Updates.createdAt)} />
      <Row label="Channel" value={Updates.channel ?? '—'} />
      <Row label="Runtime" value={Updates.runtimeVersion ?? '—'} />

      <Pressable style={styles.button} onPress={handleCheck} disabled={busy}>
        {busy ? (
          <ActivityIndicator color={theme.text} />
        ) : (
          <Text style={styles.buttonText}>Check for update (download & restart)</Text>
        )}
      </Pressable>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function shortId(id: string | null): string {
  if (!id) return '—';
  return id.length > 13 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function formatDate(d: Date | null): string {
  if (!d) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing(2),
    marginBottom: spacing(1),
    padding: spacing(1.5),
    backgroundColor: theme.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.border,
    gap: 4,
  },
  title: { color: theme.text, fontWeight: '700', fontSize: 14 },
  buildTag: {
    color: theme.accent,
    fontFamily: 'monospace',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 2,
  },
  running: { fontSize: 13, fontWeight: '600', marginBottom: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  rowLabel: { color: theme.textDim, fontSize: 12 },
  rowValue: { color: theme.text, fontSize: 12, fontFamily: 'monospace' },
  button: {
    marginTop: spacing(1),
    backgroundColor: theme.surfaceAlt,
    borderRadius: 8,
    paddingVertical: spacing(1),
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.accent,
  },
  buttonText: { color: theme.text, fontWeight: '600', fontSize: 12 },
});
