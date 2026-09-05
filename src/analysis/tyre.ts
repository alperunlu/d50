/**
 * Lastik geometrisi ve ondan türeyen ölçümler.
 *
 * Lastik ölçüsü tek başına bir "ayar" değil; birkaç metriğin eksik parçası.
 * Aracın ECU'su hızı tekerlek devrinden hesaplarken FABRİKA lastik çevresini
 * varsayar. Gerçekte takılı olan lastik farklıysa OBD hızı, dolayısıyla
 * mesafe, tüketim ve ivme türevi olan her şey aynı oranda kayar.
 *
 * Girilen ölçüyle şunlar mümkün oluyor:
 *
 *   1. Hız/mesafe düzeltmesi — farklı ebat takılıysa OBD hızı sistematik
 *      hatalı; oran bilindiğinde düzeltilebiliyor.
 *   2. GERÇEK yuvarlanma çevresi — GPS ile OBD hızının oranı, tekerleğin
 *      fiilen ne kadar yol aldığını verir. Bunu girilen ölçünün nominal
 *      çevresiyle karşılaştırmak lastik basıncı/aşınması hakkında bilgi verir.
 *   3. Toplam aktarma oranı — devir ve tekerlek devrinden. Vitesleri
 *      isimlendirmeyi ve kavrama kaymasını sayısallaştırmayı sağlar.
 *   4. Motor torku tahmini — tekerlekteki kuvvet × yarıçap / oran.
 *      Bir vites çekişinden kaba bir tork eğrisi çıkar.
 *
 * Hepsi saf fonksiyon; hiçbiri cihaz gerektirmiyor.
 */

import { MINI_R50, PHYSICS, type TyreSize, type VehicleProfile } from './vehicle';

export type { TyreSize };

/**
 * Dinamik yuvarlanma çevresinin geometrik çevreye oranı.
 *
 * Yüklü bir lastik yanağından basılır; fiilen kat ettiği mesafe serbest
 * çemberinden kısadır. Sektör pratiği 0.96-0.98 arasıdır; ortası alındı.
 * Bu bir VARSAYIM — girilen ölçüden hesaplanan çevre bu yüzden mutlak
 * doğru değil, karşılaştırma için referanstır.
 */
export const ROLLING_CIRCUMFERENCE_FACTOR = 0.97;

/**
 * "175/65R15", "175/65 R 15", "195/55-16" gibi yazımları çözer.
 * Anlaşılmazsa null döner — uydurmaz.
 */
export function parseTyreSize(input: string): TyreSize | null {
  const m = /^\s*(\d{3})\s*\/\s*(\d{2})\s*[rR-]?\s*(\d{2})\s*$/.exec(input);
  if (!m) return null;

  const widthMm = Number(m[1]);
  const aspectRatio = Number(m[2]);
  const rimInch = Number(m[3]);

  // Fiziksel olarak anlamsız değerleri kabul etmiyoruz: yanlış bir ölçü,
  // ölçünün hiç girilmemiş olmasından daha kötü sonuç üretir.
  if (widthMm < 100 || widthMm > 400) return null;
  if (aspectRatio < 25 || aspectRatio > 90) return null;
  if (rimInch < 10 || rimInch > 24) return null;

  return { widthMm, aspectRatio, rimInch };
}

export function formatTyreSize(t: TyreSize): string {
  return `${t.widthMm}/${t.aspectRatio} R${t.rimInch}`;
}

/**
 * Seçilebilir lastik ebatları.
 *
 * Elle yazdırmak yerine liste sunuluyor: yanlış girilmiş bir ebat, ebadın
 * hiç girilmemiş olmasından daha kötü sonuç üretiyor (mesafe ve tüketim
 * dahil ondan türeyen her şey sessizce kayıyor). Listede yalnızca R50
 * jant çaplarına fiilen takılabilen ölçüler var; hepsi 15-18 inç aralığında.
 *
 * Sıralama jant çapına, sonra genişliğe göre. Her seçeneğin fabrika
 * ebadına göre sapması UI'da gösteriliyor — kullanıcı seçtiği şeyin
 * hız/mesafe okumasını ne kadar kaydıracağını seçim anında görüyor.
 */
export const TYRE_OPTIONS: readonly TyreSize[] = [
  { widthMm: 175, aspectRatio: 65, rimInch: 15 },
  { widthMm: 185, aspectRatio: 60, rimInch: 15 },
  { widthMm: 195, aspectRatio: 55, rimInch: 15 },
  { widthMm: 195, aspectRatio: 50, rimInch: 16 },
  { widthMm: 195, aspectRatio: 55, rimInch: 16 },
  { widthMm: 205, aspectRatio: 45, rimInch: 16 },
  { widthMm: 205, aspectRatio: 45, rimInch: 17 },
  { widthMm: 215, aspectRatio: 40, rimInch: 17 },
  { widthMm: 205, aspectRatio: 40, rimInch: 18 },
];

/** İki ebadın aynı olup olmadığı. */
export function sameTyreSize(a: TyreSize, b: TyreSize): boolean {
  return a.widthMm === b.widthMm && a.aspectRatio === b.aspectRatio && a.rimInch === b.rimInch;
}

/** Dış çap (mm). */
export function overallDiameterMm(t: TyreSize): number {
  const sidewall = (t.widthMm * t.aspectRatio) / 100;
  return 2 * sidewall + t.rimInch * 25.4;
}

