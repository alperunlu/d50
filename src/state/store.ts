/**
 * Uygulama genelinde bağlantı/oturum durumunu tutan zustand store'u.
 *
 * Uygulamanın TEK transport'u var: gerçek BLE adaptörü. Sahte/mock transport
 * uygulama kodunda yok — yalnızca `tests/helpers/` altında bir test double
 * olarak duruyor, yayınlanan bundle'a hiç girmiyor.
 *
 * Poller, DB ve UI transport'un iç detayını bilmez; hepsi `ObdTransport`
 * arayüzü üzerinden konuşur.
 */

import { AppState as RNAppState, type NativeEventSubscription } from 'react-native';
import { create } from 'zustand';
import { breadcrumb } from '../util/crashLog';
import { BleTransport, type ScannedDevice } from '../ble/bleTransport';
import type { DiscoveredProfile, ProfileCandidate } from '../ble/profiles';
import type { ObdConnectionState, ObdTransport } from '../ble/transport';
import {
  CommandQueue,
  initElm327,
  parseAdapterVoltage,
  type InitResult,
} from '../obd/elm327';
import { Poller, type PollSample } from '../obd/poller';
import { PIDS, getPidDefinition, isPidSupported, type PidDefinition } from '../obd/pids';
import { scanPids, formatScanReport, type PidScanProgress, type PidScanRow } from '../obd/pidScan';
import {
  parseDtcResponse,
  decodeMilStatus,
  decodeReadiness,
  formatDtcReport,
  DTC_MODES,
  type Dtc,
  type DtcKind,
  type MilStatus,
  type ReadinessStatus,
} from '../obd/dtc';
import { extractDataHex, hexToBytes } from '../obd/elm327';
import {
  SensorLogger,
  requestLocationPermission,
  isAccelerometerAvailable,
  areSensorModulesAvailable,
  isMicrophoneAvailable,
  requestMicrophonePermission,
  type SensorSample,
  type SensorPermission,
} from '../sensors/sensorLogger';
import { orderedCards, moveInOrder } from '../data/cardOrder';
import {
  sensorGroupsForChannels,
  recordedKeysForSensorChannels,
  SELECTABLE_SENSOR_CHANNELS,
  type SensorGroupKey,
} from '../data/channels';
import { MINI_R50, withFittedTyre, type TyreSize, type VehicleProfile } from '../analysis/vehicle';
import { parseTyreSize, formatTyreSize } from '../analysis/tyre';
import {
  DEFAULT_SPL_CALIBRATION_DB,
  clampCalibration,
  dbfsToSpl,
} from '../analysis/spl';
import { EngineSoundListener, isAudioStreamAvailable } from '../sensors/engineSound';
import { MicLevelMeter } from '../sensors/micLevel';
import * as repo from '../db/repo';
import type { Sample, Session } from '../db/types';

/**
 * BLE tarafı tekil (singleton) tutulur — tarama sonuçlarının ve seçili
 * cihazın, bağlan/kes döngüleri arasında hayatta kalması gerekir.
 */
let bleTransportSingleton: BleTransport | null = null;
function getBleTransport(): BleTransport {
  if (!bleTransportSingleton) bleTransportSingleton = new BleTransport();
  return bleTransportSingleton;
}

export interface RawLogEntry {
  readonly ts: number;
  readonly direction: 'tx' | 'rx' | 'info' | 'error';
  readonly text: string;
}

const MAX_LOG_ENTRIES = 500;

interface LiveSeries {
  readonly [pid: string]: readonly { ts: number; value: number }[];
}

interface AppState {
  // --- BLE tarama ---
  scanning: boolean;
  scanResults: readonly ScannedDevice[];
  selectedDeviceId: string | null;
  selectedDeviceName: string | null;
  startScan: () => void;
  stopScan: () => void;
  selectDevice: (device: ScannedDevice) => void;

  // --- bağlantı ---
  transport: ObdTransport | null;
  queue: CommandQueue | null;
  connectionState: ObdConnectionState;
  initResult: InitResult | null;
  connectError: string | null;
  /** BLE modunda hangi GATT profiliyle eşleştiği (bkz. plan, Kısıt #0). */
  bleProfileLabel: string | null;
  /** Profil eşleşmediğinde bulunan ham servis/karakteristik listesi — debug ekranı için. */
  bleCandidates: readonly ProfileCandidate[] | null;
  /** Kullanıcının debug ekranında elle seçtiği notify/write karakteristikleri. */
  manualNotify: ProfileCandidate | null;
  manualWrite: ProfileCandidate | null;
  pickManualNotify: (c: ProfileCandidate) => void;
  pickManualWrite: (c: ProfileCandidate) => void;
  connectWithManualProfile: () => Promise<void>;

  // --- PID seçimi ---
  selectedPids: readonly string[]; // pid kodları, ör. ["0C","0D","05"]

  // --- canlı kayıt ---
  poller: Poller | null;
  isRecording: boolean;
  /**
   * Kayıt sırasında uygulamanın arka plana düştüğü ve HİÇBİR ŞEYİN
   * kaydedilmediği aralıklar. Boş bir liste "delik yok" demektir.
   */
  recordingGaps: readonly { at: number; seconds: number }[];
  currentSession: Session | null;
  liveSeries: LiveSeries;
  sampleRate: number;

  // --- debug log ---
  rawLog: readonly RawLogEntry[];

  // --- PID tarama ---
  scanProgress: PidScanProgress | null;
  scanRows: readonly PidScanRow[] | null;
  runPidScan: () => Promise<string | null>;

