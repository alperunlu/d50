/**
 * Türetilmiş metrikler — OBD ve telefon sensörlerini BİRLEŞTİREN hesaplar.
 *
 * Tek başına sensör loglamak fazla bir şey katmaz; değer birleşimde:
 * hız + ivme + eğim + hava kütlesi bir araya gelince motorun gerçek
 * durumu hakkında tek başına hiçbir PID'in söyleyemeyeceği şeyler çıkıyor.
 *
 * Hepsi SAF fonksiyon: örnek dizisi alır, sayı/nesne döner. Cihaz, DB, RN
 * bağımlılığı yok — cihazsız test edilebilirler ve arabada üretilen bir
 * CSV'ye masaüstünde yeniden uygulanabilirler.
 *
 * Her fonksiyonun ne KADAR güvenilir olduğu yorumlarda açıkça yazıyor;
 * tahmin ile ölçümü birbirine karıştırmamak önemli.
 */

import { maxOf, extentOf } from '../util/agg';
import { MINI_R50, PHYSICS, type VehicleProfile } from './vehicle';
import { rollingCircumferenceMm, totalDriveRatio, estimatedEngineTorqueNm, roadLoadForceN } from './tyre';

export interface TimeSeriesPoint {
  readonly ts: number; // ms
  readonly value: number;
}

// ---------------------------------------------------------------------------
// Hız / ivme
// ---------------------------------------------------------------------------

/**
 * 0'dan hedef hıza geçiş süresini bulur (saniye).
 *
 * GPS hızı tercih edilmeli: mutlaktır, lastik/jant değişiminden etkilenmez.
 * En hızlı geçerli koşuyu döner; hız arada başlangıcın altına düşerse o
 * deneme geçersiz sayılır (kesintili hızlanma "koşu" değildir).
 *
 * Kenarlarda doğrusal interpolasyon yapılır — 1 Hz GPS'te bu, ölçümü
 * yarım saniyelik yuvarlama hatasından kurtarır.
 */
export function fastestRunToSpeed(
  speedSeries: readonly TimeSeriesPoint[],
  targetKmh: number,
  startKmh = 0,
): { seconds: number; startTs: number; endTs: number } | null {
  const pts = [...speedSeries].sort((a, b) => a.ts - b.ts);
  let best: { seconds: number; startTs: number; endTs: number } | null = null;

  for (let i = 0; i < pts.length - 1; i++) {
    if (pts[i].value > startKmh) continue;

    // Başlangıç anını interpolasyonla bul (startKmh'yi geçtiği an).
    let startTs = pts[i].ts;
    if (pts[i + 1].value > startKmh && pts[i + 1].value !== pts[i].value) {
      startTs = interpolateTs(pts[i], pts[i + 1], startKmh);
    }

    for (let j = i + 1; j < pts.length; j++) {
      if (pts[j].value < startKmh) break; // koşu kesildi
      if (pts[j].value >= targetKmh) {
        const endTs =
          pts[j - 1].value < targetKmh ? interpolateTs(pts[j - 1], pts[j], targetKmh) : pts[j].ts;
        const seconds = (endTs - startTs) / 1000;
        if (seconds > 0 && (best === null || seconds < best.seconds)) {
          best = { seconds, startTs, endTs };
        }
        break;
      }
    }
  }

  return best;
}

function interpolateTs(a: TimeSeriesPoint, b: TimeSeriesPoint, value: number): number {
  const span = b.value - a.value;
  if (span === 0) return a.ts;
  const ratio = (value - a.value) / span;
  return a.ts + (b.ts - a.ts) * ratio;
}

/**
 * Hız serisinden boyuna ivme (m/s²) türetir.
 *
 * Neden ivmeölçer değil: telefonun araç içindeki yönelimi bilinmiyor,
 * ham ivmeölçer eksenleri boyuna ivmeyi doğrudan vermez. Hız türevi
 * yönelimden tamamen bağımsızdır — daha az gürültülü değil ama daha dürüst.
 */
