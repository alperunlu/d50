/**
 * ============================================================================
 *  SALT-OKUNUR BEKÇİSİ  —  READ-ONLY GUARD
 * ============================================================================
 *
 * Bu uygulama araca ASLA yazmaz. DTC silmez, aktüatör tetiklemez, ECU'ya
 * hiçbir şey göndermez. Bu dosya o garantiyi "yazmamaya dikkat ettik"
 * seviyesinden "yapısal olarak imkânsız" seviyesine çıkarır.
 *
 * Adaptöre giden TEK çıkış noktası transport'ların send() metodudur ve her
 * ikisi de ilk satırda assertReadOnly() çağırır. Buradan geçmeyen hiçbir bayt
 * BLE karakteristiğine yazılmaz.
 *
 * BEYAZ LİSTE mantığı kullanılır, kara liste değil:
 *   - Kara listede unutulan bir komut sessizce geçer. (kabul edilemez)
 *   - Beyaz listede unutulan bir komut sadece çalışmaz. (fark edilir, güvenli)
 *
 * Yeni bir komut eklemek isteyen herkes bu dosyayı ve testlerini değiştirmek
 * zorundadır — kaza eseri yazma komutu eklemek mümkün değildir.
 */

/** Bir komut beyaz listede olmadığı için reddedildiğinde fırlatılır. */
export class ReadOnlyViolationError extends Error {
  constructor(
    readonly attempted: string,
    readonly reason: string,
  ) {
    super(`Read-only violation: "${attempted}" rejected — ${reason}`);
    this.name = 'ReadOnlyViolationError';
  }
}

/**
 * İzin verilen OBD istekleri.
 *
 * Mode 01 = "show current data". Sadece okur, hiçbir yan etkisi yoktur.
 * Bu sürümün ihtiyacı bundan ibaret.
 *
 * Mode 02 (freeze frame), 06 ve 09 (VIN) de salt-okunurdur ama bu sürümde
 * gerekmiyorlar, o yüzden listede YOKLAR. İhtiyaç doğarsa tek tek, bilerek,
 * testiyle birlikte eklenirler.
 */
const OBD_MODE_01 = /^01[0-9A-F]{2}$/;

/**
 * DTC (arıza kodu) OKUMA modları — 2026-09-04'te bilerek eklendi.
 *
 * Üçü de tamamen salt-okunurdur: ECU'nun hafızasında ne yazdığını sorar,
 * hiçbir şey değiştirmez. Argüman almazlar, o yüzden tam eşleşme:
 *   03 = kayıtlı arıza kodları (MIL'i yakan kodlar)
 *   07 = bekleyen kodlar (henüz doğrulanmamış, MIL yakmamış)
 *   0A = kalıcı kodlar (silinemeyen, emisyon takibi)
 *
 * DİKKAT: Mode 04 (kod SİLME) buraya ASLA eklenmeyecek. Kod okumak arızayı
 * görmektir; silmek ECU'nun hafızasını değiştirmektir — bu uygulamanın
 * temel şartı ikincisini hiç yapmamak.
 */
const OBD_DTC_READ: ReadonlySet<string> = new Set([
  '03', // kayıtlı
  '07', // bekleyen
  '0A', // kalıcı
]);

/**
 * Sabit AT komutları. Bunlar ADAPTÖRE gider, araca değil — bus'a hiçbir şey
 * yazmazlar. Wildcard yok, tam eşleşme.
 */
const AT_LITERALS: ReadonlySet<string> = new Set([
  'ATZ',    // adaptörü resetle
  'ATE0',   // echo kapat
  'ATL0',   // linefeed kapat
  'ATS0',   // cevaplardaki boşlukları kapat
  'ATH0',   // header'ları kapat
  'ATAT1',  // adaptif zamanlama (K-line'da hız için kritik)
  'ATI',    // adaptör sürüm bilgisi
  'ATRV',   // adaptörün okuduğu akü voltajı
  'ATDPN',  // aktif protokolün numarası
]);

/**
 * Parametreli AT komutları. Parametre uzayı, yalnızca meşru değerleri
 * kapsayacak kadar dar tutulur.
 */
const AT_PATTERNS: readonly RegExp[] = [
  /^ATSP[0-9A-C]$/,      // protokol seç (0=oto .. C). Sabitlemek için gerekli.
  /^ATST[0-9A-F]{2}$/,   // cevap timeout'u (x4ms). Poll hızını ayarlamak için.
];

/**
 * SADECE hata mesajını anlaşılır kılmak için. Karar verici DEĞİLDİR —
 * karar her zaman beyaz listeye aittir. Bu tablo boş olsa da davranış aynıdır.
 */
