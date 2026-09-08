import React, { useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
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
  const vitalTrends = useAppStore((s) => s.vitalTrends);
  const loadVitalTrends = useAppStore((s) => s.loadVitalTrends);

  /**
   * Trendler bağlantı gerektirmiyor — geçmiş kayıtlardan geliyorlar.
   * Ekran her açıldığında tazeleniyor ki yeni biten bir kayıt hemen görünsün.
   */
  useFocusEffect(
    useCallback(() => {
      void loadVitalTrends();
    }, [loadVitalTrends]),
  );

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

  /**
   * Butonların NEDEN öyle davrandığını anlatan tek satır.
   *
   * Üçü de aynı soruya cevap verdiği ve birbirini dışladığı için tek yerde
   * toplandı; ayrı ayrı dururken ekranın ortasında birbirinden kopuk
   * duruyorlardı. Yeri de eylem çubuğunun dibi: açıkladığı şey orada.
   */
  const statusLine = notConnected
    ? 'Not linked. Open Link and connect to the adapter.'
    : !anyRead
      ? 'No codes read yet.'
      : null;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <VehicleChrome subtitle="readonly" />

      <View style={styles.body}>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <TrendSection trends={vitalTrends} />

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

          {/*
            Esneyen boşluk. Ekran boşken aşağıdaki iki blok dibe, eylem
            çubuğunun hemen üstüne iner; kod listesi uzunken boşluk sıfıra
            iner ve bloklar listenin sonunda kalır.

            Alternatif, ikisini de çubuğun üstüne SABİTLEMEKTİ. Öyle
            yapılmadı: uyarı üç satır ve her zaman görünse kod listesinden
            kalıcı olarak yer çalardı, oysa okunması gereken tek an
            başlangıçtaki boş ekran.
          */}
          <View style={{ flex: 1, minHeight: space(4) }} />

          {statusLine ? <Text style={[type.meta, styles.hint]}>{statusLine}</Text> : null}

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


/**
 * Kayan ölçümler — arıza lambası yanmadan önceki hâl.
 *
 * Faults ekranında duruyor çünkü bu ekranın sorusu "arabamda bir sorun var
 * mı?". Arıza kodu o sorunun geç cevabı; kayan bir vital erken cevabı.
 * Bağlantı da gerekmiyor: veriler geçmiş kayıtlardan geliyor, araca
 * takılı olmasan da okunuyor.
 *
 * Kasıtlı olarak SESSİZ: taban çizgisi kurulmamış ölçümler ve sabit
 * duranlar tek satırda özetleniyor. Ekranı dolduran bir liste, içindeki
 * tek gerçek uyarıyı gizler.
 */
function TrendSection({
  trends,
}: {
  trends: ReturnType<typeof useAppStore.getState>['vitalTrends'];
}) {
  if (trends.length === 0) {
    return (
      <View style={{ marginBottom: space(5) }}>
        <SectionRule label="Trends" meta="Nothing recorded yet" />
        <Note>
          Most of these readings come out of ordinary recordings on their own — a cold start, a
          wait at a red light, a steady stretch of road are all the app needs. The guided cycle
          from Live sets those conditions deliberately and is the only way to reach the oxygen
          sensor ones. After a few recordings this section starts showing which are moving.
        </Note>
      </View>
    );
  }

  const drifting = trends.filter((t) => t.trend.verdict === 'drifting');
  const quiet = trends.length - drifting.length;

  return (
    <View style={{ marginBottom: space(5) }}>
      <SectionRule
        label="Trends"
        meta={drifting.length > 0 ? `${drifting.length} moving` : `${trends.length} steady`}
        metaColor={drifting.length > 0 ? color.caution : undefined}
      />

      {drifting.map((t) => (
        <View key={t.key} style={styles.trendRow}>
          <View style={[styles.trendBar, { backgroundColor: color.caution }]} />
          <View style={{ flex: 1 }}>
            <Text style={type.metaSmall}>{t.label}</Text>
            <Text style={[type.prose, { color: color.ink, marginTop: space(0.75) }]}>
              {`${t.value.toFixed(2)} ${t.unit}`}
            </Text>
            <Text style={[type.meta, { marginTop: space(1), lineHeight: 16 }]}>
              {`Baseline ${(t.trend.baseline ?? 0).toFixed(2)} ${t.unit}, now ${t.value.toFixed(2)} — ` +
                `${(t.trend.change ?? 0) > 0 ? 'up' : 'down'} ${Math.abs(t.trend.change ?? 0).toFixed(2)}` +
                (t.trend.slopePerMonth !== null && Number.isFinite(t.trend.slopePerMonth)
                  ? `, about ${t.trend.slopePerMonth.toFixed(2)} ${t.unit} per month.`
                  : '.')}
            </Text>
          </View>
        </View>
      ))}

      {quiet > 0 ? (
        <Text style={[type.metaSmall, { marginTop: space(2) }]}>
          {`${quiet} other measurement${quiet === 1 ? '' : 's'} steady or still building a baseline.`}
        </Text>
      ) : null}

      <Note>
        Trends compare this car against its own earlier readings taken under the same conditions,
        not against other cars, and they do not predict when something will fail.
      </Note>
    </View>
  );
}

const styles = StyleSheet.create({
  trendRow: { flexDirection: 'row', gap: space(2.5), paddingVertical: space(2.5) },
  trendBar: { width: 2, alignSelf: 'stretch' },
  safe: { flex: 1, backgroundColor: color.ground },
  body: { flex: 1, paddingHorizontal: space(5), paddingTop: space(4) },
  // flexGrow: içerik kısa olsa bile kaydırma alanı ekranı doldursun —
  // yukarıdaki esneyen boşluğun çalışması buna bağlı.
  scroll: { flexGrow: 1, paddingBottom: space(5) },
  headlineRow: { flexDirection: 'row', gap: space(3.5), alignItems: 'stretch' },
  headlineBar: { width: 3 },
  hint: { textAlign: 'center', marginBottom: space(1) },
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
