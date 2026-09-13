/**
 * Anlık türetilmiş ölçümler — canlı ekranda gösterilenler.
 *
 * Bunlar DB'ye YAZILMAZ. Hepsi kayıtlı kanalların fonksiyonu olduğu için
 * saklamak veriyi ikizlemek olurdu; üstelik formül geliştiğinde eski
 * oturumlar eski sonuçla kalırdı. Gösterim anında hesaplanıyorlar.
 *
 * Üç durum ayrı ayrı ele alınıyor, çünkü kullanıcı için üçü farklı şey:
 *   - hesaplandı           → değer var
 *   - kanal seçili değil   → EYLEM alınabilir: kanalı aç
 *   - araç desteklemiyor   → eylem yok, metrik bu araçta hiç mümkün değil
 * Üçünü "—" ile göstermek kullanıcıyı boşuna uğraştırırdı.
 */

import {
  volumetricEfficiency,
  fuelPer100Km,
  fuelRateLitersPerHour,
  estimateAirflowSpeedDensity,
  estimatedWheelPowerKw,
  accelerationSeries,
  type SeriesMap,
} from './derived';
import { MINI_R50, type VehicleProfile } from './vehicle';

export interface DerivedReading {
  readonly key: string;
  readonly name: string;
  readonly short: string;
  readonly unit: string;
  readonly value: number | null;
  /** Seçilmediği için eksik olan kanalların adları — kullanıcı açabilir. */
  readonly missing: readonly string[];
  /** Aracın hiç desteklemediği için imkânsız olan kanalların adları. */
  readonly unsupported: readonly string[];
  /** Değer ölçüm değil tahminse kısa gerekçe (UI'da gösterilir). */
  readonly estimateNote?: string;
}

function latest(series: SeriesMap, key: string): number | null {
  const s = series[key];
  if (!s || s.length === 0) return null;
  return s[s.length - 1].value;
}

function speedSeries(series: SeriesMap) {
  const gps = series['gps_speed'];
  if (gps && gps.length > 1) return gps;
  return series['0D'] ?? [];
}

export interface DeriveOptions {
  readonly vehicle?: VehicleProfile;
  /**
   * Aracın PID desteği. Verilirse "kanalı aç" ile "araç desteklemiyor"
   * ayrımı yapılabilir; verilmezse hepsi "kanalı aç" sayılır.
   */
  readonly isPidSupported?: (pid: string) => boolean;
}

export function deriveLive(series: SeriesMap, options: DeriveOptions = {}): DerivedReading[] {
  const vehicle = options.vehicle ?? MINI_R50;
  const supported = options.isPidSupported ?? (() => true);

  const rpm = latest(series, '0C');
  const maf = latest(series, '10');
  const map = latest(series, '0B');
  const iat = latest(series, '0F');
  const obdSpeed = latest(series, '0D');
  const gpsSpeed = latest(series, 'gps_speed');
  const speed = gpsSpeed ?? obdSpeed;

  /** Bir PID eksikse, aracın desteklememesinden mi yoksa seçilmemesinden mi? */
  const classify = (
    pid: string,
    name: string,
    value: number | null,
    missing: string[],
    unsupported: string[],
  ) => {
    if (value !== null) return;
    if (!supported(pid)) unsupported.push(name);
    else missing.push(name);
  };

  const out: DerivedReading[] = [];

  // --- Hava kütlesi: ölçüm (MAF) varsa o, yoksa speed-density tahmini ---
  const mafMeasured = maf;
  const airflowEstimated =
    mafMeasured === null && rpm !== null && map !== null && iat !== null
      ? estimateAirflowSpeedDensity({ rpm, mapKpa: map, iatC: iat, vehicle })
      : null;
  const airflow = mafMeasured ?? airflowEstimated;
  const airflowIsEstimate = mafMeasured === null && airflowEstimated !== null;
  const estimateNote = airflowIsEstimate ? 'speed-density estimate, no MAF sensor' : undefined;

  const airflowMissing: string[] = [];
  const airflowUnsupported: string[] = [];
  if (airflow === null) {
    // MAF yoksa speed-density için gerekenleri say.
    classify('10', 'Air mass', mafMeasured, [], airflowUnsupported);
    classify('0C', 'RPM', rpm, airflowMissing, airflowUnsupported);
    classify('0B', 'MAP', map, airflowMissing, airflowUnsupported);
    classify('0F', 'Intake air', iat, airflowMissing, airflowUnsupported);
  }

  // --- Volumetrik verim ---
  {
    const missing: string[] = [];
    const unsupported: string[] = [];
    classify('0C', 'RPM', rpm, missing, unsupported);
    classify('0B', 'MAP', map, missing, unsupported);
    classify('0F', 'Intake air', iat, missing, unsupported);
    // VE ancak GERÇEK hava kütlesi ölçümüyle hesaplanabilir. Speed-density
    // tahmini zaten VE varsayımı içerdiği için onunla VE hesaplamak döngüsel
    // olurdu — bu araçta metrik dürüstçe "mümkün değil" olarak işaretleniyor.
    classify('10', 'Air mass (MAF)', mafMeasured, missing, unsupported);

    const value =
      rpm !== null && map !== null && iat !== null && mafMeasured !== null
        ? volumetricEfficiency({ rpm, mapKpa: map, iatC: iat, mafGs: mafMeasured, vehicle })
        : null;

    out.push({
      key: 'derived_ve',
      name: 'Volumetric efficiency',
      short: 'Vol. eff.',
      unit: '%',
      value,
      missing,
      unsupported,
    });
  }

  // --- Anlık tüketim ---
  {
    const missing = [...airflowMissing];
    const unsupported = [...airflowUnsupported];
    classify('0D', 'Speed', speed, missing, unsupported);
    const value = airflow !== null && speed !== null ? fuelPer100Km(airflow, speed) : null;
    out.push({
      key: 'derived_consumption',
      name: 'Consumption',
      short: 'Fuel',
      unit: 'L/100km',
      value,
      missing,
      unsupported,
      estimateNote: value !== null ? estimateNote : undefined,
    });
  }

  // --- Yakıt debisi (rölantide de anlamlı) ---
  {
    const value = airflow !== null ? fuelRateLitersPerHour(airflow) : null;
    out.push({
      key: 'derived_fuel_rate',
      name: 'Fuel rate',
      short: 'Fuel rate',
      unit: 'L/h',
      value,
      missing: [...airflowMissing],
      unsupported: [...airflowUnsupported],
      estimateNote: value !== null ? estimateNote : undefined,
    });
  }

  // --- Tahmini teker gücü ---
  {
    const missing: string[] = [];
    const unsupported: string[] = [];
    const spd = speedSeries(series);
    const accel = accelerationSeries(spd);
    const lastAccel = accel.length > 0 ? accel[accel.length - 1].value : null;
    if (spd.length < 2) classify('0D', 'Speed', null, missing, unsupported);

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
      unsupported,
      estimateNote: value !== null ? 'from mass and acceleration, not a dyno' : undefined,
    });
  }

  // --- Kilometre saati sapması ---
  {
    const missing: string[] = [];
    const unsupported: string[] = [];
    classify('0D', 'Speed', obdSpeed, missing, unsupported);
    if (gpsSpeed === null) missing.push('GPS speed');

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
      unsupported,
    });
  }

  return out;
}
