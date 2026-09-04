import React, { useCallback } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppStore } from '../src/state/store';
import { writeAndShare } from '../src/util/exportFile';
import { isManufacturerSpecific, type Dtc } from '../src/obd/dtc';
import { MINI_R50_DTC_COUNT } from '../src/obd/dtcMini';
import { theme, spacing } from '../src/ui/theme';

/**
 * Arıza kodu ekranı — SADECE OKUMA.
 *
 * Bilerek hiçbir "sil/temizle" butonu yok ve olmayacak: Mode 04 allowlist
 * tarafından engelleniyor, bu ekranda da karşılığı bulunmuyor. Kod okumak
 * arızayı görmektir; silmek ECU hafızasını değiştirmektir.
 */
export default function FaultsScreen() {
  const connectionState = useAppStore((s) => s.connectionState);
  const dtcGroups = useAppStore((s) => s.dtcGroups);
  const milStatus = useAppStore((s) => s.milStatus);
  const readiness = useAppStore((s) => s.readiness);
  const dtcReading = useAppStore((s) => s.dtcReading);
  const readDtcs = useAppStore((s) => s.readDtcs);

  const notConnected = connectionState !== 'connected';

  const handleRead = useCallback(async () => {
    await readDtcs();
  }, [readDtcs]);

  const handleShare = useCallback(async () => {
    const report = await readDtcs();
    if (!report) return;
    try {
      const { uri, shared } = await writeAndShare(
        `obd_faults_${Date.now()}.txt`,
        report,
        'text/plain',
        'Share fault code report',
      );
      if (!shared) Alert.alert('Sharing unavailable', `File saved: ${uri}`);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : String(e));
    }
  }, [readDtcs]);

  const total = dtcGroups
    ? dtcGroups.stored.length + dtcGroups.pending.length + dtcGroups.permanent.length
    : 0;

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.container}>
        {milStatus && (
          <View style={[styles.milCard, milStatus.milOn ? styles.milOn : styles.milOff]}>
            <Text style={styles.milTitle}>
              {milStatus.milOn ? '⚠️  Check engine light is ON' : '✓  Check engine light is off'}
            </Text>
            <Text style={styles.milMeta}>{`ECU reports ${milStatus.dtcCount} stored code(s)`}</Text>
          </View>
        )}

        <Pressable style={styles.button} onPress={handleRead} disabled={notConnected || dtcReading}>
          {dtcReading ? (
            <ActivityIndicator color={theme.text} />
          ) : (
            <Text style={styles.buttonText}>Read fault codes</Text>
          )}
        </Pressable>

        <Pressable
          style={[styles.button, styles.buttonSecondary]}
          onPress={handleShare}
          disabled={notConnected || dtcReading}
        >
          <Text style={styles.buttonText}>Read & share report</Text>
        </Pressable>

        {notConnected && (
          <Text style={styles.hint}>Connect to the adapter from the “Connect” tab first.</Text>
        )}

        {dtcGroups && total === 0 && (
          <Text style={styles.noCodes}>No fault codes stored. </Text>
        )}

        {readiness && (
          <View style={styles.group}>
            <Text style={styles.groupTitle}>
              {`Emissions readiness: ${readiness.allComplete ? 'READY' : 'NOT READY'}`}
            </Text>
            <Text style={styles.groupSubtitle}>
              “Not ready” does not mean a fault — it means the test has not run yet (battery
              disconnected, codes cleared, or not enough driving). Inspections reject a car whose
              monitors are not ready.
            </Text>
            {[...readiness.continuous, ...readiness.nonContinuous]
              .filter((m) => m.supported)
              .map((m) => (
                <View key={m.name} style={styles.readinessRow}>
                  <Text style={styles.readinessName}>{m.name}</Text>
                  <Text style={[styles.readinessState, m.complete ? styles.ok : styles.notOk]}>
                    {m.complete ? 'ready' : 'not ready'}
                  </Text>
                </View>
              ))}
          </View>
        )}

        <DtcGroup title="Stored codes" subtitle="Mode 03 — these turn the light on" codes={dtcGroups?.stored} />
        <DtcGroup title="Pending codes" subtitle="Mode 07 — seen once, not yet confirmed" codes={dtcGroups?.pending} />
        <DtcGroup title="Permanent codes" subtitle="Mode 0A — cannot be cleared by any tool" codes={dtcGroups?.permanent} />

        <Text style={styles.readOnlyNote}>
          {`${MINI_R50_DTC_COUNT} MINI R50 specific codes loaded (including P1xxx manufacturer codes and MINI service fault-code numbers).`}
        </Text>

        <Text style={styles.readOnlyNote}>
          This app only reads fault codes. It never clears them — Mode 04 is blocked at the command
          allowlist, so no clear command can reach the car.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function DtcGroup({
  title,
  subtitle,
  codes,
}: {
  title: string;
  subtitle: string;
  codes: readonly Dtc[] | undefined;
}) {
  if (!codes || codes.length === 0) return null;
  return (
    <View style={styles.group}>
      <Text style={styles.groupTitle}>{`${title} (${codes.length})`}</Text>
      <Text style={styles.groupSubtitle}>{subtitle}</Text>
      {codes.map((d) => (
        <View key={`${d.kind}-${d.code}`} style={styles.codeRow}>
          <Text style={styles.code}>{d.code}</Text>
          <Text style={styles.codeDesc}>
            {d.description ??
              (isManufacturerSpecific(d.code)
                ? 'Manufacturer-specific code — no description available'
                : 'No description available')}
          </Text>
          {(d.miniFaultCode || d.vehicleSpecific) && (
            <Text style={styles.codeMeta}>
              {d.vehicleSpecific ? 'MINI R50 service data' : ''}
              {d.miniFaultCode ? `  ·  MINI fault code ${d.miniFaultCode}` : ''}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  container: { padding: spacing(2), gap: spacing(1.5) },
  milCard: { borderRadius: 12, padding: spacing(2), borderWidth: 1 },
  milOn: { backgroundColor: '#2A1618', borderColor: theme.danger },
  milOff: { backgroundColor: theme.surface, borderColor: theme.ok },
  milTitle: { color: theme.text, fontSize: 16, fontWeight: '700' },
  milMeta: { color: theme.textDim, fontSize: 12, marginTop: 4 },
  button: {
    backgroundColor: theme.accent,
    borderRadius: 8,
    paddingVertical: spacing(1.5),
    alignItems: 'center',
  },
  buttonSecondary: {
    backgroundColor: theme.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.border,
  },
  buttonText: { color: theme.text, fontWeight: '700', fontSize: 14 },
  hint: { color: theme.textDim, fontSize: 13, textAlign: 'center', marginTop: spacing(2) },
  noCodes: { color: theme.ok, fontSize: 14, textAlign: 'center', marginTop: spacing(2) },
  group: {
    backgroundColor: theme.surface,
    borderRadius: 12,
    padding: spacing(1.5),
    borderWidth: 1,
    borderColor: theme.border,
    gap: 4,
  },
  groupTitle: { color: theme.text, fontSize: 15, fontWeight: '700' },
  groupSubtitle: { color: theme.textDim, fontSize: 11, marginBottom: 4 },
  codeRow: {
    borderTopWidth: 1,
    borderTopColor: theme.border,
    paddingTop: spacing(1),
    marginTop: spacing(0.5),
  },
  code: { color: theme.accent, fontSize: 16, fontWeight: '700', fontFamily: 'monospace' },
  codeDesc: { color: theme.text, fontSize: 13, marginTop: 2 },
  codeMeta: { color: theme.textDim, fontSize: 11, marginTop: 2 },
  readinessRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
    borderTopWidth: 1,
    borderTopColor: theme.border,
  },
  readinessName: { color: theme.text, fontSize: 12 },
  readinessState: { fontSize: 12, fontWeight: '600' },
  ok: { color: theme.ok },
  notOk: { color: theme.warning },
  readOnlyNote: {
    color: theme.textDim,
    fontSize: 11,
    marginTop: spacing(2),
    lineHeight: 16,
  },
});
