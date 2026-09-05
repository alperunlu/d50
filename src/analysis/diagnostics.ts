/**
 * Teşhis kontrolleri — tek bir kanalın söyleyemediği, ancak birkaç kanalı
 * yan yana koyunca ortaya çıkan bulgular.
 *
 * TASARIM İLKELERİ
 *
 * 1. Hepsi SAF fonksiyon. Girdi kaydedilmiş seriler, çıktı bulgu listesi.
 *    Cihaz, DB, zaman gerektirmiyorlar; bu yüzden test edilebilirler ve
 *    formül geliştikçe ESKİ oturumlar da yeni analizden faydalanır.
 *
 * 2. "Yetersiz veri" ayrı bir sonuç. Bir kontrol veriyi bulamadığında
 *    "sorun yok" DEMEZ — `inconclusive` döner ve neyin eksik olduğunu yazar.
 *    Ölçüm aletinde sessizce "iyi" demek, yanlış ölçmekten daha tehlikeli.
 *
 * 3. Eşikler mutlak doğru değil, ipucu. Her bulgu `evidence` alanında
 *    dayandığı sayıları taşır ki kullanıcı kararı kendisi verebilsin.
 *    Hiçbiri "şu parçayı değiştir" demez; "şuraya bak" der.
 *
 * 4. Hiçbiri araca komut göndermez. Bu dosya yalnızca kaydedilmiş sayıları
 *    okur — uygulamanın salt-okunur şartıyla aynı hizada.
 */

import { type SeriesMap, type TimeSeriesPoint } from './derived';
import { MINI_R50, type VehicleProfile } from './vehicle';
import {
  rollingCircumferenceMm,
  circumferenceFromSpeedPair,
  totalDriveRatio,
  formatTyreSize,
  speedCorrectionFactor,
} from './tyre';

export type Verdict = 'ok' | 'attention' | 'inconclusive';

export interface Finding {
  readonly key: string;
  readonly title: string;
  readonly verdict: Verdict;
  /** Tek cümlelik sonuç. */
  readonly headline: string;
  /** Sonucun ne anlama geldiği ve sıradaki adım. */
  readonly detail: string;
  /** Sonucun dayandığı sayılar — kullanıcı kendi kararını verebilsin. */
  readonly evidence?: string;
  /** `inconclusive` ise hangi kanallar eksik. */
  readonly needs?: readonly string[];
}

// ---------------------------------------------------------------------------
// Ortak yardımcılar
// ---------------------------------------------------------------------------

function get(series: SeriesMap, key: string): readonly TimeSeriesPoint[] {
  return series[key] ?? [];
}

function has(series: SeriesMap, key: string, min = 5): boolean {
  return get(series, key).length >= min;
}

/**
 * Bir serinin `ts` anındaki değeri — o ana kadarki SON örnek (forward-fill).
 *
 * Kanallar farklı anlarda örnekleniyor (K-line'da sırayla soruluyorlar), bu
 * yüzden "aynı anda" diye bir şey yok. `maxAgeMs` bayat veriyle karşılaştırma
 * yapmayı engelliyor: 10 saniye önceki gaz kelebeği değeri şimdiki devirle
 * ilişkilendirilemez.
 */
export function sampleAt(
  series: readonly TimeSeriesPoint[],
  ts: number,
  maxAgeMs = 3000,
): number | null {
  let best: TimeSeriesPoint | null = null;
  for (const p of series) {
    if (p.ts > ts) break;
    best = p;
  }
  if (!best) return null;
  return ts - best.ts <= maxAgeMs ? best.value : null;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdDev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values) as number;
  const variance = values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * Bir sinyalin eşiği kaç kez geçtiği (histerezisli).
 *
 * Histerezis şart: lambda sondası gürültülüdür, çıplak eşik karşılaştırması
 * tek bir salınımı onlarca "geçiş" gibi sayardı.
 */
export function countCrossings(
  series: readonly TimeSeriesPoint[],
  threshold: number,
  hysteresis: number,
): number {
  let state: 'low' | 'high' | null = null;
  let count = 0;
  for (const p of series) {
    if (state !== 'high' && p.value > threshold + hysteresis) {
      if (state !== null) count++;
      state = 'high';
    } else if (state !== 'low' && p.value < threshold - hysteresis) {
      if (state !== null) count++;
      state = 'low';
    }
  }
  return count;
}

/** Serinin kapsadığı süre (saniye). */
function spanSeconds(series: readonly TimeSeriesPoint[]): number {
  if (series.length < 2) return 0;
  return (series[series.length - 1].ts - series[0].ts) / 1000;
}

/** Pearson korelasyon katsayısı. */
export function correlation(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 5) return null;
  const mx = mean(xs.slice(0, n)) as number;
  const my = mean(ys.slice(0, n)) as number;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

function inconclusive(
  key: string,
  title: string,
  needs: readonly string[],
  detail: string,
): Finding {
  return {
    key,
    title,
    verdict: 'inconclusive',
    headline: 'Not enough data',
    detail,
    needs,
  };
}

/**
 * Rakımdan ortam basıncı (kPa) — barometrik formül.
 *
 * R50 barometrik PID'i (0133) desteklemiyor, ama GPS rakımı veriyor. Emme
 * manifoldu basıncı MUTLAK ölçülür; "vakum" ancak ortam basıncı bilinirse
 * hesaplanabilir. Rakımdan tahmin, hava durumu kaynaklı ±2 kPa hata taşır —
 * eşikler bu paya göre geniş tutuldu.
 */
export function ambientPressureKpa(altitudeM: number | null): number {
  if (altitudeM === null || !Number.isFinite(altitudeM)) return 101.325;
  return 101.325 * (1 - 2.25577e-5 * altitudeM) ** 5.25588;
}

// ---------------------------------------------------------------------------
// 1. Katalizör verimi — kat öncesi/sonrası lambda salınımı
// ---------------------------------------------------------------------------

/**
 * Sağlam bir katalizör oksijen depolar: kat öncesi sonda saniyede yaklaşık
 * bir kez salınırken, kat sonrası sonda neredeyse düz kalır. Kat sonrası da
 * beraber salınmaya başladıysa depolama kapasitesi bitmiş demektir.
 *
 * Ölçüt: geçiş sayısı oranı (kat sonrası / kat öncesi).
 */
