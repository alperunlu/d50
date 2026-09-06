/**
 * Motor sesi dinleyicisi — ham PCM'i order analizine bağlayan katman.
 *
 * `expo-audio`'nun `AudioStream` sınıfı mikrofondan gerçek zamanlı float32
 * PCM veriyor. Buradaki iş şu: gelen tamponları hedef örnekleme hızına
 * indirmek, sabit uzunlukta pencerelere bölmek, her pencereyi o anki OBD
 * devriyle birlikte `analyzeOrderFrame`'e vermek ve çıkan sayıları
 * kanal örneği olarak dışarı aktarmak.
 *
 * SES SAKLANMIYOR. Bu yol metering'li kayıttan daha temiz: dosya hiç
 * açılmıyor, PCM yalnızca bellekte pencere pencere işlenip atılıyor.
 * Diske hiçbir ses yazılmıyor.
 *
 * Analizin kendisi burada DEĞİL: bu dosya I/O yapar, matematik
 * analysis/orderTracking.ts ve analysis/fft.ts içinde ve saf.
 */

import {
  analyzeOrderFrame,
  decimate,
  decimationFactor,
  ORDER_FFT_SIZE,
  ORDER_SAMPLE_RATE,
  R50_ENGINE,
  type EngineLayout,
} from '../analysis/orderTracking';
import { dbfsToSpl } from '../analysis/spl';
import { extentOf } from '../util/agg';

/** Native modül tembel yükleniyor — bkz. micLevel.ts'teki gerekçe. */
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

/** Bu binary ham PCM akışını destekliyor mu? */
export function isAudioStreamAvailable(): boolean {
  const Audio = loadAudio();
  if (!Audio) return false;
  // Eski bir expo-audio sürümünde AudioStream bulunmayabilir; sessiz
  // çökmek yerine seviye ölçüme geri düşebilmek için burada kontrol ediliyor.
  return typeof (Audio.AudioModule as { AudioStream?: unknown })?.AudioStream === 'function';
}

export interface EngineSoundSample {
  readonly key: string;
  readonly value: number;
}

export interface EngineSoundOptions {
  /** O anki OBD devri — order analizinin referansı. */
  readonly getRpm: () => number | null;
  /**
   * dBFS -> dB(A) SPL kalibrasyonu. Fonksiyon olarak alınıyor ki
   * kullanıcı ölçüm sürerken kalibrasyonu değiştirdiğinde anında
   * geçerli olsun.
   */
  readonly getCalibrationDb: () => number;
  /** Her analiz penceresinin sonuçları. */
  readonly onSamples: (samples: EngineSoundSample[]) => void;
  readonly engine?: EngineLayout;
  readonly onError?: (message: string) => void;
  /** Kilit kurulamadığında sebebini bildirir (debug log'una düşer). */
  readonly onNote?: (message: string) => void;
}

const HOP = ORDER_FFT_SIZE / 2;

interface StreamHandle {
  start: () => Promise<void>;
  stop: () => void;
  addListener: (event: string, cb: (payload: unknown) => void) => { remove: () => void };
  release?: () => void;
}

export class EngineSoundListener {
  private stream: StreamHandle | null = null;
  private subscription: { remove: () => void } | null = null;
  /** Hedef hıza indirilmiş, henüz pencerelenmemiş örnekler. */
  private pending: number[] = [];
  /** Decimation artığı — tamponlar arasında sürekliliği korur. */
  private carry: number[] = [];
  private sourceRate = 0;
  private running = false;

  /**
   * Pencere boyunca görülen devirler. Order analizi devrin sabit olmasını
   * gerektirdiği için min/max farkı pencereyle birlikte gönderiliyor.
   */
  private rpmWindow: number[] = [];
  /** Kilit reddi sebebi tekrar tekrar loglanmasın diye son sebep. */
  private lastReason: string | null = null;

  constructor(private readonly opts: EngineSoundOptions) {}

  async start(): Promise<boolean> {
    if (this.running) return true;

    const Audio = loadAudio();
    if (!Audio || !isAudioStreamAvailable()) {
      this.opts.onError?.('Raw audio stream not available in this build');
      return false;
    }

    try {
      await Audio.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });

      const AudioStreamCtor = (
        Audio.AudioModule as unknown as {
          AudioStream: new (o: { sampleRate: number; channels: number; encoding: string }) => StreamHandle;
        }
      ).AudioStream;

