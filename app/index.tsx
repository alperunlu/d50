import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppStore } from '../src/state/store';
import { VehicleChrome } from '../src/ui/VehicleChrome';
import { SectionRule, PrimaryAction, GhostAction, Note, Label, Frame, Measure } from '../src/ui/primitives';
import {
  formatTyreSize,
  rollingCircumferenceMm,
  revsPerKm,
  sameTyreSize,
  TYRE_OPTIONS,
} from '../src/analysis/tyre';
import type { TyreSize } from '../src/analysis/vehicle';
import { decodeVin } from '../src/obd/vin';
import { describeSpl, MIN_SPL_CALIBRATION_DB, MAX_SPL_CALIBRATION_DB } from '../src/analysis/spl';
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


  const vehicle = useAppStore((s) => s.vehicle);
  const tyreError = useAppStore((s) => s.tyreError);
  const setFittedTyre = useAppStore((s) => s.setFittedTyre);
  const [tyreOpen, setTyreOpen] = useState(false);

  const soundMeterOn = useAppStore((s) => s.soundMeterOn);
  const soundNow = useAppStore((s) => s.soundNow);
  const soundMin = useAppStore((s) => s.soundMin);
  const soundMax = useAppStore((s) => s.soundMax);
  const soundAvg = useAppStore((s) => s.soundAvg);
  const soundError = useAppStore((s) => s.soundError);
  const splCalibrationDb = useAppStore((s) => s.splCalibrationDb);
  const startSoundMeter = useAppStore((s) => s.startSoundMeter);
  const stopSoundMeter = useAppStore((s) => s.stopSoundMeter);
  const resetSoundStats = useAppStore((s) => s.resetSoundStats);
  const setSplCalibration = useAppStore((s) => s.setSplCalibration);

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
            {/*
              VIN burada duruyor çünkü bu ekranın işi "neye bağlıyım"
              sorusunu cevaplamak, ve VIN o cevabın en kesin parçası:
              adaptör markası değişebilir, araba değişmez.

              Okunamadığında satır GİZLENMİYOR, "not available" yazıyor.
              Boş bırakmak "bir sorun var" hissi verir; oysa 2003 model bir
              aracın Mode 09'u desteklememesi normal ve bilinmesi gereken
              bir şey — raporun neden varsayıma dayandığını o açıklıyor.
            */}
            <Fact
              label="VIN"
              value={initResult.vin ?? 'not available from this ECU'}
            />
            {initResult.vin ? (
              <Fact label="From the VIN" value={vinSummary(initResult.vin)} />
            ) : null}
          </View>
        )}

        {connectError ? (
          <View style={{ marginTop: space(4) }}>
            <Text style={[type.prose, { color: color.caution }]}>{connectError}</Text>
          </View>
        ) : null}

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

        {/*
          Buraya taşındı (eskiden Live ekranındaydı) çünkü kalibrasyon canlı
          geri bildirim istiyor: elindeki referans metreye bakıp +/- ile
          sayı eşleşene kadar nudge ediyorsun. Sayı ile düğmeler aynı ekranda
          olmalı, yoksa her dokunuşta iki ekran arası gidip gelmen gerekirdi.

          OBD'den de BAĞIMSIZ: adaptöre bağlanmadan, kayıt başlatmadan
          çalışır — "kabinde şu an ne kadar gürültü var" sorusunun aracın
          ECU'suyla ilgisi yok. Bu yüzden bir kurulum işi olarak Link'te
          duruyor, tıpkı lastik ebadı gibi.

          Live ekranındaki `mic_db` kartı artık BUNDAN bağımsız: kayıt
          sırasında SensorLogger'ın kendi mikrofon dinleyicisinden besleniyor.
        */}
        <View style={{ marginTop: space(6) }}>
          <SoundMeter
            on={soundMeterOn}
            now={soundNow}
            min={soundMin}
            max={soundMax}
            avg={soundAvg}
            error={soundError}
            calibration={splCalibrationDb}
            onStart={() => void startSoundMeter()}
            onStop={stopSoundMeter}
            onReset={resetSoundStats}
            onCalibrate={(delta) => void setSplCalibration(splCalibrationDb + delta)}
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
        ) : selectedDeviceId ? (
          <PrimaryAction label="Connect" onPress={() => void connect()} style={{ flex: 1 }} />
        ) : null}
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

/**
 * VIN'den okunabilen kadarını tek satıra sıkıştırır.
 *
 * Kasıtlı olarak az: model yılı ve üretici VIN'in yapısından gelir ve
 * doğrudur. Model, motor, donanım gelmez — onlar üreticinin çözüm
 * tablosunda ve elimizde o tablo yok. Bilmediğini yazmayan bir satır,
 * tahmin eden bir satırdan iyidir.
 */