export function catalystEfficiency(series: SeriesMap): Finding {
  const key = 'catalyst';
  const title = 'Catalytic converter';
  const pre = get(series, '14');
  const post = get(series, '15');

  if (!has(series, '14', 20) || !has(series, '15', 20)) {
    return inconclusive(key, title, ['O2 Sensor B1S1 (pre-cat)', 'O2 Sensor B1S2 (post-cat)'],
      'Record both O2 channels for a few minutes with the engine warm and in closed loop.');
  }

  const preSwitches = countCrossings(pre, 0.45, 0.05);
  const postSwitches = countCrossings(post, 0.45, 0.05);

  // Kat öncesi sonda salınmıyorsa motor kapalı çevrimde değildir (soğuk,
  // tam gaz ya da sonda tembel). Bu durumda katalizör hakkında bir şey
  // söylenemez — oranın paydası anlamsız olur.
  if (preSwitches < 10) {
    return inconclusive(key, title, [],
      'The pre-cat sensor barely switched, so the engine was probably not in closed loop. Record a warm, steady cruise.');
  }

  const ratio = postSwitches / preSwitches;
  const evidence = `pre-cat ${preSwitches} switches, post-cat ${postSwitches} switches, ratio ${round(ratio, 2)}`;

  if (ratio > 0.5) {
    return {
      key, title, verdict: 'attention',
      headline: 'Post-cat sensor tracks the pre-cat sensor',
      detail:
        'The rear sensor is switching almost as often as the front one, which is what a converter with little oxygen storage left looks like. A P0420 code often follows. Rule out an exhaust leak ahead of the rear sensor before condemning the converter.',
      evidence,
    };
  }

  return {
    key, title, verdict: 'ok',
    headline: 'Converter is storing oxygen',
    detail: 'The rear sensor stays much flatter than the front one — the expected signature of a working converter.',
    evidence,
  };
}

// ---------------------------------------------------------------------------
// 2. Lambda sondası tepki hızı
// ---------------------------------------------------------------------------

/**
 * Yaşlanan sonda "tembelleşir": salınım frekansı düşer. Kapalı çevrimde,
 * ısınmış motorda 1500+ rpm'de saniyede en az ~0.5 geçiş beklenir.
 */
export function oxygenSensorResponse(series: SeriesMap): Finding {
  const key = 'o2_response';
  const title = 'Pre-cat O2 sensor response';
  const pre = get(series, '14');

  if (!has(series, '14', 20)) {
    return inconclusive(key, title, ['O2 Sensor B1S1 (pre-cat)'],
      'Record the pre-cat O2 channel with the engine warm.');
  }

  const seconds = spanSeconds(pre);
  if (seconds < 30) {
    return inconclusive(key, title, [], 'Needs at least 30 seconds of O2 data.');
  }

  const switches = countCrossings(pre, 0.45, 0.05);
  const hz = switches / seconds;
  const evidence = `${switches} switches in ${Math.round(seconds)} s (${round(hz, 2)} Hz)`;

  if (hz < 0.4) {
    return {
      key, title, verdict: 'attention',
      headline: 'Sensor is switching slowly',
      detail:
        'A healthy warm sensor crosses the 0.45 V line roughly once a second. Slow switching points to an aged or contaminated sensor — but it also looks like this if the engine never reached closed loop during the recording.',
      evidence,
    };
  }

  return {
    key, title, verdict: 'ok',
    headline: 'Sensor switching at a healthy rate',
    detail: 'Crossing rate is in the normal band for a warm sensor in closed loop.',
    evidence,
  };
}

// ---------------------------------------------------------------------------
// 3. Yakıt düzeltmesinin yüke göre imzası — vakum kaçağı ayrımı
// ---------------------------------------------------------------------------

/**
 * Toplam düzeltme (kısa + uzun dönem) yüke göre bakılır:
 *
 *   düşük yükte yüksek pozitif, yüksek yükte normal → ÖLÇÜLMEMİŞ HAVA
 *     (vakum kaçağı). Kaçak sabit debidedir; toplam hava debisi küçükken
 *     oransal etkisi büyüktür, gaz açılınca kaybolur.
 *   her yükte pozitif → yakıt besleme yetersizliği (pompa, filtre, enjektör)
 *     ya da hava ölçümünün kendisi hatalı.
 *   her yükte negatif → zengin karışım.
 *
 * Bu ayrım R50'de kıymetli: emme ve karter havalandırması hortumları bilinen
 * bir zayıflık.
 */
export function fuelTrimByLoad(series: SeriesMap): Finding {
  const key = 'fuel_trim_load';
  const title = 'Fuel trim vs load';
  const stft = get(series, '06');
  const ltft = get(series, '07');
  const load = get(series, '04');

  const needs: string[] = [];
  if (!has(series, '06')) needs.push('Short Term Fuel Trim');
  if (!has(series, '07')) needs.push('Long Term Fuel Trim');
  if (!has(series, '04')) needs.push('Engine Load');
  if (needs.length > 0) {
    return inconclusive(key, title, needs,
      'Fuel trim only becomes a diagnosis when it can be split by engine load.');
  }

  const lowLoad: number[] = [];
  const highLoad: number[] = [];

  for (const p of stft) {
    const long = sampleAt(ltft, p.ts);
    const l = sampleAt(load, p.ts);
    if (long === null || l === null) continue;
    const total = p.value + long;
    if (l < 30) lowLoad.push(total);
    else if (l > 50) highLoad.push(total);
  }

  const low = lowLoad.length >= 5 ? mean(lowLoad) : null;
  const high = highLoad.length >= 5 ? mean(highLoad) : null;

  if (low === null && high === null) {
    return inconclusive(key, title, [],
      'Not enough samples at a steady load. Record a few minutes including idle and some throttle.');
  }

  const evidence = [
    low !== null ? `low load ${round(low)} %` : 'low load: no data',
    high !== null ? `high load ${round(high)} %` : 'high load: no data',
  ].join(', ');

  if (low !== null && high !== null && low > 10 && high < 7) {
    return {
      key, title, verdict: 'attention',
      headline: 'Lean at low load, normal under throttle',
      detail:
        'That is the classic unmetered-air signature: a fixed leak matters a lot when little air is flowing and disappears when the throttle opens. Look at intake boots, the crankcase breather and gaskets before anything else.',
      evidence,
    };
  }

  if ((low ?? 0) > 10 && (high ?? 0) > 10) {
    return {
      key, title, verdict: 'attention',
      headline: 'Lean across the whole load range',
      detail:
        'Correction stays high everywhere, which points at fuel delivery (pump, filter, injectors) or at the air measurement itself rather than at a leak.',
      evidence,
    };
  }

  if ((low ?? 0) < -10 || (high ?? 0) < -10) {
    return {
      key, title, verdict: 'attention',
      headline: 'Running rich — the ECU is pulling fuel out',
      detail:
        'Large negative correction means the mixture arrives too rich. Leaking injectors, high fuel pressure or a skewed intake temperature reading are the usual causes.',
      evidence,
    };
  }

  return {
    key, title, verdict: 'ok',
    headline: 'Fuel trim within normal band',
    detail: 'Total correction stays inside ±10 % at both low and high load.',
    evidence,
  };
}

