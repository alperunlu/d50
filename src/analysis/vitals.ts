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
import { idleSamples, idleStabilityRpm, valueAtOrBefore } from './derived';
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
    const idle = idleSamples(rpm, speed, vehicle);
    const sd = idleStabilityRpm(idle);
    if (sd !== null && idle.length >= 10) {
      push(vital('cold_idle_rpm_sd', sd, 'cold-idle'));
    }
  }

  // --- sıcak rölanti: soğuğun eşi. İkisinin FARKI ısınma davranışını verir. ---
  const warmIdle = step('warm-idle');
  if (warmIdle) {
    const rpm = within(series['0C'] ?? [], warmIdle);
    const speed = within(series['0D'] ?? [], warmIdle);
    const idle = idleSamples(rpm, speed, vehicle);
    const sd = idleStabilityRpm(idle);
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
 * ---------------------------------------------------------------------------
 * Sıradan sürüşten koşul penceresi çıkarma
 * ---------------------------------------------------------------------------
 *
 * NEDEN: yukarıdaki her şey cycle adımlarına bağlıydı, ve cycle ayda bir
 * yapılıyor. Oysa trendin ihtiyaç duyduğu şey cycle DEĞİL, koşulun aynı
 * olması. Sıcak rölanti her kırmızı ışıkta oluyor; soğuk rölanti günün ilk
 * çalıştırmasında; kontak-açık-motor-kapalı, kayda motoru çalıştırmadan
 * başlandığı her seferde. Bunlar cycle'ın kurduğu koşullar değil, cycle'ın
 * BEKLEDİĞİ koşullar — ve verinin içinde zaten varlar.
 *
 * Bu yüzden burada adım sınırlarını kullanıcıdan değil VERİDEN çıkarıyoruz.
 * Çıkan pencereler `extractVitals`'a aynı `StepWindow` olarak giriyor; o
 * fonksiyon değişmiyor, çünkü pencerenin nasıl bulunduğu onu ilgilendirmez.
 *
 * DÜRÜSTLÜK NOTU — bunun bedeli var: cycle adımında klima kapalı, yol düz ve
 * sürücü gaza dokunmuyor; kırmızı ışıkta bunların hiçbiri garanti değil.
 * Yani fırsatçı pencereler cycle adımlarından DAHA GÜRÜLTÜLÜDÜR. Buna
 * rağmen değer: trend.ts'in gürültü tabanı (taban çizgisinin kendi
 * saçılımı) saçılmayı zaten soğuruyor ve beş nokta alt sınırı erken hüküm
 * vermeyi engelliyor, ama nokta sayısı ayda birden haftada beşe çıkıyor.
 * Gürültü artışı sabit, veri artışı çarpan.
 *
 * Lambda vitalleri buradan ÇIKMAZ ve bu bir eksik değil: `extractVitals`
 * içindeki Nyquist kapısı sondanın en az 0.8 Hz örneklenmesini istiyor,
 * 28 kanallık normal bir turda bu asla sağlanmaz. Kapı kendiliğinden
 * kapanıyor — burada ayrıca engellemeye gerek yok, ve engellememek daha
 * doğru: kanal seti bir gün daralırsa ölçüm kendiliğinden mümkün olur.
 */

/** İki örnek arası bu kadar boşluk varsa koşu KESİLMİŞ sayılır. */
const RUN_GAP_MS = 5_000;
/** Başka bir kanalın değeri bu kadar eskiyse "bilinmiyor" sayılır. */
const FILL_AGE_MS = 5_000;
/**
 * Kendi ritmi olan kanalların tazelik payı.
 *
 * `battery_v` OBD turunun içinde değil: ATRV ile 10 saniyede bir ayrı
 * okunuyor. Ona 5 saniyelik pay vermek, kanalı hiç okunmamış saymak
 * demekti — kontak penceresi 5 saniyelik parçalara bölünüyor ve 20
 * saniyelik alt sınırı hiçbir zaman geçemiyordu. Tazelik payı kanalın
 * ÖRNEKLEME ARALIĞINA göre belirlenmeli, tek bir sabite göre değil.
 */
const SLOW_FILL_AGE_MS: Readonly<Record<string, number>> = {
  battery_v: 15_000,
};

/** Bir zamandaki kanal değerini veren okuyucu (forward-fill, bayatsa null). */
type ChannelReader = (channel: string) => number | null;

interface WindowSpec {
  readonly stepId: string;
  /** Koşu bu kadar saniye KESİNTİSİZ sürmeliyse pencere sayılır. */
  readonly minSeconds: number;
  readonly test: (at: ChannelReader) => boolean;
  /**
   * Yalnızca kaydın EN BAŞINDAKİ koşuyu kabul et.
   *
   * `battery_rest_v` için şart: motor durduktan sonra akü uçlarında yüzey
   * şarjı kalır ve voltaj bir süre yüksek okunur. Sürüş sonundaki bir
   * "motor kapalı" penceresini dinlenme voltajı diye seriye sokmak, aküyü
   * her seferinde olduğundan iyi göstermek olurdu — trendi tam da
   * gözlemek istediğimiz yönde bozar.
   */
  readonly onlyAtStart?: boolean;
}