  // --- telefon sensörleri ---
  /**
   * Seçili telefon sensörü KANALLARI (grup değil).
   *
   * Kullanıcı "hangi kartı istiyorum" diye seçiyor; hangi donanımın
   * açılacağı bundan türetiliyor (bkz. sensorGroupsForChannels). Gruplar
   * üzerinden seçtirmek, desibelmetre isteyen birine tekleme order'ı
   * kartı da açıyordu.
   */
  selectedSensorChannels: readonly string[];
  sensorStatus: string | null;
  toggleSensorChannel: (key: string) => Promise<void>;

  /**
   * Live ekranındaki kartların GÖRÜNÜM sırası.
   *
   * Seçim listelerinden ayrı tutuluyor: `selectedPids` neyin
   * sorgulanacağını, bu ise neyin nerede duracağını söylüyor. İkisini
   * birleştirmek, sırayı değiştirmenin poller'ı yeniden kurmasına yol
   * açardı. Listede olmayan yeni seçimler sona ekleniyor (bkz. orderedCards).
   */
  cardOrder: readonly string[];
  moveCard: (from: number, to: number) => void;

  /**
   * Araç profili — takılı lastik ebadı dahil.
   *
   * Lastik bir "ayar" gibi görünse de aslında ARACIN verisi: hız/mesafe
   * düzeltmesi, aktarma oranı ve tork tahmini ona dayanıyor. Bu yüzden
   * profilin içinde tutuluyor ve analiz katmanına profil olarak geçiyor.
   */
  vehicle: VehicleProfile;
  tyreError: string | null;
  loadSettings: () => Promise<void>;
  setFittedTyre: (tyre: TyreSize) => Promise<void>;

  /**
   * --- Gürültü ölçer ---
   *
   * OBD'den BAĞIMSIZ çalışır: adaptör takılı olmasa da, kayıt sürmese de
   * kullanılabilir. Amaç bunun tek başına bir desibelmetre olması;
   * araç bağlantısını şart koşmak onu kullanılamaz kılardı.
   */
  soundMeterOn: boolean;
  soundNow: number | null;
  soundMin: number | null;
  soundMax: number | null;
  soundAvg: number | null;
  soundError: string | null;
  splCalibrationDb: number;
  startSoundMeter: () => Promise<void>;
  stopSoundMeter: () => void;
  resetSoundStats: () => void;
  setSplCalibration: (db: number) => Promise<void>;

  // --- arıza kodları (SALT OKUMA — silme yok) ---
  dtcGroups: Readonly<Record<DtcKind, readonly Dtc[]>> | null;
  milStatus: MilStatus | null;
  readiness: ReadinessStatus | null;
  dtcReading: boolean;
  readDtcs: () => Promise<string | null>;

  // --- eylemler ---
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  togglePid: (pid: string) => void;
  isPidSupported: (pid: string) => boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  clearLog: () => void;
}

let stopScanFn: (() => void) | null = null;
/**
 * Kayıt sürerken log satırları buraya birikir ve örneklerle aynı ritimde
 * (saniyede bir) toplu olarak DB'ye yazılır. Satır başına ayrı INSERT
 * gereksiz yere yavaş olurdu.
 */
let sensorLogger: SensorLogger | null = null;
/** Kayıttan bağımsız gürültü ölçer (bkz. startSoundMeter). */
let soundMeter: EngineSoundListener | null = null;
let fallbackMeter: MicLevelMeter | null = null;
let soundSampleCount = 0;
let loggingSessionId: number | null = null;
let pendingLogRows: { ts: number; direction: string; text: string }[] = [];
/** BleTransport tekil olduğu için log aboneliği de yalnızca bir kez kurulmalı. */
let bleLogHooked = false;

/**
 * Arka plan takibi.
 *
 * iOS uygulamayı arka planda ASKIYA ALIR: zamanlayıcılar donar, BLE
 * bildirimi gelmez, hiçbir örnek kaydedilmez. Bunun için arka plan modu
 * kapalı (app.json, react-native-ble-plx `isBackgroundEnabled: false`).
 *
 * 6 Eylül 2026 kaydında bu 7 dakika 39 saniyelik sessiz bir delik açtı ve
 * deliği fark etmenin tek yolu log zaman damgalarına bakmaktı: gezi 521
 * saniye görünüyordu, gerçek veri 62 saniyeydi. Bir ölçüm aletinde sessiz
 * boşluk, yanlış değer kadar kötüdür — artık hem oturum loguna yazılıyor
 * hem de ekranda söyleniyor.
 */
let appStateSub: NativeEventSubscription | null = null;
let backgroundedAt: number | null = null;
/**
 * En son DİSKE örnek yazılan an (epoch ms).
 *
 * Delik ölçüsü budur, "arka plana düşüldü" değil. Arka plan modları
 * açıkken (bluetooth-central + location) kayıt arka planda sürüyor;
 * uygulamadan çıkıp haritaya bakmak artık veri kaybı değil ve öyle
 * raporlanmamalı. Veri gerçekten kesildiyse bunu örneklerin kendisi
 * söyler, uygulamanın hangi ekranda olduğu değil.
 */
let lastSampleAt = 0;
/** Akü voltajı ATRV ile ayrı ritimde okunuyor (bkz. pollAdapterVoltage). */
let voltageTimer: ReturnType<typeof setInterval> | null = null;

