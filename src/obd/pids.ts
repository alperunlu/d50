/**
 * PID kataloğu — Mode 01 (anlık veri) için PID tanımları ve saf decode
 * fonksiyonları.
 *
 * Katalogda bir PID'in olması "araç bunu destekliyor" demek DEĞİLDİR.
 * Aracın neyi desteklediğini araç kendisi söyler: `0100`, `0120`, `0140`
 * sorgularının döndürdüğü bitmask'ler (bkz. `isPidSupported`). UI yalnızca
 * bitmask'in desteklendiğini söylediklerini aktif gösterir — yani katalogu
 * cömertçe genişletmek güvenli, desteklenmeyenler kendiliğinden pasifleşir.
 *
 * decode() fonksiyonları saf: sadece bayt dizisi alır, sayı döner. Hiçbir
 * I/O, hiçbir yan etki. Bu yüzden cihazsız test edilebilirler.
 */

/**
 * Bir değerin ne sıklıkla değiştiği — poller'ın öncelik sırasını belirler.
 *
 * K-line'da tek seferde tek PID sorulabiliyor ve toplam kapasite ~3 istek/sn
 * (2026-09-03 ölçümü, MINI R50). Soğutma suyu sıcaklığını RPM'le aynı sıklıkta
 * sormak bu kıt kapasiteyi çarçur ediyor: biri saniyede birkaç kez değişiyor,
 * diğeri dakikalar içinde. `slow` işaretli PID'ler her turda değil, birkaç
 * turda bir sorulur (bkz. poller.ts).
 */
export type RefreshClass = 'fast' | 'slow';

export interface PidDefinition {
  /** Mode 01 PID kodu, iki hex hane, büyük harf (ör. "0C"). */
  readonly pid: string;
  /** Kullanıcıya gösterilecek isim. */
  readonly name: string;
  /**
   * Izgara hücresi etiketi. Uzun isimler hücrelerde satır kırıp hücreleri
   * eşitsiz yapıyor — tasarımın "eşit hücreler" kuralını bozuyordu.
   */
  readonly short: string;
  /** Birim (grafik ekseni ve CSV başlığı için). */
  readonly unit: string;
  /** Cevaptaki veri bayt sayısı (mode+pid hariç, A/B/C/D baytları). */
  readonly bytes: number;
  /** Ham baytlardan fiziksel değeri hesaplar. */
  readonly decode: (b: readonly number[]) => number;
  /** CSV sütun adı (ASCII, boşluksuz). */
  readonly csvKey: string;
  /** Poller önceliği. Belirtilmezse 'fast' sayılır. */
  readonly refresh: RefreshClass;
  /**
   * Bir turda kaç kez sorulacağı. Varsayılan 1.
   *
   * Bütün "hızlı" PID'ler eşit hızlı değil: devir ve hız saniyede birkaç
   * kez değişirken gaz kelebeği ve yakıt düzeltmesi çok daha yavaş hareket
   * eder. Kıt K-line kapasitesini eşit bölmek, en çok ihtiyaç duyulan iki
   * kanalı gereğinden seyrek örneklemek demekti.
   */
  readonly weight?: number;
}