      const stream = new AudioStreamCtor({
        sampleRate: ORDER_SAMPLE_RATE,
        channels: 1,
        encoding: 'float32',
      });

      this.subscription = stream.addListener('audioStreamBuffer', (payload) => {
        this.onBuffer(payload as { data: ArrayBuffer; sampleRate: number; channels: number });
      });

      await stream.start();
      this.stream = stream;
      this.running = true;
      return true;
    } catch (e) {
      this.opts.onError?.(
        `Engine sound listener failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      this.stop();
      return false;
    }
  }

  stop(): void {
    this.running = false;
    this.subscription?.remove();
    this.subscription = null;
    try {
      this.stream?.stop();
      this.stream?.release?.();
    } catch {
      /* durdurma hatası kaydı bozmamalı */
    }
    this.stream = null;
    this.pending = [];
    this.carry = [];
    this.rpmWindow = [];
  }

  /**
   * Gelen PCM tamponu: çok kanallıysa tek kanala indir, hedef hıza
   * decimate et, pencere dolunca analiz et.
   */
  private onBuffer(buffer: { data: ArrayBuffer; sampleRate: number; channels: number }): void {
    if (!this.running) return;

    try {
      const raw = new Float32Array(buffer.data);
      const channels = Math.max(1, buffer.channels || 1);
      this.sourceRate = buffer.sampleRate || ORDER_SAMPLE_RATE;

      // Çok kanallı gelirse kanalları ortalayarak mono'ya indir.
      const mono: number[] = [];
      for (let i = 0; i + channels - 1 < raw.length; i += channels) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += raw[i + c];
        mono.push(sum / channels);
      }

      const factor = decimationFactor(this.sourceRate);
      // Artıkla birleştir: tampon sınırında örnek kaybetmemek için.
      const merged = this.carry.concat(mono);
      const usable = Math.floor(merged.length / factor) * factor;
      this.carry = merged.slice(usable);

      const decimated = decimate(merged.slice(0, usable), factor);
      for (let i = 0; i < decimated.length; i++) this.pending.push(decimated[i]);

      const rpm = this.opts.getRpm();
      if (rpm !== null) this.rpmWindow.push(rpm);

      while (this.pending.length >= ORDER_FFT_SIZE) {
        this.analyzeWindow();
        this.pending = this.pending.slice(HOP);
      }
    } catch (e) {
      this.opts.onError?.(`Audio buffer error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private analyzeWindow(): void {
    const frame = new Float64Array(ORDER_FFT_SIZE);
    for (let i = 0; i < ORDER_FFT_SIZE; i++) frame[i] = this.pending[i];

    const rpms = this.rpmWindow;
    const rpm = rpms.length > 0 ? rpms[rpms.length - 1] : this.opts.getRpm();
    const rpmExtent = rpms.length > 1 ? extentOf(rpms) : null;
    const spread = rpmExtent ? rpmExtent.max - rpmExtent.min : null;
    this.rpmWindow = rpm !== null && rpm !== undefined ? [rpm] : [];

    const result = analyzeOrderFrame({
      samples: frame,
      sampleRate: this.sourceRate >= ORDER_SAMPLE_RATE ? ORDER_SAMPLE_RATE : this.sourceRate,
      rpm: rpm ?? null,
      rpmSpread: spread,
      engine: this.opts.engine ?? R50_ENGINE,
    });

    // Kanal artık dB(A) SPL taşıyor — desibelmetrenin gösterdiği büyüklük.
    const samples: EngineSoundSample[] = [
      { key: 'mic_db', value: dbfsToSpl(result.levelDbfsA, this.opts.getCalibrationDb()) },
    ];

    if (result.audioRpm !== null) samples.push({ key: 'audio_rpm', value: result.audioRpm });

    if (result.locked) {
      if (result.halfOrderRatio !== null) {
        samples.push({ key: 'order_half_ratio', value: result.halfOrderRatio });
      }
      if (result.imbalanceRatio !== null) {
        samples.push({ key: 'order_1_ratio', value: result.imbalanceRatio });
      }
      this.lastReason = null;
    } else if (result.reason && result.reason !== this.lastReason) {
      // Aynı sebebi saniyede dört kez loglamak debug dosyasını boğardı;
      // yalnızca sebep DEĞİŞTİĞİNDE yazılıyor.
      this.lastReason = result.reason;
      this.opts.onNote?.(result.reason);
    }

    this.opts.onSamples(samples);
  }
}