// ---------------------------------------------------------------------------
// 4. Termostat
// ---------------------------------------------------------------------------

/**
 * Açık kalmış termostat motorun çalışma sıcaklığına ulaşmasını engeller:
 * yakıt tüketimi artar, kalorifer üflemez, P0128 gelir. İmza: soğutma suyu
 * yükselir ama profildeki açma sıcaklığının belirgin altında platoya oturur.
 */
export function thermostatCheck(series: SeriesMap, vehicle: VehicleProfile = MINI_R50): Finding {
  const key = 'thermostat';
  const title = 'Thermostat / warm-up';
  const coolant = get(series, '05');

  if (!has(series, '05', 10)) {
    return inconclusive(key, title, ['Coolant Temperature'],
      'Record coolant temperature from a cold start for the most useful result.');
  }

  const seconds = spanSeconds(coolant);
  const start = coolant[0].value;
  const peak = Math.max(...coolant.map((p) => p.value));
  const evidence = `start ${round(start, 0)} °C, peak ${round(peak, 0)} °C over ${Math.round(seconds / 60)} min`;

  if (seconds < 300) {
    return inconclusive(key, title, [],
      'The engine needs roughly ten minutes of running before a warm-up verdict means anything.');
  }

  // Motor zaten sıcak başladıysa ısınma eğrisi yok; yine de plato bilgisi var.
  if (peak >= vehicle.thermostatOpenC) {
    return {
      key, title, verdict: 'ok',
      headline: 'Reaches operating temperature',
      detail: `Coolant passed the ${vehicle.thermostatOpenC} °C the thermostat should open at.`,
      evidence,
    };
  }

  if (peak < vehicle.thermostatOpenC - 8) {
    return {
      key, title, verdict: 'attention',
      headline: 'Never reaches operating temperature',
      detail:
        `After ${Math.round(seconds / 60)} minutes of running the coolant peaked at ${round(peak, 0)} °C, well below the ${vehicle.thermostatOpenC} °C opening point. A thermostat stuck open is the common cause; a wrong coolant sensor reading looks the same, so compare with the temperature gauge.`,
      evidence,
    };
  }

  return {
    key, title, verdict: 'attention',
    headline: 'Warms up slowly',
    detail: 'Coolant stayed just under the opening temperature. Worth re-checking on a longer drive before drawing a conclusion.',
    evidence,
  };
}

// ---------------------------------------------------------------------------
// 5. Ateşleme avansı — vuruntu geri çekmesi
// ---------------------------------------------------------------------------

/**
 * ECU vuruntu duyduğunda avansı geri çeker. Yüksek yükte avansın düşük yüke
 * göre belirgin düşük olması bunun izidir (normalde de yükte biraz azalır;
 * eşik bu yüzden geniş).
 */
export function timingRetard(series: SeriesMap): Finding {
  const key = 'timing';
  const title = 'Ignition timing under load';
  const advance = get(series, '0E');
  const load = get(series, '04');

  const needs: string[] = [];
  if (!has(series, '0E')) needs.push('Timing Advance');
  if (!has(series, '04')) needs.push('Engine Load');
  if (needs.length > 0) {
    return inconclusive(key, title, needs, 'Timing only tells a story when paired with engine load.');
  }

  const cruise: number[] = [];
  const heavy: number[] = [];
  for (const p of advance) {
    const l = sampleAt(load, p.ts);
    if (l === null) continue;
    if (l >= 25 && l <= 45) cruise.push(p.value);
    else if (l > 70) heavy.push(p.value);
  }

  if (cruise.length < 5 || heavy.length < 5) {
    return inconclusive(key, title, [],
      'Needs both a steady cruise and some full-throttle running in the same recording.');
  }

  const c = mean(cruise) as number;
  const h = mean(heavy) as number;
  const drop = c - h;
  const evidence = `cruise ${round(c)}°, heavy load ${round(h)}°, drop ${round(drop)}°`;

  if (drop > 12) {
    return {
      key, title, verdict: 'attention',
      headline: 'Large timing pull under load',
      detail:
        'The ECU is retarding ignition much more than a normal load-based map would. Knock is the usual reason: low-octane or old fuel, carbon build-up, or heat. Try a tank of higher octane and repeat the same run.',
      evidence,
    };
  }

  return {
    key, title, verdict: 'ok',
    headline: 'Timing behaves normally under load',
    detail: 'The reduction from cruise to full load is within the range a healthy engine maps.',
    evidence,
  };
}

// ---------------------------------------------------------------------------
// 6. Vites oranları ve kavrama kayması
// ---------------------------------------------------------------------------

export interface GearCluster {
  readonly ratio: number;
  readonly samples: number;
}

/**
 * Devir/hız oranı vitesler hâlinde kümelenir. Kümeleri saymak hem kaç vites
 * kullanıldığını verir hem de kayma tespitinin temelidir.
 */
