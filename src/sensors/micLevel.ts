/**
 * Mikrofon ses seviyesi ölçer.
 *
 * NE YAPAR: `expo-audio` kaydediciyi metering açık şekilde çalıştırır ve
 * durum nesnesinden yalnızca `metering` alanını (dBFS) periyodik okur.
 *
 * NE YAPMAZ — ve bu bilinçli:
 *   - Ses SAKLAMAZ. iOS'ta metering ancak aktif bir kayıt varken üretilir,
 *     bu yüzden geçici bir dosyaya kayıt açılıyor; `stop()` o dosyayı SİLER.
 *     Dosya hiçbir zaman okunmaz, paylaşılmaz, DB'ye girmez.
 *   - Spektrum/FFT yapmaz. `expo-audio` metering tek bir seviye sayısı verir,
 *     ham PCM vermez. "Motor order takibi" ancak ham PCM ile dürüstçe
 *     yapılabilirdi; seviye verisiyle taklidini yapmak yanıltıcı olurdu.
 *     Seviyeyle yapılabilecek gerçek şeyler analysis/diagnostics.ts'te.
 *
 * ÖLÇEK: dBFS, tipik olarak -160 (sessiz) ile 0 (kırpma) arası. Mutlak SPL
 * DEĞİL — telefonun otomatik kazancı ve konumu değeri kaydırır. Bu yüzden
 * teşhislerin hepsi FARKLAR üzerine kurulu, mutlak eşikler üzerine değil.
 */

/**
 * Native modül BİLEREK tembel yükleniyor — sensorLogger.ts'teki gerekçenin
 * aynısı: `expo-audio` OTA ile eski binary'ye inemez, top-level import
 * uygulamayı açılışta çökertirdi.
 */
type AudioModuleType = typeof import('expo-audio');

let audioModule: AudioModuleType | null = null;

function loadAudio(): AudioModuleType | null {
  if (audioModule) return audioModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    audioModule = require('expo-audio') as AudioModuleType;
    return audioModule;
  } catch {
    return null;
  }
}

/** Mikrofon native modülü bu binary'de var mı? */
export function isMicrophoneAvailable(): boolean {
  return loadAudio() !== null;
}

/** Mikrofon izni ister. Reddedilirse ses kanalı sessizce atlanır. */
export async function requestMicrophonePermission(): Promise<'granted' | 'denied' | 'unavailable'> {
  const Audio = loadAudio();
  if (!Audio) return 'unavailable';
  try {
    const { granted } = await Audio.requestRecordingPermissionsAsync();
    return granted ? 'granted' : 'denied';
  } catch {
    return 'unavailable';
  }
}

/** dBFS okumaları arasındaki varsayılan aralık — 5 Hz. */
const DEFAULT_INTERVAL_MS = 200;
/** Metering okunamadığında kullanılan taban (dBFS alt sınırı). */
export const MIC_FLOOR_DBFS = -160;

export interface MicLevelOptions {
  readonly intervalMs?: number;
  /** dBFS -> dB(A) SPL kalibrasyonu (yaklaşık; bu yolda ağırlıklama yok). */
  readonly getCalibrationDb?: () => number;
  readonly onError?: (message: string) => void;
}

/**
 * Kaydediciyi açar ve seviyeyi periyodik olarak dışarı verir.
 *
 * Tek sorumluluğu bu: örnekleri nereye yazacağını bilmez, `SensorLogger`
 * onu OBD ile aynı zaman eksenine bağlar.
 */
export class MicLevelMeter {
  private recorder: { record: () => void; stop: () => Promise<void>; prepareToRecordAsync: (o?: unknown) => Promise<void>; getStatus: () => { metering?: number }; uri: string | null; release?: () => void } | null =
    null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly opts: MicLevelOptions = {}) {}

  async start(onLevel: (dbfs: number) => void): Promise<boolean> {
    if (this.running) return true;

    const Audio = loadAudio();
    if (!Audio) {
      this.opts.onError?.('Audio module not available in this build');
      return false;
    }

    try {
      // iOS'ta kayıt için ses oturumunun kayda izin vermesi gerekiyor.
      await Audio.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });

      // Düşük kalite bilerek: dosya zaten silinecek, tek istediğimiz seviye.
      // Küçük dosya = az disk, az pil.
      const recorder = new Audio.AudioModule.AudioRecorder({});
      await recorder.prepareToRecordAsync({
        ...Audio.RecordingPresets.LOW_QUALITY,
        isMeteringEnabled: true,
      });
      recorder.record();
      this.recorder = recorder as unknown as MicLevelMeter['recorder'];
      this.running = true;

      this.timer = setInterval(() => {
        try {
          const status = this.recorder?.getStatus();
          const metering = status?.metering;
          if (typeof metering === 'number' && Number.isFinite(metering)) {
            onLevel(metering);
          }
        } catch {
          // Tek bir okuma hatası kaydı bozmamalı — sessizce atlanır.
        }
      }, this.opts.intervalMs ?? DEFAULT_INTERVAL_MS);

      return true;
    } catch (e) {
      this.opts.onError?.(`Microphone unavailable: ${e instanceof Error ? e.message : String(e)}`);
      await this.cleanup();
      return false;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.cleanup();
  }

  /** Kaydı durdurur ve geçici ses dosyasını SİLER. */
  private async cleanup(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const recorder = this.recorder;
    this.recorder = null;
    if (!recorder) return;

    let uri: string | null = null;
    try {
      uri = recorder.uri;
      await recorder.stop();
      uri = recorder.uri ?? uri;
    } catch {
      // Durdurma hatası dosyayı silmemizi engellememeli.
    }

    if (uri) await deleteFile(uri);

    try {
      recorder.release?.();
    } catch {
      /* boş */
    }
  }
}

/**
 * Geçici ses dosyasını siler.
 *
 * `expo-file-system` de tembel yükleniyor: bu modülün tamamı native modül
 * olmayan bir binary'de sessizce devre dışı kalabilmeli.
 */
async function deleteFile(uri: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const FS = require('expo-file-system') as typeof import('expo-file-system');
    const file = new FS.File(uri);
    if (file.exists) file.delete();
  } catch {
    // Silinemezse de ses hiçbir yere gönderilmiyor; sessizce geçiyoruz.
  }
}
