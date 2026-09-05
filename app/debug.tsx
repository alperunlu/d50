import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, Pressable, FlatList, ScrollView, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Updates from 'expo-updates';
import { useAppStore } from '../src/state/store';
import { writeAndShare } from '../src/util/exportFile';
import { ALLOWED_COMMANDS_SUMMARY } from '../src/obd/allowlist';
import type { RawLogEntry } from '../src/state/store';
import type { ProfileCandidate } from '../src/ble/profiles';
import { VehicleChrome } from '../src/ui/VehicleChrome';
import { SectionRule, GhostAction, PrimaryAction, Note, Tag } from '../src/ui/primitives';
import { JS_BUILD_TAG } from '../src/ui/buildTag';
import { color, type, space, hairlineWidth } from '../src/ui/theme';

/**
 * Debug — adaptörle konuşulan her baytın ham dökümü.
 *
 * Arabaya çıkılan her ziyaretten azami bilgi çıkarmak için var: gönderilen
 * komut, gelen cevap, denenen GATT profilleri, hepsi zaman damgasıyla ve
 * .txt olarak paylaşılabilir.
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
  const [manualBusy, setManualBusy] = useState(false);
  const [showCommands, setShowCommands] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);

  /**
   * Elle güncelleme indirme. Arabada, uygulamayı iki kez kapatıp açmak yerine
   * tek dokunuşla en son JS sürümüne geçmeyi sağlıyor.
   */
  const checkUpdate = useCallback(async () => {
    if (!Updates.isEnabled) {
      Alert.alert('Development mode', 'OTA updates only work in a real build.');
      return;
    }
    setUpdateBusy(true);
    try {
      const check = await Updates.checkForUpdateAsync();
      if (!check.isAvailable) {
        Alert.alert('Up to date', 'Already running the latest version.');
        return;
      }
      await Updates.fetchUpdateAsync();
      Alert.alert('Update downloaded', 'The app will restart.', [
        { text: 'OK', onPress: () => void Updates.reloadAsync() },
      ]);
    } catch (e) {
      Alert.alert('Update failed', e instanceof Error ? e.message : String(e));
    } finally {
      setUpdateBusy(false);
    }
  }, []);

  const shareLog = useCallback(async () => {
    setBusy(true);
    try {
      const text = rawLog
        .map((e) => `${new Date(e.ts).toISOString()} [${e.direction}] ${e.text}`)
        .join('\n');
      const { uri, shared } = await writeAndShare(
        `obd_debug_${Date.now()}.txt`,
        text,
        'text/plain',
        'Share debug log',
      );
      if (!shared) Alert.alert('Sharing unavailable', `File saved: ${uri}`);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [rawLog]);

  const pidScan = useCallback(async () => {
    const report = await runPidScan();
    if (!report) return;
    try {
      const { uri, shared } = await writeAndShare(
        `obd_pid_scan_${Date.now()}.txt`,
        report,
        'text/plain',
        'Share PID scan',
      );
      if (!shared) Alert.alert('Sharing unavailable', `File saved: ${uri}`);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : String(e));
    }
  }, [runPidScan]);

  const manualConnect = useCallback(async () => {
    setManualBusy(true);
    try {
      await connectWithManualProfile();
    } finally {
      setManualBusy(false);
    }
  }, [connectWithManualProfile]);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <VehicleChrome />

      <View style={styles.body}>
        <ScrollView
          style={styles.upper}
          contentContainerStyle={{ paddingBottom: space(3) }}
          showsVerticalScrollIndicator={false}
        >
          <SectionRule label="Build" meta={Updates.isEmbeddedLaunch ? 'Embedded' : 'OTA'} />
          <View style={styles.buildRow}>
            <Text style={[type.status, { color: color.ink, fontSize: 14 }]}>{JS_BUILD_TAG}</Text>
            <Text style={type.metaSmall}>{Updates.runtimeVersion ?? '—'}</Text>
          </View>
          <GhostAction
            label={updateBusy ? 'Checking' : 'Check for update'}
            onPress={checkUpdate}
            disabled={updateBusy}
            style={{ marginTop: space(2.5) }}
          />

          {bleCandidates && bleCandidates.length > 0 && (
            <View style={{ marginTop: space(5) }}>
              <SectionRule label="Manual profile" meta="No automatic match" metaColor={color.caution} />
              <Text style={[type.metaSmall, { marginTop: space(2) }]}>
                {`Notify ${short(manualNotify)}   Write ${short(manualWrite)}`}
              </Text>
              <PrimaryAction
                label={manualBusy ? 'Connecting' : 'Connect with profile'}
                onPress={manualConnect}
                disabled={manualBusy || !manualNotify || !manualWrite}
                style={{ marginTop: space(2.5) }}
              />
              {connectError ? (
                <Text style={[type.meta, { color: color.caution, marginTop: space(2) }]}>
                  {connectError}
                </Text>
              ) : null}
              <View style={styles.candidateList}>
                {bleCandidates.map((c, i) => (
                  <CandidateRow
                    key={i}
                    candidate={c}
                    isNotify={same(manualNotify, c)}
                    isWrite={same(manualWrite, c)}
                    onNotify={() => pickManualNotify(c)}
                    onWrite={() => pickManualWrite(c)}
                  />
                ))}
              </View>
            </View>
          )}

          <View style={{ marginTop: space(5) }}>
            <SectionRule
              label="PID scan"
              meta={
                scanProgress
                  ? `${scanProgress.done}/${scanProgress.total}`
                  : scanRows
                    ? `${scanRows.filter((r) => r.answered).length}/${scanRows.length} answered`
                    : undefined
              }
            />
            <Note>
              Probes every PID the ECU claims and writes a report — the definitive answer to what
              this car actually supports.
            </Note>
            <GhostAction
              label={scanProgress ? `Scanning ${scanProgress.currentPid}` : 'Scan PIDs'}
              onPress={pidScan}
              disabled={connectionState !== 'connected' || scanProgress !== null}
                style={{ marginTop: space(3) }}
            />
          </View>

          <View style={{ marginTop: space(5) }}>
            <Pressable onPress={() => setShowCommands((v) => !v)}>
              <SectionRule label="Allowed commands" meta={showCommands ? 'Hide' : 'Show'} />
            </Pressable>
            {showCommands && (
              <Text style={[type.mono, { marginTop: space(2.5), lineHeight: 16 }]}>
                {ALLOWED_COMMANDS_SUMMARY}
              </Text>
            )}
          </View>
        </ScrollView>

        <View style={styles.logSection}>
          <SectionRule label="Traffic" meta={`${rawLog.length} lines`} />
          <FlatList
            style={styles.logList}
            data={[...rawLog].reverse()}
            keyExtractor={(item, i) => `${item.ts}-${i}`}
            inverted
            showsVerticalScrollIndicator={false}
            renderItem={({ item }) => <LogLine entry={item} />}
            ListEmptyComponent={
              <Text style={[type.meta, { paddingTop: space(4) }]}>
                No traffic yet. Connect from Link.
              </Text>
            }
          />
        </View>

        <View style={styles.actions}>
          <GhostAction
            label={busy ? 'Preparing' : 'Share log'}
            onPress={shareLog}
            disabled={busy || rawLog.length === 0}
            style={{ flex: 1 }}
          />
          <GhostAction
            label="Clear"
            onPress={clearLog}
            textTint={color.chrome}
            style={{ flex: 1 }}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

function LogLine({ entry }: { entry: RawLogEntry }) {
  const tint =
    entry.direction === 'error'
      ? color.alert
      : entry.direction === 'tx'
        ? color.linked
        : entry.direction === 'rx'
          ? color.ink
          : color.muted;
  const prefix =
    entry.direction === 'tx' ? '>' : entry.direction === 'rx' ? '<' : entry.direction === 'error' ? '!' : '·';
  return (
    <Text style={[type.mono, { color: tint, marginVertical: 1 }]}>
      {`${time(entry.ts)} ${prefix} ${entry.text}`}
    </Text>
  );
}

function CandidateRow({
  candidate,
  isNotify,
  isWrite,
  onNotify,
  onWrite,
}: {
  candidate: ProfileCandidate;
  isNotify: boolean;
  isWrite: boolean;
  onNotify: () => void;
  onWrite: () => void;
}) {
  return (
    <View style={styles.candidate}>
      <Text style={[type.mono, { fontSize: 10 }]}>
        {`${candidate.serviceUUID.split('-')[0]} / ${candidate.characteristicUUID.split('-')[0]}`}
      </Text>
      <View style={styles.candidateActions}>
        {candidate.isNotifiable && (
          <Pressable onPress={onNotify} style={styles.candidateBtn}>
            <Tag text={isNotify ? '✓ Notify' : 'Notify'} tint={isNotify ? color.ink : color.muted} />
          </Pressable>
        )}
        {candidate.isWritable && (
          <Pressable onPress={onWrite} style={styles.candidateBtn}>
            <Tag text={isWrite ? '✓ Write' : 'Write'} tint={isWrite ? color.ink : color.muted} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

function same(a: ProfileCandidate | null, b: ProfileCandidate): boolean {
  return !!a && a.serviceUUID === b.serviceUUID && a.characteristicUUID === b.characteristicUUID;
}

function short(c: ProfileCandidate | null): string {
  return c ? c.characteristicUUID.split('-')[0] : '—';
}

function time(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.ground },
  body: { flex: 1, paddingHorizontal: space(5), paddingTop: space(4) },
  upper: { maxHeight: '48%' },
  buildRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingTop: space(2.5),
  },
  candidateList: { marginTop: space(3) },
  candidate: {
    paddingVertical: space(2),
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.hairlineFaint,
    gap: space(1.5),
  },
  candidateActions: { flexDirection: 'row', gap: space(2) },
  candidateBtn: { minHeight: 32, justifyContent: 'center' },
  logSection: { flex: 1, marginTop: space(4) },
  logList: { flex: 1, marginTop: space(2) },
  actions: { flexDirection: 'row', gap: space(3), paddingVertical: space(3) },
});