export function gearClusters(series: SeriesMap, tolerance = 0.06): GearCluster[] {
  const rpm = get(series, '0C');
  const speed = get(series, '0D').length > 0 ? get(series, '0D') : get(series, 'gps_speed');

  const ratios: number[] = [];
  for (const p of rpm) {
    const v = sampleAt(speed, p.ts, 1500);
    if (v === null || v < 20) continue; // düşük hızda oran gürültülü (debriyaj)
    ratios.push(p.value / v);
  }
  if (ratios.length < 10) return [];

  ratios.sort((a, b) => a - b);
  const clusters: { sum: number; n: number; ref: number }[] = [];
  for (const r of ratios) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(r - last.ref) / last.ref < tolerance) {
      last.sum += r;
      last.n += 1;
      last.ref = last.sum / last.n;
    } else {
      clusters.push({ sum: r, n: 1, ref: r });
    }
  }

  return clusters
    .filter((c) => c.n >= Math.max(5, ratios.length * 0.05))
    .map((c) => ({ ratio: round(c.sum / c.n, 3), samples: c.n }))
    .sort((a, b) => b.ratio - a.ratio);
}

/**
 * Kavrama/CVT kayması: gaz açıkken devir yükselirken hızın aynı oranda
 * artmaması. Oran (rpm/hız) sabit vitesteyken sabit olmalı; vites
 * değiştirmeden büyüyorsa aktarma organı kaçırıyor demektir.
 */
export function clutchSlip(series: SeriesMap): Finding {
  const key = 'clutch';
  const title = 'Transmission slip';
  const rpm = get(series, '0C');
  const speedObd = get(series, '0D');
  const speed = speedObd.length > 0 ? speedObd : get(series, 'gps_speed');
  const throttle = get(series, '11').length > 0 ? get(series, '11') : get(series, '04');

  const needs: string[] = [];
  if (!has(series, '0C')) needs.push('Engine RPM');
  if (speed.length < 5) needs.push('Vehicle Speed');
  if (throttle.length < 5) needs.push('Throttle Position or Engine Load');
  if (needs.length > 0) {
    return inconclusive(key, title, needs, 'Slip is a mismatch between engine speed and road speed under throttle.');
  }

  let slipEvents = 0;
  let compared = 0;

  for (let i = 1; i < rpm.length; i++) {
    const prev = rpm[i - 1];
    const cur = rpm[i];
    const dt = (cur.ts - prev.ts) / 1000;
    if (dt <= 0 || dt > 2) continue;

    const th = sampleAt(throttle, cur.ts, 1500);
    const vPrev = sampleAt(speed, prev.ts, 1500);
    const vCur = sampleAt(speed, cur.ts, 1500);
    if (th === null || vPrev === null || vCur === null) continue;
    if (th < 40 || vCur < 25) continue; // gaz kapalıysa ya da yavaşsa anlamsız

    compared++;
    const rpmRise = (cur.value - prev.value) / dt; // rpm/s
    const speedRise = (vCur - vPrev) / dt; // km/h/s

    // Devir hızla yükselirken hız neredeyse sabitse: ya vites değişiyor
    // (kısa süreli) ya da kaçırıyor. Tek olay bir şey söylemez, sayısı söyler.
    if (rpmRise > 400 && speedRise < 0.5) slipEvents++;
  }

  if (compared < 10) {
    return inconclusive(key, title, [],
      'Needs some accelerating under throttle above 25 km/h in the recording.');
  }

  const rate = slipEvents / compared;
  const evidence = `${slipEvents} slip-like moments in ${compared} accelerating samples`;

  if (rate > 0.15) {
    return {
      key, title, verdict: 'attention',
      headline: 'Engine speed rises without matching road speed',
      detail:
        'Repeatedly the revs climbed while the car did not. Gearshifts look like this too, so check whether it happens in a single gear at steady throttle — that pattern means a slipping clutch or a CVT losing grip.',
      evidence,
    };
  }

  return {
    key, title, verdict: 'ok',
    headline: 'Engine and road speed stay locked together',
    detail: 'No repeated mismatch between rising revs and road speed.',
    evidence,
  };
}

// ---------------------------------------------------------------------------
// 7. Rölanti kalitesi — devir + titreşim + ses birlikte
// ---------------------------------------------------------------------------

/**
 * Rölanti devrinin dalgalanması tek başına da anlamlı, ama telefonun
 * ivmeölçeri ve mikrofonu tabloyu tamamlıyor: devir oynuyor + titreşim
 * yüksek → yanma sorunu; devir düz + titreşim yüksek → mekanik (takoz).
 */
