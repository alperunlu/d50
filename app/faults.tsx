import React, { useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppStore } from '../src/state/store';
import { writeAndShare } from '../src/util/exportFile';
import { isManufacturerSpecific, type Dtc, type ReadinessStatus } from '../src/obd/dtc';
import { MINI_R50_DTC_COUNT } from '../src/obd/dtcMini';
import { VehicleChrome } from '../src/ui/VehicleChrome';
import { SectionRule, Tag, PrimaryAction, GhostAction, Note } from '../src/ui/primitives';
import { color, type, space, hairlineWidth } from '../src/ui/theme';

/**
 * Arıza kodu ekranı — SADECE OKUMA.
 *
 * Tasarım kuralı: "Kod manşettir. Mode grupları iç içe kutular değil, kural
 * üstündeki kenar etiketleridir. Şiddet, kırmızı dolgudan değil konumdan ve
 * hairline etiketten okunur."
 *
 * Hiçbir "sil/temizle" eylemi yok ve olmayacak: Mode 04 allowlist tarafından
 * engelleniyor, bu ekranda da karşılığı bulunmuyor.
 */
export default function FaultsScreen() {
  const connectionState = useAppStore((s) => s.connectionState);
  const dtcGroups = useAppStore((s) => s.dtcGroups);
  const milStatus = useAppStore((s) => s.milStatus);
  const readiness = useAppStore((s) => s.readiness);
  const dtcReading = useAppStore((s) => s.dtcReading);
  const readDtcs = useAppStore((s) => s.readDtcs);

  const notConnected = connectionState !== 'connected';

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

  const stored = dtcGroups?.stored ?? [];
  const pending = dtcGroups?.pending ?? [];
  const permanent = dtcGroups?.permanent ?? [];
  const anyRead = dtcGroups !== null;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <VehicleChrome subtitle="readonly" />

      <View style={styles.body}>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          {milStatus && (
            <View style={styles.headlineRow}>
              <View
                style={[
                  styles.headlineBar,
                  { backgroundColor: milStatus.milOn ? color.alert : color.linked },
                ]}
              />
              <View style={{ flex: 1 }}>
                <Text style={type.headline}>
                  {milStatus.milOn ? 'Check engine on' : 'No active fault'}
                </Text>
                <Text style={[type.prose, { color: color.chrome, marginTop: space(1.5) }]}>
                  {`ECU reports ${milStatus.dtcCount} stored code${milStatus.dtcCount === 1 ? '' : 's'}` +
                    (pending.length > 0 ? `, ${pending.length} pending` : '')}
                </Text>
              </View>
            </View>
          )}

          {notConnected && (
            <Text style={[type.meta, styles.hint]}>
              Not linked. Open Link and connect to the adapter.
            </Text>
          )}

          {!anyRead && !notConnected && (
            <Text style={[type.meta, styles.hint]}>No codes read yet.</Text>
          )}

          {stored.length > 0 && (
            <CodeGroup label="Stored" meta="Mode 03 · turns the light on" codes={stored} primary />
          )}
          {pending.length > 0 && (
            <CodeGroup label="Pending" meta="Mode 07 · seen once, unconfirmed" codes={pending} />
          )}
          {permanent.length > 0 && (
            <CodeGroup label="Permanent" meta="Mode 0A · cannot be cleared" codes={permanent} />
          )}

          {anyRead && stored.length + pending.length + permanent.length === 0 && (
            <Text style={[type.prose, { color: color.linked, marginTop: space(4) }]}>
              No fault codes stored.
            </Text>
          )}

          {readiness && <Readiness readiness={readiness} />}

          <Note>
            {`${MINI_R50_DTC_COUNT} R50 service codes loaded, including P1xxx manufacturer codes. This app only reads — Mode 04 is blocked at the command allowlist, so no clear command can reach the car.`}
          </Note>
        </ScrollView>

        <View style={styles.actions}>
          {dtcReading ? (
            <View style={styles.loading}>
              <ActivityIndicator color={color.ink} />
            </View>
          ) : (
            <>
              {notConnected ? (
                <GhostAction
                  label={anyRead ? 'Re-read' : 'Read'}
                  onPress={() => void readDtcs()}
                  disabled
                        style={{ flex: 1 }}
                />
              ) : (
                <PrimaryAction
                  label={anyRead ? 'Re-read' : 'Read'}
                  onPress={() => void readDtcs()}
                  style={{ flex: 1 }}
                />
              )}
              <GhostAction
                label="Share"
                onPress={handleShare}
                disabled={notConnected}
                style={{ flex: 1 }}
              />
            </>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

/** Bir mod grubunun kodları. Grup bir kutu değil, kural + kenar etiketi. */
function CodeGroup({
  label,
  meta,
  codes,
  primary,
}: {
  label: string;
  meta: string;
  codes: readonly Dtc[];
  primary?: boolean;
}) {
  return (
    <View style={{ marginTop: space(5) }}>
      <SectionRule label={label} meta={meta} />
      {codes.map((d) => (
        <CodeRow key={`${d.kind}-${d.code}`} dtc={d} dim={!primary} />
      ))}
    </View>
  );
}

function CodeRow({ dtc, dim }: { dtc: Dtc; dim?: boolean }) {
  const ink = dim ? color.chrome : color.ink;
  const tag = tagFor(dtc);

  return (
    <View style={styles.codeRow}>
      <View style={styles.codeHead}>
        <Text style={[type.codeValue, { color: ink }]}>{dtc.code}</Text>
        {tag ? <Tag text={tag.text} tint={tag.tint} /> : null}
      </View>
      <Text style={[type.prose, { color: ink, marginTop: space(1.75) }]}>
        {dtc.description ??
          (isManufacturerSpecific(dtc.code)
            ? 'Manufacturer-specific — no description available'
            : 'No description available')}
      </Text>
      {(dtc.vehicleSpecific || dtc.miniFaultCode) && (
        <Text style={[type.meta, { marginTop: space(1.25) }]}>
          {[
            dtc.miniFaultCode ? `MINI fault code ${dtc.miniFaultCode}` : null,
            dtc.vehicleSpecific ? 'R50 service data' : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      )}
    </View>
  );
}

/**
 * Kodun konusuna göre kısa etiket. Amber yalnızca karışım/emisyon gibi
 * "dikkat" konularında; geri kalanı krom. Kırmızı burada hiç kullanılmıyor —
 * kırmızı MIL'e ait.
 */
function tagFor(dtc: Dtc): { text: string; tint: string } | null {
  const c = dtc.code.toUpperCase();
  if (/^P01(7|3)/.test(c)) return { text: 'Mixture', tint: color.caution };
  if (/^P03/.test(c)) return { text: 'Misfire', tint: color.caution };
  if (/^P04(4|5)/.test(c)) return { text: 'Evap', tint: color.chrome };
  if (/^P042/.test(c)) return { text: 'Catalyst', tint: color.caution };
  if (isManufacturerSpecific(c)) return { text: 'MINI', tint: color.chrome };
  return null;
}

function Readiness({ readiness }: { readiness: ReadinessStatus }) {
  const all = [...readiness.continuous, ...readiness.nonContinuous].filter((m) => m.supported);
  const ready = all.filter((m) => m.complete);
  const notReady = all.filter((m) => !m.complete);

  return (
    <View style={{ marginTop: space(5) }}>
      <SectionRule
        label="Emissions readiness"
        meta={readiness.allComplete ? 'Ready' : 'Not ready'}
        metaColor={readiness.allComplete ? color.linked : color.caution}
      />
      <View style={{ marginTop: space(3), gap: space(1.5) }}>
        {ready.length > 0 && (
          <View style={styles.readyRow}>
            <View style={[styles.readyDot, { backgroundColor: color.linked }]} />
            <Text style={[type.prose, { flex: 1 }]}>{ready.map((m) => m.name).join(' · ')}</Text>
          </View>
        )}
        {notReady.length > 0 && (
          <View style={styles.readyRow}>
            <View style={[styles.readyDot, { backgroundColor: color.caution }]} />
            <Text style={[type.prose, { flex: 1 }]}>{notReady.map((m) => m.name).join(' · ')}</Text>
            <Text style={[type.status, { fontSize: 11, color: color.caution }]}>Incomplete</Text>
          </View>
        )}
      </View>
      {!readiness.allComplete && (
        <Note>Not ready is not a fault — the test has not run yet. Inspections still reject it.</Note>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.ground },
  body: { flex: 1, paddingHorizontal: space(5), paddingTop: space(4) },
  scroll: { paddingBottom: space(5) },
  headlineRow: { flexDirection: 'row', gap: space(3.5), alignItems: 'stretch' },
  headlineBar: { width: 3 },
  hint: { textAlign: 'center', marginTop: space(6) },
  codeRow: {
    paddingVertical: space(2.75),
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.hairlineFaint,
  },
  codeHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  readyRow: { flexDirection: 'row', alignItems: 'center', gap: space(2.25) },
  readyDot: { width: 5, height: 5 },
  actions: { flexDirection: 'row', gap: space(3), paddingVertical: space(3) },
  loading: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
});
