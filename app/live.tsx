import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppStore, ALL_PIDS } from '../src/state/store';
import { getPidDefinition } from '../src/obd/pids';
import { getChannel } from '../src/data/channels';
import { deriveLive, type DerivedReading } from '../src/analysis/live';
import { VehicleChrome } from '../src/ui/VehicleChrome';
import {
  Frame,
  Label,
  Measure,
  Sparkline,
  StatusDot,
  PrimaryAction,
  Rule,
  SectionRule,
  Note,
} from '../src/ui/primitives';
import { color, type, space, hairlineWidth } from '../src/ui/theme';

/**
 * Canlı ekran.
 *
 * Tasarım kuralı: "Bir sayı ekranın sahibidir. İkincil kanallar görünür bir
 * ızgarada eşit hücrelerdir, her birinin altında iz. Hiçbiri dolu kart değil."
 *
 * Hangi kanalın hero olacağı kullanıcının seçtiği ilk kanaldır — sürüşte
 * bakılan şey kişiye göre değişir (biri devir, biri su sıcaklığı izler).
 */
export default function LiveScreen() {
  const connectionState = useAppStore((s) => s.connectionState);
  const selectedPids = useAppStore((s) => s.selectedPids);
  const liveSeries = useAppStore((s) => s.liveSeries);
  const isRecording = useAppStore((s) => s.isRecording);
  const sampleRate = useAppStore((s) => s.sampleRate);
  const startRecording = useAppStore((s) => s.startRecording);
  const stopRecording = useAppStore((s) => s.stopRecording);
  const togglePid = useAppStore((s) => s.togglePid);
  const isPidSupported = useAppStore((s) => s.isPidSupported);

  const [picking, setPicking] = useState(false);

  const notConnected = connectionState !== 'connected';
  const heroKey = selectedPids[0];
  const cellKeys = selectedPids.slice(1);

  if (picking) {
    return (
      <ChannelPicker
        selected={selectedPids}
        isSupported={isPidSupported}
        onToggle={togglePid}
        onDone={() => setPicking(false)}
      />
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <VehicleChrome />

      <View style={styles.body}>
        <View style={styles.topRow}>
          <View style={styles.rateRow}>
            <Text
              style={[
                type.cellValue,
                { fontSize: 22, lineHeight: 22 },
                !isRecording && { color: color.muted },
              ]}
            >
              {isRecording ? sampleRate.toFixed(1) : '·'}
            </Text>
            <Label small>samples/s</Label>
          </View>

          <Pressable
            style={[styles.recordChip, isRecording && { borderColor: color.alert }]}
            onPress={() => (isRecording ? stopRecording() : startRecording())}
            disabled={notConnected}
          >
            <StatusDot
              text={isRecording ? 'Recording' : 'Record'}
              tint={isRecording ? color.alert : color.chrome}
            />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          {notConnected && (
            <Text style={[type.meta, styles.hint]}>
              Not linked. Open Link and connect to the adapter.
            </Text>
          )}

          {selectedPids.length === 0 && (
            <Text style={[type.meta, styles.hint]}>No channels selected.</Text>
          )}

          {heroKey && <HeroChannel channelKey={heroKey} series={liveSeries[heroKey] ?? []} />}

          <View style={styles.grid}>
            {cellKeys.map((key) => (
              <CellChannel key={key} channelKey={key} series={liveSeries[key] ?? []} />
            ))}
          </View>

          <DerivedSection series={liveSeries} />
        </ScrollView>

        <View style={styles.footer}>
          <Rule strong />
          <Pressable style={styles.footerRow} onPress={() => setPicking(true)}>
            <Label small>{`${selectedPids.length} of ${ALL_PIDS.length} channels`}</Label>
            <Text style={styles.chooseLink}>Choose channels</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

/** Ekranın sahibi olan kanal. */
function HeroChannel({
  channelKey,
  series,
}: {
  channelKey: string;
  series: readonly { ts: number; value: number }[];
}) {
  const channel = getChannel(channelKey);
  const pid = getPidDefinition(channelKey);
  const latest = series.length > 0 ? series[series.length - 1].value : null;

  return (
    <Frame style={styles.heroFrame} cornerTint="rgba(241,235,221,0.5)">
      <View style={styles.cellHead}>
        <Label>{channel?.name ?? channelKey}</Label>
        {pid ? <Text style={type.metaSmall}>{`PID 01${pid.pid}`}</Text> : null}
      </View>
      <Measure hero value={latest === null ? null : formatValue(latest)} unit={channel?.unit ?? ''} />
      <Sparkline points={series} height={40} tint={color.linked} />
    </Frame>
  );
}

/** Izgaradaki ikincil kanal hücresi. */
function CellChannel({
  channelKey,
  series,
}: {
  channelKey: string;
  series: readonly { ts: number; value: number }[];
}) {
  const channel = getChannel(channelKey);
  const latest = series.length > 0 ? series[series.length - 1].value : null;

  return (
    <Frame style={styles.cell}>
      <Label small>{channel?.short ?? channelKey}</Label>
      <Measure value={latest === null ? null : formatValue(latest)} unit={channel?.unit ?? ''} />
      <Sparkline points={series} height={20} />
    </Frame>
  );
}

/**
 * Türetilmiş ölçümler — tek bir PID'in söyleyemeyeceği şeyler.
 *
 * Hesaplanamayanlar gizlenmiyor: hangi kanalı açması gerektiği yazıyor.
 * "—" gösterip kullanıcıyı tahmine bırakmak, ölçüm aletinde en kötü davranış.
 */
function DerivedSection({ series }: { series: Record<string, readonly { ts: number; value: number }[]> }) {
  const readings = deriveLive(series);
  const available = readings.filter((r) => r.value !== null);
  const blocked = readings.filter((r) => r.value === null);

  return (
    <View style={{ marginTop: space(2) }}>
      <SectionRule label="Derived" meta={`${available.length} of ${readings.length}`} />

      {available.map((r) => (
        <DerivedRow key={r.key} reading={r} />
      ))}

      {blocked.length > 0 && (
        <Note>
          {blocked
            .map((r) => `${r.name} needs ${[...new Set(r.missing)].join(' + ')}`)
            .join('. ')}
          {'. Enable those channels to compute them.'}
        </Note>
      )}
    </View>
  );
}

function DerivedRow({ reading }: { reading: DerivedReading }) {
  return (
    <View style={styles.derivedRow}>
      <View style={{ flex: 1 }}>
        <Text style={[type.prose, { color: color.ink }]}>{reading.name}</Text>
      </View>
      <View style={styles.derivedValue}>
        <Text style={[type.cellValue, { fontSize: 22, lineHeight: 24 }]}>
          {formatValue(reading.value!)}
        </Text>
        <Text style={type.unitSmall}>{reading.unit}</Text>
      </View>
    </View>
  );
}

/** Kanal seçimi — Live'ı kalabalıklaştırmamak için ayrı bir yüzey. */
function ChannelPicker({
  selected,
  isSupported,
  onToggle,
  onDone,
}: {
  selected: readonly string[];
  isSupported: (pid: string) => boolean;
  onToggle: (pid: string) => void;
  onDone: () => void;
}) {
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <VehicleChrome />
      <View style={styles.body}>
        <View style={{ marginBottom: space(3) }}>
          <Label>Channels</Label>
          <Text style={[type.meta, { marginTop: space(1.5), lineHeight: 16 }]}>
            One PID at a time on the K-line bus — fewer channels, faster sampling. The first
            selected channel owns the Live screen.
          </Text>
        </View>

        <ScrollView showsVerticalScrollIndicator={false}>
          {ALL_PIDS.map((pid) => {
            const on = selected.includes(pid.pid);
            const supported = isSupported(pid.pid);
            const order = selected.indexOf(pid.pid);
            return (
              <Pressable
                key={pid.pid}
                style={[styles.pickRow, !supported && styles.pickDisabled]}
                onPress={() => supported && onToggle(pid.pid)}
                disabled={!supported}
              >
                <View style={styles.pickMark}>
                  {on ? (
                    <Text style={[type.status, { color: color.ink, fontSize: 12 }]}>
                      {order === 0 ? '★' : String(order + 1)}
                    </Text>
                  ) : null}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[type.prose, { color: on ? color.ink : color.chrome }]}>
                    {pid.name}
                  </Text>
                  <Text style={type.metaSmall}>
                    {`01${pid.pid} · ${pid.unit}${supported ? '' : ' · not supported'}`}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>

        <PrimaryAction label="Done" onPress={onDone} style={{ marginTop: space(3) }} />
      </View>
    </SafeAreaView>
  );
}

function formatValue(v: number): string {
  if (Math.abs(v) >= 100) return String(Math.round(v));
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.ground },
  body: { flex: 1, paddingHorizontal: space(5), paddingTop: space(4) },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: space(4),
  },
  rateRow: { flexDirection: 'row', alignItems: 'baseline', gap: space(1.5) },
  recordChip: {
    borderWidth: hairlineWidth,
    borderColor: color.hairlineStrong,
    paddingHorizontal: space(4),
    minHeight: 44,
    justifyContent: 'center',
  },
  scroll: { paddingBottom: space(4), gap: space(4) },
  hint: { textAlign: 'center', marginTop: space(6) },
  heroFrame: { paddingBottom: space(1) },
  cellHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space(3.5) },
  cell: { width: '47%', paddingHorizontal: space(3.5), paddingVertical: space(3) },
  footer: { paddingBottom: space(2) },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: space(3),
    minHeight: 44,
  },
  chooseLink: {
    fontFamily: 'BarlowCondensed_600SemiBold',
    fontSize: 13,
    letterSpacing: 1.8,
    textTransform: 'uppercase',
    color: color.ink,
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.chrome,
    paddingBottom: 2,
  },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
    paddingVertical: space(3),
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.hairlineFaint,
    minHeight: 44,
  },
  pickDisabled: { opacity: 0.35 },
  derivedRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space(3),
    paddingVertical: space(2.5),
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.hairlineFaint,
  },
  derivedValue: { flexDirection: 'row', alignItems: 'baseline', gap: space(1.5) },
  pickMark: {
    width: 22,
    height: 22,
    borderWidth: hairlineWidth,
    borderColor: color.hairlineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
