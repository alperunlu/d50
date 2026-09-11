import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Updates from 'expo-updates';
import { useAppStore } from '../src/state/store';
import type { RawLogEntry } from '../src/state/store';
import type { ProfileCandidate } from '../src/ble/profiles';
import { VehicleChrome } from '../src/ui/VehicleChrome';
import {
  SectionRule,
  PrimaryAction,
  GhostAction,
  Note,
  Label,
  Frame,
  Measure,
  Tag,
} from '../src/ui/primitives';
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
import { writeAndShare } from '../src/util/exportFile';
import { JS_BUILD_TAG } from '../src/ui/buildTag';
import { readLastCrash, clearLastCrash, type CrashRecord } from '../src/util/crashLog';
import { color, type, space, hairlineWidth } from '../src/ui/theme';

/**
 * Link ekranı.
 *
 * Tasarım gerekçesi: araç künyesi artık her ekranda kalıcı olduğu için bu
 * ekran "sürekli bakılan bir sekme" olmaktan çıkıp yalnızca bağlantı
 * kurulmadığında ya da bozulduğunda açılan bir sayfaya dönüşüyor.
 *
 * Debug sekmesinin bütün içeriği (sürüm, çökme kaydı, elle GATT profili,
 * PID taraması, ham trafik) buranın altına taşındı. Gerekçe iki tane:
 * alt barda altıncı sekmeye yer yoktu ve "Debug" etiketli bir sekme
 * yayınlanan bir uygulamada yanlış duruyordu. İçerik zaten bu ekranın
 * cevapladığı soruyla aynı soruyu cevaplıyor — "bağlantıda ne oluyor".
 * Sıralama bilinçli: her ziyarette bakılan şeyler üstte, yalnızca bir şey
 * ters gittiğinde bakılanlar altta.
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

  // --- Debug sekmesinden taşınan durum ---
  const rawLog = useAppStore((s) => s.rawLog);
  const clearLog = useAppStore((s) => s.clearLog);
  const bleCandidates = useAppStore((s) => s.bleCandidates);
  const manualNotify = useAppStore((s) => s.manualNotify);
  const manualWrite = useAppStore((s) => s.manualWrite);
  const pickManualNotify = useAppStore((s) => s.pickManualNotify);
  const pickManualWrite = useAppStore((s) => s.pickManualWrite);
  const connectWithManualProfile = useAppStore((s) => s.connectWithManualProfile);
  const scanProgress = useAppStore((s) => s.scanProgress);
  const scanRows = useAppStore((s) => s.scanRows);
  const runPidScan = useAppStore((s) => s.runPidScan);

  const [logBusy, setLogBusy] = useState(false);
  const [manualBusy, setManualBusy] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  /**
   * Son yakalanmamış JS hatası. TestFlight'ın çökme raporu yalnızca yerel
   * yığını içeriyor — hatanın metni bu dosyada; uygulama yeniden açılınca
   * burada görünür.
   */
  const [crash, setCrash] = useState<CrashRecord | null>(() => readLastCrash());

  /**
   * Elle güncelleme indirme. Arabada, uygulamayı iki kez kapatıp açmak yerine
   * tek dokunuşla en son JS sürümüne geçmeyi sağlıyor.
   */
  const checkUpdate = useCallback(async () => {
    if (!Updates.isEnabled) {
      Alert.alert('Development mode', 'OTA updates only work in a real build.');
      return;
    }
    setUpdateBusy(true);
    try {
      const check = await Updates.checkForUpdateAsync();
      if (!check.isAvailable) {
        Alert.alert('Up to date', 'Already running the latest version.');
        return;
      }
      await Updates.fetchUpdateAsync();
      Alert.alert('Update downloaded', 'The app will restart.', [
        { text: 'OK', onPress: () => void Updates.reloadAsync() },
      ]);
    } catch (e) {
      Alert.alert('Update failed', e instanceof Error ? e.message : String(e));
    } finally {
      setUpdateBusy(false);
    }
  }, []);

  const shareCrash = useCallback(async () => {
    if (!crash) return;
    const text =
      `${new Date(crash.at).toISOString()} ${crash.fatal ? 'FATAL' : 'non-fatal'}\n` +
      `${crash.message}\n\n${crash.stack ?? '(no stack)'}\n\n` +
      `Breadcrumbs:\n${crash.breadcrumbs.join('\n')}\n`;
    try {
      const { uri, shared } = await writeAndShare(
        `d50_crash_${crash.at}.txt`,
        text,
        'text/plain',
        'Share crash report',
      );
      if (!shared) Alert.alert('Sharing unavailable', `File saved: ${uri}`);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : String(e));
    }
  }, [crash]);

  const dismissCrash = useCallback(() => {
    clearLastCrash();
    setCrash(null);
  }, []);

  const shareLog = useCallback(async () => {
    setLogBusy(true);
    try {
      const text = rawLog
        .map((e) => `${new Date(e.ts).toISOString()} [${e.direction}] ${e.text}`)
        .join('\n');
      const { uri, shared } = await writeAndShare(
        `obd_debug_${Date.now()}.txt`,
        text,
        'text/plain',
        'Share debug log',
      );
      if (!shared) Alert.alert('Sharing unavailable', `File saved: ${uri}`);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : String(e));
    } finally {
      setLogBusy(false);
    }
  }, [rawLog]);

  const pidScan = useCallback(async () => {
    const report = await runPidScan();
    if (!report) return;
    try {
      const { uri, shared } = await writeAndShare(
        `obd_pid_scan_${Date.now()}.txt`,
        report,
        'text/plain',
        'Share PID scan',
      );
      if (!shared) Alert.alert('Sharing unavailable', `File saved: ${uri}`);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : String(e));
    }
  }, [runPidScan]);

  const manualConnect = useCallback(async () => {
    setManualBusy(true);
    try {
      await connectWithManualProfile();
    } finally {
      setManualBusy(false);
    }
  }, [connectWithManualProfile]);

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

        {/*
          Buradan aşağısı eski Debug sekmesi. Sırası kasıtlı: sürüm ve çökme
          kaydı üstte (bir şey ters gittiğinde ilk sorulan bunlar), ham trafik
          en altta — en teknik olan en derinde.
        */}
        <View style={{ marginTop: space(6) }}>
          <SectionRule label="Build" meta={Updates.isEmbeddedLaunch ? 'Embedded' : 'OTA'} />
          <View style={styles.buildRow}>
            <Text style={[type.status, { color: color.ink, fontSize: 14 }]}>{JS_BUILD_TAG}</Text>
            <Text style={type.metaSmall}>{Updates.runtimeVersion ?? '—'}</Text>
          </View>
          <GhostAction
            label={updateBusy ? 'Checking' : 'Check for update'}
            onPress={checkUpdate}
            disabled={updateBusy}
            style={{ marginTop: space(2.5) }}
          />
        </View>

        {crash && (
          <View style={{ marginTop: space(6) }}>
            <SectionRule
              label="Last crash"
              meta={new Date(crash.at).toLocaleString()}
              metaColor={color.alert}
            />
            <Text style={[type.prose, { color: color.ink, marginTop: space(2) }]}>
              {crash.message}
            </Text>
            {crash.stack ? (
              <Text style={[type.metaSmall, { marginTop: space(2), lineHeight: 14 }]}>
                {crash.stack.split('\n').slice(0, 8).join('\n')}
              </Text>
            ) : null}
            {crash.breadcrumbs.length > 0 ? (
              <Text style={[type.metaSmall, { marginTop: space(2), lineHeight: 14 }]}>
                {crash.breadcrumbs.slice(-4).join('\n')}
              </Text>
            ) : null}
            <View style={{ flexDirection: 'row', gap: space(3), marginTop: space(2.5) }}>
              <GhostAction label="Share crash" onPress={shareCrash} style={{ flex: 1 }} />
              <GhostAction label="Dismiss" onPress={dismissCrash} style={{ flex: 1 }} />
            </View>
          </View>
        )}

        {bleCandidates && bleCandidates.length > 0 && (
          <View style={{ marginTop: space(6) }}>
            <SectionRule
              label="Manual profile"
              meta="No automatic match"
              metaColor={color.caution}
            />
            <Text style={[type.metaSmall, { marginTop: space(2) }]}>
              {`Notify ${short(manualNotify)}   Write ${short(manualWrite)}`}
            </Text>
            <PrimaryAction
              label={manualBusy ? 'Connecting' : 'Connect with profile'}
              onPress={manualConnect}
              disabled={manualBusy || !manualNotify || !manualWrite}
              style={{ marginTop: space(2.5) }}
            />
            <View style={styles.candidateList}>
              {bleCandidates.map((c, i) => (
                <CandidateRow
                  key={i}
                  candidate={c}
                  isNotify={same(manualNotify, c)}
                  isWrite={same(manualWrite, c)}
                  onNotify={() => pickManualNotify(c)}
                  onWrite={() => pickManualWrite(c)}
                />
              ))}
            </View>
          </View>
        )}

        <View style={{ marginTop: space(6) }}>
          <SectionRule
            label="PID scan"
            meta={
              scanProgress
                ? `${scanProgress.done}/${scanProgress.total}`
                : scanRows
                  ? `${scanRows.filter((r) => r.answered).length}/${scanRows.length} answered`
                  : undefined
            }
          />
          <Note>
            Probes every PID the ECU claims and writes a report — the definitive answer to what
            this car actually supports.
          </Note>
          <GhostAction
            label={scanProgress ? `Scanning ${scanProgress.currentPid}` : 'Scan PIDs'}
            onPress={pidScan}
            disabled={!linked || scanProgress !== null}
            style={{ marginTop: space(3) }}
          />
        </View>

        {/*
          Ham trafik. Eskiden ekranın yarısını kaplayan ters çevrilmiş bir
          FlatList'ti; artık sayfanın içinde sabit yükseklikte bir pencere.
          VirtualizedList sayfayla aynı yönde kaydırılan bir ScrollView'in
          içine konulamaz, o yüzden sade ScrollView kullanılıyor — kayıt
          zaten 500 satırla sınırlı (MAX_LOG_ENTRIES), sanallaştırmaya gerek
          yok.

          Sıra artık YENİDEN ESKİYE: pencere sayfanın içinde olduğu için
          otomatik en alta kaydırma yok, dolayısıyla en son satır görünür
          olan yerde — yani en üstte — durmalı.
        */}
        <View style={{ marginTop: space(6) }}>
          <SectionRule label="Traffic" meta={`${rawLog.length} lines`} />
          <ScrollView
            style={styles.logWindow}
            contentContainerStyle={{ padding: space(2) }}
            nestedScrollEnabled
            showsVerticalScrollIndicator={false}
          >
            {rawLog.length === 0 ? (
              <Text style={type.meta}>No traffic yet. Connect the adapter above.</Text>
            ) : (
              [...rawLog]
                .reverse()
                .map((entry, i) => <LogLine key={`${entry.ts}-${i}`} entry={entry} />)
            )}
          </ScrollView>
          <View style={styles.logActions}>
            <GhostAction
              label={logBusy ? 'Preparing' : 'Share log'}
              onPress={shareLog}
              disabled={logBusy || rawLog.length === 0}
              style={{ flex: 1 }}
            />
            <GhostAction
              label="Clear"
              onPress={clearLog}
              textTint={color.chrome}
              style={{ flex: 1 }}
            />
          </View>
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

