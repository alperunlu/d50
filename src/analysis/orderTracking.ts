/**
 * Motor order takibi — ses spektrumunu motor devrine bağlamak.
 *
 * FİKİR: Bir motorun çıkardığı sesin büyük kısmı krank dönüşünün tam
 * katlarındadır. Bu katlara "order" denir ve her birinin fiziksel bir
 * karşılığı vardır:
 *
 *   order 0.5 (ve 1.5, 2.5) → bir silindir İKİ TURDA BİR farklı davranıyor.
 *                             4 zamanlı motorda her silindir iki turda bir
 *                             ateşlediği için tekleyen/zayıf silindirin
 *                             imzası buradadır. Bu modülün varlık sebebi.
 *   order 1                 → dönel dengesizlik (kasnak, volan, debriyaj).
 *   order 2 (4 silindirde)  → ateşleme frekansı; normal yanmanın tabanı.
 *
 * Order k'nın frekansı: f = k · rpm / 60.
 * 4 silindir 4 zamanlıda ateşleme order'ı = silindir/2 = 2 → f = rpm/30.
 *
 * ÖLÇÜM DEĞİL ORAN: iOS ses oturumu otomatik kazanç uygular, mikrofon
 * kalibre değildir, telefonun konumu seviyeyi kaydırır. Bu yüzden mutlak
 * genlik hiçbir yerde teşhise girmiyor; her şey order'lar ARASI orandır —
 * kazanç ikisini birden aynı oranda kaydırdığı için oran sağlam kalır.
 *
 * SENKRONİZASYON SORUNU ve dürüst çözümü: Gerçek order takibi tako
 * sinyaliyle açısal yeniden örnekleme yapar. Bizim devrimiz K-line'dan
 * saniyede 1-3 kez geliyor. Bu yüzden yalnızca devrin pencere boyunca
 * SABİT kaldığı anlar kullanılıyor; devir süpürülürken order'lar bulanır
 * ve o pencereler `null` dönüyor. Ayrıca devir sesin kendisinden de
 * kestirilip OBD deviriyle karşılaştırılıyor — tutmuyorsa kilit yok demektir.
 *
 * Buradaki her şey SAF fonksiyon: sentetik motor sesiyle test ediliyor.
 */

import {
  magnitudeSpectrum,
  hannWindow,
  peakNear,
  dominantHzInBand,
  rms,
  rmsToDbfs,
} from './fft';
import { aWeightedDbfs } from './spl';

/** Analiz penceresi. 8 kHz'de 0.512 s → 1.95 Hz çözünürlük. */
export const ORDER_FFT_SIZE = 4096;
/** Hedef örnekleme hızı. 10. order 7000 rpm'de bile 1.2 kHz'in altında. */
export const ORDER_SAMPLE_RATE = 8000;

/** İzlenen order'lar. */
export const TRACKED_ORDERS = [0.5, 1, 1.5, 2, 2.5, 3, 4] as const;

export interface EngineLayout {
  readonly cylinders: number;
  /** 4 = dört zamanlı. */
  readonly strokes: number;
}

/** MINI R50 W10B16: 4 silindir, 4 zamanlı. */
export const R50_ENGINE: EngineLayout = { cylinders: 4, strokes: 4 };

/** Ateşleme order'ı: dört zamanlıda silindir sayısının yarısı. */
export function firingOrder(engine: EngineLayout = R50_ENGINE): number {
  return engine.strokes === 4 ? engine.cylinders / 2 : engine.cylinders;
}

export interface OrderFrameInput {
  /** Pencere örnekleri; uzunluğu 2'nin kuvveti olmalı. */
  readonly samples: ArrayLike<number>;
  readonly sampleRate: number;
  /** Pencere ortasına denk gelen OBD devri; yoksa null. */
  readonly rpm: number | null;
  /** Pencere boyunca devirdeki değişim (rpm). Büyükse order'lar bulanır. */
  readonly rpmSpread?: number | null;
  readonly engine?: EngineLayout;
}

export interface OrderFrame {
  /** Ham seviye (dBFS), ağırlıklamasız. */
  readonly levelDbfs: number;
  /**
   * A-ağırlıklı seviye (dBFS). Kalibrasyon eklenince dB(A) SPL oluyor —
   * desibelmetrelerin gösterdiği büyüklük budur (bkz. analysis/spl.ts).
   */
  readonly levelDbfsA: number;
  /** Sesten kestirilen devir — OBD deviriyle çapraz doğrulama için. */
  readonly audioRpm: number | null;
  /** Order genlikleri (order → genlik). Kilit yoksa null. */
  readonly orders: Readonly<Record<string, number>> | null;
  /** En güçlü yarım order / ateşleme order'ı. Tekleme göstergesi. */
  readonly halfOrderRatio: number | null;
  /** 1. order / ateşleme order'ı. Dengesizlik göstergesi. */
  readonly imbalanceRatio: number | null;
  /** Order çıkarımının güvenilir olup olmadığı. */
  readonly locked: boolean;
  /** Kilit yoksa nedeni — kullanıcıya ne yapması gerektiğini söyleyebilmek için. */
  readonly reason?: string;
}

/** Devir bu kadar oynadıysa pencere order analizi için kullanılamaz. */
const MAX_RPM_SPREAD = 100;
/** Ses devri ile OBD devri bu orandan fazla ayrışırsa kilit yok sayılır. */
const RPM_AGREEMENT_TOLERANCE = 0.12;

