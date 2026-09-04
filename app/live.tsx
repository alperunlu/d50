import React from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppStore } from '../src/state/store';
import { getPidDefinition } from '../src/obd/pids';
import { LineChart } from '../src/ui/LineChart';
import { theme, spacing } from '../src/ui/theme';

export default function LiveScreen() {
  const connectionState = useAppStore((s) => s.connectionState);
  const selectedPids = useAppStore((s) => s.selectedPids);
  const liveSeries = useAppStore((s) => s.liveSeries);
  const isRecording = useAppStore((s) => s.isRecording);
  const sampleRate = useAppStore((s) => s.sampleRate);
  const startRecording = useAppStore((s) => s.startRecording);
  const stopRecording = useAppStore((s) => s.stopRecording);

  const notConnected = connectionState !== 'connected';

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.headerRow}>
          <Text style={styles.rate}>
            {isRecording ? `~${sampleRate} samples/s` : 'Not recording'}
          </Text>
          <Pressable
            style={[styles.recordButton, isRecording && styles.recordButtonActive]}
            onPress={() => (isRecording ? stopRecording() : startRecording())}
            disabled={notConnected}
          >
            <Text style={styles.recordButtonText}>{isRecording ? 'Stop' : 'Record'}</Text>
          </Pressable>
        </View>

        {notConnected && (
          <Text style={styles.hint}>Connect to the adapter from the “Connect” tab first.</Text>
        )}

        {selectedPids.length === 0 && (
          <Text style={styles.hint}>Select at least one value from the “Connect” tab.</Text>
        )}

        {selectedPids.map((pidCode) => {
          const pid = getPidDefinition(pidCode);
          if (!pid) return null;
          const series = liveSeries[pidCode] ?? [];
          return (
            <View key={pidCode} style={styles.chartBlock}>
              <Text style={styles.chartTitle}>{pid.name}</Text>
              <LineChart points={series} unit={pid.unit} />
            </View>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  container: { padding: spacing(2), gap: spacing(2) },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rate: { color: theme.textDim, fontSize: 13 },
  recordButton: {
    backgroundColor: theme.accent,
    borderRadius: 8,
    paddingVertical: spacing(1),
    paddingHorizontal: spacing(2.5),
  },
  recordButtonActive: { backgroundColor: theme.danger },
  recordButtonText: { color: '#06201D', fontWeight: '700' },
  hint: { color: theme.textDim, fontSize: 13, textAlign: 'center', marginTop: spacing(2) },
  chartBlock: { gap: 6 },
  chartTitle: { color: theme.text, fontSize: 14, fontWeight: '600' },
});
