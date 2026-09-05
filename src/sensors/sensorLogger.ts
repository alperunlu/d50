/**
 * Telefon sensörlerini OBD verisiyle aynı örnek akışına besleyen katman.
 *
 * Tasarım kararı: sensör örnekleri ayrı bir tabloya değil, `samples`
 * tablosuna `Channel.key` anahtarıyla yazılır (bkz. data/channels.ts).
 * Böylece grafik, CSV, oturum yönetimi hiç değişmeden sensörleri de kapsar.
 *
 * Zaman ekseni OBD ile ORTAK: `startedAt` poller ile aynı referans olduğu
 * için CSV'de aynı satıra düşerler — 0-100 ölçümü, eğim düzeltmesi gibi
 * birleşik metriklerin çalışabilmesi buna bağlı.
 *
 * ÖNEMLİ (dürüstlük notu): ivmeölçer telefonun KENDİ eksenlerinde ölçer.
 * Telefon araca nasıl yerleştirildiği bilinmeden "boyuna ivme" hesaplamak
 * yanıltıcı olur. Bu yüzden ham eksenler + toplam büyüklük loglanıyor;
 * boyuna ivme, yönelimden bağımsız olan hız türevinden (GPS/OBD) elde
 * ediliyor (bkz. analysis/derived.ts). Eksen kalibrasyonu ileride eklenebilir.
 */

/**
 * Native modüller BİLEREK tembel (lazy) yükleniyor.
 *
 * `expo-location` ve `expo-sensors` native modüldür; OTA güncellemesi bunları
 * mevcut binary'ye ekleyemez. Top-level import olsalardı, sensör kodu içeren
 * bir OTA eski binary'de uygulamayı AÇILIŞTA çökertirdi. Bu şekilde ise
 * kullanıcı sensörleri açmaya çalışana kadar hiç dokunulmuyor; native modül
 * yoksa temiz bir "sensors unavailable" mesajı veriliyor ve uygulamanın geri
 * kalanı çalışmaya devam ediyor.
 */
import { MicLevelMeter } from './micLevel';
import { EngineSoundListener, isAudioStreamAvailable } from './engineSound';
import { DEFAULT_SPL_CALIBRATION_DB } from '../analysis/spl';
import type { SensorGroupKey } from '../data/channels';

type LocationModule = typeof import('expo-location');
type SensorsModule = typeof import('expo-sensors');

let locationModule: LocationModule | null = null;
let sensorsModule: SensorsModule | null = null;

function loadLocation(): LocationModule | null {
  if (locationModule) return locationModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    locationModule = require('expo-location') as LocationModule;
    return locationModule;
  } catch {
    return null;
  }
}

function loadSensors(): SensorsModule | null {
  if (sensorsModule) return sensorsModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sensorsModule = require('expo-sensors') as SensorsModule;
    return sensorsModule;
  } catch {
    return null;
  }
}

/** Sensör native modülleri bu binary'de var mı? */
export function areSensorModulesAvailable(): boolean {
  return loadLocation() !== null || loadSensors() !== null;
}

export interface SensorSample {
  /** Kanal anahtarı (`gps_speed`, `accel_x` ...). */
  readonly key: string;
  /** Oturum başlangıcına göre ms. */
  readonly ts: number;
  readonly value: number;
}

export interface SensorLoggerOptions {
  /** Örnekleri dışarı veren callback (store bunu DB'ye yazar). */
  readonly onSamples: (samples: SensorSample[]) => void;
  /**
   * Çalıştırılacak sensör grupları — kullanıcının kanal seçim ekranında
   * işaretledikleri. Seçilmeyen donanım hiç açılmaz: GPS ve mikrofon pil
   * yakar, istenmeyen bir sensörü "nasılsa açık" diye çalıştırmak doğru olmaz.
   */
  readonly groups: readonly SensorGroupKey[];
  /**
   * O anki OBD devri. Order analizinin referansı — devir bilinmeden ses
   * spektrumundan order çıkarılamaz (bkz. analysis/orderTracking.ts).
   */
  readonly getRpm?: () => number | null;
  /** dBFS -> dB(A) SPL kalibrasyonu (bkz. analysis/spl.ts). */
  readonly getCalibrationDb?: () => number;
  /** Zaman ekseni referansı — poller ile AYNI olmalı. */
  readonly startedAt: number;
  /** İvmeölçer örnekleme aralığı (ms). Varsayılan 100ms = 10Hz. */
  readonly accelIntervalMs?: number;
  readonly onError?: (message: string) => void;
}

export type SensorPermission = 'granted' | 'denied' | 'unavailable';

export { isMicrophoneAvailable, requestMicrophonePermission } from './micLevel';

const DEFAULT_ACCEL_INTERVAL_MS = 100;
/** Örnekler bu aralıkla toplu verilir — örnek başına DB yazımı pahalı. */
const FLUSH_INTERVAL_MS = 1000;

/** Konum izni ister. Kullanıcı reddederse sensörsüz devam edilir. */
export async function requestLocationPermission(): Promise<SensorPermission> {
  const Location = loadLocation();
  if (!Location) return 'unavailable';
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    return status === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'unavailable';
  }
}

export async function isAccelerometerAvailable(): Promise<boolean> {
  const Sensors = loadSensors();
  if (!Sensors) return false;
  try {
    return await Sensors.Accelerometer.isAvailableAsync();
  } catch {
    return false;
  }
}