/**
 * Tek bir pencereyi analiz eder.
 *
 * Seviye HER ZAMAN hesaplanır (mikrofon çalışıyor mu sorusunun cevabı odur);
 * order'lar yalnızca devir kilidi varken.
 */
export function analyzeOrderFrame(input: OrderFrameInput): OrderFrame {
  const { samples, sampleRate, rpm, rpmSpread, engine = R50_ENGINE } = input;
  const n = samples.length;

  const levelDbfs = rmsToDbfs(rms(samples));
  const spectrum = magnitudeSpectrum(samples, hannWindow(n));
  // Aynı FFT hem order analizi hem gürültü ölçümü için kullanılıyor;
  // ikinci bir dönüşüm hesaplamaya gerek yok.
  const levelDbfsA = aWeightedDbfs(spectrum, sampleRate, n);
  const fOrder = firingOrder(engine);

  /**
   * Sesten devir kestirimi: ateşleme frekansı bandındaki en güçlü bileşen.
   * Bant, 500-7500 rpm aralığına karşılık geliyor.
   */
  const firingBandFrom = (500 / 60) * fOrder;
  const firingBandTo = (7500 / 60) * fOrder;
  const dominant = dominantHzInBand(spectrum, sampleRate, n, firingBandFrom, firingBandTo);
  const audioRpm = dominant ? (dominant.hz * 60) / fOrder : null;

  const noOrders = (reason: string): OrderFrame => ({
    levelDbfs,
    levelDbfsA,
    audioRpm,
    orders: null,
    halfOrderRatio: null,
    imbalanceRatio: null,
    locked: false,
    reason,
  });

  if (rpm === null && audioRpm === null) {
    return noOrders('No engine speed reference — neither OBD RPM nor a clear firing peak.');
  }

  if (rpmSpread !== null && rpmSpread !== undefined && rpmSpread > MAX_RPM_SPREAD) {
    return noOrders('Engine speed moved too much during the window — orders smear together.');
  }

  // OBD devri varsa referans odur (ölçüm), ses yalnızca doğrulama.
  const reference = rpm ?? (audioRpm as number);

  if (rpm !== null && audioRpm !== null) {
    const disagreement = Math.abs(audioRpm - rpm) / rpm;
    if (disagreement > RPM_AGREEMENT_TOLERANCE) {
      return noOrders(
        `Sound and OBD disagree on engine speed (${Math.round(audioRpm)} vs ${Math.round(rpm)} rpm) — the microphone is probably hearing something else.`,
      );
    }
  }

  if (reference < 400) return noOrders('Engine speed too low to resolve orders.');

  const orders: Record<string, number> = {};
  for (const k of TRACKED_ORDERS) {
    const hz = (k * reference) / 60;
    if (hz < 10 || hz > sampleRate / 2 - 20) continue;
    orders[String(k)] = peakNear(spectrum, hz, sampleRate, n, 2);
  }

  const firing = orders[String(fOrder)];
  if (!firing || firing <= 0) {
    return noOrders('The firing frequency itself is not visible — too quiet or too noisy.');
  }

  // Yarım order ailesi: 0.5, 1.5, 2.5. Bir silindir iki turda bir farklı
  // davranıyorsa enerji bunlara dağılır; en güçlüsü göstergedir.
  const halfFamily = [0.5, 1.5, 2.5]
    .map((k) => orders[String(k)])
    .filter((v): v is number => typeof v === 'number');
  const halfOrderRatio = halfFamily.length > 0 ? Math.max(...halfFamily) / firing : null;
  const firstOrder = orders['1'];
  const imbalanceRatio = typeof firstOrder === 'number' ? firstOrder / firing : null;

  return {
    levelDbfs,
    levelDbfsA,
    audioRpm,
    orders,
    halfOrderRatio,
    imbalanceRatio,
    locked: true,
  };
}

/**
 * Ses akışını sabit uzunlukta, örtüşmeli pencerelere böler.
 *
 * %50 örtüşme, pencere kenarına düşen olayların Hann penceresi tarafından
 * bastırılıp tamamen kaybolmasını engelliyor.
 */
export function* framesOf(
  buffer: ArrayLike<number>,
  frameSize: number,
  hop: number = frameSize / 2,
): Generator<Float64Array> {
  for (let start = 0; start + frameSize <= buffer.length; start += hop) {
    const frame = new Float64Array(frameSize);
    for (let i = 0; i < frameSize; i++) frame[i] = buffer[start + i];
    yield frame;
  }
}

/**
 * Örnekleme hızını tam sayı katıyla düşürür.
 *
 * Önce `factor` uzunluğunda ortalama alınıyor: doğrudan örnek atlamak,
 * yukarıdaki frekansları bandımıza katlayarak (aliasing) olmayan order'lar
 * uydururdu. Ortalama, kaba ama bu iş için yeterli bir alçak geçiren filtre.
 */
export function decimate(input: ArrayLike<number>, factor: number): Float64Array {
  if (factor <= 1) {
    const copy = new Float64Array(input.length);
    for (let i = 0; i < input.length; i++) copy[i] = input[i];
    return copy;
  }

  const outLength = Math.floor(input.length / factor);
  const out = new Float64Array(outLength);
  for (let i = 0; i < outLength; i++) {
    let sum = 0;
    for (let j = 0; j < factor; j++) sum += input[i * factor + j];
    out[i] = sum / factor;
  }
  return out;
}

/** Donanımın verdiği hızdan hedefe inmek için tam sayı bölen. */
export function decimationFactor(sourceRate: number, targetRate = ORDER_SAMPLE_RATE): number {
  return Math.max(1, Math.floor(sourceRate / targetRate));
}
