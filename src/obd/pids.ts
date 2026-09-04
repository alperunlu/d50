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
}

export const PIDS: readonly PidDefinition[] = [
  // ---- hızlı değişenler: her turda sorulur ----
  {
    pid: '0C',
    name: 'Engine RPM',
    unit: 'rpm',
    bytes: 2,
    csvKey: 'rpm',
    refresh: 'fast',
    decode: ([a, b]) => (a * 256 + b) / 4,
  },
  {
    pid: '0D',
    name: 'Vehicle Speed',
    unit: 'km/h',
    bytes: 1,
    csvKey: 'speed_kmh',
    refresh: 'fast',
    decode: ([a]) => a,
  },
  {
    pid: '11',
    name: 'Throttle Position',
    unit: '%',
    bytes: 1,
    csvKey: 'throttle_pct',
    refresh: 'fast',
    decode: ([a]) => (a * 100) / 255,
  },
  {
    pid: '04',
    name: 'Engine Load',
    unit: '%',
    bytes: 1,
    csvKey: 'engine_load_pct',
    refresh: 'fast',
    decode: ([a]) => (a * 100) / 255,
  },
  {
    pid: '10',
    name: 'MAF (Mass Air Flow)',
    unit: 'g/s',
    bytes: 2,
    csvKey: 'maf_gs',
    refresh: 'fast',
    decode: ([a, b]) => (a * 256 + b) / 100,
  },
  {
    pid: '0B',
    name: 'Intake Manifold Pressure',
    unit: 'kPa',
    bytes: 1,
    csvKey: 'map_kpa',
    refresh: 'fast',
    decode: ([a]) => a,
  },
  {
    pid: '0E',
    name: 'Timing Advance',
    unit: '°',
    bytes: 1,
    csvKey: 'timing_advance_deg',
    refresh: 'fast',
    decode: ([a]) => a / 2 - 64,
  },
  {
    pid: '06',
    name: 'Short Term Fuel Trim',
    unit: '%',
    bytes: 1,
    csvKey: 'stft_pct',
    refresh: 'fast',
    decode: ([a]) => (a * 100) / 128 - 100,
  },
  {
    pid: '43',
    name: 'Absolute Load',
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
    unit: '°C',
    bytes: 1,
    csvKey: 'coolant_c',
    refresh: 'slow',
    decode: ([a]) => a - 40,
  },
  {
    pid: '0F',
    name: 'Intake Air Temperature',
    unit: '°C',
    bytes: 1,
    csvKey: 'intake_air_c',
    refresh: 'slow',
    decode: ([a]) => a - 40,
  },
  {
    pid: '2F',
    name: 'Fuel Level',
    unit: '%',
    bytes: 1,
    csvKey: 'fuel_level_pct',
    refresh: 'slow',
    decode: ([a]) => (a * 100) / 255,
  },
  {
    pid: '07',
    name: 'Long Term Fuel Trim',
    unit: '%',
    bytes: 1,
    csvKey: 'ltft_pct',
    refresh: 'slow',
    decode: ([a]) => (a * 100) / 128 - 100,
  },
  {
    pid: '33',
    name: 'Barometric Pressure',
    unit: 'kPa',
    bytes: 1,
    csvKey: 'baro_kpa',
    refresh: 'slow',
    decode: ([a]) => a,
  },
  {
    pid: '42',
    name: 'Control Module Voltage',
    unit: 'V',
    bytes: 2,
    csvKey: 'module_voltage_v',
    refresh: 'slow',
    decode: ([a, b]) => (a * 256 + b) / 1000,
  },
  {
    pid: '46',
    name: 'Ambient Air Temperature',
    unit: '°C',
    bytes: 1,
    csvKey: 'ambient_air_c',
    refresh: 'slow',
    decode: ([a]) => a - 40,
  },
  {
    pid: '1F',
    name: 'Run Time Since Start',
    unit: 's',
    bytes: 2,
    csvKey: 'run_time_s',
    refresh: 'slow',
    decode: ([a, b]) => a * 256 + b,
  },
  {
    pid: '21',
    name: 'Distance With MIL On',
    unit: 'km',
    bytes: 2,
    csvKey: 'distance_mil_km',
    refresh: 'slow',
    decode: ([a, b]) => a * 256 + b,
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
