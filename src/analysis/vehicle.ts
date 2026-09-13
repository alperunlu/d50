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

/** Lastik ebadı — aracın verisi olduğu için profil dosyasında tanımlı. */
export interface TyreSize {
  /** Kesit genişliği (mm), ör. 175. */
  readonly widthMm: number;
  /** Yanak oranı (%), ör. 65. */
  readonly aspectRatio: number;
  /** Jant çapı (inç), ör. 15. */
  readonly rimInch: number;
}

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
  /**
   * Motor çalışırken AKÜ UÇLARINDA beklenen gerilim bandı (V).
   *
   * Araca ait: sabit regülatörlü eski sistemlerle, şarjı bilerek kısan
   * modern "akıllı" alternatörlerin bantları aynı değil. R50 (2001-2006)
   * sabit regülatörlü — Valeo regülatörünün ayar noktası ~14.5 V.
   */
  readonly chargingVoltageV: { readonly min: number; readonly max: number };
  /**
   * ECU'nun hız/mesafe hesabında varsaydığı FABRİKA lastik ebadı.
   * Araca ait sabit bir değer; kullanıcı değiştirmez.
   */
  readonly factoryTyre: TyreSize;
  /**
   * Fiilen takılı lastik. Varsayılan olarak fabrika ebadı; kullanıcı
   * kendi ebadını girdiğinde bu alan değişir ve hız/mesafe düzeltmesi,
   * aktarma oranı ve tork tahmini bu değere dayanır.
   */
  readonly fittedTyre: TyreSize;
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
  // Üretici/servis kaynakları: motor çalışırken 13.5-14.8 V, ayar ~14.5 V.
  chargingVoltageV: { min: 13.5, max: 14.8 },
  // R50 Cooper'ın standart ebadı. Kullanıcı farklı bir ebat taktıysa
  // `fittedTyre` ayarlardan güncellenir; fabrika değeri sabit kalır çünkü
  // ECU'nun hız hesabı ona göre kalibre edilmiştir.
  factoryTyre: { widthMm: 175, aspectRatio: 65, rimInch: 15 },
  fittedTyre: { widthMm: 175, aspectRatio: 65, rimInch: 15 },
};

/** Profili farklı bir takılı lastikle kopyalar. */
export function withFittedTyre(vehicle: VehicleProfile, tyre: TyreSize): VehicleProfile {
  return { ...vehicle, fittedTyre: tyre };
}

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

/**
 * Profilin getirdiği ve türetilmiş sonuçları DOĞRUDAN belirleyen sayılar.
 *
 * Raporda yazıyor çünkü bu değerler ölçüm değil varsayım, ve rapordaki
 * güç/tork/tüketim/yol yükü rakamlarının hepsi bunlara bağlı. Kütle 100 kg
 * yanlışsa tork tahmini de o oranda yanlış — okuyan kişinin bunu görmesi,
 * sonra keşfetmesinden iyi.
 */
export function profileAssumptions(v: VehicleProfile): string[] {
  const t = v.fittedTyre;
  return [
    `mass ${v.massKg} kg`,
    `displacement ${v.displacementL.toFixed(3)} L`,
    `Cd ${v.dragCoefficient} over ${v.frontalAreaM2} m²`,
    `rolling resistance ${v.rollingResistance}`,
    `idle ${v.idleRpm} rpm`,
    `tyres ${t.widthMm}/${t.aspectRatio} R${t.rimInch}`,
  ];
}
