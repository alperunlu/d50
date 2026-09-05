import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import * as repo from '../src/db/repo';
import { writeAndShare } from '../src/util/exportFile';
import { toWideCsv } from '../src/db/csv';
import { channelsForKeys, getChannel } from '../src/data/channels';
import { summarizeTrip, groupSeries, type TripSummary } from '../src/analysis/derived';
import type { Session } from '../src/db/types';
import { VehicleChrome } from '../src/ui/VehicleChrome';
import { SectionRule, Rule } from '../src/ui/primitives';
import { color, type, space, hairlineWidth } from '../src/ui/theme';

/** Trips — kaydedilmiş oturumlar, özetleri ve dışa aktarımları. */
export default function TripsScreen() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [summaries, setSummaries] = useState<Record<number, TripSummary>>({});
  const [openId, setOpenId] = useState<number | null>(null);

  const reload = useCallback(async () => {
    setSessions(await repo.listSessions());
  }, []);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Özet DB'de saklanmaz, her açılışta örneklerden hesaplanır. Metrik
   * formülleri geliştikçe eski oturumlar da yeni analizden faydalansın diye.
   */
  const analyze = useCallback(async (session: Session) => {
    setBusyId(session.id);
    try {
      const samples = await repo.readSamples(session.id);
      setSummaries((prev) => ({ ...prev, [session.id]: summarizeTrip(groupSeries(samples)) }));
    } catch (e) {
      Alert.alert('Analysis failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, []);

  const exportCsv = useCallback(async (session: Session) => {
    setBusyId(session.id);
    try {
      const samples = await repo.readSamples(session.id);
      const csv = toWideCsv(samples, channelsForKeys(session.pids));
      const { uri, shared } = await writeAndShare(
        `obd_session_${session.id}_${session.startedAt}.csv`,
        csv,
        'text/csv',
        'Share session',
      );
      if (!shared) Alert.alert('Sharing unavailable', `File saved: ${uri}`);
    } catch (e) {
      Alert.alert('Export failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, []);

  const exportLog = useCallback(async (session: Session) => {
    setBusyId(session.id);
    try {
      const rows = await repo.readSessionLogs(session.id);
      if (rows.length === 0) {
        Alert.alert('No log', 'This session has no stored adapter log.');
        return;
      }
      const text = rows
        .map((r) => `${new Date(r.ts).toISOString()} [${r.direction}] ${r.text}`)
        .join('\n');
      const { uri, shared } = await writeAndShare(
        `obd_session_${session.id}_${session.startedAt}_log.txt`,
        text,
        'text/plain',
        'Share session log',
      );
      if (!shared) Alert.alert('Sharing unavailable', `File saved: ${uri}`);
    } catch (e) {
      Alert.alert('Export failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, []);

  const remove = useCallback(
    (session: Session) => {
      Alert.alert('Delete trip?', 'This cannot be undone.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await repo.deleteSession(session.id);
            await reload();
          },
        },
      ]);
    },
    [reload],
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <VehicleChrome />
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <SectionRule label="Trips" meta={`${sessions.length} recorded`} />

        {sessions.length === 0 && (
          <Text style={[type.meta, { marginTop: space(6), textAlign: 'center' }]}>
            No recorded trips yet.
          </Text>
        )}

        {sessions.map((s) => {
          const open = openId === s.id;
          const started = new Date(s.startedAt);
          const durationSec = s.endedAt ? Math.round((s.endedAt - s.startedAt) / 1000) : null;
          const summary = summaries[s.id];
          const busy = busyId === s.id;

          return (
            <View key={s.id} style={styles.trip}>
              <Pressable
                style={styles.tripHead}
                onPress={() => {
                  setOpenId(open ? null : s.id);
                  if (!open && !summary) void analyze(s);
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[type.prose, { color: color.ink }]}>
                    {started.toLocaleString()}
                  </Text>
                  <Text style={[type.metaSmall, { marginTop: space(1) }]}>
                    {`${durationSec !== null ? `${durationSec} s` : 'incomplete'} · ${s.pids.length} channels`}
                  </Text>
                </View>
                <Text style={[type.status, { color: color.chrome, fontSize: 12 }]}>
                  {open ? 'Close' : 'Open'}
                </Text>
              </Pressable>

              {open && (
                <View style={styles.tripBody}>
                  <Text style={[type.metaSmall, { marginBottom: space(2.5) }]}>
                    {s.pids.map((p) => getChannel(p)?.name ?? p).join(' · ')}
                  </Text>

                  {busy && <Text style={type.meta}>Working…</Text>}

                  {summary && <SummaryGrid summary={summary} />}

                  <Rule style={{ marginTop: space(3) }} />
                  <View style={styles.tripActions}>
                    <TripAction label="CSV" onPress={() => void exportCsv(s)} disabled={busy} />
                    <TripAction label="Log" onPress={() => void exportLog(s)} disabled={busy} />
                    <TripAction label="Delete" onPress={() => remove(s)} tint={color.alert} />
                  </View>
                </View>
              )}
            </View>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

function TripAction({
  label,
  onPress,
  disabled,
  tint = color.ink,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tint?: string;
}) {
  return (
    <Pressable style={styles.tripActionBtn} onPress={onPress} disabled={disabled}>
      <Text style={[type.status, { fontSize: 13, color: disabled ? color.muted : tint }]}>
        {label}
      </Text>
    </Pressable>
  );
}

function SummaryGrid({ summary }: { summary: TripSummary }) {
  const rows: [string, string][] = [
    ['Max speed', fmt(summary.maxSpeedKmh, 'km/h', 0)],
    ['Avg speed', fmt(summary.avgSpeedKmh, 'km/h', 0)],
    ['Idle', fmt(summary.idlePercent, '%', 0)],
    ['0-100', fmt(summary.zeroToHundredSec, 's', 2)],
    ['Warm-up', fmt(summary.warmupSec, 's', 0)],
    ['Peak power', fmt(summary.maxPowerKw, 'kW', 1)],
    ['Consumption', fmt(summary.avgFuelPer100Km, 'L/100km', 1)],
    ['Harsh events', String(summary.harshEventCount)],
    ['Volumetric eff.', fmt(summary.medianVolumetricEfficiency, '%', 0)],
    ['Speedo error', fmt(summary.speedometerErrorPct, '%', 1)],
    ['Idle stability', fmt(summary.idleRpmStdDev, 'rpm σ', 0)],
    [
      'Fuel trim',
      summary.fuelTrim
        ? `${summary.fuelTrim.total > 0 ? '+' : ''}${summary.fuelTrim.total.toFixed(1)} % ${summary.fuelTrim.verdict}`
        : '—',
    ],
  ];
  return (
    <View>
      {rows.map(([label, value]) => (
        <View key={label} style={styles.summaryRow}>
          <Text style={type.metaSmall}>{label}</Text>
          <Text style={[type.cellValue, { fontSize: 15, lineHeight: 18 }]}>{value}</Text>
        </View>
      ))}
      <Text style={[type.metaSmall, { marginTop: space(2), lineHeight: 14 }]}>
        Power and consumption are estimates from vehicle mass and air mass flow, not dyno
        measurements. “—” could not be computed from this trip.
      </Text>
    </View>
  );
}

/** Hesaplanamayanı sıfır göstermek yanıltıcı olurdu. */
function fmt(value: number | null, unit: string, digits: number): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)} ${unit}`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.ground },
  body: { paddingHorizontal: space(5), paddingTop: space(4), paddingBottom: space(5) },
  trip: { borderBottomWidth: hairlineWidth, borderBottomColor: color.hairlineFaint },
  tripHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
    paddingVertical: space(3.5),
    minHeight: 44,
  },
  tripBody: { paddingBottom: space(4) },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingVertical: space(1.5),
  },
  tripActions: { flexDirection: 'row', gap: space(6), paddingTop: space(3) },
  tripActionBtn: { minHeight: 44, justifyContent: 'center' },
});
