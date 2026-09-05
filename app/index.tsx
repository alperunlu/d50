import React from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppStore } from '../src/state/store';
import { VehicleChrome } from '../src/ui/VehicleChrome';
import { SectionRule, PrimaryAction, GhostAction, Note, Label } from '../src/ui/primitives';
import { color, type, space, hairlineWidth } from '../src/ui/theme';

/**
 * Link ekranı.
 *
 * Tasarım gerekçesi: araç künyesi artık her ekranda kalıcı olduğu için bu
 * ekran "sürekli bakılan bir sekme" olmaktan çıkıp yalnızca bağlantı
 * kurulmadığında ya da bozulduğunda açılan bir sayfaya dönüşüyor.
 */
export default function LinkScreen() {
  const connectionState = useAppStore((s) => s.connectionState);
  const initResult = useAppStore((s) => s.initResult);
  const connectError = useAppStore((s) => s.connectError);
  const bleProfileLabel = useAppStore((s) => s.bleProfileLabel);
  const connect = useAppStore((s) => s.connect);
  const disconnect = useAppStore((s) => s.disconnect);

  const scanning = useAppStore((s) => s.scanning);
  const scanResults = useAppStore((s) => s.scanResults);
  const selectedDeviceId = useAppStore((s) => s.selectedDeviceId);
  const selectedDeviceName = useAppStore((s) => s.selectedDeviceName);
  const startScan = useAppStore((s) => s.startScan);
  const stopScan = useAppStore((s) => s.stopScan);
  const selectDevice = useAppStore((s) => s.selectDevice);

  const sensorsEnabled = useAppStore((s) => s.sensorsEnabled);
  const sensorStatus = useAppStore((s) => s.sensorStatus);
  const setSensorsEnabled = useAppStore((s) => s.setSensorsEnabled);

  const busy = connectionState === 'connecting';
  const linked = connectionState === 'connected';

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <VehicleChrome />

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        {!linked && (
          <View>
            <SectionRule
              label="Adapter"
              meta={scanning ? 'Scanning' : `${scanResults.length} found`}
              metaColor={scanning ? color.caution : undefined}
            />

            <View style={styles.deviceList}>
              {scanResults.map((d) => {
                const on = selectedDeviceId === d.id;
                return (
                  <Pressable key={d.id} style={styles.deviceRow} onPress={() => selectDevice(d)}>
                    <View style={styles.pickMark}>
                      {on ? <View style={styles.pickMarkFill} /> : null}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[type.prose, { color: on ? color.ink : color.chrome }]}>
                        {d.name ?? 'Unnamed device'}
                      </Text>
                      <Text style={type.metaSmall}>{`RSSI ${d.rssi ?? '—'}`}</Text>
                    </View>
                  </Pressable>
                );
              })}

              {scanning && scanResults.length === 0 && (
                <Text style={[type.meta, { marginTop: space(3) }]}>
                  Ignition on, adapter plugged in.
                </Text>
              )}
            </View>

            {/*
              Hiç cihaz bulunmadıysa ekranın asıl eylemi taramaktır — dolu buton
              hiyerarşiyi tek başına kurar. Cihaz listelendiğinde asıl eylem
              aşağıdaki Connect'e geçer, tarama ikincile düşer.
            */}
            {scanResults.length === 0 && !scanning ? (
              <PrimaryAction
                label="Scan"
                onPress={() => startScan()}
                style={{ marginTop: space(3) }}
              />
            ) : (
              <GhostAction
                label={scanning ? 'Stop scan' : 'Scan again'}
                onPress={() => (scanning ? stopScan() : startScan())}
                style={{ marginTop: space(3) }}
              />
            )}
          </View>
        )}

        {linked && initResult && (
          <View>
            <SectionRule label="Session" />
            <Fact label="Adapter" value={initResult.adapterInfo} />
            {bleProfileLabel ? <Fact label="GATT profile" value={bleProfileLabel} /> : null}
            <Fact label="Device" value={selectedDeviceName ?? selectedDeviceId ?? '—'} />
          </View>
        )}

        {connectError ? (
          <View style={{ marginTop: space(4) }}>
            <Text style={[type.prose, { color: color.caution }]}>{connectError}</Text>
          </View>
        ) : null}

        <View style={{ marginTop: space(6) }}>
          <SectionRule
            label="Phone sensors"
            meta={sensorsEnabled ? 'On' : 'Off'}
            metaColor={sensorsEnabled ? color.linked : undefined}
          />
          <Note>
            GPS and accelerometer are logged alongside OBD data — they enable 0-100 timing,
            grade-corrected power and speedometer error.
          </Note>
          {sensorStatus ? (
            <Text style={[type.metaSmall, { marginTop: space(2) }]}>{sensorStatus}</Text>
          ) : null}
          <GhostAction
            label={sensorsEnabled ? 'Disable sensors' : 'Enable sensors'}
            onPress={() => void setSensorsEnabled(!sensorsEnabled)}
            tint={sensorsEnabled ? color.linked : color.hairlineStrong}
            textTint={sensorsEnabled ? color.linked : color.ink}
            style={{ marginTop: space(3) }}
          />
        </View>
      </ScrollView>

      <View style={styles.actions}>
        {busy ? (
          <View style={styles.loading}>
            <ActivityIndicator color={color.ink} />
            <Label small>Linking</Label>
          </View>
        ) : linked ? (
          <GhostAction label="Disconnect" onPress={() => void disconnect()} style={{ flex: 1 }} />
        ) : (
          selectedDeviceId ? (
            <PrimaryAction label="Connect" onPress={() => void connect()} style={{ flex: 1 }} />
          ) : (
            <GhostAction
              label="Select an adapter"
              onPress={() => {}}
              disabled
                style={{ flex: 1 }}
            />
          )
        )}
      </View>
    </SafeAreaView>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.factRow}>
      <Text style={type.metaSmall}>{label}</Text>
      <Text style={[type.prose, { flex: 1, textAlign: 'right' }]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.ground },
  body: { paddingHorizontal: space(5), paddingTop: space(4), paddingBottom: space(4) },
  deviceList: { marginTop: space(1) },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
    paddingVertical: space(3),
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.hairlineFaint,
    minHeight: 44,
  },
  pickMark: {
    width: 20,
    height: 20,
    borderWidth: hairlineWidth,
    borderColor: color.hairlineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickMarkFill: { width: 10, height: 10, backgroundColor: color.ink },
  factRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: space(4),
    paddingVertical: space(2.5),
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.hairlineFaint,
  },
  actions: { flexDirection: 'row', gap: space(3), paddingHorizontal: space(5), paddingVertical: space(3) },
  loading: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', gap: space(1.5) },
});