/**
 * GPS + ivmeölçer verisini toplayıp periyodik olarak dışarı veren logger.
 * OBD poller'ından bağımsız çalışır; ikisi aynı zaman referansını paylaşır.
 */
export class SensorLogger {
  private locationSub: { remove: () => void } | null = null;
  private accelSub: { remove: () => void } | null = null;
  private mic: MicLevelMeter | null = null;
  private engineSound: EngineSoundListener | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private buffer: SensorSample[] = [];
  private running = false;

  /** Son konum — mesafe ve eğim hesabı için (bkz. analysis/derived.ts). */
  lastPosition: { latitude: number; longitude: number; altitude: number | null } | null = null;

  constructor(private readonly opts: SensorLoggerOptions) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);

    if (this.opts.groups.includes('gps')) await this.startLocation();
    if (this.opts.groups.includes('motion')) this.startAccelerometer();
    if (this.opts.groups.includes('mic')) await this.startMicrophone();
  }

  /**
   * Mikrofon. İki yol var, sırayla deneniyor:
   *
   * 1. Ham PCM akışı (`EngineSoundListener`) — hem ses seviyesini hem
   *    order analizini verir, üstelik diske hiç ses yazmaz. Tercih edilen.
   * 2. Metering'li kayıt (`MicLevelMeter`) — yalnızca seviye. Ham akış
   *    çalışmazsa buna düşülüyor: seviyesiz kalmaktansa order'sız kalmak
   *    yeğdir, ve arabaya ikinci kez gitmek pahalı.
   *
   * Hiçbir durumda ses saklanmıyor.
   */
  private async startMicrophone(): Promise<void> {
    if (isAudioStreamAvailable()) {
      this.engineSound = new EngineSoundListener({
        getRpm: () => this.opts.getRpm?.() ?? null,
        getCalibrationDb: () =>
          this.opts.getCalibrationDb?.() ?? DEFAULT_SPL_CALIBRATION_DB,
        onSamples: (samples) => {
          const ts = Date.now() - this.opts.startedAt;
          for (const s of samples) this.push({ key: s.key, ts, value: s.value });
        },
        onError: (m) => this.opts.onError?.(m),
        onNote: (m) => this.opts.onError?.(`Order tracking: ${m}`),
      });
      if (await this.engineSound.start()) return;
      this.engineSound = null;
    }

    this.opts.onError?.('Falling back to level-only microphone (no order tracking)');
    this.mic = new MicLevelMeter({ onError: (m) => this.opts.onError?.(m) });
    await this.mic.start((dbfs) => {
      this.push({ key: 'mic_db', ts: Date.now() - this.opts.startedAt, value: dbfs });
    });
  }

  private async startLocation(): Promise<void> {
    const Location = loadLocation();
    if (!Location) {
      this.opts.onError?.('Location module not available in this build');
      return;
    }
    try {
      this.locationSub = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 1000,
          distanceInterval: 0,
        },
        (position) => {
          const ts = Date.now() - this.opts.startedAt;
          const { coords } = position;

          // expo-location hızı m/s verir; km/h'ye çeviriyoruz ki OBD hızıyla
          // aynı birimde olsun ve doğrudan karşılaştırılabilsin.
          if (typeof coords.speed === 'number' && coords.speed >= 0) {
            this.push({ key: 'gps_speed', ts, value: coords.speed * 3.6 });
          }
          if (typeof coords.altitude === 'number') {
            this.push({ key: 'gps_altitude', ts, value: coords.altitude });
          }
          if (typeof coords.accuracy === 'number') {
            this.push({ key: 'gps_accuracy', ts, value: coords.accuracy });
          }
          if (typeof coords.heading === 'number' && coords.heading >= 0) {
            this.push({ key: 'gps_heading', ts, value: coords.heading });
          }

          this.lastPosition = {
            latitude: coords.latitude,
            longitude: coords.longitude,
            altitude: typeof coords.altitude === 'number' ? coords.altitude : null,
          };
        },
      );
    } catch (e) {
      this.opts.onError?.(`GPS unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private startAccelerometer(): void {
    const Sensors = loadSensors();
    if (!Sensors) {
      this.opts.onError?.('Sensors module not available in this build');
      return;
    }

    try {
      Sensors.Accelerometer.setUpdateInterval(this.opts.accelIntervalMs ?? DEFAULT_ACCEL_INTERVAL_MS);
      this.accelSub = Sensors.Accelerometer.addListener(({ x, y, z }) => {
        const ts = Date.now() - this.opts.startedAt;
        this.push({ key: 'accel_x', ts, value: x });
        this.push({ key: 'accel_y', ts, value: y });
        this.push({ key: 'accel_z', ts, value: z });
        this.push({ key: 'accel_magnitude', ts, value: Math.sqrt(x * x + y * y + z * z) });
      });
    } catch (e) {
      this.opts.onError?.(`Accelerometer unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  stop(): void {
    this.running = false;
    void this.mic?.stop();
    this.mic = null;
    this.engineSound?.stop();
    this.engineSound = null;
    this.locationSub?.remove();
    this.locationSub = null;
    this.accelSub?.remove();
    this.accelSub = null;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  private push(sample: SensorSample): void {
    if (!this.running) return;
    this.buffer.push(sample);
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    this.opts.onSamples(batch);
  }
}