export function idleQuality(series: SeriesMap, vehicle: VehicleProfile = MINI_R50): Finding {
  const key = 'idle';
  const title = 'Idle quality';
  const rpm = get(series, '0C');
  const speed = get(series, '0D').length > 0 ? get(series, '0D') : get(series, 'gps_speed');

  if (!has(series, '0C', 10)) {
    return inconclusive(key, title, ['Engine RPM'], 'Record a minute of idling.');
  }

  const idleRpm: number[] = [];
  const idleTs: number[] = [];
  for (const p of rpm) {
    const v = speed.length > 0 ? sampleAt(speed, p.ts, 3000) : 0;
    const stationary = v === null ? false : v < 2;
    if (stationary && p.value > 300 && p.value < vehicle.idleRpm * 1.6) {
      idleRpm.push(p.value);
      idleTs.push(p.ts);
    }
  }

  if (idleRpm.length < 10) {
    return inconclusive(key, title, [],
      'No stationary idling found in this recording. Leave it idling for a minute while recording.');
  }

  const sd = stdDev(idleRpm) as number;
  const avg = mean(idleRpm) as number;

  // Aynı zaman aralığındaki titreşim ve ses — varsa tabloyu tamamlıyorlar.
  const from = idleTs[0];
  const to = idleTs[idleTs.length - 1];
  const window = (s: readonly TimeSeriesPoint[]) =>
    s.filter((p) => p.ts >= from && p.ts <= to).map((p) => p.value);
  const accel = window(get(series, 'accel_magnitude'));
  const sound = window(get(series, 'mic_db'));
  const accelSd = accel.length >= 10 ? stdDev(accel) : null;
  const soundSd = sound.length >= 10 ? stdDev(sound) : null;

  const evidence = [
    `mean ${round(avg, 0)} rpm, σ ${round(sd)} rpm`,
    accelSd !== null ? `vibration σ ${round(accelSd, 3)} g` : null,
    soundSd !== null ? `sound σ ${round(soundSd)} dB` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const rough = sd > 40;
  const shaky = accelSd !== null && accelSd > 0.03;

  if (rough && shaky) {
    return {
      key, title, verdict: 'attention',
      headline: 'Idle hunts and the car shakes with it',
      detail:
        'Both the revs and the phone vibration move together, which is what a combustion problem looks like: a misfire, a vacuum leak or a fouled injector. Fuel trim and the O2 trace in this same trip narrow it down.',
      evidence,
    };
  }

  if (shaky && !rough) {
    return {
      key, title, verdict: 'attention',
      headline: 'Steady revs but noticeable shake',
      detail:
        'Engine speed is stable while the body still vibrates — that points at mechanics rather than combustion, most often worn engine or gearbox mounts. Note that a phone lying loose in a cupholder can fake this; wedge it before trusting it.',
      evidence,
    };
  }

  if (rough) {
    return {
      key, title, verdict: 'attention',
      headline: 'Idle speed wanders',
      detail:
        'Idle RPM varies more than a healthy engine should. Idle air control, a vacuum leak or a weak cylinder are the usual suspects.',
      evidence,
    };
  }

  return {
    key, title, verdict: 'ok',
    headline: 'Idle is steady',
    detail: 'Engine speed holds close to its mean while stationary.',
    evidence,
  };
}

// ---------------------------------------------------------------------------
// 8. Ses seviyesi — devirle ilişkisi ve açıklanamayan sıçramalar
// ---------------------------------------------------------------------------

/**
 * Mikrofon ölçümüyle DÜRÜSTÇE yapılabilecek şey bu: seviye ile devir
 * arasındaki ilişkiye bakmak.
 *
 * Sağlıklı bir araçta gürültünün büyük kısmını devir ve hız açıklar
 * (korelasyon yüksek). Devir sabitken seviyenin belirgin biçimde zıplaması
 * devirden BAĞIMSIZ bir kaynağa işaret eder: egzoz kaçağı, kayış, rulman,
 * gevşek parça. Bu bir teşhis değil, "kulağını ver" işaretidir.
 *
 * FFT/order analizi bilinçli olarak YOK: expo-audio tek bir seviye sayısı
 * veriyor, ham PCM vermiyor. Seviyeden spektrum uydurmak sahtecilik olurdu.
 */
export function soundVsRpm(series: SeriesMap): Finding {
  const key = 'sound_rpm';
  const title = 'Sound level vs engine speed';
  const sound = get(series, 'mic_db');
  const rpm = get(series, '0C');

  const needs: string[] = [];
  if (sound.length < 20) needs.push('Noise Level (microphone)');
  if (!has(series, '0C', 20)) needs.push('Engine RPM');
  if (needs.length > 0) {
    return inconclusive(key, title, needs,
      'Turn on the microphone channel in Choose channels and record with the engine running.');
  }

  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of sound) {
    const r = sampleAt(rpm, p.ts, 2000);
    if (r === null) continue;
    xs.push(r);
    ys.push(p.value);
  }

  if (xs.length === 0) {
    return inconclusive(key, title, [], 'Sound and RPM never overlapped in time.');
  }

  // Devir sabitken (dar bir bantta) seviyenin yayılımı: devirle açıklanamayan
  // gürültünün kaba ölçüsü.
  const steady: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] > 600 && xs[i] < 1200) steady.push(ys[i]);
  }
  const steadySd = steady.length >= 10 ? stdDev(steady) : null;

  /**
   * Korelasyon SABİT devirde tanımsızdır (bölen sıfır). Bu, bulguyu
   * geçersiz kılmaz — tam tersine rölantide sabit devirdeyken sesin
   * dalgalanması aradığımız şeyin ta kendisi. Bu yüzden `null` korelasyon
   * erken çıkış sebebi değil; önce yayılım değerlendiriliyor.
   */
  const r = correlation(xs, ys);
  if (r === null && steadySd === null) {
    return inconclusive(key, title, [],
      'Engine speed never varied enough, and there is not enough steady-idle data either.');
  }

  const evidence = [
    r !== null ? `correlation ${round(r, 2)} over ${xs.length} samples` : 'engine speed was constant',
    steadySd !== null ? `spread at steady idle ${round(steadySd)} dB` : null,
  ]
    .filter(Boolean)
    .join(', ');

  if (steadySd !== null && steadySd > 6) {
    return {
      key, title, verdict: 'attention',
      headline: 'Noise changes while engine speed does not',
      detail:
        'At a steady idle the sound level still moved a lot. Something that is not tied to engine speed is making noise — an exhaust leak, a belt, a bearing, or simply the environment (traffic, wind, windows down). Repeat it parked in a quiet place before reading anything into it.',
      evidence,
    };
  }

  if (r !== null && r < 0.2) {
    return {
      key, title, verdict: 'inconclusive',
      headline: 'Sound does not track engine speed',
      detail:
        'The microphone mostly heard something other than the engine — road, wind or handling noise. Wedge the phone somewhere fixed and re-record for a usable trace.',
      evidence,
    };
  }

  return {
    key, title, verdict: 'ok',
    headline: 'Noise follows engine speed',
    detail: 'The sound level rises and falls with the revs, with no unexplained excursions at steady idle.',
    evidence,
  };
}

// ---------------------------------------------------------------------------
// 8b. Order takibi — yarım order imzası (tekleyen/zayıf silindir)
// ---------------------------------------------------------------------------

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Dört zamanlı motorda her silindir İKİ TURDA BİR ateşler. Bir silindir
 * zayıfsa ya da tekliyorsa, ses her iki turda bir farklılaşır ve enerji
 * yarım order ailesine (0.5 / 1.5 / 2.5) kaçar. Sağlam bir motorda bu
 * aile ateşleme order'ının yanında sönüktür.
 *
 * Ölçüt: en güçlü yarım order / ateşleme order'ı (bkz. orderTracking.ts).
 * Oran olduğu için mikrofon kalibrasyonundan ve otomatik kazançtan bağımsız.
 *
 * DÜRÜSTLÜK: eşik deneyseldir. En sağlam kullanım, aynı araçta sağlıklıyken
 * alınmış bir kaydı temel çizgi kabul edip onunla karşılaştırmaktır; bu
 * yüzden bulgu her zaman ölçülen sayıyı da yazıyor.
 */