function LogLine({ entry }: { entry: RawLogEntry }) {
  // Hata satırı: kırmızı metin zemin üzerinde okunmuyor (~2.8:1). Amber
  // (6.1:1) hem okunur hem "bir şey ters" sinyalini korur; '!' öneki zaten var.
  const tint =
    entry.direction === 'error'
      ? color.caution
      : entry.direction === 'tx'
        ? color.linked
        : entry.direction === 'rx'
          ? color.ink
          : color.muted;
  const prefix =
    entry.direction === 'tx'
      ? '>'
      : entry.direction === 'rx'
        ? '<'
        : entry.direction === 'error'
          ? '!'
          : '·';
  return (
    <Text style={[type.mono, { color: tint, marginVertical: 1 }]}>
      {`${time(entry.ts)} ${prefix} ${entry.text}`}
    </Text>
  );
}

function CandidateRow({
  candidate,
  isNotify,
  isWrite,
  onNotify,
  onWrite,
}: {
  candidate: ProfileCandidate;
  isNotify: boolean;
  isWrite: boolean;
  onNotify: () => void;
  onWrite: () => void;
}) {
  return (
    <View style={styles.candidate}>
      <Text style={[type.mono, { fontSize: 10 }]}>
        {`${candidate.serviceUUID.split('-')[0]} / ${candidate.characteristicUUID.split('-')[0]}`}
      </Text>
      <View style={styles.candidateActions}>
        {candidate.isNotifiable && (
          <Pressable onPress={onNotify} style={styles.candidateBtn}>
            <Tag text={isNotify ? '✓ Notify' : 'Notify'} tint={isNotify ? color.ink : color.muted} />
          </Pressable>
        )}
        {candidate.isWritable && (
          <Pressable onPress={onWrite} style={styles.candidateBtn}>
            <Tag text={isWrite ? '✓ Write' : 'Write'} tint={isWrite ? color.ink : color.muted} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

function same(a: ProfileCandidate | null, b: ProfileCandidate): boolean {
  return !!a && a.serviceUUID === b.serviceUUID && a.characteristicUUID === b.characteristicUUID;
}

function short(c: ProfileCandidate | null): string {
  return c ? c.characteristicUUID.split('-')[0] : '—';
}

function time(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
  buildRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingTop: space(2.5),
  },
  candidateList: { marginTop: space(3) },
  candidate: {
    paddingVertical: space(2),
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.hairlineFaint,
    gap: space(1.5),
  },
  candidateActions: { flexDirection: 'row', gap: space(2) },
  candidateBtn: { minHeight: 32, justifyContent: 'center' },
  /**
   * Trafik penceresi. Sabit yükseklik şart: sayfanın içinde yaşayan bir
   * kayıt, sınırlanmazsa 500 satırla Link ekranını kaydırılamaz hâle getirir.
   */
  logWindow: {
    height: 220,
    marginTop: space(2),
    borderWidth: hairlineWidth,
    borderColor: color.hairlineFaint,
    backgroundColor: color.groundAlt,
  },
  logActions: { flexDirection: 'row', gap: space(3), marginTop: space(3) },
});