const KNOWN_DANGEROUS: readonly [RegExp, string][] = [
  [/^04/,     'Mode 04 = clear DTCs. This app never clears fault codes — reading (03/07/0A) is allowed, clearing never is.'],
  [/^08/,     'Mode 08 = on-board component/actuator control. That is intervening in the car.'],
  [/^2E/,     'UDS 2E = write-data-by-identifier. Writing to the ECU.'],
  [/^31/,     'UDS 31 = routine control. Runs a routine on the ECU.'],
  [/^10/,     'UDS 10 = diagnostic session control.'],
  [/^11/,     'UDS 11 = ECU reset.'],
  [/^27/,     'UDS 27 = security access.'],
  [/^3E/,     'UDS 3E = tester present. Keeps a session alive; not needed.'],
  [/^34|^35|^36|^37/, 'UDS 34-37 = data transfer / flashing.'],
  [/^ATSH/,   'ATSH = targets an arbitrary ECU address. Destroys the read-only guarantee.'],
  [/^ATPP/,   'ATPP = writes to the adapter EEPROM; can permanently brick it.'],
  [/^ATBI/,   'ATBI = bypasses bus init and drives the line manually.'],
  [/^ATFI|^ATSI|^ATIB|^ATKW|^ATSW/, 'Low-level bus init manipulation.'],
  [/^ATMA|^ATMR|^ATMT/, 'Monitor commands: passive but unnecessary; widens the surface.'],
];

/** ELM327 boşlukları yok sayar, yani "01 0C" ile "010C" aynı komuttur. */
const WHITESPACE = /\s/g;

/** Makul bir komut bu uzunluğu asla aşmaz; tampon taşırma denemelerini keser. */
const MAX_COMMAND_LENGTH = 16;

/**
 * Komutu kanonik hâle getirir ve beyaz listeye karşı doğrular.
 *
 * @returns Adaptöre gönderilecek kanonik komut (boşluksuz, büyük harf).
 *          Çağıran MUTLAKA bu dönüş değerini göndermelidir, girdisini değil.
 * @throws  {ReadOnlyViolationError} beyaz listede olmayan her şey için.
 */
export function assertReadOnly(raw: string): string {
  if (typeof raw !== 'string') {
    throw new ReadOnlyViolationError(String(raw), 'command is not a string');
  }

  // Satır sonu = ELM327 için komut sınırı. İçeride bir tane varsa, tek bir
  // "komut" gibi görünen şey aslında iki komuttur ve ikincisi denetlenmemiş
  // olur. Bu, bekçiyi atlatmanın en bariz yolu; en başta kapatılır.
  if (/[\r\n\0]/.test(raw)) {
    throw new ReadOnlyViolationError(
      raw,
      'command contains a line break or null (could hide a second command)',
    );
  }

  const cmd = raw.replace(WHITESPACE, '').toUpperCase();

  if (cmd.length === 0) {
    throw new ReadOnlyViolationError(raw, 'empty command');
  }
  if (cmd.length > MAX_COMMAND_LENGTH) {
    throw new ReadOnlyViolationError(raw, `command longer than ${MAX_COMMAND_LENGTH} characters`);
  }

  if (OBD_MODE_01.test(cmd)) return cmd;
  if (OBD_DTC_READ.has(cmd)) return cmd;
  if (AT_LITERALS.has(cmd)) return cmd;
  if (AT_PATTERNS.some((p) => p.test(cmd))) return cmd;

  const known = KNOWN_DANGEROUS.find(([p]) => p.test(cmd));
  throw new ReadOnlyViolationError(
    raw,
    known ? known[1] : 'not on the allowlist (this app only reads Mode 01)',
  );
}

/** Fırlatmadan kontrol etmek isteyenler için (ör. UI’da pasifleştirme). */
export function isReadOnlyCommand(raw: string): boolean {
  try {
    assertReadOnly(raw);
    return true;
  } catch {
    return false;
  }
}

/** Debug ekranında kullanıcıya gösterilmek üzere, izin verilen her şeyin listesi. */
export const ALLOWED_COMMANDS_SUMMARY = [
  'OBD: 01XX (Mode 01 — current data, read only)',
  'OBD: 03, 07, 0A (read fault codes — never clears them)',
  `AT : ${[...AT_LITERALS].join(', ')}`,
  'AT : ATSP0-ATSPC (select protocol), ATSTxx (timeout)',
  'EVERY other command is rejected.',
].join('\n');