export const useAppStore = create<AppState>((set, get) => ({
  scanning: false,
  scanResults: [],
  selectedDeviceId: null,
  selectedDeviceName: null,

  startScan: () => {
    stopScanFn?.();
    set({ scanResults: [], scanning: true });
    const ble = getBleTransport();
    stopScanFn = ble.scan(
      (device) => {
        set((s) => {
          if (s.scanResults.some((d) => d.id === device.id)) return s;
          return { scanResults: [...s.scanResults, device] };
        });
      },
      (err) => {
        set({ connectError: err.message, scanning: false });
      },
    );
  },

  stopScan: () => {
    stopScanFn?.();
    stopScanFn = null;
    set({ scanning: false });
  },

  selectDevice: (device) => {
    get().stopScan();
    getBleTransport().setTargetDevice(device.id);
    set({ selectedDeviceId: device.id, selectedDeviceName: device.name });
  },

  transport: null,
  queue: null,
  connectionState: 'disconnected',
  initResult: null,
  connectError: null,
  bleProfileLabel: null,
  bleCandidates: null,
  manualNotify: null,
  manualWrite: null,
  pickManualNotify: (c) => set({ manualNotify: c }),
  pickManualWrite: (c) => set({ manualWrite: c }),

  selectedPids: ['0C', '0D', '05'],

  poller: null,
  isRecording: false,
  recordingGaps: [],
  currentSession: null,
  liveSeries: {},
  sampleRate: 0,

  rawLog: [],

  scanProgress: null,
  scanRows: null,

  dtcGroups: null,
  milStatus: null,
  readiness: null,
  dtcReading: false,

  // Sensörler varsayılan olarak KAPALI: izin istemek kullanıcının kararı
  // olmalı, ayrıca GPS ve mikrofon pil tüketiyor.
  selectedSensorChannels: [],
  sensorStatus: null,
  cardOrder: [],

  /**
   * Kartı taşır. Sıra, o an seçili olan kanallar üzerinden hesaplanıp
   * yeniden yazılıyor: arada silinmiş bir kanal varsa listede kalıntı
   * bırakmıyor.
   */
  moveCard: (from: number, to: number) => {
    const next = moveInOrder(orderedCards(get()), from, to);
    set({ cardOrder: next });
    // Kullanıcının kurduğu düzen her açılışta sıfırlanmamalı.
    void repo.setSetting('card_order', JSON.stringify(next)).catch(() => undefined);
  },

  /**
   * Bir sensör kanalını açar/kapatır ve gerekiyorsa donanımının iznini ister.
   *
   * İzin seçim anında isteniyor, kayıt başlarken değil: arabada "Record"a
   * bastığında karşına izin diyaloğu çıkması, kaydın ilk saniyelerini
   * kaybettirir.
   *
   * Kapatırken izin sorulmuyor; aynı donanımı kullanan başka bir kanal
   * hâlâ seçiliyse donanım da açık kalmaya devam ediyor.
   */
  toggleSensorChannel: async (key: string) => {
    const current = get().selectedSensorChannels;
    if (current.includes(key)) {
      set({ selectedSensorChannels: current.filter((k) => k !== key), sensorStatus: null });
      return;
    }

    const definition = SELECTABLE_SENSOR_CHANNELS.find((c) => c.key === key);
    if (!definition) return;
    const group = definition.group;

    // Aynı donanımı kullanan bir kanal zaten seçiliyse izin de alınmış demektir.
    const alreadyOn = sensorGroupsForChannels(current).includes(group);
    if (alreadyOn) {
      set({ selectedSensorChannels: [...current, key], sensorStatus: null });
      return;
    }

    // Sensörler native modül gerektirir; OTA ile gelmezler. Eski bir binary'de
    // net bir mesaj vermek, sessizce hiçbir şey olmamasından iyidir.
    const nativeReady = group === 'mic' ? isMicrophoneAvailable() : areSensorModulesAvailable();
    if (!nativeReady) {
      set({
        sensorStatus:
          'This sensor needs a new app build (native module). Everything else works on this version.',
      });
      return;
    }

    let status: SensorPermission = 'granted';
    if (group === 'gps') status = await requestLocationPermission();
    if (group === 'mic') status = await requestMicrophonePermission();
    if (group === 'motion') status = (await isAccelerometerAvailable()) ? 'granted' : 'unavailable';

    if (status !== 'granted') {
      set({
        sensorStatus:
          status === 'denied'
            ? `${group.toUpperCase()} permission denied — enable it in iOS Settings.`
            : `${group.toUpperCase()} is not available on this device.`,
      });
      return;
    }

    set({
      selectedSensorChannels: [...current, key],
      sensorStatus:
        group === 'mic'
          ? 'Microphone ready — no audio is stored.'
          : `${group.toUpperCase()} ready.`,
    });
  },

  vehicle: MINI_R50,
  tyreError: null,

  soundMeterOn: false,
  soundNow: null,
  soundMin: null,
  soundMax: null,
  soundAvg: null,
  soundError: null,
  splCalibrationDb: DEFAULT_SPL_CALIBRATION_DB,

  /**
   * Gürültü ölçümünü başlatır. Kayıttan bağımsız bir dinleyici açıyor:
   * kullanıcı sadece "şu an ne kadar gürültülü" sorusunu sormak için
   * uygulamayı açtığında araca bağlanmak zorunda kalmasın.
   */
  startSoundMeter: async () => {
    if (get().soundMeterOn) return;

    if (!isMicrophoneAvailable()) {
      set({ soundError: 'The microphone needs a new app build (native module).' });
      return;
    }
    const permission = await requestMicrophonePermission();
    if (permission !== 'granted') {
      set({
        soundError:
          permission === 'denied'
            ? 'Microphone permission denied — enable it in iOS Settings.'
            : 'Microphone is not available on this device.',
      });
      return;
    }

    const push = (dbA: number) => {
      const s = get();
      const count = soundSampleCount++;
      const avg =
        s.soundAvg === null ? dbA : (s.soundAvg * count + dbA) / (count + 1);
      set({
        soundNow: dbA,
        soundMin: s.soundMin === null ? dbA : Math.min(s.soundMin, dbA),
        soundMax: s.soundMax === null ? dbA : Math.max(s.soundMax, dbA),
        soundAvg: avg,
      });
    };

    if (isAudioStreamAvailable()) {
      soundMeter = new EngineSoundListener({
        getRpm: () => {
          const rpmSeries = get().liveSeries['0C'];
          if (!rpmSeries || rpmSeries.length === 0) return null;
          return rpmSeries[rpmSeries.length - 1].value;
        },
        getCalibrationDb: () => get().splCalibrationDb,
        onSamples: (samples) => {
          for (const s of samples) if (s.key === 'mic_db') push(s.value);
        },
        onError: (message) => set({ soundError: message }),
      });
      const ok = await soundMeter.start();
      if (!ok) {
        soundMeter = null;
      } else {
        set({ soundMeterOn: true, soundError: null });
        return;
      }
    }

    /**
     * Ham PCM yoksa metering'li kayda düşülüyor. O yolda A-ağırlıklama
     * yapılamıyor (spektrum yok), yani sayı daha kaba; bunu kullanıcıya
     * söylüyoruz, sessizce daha kötü bir ölçüm sunmuyoruz.
     */
    fallbackMeter = new MicLevelMeter({
      onError: (message) => set({ soundError: message }),
    });
    const started = await fallbackMeter.start((dbfs) => push(dbfsToSpl(dbfs, get().splCalibrationDb)));
    if (!started) {
      fallbackMeter = null;
      return;
    }
    set({
      soundMeterOn: true,
      soundError: 'Unweighted reading — this build cannot do A-weighting.',
    });
  },

  stopSoundMeter: () => {
    soundMeter?.stop();
    soundMeter = null;
    void fallbackMeter?.stop();
    fallbackMeter = null;
    set({ soundMeterOn: false, soundNow: null });
  },

  resetSoundStats: () => {
    soundSampleCount = 0;
    set({ soundMin: null, soundMax: null, soundAvg: null });
  },

  /** Kalibrasyon: 0 dBFS'in kaç dB SPL sayılacağı. */
  setSplCalibration: async (db: number) => {
    const value = clampCalibration(db);
    set({ splCalibrationDb: value });
    try {
      await repo.setSetting('spl_calibration_db', String(value));
    } catch {
      // Kalıcı yazılamazsa oturum boyunca geçerli kalır.
    }
  },

  /** Kalıcı ayarları uygulama açılışında yükler. */
  loadSettings: async () => {
    try {
      const raw = await repo.getSetting('fitted_tyre');
      if (raw) {
        const tyre = parseTyreSize(raw);
        if (tyre) set({ vehicle: withFittedTyre(get().vehicle, tyre) });
      }
      const cal = await repo.getSetting('spl_calibration_db');
      if (cal) set({ splCalibrationDb: clampCalibration(Number(cal)) });

      const order = await repo.getSetting('card_order');
      if (order) {
        const parsed: unknown = JSON.parse(order);
        if (Array.isArray(parsed) && parsed.every((k) => typeof k === 'string')) {
          set({ cardOrder: parsed as string[] });
        }
      }
    } catch {
      // Ayar okunamazsa varsayılan profille devam — uygulama açılmalı.
    }
  },

  /**
   * Takılı lastik ebadını kaydeder.
   *
   * Girdi artık serbest metin değil, listeden seçilmiş bir ebat — bu yüzden
   * ayrıştırma hatası diye bir durum yok. `tyreError` yalnızca kalıcı
   * yazmanın başarısız olduğu durumda doluyor ve o zaman bile seçim
   * oturum boyunca geçerli kalıyor.
   */
  setFittedTyre: async (tyre: TyreSize) => {
    set({ vehicle: withFittedTyre(get().vehicle, tyre), tyreError: null });
    try {
      await repo.setSetting('fitted_tyre', formatTyreSize(tyre));
    } catch (e) {
      set({
        tyreError: `Saved for this session only: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  },

  /**
   * Arıza kodlarını OKUR. Üç mod da salt-okunurdur; Mode 04 (silme) ne burada
   * ne allowlist'te vardır — uygulamanın temel şartı.
   */
  readDtcs: async () => {
    const { queue } = get();
    if (!queue) {
      set({ connectError: 'Connect to the adapter first.' });
      return null;
    }

    set({ dtcReading: true, connectError: null });
    appendLog(set, { ts: Date.now(), direction: 'info', text: 'Reading fault codes…' });

    try {
      // MIL durumu ve kod sayısı Mode 01 PID 01'den gelir.
      let milStatus: MilStatus | null = null;
      let readiness: ReadinessStatus | null = null;
      try {
        const raw = await queue.send('0101');
        const hex = extractDataHex(raw, '01');
        if (hex) {
          const bytes = hexToBytes(hex);
          milStatus = decodeMilStatus(bytes);
          // Aynı cevabın B/C/D baytları I/M hazırlık monitörlerini taşıyor —
          // ekstra komut göndermeden muayene hazırlığını da öğreniyoruz.
          readiness = decodeReadiness(bytes);
        }
      } catch {
        // MIL bilgisi alınamazsa kod okumaya yine de devam edilir.
      }

      const groups: Record<DtcKind, Dtc[]> = { stored: [], pending: [], permanent: [] };
      for (const kind of ['stored', 'pending', 'permanent'] as DtcKind[]) {
        try {
          const raw = await queue.send(DTC_MODES[kind].command);
          groups[kind] = parseDtcResponse(raw, kind);
        } catch (e) {
          appendLog(set, {
            ts: Date.now(),
            direction: 'error',
            text: `${DTC_MODES[kind].command} failed: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }

      set({ dtcGroups: groups, milStatus, readiness });
      const total = groups.stored.length + groups.pending.length + groups.permanent.length;
      appendLog(set, {
        ts: Date.now(),
        direction: 'info',
        text: `Fault codes read: ${total} (MIL ${milStatus?.milOn ? 'ON' : 'off'})`,
      });
      return formatDtcReport(groups, milStatus, readiness);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set({ connectError: message });
      appendLog(set, { ts: Date.now(), direction: 'error', text: `Fault code read failed: ${message}` });
      return null;
    } finally {
      set({ dtcReading: false });
    }
  },

  /**
   * Aracın iddia ettiği her PID'i tek tek sorar. Bitmask "destekliyorum"
   * dese bile gerçekte cevap gelmeyebiliyor; rapor ikisini yan yana koyuyor.
   * Dönen metin paylaşılmak üzere çağırana verilir.
   */
  runPidScan: async () => {
    const { queue, initResult } = get();
    if (!queue || !initResult) {
      set({ connectError: 'Connect to the adapter first.' });
      return null;
    }

    set({ scanProgress: { done: 0, total: 0, currentPid: '' }, scanRows: null });
    appendLog(set, { ts: Date.now(), direction: 'info', text: 'Scanning vehicle PIDs…' });

    try {
      const rows = await scanPids(queue, initResult.supportedPids, (p) => set({ scanProgress: p }));
      set({ scanRows: rows });
      appendLog(set, {
        ts: Date.now(),
        direction: 'info',
        text: `PID scan done: ${rows.filter((r) => r.answered).length}/${rows.length} answered`,
      });
      return formatScanReport(rows, initResult.supportedPids);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set({ connectError: message });
      appendLog(set, { ts: Date.now(), direction: 'error', text: `PID scan failed: ${message}` });
      return null;
    } finally {
      set({ scanProgress: null });
    }
  },

  connect: async () => {
    const { selectedDeviceId } = get();
    if (!selectedDeviceId) {
      set({ connectError: 'Select an adapter from the scan list first.' });
      return;
    }

    const existing = get().transport;
    if (existing && get().connectionState === 'connected') return;

    const transport = existing ?? getBleTransport();
    const queue = new CommandQueue(loggingTransport(transport, (entry) => appendLog(set, entry)));

    transport.onStateChange((s) => set({ connectionState: s }));

    // Transport'un İÇİNDEKİ adımları (profil denemeleri, sınama sonuçları)
    // debug log'una taşı — dıştan saran loggingTransport bunları göremez.
    if (transport instanceof BleTransport && !bleLogHooked) {
      transport.onLog((msg) => appendLog(set, { ts: Date.now(), direction: 'info', text: msg }));
      bleLogHooked = true;
    }

    set({ transport, queue, connectError: null, bleCandidates: null, manualNotify: null, manualWrite: null });

    try {
      appendLog(set, { ts: Date.now(), direction: 'info', text: 'Connecting…' });
      await transport.connect();
      appendLog(set, { ts: Date.now(), direction: 'info', text: 'Connected, initialising ELM327…' });

      if (transport instanceof BleTransport) {
        const profile = transport.discoveredProfile;
        set({ bleProfileLabel: profile?.label ?? null });
        if (profile) {
          appendLog(set, { ts: Date.now(), direction: 'info', text: `GATT profile: ${profile.label}` });
        }
      }

      await runInitSequence(queue, set);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set({ connectError: message });
      appendLog(set, { ts: Date.now(), direction: 'error', text: `Error: ${message}` });

      // Bilinen bir GATT profili eşleşmediyse, bulunan ham servis/karakteristik
      // listesini debug ekranında göster — sessiz hata yok (bkz. plan, Kısıt #0).
      if (transport instanceof BleTransport) {
        set({ bleCandidates: transport.lastCandidates });
      }
    }
  },

  connectWithManualProfile: async () => {
    const { transport, queue, manualNotify, manualWrite } = get();
    if (!(transport instanceof BleTransport) || !queue) {
      set({ connectError: 'Try connecting from the Connect tab first.' });
      return;
    }
    if (!manualNotify || !manualWrite) {
      set({ connectError: 'Pick one notify and one write characteristic from the list.' });
      return;
    }
    if (manualNotify.serviceUUID !== manualWrite.serviceUUID) {
      set({ connectError: 'Notify and write must be in the same service.' });
      return;
    }

    const profile: DiscoveredProfile = {
      serviceUUID: manualNotify.serviceUUID,
      notifyUUID: manualNotify.characteristicUUID,
      writeUUID: manualWrite.characteristicUUID,
      writeWithResponse: manualWrite.isWritableWithResponse,
      label: 'Manually selected',
    };

    set({ connectError: null });
    try {
      appendLog(set, { ts: Date.now(), direction: 'info', text: 'Connecting with the manually selected profile…' });
      await transport.connectWithManualProfile(profile);
      set({ bleProfileLabel: profile.label, bleCandidates: null });
      appendLog(set, { ts: Date.now(), direction: 'info', text: `GATT profile: ${profile.label}` });
      await runInitSequence(queue, set);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set({ connectError: message });
      appendLog(set, { ts: Date.now(), direction: 'error', text: `Error: ${message}` });
    }
  },

  disconnect: async () => {
    const { transport, poller } = get();
    if (poller) {
      poller.stop();
    }
    if (transport) {
      await transport.disconnect();
    }
    set({
      poller: null,
      isRecording: false,
      currentSession: null,
      initResult: null,
    });
  },

  togglePid: (pid: string) => {
    set((s) => ({
      selectedPids: s.selectedPids.includes(pid)
        ? s.selectedPids.filter((p) => p !== pid)
        : [...s.selectedPids, pid],
    }));
  },

  isPidSupported: (pid: string) => {
    const mask = get().initResult?.supportedPids;
    if (!mask) return true; // henüz bilinmiyor -> engelleme, aktif göster
    return isPidSupported(pid, mask);
  },

  startRecording: async () => {
    const { queue, selectedPids } = get();
    if (!queue) throw new Error('You must connect first');
    if (selectedPids.length === 0) throw new Error('You must select at least one PID');

    /**
     * ECU'nun DESTEKLEMEDİĞİNİ söylediği kanalları sormuyoruz.
     *
     * 6 Eylül 2026 kaydı: 0142, 0143 ve 0146 seçiliydi, 757 saniye boyunca
     * her turda soruldu, hepsine `NO DATA` geldi ve CSV'ye üç tamamen boş
     * sütun olarak girdi. Oysa ECU bunu bağlantı anında söylemişti —
     * 0120 cevabı 80000000, yani 0x40 bloğu hiç desteklenmiyor, dolayısıyla
     * 0x41-0x60 arası bütün PID'ler yok. Cevap vermeyecek bir PID'i sormak
     * her turdan birkaç yüz milisaniye çalıyor ve o süre gerçek kanallardan
     * kesiliyor.
     *
     * Maskede bilgi yoksa (tarama yapılmamışsa) hiçbir şey elenmiyor:
     * susmak, yanlış elemekten iyidir.
     */
    const supportMask = get().initResult?.supportedPids ?? null;
    const unsupported = supportMask
      ? selectedPids.filter((p) => !isPidSupported(p, supportMask))
      : [];
    const pollPids = selectedPids.filter((p) => !unsupported.includes(p));

    if (pollPids.length === 0) {
      throw new Error('This ECU reports none of the selected channels as supported');
    }
    if (unsupported.length > 0) {
      appendLog(set, {
        ts: Date.now(),
        direction: 'info',
        text: `Not recording ${unsupported.join(', ')} — this ECU does not report them supported`,
      });
    }

    const pidDefs = pollPids
      .map((p) => getPidDefinition(p))
      .filter((p): p is PidDefinition => p !== undefined);

    // Seçili sensörlerin kanal anahtarları da oturuma yazılır ki CSV export
    // onları da sütun olarak çıkarsın.
    const selectedSensorChannels = get().selectedSensorChannels;
    const selectedSensors = sensorGroupsForChannels(selectedSensorChannels);
    const recordedKeys = [
      ...pollPids,
      // Adaptörün voltmetresi her araçta çalışıyor ve seçim gerektirmiyor:
      // bedeli 10 saniyede bir komut, karşılığı şarj sisteminin durumu.
      'battery_v',
      ...recordedKeysForSensorChannels(selectedSensorChannels),
    ];
    // ECU'nun destek bitmask'i oturumla saklanıyor: sonradan analiz
    // ederken "araç bunu desteklemiyor" ile "kanalı seçmemişim" ayrımı
    // ancak bununla yapılabiliyor.
    const session = await repo.startSession(recordedKeys, get().initResult?.supportedPids ?? null);

    // Bağlantı/init sırasındaki satırlar kayıttan ÖNCE oluştu ama oturuma
    // ait bağlamın en değerli kısmı (protokol, GATT profili, desteklenen
    // PID'ler) orada; oturumun başına iliştiriliyor.
    loggingSessionId = session.id;
    pendingLogRows = get().rawLog.map((e) => ({ ts: e.ts, direction: e.direction, text: e.text }));

    /**
     * OBD ve sensör örnekleri TEK bir sıfır noktasını paylaşır.
     *
     * Yorum baştan beri bunu söylüyordu ama kod iki ayrı `Date.now()`
     * çağırıyordu: poller kurulurken bir tane, sensör logger kurulurken
     * bir tane daha. Aradaki fark küçük ama gerçek, ve iki zaman ekseni
     * arasında sabit bir kayma bırakıyordu — hız ile ivmeyi eşleştiren
     * her metrik o kaymayı taşıyordu. Ayrıca cycle adımları arasında
     * poller yeniden kurulduğunda referansın değişmemesi buna bağlı.
     */
    const recordingStartedAt = Date.now();

    breadcrumb(`recording started: session ${session.id}, ${recordedKeys.length} channels`);
    set({ currentSession: session, liveSeries: {}, isRecording: true, recordingGaps: [] });

    keepScreenAwake(true);
    watchBackgroundGaps(set);
    startVoltagePolling(session.id, recordingStartedAt, queue, set);

    const poller = new Poller({
      pids: pidDefs,
      queue,
      startedAt: recordingStartedAt,
      onFlush: (samples: PollSample[]) => {
        void flushSamples(session.id, samples, set, get);
      },
      // Cevap vermeyen bir kanal seyreltildiğinde kullanıcı bunu debug
      // log'unda görsün — sessizce yavaşlayan bir kanal kafa karıştırır.
      onBackoff: (pid, failures) =>
        appendLog(set, {
          ts: Date.now(),
          direction: 'info',
          text: `PID ${pid} did not answer ${failures}x — polling it less often`,
        }),
    });
    poller.start();
    set({ poller });

    // Sensörler açıksa OBD ile AYNI zaman referansını paylaşarak başlar —
    // CSV'de aynı satıra düşmeleri ve birleşik metriklerin çalışması buna bağlı.
    if (selectedSensors.length > 0) {
      sensorLogger = new SensorLogger({
        startedAt: recordingStartedAt,
        groups: selectedSensors,
        // Order analizi için canlı devir. Poller'ın en son yazdığı 0C
        // örneği; sensör tarafı OBD tarafını böyle okuyor.
        getRpm: () => {
          const rpmSeries = get().liveSeries['0C'];
          if (!rpmSeries || rpmSeries.length === 0) return null;
          return rpmSeries[rpmSeries.length - 1].value;
        },
        getCalibrationDb: () => get().splCalibrationDb,
        onSamples: (sensorSamples: SensorSample[]) => {
          void flushSensorSamples(session.id, sensorSamples, set);
        },
        onError: (message) =>
          appendLog(set, { ts: Date.now(), direction: 'error', text: `Sensor: ${message}` }),
      });
      void sensorLogger.start();
      appendLog(set, {
        ts: Date.now(),
        direction: 'info',
        text: `Phone sensors started: ${selectedSensors.join(', ')}`,
      });
    }
  },

  stopRecording: async () => {
    const { poller, currentSession } = get();
    stopWatchingBackgroundGaps();
    stopVoltagePolling();
    keepScreenAwake(false);
    poller?.stop();
    sensorLogger?.stop();
    sensorLogger = null;
    await flushSessionLogs();
    loggingSessionId = null;
    if (currentSession) {
      await repo.endSession(currentSession.id);
    }
    breadcrumb(
      `recording stopped: session ${currentSession?.id ?? '—'}, ${
        currentSession ? Math.round((Date.now() - currentSession.startedAt) / 1000) : 0
      } s`,
    );
    set({ poller: null, isRecording: false });
  },

  clearLog: () => set({ rawLog: [] }),
}));

/** `connect()` ve `connectWithManualProfile()` arasında paylaşılan ELM327 init adımı. */
async function runInitSequence(
  queue: CommandQueue,
  set: (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void,
): Promise<void> {
  const initResult = await initElm327(queue);
  set({ initResult });
  appendLog(set, {
    ts: Date.now(),
    direction: 'info',
    text: `Ready. Protocol #${initResult.protocolNumber}, adapter: ${initResult.adapterInfo}`,
  });
}

async function flushSamples(
  sessionId: number,
  samples: PollSample[],
  set: (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
): Promise<void> {
  const dbSamples: Sample[] = samples.map((s) => ({
    sessionId,
    ts: s.ts,
    pid: s.pid,
    value: s.value,
  }));

  lastSampleAt = Date.now();
  try {
    await repo.insertSamples(dbSamples);
  } catch (e) {
    appendLog(set, {
      ts: Date.now(),
      direction: 'error',
      text: `DB write error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  /**
   * Oturum log'u AYRI bir try içinde yazılıyor.
   *
   * Önce örneklerle aynı blokta duruyordu: örnek yazımı hata verince log
   * yazımına hiç sıra gelmiyordu. 2026-09-05 araç kaydında tam olarak bu
   * oldu — hem veri hem log aynı anda kayboldu ve Trips ekranındaki "Log"
   * düğmesi "bu oturumda log yok" dedi. Teşhis için en çok ihtiyaç
   * duyulan an, bir şeylerin bozulduğu andır; log o anda kaybolmamalı.
   */
  try {
    await flushSessionLogs();
  } catch (e) {
    appendLog(set, {
      ts: Date.now(),
      direction: 'error',
      text: `Session log write error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  set((s) => {
    const nextSeries: Record<string, { ts: number; value: number }[]> = {};
    for (const pid of Object.keys(s.liveSeries)) {
      nextSeries[pid] = [...s.liveSeries[pid]];
    }
    for (const sample of samples) {
      const arr = nextSeries[sample.pid] ?? [];
      arr.push({ ts: sample.ts, value: sample.value });
      // Kayan grafik: yalnızca son ~120sn'yi bellekte tut.
      const cutoff = sample.ts - 120_000;
      nextSeries[sample.pid] = arr.filter((p) => p.ts >= cutoff);
    }
    return { liveSeries: nextSeries, sampleRate: get().poller?.sampleRate ?? 0 };
  });
}

/** Sensör örneklerini OBD örnekleriyle aynı tabloya yazar. */
async function flushSensorSamples(
  sessionId: number,
  samples: SensorSample[],
  set: (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void,
): Promise<void> {
  if (samples.length === 0) return;
  lastSampleAt = Date.now();
  try {
    await repo.insertSamples(
      samples.map((s) => ({ sessionId, ts: s.ts, pid: s.key, value: s.value })),
    );
  } catch (e) {
    appendLog(set, {
      ts: Date.now(),
      direction: 'error',
      text: `Sensor DB write error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // Canlı grafik için hızlı kanalları da seriye ekle.
  set((state) => {
    const next: Record<string, { ts: number; value: number }[]> = {};
    for (const key of Object.keys(state.liveSeries)) next[key] = [...state.liveSeries[key]];
    for (const s of samples) {
      // Canlı ekranda ve türetilmiş metriklerde kullanılan hızlı kanallar.
      if (
        s.key !== 'gps_speed' &&
        s.key !== 'accel_magnitude' &&
        s.key !== 'mic_db' &&
        s.key !== 'order_half_ratio'
      )
        continue;
      const arr = next[s.key] ?? [];
      arr.push({ ts: s.ts, value: s.value });
      next[s.key] = arr.filter((p) => p.ts >= s.ts - 120_000);
    }
    return { liveSeries: next };
  });
}

/** Biriken log satırlarını DB'ye aktarır. Hata olursa satırlar kaybolur ama kayıt sürer. */
async function flushSessionLogs(): Promise<void> {
  if (loggingSessionId === null || pendingLogRows.length === 0) return;
  const sessionId = loggingSessionId;
  const rows = pendingLogRows;
  pendingLogRows = [];
  try {
    await repo.insertSessionLogs(sessionId, rows);
  } catch {
    // Log yazımı kaydın kendisini bozmamalı.
  }
}

/**
 * Kayıt sürerken ekranın kilitlenmesini engeller.
 *
 * Ekran kilidi = uygulama arka planda = kayıt durur. Kullanıcının bunu
 * bilerek yapması ayrı, telefonu cebe koyup 40 dakikalık bir sürüşün
 * yarısını kaybetmesi ayrı şeydir.
 *
 * `expo-keep-awake` doğrudan bağımlılık değil, `expo` paketiyle geliyor:
 * native tarafı mevcut derlemede yoksa require patlar ve HİÇBİR ŞEY
 * yapılmaz — kayıt bundan etkilenmemeli, bu yalnızca bir kolaylık.
 */
function keepScreenAwake(on: boolean): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('expo-keep-awake') as {
      activateKeepAwakeAsync?: (tag?: string) => Promise<void>;
      deactivateKeepAwake?: (tag?: string) => void;
    };
    if (on) void mod.activateKeepAwakeAsync?.('d50-recording');
    else mod.deactivateKeepAwake?.('d50-recording');
  } catch {
    /* native modül yoksa sessizce vazgeç */
  }
}

/**
 * Uygulama arka plana düştüğünde/döndüğünde oturum loguna iz bırakır ve
 * kayıp süreyi `recordingGaps`'e ekler.
 *
 * Yalnızca 'background' sayılıyor: iOS bildirim merkezi ya da gelen arama
 * bandı 'inactive' üretir, uygulama askıya alınmaz ve kayıt sürer. Onu da
 * delik saymak her denetim merkezi açılışında yanlış uyarı verirdi.
 */
function watchBackgroundGaps(
  set: (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void,
): void {
  stopWatchingBackgroundGaps();
  backgroundedAt = null;

  appStateSub = RNAppState.addEventListener('change', (next) => {
    if (next === 'background') {
      backgroundedAt = Date.now();
      appendLog(set, {
        ts: Date.now(),
        direction: 'info',
        text: 'App left the foreground',
      });
      return;
    }

    if (next === 'active' && backgroundedAt !== null) {
      const now = Date.now();
      const seconds = Math.round((now - backgroundedAt) / 1000);
      const at = backgroundedAt;
      backgroundedAt = null;
      // Bir saniyenin altındaki geçişler (uygulama değiştirici) delik değil.
      if (seconds < 1) return;

      /**
       * Arka planda örnek yazılmaya devam ettiyse delik YOKTUR.
       *
       * Arka plan modları açık bir derlemede kayıt sürüyor ve kullanıcı
       * haritaya bakabiliyor. "Arka plana düştün" ile "veri kaybettin"
       * aynı şey değil; ikincisini yalnızca örneklerin kesilmesi söyler.
       */
      const silentSeconds = Math.round((now - lastSampleAt) / 1000);
      if (lastSampleAt > 0 && silentSeconds <= 10) {
        appendLog(set, {
          ts: now,
          direction: 'info',
          text: `Back in the foreground — recording continued in the background for ${seconds} s`,
        });
        return;
      }

      appendLog(set, {
        ts: now,
        direction: 'error',
        text: `Back in the foreground — ${silentSeconds} s with no data recorded`,
      });
      set((state) => ({
        recordingGaps: [...state.recordingGaps, { at, seconds: silentSeconds }],
      }));
    }
  });
}

function stopWatchingBackgroundGaps(): void {
  appStateSub?.remove();
  appStateSub = null;
  backgroundedAt = null;
}

/**
 * Akü voltajını adaptörün kendi voltmetresinden okur (`ATRV`).
 *
 * Araca sorulmuyor: bu ECU control module voltage PID'ini desteklemiyor ve
 * desteklemeyen araçlarda o kanal sonsuza kadar boş kalır. Adaptör ise her
 * araçta ölçebiliyor, çünkü ölçtüğü şey soketin kendi beslemesi.
 *
 * 10 saniyede bir soruluyor: voltaj yavaş değişen bir büyüklük ve tur
 * kapasitesi kıt — bu ritimde PID'lerden çaldığı süre binde birkaç.
 */
const VOLTAGE_INTERVAL_MS = 10_000;

function startVoltagePolling(
  sessionId: number,
  startedAt: number,
  queue: CommandQueue,
  set: (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void,
): void {
  stopVoltagePolling();
  const read = async () => {
    try {
      const raw = await queue.send('ATRV');
      const volts = parseAdapterVoltage(raw);
      if (volts === null) return;
      await flushSensorSamples(
        sessionId,
        [{ key: 'battery_v', ts: Date.now() - startedAt, value: volts }],
        set,
      );
    } catch {
      // Voltaj okunamaması kaydı bozmamalı; sonraki turda tekrar denenir.
    }
  };
  void read();
  voltageTimer = setInterval(() => void read(), VOLTAGE_INTERVAL_MS);
}

function stopVoltagePolling(): void {
  if (voltageTimer) {
    clearInterval(voltageTimer);
    voltageTimer = null;
  }
}

function appendLog(
  set: (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void,
  entry: RawLogEntry,
): void {
  // Kayıt sürüyorsa satır oturumla birlikte kalıcılaşsın.
  if (loggingSessionId !== null) {
    pendingLogRows.push({ ts: entry.ts, direction: entry.direction, text: entry.text });
  }
  set((s) => {
    const next = [...s.rawLog, entry];
    return { rawLog: next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next };
  });
}

/**
 * Verilen transport'u sarmalayıp her send() çağrısının komutunu ve
 * cevabını (veya hatasını) debug log'a yazan bir ara katman döner.
 * Salt-okunurluk davranışını DEĞİŞTİRMEZ — transport.send() zaten kendi
 * içinde assertReadOnly() çağırıyor, bu sadece gözlemler.
 */
function loggingTransport(transport: ObdTransport, onEntry: (e: RawLogEntry) => void): ObdTransport {
  return {
    get state() {
      return transport.state;
    },
    connect: () => transport.connect(),
    disconnect: () => transport.disconnect(),
    onStateChange: (l) => transport.onStateChange(l),
    send: async (command: string, timeoutMs?: number) => {
      onEntry({ ts: Date.now(), direction: 'tx', text: command });
      try {
        const response = await transport.send(command, timeoutMs);
        onEntry({ ts: Date.now(), direction: 'rx', text: response.replace(/\r/g, '⏎') });
        return response;
      } catch (e) {
        onEntry({
          ts: Date.now(),
          direction: 'error',
          text: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    },
  };
}

export const ALL_PIDS = PIDS;
