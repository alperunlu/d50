import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, FlatList, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import * as repo from '../src/db/repo';
import { writeAndShare } from '../src/util/exportFile';
import { toWideCsv } from '../src/db/csv';
import { channelsForKeys, getChannel } from '../src/data/channels';
import { summarizeTrip, groupSeries, type TripSummary } from '../src/analysis/derived';
import type { Session } from '../src/db/types';
import { theme, spacing } from '../src/ui/theme';

export default function SessionsScreen() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [summaries, setSummaries] = useState<Record<number, TripSummary>>({});

  /**
   * Oturum özeti (0-100, ısınma süresi, tahmini güç...) örnekler üzerinden
   * hesaplanır — DB'de saklanmaz. Hesap saf ve hızlı; saklamak yerine
   * yeniden hesaplamak, metrik formülleri geliştikçe eski oturumların da
   * yeni analizden faydalanmasını sağlıyor.
   */
  const handleAnalyze = useCallback(async (session: Session) => {
    setBusyId(session.id);
    try {
      const samples = await repo.readSamples(session.id);
      const summary = summarizeTrip(groupSeries(samples));
      setSummaries((prev) => ({ ...prev, [session.id]: summary }));
    } catch (e) {
      Alert.alert('Analysis failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, []);

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

  const handleExport = useCallback(async (session: Session) => {
    setBusyId(session.id);
    try {
      const samples = await repo.readSamples(session.id);
      const csv = toWideCsv(samples, channelsForKeys(session.pids));

      const fileName = `obd_session_${session.id}_${session.startedAt}.csv`;
      const { uri, shared } = await writeAndShare(fileName, csv, 'text/csv', 'Share session');
      if (!shared) {
        Alert.alert('Sharing unavailable', `File saved: ${uri}`);
      }
    } catch (e) {
      Alert.alert('Export failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, []);

  const handleExportLog = useCallback(async (session: Session) => {
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
      const fileName = `obd_session_${session.id}_${session.startedAt}_log.txt`;
      const { uri, shared } = await writeAndShare(fileName, text, 'text/plain', 'Share session log');
      if (!shared) Alert.alert('Sharing unavailable', `File saved: ${uri}`);
    } catch (e) {
      Alert.alert('Export failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, []);

  const handleDelete = useCallback(
    (session: Session) => {
      Alert.alert('Delete session?', 'This cannot be undone.', [
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
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <FlatList
        data={sessions}
        keyExtractor={(s) => String(s.id)}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<Text style={styles.empty}>No recorded sessions yet.</Text>}
        renderItem={({ item }) => (
          <SessionCard
            session={item}
            busy={busyId === item.id}
            onExport={() => handleExport(item)}
            onExportLog={() => handleExportLog(item)}
            onAnalyze={() => handleAnalyze(item)}
            summary={summaries[item.id]}
            onDelete={() => handleDelete(item)}
          />
        )}
      />
    </SafeAreaView>
  );
}

function SessionCard({
  session,
  busy,
  onExport,
  onExportLog,
  onAnalyze,
  summary,
  onDelete,
}: {
  session: Session;
  busy: boolean;
  onExport: () => void;
  onExportLog: () => void;
  onAnalyze: () => void;
  summary: TripSummary | undefined;
  onDelete: () => void;
}) {
  const started = new Date(session.startedAt);
  const durationSec = session.endedAt
    ? Math.round((session.endedAt - session.startedAt) / 1000)
    : null;

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{started.toLocaleString()}</Text>
      <Text style={styles.cardMeta}>
        {session.pids.map((p) => getChannel(p)?.name ?? p).join(', ')}
      </Text>
      <Text style={styles.cardMeta}>
        {durationSec !== null ? `${durationSec} s` : 'in progress / incomplete'}
      </Text>
      <View style={styles.cardActions}>
        <Pressable style={styles.actionButton} onPress={onExport} disabled={busy}>
          <Text style={styles.actionButtonText}>{busy ? 'Preparing…' : 'CSV'}</Text>
        </Pressable>
        <Pressable style={styles.actionButton} onPress={onExportLog} disabled={busy}>
          <Text style={styles.actionButtonText}>Log</Text>
        </Pressable>
        <Pressable style={[styles.actionButton, styles.deleteButton]} onPress={onDelete}>
          <Text style={styles.actionButtonText}>Delete</Text>
        </Pressable>
      </View>

      <Pressable style={styles.analyzeButton} onPress={onAnalyze} disabled={busy}>
        <Text style={styles.actionButtonText}>{summary ? 'Re-analyze' : 'Analyze trip'}</Text>
      </Pressable>

      {summary && <TripSummaryView summary={summary} />}
    </View>
  );
}

function TripSummaryView({ summary }: { summary: TripSummary }) {
  const rows: [string, string][] = [
    ['Max speed', fmt(summary.maxSpeedKmh, 'km/h', 0)],
    ['Avg speed', fmt(summary.avgSpeedKmh, 'km/h', 0)],
    ['Idle time', fmt(summary.idlePercent, '%', 0)],
    ['0-100 km/h', fmt(summary.zeroToHundredSec, 's', 2)],
    ['Warm-up to 88°C', fmt(summary.warmupSec, 's', 0)],
    ['Peak wheel power', fmt(summary.maxPowerKw, 'kW', 1)],
    ['Avg consumption', fmt(summary.avgFuelPer100Km, 'L/100km', 1)],
    ['Harsh events', String(summary.harshEventCount)],
  ];
  return (
    <View style={styles.summaryBox}>
      {rows.map(([label, value]) => (
        <View key={label} style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>{label}</Text>
          <Text style={styles.summaryValue}>{value}</Text>
        </View>
      ))}
      <Text style={styles.summaryNote}>
        Power and consumption are estimates from vehicle mass and air mass flow, not dyno
        measurements. Values shown as “—” could not be computed from this session’s data.
      </Text>
    </View>
  );
}

/** Hesaplanamayan değeri sıfır gibi göstermek yanıltıcı olurdu — “—” yazıyoruz. */
function fmt(value: number | null, unit: string, digits: number): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)} ${unit}`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  list: { padding: spacing(2), gap: spacing(1.5) },
  empty: { color: theme.textDim, textAlign: 'center', marginTop: spacing(4) },
  card: {
    backgroundColor: theme.surface,
    borderRadius: 12,
    padding: spacing(1.5),
    borderWidth: 1,
    borderColor: theme.border,
    gap: 4,
    marginBottom: spacing(1.5),
  },
  cardTitle: { color: theme.text, fontSize: 15, fontWeight: '700' },
  cardMeta: { color: theme.textDim, fontSize: 12 },
  cardActions: { flexDirection: 'row', gap: spacing(1), marginTop: spacing(1) },
  actionButton: {
    flex: 1,
    backgroundColor: theme.surfaceAlt,
    borderRadius: 8,
    paddingVertical: spacing(1),
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.border,
  },
  deleteButton: { borderColor: theme.danger },
  actionButtonText: { color: theme.text, fontSize: 13, fontWeight: '600' },
  analyzeButton: {
    backgroundColor: theme.surfaceAlt,
    borderRadius: 8,
    paddingVertical: spacing(1),
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.accent,
    marginTop: spacing(1),
  },
  summaryBox: {
    marginTop: spacing(1),
    padding: spacing(1.5),
    backgroundColor: theme.surfaceAlt,
    borderRadius: 8,
    gap: 3,
  },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between' },
  summaryLabel: { color: theme.textDim, fontSize: 12 },
  summaryValue: { color: theme.text, fontSize: 12, fontFamily: 'monospace' },
  summaryNote: { color: theme.textDim, fontSize: 10, marginTop: spacing(1), lineHeight: 14 },
});
