/**
 * Anlık türetilmiş ölçümler — canlı ekranda gösterilenler.
 *
 * Bunlar DB'ye YAZILMAZ. Hepsi kayıtlı kanalların fonksiyonu olduğu için
 * saklamak veriyi ikizlemek olurdu; üstelik formül geliştiğinde eski
 * oturumlar eski sonuçla kalırdı. Gösterim anında hesaplanıyorlar, aynı
 * hesap Trips ekranında geçmiş oturumlara da uygulanabiliyor.
 *
 * Bir metrik hesaplanamıyorsa `value: null` ve `missing` ile HANGİ kanalın
 * eksik olduğu döner — "—" gösterip kullanıcıyı neyin eksik olduğunu tahmin
 * etmeye bırakmak yerine, hangi kanalı açması gerektiğini söylüyoruz.
 */

import {
  volumetricEfficiency,
  fuelPer100Km,
  fuelRateLitersPerHour,
  estimatedWheelPowerKw,
  accelerationSeries,
  type SeriesMap,
} from './derived';
import { MINI_R50, type VehicleProfile } from './vehicle';

export interface DerivedReading {
  readonly key: string;
  readonly name: string;
  /** Izgara hücresi etiketi. */
  readonly short: string;
  readonly unit: string;
  readonly value: number | null;
  /** Hesap için eksik olan kanalların insan okur adları. */
  readonly missing: readonly string[];
}

/** Bir kanalın en son değeri. */
function latest(series: SeriesMap, key: string): number | null {
  const s = series[key];
  if (!s || s.length === 0) return null;
  return s[s.length - 1].value;
}

/** Hız için önce GPS, yoksa OBD — GPS mutlak referans olduğu için önce o. */
function speedSeries(series: SeriesMap) {
  const gps = series['gps_speed'];
  if (gps && gps.length > 1) return gps;
  return series['0D'] ?? [];
}

/**
 * Canlı türetilmiş okumalar. Girdi kanalları seçili değilse metrik
 * hesaplanmaz ama listede kalır — böylece kullanıcı neyin mümkün olduğunu
 * ve ne açması gerektiğini görür.
 */
export function deriveLive(
  series: SeriesMap,
  vehicle: VehicleProfile = MINI_R50,
): DerivedReading[] {
  const rpm = latest(series, '0C');
  const maf = latest(series, '10');
  const map = latest(series, '0B');
  const iat = latest(series, '0F');
  const obdSpeed = latest(series, '0D');
  const gpsSpeed = latest(series, 'gps_speed');
  const speed = gpsSpeed ?? obdSpeed;

  const out: DerivedReading[] = [];

  // --- Volumetrik verim: motorun nefes alma sağlığı ---
  {
    const missing: string[] = [];
    if (rpm === null) missing.push('RPM');
    if (map === null) missing.push('MAP');
    if (iat === null) missing.push('Intake air');
    if (maf === null) missing.push('Air mass');
    const value =
      missing.length === 0
        ? volumetricEfficiency({ rpm: rpm!, mapKpa: map!, iatC: iat!, mafGs: maf!, vehicle })
        : null;
    out.push({
      key: 'derived_ve',
      name: 'Volumetric efficiency',
      short: 'Vol. eff.',
      unit: '%',
      value,
      missing,
    });
  }

  // --- Anlık tüketim ---
  {
    const missing: string[] = [];
    if (maf === null) missing.push('Air mass');
    if (speed === null) missing.push('Speed');
    const value = missing.length === 0 ? fuelPer100Km(maf!, speed!) : null;
    out.push({
      key: 'derived_consumption',
      name: 'Consumption',
      short: 'Fuel',
      unit: 'L/100km',
      value,
      missing,
    });
  }

  // --- Yakıt debisi (durağanken de anlamlı, rölanti tüketimi) ---
  {
    const missing = maf === null ? ['Air mass'] : [];
    const value = maf !== null ? fuelRateLitersPerHour(maf) : null;
    out.push({
      key: 'derived_fuel_rate',
      name: 'Fuel rate',
      short: 'Fuel rate',
      unit: 'L/h',
      value,
      missing,
    });
  }

  // --- Tahmini teker gücü ---
  {
    const spd = speedSeries(series);
    const accel = accelerationSeries(spd);
    const missing: string[] = [];
    if (spd.length < 2) missing.push('Speed');
    const lastAccel = accel.length > 0 ? accel[accel.length - 1].value : null;
    const value =
      speed !== null && lastAccel !== null
        ? estimatedWheelPowerKw({ speedKmh: speed, accelMs2: lastAccel, vehicle })
        : null;
    out.push({
      key: 'derived_power',
      name: 'Estimated wheel power',
      short: 'Power',
      unit: 'kW',
      value,
      missing,
    });
  }

  // --- Kilometre saati sapması: OBD hızı ile GPS hızı farkı ---
  {
    const missing: string[] = [];
    if (obdSpeed === null) missing.push('Speed');
    if (gpsSpeed === null) missing.push('GPS speed');
    // Düşük hızda GPS gürültülü olduğu için eşik derived.ts içinde uygulanıyor.
    const value =
      obdSpeed !== null && gpsSpeed !== null && gpsSpeed >= 30
        ? ((obdSpeed - gpsSpeed) / gpsSpeed) * 100
        : null;
    out.push({
      key: 'derived_speedo',
      name: 'Speedometer error',
      short: 'Speedo',
      unit: '%',
      value,
      missing,
    });
  }

  return out;
}
