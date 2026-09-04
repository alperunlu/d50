import React from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppStore, ALL_PIDS } from '../src/state/store';
import { theme, spacing } from '../src/ui/theme';

export default function ConnectScreen() {
  const connectionState = useAppStore((s) => s.connectionState);
  const initResult = useAppStore((s) => s.initResult);
  const connectError = useAppStore((s) => s.connectError);
  const bleProfileLabel = useAppStore((s) => s.bleProfileLabel);
  const selectedPids = useAppStore((s) => s.selectedPids);
  const togglePid = useAppStore((s) => s.togglePid);
  const isPidSupported = useAppStore((s) => s.isPidSupported);
  const connect = useAppStore((s) => s.connect);
  const disconnect = useAppStore((s) => s.disconnect);

  const sensorsEnabled = useAppStore((s) => s.sensorsEnabled);
  const sensorStatus = useAppStore((s) => s.sensorStatus);
  const setSensorsEnabled = useAppStore((s) => s.setSensorsEnabled);

  const scanning = useAppStore((s) => s.scanning);
  const scanResults = useAppStore((s) => s.scanResults);
  const selectedDeviceId = useAppStore((s) => s.selectedDeviceId);
  const selectedDeviceName = useAppStore((s) => s.selectedDeviceName);
  const startScan = useAppStore((s) => s.startScan);
  const stopScan = useAppStore((s) => s.stopScan);
  const selectDevice = useAppStore((s) => s.selectDevice);

  const isBusy = connectionState === 'connecting';
  const isConnected = connectionState === 'connected';
  const isDisconnected = connectionState === 'disconnected';

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.container}>
        {isDisconnected && (
          <View style={styles.statusCard}>
            <View style={styles.statusRow}>
              <Text style={styles.statusText}>
                {selectedDeviceName ?? selectedDeviceId ?? 'No device selected'}
              </Text>
            </View>
            <Pressable
              style={styles.buttonSecondary}
              onPress={() => (scanning ? stopScan() : startScan())}
            >
              <Text style={styles.buttonText}>{scanning ? 'Stop Scan' : 'Scan for Devices'}</Text>
            </Pressable>
            {scanResults.map((d) => (
              <Pressable
                key={d.id}
                style={[styles.deviceRow, selectedDeviceId === d.id && styles.deviceRowSelected]}
                onPress={() => selectDevice(d)}
              >
                <Text style={styles.deviceName}>{d.name ?? '(unnamed device)'}</Text>
                <Text style={styles.deviceMeta}>
                  {d.id} · RSSI {d.rssi ?? '—'}
                </Text>
              </Pressable>
            ))}
            {scanning && scanResults.length === 0 && (
              <Text style={styles.hint}>Scanning… Ignition must be on and the adapter plugged in.</Text>
            )}
          </View>
        )}

        <View style={styles.statusCard}>
          <View style={styles.statusRow}>
            <StatusDot state={connectionState} />
            <Text style={styles.statusText}>{statusLabel(connectionState)}</Text>
          </View>

          {initResult && (
            <View style={styles.infoBlock}>
              <InfoLine label="Adapter" value={initResult.adapterInfo} />
              <InfoLine label="Protocol #" value={initResult.protocolNumber} />
              {bleProfileLabel && <InfoLine label="GATT profile" value={bleProfileLabel} />}
              {/*
                Soru: "araç hangi PID'leri destekliyor, nasıl bileceğiz?"
                Cevap: aracın kendisi söylüyor — 0100/0120/0140 bitmask'leri.
                Katalogdaki PID'lerden kaçının desteklendiğini burada gösteriyoruz;
                desteklenmeyenler aşağıdaki listede zaten pasif görünüyor.
              */}
              <InfoLine
                label="Supported PIDs"
                value={`${ALL_PIDS.filter((p) => isPidSupported(p.pid)).length} / ${ALL_PIDS.length}`}
              />
            </View>
          )}

          {connectError && <Text style={styles.errorText}>{connectError}</Text>}

          <Pressable
            style={[styles.button, isConnected && styles.buttonDanger]}
            onPress={() => (isConnected ? disconnect() : connect())}
            disabled={isBusy || (!selectedDeviceId && isDisconnected)}
          >
            {isBusy ? (
              <ActivityIndicator color={theme.text} />
            ) : (
              <Text style={styles.buttonText}>{isConnected ? 'Disconnect' : 'Connect'}</Text>
            )}
          </Pressable>
        </View>

        <View style={styles.statusCard}>
          <Text style={styles.sectionTitle}>Phone sensors</Text>
          <Text style={styles.sectionHint}>
            GPS speed, altitude and acceleration are logged alongside OBD data — they enable
            0-100 timing, grade-corrected power estimates and speedometer error.
          </Text>
          <Pressable
            style={[styles.buttonSecondary, sensorsEnabled && styles.sensorOn]}
            onPress={() => setSensorsEnabled(!sensorsEnabled)}
          >
            <Text style={styles.buttonText}>
              {sensorsEnabled ? '✓ Sensors enabled' : 'Enable phone sensors'}
            </Text>
          </Pressable>
          {sensorStatus && <Text style={styles.sectionHint}>{sensorStatus}</Text>}
        </View>

        <Text style={styles.sectionTitle}>Values to Log</Text>
        <Text style={styles.sectionHint}>
          Only one PID can be queried at a time on the K-line bus — fewer PIDs means a faster sample rate.
        </Text>

        <View style={styles.pidList}>
          {ALL_PIDS.map((pid) => {
            const selected = selectedPids.includes(pid.pid);
            const supported = isPidSupported(pid.pid);
            return (
              <Pressable
                key={pid.pid}
                style={[styles.pidRow, selected && styles.pidRowSelected, !supported && styles.pidRowDisabled]}
                onPress={() => supported && togglePid(pid.pid)}
                disabled={!supported}
              >
                <View style={[styles.checkbox, selected && styles.checkboxChecked]} />
                <View style={styles.pidTextBlock}>
                  <Text style={styles.pidName}>{pid.name}</Text>
                  <Text style={styles.pidMeta}>
                    Mode 01 · {pid.pid} · {pid.unit}
                    {!supported ? ' · not supported by vehicle' : ''}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function StatusDot({ state }: { state: string }) {
  const color =
    state === 'connected' ? theme.ok : state === 'error' ? theme.danger : state === 'connecting' ? theme.warning : theme.textDim;
  return <View style={[styles.dot, { backgroundColor: color }]} />;
}

function statusLabel(state: string): string {
  switch (state) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting…';
    case 'error':
      return 'Error';
    default:
      return 'Not connected';
  }
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoLine}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  container: { padding: spacing(2), gap: spacing(2) },
  buttonSecondary: {
    backgroundColor: theme.surfaceAlt,
    borderRadius: 8,
    paddingVertical: spacing(1),
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.border,
  },
  deviceRow: {
    backgroundColor: theme.surfaceAlt,
    borderRadius: 8,
    padding: spacing(1),
    marginTop: spacing(1),
    borderWidth: 1,
    borderColor: theme.border,
  },
  deviceRowSelected: { borderColor: theme.accent },
  deviceName: { color: theme.text, fontSize: 14, fontWeight: '600' },
  deviceMeta: { color: theme.textDim, fontSize: 11, marginTop: 2 },
  hint: { color: theme.textDim, fontSize: 12, marginTop: spacing(1), textAlign: 'center' },
  sensorOn: { borderColor: theme.accent, backgroundColor: theme.surface },
  statusCard: {
    backgroundColor: theme.surface,
    borderRadius: 12,
    padding: spacing(2),
    borderWidth: 1,
    borderColor: theme.border,
    gap: spacing(1.5),
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing(1) },
  dot: { width: 10, height: 10, borderRadius: 5 },
  statusText: { color: theme.text, fontSize: 16, fontWeight: '600' },
  infoBlock: { gap: 4 },
  infoLine: { flexDirection: 'row', justifyContent: 'space-between' },
  infoLabel: { color: theme.textDim, fontSize: 13 },
  infoValue: { color: theme.text, fontSize: 13 },
  errorText: { color: theme.danger, fontSize: 13 },
  button: {
    backgroundColor: theme.accent,
    borderRadius: 8,
    paddingVertical: spacing(1.5),
    alignItems: 'center',
  },
  buttonDanger: { backgroundColor: theme.danger },
  buttonText: { color: '#06201D', fontWeight: '700', fontSize: 15 },
  sectionTitle: { color: theme.text, fontSize: 16, fontWeight: '700', marginTop: spacing(1) },
  sectionHint: { color: theme.textDim, fontSize: 12, marginTop: -4 },
  pidList: { gap: spacing(1) },
  pidRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(1.5),
    backgroundColor: theme.surface,
    borderRadius: 10,
    padding: spacing(1.5),
    borderWidth: 1,
    borderColor: theme.border,
  },
  pidRowSelected: { borderColor: theme.accent },
  pidRowDisabled: { opacity: 0.4 },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: theme.textDim,
  },
  checkboxChecked: { backgroundColor: theme.accent, borderColor: theme.accent },
  pidTextBlock: { flex: 1 },
  pidName: { color: theme.text, fontSize: 15, fontWeight: '600' },
  pidMeta: { color: theme.textDim, fontSize: 12, marginTop: 2 },
});
