/**
 * Cycle başına çıkarılan skaler ölçümler.
 *
 * NEDEN AYRI BİR KAVRAM: teşhisler tek bir kaydın içine bakıyor ve "şu an
 * iyi mi kötü mü" diyor. Trend ise aynı ölçümün ZAMAN İÇİNDE nereye
 * gittiğini soruyor, ve bunun ön şartı ölçümün her seferinde AYNI KOŞULDA
 * alınmış olması. Cycle o koşulu kuruyor; bu dosya da her cycle'dan
 * karşılaştırılabilir bir avuç sayı çıkarıyor.
 *
 * Her vital hangi ADIMDAN çıktığını biliyor. Adım atlandıysa vital
 * üretilmiyor — eksik bırakmak, farklı koşulda ölçülmüş bir sayıyı
 * seriye sokmaktan iyidir; ikincisi trendi sessizce bozar.
 *
 * Buradaki hiçbir fonksiyon "arıza" demiyor. Tek işleri, karşılaştırılabilir
 * bir sayı üretmek. Yorumu trend.ts ve teşhisler yapıyor.
 */

import type { SeriesMap, TimeSeriesPoint } from './derived';
import { idleSamples } from './derived';
import { MINI_R50, type VehicleProfile } from './vehicle';

/** Bir cycle adımının kayıt içindeki zaman aralığı (ms, oturum başına göre). */
export interface StepWindow {
  readonly stepId: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly skipped: boolean;
}

export interface Vital {
  readonly key: string;
  /** Kullanıcıya gösterilecek ad. */
  readonly label: string;
  readonly value: number;
  readonly unit: string;
  /** Hangi cycle adımından çıktığı — koşulun kimliği. */
  readonly stepId: string;
  /**
   * Artan değer iyiye mi gidiyor kötüye mi? Trend yorumu buna bakıyor:
   * "yükseliyor" tek başına iyi ya da kötü değil.
   */
  readonly betterWhen: 'higher' | 'lower' | 'stable';
}


/**
 * Vital'lerin TEK tanımı: etiket, birim, hangi yönün iyi olduğu.
 *
 * Tek yerde, çünkü bu bilgi hem çıkarımda hem raporda hem trend yorumunda
 * lazım. Bugün bu projede iki kez aynı hatayı düzelttik — aynı büyüklüğün
 * iki ayrı yerde tanımlanması, er geç iki farklı cevap üretiyor.
 */
export const VITAL_META: Readonly<
  Record<string, { label: string; unit: string; betterWhen: 'higher' | 'lower' | 'stable' }>
> = {
  battery_rest_v: { label: 'Battery resting voltage', unit: 'V', betterWhen: 'higher' },
  cold_idle_rpm_sd: { label: 'Cold idle stability', unit: 'rpm σ', betterWhen: 'lower' },
  warm_idle_rpm_sd: { label: 'Warm idle stability', unit: 'rpm σ', betterWhen: 'lower' },
  warm_idle_ltft: { label: 'Long term fuel trim at idle', unit: '%', betterWhen: 'stable' },
  warm_idle_map: { label: 'Idle manifold pressure', unit: 'kPa', betterWhen: 'lower' },
  o2_pre_switch_hz: { label: 'Pre-cat sensor switching rate', unit: 'Hz', betterWhen: 'higher' },
  catalyst_switch_ratio: { label: 'Converter oxygen storage', unit: 'ratio', betterWhen: 'lower' },
  charge_idle_drop_v: { label: 'Charging drop at idle', unit: 'V', betterWhen: 'lower' },
};

/** Kaydı VITAL_META'dan kuran yardımcı — etiket/birim tek kaynaktan gelsin. */
function vital(key: string, value: number, stepId: string): Vital | null {
  const meta = VITAL_META[key];
  if (!meta) return null;
  return { key, label: meta.label, value, unit: meta.unit, stepId, betterWhen: meta.betterWhen };
}

/** Seriyi bir adımın zaman penceresine kırpar. */
function within(series: readonly TimeSeriesPoint[], window: StepWindow): TimeSeriesPoint[] {
  return series.filter((p) => p.ts >= window.fromMs && p.ts <= window.toMs);
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Örneklem standart sapması (n-1) — teşhislerle aynı tahminci. */
function stdDev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values) as number;
  return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1));
}

/** 0.45 V çizgisini kaç kez geçtiği — histerezisli, gürültü sayılmasın diye. */
function countCrossings(series: readonly TimeSeriesPoint[]): number {
  let state: 'low' | 'high' | null = null;
  let count = 0;
  for (const p of series) {
    if (state !== 'high' && p.value > 0.5) {
      if (state !== null) count++;
      state = 'high';
    } else if (state !== 'low' && p.value < 0.4) {
      if (state !== null) count++;
      state = 'low';
    }
  }
  return count;
}

function spanSeconds(window: StepWindow): number {
  return Math.max(1, (window.toMs - window.fromMs) / 1000);
}