function vinSummary(vin: string): string {
  const info = decodeVin(vin);
  if (!info) return '—';
  const parts = [info.manufacturer, info.modelYear ? `model year ${info.modelYear}` : null];
  const known = parts.filter((p): p is string => p !== null);
  return known.length > 0 ? known.join(' · ') : `WMI ${info.wmi}`;
}

/**
 * Gürültü ölçer — dB(A).
 *
 * OBD'den bağımsız: adaptör bağlı olmasa da çalışıyor, çünkü "kabinde ne
 * kadar gürültü var" sorusunun aracın ECU'suyla ilgisi yok. Ölçüm ayrı
 * bir uygulama gerektirmesin diye Link ekranına, kurulum işlerinin
 * yanına kondu (bkz. Tyres bölümü — aynı gerekçe).
 *
 * Anlık değerin yanında MIN/ORT/MAKS de gösteriliyor: gürültü sürekli
 * dalgalanır, tek bir anlık sayı ("73") aslında hiçbir şey söylemez.
 * Bir desibelmetreyi kullanılabilir kılan, bir süre boyunca tutulan
 * bu üç değerdir.
 */
function SoundMeter({
  on,
  now,
  min,
  max,
  avg,
  error,
  calibration,
  onStart,
  onStop,
  onReset,
  onCalibrate,
}: {
  on: boolean;
  now: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
  error: string | null;
  calibration: number;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
  onCalibrate: (delta: number) => void;
}) {
  return (
    <View>
      <SectionRule
        label="Microphone"
        meta={on ? 'Measuring' : 'Off'}
        metaColor={on ? color.linked : undefined}
      />

      <Frame style={styles.soundFrame} cornerTint="rgba(241,235,221,0.5)">
        <Measure hero value={now === null ? null : now.toFixed(1)} unit="dB(A)" />
        <Text style={[type.meta, { marginTop: space(1) }]}>
          {now === null ? 'Not measuring' : describeSpl(now)}
        </Text>

        <View style={styles.soundStats}>
          <SoundStat label="Min" value={min} />
          <SoundStat label="Avg" value={avg} />
          <SoundStat label="Max" value={max} />
        </View>
      </Frame>

      <View style={styles.soundActions}>
        {on ? (
          <GhostAction label="Stop" onPress={onStop} style={{ flex: 1 }} />
        ) : (
          <PrimaryAction label="Measure" onPress={onStart} style={{ flex: 1 }} />
        )}
        <GhostAction label="Reset" onPress={onReset} style={{ flex: 1 }} />
      </View>

      {/*
        Kalibrasyon: telefon mikrofonu kalibre bir ölçüm cihazı değil, o yüzden
        mutlak doğruluk ancak bilinen bir referansla eşitlenerek sağlanır.
        Ticari desibelmetre uygulamalarının yaptığı da budur.
      */}
      <View style={styles.calibrationRow}>
        <View style={{ flex: 1 }}>
          <Label small>Calibration</Label>
          <Text style={[type.metaSmall, { marginTop: space(0.75), lineHeight: 14 }]}>
            {`0 dBFS = ${calibration} dB SPL. Put a meter you trust next to the phone and nudge until they agree.`}
          </Text>
        </View>
        <Pressable
          style={styles.calButton}
          onPress={() => onCalibrate(-1)}
          disabled={calibration <= MIN_SPL_CALIBRATION_DB}
        >
          <Text style={[type.status, { color: color.ink, fontSize: 15 }]}>−</Text>
        </Pressable>
        <Pressable
          style={styles.calButton}
          onPress={() => onCalibrate(1)}
          disabled={calibration >= MAX_SPL_CALIBRATION_DB}
        >
          <Text style={[type.status, { color: color.ink, fontSize: 15 }]}>+</Text>
        </Pressable>
      </View>

      {error ? (
        <Text style={[type.meta, { color: color.caution, marginTop: space(2) }]}>{error}</Text>
      ) : null}
    </View>
  );
}

function SoundStat({ label, value }: { label: string; value: number | null }) {
  return (
    <View style={{ flex: 1 }}>
      <Label small>{label}</Label>
      <Text style={[type.cellValue, { fontSize: 18, lineHeight: 20, marginTop: space(0.5) }]}>
        {value === null ? '·' : value.toFixed(1)}
      </Text>
    </View>
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
  soundFrame: { paddingBottom: space(2), marginTop: space(1) },
  soundStats: {
    flexDirection: 'row',
    gap: space(3),
    marginTop: space(3),
    paddingTop: space(2.5),
    borderTopWidth: hairlineWidth,
    borderTopColor: color.hairlineFaint,
  },
  soundActions: { flexDirection: 'row', gap: space(3), marginTop: space(3) },
  calibrationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(2.5),
    marginTop: space(3),
  },
  calButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: hairlineWidth,
    borderColor: color.hairlineStrong,
    backgroundColor: color.groundAlt,
  },
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