export function misfireOrderSignature(series: SeriesMap): Finding {
  const key = 'order_misfire';
  const title = 'Cylinder balance (engine orders)';
  const half = get(series, 'order_half_ratio');

  if (half.length < 10) {
    return inconclusive(key, title, ['Microphone (noise level + engine orders)'],
      'Turn on the microphone channel and record with the engine running at a steady speed — parked in neutral works best.');
  }

  const value = median(half.map((p) => p.value)) as number;
  const evidence = `median half-order ratio ${round(value, 2)} over ${half.length} windows`;

  if (value > 0.45) {
    return {
      key, title, verdict: 'attention',
      headline: 'Half-order energy is high — one cylinder is behaving differently',
      detail:
        'In a four-stroke engine each cylinder fires once every two revolutions, so a weak or misfiring cylinder puts energy into the half orders. That is what this recording shows. Cross-check with the fuel trim and idle results in this same trip, and with any pending fault codes. Note the threshold is empirical — the strongest evidence is comparing against a recording made when the car ran well.',
      evidence,
    };
  }

  if (value > 0.3) {
    return {
      key, title, verdict: 'attention',
      headline: 'Half-order energy is slightly raised',
      detail:
        'Not enough to call it a misfire, but above what a smoothly running engine usually shows. Repeat the recording parked in a quiet place with the phone wedged in place; road and wind noise inflate this number.',
      evidence,
    };
  }

  return {
    key, title, verdict: 'ok',
    headline: 'Cylinders sound balanced',
    detail: 'Half-order energy stays low against the firing order — the signature of even combustion.',
    evidence,
  };
}

/**
 * 1. order (krank dönüş frekansı) dönel dengesizliğin frekansıdır: kasnak,
 * volan, debriyaj, balanssız bir dönen kütle. Ateşleme order'ına oranla
 * yükselmesi mekanik bir dengesizliğe işaret eder.
 */
export function rotationalImbalance(series: SeriesMap): Finding {
  const key = 'order_imbalance';
  const title = 'Rotational balance (1st order)';
  const first = get(series, 'order_1_ratio');

  if (first.length < 10) {
    return inconclusive(key, title, ['Microphone (noise level + engine orders)'],
      'Needs the microphone channel with a steady engine speed.');
  }

  const value = median(first.map((p) => p.value)) as number;
  const evidence = `median first-order ratio ${round(value, 2)} over ${first.length} windows`;

  if (value > 0.6) {
    return {
      key, title, verdict: 'attention',
      headline: 'Strong once-per-revolution component',
      detail:
        'Energy at exactly one per crank revolution usually means an unbalanced rotating mass — crank pulley/damper, flywheel or clutch. Worn engine mounts make it audible even when the imbalance itself is small.',
      evidence,
    };
  }

  return {
    key, title, verdict: 'ok',
    headline: 'No unusual once-per-revolution component',
    detail: 'The first order stays well below the firing order.',
    evidence,
  };
}

/**
 * Ses devriyle OBD devrinin uyuşması — order sonuçlarının GEÇERLİLİK
 * kontrolü. Uyuşmuyorsa yukarıdaki iki bulgu da güvenilmezdir; bunu
 * söylememek, kötü veriden çıkarılmış bir teşhisi doğru sanmaya yol açardı.
 */
export function orderTrackingQuality(series: SeriesMap): Finding {
  const key = 'order_quality';
  const title = 'Order tracking quality';
  const audioRpm = get(series, 'audio_rpm');
  const obdRpm = get(series, '0C');

  if (audioRpm.length < 10 || obdRpm.length < 5) {
    return inconclusive(key, title, ['Microphone (noise level + engine orders)', 'Engine RPM'],
      'Record the microphone together with RPM so the sound can be locked to engine speed.');
  }

  const errors: number[] = [];
  for (const p of audioRpm) {
    const r = sampleAt(obdRpm, p.ts, 2000);
    if (r === null || r < 400) continue;
    errors.push(Math.abs(p.value - r) / r);
  }

  const m = median(errors);
  if (m === null) {
    return inconclusive(key, title, [], 'Sound and RPM never overlapped in time.');
  }

  const agreement = round((1 - m) * 100, 0);
  const evidence = `sound and OBD agree within ${round(m * 100)} % (median of ${errors.length} windows)`;

  if (m > 0.1) {
    return {
      key, title, verdict: 'attention',
      headline: 'Sound is not locked to engine speed',
      detail:
        `The engine speed derived from the microphone only matches the ECU ${agreement} % of the way. The order results in this trip should not be trusted. Fix the recording conditions: wedge the phone somewhere solid, close the windows, turn off music and the fan, and record parked in neutral.`,
      evidence,
    };
  }

  return {
    key, title, verdict: 'ok',
    headline: 'Sound is locked to engine speed',
    detail: 'The microphone hears the engine clearly enough that its own RPM estimate matches the ECU — the order results rest on solid ground.',
    evidence,
  };
}

// ---------------------------------------------------------------------------
// 9. Rölanti manifold vakumu (MAP + GPS rakımı)
// ---------------------------------------------------------------------------

/**
 * Rölantide sağlam bir motor güçlü vakum çeker: mutlak manifold basıncı
 * ortam basıncının epey altındadır (tipik olarak 30-40 kPa civarı, yani
 * ~60-70 kPa vakum). Zayıf vakum; kaçak, tıkalı egzoz, kaçıran subap ya da
 * yanlış ayarlanmış zamanlama demektir.
 *
 * Ortam basıncı 0133 PID'iyle okunamıyor (R50 desteklemiyor); GPS rakımından
 * tahmin ediliyor, rakım yoksa deniz seviyesi varsayılıyor.
 */