/**
 * Bir cycle'ın vitals'ını çıkarır.
 *
 * Ölçüm yapılamadıysa o vital hiç üretilmiyor: eksik bir nokta, yanlış
 * koşulda ölçülmüş bir noktadan daha dürüst.
 */
export function extractVitals(
  series: SeriesMap,
  windows: readonly StepWindow[],
  vehicle: VehicleProfile = MINI_R50,
): Vital[] {
  const out: Vital[] = [];
  const step = (id: string) => windows.find((w) => w.stepId === id && !w.skipped);

  const push = (v: Vital | null) => {
    if (v && Number.isFinite(v.value)) out.push(v);
  };

  // --- akü: kontak açık, motor kapalı. Yılın en dürüst voltaj ölçümü. ---
  const ignition = step('ignition');
  if (ignition) {
    const volts = within(series['battery_v'] ?? [], ignition).map((p) => p.value);
    const level = median(volts);
    if (level !== null && volts.length >= 2) {
      push(vital('battery_rest_v', level, 'ignition'));
    }
  }

  // --- soğuk rölanti: devir kararlılığı ve yakıt düzeltmesi ---
  const coldIdle = step('cold-idle');
  if (coldIdle) {
    const rpm = within(series['0C'] ?? [], coldIdle);
    const speed = within(series['0D'] ?? [], coldIdle);
    const idle = idleSamples(rpm, speed, vehicle).map((p) => p.value);
    const sd = stdDev(idle);
    if (sd !== null && idle.length >= 10) {
      push(vital('cold_idle_rpm_sd', sd, 'cold-idle'));
    }
  }

  // --- sıcak rölanti: soğuğun eşi. İkisinin FARKI ısınma davranışını verir. ---
  const warmIdle = step('warm-idle');
  if (warmIdle) {
    const rpm = within(series['0C'] ?? [], warmIdle);
    const speed = within(series['0D'] ?? [], warmIdle);
    const idle = idleSamples(rpm, speed, vehicle).map((p) => p.value);
    const sd = stdDev(idle);
    if (sd !== null && idle.length >= 10) {
      push(vital('warm_idle_rpm_sd', sd, 'warm-idle'));
    }

    const ltft = median(within(series['07'] ?? [], warmIdle).map((p) => p.value));
    if (ltft !== null) {
      push(vital('warm_idle_ltft', ltft, 'warm-idle'));
    }

    const map = median(within(series['0B'] ?? [], warmIdle).map((p) => p.value));
    if (map !== null) {
      push(vital('warm_idle_map', map, 'warm-idle'));
    }
  }

  // --- lambda sondası: cycle'ın dar kanal setinde ölçülebilir hâle gelen şey ---
  const o2 = step('o2');
  if (o2) {
    const pre = within(series['14'] ?? [], o2);
    const post = within(series['15'] ?? [], o2);
    const seconds = spanSeconds(o2);
    const preHz = countCrossings(pre) / seconds;
    /**
     * Nyquist kapısı burada da geçerli: örnekleme hızı geçiş hızının iki
     * katından azsa üretilen sayı sondayı değil poller'ı ölçer ve trende
     * sokulursa yıllarca yanlış bir çizgi çizer.
     */
    const preRate = pre.length > 1 ? (pre.length - 1) / seconds : 0;
    if (pre.length >= 20 && preRate >= 0.8) {
      push(vital('o2_pre_switch_hz', preHz, 'o2'));

      const preCount = countCrossings(pre);
      if (preCount >= 5) {
        push(vital('catalyst_switch_ratio', countCrossings(post) / preCount, 'o2'));
      }
    }
  }

  // --- şarj: rölanti ile seyir farkı. Kayış/alternatör yorulması burada. ---
  const cruise = step('cruise');
  if (cruise && warmIdle) {
    const idleV = median(within(series['battery_v'] ?? [], warmIdle).map((p) => p.value));
    const cruiseV = median(within(series['battery_v'] ?? [], cruise).map((p) => p.value));
    if (idleV !== null && cruiseV !== null) {
      push(vital('charge_idle_drop_v', cruiseV - idleV, 'cruise'));
    }
  }

  return out;
}

/**
 * Ölçümün alındığı koşul.
 *
 * Mevsim, trend analizinin en büyük düşmanı: ısınma süresi, akü voltajı ve
 * hava yoğunluğu dış sıcaklıkla değişir, ve kışın "kötüleşen" her şey
 * aslında kış olabilir. Bu araç ambient air temp PID'ini desteklemiyor
 * (0146 → yok), o yüzden SOĞUK çalıştırmadaki emme havası sıcaklığı vekil
 * olarak saklanıyor: motor daha ısınmadan emme havası dış havaya en yakın
 * olduğu andır.
 */
export function cycleContext(series: SeriesMap, windows: readonly StepWindow[]): string | null {
  const coldIdle = windows.find((w) => w.stepId === 'cold-idle' && !w.skipped);
  if (!coldIdle) return null;
  const iat = median(within(series['0F'] ?? [], coldIdle).map((p) => p.value));
  if (iat === null) return null;
  return JSON.stringify({ intakeAirC: Math.round(iat) });
}
