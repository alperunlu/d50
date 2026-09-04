import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, Pressable, FlatList, ScrollView, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppStore } from '../src/state/store';
import { writeAndShare } from '../src/util/exportFile';
import { ALLOWED_COMMANDS_SUMMARY } from '../src/obd/allowlist';
import { theme, spacing } from '../src/ui/theme';
import { UpdateStatusCard } from '../src/ui/UpdateStatusCard';
import type { RawLogEntry } from '../src/state/store';
import type { ProfileCandidate } from '../src/ble/profiles';

/**
 * Arabaya çıkılan her ziyaretten azami bilgi çıkarmak için: gönderilen her
 * komut ve gelen her ham cevap burada, zaman damgasıyla görünür ve .txt
 * olarak paylaşılabilir. Bkz. plan, Kısıt #2 — "Ham kayıt ekranı".
 */
export default function DebugScreen() {
  const rawLog = useAppStore((s) => s.rawLog);
  const clearLog = useAppStore((s) => s.clearLog);
  const bleCandidates = useAppStore((s) => s.bleCandidates);
  const manualNotify = useAppStore((s) => s.manualNotify);
  const manualWrite = useAppStore((s) => s.manualWrite);
  const pickManualNotify = useAppStore((s) => s.pickManualNotify);
  const pickManualWrite = useAppStore((s) => s.pickManualWrite);
  const connectWithManualProfile = useAppStore((s) => s.connectWithManualProfile);
  const connectError = useAppStore((s) => s.connectError);
  const connectionState = useAppStore((s) => s.connectionState);
  const scanProgress = useAppStore((s) => s.scanProgress);
  const scanRows = useAppStore((s) => s.scanRows);
  const runPidScan = useAppStore((s) => s.runPidScan);
  const [busy, setBusy] = useState(false);
  const [manualConnecting, setManualConnecting] = useState(false);

  const handleManualConnect = useCallback(async () => {
    setManualConnecting(true);
    try {
      await connectWithManualProfile();
    } finally {
      setManualConnecting(false);
    }
  }, [connectWithManualProfile]);

  const handlePidScan = useCallback(async () => {
    const report = await runPidScan();
    if (!report) return;
    try {
      const { uri, shared } = await writeAndShare(
        `obd_pid_scan_${Date.now()}.txt`,
        report,
        'text/plain',
        'Share PID scan report',
      );
      if (!shared) Alert.alert('Sharing unavailable', `File saved: ${uri}`);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : String(e));
    }
  }, [runPidScan]);

  const handleShare = useCallback(async () => {
    setBusy(true);
    try {
      const text = rawLog.map(formatLine).join('\n');
      const fileName = `obd_debug_${Date.now()}.txt`;
      const { uri, shared } = await writeAndShare(fileName, text, 'text/plain', 'Share debug log');
      if (!shared) {
        Alert.alert('Sharing unavailable', `File saved: ${uri}`);
      }
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [rawLog]);

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <UpdateStatusCard />

      <View style={styles.toolbar}>
        <Pressable style={styles.button} onPress={handleShare} disabled={busy || rawLog.length === 0}>
          <Text style={styles.buttonText}>{busy ? 'Preparing…' : 'Share .txt'}</Text>
        </Pressable>
        <Pressable style={[styles.button, styles.buttonSecondary]} onPress={clearLog}>
          <Text style={styles.buttonText}>Clear</Text>
        </Pressable>
      </View>

      {/*
        "Bu PID araçta var mı?" sorusunun kesin cevabı: bitmask'in iddia
        ettiği her PID'i tek tek sorup gerçek cevabı kaydetmek. Tek araç
        ziyaretinde katalogun tamamı doğrulanır.
      */}
      <View style={styles.toolbar}>
        <Pressable
          style={[styles.button, styles.scanButton]}
          onPress={handlePidScan}
          disabled={connectionState !== 'connected' || scanProgress !== null}
        >
          <Text style={styles.buttonText}>
            {scanProgress
              ? `Scanning ${scanProgress.done}/${scanProgress.total}… (${scanProgress.currentPid})`
              : 'Scan vehicle PIDs & share report'}
          </Text>
        </Pressable>
      </View>

      {scanRows && (
        <Text style={styles.scanSummary}>
          {`Last scan: ${scanRows.filter((r) => r.answered).length}/${scanRows.length} claimed PIDs actually answered`}
        </Text>
      )}

      {bleCandidates && bleCandidates.length > 0 && (
        <View style={styles.candidatesBlock}>
          <Text style={styles.allowedTitle}>
            No profile matched automatically. Pick one notify + one write (must be in the same service):
          </Text>

          {/*
            Buton ve seçim özeti BİLEREK listenin ÜSTÜNDE: aday listesi uzun
            olabiliyor ve altta kalırsa ekrandan taşıp erişilemez hâle geliyor
            (2026-09-03'te arabada tam olarak bu oldu — kullanıcı butonu göremedi).
          */}
          <Text style={styles.selectionSummary}>
            {`Notify: ${shortUuid(manualNotify?.characteristicUUID)}   Write: ${shortUuid(manualWrite?.characteristicUUID)}`}
          </Text>

          <Pressable
            style={[styles.button, styles.manualConnectButton]}
            onPress={handleManualConnect}
            disabled={manualConnecting || !manualNotify || !manualWrite}
          >
            <Text style={styles.buttonText}>
              {manualConnecting ? 'Connecting…' : 'Connect with this profile'}
            </Text>
          </Pressable>

          {connectError && (
            <Text style={styles.errorText} numberOfLines={4}>
              {connectError}
            </Text>
          )}

          <ScrollView style={styles.candidateScroll} nestedScrollEnabled>
            {bleCandidates.map((c, i) => (
              <CandidateRow
                key={i}
                candidate={c}
                isNotify={sameCandidate(manualNotify, c)}
                isWrite={sameCandidate(manualWrite, c)}
                onPickNotify={() => pickManualNotify(c)}
                onPickWrite={() => pickManualWrite(c)}
              />
            ))}
          </ScrollView>
        </View>
      )}

      <FlatList
        data={[...rawLog].reverse()}
        keyExtractor={(item, i) => `${item.ts}-${i}`}
        contentContainerStyle={styles.logList}
        inverted
        renderItem={({ item }) => <LogLine entry={item} />}
        ListEmptyComponent={
          <View style={styles.emptyBlock}>
            <Text style={styles.empty}>No log entries yet. They appear here once you connect from the Connect tab.</Text>
            <Text style={styles.allowedTitle}>Allowed commands:</Text>
            <Text style={styles.allowedText}>{ALLOWED_COMMANDS_SUMMARY}</Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

function sameCandidate(a: ProfileCandidate | null, b: ProfileCandidate): boolean {
  return !!a && a.serviceUUID === b.serviceUUID && a.characteristicUUID === b.characteristicUUID;
}

/** 128-bit UUID'nin ayırt edici ilk bloğu — özet satırında tam UUID sığmıyor. */
function shortUuid(uuid: string | undefined): string {
  if (!uuid) return '—';
  return uuid.split('-')[0];
}

function CandidateRow({
  candidate,
  isNotify,
  isWrite,
  onPickNotify,
  onPickWrite,
}: {
  candidate: ProfileCandidate;
  isNotify: boolean;
  isWrite: boolean;
  onPickNotify: () => void;
  onPickWrite: () => void;
}) {
  return (
    <View style={styles.candidateRow}>
      <Text style={styles.candidateLine}>
        {candidate.serviceUUID} / {candidate.characteristicUUID}
      </Text>
      <View style={styles.candidateActions}>
        {candidate.isNotifiable && (
          <Pressable
            style={[styles.chip, isNotify && styles.chipActive]}
            onPress={onPickNotify}
          >
            <Text style={[styles.chipText, isNotify && styles.chipTextActive]}>
              {isNotify ? '✓ Notify' : 'Set notify'}
            </Text>
          </Pressable>
        )}
        {candidate.isWritable && (
          <Pressable style={[styles.chip, isWrite && styles.chipActive]} onPress={onPickWrite}>
            <Text style={[styles.chipText, isWrite && styles.chipTextActive]}>
              {isWrite ? '✓ Write' : 'Set write'}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function LogLine({ entry }: { entry: RawLogEntry }) {
  const color =
    entry.direction === 'error'
      ? theme.danger
      : entry.direction === 'tx'
        ? theme.accent
        : entry.direction === 'rx'
          ? theme.text
          : theme.textDim;
  const prefix =
    entry.direction === 'tx' ? '→' : entry.direction === 'rx' ? '←' : entry.direction === 'error' ? '✗' : 'ℹ';

  return (
    <Text style={[styles.logLine, { color }]}>
      {`${formatTime(entry.ts)}  ${prefix}  ${entry.text}`}
    </Text>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function formatLine(entry: RawLogEntry): string {
  return `${new Date(entry.ts).toISOString()} [${entry.direction}] ${entry.text}`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  toolbar: { flexDirection: 'row', gap: spacing(1), padding: spacing(2) },
  button: {
    flex: 1,
    backgroundColor: theme.surfaceAlt,
    borderRadius: 8,
    paddingVertical: spacing(1),
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.border,
  },
  buttonSecondary: { borderColor: theme.warning },
  scanButton: { borderColor: theme.accent },
  scanSummary: {
    color: theme.textDim,
    fontSize: 12,
    marginHorizontal: spacing(2),
    marginBottom: spacing(1),
  },
  buttonText: { color: theme.text, fontWeight: '600', fontSize: 13 },
  logList: { paddingHorizontal: spacing(2), paddingBottom: spacing(2) },
  logLine: { fontFamily: 'monospace', fontSize: 12, marginVertical: 2 },
  emptyBlock: { paddingTop: spacing(4), gap: spacing(1) },
  empty: { color: theme.textDim, textAlign: 'center', fontSize: 13 },
  allowedTitle: { color: theme.text, fontWeight: '700', marginTop: spacing(2) },
  allowedText: { color: theme.textDim, fontFamily: 'monospace', fontSize: 11 },
  candidatesBlock: {
    marginHorizontal: spacing(2),
    marginBottom: spacing(1),
    padding: spacing(1.5),
    backgroundColor: theme.surfaceAlt,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.warning,
    gap: 2,
    // Blok ne kadar aday olursa olsun ekranın yarısını geçmesin — altındaki
    // log listesi de görünür kalmalı.
    maxHeight: '55%',
  },
  candidateScroll: { marginTop: spacing(1) },
  selectionSummary: {
    color: theme.text,
    fontFamily: 'monospace',
    fontSize: 11,
    marginTop: 4,
  },
  candidateLine: { color: theme.textDim, fontFamily: 'monospace', fontSize: 10 },
  candidateRow: {
    paddingVertical: spacing(1),
    borderTopWidth: 1,
    borderTopColor: theme.border,
    gap: 6,
  },
  candidateActions: { flexDirection: 'row', gap: spacing(1) },
  chip: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 6,
    paddingVertical: 4,
    paddingHorizontal: spacing(1),
  },
  chipActive: { backgroundColor: theme.accent, borderColor: theme.accent },
  chipText: { color: theme.textDim, fontSize: 11, fontWeight: '600' },
  chipTextActive: { color: '#06201D' },
  manualConnectButton: { marginTop: spacing(1.5), borderColor: theme.accent },
  errorText: { color: theme.danger, fontSize: 12, marginTop: spacing(1) },
});
