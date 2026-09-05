import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppStore } from '../src/state/store';
import { VehicleChrome } from '../src/ui/VehicleChrome';
import { SectionRule, PrimaryAction, GhostAction, Note, Label } from '../src/ui/primitives';
import {
  formatTyreSize,
  rollingCircumferenceMm,
  revsPerKm,
  sameTyreSize,
  TYRE_OPTIONS,
} from '../src/analysis/tyre';
import type { TyreSize } from '../src/analysis/vehicle';
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

  const selectedSensorChannels = useAppStore((s) => s.selectedSensorChannels);
  const sensorStatus = useAppStore((s) => s.sensorStatus);

  const vehicle = useAppStore((s) => s.vehicle);
  const tyreError = useAppStore((s) => s.tyreError);
  const setFittedTyre = useAppStore((s) => s.setFittedTyre);
  const [tyreOpen, setTyreOpen] = useState(false);

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
            meta={
              selectedSensorChannels.length > 0
                ? `${selectedSensorChannels.length} selected`
                : 'None selected'
            }
            metaColor={selectedSensorChannels.length > 0 ? color.linked : undefined}
          />
          <Note>
            GPS, accelerometer and microphone are logged alongside OBD data — they enable 0-100
            timing, grade-corrected power, speedometer error and the sound-based checks. Pick them
            in Live → Choose channels, next to the OBD channels.
          </Note>
          {sensorStatus ? (
            <Text style={[type.metaSmall, { marginTop: space(2) }]}>{sensorStatus}</Text>
          ) : null}
        </View>

        {/*
          Lastik ebadı bir "tercih" değil ÖLÇÜM PARAMETRESİ: ECU hızı fabrika
          lastiğine göre hesaplıyor, dolayısıyla mesafe ve tüketim dahil ondan
          türeyen her şey buna bağlı. O yüzden ayarlar ekranına gömülmedi,
          bağlantı ekranında görünür duruyor.

          Seçim listeden yapılıyor, elle yazılmıyor: yanlış yazılmış bir ebat
          bütün mesafe ve tüketim rakamlarını sessizce kaydırırdı. Listede her
          seçeneğin fabrika ebadına göre sapması da yazıyor — kullanıcı
          seçtiği şeyin okumaları ne kadar değiştireceğini o anda görüyor.
        */}
        <View style={{ marginTop: space(6) }}>
          <SectionRule label="Tyres" meta={formatTyreSize(vehicle.fittedTyre)} />
          <Note>
            The ECU computes speed from wheel revolutions using the factory size
            ({formatTyreSize(vehicle.factoryTyre)}). Telling the app what is actually fitted
            corrects speed and distance, and unlocks the drive-ratio and rolling-circumference
            checks.
          </Note>

          <Pressable style={styles.tyreSelect} onPress={() => setTyreOpen((v) => !v)}>
            <View style={{ flex: 1 }}>
              <Text style={[type.prose, { color: color.ink }]}>
                {formatTyreSize(vehicle.fittedTyre)}
              </Text>
              <Text style={[type.metaSmall, { marginTop: space(0.75) }]}>
                {`${Math.round(rollingCircumferenceMm(vehicle.fittedTyre))} mm rolling circumference · ${Math.round(revsPerKm(vehicle.fittedTyre))} revs/km`}
              </Text>
            </View>
            <Text style={[type.status, { color: color.chrome, fontSize: 12 }]}>
              {tyreOpen ? 'Close' : 'Change'}
            </Text>
          </Pressable>

          {tyreOpen && (
            <View style={styles.tyreList}>
              {TYRE_OPTIONS.map((option) => (
                <TyreOption
                  key={formatTyreSize(option)}
                  option={option}
                  factory={vehicle.factoryTyre}
                  selected={sameTyreSize(option, vehicle.fittedTyre)}
                  onPick={() => {
                    void setFittedTyre(option);
                    setTyreOpen(false);
                  }}
                />
              ))}
            </View>
          )}

          {tyreError ? (
            <Text style={[type.meta, { color: color.caution, marginTop: space(2) }]}>
              {tyreError}
            </Text>
          ) : null}
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

/**
 * Listedeki tek bir ebat.
 *
 * Fabrika ebadına göre sapma yüzdesi burada gösteriliyor çünkü seçimin
 * sonucu tam olarak bu: ECU'nun hız ve mesafe okumasının ne kadar kayacağı.
 * Fabrika ebadı ayrıca etiketleniyor ki "hangisi orijinaldi" sorusu
 * kullanıcıda kalmasın.
 */
function TyreOption({
  option,
  factory,
  selected,
  onPick,
}: {
  option: TyreSize;
  factory: TyreSize;
  selected: boolean;
  onPick: () => void;
}) {
  const deviation =
    (rollingCircumferenceMm(option) / rollingCircumferenceMm(factory) - 1) * 100;
  const isFactory = sameTyreSize(option, factory);

  return (
    <Pressable style={styles.tyreOption} onPress={onPick}>
      <View style={styles.pickMark}>{selected ? <View style={styles.pickMarkFill} /> : null}</View>
      <View style={{ flex: 1 }}>
        <Text style={[type.prose, { color: selected ? color.ink : color.chrome }]}>
          {formatTyreSize(option)}
        </Text>
        <Text style={type.metaSmall}>
          {`${Math.round(rollingCircumferenceMm(option))} mm${isFactory ? ' · factory size' : ''}`}
        </Text>
      </View>
      <Text
        style={[
          type.metaSmall,
          { color: Math.abs(deviation) < 0.5 ? color.muted : color.caution },
        ]}
      >
        {`${deviation > 0 ? '+' : ''}${deviation.toFixed(1)} %`}
      </Text>
    </Pressable>
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
  tyreSelect: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
    marginTop: space(3),
    minHeight: 48,
    paddingHorizontal: space(3),
    paddingVertical: space(2),
    borderWidth: hairlineWidth,
    borderColor: color.hairlineStrong,
    backgroundColor: color.groundAlt,
  },
  tyreList: { marginTop: space(1) },
  tyreOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
    paddingVertical: space(2.5),
    paddingHorizontal: space(3),
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.hairlineFaint,
    minHeight: 44,
  },
  actions: { flexDirection: 'row', gap: space(3), paddingHorizontal: space(5), paddingVertical: space(3) },
  loading: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', gap: space(1.5) },
});
