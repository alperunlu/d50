/**
 * Ses basınç seviyesi (SPL) — "gerçek desibel".
 *
 * İKİ FARKLI DESİBEL VAR, karıştırmak yanlış sayı üretir:
 *
 *   dBFS ("full scale") — dijital tavana göre. 0 dBFS mikrofonun
 *     kaydedebileceği en yüksek seviye, her şey negatif. Telefondan
 *     doğrudan çıkan budur. Fiziksel bir gürültü ölçüsü DEĞİLDİR.
 *
 *   dB SPL — havadaki gerçek ses basıncı (20 µPa referansına göre).
 *     Desibelmetrelerin gösterdiği budur: sessiz oda ~30 dB, sürüş
 *     içi kabin gürültüsü ~65-75 dB, ağır trafik ~85 dB.
 *
 * Aralarındaki ilişki tek bir sabit:  dB SPL = dBFS + kalibrasyon
 * Bu sabit mikrofonun hassasiyetidir; cihaz modeline göre değişir ve
 * ticari desibelmetre uygulamalarının yaptığı da tam olarak budur:
 * cihaz başına bir kalibrasyon sayısı tutmak.
 *
 * A-AĞIRLIKLAMA: Kulak her frekansı eşit duymaz; özellikle çok pesleri
 * çok daha az duyar. Desibelmetreler bu yüzden dB(A) raporlar — spektrum
 * kulağın duyarlılık eğrisiyle ağırlıklandırılır. Araç içinde bu fark
 * BÜYÜKTÜR: motor ve yol gürültüsünün enerjisinin çoğu 100 Hz altındadır,
 * ağırlıklamadan okunan sayı olduğundan 10-15 dB yüksek çıkar. Zaten
 * FFT hesapladığımız için ağırlıklamayı doğru şekilde uygulayabiliyoruz.
 *
 * Hepsi saf fonksiyon.
 */

import { HANN_POWER_CORRECTION } from './fft';

/**
 * Varsayılan kalibrasyon: 0 dBFS'in kaç dB SPL'e denk geldiği.
 *
 * iPhone'un dahili mikrofonu için yaygın olarak kullanılan değer. Cihaza,
 * mikrofon deliğine ve iOS'un uyguladığı otomatik kazanca göre birkaç dB
 * oynayabilir; bu yüzden kullanıcı ayarlayabiliyor. Referans bir ölçüm
 * cihazıyla (ya da güvendiği bir uygulamayla) yan yana koyup farkı
 * kapatmak, mutlak doğruluğu sağlamanın tek dürüst yolu.
 */
export const DEFAULT_SPL_CALIBRATION_DB = 120;

/** Kullanıcının ayarlayabileceği kalibrasyon aralığı. */
export const MIN_SPL_CALIBRATION_DB = 90;
export const MAX_SPL_CALIBRATION_DB = 150;

/**
 * A-ağırlıklama eğrisinin verilen frekanstaki kazancı (dB).
 * IEC 61672 tanımı.
 */
export function aWeightingDb(hz: number): number {
  if (hz <= 0) return -Infinity;
  const f2 = hz * hz;
  const f4 = f2 * f2;

  const numerator = 12194 * 12194 * f4;
  const denominator =
    (f2 + 20.6 * 20.6) *
    Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9)) *
    (f2 + 12194 * 12194);

  // +2.00 dB: eğri 1 kHz'de 0 dB olacak şekilde normalize edilir.
  return 20 * Math.log10(numerator / denominator) + 2.0;
}

/**
 * Genlik spektrumundan A-ağırlıklı seviye (dBFS).
 *
 * Spektrum `magnitudeSpectrum` çıktısıdır (bin başına GENLİK). Her bin
 * kendi A-ağırlığıyla çarpılıp enerjiler toplanıyor; sinüs için
 * RMS = genlik/√2 olduğu için toplam ikiye bölünüyor.
 */
export function aWeightedDbfs(
  spectrum: ArrayLike<number>,
  sampleRate: number,
  fftSize: number,
  /**
   * Pencereleme enerji düzeltmesi. Varsayılan Hann içindir; pencerelenmemiş
   * bir spektrum için 1 verilmeli (bkz. fft.ts'teki türetme).
   */
  windowEnergyCorrection: number = HANN_POWER_CORRECTION,
): number {
  let energy = 0;
  for (let i = 1; i < spectrum.length; i++) {
    const hz = (i * sampleRate) / fftSize;
    // Duyulabilir bandın dışı ölçüme katılmıyor: altındaki titreşim ve
    // üstündeki gürültü kulağın duymadığı enerjidir.
    if (hz < 10 || hz > 20000) continue;
    const gain = 10 ** (aWeightingDb(hz) / 20);
    const amplitude = spectrum[i] * gain;
    energy += (amplitude * amplitude) / 2;
  }
  if (energy <= 0) return -160;
  return Math.max(-160, 10 * Math.log10(energy / windowEnergyCorrection));
}

/**
 * dBFS -> dB SPL. Kalibrasyon, 0 dBFS'in kaç dB SPL olduğudur.
 *
 * Sonuç 0'ın altına inemez: negatif ses basıncı seviyesi diye bir şey
 * yok ve mutlak sessizlik zaten ölçülemez.
 */
export function dbfsToSpl(dbfs: number, calibrationDb = DEFAULT_SPL_CALIBRATION_DB): number {
  if (!Number.isFinite(dbfs)) return 0;
  return Math.max(0, dbfs + calibrationDb);
}

/** Kalibrasyon değerini geçerli aralığa kırpar. */
export function clampCalibration(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPL_CALIBRATION_DB;
  return Math.min(MAX_SPL_CALIBRATION_DB, Math.max(MIN_SPL_CALIBRATION_DB, value));
}

/**
 * Ölçülen seviyenin insan diliyle karşılığı.
 *
 * Çıplak bir sayı ("72 dB") çoğu kişiye bir şey söylemiyor; referans
 * noktası vermek onu kullanılabilir kılıyor.
 */
export function describeSpl(dbA: number): string {
  if (dbA < 40) return 'very quiet — like a still room';
  if (dbA < 55) return 'quiet — parked, engine off';
  if (dbA < 65) return 'calm cabin — idling or slow city driving';
  if (dbA < 75) return 'normal cabin noise at speed';
  if (dbA < 85) return 'loud — motorway, windows down, or a coarse surface';
  if (dbA < 95) return 'very loud — long exposure is tiring';
  return 'extremely loud — check for an exhaust or bearing problem';
}