export function idleManifoldVacuum(series: SeriesMap, vehicle: VehicleProfile = MINI_R50): Finding {
  const key = 'vacuum';
  const title = 'Idle manifold vacuum';
  const map = get(series, '0B');
  const rpm = get(series, '0C');
  const speed = get(series, '0D').length > 0 ? get(series, '0D') : get(series, 'gps_speed');

  const needs: string[] = [];
  if (!has(series, '0B', 10)) needs.push('Intake Manifold Pressure');
  if (!has(series, '0C', 10)) needs.push('Engine RPM');
  if (needs.length > 0) {
    return inconclusive(key, title, needs, 'Vacuum is manifold pressure measured against ambient pressure at idle.');
  }

  const altitude = get(series, 'gps_altitude');
  const ambient = ambientPressureKpa(altitude.length > 0 ? (mean(altitude.map((p) => p.value)) as number) : null);

  const idleMap: number[] = [];
  for (const p of map) {
    const r = sampleAt(rpm, p.ts, 2000);
    const v = speed.length > 0 ? sampleAt(speed, p.ts, 3000) : 0;
    if (r === null) continue;
    if (v !== null && v >= 2) continue;
    if (r > 300 && r < vehicle.idleRpm * 1.4) idleMap.push(p.value);
  }

  if (idleMap.length < 10) {
    return inconclusive(key, title, [], 'No stationary idling with MAP data in this recording.');
  }

  const avgMap = mean(idleMap) as number;
  const vacuum = ambient - avgMap;
  const evidence = `MAP ${round(avgMap)} kPa, ambient ${round(ambient)} kPa${altitude.length > 0 ? ' (from GPS altitude)' : ' (assumed sea level)'}, vacuum ${round(vacuum)} kPa`;

  if (vacuum < 45) {
    return {
      key, title, verdict: 'attention',
      headline: 'Weak vacuum at idle',
      detail:
        'A healthy warm engine pulls roughly 55-70 kPa of vacuum at idle. Low vacuum comes from an intake leak, a restricted exhaust, late valve timing or leaking valves. Cross-check with the fuel trim result in this same trip: a leak pushes trim positive, a restricted exhaust does not.',
      evidence,
    };
  }

  return {
    key, title, verdict: 'ok',
    headline: 'Vacuum is in the healthy range',
    detail: 'Manifold pressure sits well below ambient at idle, as it should.',
    evidence,
  };
}

// ---------------------------------------------------------------------------
// 10. Lastik ölçüsünden türeyenler
// ---------------------------------------------------------------------------

/**
 * FİİLİ yuvarlanma çevresi ile girilen lastiğin nominal çevresinin farkı.
 *
 * ECU hızı fabrika lastiğine göre hesapladığı için GPS/OBD hız oranı,
 * tekerleğin gerçekte ne kadar yol aldığını verir. Bunu girilen ebadın
 * nominal çevresiyle karşılaştırmak üç şeyi ayırt ettirir:
 *
 *   - beklenenden KÜÇÜK çevre → düşük basınç ya da aşınmış lastik
 *     (tamamen aşınmış bir lastik yaklaşık %1.5 daha küçüktür)
 *   - beklenenden BÜYÜK çevre → girilen ebat yanlış ya da farklı ebat takılı
 *   - fark yok → hız/mesafe okumaları güvenilir
 *
 * Uyarı: ölçüm GPS'e dayanıyor ve GPS hızı ±0.5 km/h gürültülü. Bu yüzden
 * 40 km/h altı örnekler atılıyor ve tek ölçüm değil ORTANCA kullanılıyor.
 */
export function tyreCircumferenceCheck(
  series: SeriesMap,
  vehicle: VehicleProfile = MINI_R50,
): Finding {
  const key = 'tyre_circumference';
  const title = 'Rolling circumference';
  const obd = get(series, '0D');
  const gps = get(series, 'gps_speed');

  const needs: string[] = [];
  if (obd.length < 10) needs.push('Vehicle Speed');
  if (gps.length < 10) needs.push('GPS');
  if (needs.length > 0) {
    return inconclusive(key, title, needs,
      'Needs both ECU speed and GPS speed — the ratio between them is the measurement.');
  }

  const measured: number[] = [];
  for (const g of gps) {
    const o = sampleAt(obd, g.ts, 2000);
    if (o === null) continue;
    const c = circumferenceFromSpeedPair(o, g.value, vehicle.factoryTyre);
    if (c !== null) measured.push(c);
  }

  if (measured.length < 10) {
    return inconclusive(key, title, [],
      'Needs a few minutes above 40 km/h — below that GPS speed is too noisy to compare.');
  }

  const actual = median(measured) as number;
  const nominal = rollingCircumferenceMm(vehicle.fittedTyre);
  const deviation = ((actual - nominal) / nominal) * 100;
  const evidence = `measured ${Math.round(actual)} mm vs ${Math.round(nominal)} mm nominal for ${formatTyreSize(vehicle.fittedTyre)} (${round(deviation)} %), ${measured.length} samples`;

  if (deviation < -2.5) {
    return {
      key, title, verdict: 'attention',
      headline: 'Wheels are turning smaller than the entered tyre size',
      detail:
        'The wheels cover less ground per revolution than the entered size predicts. Low tyre pressure and heavy wear both do this; so does entering the wrong size. Check pressures cold first — it is the cheap explanation and the one that also costs fuel.',
      evidence,
    };
  }

  if (deviation > 2.5) {
    return {
      key, title, verdict: 'attention',
      headline: 'Wheels are turning larger than the entered tyre size',
      detail:
        'The car covers more ground per revolution than the entered size predicts. Usually this means the entered size is not what is actually fitted. Check the sidewall and correct it — every distance and consumption figure depends on this number.',
      evidence,
    };
  }

  return {
    key, title, verdict: 'ok',
    headline: 'Rolling circumference matches the entered tyre size',
    detail:
      'Measured circumference agrees with the entered size, so speed and distance readings rest on solid ground.',
    evidence,
  };
}

/**
 * Toplam aktarma oranının SABİTLİĞİ — kavrama/CVT kayması.
 *
 * Sabit bir viteste motor devri ile tekerlek devri arasındaki oran
 * değişmemeli. Bir vites kümesi içinde oranın yayılması, aktarmanın
 * kaçırdığı anlamına gelir. `clutchSlip` olayları sayıyordu; bu ise
 * kaymayı YÜZDE olarak ölçüyor.
 *
 * Lastik çevresi olmadan da oran hesaplanabilirdi ama anlamsız bir sayı
 * (rpm/kmh) olurdu; çevre girilince gerçek bir aktarma oranı çıkıyor.
 */
