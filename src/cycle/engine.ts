/**
 * Cycle'ın durum makinesi. SAF: cihaz, store, RN yok.
 *
 * Girdi olarak canlı serileri ve şimdiki zamanı alır, "bu adım tamam mı,
 * değilse ne eksik" sorusunu cevaplar. Cihazsız test edilebilmesi önemli:
 * bir adımın ne zaman biteceği kuralı arabada denenerek değil, masada
 * doğrulanarak yazılmalı.
 */

import type { CycleStep, StepCondition } from './steps';

/** Kanal anahtarı -> zaman serisi (poller başlangıcına göre ms). */
export type LiveSeries = Readonly<Record<string, readonly { ts: number; value: number }[]>>;

export interface ConditionState {
  readonly label: string;
  /** Şu ANDA sağlanıyor mu. */
  readonly met: boolean;
  /** Kanalın son değeri — ekranda "hız 78 km/h" diye göstermek için. */
  readonly value: number | null;
}

export interface StepProgress {
  readonly conditions: readonly ConditionState[];
  /** Bütün koşullar kesintisiz sağlanarak geçen süre (sn). */
  readonly heldSeconds: number;
  /** 0..1 — süre hedefine göre. Hedefi olmayan adımda koşula göre 0 ya da 1. */
  readonly fraction: number;
  readonly complete: boolean;
  /**
   * Tamamlanmayı engelleyen tek cümle. Koşullar sağlanıyorsa `null`.
   * Sürücüye "neyi düzelt" demek için — ekranda emirle birlikte duruyor.
   */
  readonly blocker: string | null;
}

/**
 * Bir kanalın GÜNCEL son değeri. Seri boşsa ya da değer bayatsa `null`.
 *
 * Tazelik kontrolü isteğe bağlı bir titizlik değil. 7 Eylül 2026 saha
 * testinde ECU sustu ve `liveSeries` son gördüğü değerlerde dondu; kimse
 * onları temizlemedi çünkü temizleme yalnızca YENİ örnek geldiğinde
 * çalışıyor. Sonuç:
 *
 *   - "80 km/h'de sabit sür" adımı, donmuş bir `hız = 0` üstünde 8 dakika
 *     boyunca yeşillenmedi; sürücü gerçekten 80'de gidiyordu.
 *   - "Isınma sürüşü" adımı, veri kesildikten ÜÇ DAKİKA sonra donmuş bir
 *     soğutma suyu değeri üstünde sayaç işleterek "tamamlandı".
 *
 * Ölçmediğini bilmek, yanlış ölçmekten iyidir.
 */
const MAX_SAMPLE_AGE_MS = 5_000;

function freshValue(series: LiveSeries, channel: string, elapsedMs: number): number | null {
  const points = series[channel];
  if (!points || points.length === 0) return null;
  const last = points[points.length - 1];
  return elapsedMs - last.ts <= MAX_SAMPLE_AGE_MS ? last.value : null;
}

function conditionMet(condition: StepCondition, value: number | null): boolean {
  if (value === null) return false;
  if (condition.min !== undefined && value < condition.min) return false;
  if (condition.max !== undefined && value > condition.max) return false;
  return true;
}

/**
 * Adımın o anki durumu.
 *
 * `heldSince`: koşulların KESİNTİSİZ sağlanmaya başladığı an (epoch ms) ya
 * da `null`. Kesintisizlik şart: bir saniyeliğine 80 km/h'a değip geçmek
 * "bir dakika sabit hızda sürdüm" değildir, ve o farkı ölçüm görür.
 */
export function evaluateStep(
  step: CycleStep,
  series: LiveSeries,
  heldSince: number | null,
  now: number,
  /**
   * Kaydın başlangıcından beri geçen süre (ms) — örneklerin `ts` alanıyla
   * AYNI saat. Tazelik ancak aynı saatle ölçülebilir.
   */
  elapsedMs: number,
): StepProgress {
  const conditions: ConditionState[] = step.conditions.map((c) => {
    const value = freshValue(series, c.channel, elapsedMs);
    return { label: c.label, met: conditionMet(c, value), value };
  });

  const allMet = conditions.every((c) => c.met);
  const heldSeconds = allMet && heldSince !== null ? (now - heldSince) / 1000 : 0;

  // Süre hedefi olmayan adımlar (0-100 çekişi, coast down) koşul sağlanır
  // sağlanmaz biter: orada ölçülen şey süre değil olayın kendisi.
  const complete = step.holdSeconds > 0 ? allMet && heldSeconds >= step.holdSeconds : allMet;

  const fraction = step.holdSeconds > 0
    ? Math.min(1, heldSeconds / step.holdSeconds)
    : allMet
      ? 1
      : 0;

  const missing = conditions.filter((c) => !c.met);
  const blocker =
    missing.length === 0
      ? null
      : missing
          .map((c) => (c.value === null ? `no fresh data for ${c.label}` : `needs ${c.label}`))
          .join(', ');

  return { conditions, heldSeconds, fraction, complete, blocker };
}

/**
 * Koşulların kesintisiz sağlanma başlangıcını günceller.
 *
 * Ayrı tutuluyor çünkü `evaluateStep` saf kalmalı: aynı girdiyle çağrıldığında
 * aynı sonucu vermeli, kendi içinde zaman biriktirmemeli.
 */
export function nextHeldSince(
  progress: StepProgress,
  heldSince: number | null,
  now: number,
): number | null {
  const allMet = progress.conditions.every((c) => c.met);
  if (!allMet) return null;
  return heldSince ?? now;
}
