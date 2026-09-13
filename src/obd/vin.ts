/**
 * VIN okuma ve VIN'den çıkarılabilecek araç bilgisi.
 *
 * NEDEN VAR: rapor bugüne kadar araca "MINI Cooper R50 (2001-2006)" diyordu
 * ve bunu yalnızca `MINI_R50` profilinden biliyordu — yani hiç bilmiyordu,
 * varsayıyordu. Kullanıcı haklı olarak sordu: "bunu nereden biliyor?".
 * Cevabı "hiçbir yerden" olan bir satırın raporda kalması olmaz.
 *
 * İKİNCİ NEDEN: trend verisi araca bağlı olmalı. İki farklı arabanın rölanti
 * ölçümü aynı seriye girerse seri anlamsızlaşır, üstelik sessizce.
 *
 * NE YAPMIYOR: VIN'i bir üretici veritabanında sorgulamıyor. Bu dosyanın
 * çıkardığı her şey VIN'in KENDİ YAPISINDAN geliyor — standardın garanti
 * ettiği kadarı. Model, motor, donanım VIN'in üretici-özel bölümünde ve
 * onu okumak BMW'nin çözüm tablosunu gerektirir; elimizde yok, o yüzden
 * uydurmuyoruz.
 */

/**
 * Cevabı satırlara böler.
 *
 * `elm327.ts` içinde aynı işi yapan bir fonksiyon var ama buradan ONA
 * bağlanılmıyor: elm327 bu dosyayı import ediyor, ters yön de eklenirse
 * döngüsel bağımlılık olurdu. Üç satırlık bir kopya, o düğümden ucuz.
 */
function responseLines(raw: string): string[] {
  return raw
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== 'SEARCHING...');
}

/** VIN alfabesi: I, O ve Q yok — 1/0 ile karışmasınlar diye standart dışı. */
const VIN_CHARS = /^[A-HJ-NPR-Z0-9]{17}$/;

/**
 * Mode 09 PID 02 cevabından VIN'i çıkarır.
 *
 * İki farklı taşıma biçimini de kabul etmesi gerekiyor ve bu isteğe bağlı
 * bir genişlik değil — hangi biçimin geleceği araca bağlı:
 *
 *   CAN (ISO-TP), satırlar sıra numarasıyla gelir:
 *     014⏎0:490201574D57⏎1:5A43353143333⏎2:354B33323139...
 *
 *   K-line (ISO 9141 / KWP), her satır kendi başlığını taşır ve üçüncü
 *   bayt satır sayacıdır; VIN 17 bayt olduğu için ilk satır 0x00 ile
 *   doldurulur:
 *     49020100000057⏎490202 4D 57 5A 43...
 *
 * Bu R50 K-line konuşuyor, ama adaptör ve protokol değişebilir ve tek
 * biçime bel bağlamak sessizce boş VIN üretirdi.
 *
 * ÇÖZÜMLENEMEZSE `null` DÖNER. Bu önemli: yarım ya da bozuk bir VIN,
 * VIN olmamasından kötüdür — oturumları yanlış araca bağlar.
 */
export function parseVin(raw: string): string | null {
  const hex = collectVinHex(raw);
  if (!hex) return null;

  let ascii = '';
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    // 0x00 dolgu baytları ve satır sonu artıkları atlanır; VIN yalnızca
    // basılabilir ASCII içerir.
    if (byte === 0x00 || byte === 0xff) continue;
    ascii += String.fromCharCode(byte);
  }

  const cleaned = ascii.toUpperCase().replace(/[^A-Z0-9]/g, '');
  // Bazı ECU'lar VIN'i 17'den uzun bir alanda döndürür; sondan 17 karakter
  // VIN'dir çünkü dolgu baştadır.
  const candidate = cleaned.length > 17 ? cleaned.slice(-17) : cleaned;
  return VIN_CHARS.test(candidate) ? candidate : null;
}

/** Cevabın içindeki VIN veri baytlarını tek bir hex dizisine toplar. */
function collectVinHex(raw: string): string {
  const out: string[] = [];

  for (const line of responseLines(raw)) {
    let l = line.replace(/\s/g, '').toUpperCase();
    if (!l) continue;
    // CAN çok-çerçeveli cevapta satır başındaki "0:" / "1:" sıra numarası.
    l = l.replace(/^[0-9A-F]:/, '');
    if (!/^[0-9A-F]+$/.test(l)) continue;
    // Toplam uzunluk satırı (ör. "014") — veri değil.
    if (l.length <= 3) continue;

    const start = l.indexOf('4902');
    if (start >= 0) {
      // "4902" + bir bayt (CAN'de veri-öğesi sayısı, K-line'da satır
      // sayacı). İkisinde de VIN'in parçası değil.
      out.push(l.slice(start + 6));
    } else {
      // Başlıksız devam çerçevesi.
      out.push(l);
    }
  }

  return out.join('');
}

/**
 * Model yılı kodu (VIN'in 10. karakteri) — 1980'den beri standart.
 *
 * 30 yıllık bir çevrim: 'Y' hem 2000 hem 1970. Belirsizliği kabaca
 * kesmenin yolu yok, o yüzden yalnızca 1980-2029 aralığı çözülüyor ve
 * çakışan kod için aracın makul yaşına bakılıyor: bu uygulama bugünün
 * araçlarına takılıyor, 1980'lerin değil.
 */
const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';

export function modelYearFromVin(vin: string): number | null {
  const code = vin[9];
  const index = YEAR_CODES.indexOf(code);
  if (index < 0) return null;
  // 1980 + index birinci çevrim, +30 ikinci çevrim (2010-2039).
  const first = 1980 + index;
  const second = first + 30;
  const thisYear = new Date().getFullYear();
  // Gelecekteki bir model yılı olamaz (model yılı takvim yılını en fazla
  // bir aşar); o yüzden ikinci çevrim ancak makulse seçilir.
  return second <= thisYear + 1 ? second : first;
}

/**
 * Dünya Üretici Kodu (ilk üç karakter) -> üretici.
 *
 * KASITLI OLARAK KÜÇÜK bir tablo. Tam WMI listesi binlerce satırdır ve
 * uygulamaya konsa bile bakımı yapılmaz. Buradaki tek iş, aracın gömülü
 * profille TUTARLI olup olmadığını söyleyebilmek; tanımadığı bir WMI için
 * dürüst cevap "bilmiyorum".
 */
const WMI: Readonly<Record<string, string>> = {
  WMW: 'MINI (Oxford, UK)',
  WBA: 'BMW',
  WBS: 'BMW M',
  WBY: 'BMW i',
  SAX: 'Land Rover',
  VSS: 'SEAT',
  WVW: 'Volkswagen',
  WAU: 'Audi',
  WDB: 'Mercedes-Benz',
};

export interface VinInfo {
  readonly vin: string;
  /** İlk üç karakter. */
  readonly wmi: string;
  /** Tanınıyorsa üretici adı, tanınmıyorsa `null`. */
  readonly manufacturer: string | null;
  /** 10. karakterden model yılı. */
  readonly modelYear: number | null;
  /** 11. karakter — montaj fabrikası kodu. Çözümü üreticiye özel. */
  readonly plantCode: string;
}

/**
 * VIN'in yapısından çıkarılabilecek her şey — ve fazlası değil.
 */
export function decodeVin(vin: string): VinInfo | null {
  if (!VIN_CHARS.test(vin)) return null;
  const wmi = vin.slice(0, 3);
  return {
    vin,
    wmi,
    manufacturer: WMI[wmi] ?? null,
    modelYear: modelYearFromVin(vin),
    plantCode: vin[10],
  };
}