export function driveRatioStability(
  series: SeriesMap,
  vehicle: VehicleProfile = MINI_R50,
): Finding {
  const key = 'drive_ratio';
  const title = 'Drive ratio stability';
  const rpm = get(series, '0C');
  const speed = get(series, '0D').length > 0 ? get(series, '0D') : get(series, 'gps_speed');

  const needs: string[] = [];
  if (rpm.length < 10) needs.push('Engine RPM');
  if (speed.length < 10) needs.push('Vehicle Speed');
  if (needs.length > 0) {
    return inconclusive(key, title, needs, 'Needs engine speed and road speed together.');
  }

  const circumference = rollingCircumferenceMm(vehicle.fittedTyre);
  const ratios: number[] = [];
  for (const r of rpm) {
    const v = sampleAt(speed, r.ts, 1500);
    if (v === null || v < 25) continue;
    const ratio = totalDriveRatio(r.value, v, circumference);
    if (ratio !== null && ratio > 1 && ratio < 30) ratios.push(ratio);
  }

  if (ratios.length < 15) {
    return inconclusive(key, title, [],
      'Needs steady driving above 25 km/h — ratios below that are dominated by the clutch.');
  }

  /**
   * Vites kümelerine ayır.
   *
   * Tolerans (%18) bilinçli olarak GENİŞ: bir vites basamağı tipik olarak
   * %25-40 fark yaratır, dolayısıyla bu eşik vitesleri hâlâ ayırır. Dar bir
   * tolerans (ilk denemede %8) ise aradığımız şeyi imkânsız kılıyordu —
   * kayan bir vitesin oranı kümeden taşıp AYRI BİR VİTES gibi görünüyor,
   * geriye kusursuz sabit görünen kümeler kalıyordu. Yani kontrol, tam da
   * yakalaması gereken durumda "sağlam" diyordu.
   */
  const sorted = [...ratios].sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const r of sorted) {
    const last = clusters[clusters.length - 1];
    const ref = last ? (mean(last) as number) : null;
    if (last && ref !== null && Math.abs(r - ref) / ref < 0.18) last.push(r);
    else clusters.push([r]);
  }

  const solid = clusters.filter((c) => c.length >= Math.max(5, ratios.length * 0.1));
  if (solid.length === 0) {
    return inconclusive(key, title, [], 'No gear was held long enough to measure its ratio.');
  }

  // Her küme içindeki bağıl yayılım: kaymanın ölçüsü.
  const spreads = solid.map((c) => ((stdDev(c) ?? 0) / (mean(c) as number)) * 100);
  const worst = Math.max(...spreads);
  const evidence =
    `${solid.length} gear${solid.length === 1 ? '' : 's'} seen, ratios ` +
    solid.map((c) => round(mean(c) as number, 2)).join(' · ') +
    `, worst spread ${round(worst)} %`;

  // Sağlam bir aktarmada sabit vitesteki oran neredeyse hiç oynamaz; %3
  // bağıl yayılım, ölçüm gürültüsünün üstünde kalan ilk anlamlı eşik.
  if (worst > 3) {
    return {
      key, title, verdict: 'attention',
      headline: 'Drive ratio wanders within a single gear',
      detail:
        'In a fixed gear the ratio between engine and wheel speed should be constant. It is not, which is what a slipping clutch or a CVT losing grip looks like. Gearshifts and wheelspin also widen this number, so confirm it on a steady pull in one gear.',
      evidence,
    };
  }

  return {
    key, title, verdict: 'ok',
    headline: 'Drive ratios are consistent',
    detail: 'Each gear holds a steady engine-to-wheel ratio — no sign of slip.',
    evidence,
  };
}

/**
 * Fabrika ebadından farklı bir lastik takılıysa hız/mesafe okumalarının
 * sistematik hatası. Teşhis değil, KALİBRASYON uyarısı: kullanıcı bilmezse
 * bütün mesafe ve tüketim rakamlarını yanlış okur.
 */
export function tyreSizeCalibration(vehicle: VehicleProfile = MINI_R50): Finding {
  const key = 'tyre_calibration';
  const title = 'Speed calibration';
  const factor = speedCorrectionFactor(vehicle.fittedTyre, vehicle.factoryTyre);
  const errorPct = (factor - 1) * 100;
  const evidence = `fitted ${formatTyreSize(vehicle.fittedTyre)}, factory ${formatTyreSize(vehicle.factoryTyre)} — ECU speed off by ${round(-errorPct)} %`;

  if (Math.abs(errorPct) < 0.5) {
    return {
      key, title, verdict: 'ok',
      headline: 'Fitted tyre matches the factory size',
      detail: 'The ECU speed and distance readings need no correction.',
      evidence,
    };
  }

  return {
    key, title, verdict: 'attention',
    headline:
      errorPct > 0
        ? 'Fitted tyres are larger than factory — the car travels further than it reports'
        : 'Fitted tyres are smaller than factory — the car reports more distance than it travels',
    detail: `Every ECU speed and distance reading is off by ${round(Math.abs(errorPct))} %, and so is anything derived from them, including consumption. True speed is ECU speed multiplied by ${round(factor, 3)}.`,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Hepsi bir arada
// ---------------------------------------------------------------------------

/**
 * Bütün kontrolleri çalıştırır ve önem sırasına dizer: dikkat isteyenler
 * önce, sonra sağlam çıkanlar, en sonda veri yetersizliğinden karar
 * verilemeyenler. Kullanıcı ekranı yukarıdan aşağı okuyunca önce
 * bakması gerekeni görüyor.
 */
export function runDiagnostics(series: SeriesMap, vehicle: VehicleProfile = MINI_R50): Finding[] {
  const findings: Finding[] = [
    fuelTrimByLoad(series),
    idleManifoldVacuum(series, vehicle),
    catalystEfficiency(series),
    oxygenSensorResponse(series),
    timingRetard(series),
    thermostatCheck(series, vehicle),
    idleQuality(series, vehicle),
    clutchSlip(series),
    misfireOrderSignature(series),
    rotationalImbalance(series),
    soundVsRpm(series),
    orderTrackingQuality(series),
    tyreCircumferenceCheck(series, vehicle),
    driveRatioStability(series, vehicle),
  ];

  /**
   * Kalibrasyon uyarısı yalnızca fabrika ebadından SAPMA varsa listeye
   * giriyor. Fabrika ebadı takılıyken "düzeltme gerekmiyor" satırı,
   * söyleyecek bir şeyi olmayan bir satırdır — ve veri içermeyen bir
   * kayıtta tek başına "ok" görünüp listeyi yanıltırdı.
   */
  const calibration = tyreSizeCalibration(vehicle);
  if (calibration.verdict !== 'ok') findings.push(calibration);

  const rank: Record<Verdict, number> = { attention: 0, ok: 1, inconclusive: 2 };
  return findings.sort((a, b) => rank[a.verdict] - rank[b.verdict]);
}