export function accelerationSeries(speedSeries: readonly TimeSeriesPoint[]): TimeSeriesPoint[] {
  const pts = [...speedSeries].sort((a, b) => a.ts - b.ts);
  const out: TimeSeriesPoint[] = [];
  for (let i = 1; i < pts.length; i++) {
    const dtSec = (pts[i].ts - pts[i - 1].ts) / 1000;
    if (dtSec <= 0) continue;
    const dvMs = (pts[i].value - pts[i - 1].value) / 3.6; // km/h -> m/s
    out.push({ ts: pts[i].ts, value: dvMs / dtSec });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Motor sağlığı
// ---------------------------------------------------------------------------

/**
 * Volumetrik verim (%) — motorun "nefes alma" sağlığının tek en iyi göstergesi.
 *
 * Gerçek hava kütlesi (MAF) ile teorik hava kütlesini karşılaştırır.
 * Beklenenin belirgin altındaysa: tıkalı hava filtresi, emme kaçağı,
 * yapışmış supap, tıkalı katalizör. Beklenenin üstündeyse genelde MAF
 * kalibrasyon hatasıdır.
 *
 * Rölantide %20-40, tam gazda %80-100 tipik değerlerdir; tek bir ölçüm
 * değil, aynı devirdeki değişim izlenmeli.
 */
export function volumetricEfficiency(input: {
  rpm: number;
  mapKpa: number;
  iatC: number;
  mafGs: number;
  vehicle?: VehicleProfile;
}): number | null {
  const v = input.vehicle ?? MINI_R50;
  const { rpm, mapKpa, iatC, mafGs } = input;
  if (rpm <= 0 || mapKpa <= 0 || mafGs <= 0) return null;

  const tempK = iatC + 273.15;
  if (tempK <= 0) return null;

  const displacementM3 = v.displacementL / 1000;
  // Dört zamanlı motor iki turda bir dolum yapar -> RPM/2.
  const intakeCyclesPerSec = rpm / 60 / 2;
  const theoreticalKgPerSec =
    (mapKpa * 1000 * displacementM3 * intakeCyclesPerSec) / (PHYSICS.airGasConstant * tempK);
  if (theoreticalKgPerSec <= 0) return null;

  const actualKgPerSec = mafGs / 1000;
  return (actualKgPerSec / theoreticalKgPerSec) * 100;
}

/**
 * Speed-density ile hava kütlesi TAHMİNİ (g/s).
 *
 * 2026-09-05 araç taraması kesinleştirdi: MINI R50 PID 10 (MAF) DESTEKLEMİYOR
 * — motor speed-density çalışıyor, yani hava kütlesini ölçmüyor, MAP'ten
 * hesaplıyor. MAF'a dayanan her metrik bu araçta olduğu gibi imkânsız.
 *
 * Bu fonksiyon aynı hesabı dışarıdan yapar. AMA bir varsayım içerir:
 * volumetrik verim. Gerçek VE ölçülemez (ölçmek için MAF gerekir — döngüsel),
 * bu yüzden nominal bir değer kullanılıyor. Sonuç:
 *
 *   - Mutlak doğruluğu MAF'lı bir ölçümün altındadır (kabaca ±%15-20).
 *   - Aynı araçta zaman içindeki DEĞİŞİMİ izlemek için yeterlidir.
 *   - Kesin yakıt hesabı için kullanılmamalıdır.
 *
 * Bu belirsizlik UI'da da yazıyor; tahmini ölçüm gibi göstermek olmaz.
 */
export function estimateAirflowSpeedDensity(input: {
  rpm: number;
  mapKpa: number;
  iatC: number;
  /** Varsayılan volumetrik verim. Kısmi gazda 0.75-0.90 tipiktir. */
  assumedVe?: number;
  vehicle?: VehicleProfile;
}): number | null {
  const v = input.vehicle ?? MINI_R50;
  const { rpm, mapKpa, iatC } = input;
  if (rpm <= 0 || mapKpa <= 0) return null;

  const tempK = iatC + 273.15;
  if (tempK <= 0) return null;

  const ve = input.assumedVe ?? NOMINAL_VOLUMETRIC_EFFICIENCY;
  const displacementM3 = v.displacementL / 1000;
  const intakeCyclesPerSec = rpm / 60 / 2;

  const kgPerSec =
    (mapKpa * 1000 * displacementM3 * intakeCyclesPerSec * ve) / (PHYSICS.airGasConstant * tempK);
  return kgPerSec * 1000; // g/s
}

/**
 * Nominal volumetrik verim varsayımı.
 *
 * Ölçülemediği için sabit. Kısmi gazda gerçek değer bunun altında, tam gazda
 * üstünde kalır — yani tahmin rölantide iyimser, tam gazda kötümserdir.
 */
export const NOMINAL_VOLUMETRIC_EFFICIENCY = 0.85;

/**
 * Anlık yakıt tüketimi (L/saat), MAF'tan.
 *
 * Stokiyometrik karışım varsayar. Tam gazda motor zenginleştirme yapar,
 * o anlarda gerçek tüketim bundan yüksektir — yani bu değer normal
 * sürüşte iyi, tam gazda iyimserdir.
 */
export function fuelRateLitersPerHour(mafGs: number): number | null {
  if (mafGs <= 0) return null;
  const fuelGramsPerSec = mafGs / PHYSICS.stoichiometricAfr;
  const litersPerSec = fuelGramsPerSec / PHYSICS.gasolineDensityGPerL;
  return litersPerSec * 3600;
}

/** Anlık tüketim (L/100km). Durağan araçta tanımsızdır (sonsuz). */
export function fuelPer100Km(mafGs: number, speedKmh: number): number | null {
  const lph = fuelRateLitersPerHour(mafGs);
  if (lph === null || speedKmh <= 1) return null;
  return (lph / speedKmh) * 100;
}

/**
 * Isınma süresi (saniye) — termostat sağlığının doğrudan ölçüsü.
 *
 * R50'de termostat arızası bilinen bir sorundur: açık takılı kalan termostat
 * motorun çalışma sıcaklığına hiç ulaşamamasına ya da çok geç ulaşmasına
 * yol açar. Bu ölçüm soğuk çalıştırmada anlamlıdır; motor zaten sıcakken
 * yapılan kayıt `null` döner.
 */
export function warmupSeconds(
  coolantSeries: readonly TimeSeriesPoint[],
  targetC: number = MINI_R50.thermostatOpenC,
  maxStartC = 60,
): number | null {
  const pts = [...coolantSeries].sort((a, b) => a.ts - b.ts);
  if (pts.length === 0) return null;
  if (pts[0].value > maxStartC) return null; // soğuk başlangıç değil

  const reached = pts.find((p) => p.value >= targetC);
  if (!reached) return null;
  return (reached.ts - pts[0].ts) / 1000;
}

/**
 * Rölanti kararlılığı — devir standart sapması (RPM).
 *
 * Tekleme, kirli enjektör ya da vakum kaçağı rölantiyi dalgalandırır.
 * Sağlıklı bir motorda sapma tipik olarak 20-30 RPM altındadır; 60+ RPM
 * bir şeylerin yolunda olmadığının kaba ama kullanışlı bir işaretidir.
 */
export function idleRpmStability(
  rpmSeries: readonly TimeSeriesPoint[],
  speedSeries: readonly TimeSeriesPoint[],
  vehicle: VehicleProfile = MINI_R50,
): { stdDev: number; meanRpm: number; sampleCount: number } | null {
  // "Hız verisi yok" ile "hız verisi var ama araç hareket hâlinde" farklı
  // şeylerdir: ilkinde devir bandına güvenip devam ederiz, ikincisinde
  // rölanti diye bir şey yoktur ve ölçüm yapılmamalıdır.
  const haveSpeedData = speedSeries.length > 0;
  const stoppedTimes = speedSeries.filter((s) => s.value <= 1).map((s) => s.ts);

  const idleBand = rpmSeries.filter((r) => {
    const inIdleRange = r.value > vehicle.idleRpm * 0.6 && r.value < vehicle.idleRpm * 1.8;
    if (!inIdleRange) return false;
    if (!haveSpeedData) return true;
    // Hız örneği tam aynı ts'te olmayabilir; en yakın 2 sn içinde duruyorsa say.
    return stoppedTimes.some((ts) => Math.abs(ts - r.ts) <= 2000);
  });

  if (idleBand.length < 5) return null;

  const values = idleBand.map((p) => p.value);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { stdDev: Math.sqrt(variance), meanRpm: mean, sampleCount: values.length };
}

/**
 * Yakıt trim değerlendirmesi.
 *
 * STFT + LTFT toplamı motorun stokiyometriden ne kadar saptığını gösterir:
 *   > +%10  : sistem fakir çalışıyor -> vakum/emme kaçağı, zayıf yakıt pompası,
 *             kirli MAF (klasik R50 senaryosu emme manifoldu contası)
 *   < -%10  : sistem zengin -> sızdıran enjektör, tıkalı hava filtresi,
 *             arızalı yakıt basınç regülatörü
 * Aradaki bölge normaldir.
 */
export function fuelTrimAssessment(
  stftPct: number,
  ltftPct: number,
): { total: number; verdict: 'lean' | 'rich' | 'normal' } {
  const total = stftPct + ltftPct;
  if (total > 10) return { total, verdict: 'lean' };
  if (total < -10) return { total, verdict: 'rich' };
  return { total, verdict: 'normal' };
}

// ---------------------------------------------------------------------------
// Konum tabanlı
// ---------------------------------------------------------------------------

/** İki koordinat arası mesafe (metre) — haversine. */
export function haversineMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Yol eğimi (%). Yatay mesafe ve yükseklik farkından.
 *
 * GPS yüksekliği yatay konumdan belirgin daha gürültülüdür; kısa mesafede
 * anlamsız değerler çıkar. Bu yüzden minimum mesafe şartı var — altındaysa
 * `null` döner, uydurma yapmaz.
 */
export function gradePercent(
  horizontalMeters: number,
  altitudeDeltaMeters: number,
  minDistanceM = 50,
): number | null {
  if (horizontalMeters < minDistanceM) return null;
  return (altitudeDeltaMeters / horizontalMeters) * 100;
}

/**
 * Tekerlekteki gücü tahmin eder (kW).
 *
 * P = (atalet + yerçekimi + yuvarlanma + aerodinamik) × hız
 *
 * Bu bir dinamometre DEĞİLDİR: kütle tahminine, katsayılara ve düz bir yol
 * varsayımına dayanır. Mutlak değeri değil, aynı koşullarda zaman içindeki
 * DEĞİŞİMİ anlamlıdır (ör. bakım öncesi/sonrası karşılaştırma).
 */
export function estimatedWheelPowerKw(input: {
  speedKmh: number;
  accelMs2: number;
  gradePercent?: number;
  vehicle?: VehicleProfile;
  airDensity?: number;
}): number | null {
  const v = input.vehicle ?? MINI_R50;
  const speedMs = input.speedKmh / 3.6;
  if (speedMs <= 0) return null;

  const rho = input.airDensity ?? PHYSICS.airDensitySeaLevel;
  const gradeRatio = (input.gradePercent ?? 0) / 100;

  const inertial = v.massKg * input.accelMs2;
  const gravity = v.massKg * PHYSICS.g * Math.sin(Math.atan(gradeRatio));
  const rolling = v.rollingResistance * v.massKg * PHYSICS.g;
  const aero = 0.5 * rho * v.dragCoefficient * v.frontalAreaM2 * speedMs * speedMs;

  const totalForceN = inertial + gravity + rolling + aero;
  return (totalForceN * speedMs) / 1000;
}

/** kW -> metrik beygir (PS). */
export function kwToPs(kw: number): number {
  return kw * 1.35962;
}

/**
 * Kilometre saati sapması (%) — OBD hızı ile GPS hızı arasındaki fark.
 *
 * Üreticiler kilometre saatini bilerek yüksek gösterir (yasal olarak eksik
 * göstermesi yasaktır), tipik +%2-5. Bunun belirgin dışına çıkması lastik
 * ebadı değişiminin işaretidir.
 */
export function speedometerErrorPercent(
  obdSpeedKmh: number,
  gpsSpeedKmh: number,
  minSpeedKmh = 30,
): number | null {
  if (gpsSpeedKmh < minSpeedKmh) return null; // düşük hızda GPS gürültülü
  return ((obdSpeedKmh - gpsSpeedKmh) / gpsSpeedKmh) * 100;
}

/**
 * Sert olayları (ani fren / sert viraj) bulur.
 *
 * İvmeölçer büyüklüğünü kullanır: telefon yönelimi bilinmediği için
 * yönü değil ŞİDDETİ ölçüyoruz. Durağanken büyüklük ~1g'dir (yerçekimi),
 * o yüzden eşik 1g'nin üstünde sapma olarak tanımlı.
 */
export function detectHarshEvents(
  accelMagnitudeSeries: readonly TimeSeriesPoint[],
  thresholdG = 0.35,
): TimeSeriesPoint[] {
  return accelMagnitudeSeries.filter((p) => Math.abs(p.value - 1) >= thresholdG);
}

// ---------------------------------------------------------------------------
// Oturum özeti
// ---------------------------------------------------------------------------

export interface TripSummary {
  readonly durationSec: number;
  readonly maxSpeedKmh: number | null;
  readonly avgSpeedKmh: number | null;
  readonly idlePercent: number | null;
  readonly zeroToHundredSec: number | null;
  readonly warmupSec: number | null;
  readonly maxPowerKw: number | null;
  readonly avgFuelPer100Km: number | null;
  readonly harshEventCount: number;
  /** Sürüş boyunca ortanca volumetrik verim — motor sağlığının tek en iyi göstergesi. */
  readonly medianVolumetricEfficiency: number | null;
  /** OBD hızının GPS'e göre sapması (%) — lastik ebadı değişimini ortaya çıkarır. */
  readonly speedometerErrorPct: number | null;
  /** Rölantide devir standart sapması — tekleme/kirli enjektör erken işareti. */
  readonly idleRpmStdDev: number | null;
  /** STFT+LTFT toplamı ve yorumu — vakum kaçağını kod çıkmadan yakalar. */
  readonly fuelTrim: { total: number; verdict: 'lean' | 'rich' | 'normal' } | null;
  /**
   * Tahmini azami MOTOR torku (Nm) — lastik çevresi ve ölçülen aktarma
   * oranı üzerinden tekerlek kuvvetinden geri hesaplanır. Dinamometre
   * değildir; kütle, sürtünme ve aktarma verimi varsayımlarına dayanır.
   */
  readonly maxEngineTorqueNm: number | null;
}

/** Kanal anahtarına göre gruplanmış seriler. */
export type SeriesMap = Readonly<Record<string, readonly TimeSeriesPoint[]>>;

/**
 * Bir oturumun insan okur özeti. Hesaplanamayan alanlar `null` döner —
 * eksik veriyi sıfırla doldurmak yanıltıcı olurdu.
 */
export function summarizeTrip(series: SeriesMap, vehicle: VehicleProfile = MINI_R50): TripSummary {
  const speed = series['gps_speed']?.length ? series['gps_speed'] : (series['0D'] ?? []);
  const rpm = series['0C'] ?? [];
  const coolant = series['05'] ?? [];
  const maf = series['10'] ?? [];
  const accelMag = series['accel_magnitude'] ?? [];

  /**
   * Süre: bütün kanalların uçlarından. Tek bir dev dizi kurup spread etmek
   * yerine kanal kanal geziliyor — uzun oturumlarda spread'in argüman
   * tavanına takılıp çökmesinin sebebi buydu (bkz. util/agg.ts).
   */
  let tsMin: number | null = null;
  let tsMax: number | null = null;
  for (const points of Object.values(series)) {
    const span = extentOf(points.map((p) => p.ts));
    if (!span) continue;
    if (tsMin === null || span.min < tsMin) tsMin = span.min;
    if (tsMax === null || span.max > tsMax) tsMax = span.max;
  }
  const durationSec = tsMin !== null && tsMax !== null ? (tsMax - tsMin) / 1000 : 0;

  const speedValues = speed.map((p) => p.value);
  const maxSpeedKmh = maxOf(speedValues);
  const avgSpeedKmh =
    speedValues.length > 0 ? speedValues.reduce((a, b) => a + b, 0) / speedValues.length : null;

  const idlePercent =
    speedValues.length > 0
      ? (speedValues.filter((v) => v <= 1).length / speedValues.length) * 100
      : null;

  const run = fastestRunToSpeed(speed, 100);
  const accel = accelerationSeries(speed);

  let maxPowerKw: number | null = null;
  for (const a of accel) {
    const nearestSpeed = nearestValue(speed, a.ts);
    if (nearestSpeed === null) continue;
    const p = estimatedWheelPowerKw({ speedKmh: nearestSpeed, accelMs2: a.value, vehicle });
    if (p !== null && (maxPowerKw === null || p > maxPowerKw)) maxPowerKw = p;
  }

  /**
   * Hava kütlesi serisi: MAF varsa ölçüm, yoksa speed-density tahmini.
   *
   * R50'de MAF YOK (2026-09-05 tarama raporu: bitmask BE3EB811, PID 10
   * desteklenmiyor). Tüketimi yalnızca MAF'a bağlamak, bu araçta metriği
   * sonsuza kadar boş bırakırdı; MAP + emme havası sıcaklığı kaydedildiğinde
   * tahmin üretilebiliyor. Tahmin olduğu kullanıcıya ayrıca söyleniyor.
   */
  const map = series['0B'] ?? [];
  const iat = series['0F'] ?? [];

  const airflow: TimeSeriesPoint[] =
    maf.length > 0
      ? [...maf]
      : rpm
          .map((r) => {
            const mp = nearestValue(map, r.ts);
            const it = nearestValue(iat, r.ts);
            if (mp === null || it === null) return null;
            const gs = estimateAirflowSpeedDensity({
              rpm: r.value,
              mapKpa: mp,
              iatC: it,
              vehicle,
            });
            return gs === null ? null : { ts: r.ts, value: gs };
          })
          .filter((p): p is TimeSeriesPoint => p !== null);

  const fuelValues: number[] = [];
  for (const m of airflow) {
    const s = nearestValue(speed, m.ts);
    if (s === null) continue;
    const f = fuelPer100Km(m.value, s);
    if (f !== null && f < 100) fuelValues.push(f); // absürt değerleri ele
  }

  // --- volumetrik verim: her örnekte hesaplanıp ortancası alınıyor ---
  const veValues: number[] = [];
  for (const m of maf) {
    const r = nearestValue(rpm, m.ts);
    const mp = nearestValue(map, m.ts);
    const it = nearestValue(iat, m.ts);
    if (r === null || mp === null || it === null) continue;
    const ve = volumetricEfficiency({ rpm: r, mapKpa: mp, iatC: it, mafGs: m.value, vehicle });
    // Absürt değerleri ele — tek bir kötü örnek ortancayı bozmamalı ama
    // fizik dışı sonuçlar zaten ölçüm hatasıdır.
    if (ve !== null && ve > 5 && ve < 200) veValues.push(ve);
  }
  veValues.sort((a, b) => a - b);
  const medianVolumetricEfficiency =
    veValues.length > 0 ? veValues[Math.floor(veValues.length / 2)] : null;

  // --- kilometre saati sapması: yalnızca ikisi de varken ve yeterli hızda ---
  const obdSpeed = series['0D'] ?? [];
  const gpsSpeed = series['gps_speed'] ?? [];
  const speedoErrors: number[] = [];
  for (const g of gpsSpeed) {
    if (g.value < 30) continue;
    const o = nearestValue(obdSpeed, g.ts);
    if (o === null) continue;
    speedoErrors.push(((o - g.value) / g.value) * 100);
  }
  const speedometerErrorPct =
    speedoErrors.length > 0
      ? speedoErrors.reduce((a, b) => a + b, 0) / speedoErrors.length
      : null;

  /**
   * --- tahmini motor torku ---
   *
   * Lastik ebadı girildiği için artık mümkün: tekerlek kuvveti × yarıçap =
   * tekerlek torku, bunu ölçülen toplam aktarma oranına bölünce motor torku
   * çıkıyor. Oran anlık ölçülüyor (devir / tekerlek devri), yayımlanmış bir
   * vites tablosuna ihtiyaç yok.
   *
   * Yalnızca HIZLANIRKEN ve makul hızda örnekler alınıyor: sabit hızda
   * kuvvet yalnızca sürtünmeyi yener, tepe torkla ilgisi olmaz.
   */
  const circumference = rollingCircumferenceMm(vehicle.fittedTyre);
  let maxEngineTorqueNm: number | null = null;
  for (const a of accel) {
    if (a.value < 0.5) continue; // belirgin hızlanma yoksa anlamsız
    const v = nearestValue(speed, a.ts);
    const r = nearestValue(rpm, a.ts);
    if (v === null || r === null || v < 20) continue;

    const ratio = totalDriveRatio(r, v, circumference);
    if (ratio === null) continue;

    const force = roadLoadForceN({ speedKmh: v, accelMs2: a.value, vehicle });
    const torque = estimatedEngineTorqueNm({
      wheelForceN: force,
      circumferenceMm: circumference,
      totalRatio: ratio,
    });
    // Fizik dışı sonuçlar ölçüm hatasıdır; tepe değeri bozmasınlar.
    if (torque !== null && torque > 0 && torque < 500) {
      if (maxEngineTorqueNm === null || torque > maxEngineTorqueNm) maxEngineTorqueNm = torque;
    }
  }

  // --- rölanti kararlılığı ---
  const idle = idleRpmStability(rpm, speed, vehicle);

  // --- yakıt trim değerlendirmesi: her ikisinin son değeriyle ---
  const stft = series['06'] ?? [];
  const ltft = series['07'] ?? [];
  const fuelTrim =
    stft.length > 0 && ltft.length > 0
      ? fuelTrimAssessment(stft[stft.length - 1].value, ltft[ltft.length - 1].value)
      : null;

  return {
    durationSec,
    maxSpeedKmh,
    avgSpeedKmh,
    idlePercent,
    zeroToHundredSec: run?.seconds ?? null,
    warmupSec: warmupSeconds(coolant, vehicle.thermostatOpenC),
    maxPowerKw,
    avgFuelPer100Km:
      fuelValues.length > 0 ? fuelValues.reduce((a, b) => a + b, 0) / fuelValues.length : null,
    harshEventCount: detectHarshEvents(accelMag).length,
    medianVolumetricEfficiency,
    speedometerErrorPct,
    idleRpmStdDev: idle?.stdDev ?? null,
    fuelTrim,
    maxEngineTorqueNm,
  };
}

/**
 * Özetteki her BOŞ alanın nedeni.
 *
 * Gerekçe: "—" tek başına kullanıcıya hiçbir şey söylemiyor. Üç bambaşka
 * durum aynı çizgiyle gösteriliyordu ve kullanıcı hangisi olduğunu bilemiyordu:
 *
 *   - kanal kaydedilmemiş        → EYLEM VAR: o kanalı seçip tekrar kaydet
 *   - kanal var ama koşul oluşmamış → EYLEM VAR ama başka: 100 km/h'a çık,
 *                                     soğuk motorla başla
 *   - araç o sensöre sahip değil → EYLEM YOK
 *
 * Bu fonksiyon saf: seriye bakar, her boş alan için tek cümlelik sebep döner.
 * Dolu alanlar için hiçbir şey döndürmez.
 */
export function explainSummaryGaps(
  series: SeriesMap,
  summary: TripSummary,
): Record<string, string> {
  const out: Record<string, string> = {};
  const hasChannel = (key: string) => (series[key]?.length ?? 0) > 0;
  const values = (key: string) => (series[key] ?? []).map((p) => p.value);

  const speed = hasChannel('gps_speed') ? values('gps_speed') : values('0D');
  const maxSpeed = maxOf(speed);

  if (summary.zeroToHundredSec === null) {
    out.zeroToHundredSec =
      maxSpeed === null
        ? 'needs vehicle speed'
        : `top speed here was ${Math.round(maxSpeed)} km/h — a full 0-100 run is required`;
  }

  if (summary.warmupSec === null) {
    const coolant = values('05');
    out.warmupSec =
      coolant.length === 0
        ? 'needs coolant temperature'
        : coolant[0] > 60
          ? `engine was already warm at the start (${Math.round(coolant[0])} °C) — record from a cold start`
          : 'coolant never reached the thermostat opening temperature in this trip';
  }

  if (summary.avgFuelPer100Km === null) {
    const missing: string[] = [];
    if (!hasChannel('0B')) missing.push('MAP');
    if (!hasChannel('0F')) missing.push('intake air temp');
    if (!hasChannel('0C')) missing.push('RPM');
    out.avgFuelPer100Km =
      hasChannel('10')
        ? 'needs vehicle speed alongside air mass'
        : missing.length > 0
          ? `no MAF on this car — the speed-density estimate needs ${missing.join(' + ')}`
          : 'needs vehicle speed alongside the air-mass estimate';
  }

  if (summary.medianVolumetricEfficiency === null) {
    out.medianVolumetricEfficiency = hasChannel('10')
      ? 'needs RPM + MAP + intake air temp as well'
      : 'impossible on this car — it has no MAF sensor, and estimating airflow already assumes an efficiency';
  }

  if (summary.speedometerErrorPct === null) {
    if (!hasChannel('gps_speed')) out.speedometerErrorPct = 'needs the GPS sensor';
    else if (!hasChannel('0D')) out.speedometerErrorPct = 'needs vehicle speed from the ECU';
    else
      out.speedometerErrorPct = `needs GPS speed above 30 km/h — this trip peaked at ${Math.round(maxSpeed ?? 0)} km/h`;
  }

  if (summary.fuelTrim === null) {
    const missing: string[] = [];
    if (!hasChannel('06')) missing.push('short term fuel trim');
    if (!hasChannel('07')) missing.push('long term fuel trim');
    out.fuelTrim = missing.length > 0 ? `needs ${missing.join(' + ')}` : 'no readings in this trip';
  }

  if (summary.maxPowerKw === null) out.maxPowerKw = 'needs vehicle speed over time';
  if (summary.maxEngineTorqueNm === null) {
    const missing: string[] = [];
    if (!hasChannel('0C')) missing.push('RPM');
    if (!hasChannel('0D')) missing.push('vehicle speed');
    out.maxEngineTorqueNm =
      missing.length > 0
        ? `needs ${missing.join(' + ')}`
        : 'no accelerating pull above 20 km/h in this trip';
  }
  if (summary.idleRpmStdDev === null) {
    out.idleRpmStdDev = !hasChannel('0C')
      ? 'needs engine RPM'
      : 'no stationary idling found in this trip';
  }
  if (summary.maxSpeedKmh === null) out.maxSpeedKmh = 'needs vehicle speed';
  if (summary.avgSpeedKmh === null) out.avgSpeedKmh = 'needs vehicle speed';
  if (summary.idlePercent === null) out.idlePercent = 'needs vehicle speed';

  return out;
}

/**
 * Bir özet alanının hangi OBD PID'lerine ihtiyacı olduğu.
 *
 * `alternatives`: her biri yeterli olan kümelerden herhangi biri
 * destekleniyorsa alan hesaplanabilir demektir. Örneğin tüketim ya MAF
 * ölçümüyle (10) ya da speed-density üçlüsüyle (0C + 0B + 0F) çıkar.
 *
 * Burada YALNIZCA ECU'ya bağlı alanlar var. Telefon sensörlerine dayanan
 * alanlar (sert olay sayısı gibi) araçtan bağımsız olduğu için listede yok:
 * onlar "araç desteklemiyor" olamaz.
 */
export const SUMMARY_REQUIREMENTS: readonly {
  readonly field: string;
  readonly alternatives: readonly (readonly string[])[];
}[] = [
  { field: 'warmupSec', alternatives: [['05']] },
  { field: 'idleRpmStdDev', alternatives: [['0C']] },
  { field: 'fuelTrim', alternatives: [['06', '07']] },
  // Tüketim: gerçek MAF ölçümü YA DA speed-density tahmini.
  { field: 'avgFuelPer100Km', alternatives: [['10'], ['0C', '0B', '0F']] },
  /**
   * Volumetrik verim yalnızca GERÇEK MAF ile mümkün. Speed-density tahmini
   * zaten bir verim varsayımı içerdiği için onunla verim hesaplamak
   * döngüsel olurdu — bu yüzden tek alternatif var.
   */
  { field: 'medianVolumetricEfficiency', alternatives: [['10', '0C', '0B', '0F']] },
  // Tork için devir ve hız birlikte gerekiyor: oran ikisinden çıkıyor.
  { field: 'maxEngineTorqueNm', alternatives: [['0C', '0D']] },
];

/**
 * Bu ECU'da HİÇBİR ŞEKİLDE hesaplanamayacak özet alanları.
 *
 * Amaç arayüzü sadeleştirmek: kullanıcının asla dolduramayacağı bir satırı
 * ömür boyu "—" olarak göstermek, ekranı kalabalıklaştırmaktan başka bir işe
 * yaramıyor. Destek bilgisi yoksa (eski oturumlar, bağlantısız kayıt) hiçbir
 * şey imkânsız sayılmaz — bilmediğimiz bir şeyi eleyemeyiz.
 */
export function impossibleSummaryFields(
  isPidSupported: ((pid: string) => boolean) | null,
): string[] {
  if (!isPidSupported) return [];
  return SUMMARY_REQUIREMENTS.filter(
    (r) => !r.alternatives.some((set) => set.every((pid) => isPidSupported(pid))),
  ).map((r) => r.field);
}

/**
 * Verilen zamana en yakın örneğin değeri (2 sn toleransla).
 *
 * İKİLİ ARAMA, doğrusal tarama DEĞİL. Bu fonksiyon iki seriyi zamana göre
 * eşlemek için kullanılıyor ve her çağrıda seriyi baştan sona taradığında
 * maliyet iki serinin boyunun ÇARPIMI oluyordu. Kısa kayıtta göze
 * batmıyordu; 4483 saniyelik 27 kanallı kayıtta `summarizeTrip` masaüstünde
 * ~9 saniye sürdü, telefonda ise Trips ekranı "Working…" yazısında
 * kilitlendi (2026-09-06). İkili arama aynı sonucu üretir, maliyeti
 * çarpım yerine logaritmik.
 *
 * `series` zamana göre SIRALI olmak zorunda — `groupSeries` bunu garanti
 * ediyor, bu modüldeki tüm çağrılar oradan geliyor. Sıralılık varsayımının
 * kolay doğrulanabilmesi için dışa açık (bkz. tests/longSession.test.ts).
 */
export function nearestValue(
  series: readonly TimeSeriesPoint[],
  ts: number,
  toleranceMs = 2000,
): number | null {
  if (series.length === 0) return null;

  // İlk `ts`'ten küçük olmayan örneği bul.
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }

  // En yakın aday ya bulunan örnek ya da bir öncekidir.
  const after = lo < series.length ? series[lo] : null;
  // Aynı zaman damgasını taşıyan örnek grubunda İLKİ seçiliyor: doğrusal
  // tarama diziyi baştan gezdiği için ilkini bulurdu, davranış korunuyor.
  let beforeIndex = lo - 1;
  while (beforeIndex > 0 && series[beforeIndex - 1].ts === series[beforeIndex].ts) beforeIndex--;
  const before = beforeIndex >= 0 ? series[beforeIndex] : null;

  let best: TimeSeriesPoint | null = null;
  let bestDist = Infinity;
  // Eşitlikte ÖNCEKİ kazanır — doğrusal taramanın davranışı da buydu.
  if (before !== null) {
    best = before;
    bestDist = Math.abs(before.ts - ts);
  }
  if (after !== null && Math.abs(after.ts - ts) < bestDist) {
    best = after;
    bestDist = Math.abs(after.ts - ts);
  }

  return best !== null && bestDist <= toleranceMs ? best.value : null;
}

/** `Sample[]` listesini kanal anahtarına göre serilere böler. */
export function groupSeries(
  samples: readonly { ts: number; pid: string; value: number }[],
): SeriesMap {
  const out: Record<string, TimeSeriesPoint[]> = {};
  for (const s of samples) {
    (out[s.pid] ??= []).push({ ts: s.ts, value: s.value });
  }
  for (const key of Object.keys(out)) out[key].sort((a, b) => a.ts - b.ts);
  return out;
}