export const PIDS: readonly PidDefinition[] = [
  // ---- hızlı değişenler: her turda sorulur ----
  {
    pid: '0C',
    name: 'Engine RPM',
    short: 'RPM',
    unit: 'rpm',
    bytes: 2,
    csvKey: 'rpm',
    refresh: 'fast',
    // Devir her şeyin referansı: 0-100 ölçümü, rölanti kararlılığı ve
    // order takibi hep buna dayanıyor. Turda iki kez soruluyor.
    weight: 2,
    decode: ([a, b]) => (a * 256 + b) / 4,
  },
  {
    pid: '0D',
    name: 'Vehicle Speed',
    short: 'Speed',
    unit: 'km/h',
    bytes: 1,
    csvKey: 'speed_kmh',
    refresh: 'fast',
    // Hızın türevi ivme, ivmenin türevi güç/tork tahmini: seyrek
    // örneklenirse üçü birden bozuluyor.
    weight: 2,
    decode: ([a]) => a,
  },
  {
    pid: '11',
    name: 'Throttle Position',
    short: 'Throttle',
    unit: '%',
    bytes: 1,
    csvKey: 'throttle_pct',
    refresh: 'fast',
    decode: ([a]) => (a * 100) / 255,
  },
  {
    pid: '04',
    name: 'Engine Load',
    short: 'Load',
    unit: '%',
    bytes: 1,
    csvKey: 'engine_load_pct',
    refresh: 'fast',
    decode: ([a]) => (a * 100) / 255,
  },
  {
    pid: '10',
    name: 'MAF (Mass Air Flow)',
    short: 'Air mass',
    unit: 'g/s',
    bytes: 2,
    csvKey: 'maf_gs',
    refresh: 'fast',
    decode: ([a, b]) => (a * 256 + b) / 100,
  },
  {
    pid: '0B',
    name: 'Intake Manifold Pressure',
    short: 'MAP',
    unit: 'kPa',
    bytes: 1,
    csvKey: 'map_kpa',
    refresh: 'fast',
    decode: ([a]) => a,
  },
  {
    pid: '0E',
    name: 'Timing Advance',
    short: 'Advance',
    unit: '°',
    bytes: 1,
    csvKey: 'timing_advance_deg',
    refresh: 'fast',
    decode: ([a]) => a / 2 - 64,
  },
  {
    pid: '06',
    name: 'Short Term Fuel Trim',
    short: 'STFT',
    unit: '%',
    bytes: 1,
    csvKey: 'stft_pct',
    refresh: 'fast',
    decode: ([a]) => (a * 100) / 128 - 100,
  },
  {
    pid: '43',
    name: 'Absolute Load',
    short: 'Abs load',
    unit: '%',
    bytes: 2,
    csvKey: 'abs_load_pct',
    refresh: 'fast',
    decode: ([a, b]) => ((a * 256 + b) * 100) / 255,
  },

  // ---- yavaş değişenler: birkaç turda bir sorulur ----
  {
    pid: '05',
    name: 'Coolant Temperature',
    short: 'Coolant',
    unit: '°C',
    bytes: 1,
    csvKey: 'coolant_c',
    refresh: 'slow',
    decode: ([a]) => a - 40,
  },
  {
    pid: '0F',
    name: 'Intake Air Temperature',
    short: 'Intake air',
    unit: '°C',
    bytes: 1,
    csvKey: 'intake_air_c',
    refresh: 'slow',
    decode: ([a]) => a - 40,
  },
  {
    pid: '2F',
    name: 'Fuel Level',
    short: 'Fuel',
    unit: '%',
    bytes: 1,
    csvKey: 'fuel_level_pct',
    refresh: 'slow',
    decode: ([a]) => (a * 100) / 255,
  },
  {
    pid: '07',
    name: 'Long Term Fuel Trim',
    short: 'LTFT',
    unit: '%',
    bytes: 1,
    csvKey: 'ltft_pct',
    refresh: 'slow',
    decode: ([a]) => (a * 100) / 128 - 100,
  },
  {
    pid: '33',
    name: 'Barometric Pressure',
    short: 'Baro',
    unit: 'kPa',
    bytes: 1,
    csvKey: 'baro_kpa',
    refresh: 'slow',
    decode: ([a]) => a,
  },
  {
    pid: '42',
    name: 'Control Module Voltage',
    short: 'Voltage',
    unit: 'V',
    bytes: 2,
    csvKey: 'module_voltage_v',
    refresh: 'slow',
    decode: ([a, b]) => (a * 256 + b) / 1000,
  },
  {
    pid: '46',
    name: 'Ambient Air Temperature',
    short: 'Ambient',
    unit: '°C',
    bytes: 1,
    csvKey: 'ambient_air_c',
    refresh: 'slow',
    decode: ([a]) => a - 40,
  },
  {
    pid: '1F',
    name: 'Run Time Since Start',
    short: 'Run time',
    unit: 's',
    bytes: 2,
    csvKey: 'run_time_s',
    refresh: 'slow',
    decode: ([a, b]) => a * 256 + b,
  },
  {
    pid: '21',
    name: 'Distance With MIL On',
    short: 'MIL dist',
    unit: 'km',
    bytes: 2,
    csvKey: 'distance_mil_km',
    refresh: 'slow',
    decode: ([a, b]) => a * 256 + b,
  },
  /**
   * Lambda sondaları (2026-09-05 araç taramasıyla doğrulandı: R50 hem 14 hem
   * 15'i cevaplıyor).
   *
   * İki bayt dönüyor: A gerilim, B o sonda için kısa dönem yakıt düzeltmesi.
   * Kanal olarak GERİLİM loglanıyor, çünkü teşhis değeri onda: B1S1 sürekli
   * salınmalı (kapalı çevrimde saniyede ~1 kez 0.1–0.9 V arası), B1S2 ise
   * katalizör sağlamsa neredeyse düz ~0.6–0.8 V durmalı. İkisi birlikte
   * salınıyorsa katalizör verimi düşmüş demektir.
   */
  {
    pid: '14',
    name: 'O2 Sensor B1S1 (pre-cat)',
    short: 'O2 pre',
    unit: 'V',
    bytes: 2,
    csvKey: 'o2_b1s1_v',
    refresh: 'fast',
    decode: ([a]) => a / 200,
  },
  {
    pid: '15',
    name: 'O2 Sensor B1S2 (post-cat)',
    short: 'O2 post',
    unit: 'V',
    bytes: 2,
    csvKey: 'o2_b1s2_v',
    refresh: 'fast',
    decode: ([a]) => a / 200,
  },
];