/** Serbest (geometrik) çevre (mm). */
export function geometricCircumferenceMm(t: TyreSize): number {
  return Math.PI * overallDiameterMm(t);
}

/** Dinamik yuvarlanma çevresi (mm) — mesafe hesabında kullanılan budur. */
export function rollingCircumferenceMm(t: TyreSize): number {
  return geometricCircumferenceMm(t) * ROLLING_CIRCUMFERENCE_FACTOR;
}

/** Kilometrede tekerlek devri. */
export function revsPerKm(t: TyreSize): number {
  return 1_000_000 / rollingCircumferenceMm(t);
}

/**
 * Fabrika ölçüsü yerine başka bir ebat takılıysa OBD hızının çarpanı.
 *
 * ECU fabrika çevresini varsaydığı için, daha büyük bir lastikte araç
 * gösterdiğinden HIZLI gider. Gerçek hız = OBD hızı × bu çarpan.
 */
export function speedCorrectionFactor(fitted: TyreSize, factory: TyreSize): number {
  return rollingCircumferenceMm(fitted) / rollingCircumferenceMm(factory);
}

/**
 * Tekerleğin dakikadaki devri, verilen hız ve çevre için.
 */
export function wheelRpm(speedKmh: number, circumferenceMm: number): number | null {
  if (speedKmh <= 0 || circumferenceMm <= 0) return null;
  // km/h -> mm/dk : ×1e6 / 60
  return (speedKmh * 1_000_000) / 60 / circumferenceMm;
}

/**
 * Motor devri / tekerlek devri = toplam aktarma oranı (vites × diferansiyel).
 *
 * Yayımlanmış vites oranlarıyla KARŞILAŞTIRILMIYOR: elimde doğrulanmış R50
 * tablosu yok ve uydurma bir referans, olmayan bir sapma raporlardı. Bunun
 * yerine oranın kendisi ölçülüyor; teşhis değeri oranın SABİTLİĞİNDE.
 */
export function totalDriveRatio(
  engineRpm: number,
  speedKmh: number,
  circumferenceMm: number,
): number | null {
  const wheel = wheelRpm(speedKmh, circumferenceMm);
  if (wheel === null || wheel <= 0 || engineRpm <= 0) return null;
  return engineRpm / wheel;
}

/**
 * GPS ve OBD hızının oranından FİİLİ yuvarlanma çevresi (mm).
 *
 * ECU'nun hız hesabı fabrika çevresine dayandığı için:
 *   gerçek çevre = fabrika çevresi × (GPS hızı / OBD hızı)
 *
 * Düşük hızda GPS gürültülü olduğundan eşik var; tek bir ölçüm değil,
 * çok sayıda örneğin ortancası kullanılmalı (bkz. effectiveCircumferenceMm).
 */
export function circumferenceFromSpeedPair(
  obdSpeedKmh: number,
  gpsSpeedKmh: number,
  factory: TyreSize,
  minSpeedKmh = 40,
): number | null {
  if (obdSpeedKmh < minSpeedKmh || gpsSpeedKmh < minSpeedKmh) return null;
  return rollingCircumferenceMm(factory) * (gpsSpeedKmh / obdSpeedKmh);
}

/**
 * Tekerlekteki torkun motor tarafındaki karşılığı (Nm).
 *
 * Tekerlek kuvveti × yarıçap = tekerlek torku; toplam orana ve aktarma
 * verimine bölününce motor torku tahmini çıkar.
 *
 * DİNAMOMETRE DEĞİL: kütle, sürtünme katsayıları ve aktarma verimi
 * varsayım. Mutlak değeri değil, aynı koşullardaki değişimi anlamlı.
 */
export const DRIVETRAIN_EFFICIENCY = 0.88;

export function estimatedEngineTorqueNm(input: {
  wheelForceN: number;
  circumferenceMm: number;
  totalRatio: number;
  efficiency?: number;
}): number | null {
  const { wheelForceN, circumferenceMm, totalRatio } = input;
  if (totalRatio <= 0 || circumferenceMm <= 0) return null;
  const radiusM = circumferenceMm / 1000 / (2 * Math.PI);
  const wheelTorque = wheelForceN * radiusM;
  return wheelTorque / (totalRatio * (input.efficiency ?? DRIVETRAIN_EFFICIENCY));
}

/**
 * Yol yüküne karşı koyan toplam kuvvet (N) — güç hesabıyla aynı fizik,
 * ama kuvvet olarak. Tork tahmininin girdisi.
 */
export function roadLoadForceN(input: {
  speedKmh: number;
  accelMs2: number;
  gradePercent?: number;
  vehicle?: VehicleProfile;
  airDensity?: number;
}): number {
  const v = input.vehicle ?? MINI_R50;
  const speedMs = input.speedKmh / 3.6;
  const rho = input.airDensity ?? PHYSICS.airDensitySeaLevel;
  const gradeRatio = (input.gradePercent ?? 0) / 100;

  const inertial = v.massKg * input.accelMs2;
  const gravity = v.massKg * PHYSICS.g * Math.sin(Math.atan(gradeRatio));
  const rolling = v.rollingResistance * v.massKg * PHYSICS.g;
  const aero = 0.5 * rho * v.dragCoefficient * v.frontalAreaM2 * speedMs * speedMs;

  return inertial + gravity + rolling + aero;
}
