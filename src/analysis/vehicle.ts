/**
 * Araç profili — türetilmiş metriklerin dayandığı fiziksel sabitler.
 *
 * Bu dosya, projenin "ileride MINI R50 için özelleştirilecek" hedefinin
 * somut karşılığı: motor hacmi, kütle, aerodinamik katsayılar burada tek
 * yerde toplanıyor. Başka bir araç eklemek yeni bir profil yazmak demek;
 * hesap kodunun hiçbiri değişmiyor.
 *
 * Değerler MINI Cooper R50 (W10B16, 2001-2006) için yayımlanmış tipik
 * spesifikasyonlardır. Kütle sürücü + yakıt dahil tahmindir ve tork/güç
 * tahmininin doğruluğunu doğrudan etkiler — kesin ölçüm isteyen biri
 * kendi aracını tartıp burayı güncellemeli.
 */

export interface VehicleProfile {
  readonly name: string;
  /** Motor hacmi (litre). */
  readonly displacementL: number;
  /** Sürücü + yakıt dahil çalışma kütlesi (kg). */
  readonly massKg: number;
  /** Aerodinamik sürükleme katsayısı. */
  readonly dragCoefficient: number;
  /** Alından görünen kesit alanı (m²). */
  readonly frontalAreaM2: number;
  /** Yuvarlanma direnci katsayısı (asfalt, normal lastik). */
  readonly rollingResistance: number;
  /** Rölanti devri (RPM) — rölanti kalitesi analizinde referans. */
  readonly idleRpm: number;
  /** Termostatın açması beklenen sıcaklık (°C). */
  readonly thermostatOpenC: number;
  /** Normal çalışma sıcaklığı (°C). */
  readonly normalCoolantC: number;
}

/** MINI Cooper R50 (2001-2006, W10B16 1.6L). */
export const MINI_R50: VehicleProfile = {
  name: 'MINI Cooper R50 (2001-2006)',
  displacementL: 1.598,
  massKg: 1215, // ~1140 kg boş + sürücü + yakıt
  dragCoefficient: 0.35,
  frontalAreaM2: 1.97,
  rollingResistance: 0.013,
  idleRpm: 850,
  thermostatOpenC: 88,
  normalCoolantC: 95,
};

/** Standart fiziksel sabitler. */
export const PHYSICS = {
  /** Yerçekimi ivmesi (m/s²). */
  g: 9.80665,
  /** Kuru hava özgül gaz sabiti (J/(kg·K)). */
  airGasConstant: 287.05,
  /** Deniz seviyesinde hava yoğunluğu (kg/m³). */
  airDensitySeaLevel: 1.225,
  /** Benzin için stokiyometrik hava/yakıt oranı. */
  stoichiometricAfr: 14.7,
  /** Benzin yoğunluğu (g/L). */
  gasolineDensityGPerL: 745,
} as const;