function driveWindowSpecs(vehicle: VehicleProfile): readonly WindowSpec[] {
  // idleSamples ile AYNI tanım: alt sınır motorun çalıştığını, üst sınır
  // rölantiden çıkılmadığını söyler. Tek yerde tutulamıyor çünkü orası
  // örnek süzüyor, burası zaman aralığı arıyor; ama sayılar aynı kalmalı.
  const idling = (at: ChannelReader): boolean => {
    const rpm = at('0C');
    if (rpm === null || rpm <= 300 || rpm >= vehicle.idleRpm * 1.6) return false;
    const speed = at('0D');
    return speed === null || speed < 2;
  };

  return [
    {
      stepId: 'ignition',
      minSeconds: 20, // ATRV 10 sn'de bir okunuyor; medyan için en az iki örnek.
      onlyAtStart: true,
      test: (at) => {
        const rpm = at('0C');
        return rpm !== null && rpm <= 300 && at('battery_v') !== null;
      },
    },
    {
      stepId: 'cold-idle',
      minSeconds: 30,
      test: (at) => {
        const coolant = at('05');
        // Soğutma suyu OKUNAMIYORSA pencere üretilmiyor: soğuk ile sıcak
        // rölantiyi ayıramadan ikisini aynı seriye yazmak trendi bozar.
        return coolant !== null && coolant < 60 && idling(at);
      },
    },
    {
      stepId: 'warm-idle',
      minSeconds: 30,
      test: (at) => {
        const coolant = at('05');
        return coolant !== null && coolant >= 80 && idling(at);
      },
    },
    {
      stepId: 'cruise',
      minSeconds: 30,
      // Vites ya da yokuş kontrolü YOK, çünkü bu pencereden çıkan tek vital
      // şarj voltajı ve o vitesle değil alternatör devriyle ilgili. Vitesin
      // önemli olduğu ölçümler (tekerlek çevresi, hız sapması) cycle'ın
      // cruise adımına bağlı kalıyor.
      test: (at) => {
        const speed = at('0D');
        return speed !== null && speed >= 60 && speed <= 100;
      },
    },
  ];
}

/**
 * Kaydın içinden koşul pencerelerini bulur.
 *
 * Saat olarak devir serisi kullanılıyor: her kanal setinde var, ve aranan
 * koşulların hepsi motorun durumuyla tanımlı. Diğer kanallar o anlara
 * forward-fill ile taşınıyor.
 *
 * Her koşul için EN UZUN koşu seçiliyor — en çok örnek, en az kenar etkisi.
 */
export function detectWindows(
  series: SeriesMap,
  vehicle: VehicleProfile = MINI_R50,
): StepWindow[] {
  const clock = series['0C'] ?? [];
  if (clock.length < 2) return [];

  const readerAt = (ts: number): ChannelReader => (channel) => {
    const s = series[channel];
    if (!s || s.length === 0) return null;
    return valueAtOrBefore(s, ts, SLOW_FILL_AGE_MS[channel] ?? FILL_AGE_MS);
  };

  const out: StepWindow[] = [];

  for (const spec of driveWindowSpecs(vehicle)) {
    const runs: { fromMs: number; toMs: number }[] = [];
    let runStart: number | null = null;
    let prevTs = clock[0].ts;

    const consider = (fromMs: number, toMs: number) => {
      if ((toMs - fromMs) / 1000 < spec.minSeconds) return;
      if (spec.onlyAtStart && fromMs > clock[0].ts + RUN_GAP_MS) return;
      runs.push({ fromMs, toMs });
    };

    for (const p of clock) {
      const ok = spec.test(readerAt(p.ts));
      // Veri boşluğu koşuyu keser: ölçmediğimiz süreyi "koşul sürüyordu"
      // diye saymak, 7 Eylül sahasında donmuş değerlerle yaptığımız hatanın
      // aynısı olur.
      const broken = p.ts - prevTs > RUN_GAP_MS;
      if (!ok || broken) {
        if (runStart !== null) consider(runStart, prevTs);
        runStart = ok ? p.ts : null;
      } else if (runStart === null) {
        runStart = p.ts;
      }
      prevTs = p.ts;
    }
    if (runStart !== null) consider(runStart, prevTs);

    const best = runs.reduce<{ fromMs: number; toMs: number } | null>(
      (a, b) => (a === null || b.toMs - b.fromMs > a.toMs - a.fromMs ? b : a),
      null,
    );
    if (best !== null) {
      out.push({ stepId: spec.stepId, fromMs: best.fromMs, toMs: best.toMs, skipped: false });
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
