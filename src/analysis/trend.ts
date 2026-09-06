/**
 * Bir vital'in zaman içindeki kayması.
 *
 * "Predictive maintenance" adı altında yapılabilecek DÜRÜST şey budur:
 * kalan ömür tahmini değil — onun için binlerce aracın arıza-zaman verisi
 * gerekir, elimizde bir araç var — aracın KENDİ TABAN ÇİZGİSİNE göre
 * kayması. Arıza lambası yanmadan haftalar önce görünen şey de bu.
 *
 * Üç kural, üçü de yanlış alarmı önlemek için:
 *
 *   1. TABAN ÇİZGİSİ olmadan hüküm yok. İki noktadan eğim çıkarmak
 *      sahtekârlıktır; en az beş ölçüm birikene kadar kart "taban çizgisi
 *      kuruluyor" der.
 *   2. Eğim ROBUST hesaplanır (Theil-Sen: bütün nokta çiftlerinin
 *      eğimlerinin ortancası). Tek bir kötü cycle en küçük kareler
 *      regresyonunu sürükler, ortancayı sürükleyemez.
 *   3. Kayma, ÖLÇÜM GÜRÜLTÜSÜNÜ aşmalı. Taban çizgisinin kendi içindeki
 *      saçılım gürültünün ölçüsüdür; kayma onun altındaysa haber değildir.
 */

export interface VitalPoint {
  /** Ölçümün alındığı an (epoch ms). */
  readonly at: number;
  readonly value: number;
}

export type TrendVerdict = 'baseline' | 'stable' | 'improving' | 'drifting';

export interface Trend {
  readonly verdict: TrendVerdict;
  /** Taban çizgisi — ilk ölçümlerin ortancası. */
  readonly baseline: number | null;
  /** En son ölçüm. */
  readonly latest: number | null;
  /** Taban çizgisine göre değişim (mutlak, vital'in birimiyle). */
  readonly change: number | null;
  /** Ayda birim cinsinden robust eğim. */
  readonly slopePerMonth: number | null;
  /** Taban çizgisinin saçılımı — gürültünün ölçüsü. */
  readonly noise: number | null;
  /** Kaç ölçüm daha gerektiği (taban çizgisi kurulurken). */
  readonly needMore: number;
}

/** Taban çizgisi için gereken en az ölçüm sayısı. */
const BASELINE_POINTS = 3;
/** Hüküm verebilmek için gereken toplam ölçüm sayısı. */
const MIN_POINTS = 5;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Ortancadan mutlak sapmaların ortancası — aykırı değerden etkilenmeyen saçılım. */
function medianAbsoluteDeviation(values: readonly number[]): number | null {
  const m = median(values);
  if (m === null) return null;
  return median(values.map((v) => Math.abs(v - m)));
}

/**
 * Theil-Sen eğimi: bütün nokta çiftlerinin eğimlerinin ortancası.
 * Birim: değer / ay.
 */
function robustSlopePerMonth(points: readonly VitalPoint[]): number | null {
  const slopes: number[] = [];
  const MONTH_MS = 30 * 24 * 3600 * 1000;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dt = (points[j].at - points[i].at) / MONTH_MS;
      if (dt <= 0) continue;
      slopes.push((points[j].value - points[i].value) / dt);
    }
  }
  return median(slopes);
}

/**
 * Bir vital'in geçmişinden trend çıkarır.
 *
 * `betterWhen` yönü yorumu belirliyor: rölanti sapmasının yükselmesi kötü,
 * sonda geçiş hızının yükselmesi iyidir. "Yükseliyor" tek başına bir şey
 * söylemez.
 */
export function analyseTrend(
  history: readonly VitalPoint[],
  betterWhen: 'higher' | 'lower' | 'stable',
): Trend {
  const points = [...history].sort((a, b) => a.at - b.at);

  if (points.length < MIN_POINTS) {
    const baseline =
      points.length >= BASELINE_POINTS
        ? median(points.slice(0, BASELINE_POINTS).map((p) => p.value))
        : null;
    return {
      verdict: 'baseline',
      baseline,
      latest: points.length > 0 ? points[points.length - 1].value : null,
      change: null,
      slopePerMonth: null,
      noise: null,
      needMore: MIN_POINTS - points.length,
    };
  }

  const baselineValues = points.slice(0, BASELINE_POINTS).map((p) => p.value);
  const baseline = median(baselineValues) as number;
  const latest = points[points.length - 1].value;
  const change = latest - baseline;
  const slopePerMonth = robustSlopePerMonth(points);

  /**
   * Gürültü tabanı. Taban çizgisi noktalarının saçılımı sıfır çıkabilir
   * (üç ölçüm de aynıysa), o yüzden değerin kendi büyüklüğünün %2'si alt
   * sınır olarak kullanılıyor: hiçbir ölçüm sonsuz hassas değildir.
   */
  const spread = medianAbsoluteDeviation(baselineValues) ?? 0;
  const noise = Math.max(spread * 2, Math.abs(baseline) * 0.02);

  if (Math.abs(change) <= noise) {
    return { verdict: 'stable', baseline, latest, change, slopePerMonth, noise, needMore: 0 };
  }

  if (betterWhen === 'stable') {
    // Yönü olmayan ölçümlerde her iki taraf da kaymadır (ör. yakıt trimi).
    return { verdict: 'drifting', baseline, latest, change, slopePerMonth, noise, needMore: 0 };
  }

  const worsening = betterWhen === 'higher' ? change < 0 : change > 0;
  return {
    verdict: worsening ? 'drifting' : 'improving',
    baseline,
    latest,
    change,
    slopePerMonth,
    noise,
    needMore: 0,
  };
}