const BY_PID = new Map(PIDS.map((p) => [p.pid, p]));

export function getPidDefinition(pid: string): PidDefinition | undefined {
  return BY_PID.get(pid.toUpperCase());
}

/** `01XX` biçimindeki tam komutu üretir. */
export function commandFor(pid: PidDefinition): string {
  return `01${pid.pid}`;
}

/**
 * Aracın desteklediği PID'lerin haritası.
 *
 * OBD-II'de destek bilgisi 32'lik bloklar hâlinde gelir:
 *   `0100` → PID 01-20, `0120` → PID 21-40, `0140` → PID 41-60.
 * Her blok 4 baytlık bir bitmask'tir; en anlamlı bit bloğun ilk PID'ine denk
 * gelir (SAE J1979).
 */
export interface SupportedPidMap {
  /** `0100` cevabının veri baytları, hex (ör. "BE1FA813"). */
  readonly block00?: string;
  /** `0120` cevabının veri baytları. */
  readonly block20?: string;
  /** `0140` cevabının veri baytları. */
  readonly block40?: string;
}

/**
 * Bir PID'in araç tarafından desteklenip desteklenmediğini söyler.
 *
 * Bilgi yoksa (ilgili blok sorulmamış/cevapsız) `true` döner: elimizde kanıt
 * yokken kullanıcıyı engellemek yerine denemesine izin vermek daha doğru.
 */
export function isPidSupported(pidHex: string, mask: SupportedPidMap): boolean {
  const pidNum = parseInt(pidHex, 16);
  if (Number.isNaN(pidNum) || pidNum < 1 || pidNum > 0x60) return false;

  let block: string | undefined;
  let offset: number;
  if (pidNum <= 0x20) {
    block = mask.block00;
    offset = 0x00;
  } else if (pidNum <= 0x40) {
    block = mask.block20;
    offset = 0x20;
  } else {
    block = mask.block40;
    offset = 0x40;
  }

  if (!block) return true; // bilgi yok -> engelleme
  const bits = hexToBits(block);
  return bits[pidNum - offset - 1] === '1';
}

/** Kullanıcıya "araç şunları destekliyor" listesi göstermek için. */
export function supportedPidsFrom(mask: SupportedPidMap): PidDefinition[] {
  return PIDS.filter((p) => isPidSupported(p.pid, mask));
}

function hexToBits(hex: string): string {
  return hex
    .split('')
    .map((c) => parseInt(c, 16).toString(2).padStart(4, '0'))
    .join('');
}
