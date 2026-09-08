/**
 * ELM327 çerçeveleme, komut kuyruğu ve init dizisi.
 *
 * ELM327 tek kanallıdır: bir komut gönderilir, cevabı beklenir, sonraki
 * komut ancak ondan sonra gönderilir. BLE üzerinden gelen bildirimler ~20
 * byte'lık parçalar hâlinde gelir ve her cevap `>` prompt karakteriyle
 * biter — bu modül parça birleştirmeyi ve komut sıralamasını yönetir.
 *
 * Bu dosya `ObdTransport`'un ÜZERİNDE çalışır, kendisi transport değildir.
 * Salt-okunurluk zaten transport katmanında (assertReadOnly) garanti
 * edildiği için burada tekrar kontrol edilmez — ama hiçbir komut bu
 * modülü atlayarak transport'a ulaşamaz, her şey `queue.send()`'den geçer.
 */

import type { ObdTransport } from '../ble/transport';
import type { SupportedPidMap } from './pids';
import { parseVin } from './vin';

/** ELM327 komut/cevap sınırı. Cevaplar bu prompt ile biter. */
export const PROMPT = '>';

/** Ham baytları ELM327 satır protokolüne göre çerçeveleyen birleştirici. */
export class ResponseFramer {
  private buffer = '';

  /**
   * Yeni bir parça ekler. Tampon `>` içeriyorsa, o ana kadarki (prompt
   * hariç) metni döndürür ve tamponu sıfırlar; içermiyorsa `null` döner —
   * çağıran taraf daha fazla veri beklemelidir.
   */
  push(chunk: string): string | null {
    this.buffer += chunk;
    const idx = this.buffer.indexOf(PROMPT);
    if (idx === -1) return null;

    const complete = this.buffer.slice(0, idx);
    this.buffer = this.buffer.slice(idx + PROMPT.length);
    return complete;
  }

  reset(): void {
    this.buffer = '';
  }
}

/**
 * Ham ELM327 cevap metnini kullanılabilir satırlara ayırır:
 * `\r`/`\n` ile böler, boş satırları ve "SEARCHING..." gibi durum
 * mesajlarını eler, baş/son boşlukları kırpar.
 */
export function splitResponseLines(raw: string): string[] {
  return raw
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !STATUS_LINE.test(l));
}

/**
 * Cevap DEĞİL, durum bildiren satırlar.
 *
 * `SEARCHING...` baştan beri eleniyordu; `STOPPED` elenmiyordu ve bu pahalıya
 * mal oldu. `STOPPED`, ELM327'nin "protokol aramasını yarıda kestim" demesi
 * — ve aramayı kesen şey bizim gönderdiğimiz bir sonraki komut. 7 Eylül
 * kaydında 41 kez arka arkaya oldu ve bağlantı hiç toparlanamadı: arama
 * 3 saniyelik PID timeout'undan uzun sürüyor, timeout dolunca yeni komut
 * gidiyor, o da aramayı kesiyor.
 *
 * Bunu "cevap" saymak iki kat yanlıştı: hem veri sanıldı, hem de
 * `initElm327` bunun üstüne "protokol kuruldu" dedi.
 */
const STATUS_LINE = /^(SEARCHING\.{0,3}|STOPPED|BUS INIT.*|BUS ERROR|UNABLE TO CONNECT|\?)$/i;

/**
 * Cevap gerçek veri mi, yoksa adaptörün "hâlâ uğraşıyorum / olmadı"
 * demesi mi? İkincisinde beklemek ya da yeniden denemek gerekir; komutu
 * cevaplanmış saymak olmaz.
 */
export function isStatusOnlyResponse(raw: string): boolean {
  return splitResponseLines(raw).length === 0;
}

/** Komut zaman aşımına uğradığında fırlatılır. */
export class ObdTimeoutError extends Error {
  constructor(readonly command: string, readonly timeoutMs: number) {
    super(`Command "${command}" was not answered within ${timeoutMs}ms`);
    this.name = 'ObdTimeoutError';
  }
}

const DEFAULT_TIMEOUT_MS = 5000;
const RESET_TIMEOUT_MS = 10000; // ATZ / 5-baud init K-line'da yavaş olabilir

/**
 * Komutları sıraya alıp transport'a tek tek, önceki cevap tamamlanmadan
 * yenisini göndermeden ileten kuyruk. `elm327.ts` dışındaki hiçbir modül
 * transport.send()'i doğrudan çağırmamalıdır — poller dahil, her şey bu
 * kuyruktan geçer, aksi hâlde iki komut aynı anda uçabilir ve ELM327
 * cevapları birbirine karışır.
 */
export class CommandQueue {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly transport: ObdTransport) {}

  /** Komutu kuyruğa ekler, sırası gelince gönderir, cevabı döndürür. */
  send(command: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    const run = this.tail.then(() => this.transport.send(command, timeoutMs));
    // Zincirin kopmaması için hatayı yut, ama çağırana yine de ilet.
    this.tail = run.catch(() => undefined);
    return run;
  }
}

/** Bir init adımının cevabının kabul edilebilir olup olmadığını kontrol eder. */
function expectOk(response: string): boolean {
  const lines = splitResponseLines(response);
  return lines.some((l) => /^(OK|ELM327)/i.test(l));
}

/**
 * Bir AT ayar komutunu gönderir ve cevabını DOĞRULAR.
 *
 * `expectOk` bu dosyada baştan beri tanımlıydı ama hiçbir yerden
 * çağrılmıyordu — yani init'in hiçbir adımı kontrol edilmiyordu. 7 Eylül
 * kaydında bunun bedeli şuydu: ATE0/ATL0/ATS0/ATH0 sırayla "gönderildi",
 * hepsi bir önceki komutun geç cevabını aldı, hiçbiri uygulanmadı, ve
 * uygulama farkında olmadan echo açık hâlde çalışmaya devam etti.
 *
 * Bir kez yeniden deneniyor: tek seferlik gürültü ile gerçek arıza farklı
 * şeyler, ve ilkini arıza saymak bağlantıyı gereksiz yere düşürür.
 */
async function sendSetting(queue: CommandQueue, command: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await queue.send(command);
    if (expectOk(response)) return;
  }
  throw new Error(`Adapter did not accept ${command}`);
}

export interface InitResult {
  /** `ATI` cevabı — adaptör tanıtımı. */
  adapterInfo: string;
  /** `ATDPN` cevabı — aktif protokol numarası (ör. "5" = ISO 14230-4 KWP fast). */
  protocolNumber: string;
  /**
   * Aracın desteklediği PID'lerin bitmask haritası (0100/0120/0140).
   * Bir blok sorulmadıysa ya da cevapsız kaldıysa o alan tanımsız kalır.
   */
  supportedPids: SupportedPidMap;
  /**
   * Aracın şasi numarası, okunabildiyse.
   *
   * `null` üç ayrı şeyi birlikte anlatıyor ve üçünü ayırmaya gerek yok:
   * ECU Mode 09'u hiç desteklemiyor olabilir (2003 model bir K-line aracında
   * bu sık), 0902'ye cevap vermemiş olabilir, ya da cevap çözümlenememiş
   * olabilir. Hepsinin sonucu aynı: VIN'i bilmiyoruz, ve bilmediğimizi
   * söylemek uydurmaktan iyi.
   */
  vin: string | null;
  /**
   * Adaptör, komut sonundaki "beklenen cevap sayısı" hanesini anlıyor mu?
   *
   * 7 Eylül 2026 ölçümü: bir PID sorgusu 272 ms sürüyordu ve bu süre hangi
   * PID olursa olsun aynıydı. Aynı adaptöre giden ama araca hiç dokunmayan
   * `ATRV` 47 ms sürüyordu. PID'den bağımsız sabit fark K-line'ın hızı
   * olamaz — ELM327'nin cevabı aldıktan sonra "başka ECU da konuşacak mı"
   * diye kendi zaman aşımını doldurmasıdır. `010C1` ona "bir cevap yeter"
   * der ve beklemeyi keser.
   *
   * SINANIYOR, varsayılmıyor: bazı klon adaptörler son eki anlamayıp `?`
   * döner ve o hâlde hiçbir kanal okunamazdı.
   */
  supportsReplyCount: boolean;
}

/**
 * Adaptörü sıfırdan başlatır: reset, echo/linefeed/space/header kapatma,
 * adaptif zamanlama, protokol seçimi, desteklenen PID keşfi.
 *
 * `preferredProtocol` verilirse (ör. önceki bağlantıdan hatırlanan "5"),
 * `ATSP0` (otomatik arama, bus'a fazladan trafik biner) yerine doğrudan
 * `ATSP<n>` kullanılır — bkz. plan, Kısıt #1 "bus üzerindeki ayak izi".
 */
export async function initElm327(
  queue: CommandQueue,
  preferredProtocol?: string,
  /**
   * VIN okumayı atlar ve verilen değeri sonuca koyar.
   *
   * Kurtarma (`recoverProtocol`) için: bus zaten sorunluyken ona iki
   * fazladan komut daha sormanın anlamı yok, üstelik VIN değişmiyor —
   * bağlantı başında okunan hâlâ geçerli.
   */
  knownVin?: string | null,
): Promise<InitResult> {
  const reset = await queue.send('ATZ', RESET_TIMEOUT_MS);
  if (!/ELM327/i.test(reset)) {
    throw new Error(`ATZ returned an unexpected response: ${JSON.stringify(reset)}`);
  }

  await sendSetting(queue, 'ATE0');
  await sendSetting(queue, 'ATL0');
  await sendSetting(queue, 'ATS0');
  await sendSetting(queue, 'ATH0');
  await sendSetting(queue, 'ATAT1');

  const spCmd = preferredProtocol ? `ATSP${preferredProtocol}` : 'ATSP0';
  await sendSetting(queue, spCmd);

  // Destek bitmask'i 32'lik bloklar hâlinde gelir. 0100 zorunlu; 0120 ve
  // 0140 yalnızca bir önceki blok "sıradaki blok var" bitini (en düşük bit)
  // set etmişse sorulur — desteklenmeyen bloğu sormak K-line'da boşa
  // timeout beklemek demek.
  /**
   * İlk gerçek istek protokol ARAMASINI tetikler ve arama K-line'da
   * saniyeler sürer. Normal PID timeout'uyla sorulursa timeout dolar,
   * sıradaki komut gider ve aramayı keser (`STOPPED`) — 7 Eylül kaydında
   * bağlantının hiç toparlanamamasının sebebi tam olarak buydu.
   *
   * Bu yüzden ilk istek uzun timeout'la ve `STOPPED` gelirse yeniden
   * denenerek yapılıyor. Aramayı bölmemek, aramayı hızlandırmaktan daha
   * önemli.
   */
  const block00 = extractDataHex(await requestThroughSearch(queue, '0100'));
  const supportedPids: { block00?: string; block20?: string; block40?: string } = { block00 };

  if (hasNextBlockBit(block00)) {
    const block20 = extractDataHex(await queue.send('0120'));
    if (block20) {
      supportedPids.block20 = block20;
      if (hasNextBlockBit(block20)) {
        const block40 = extractDataHex(await queue.send('0140'));
        if (block40) supportedPids.block40 = block40;
      }
    }
  }

  const dpn = await queue.send('ATDPN');
  const info = await queue.send('ATI');

  /**
   * Protokol numarası DOĞRULANIYOR.
   *
   * Doğrulanmadığı için 7 Eylül kaydında şu satır yazıldı:
   *   "Protocol re-established: 010BSEARCHING...STOPPED, 0111SEARCH..."
   * Kurtarma başarısız olmuştu ve uygulama başarılı sandı. Bir ölçüm
   * aletinin kendi durumu hakkında yalan söylemesi, ölçüm yapamamasından
   * kötüdür.
   */
  const protocolNumber = dpn.trim();
  if (!PROTOCOL_NUMBER.test(protocolNumber.replace(/\s/g, ''))) {
    throw new Error(`Adapter reported an implausible protocol: ${JSON.stringify(protocolNumber)}`);
  }
  const vin = knownVin !== undefined ? knownVin : await readVin(queue);
  const supportsReplyCount = await probeReplyCount(queue);

  return {
    adapterInfo: info.trim(),
    protocolNumber,
    supportedPids,
    vin,
    supportsReplyCount,
  };
}

/**
 * Cevap sayısı son ekini sınar.
 *
 * Devir seçildi çünkü her araçta var ve kontak açıkken motor kapalıyken
 * bile geçerli bir cevap (`410C0000`) döner — sınama motorun çalışıp
 * çalışmamasından bağımsız.
 *
 * Anlaşılmayan son ek `?` ile karşılanır ve `extractDataHex` boş döner.
 * Hata durumunda da `false`: hızlanamamak kötü, hiç okuyamamak felaket.
 */
async function probeReplyCount(queue: CommandQueue): Promise<boolean> {
  try {
    const response = await queue.send('010C1');
    return extractDataHex(response, '0C').length > 0;
  } catch {
    return false;
  }
}

/**
 * `ATDPN` cevabı: bir hane (0-C), önünde otomatik aramayı gösteren 'A'
 * olabilir. Başka her şey ya geç gelen bir cevap ya da çöptür.
 */
const PROTOCOL_NUMBER = /^A?[0-9A-C]$/i;

/** Protokol araması sürerken bir isteğin tamamlanmasını bekler. */
const SEARCH_TIMEOUT_MS = 12_000;
const SEARCH_ATTEMPTS = 3;

/**
 * Protokol araması gerektirebilecek ilk isteği yapar.
 *
 * `STOPPED` bir cevap değil, "aramayı yarıda kestin" demektir; tek çare
 * yeniden sormak ve bu sefer kesmemektir.
 */
async function requestThroughSearch(queue: CommandQueue, command: string): Promise<string> {
  let last = '';
  for (let attempt = 0; attempt < SEARCH_ATTEMPTS; attempt++) {
    last = await queue.send(command, SEARCH_TIMEOUT_MS);
    if (!isStatusOnlyResponse(last)) return last;
  }
  throw new Error(
    `${command} never got past the protocol search (last response: ${JSON.stringify(last)})`,
  );
}

/**
 * VIN'i okur. Bağlantı başına BİR kez — VIN değişmez.
 *
 * Önce 0900 ile Mode 09'un desteklenip desteklenmediği soruluyor. Bunun
 * sebebi ölçülü olmak: desteklenmeyen bir moda soru sormak K-line'da boşa
 * timeout beklemek demek ve bağlantı açılışını yavaşlatır. 0900 cevapsız
 * kalırsa 0902 hiç denenmiyor.
 *
 * Hiçbir hata yukarı sızmıyor: VIN okunamadı diye bağlantı kurulamamış
 * sayılmaz. VIN bir kolaylık, bağlantının şartı değil.
 */
async function readVin(queue: CommandQueue): Promise<string | null> {
  try {
    const support = await queue.send('0900');
    if (!/4900/.test(support.replace(/\s/g, ''))) return null;

    const response = await queue.send('0902', VIN_TIMEOUT_MS);
    return parseVin(response);
  } catch {
    return null;
  }
}

/**
 * VIN çok çerçeveli gelir ve K-line'da her çerçeve ayrı ayrı zamanlanır;
 * tek bir PID'e verilen süre yetmiyor.
 */
const VIN_TIMEOUT_MS = 5_000;

/**
 * Bitmask'in en düşük biti (PID x20) "bir sonraki blok da destekleniyor"
 * anlamına gelir — SAE J1979. Bu bit yoksa sıradaki bloğu sormak gereksiz.
 */
function hasNextBlockBit(blockHex: string): boolean {
  if (!blockHex || blockHex.length < 8) return false;
  const lastNibble = parseInt(blockHex[7], 16);
  return (lastNibble & 0x1) === 1;
}

/**
 * Mode 01 cevabından veri baytlarını (mode+PID hariç) çıkarır.
 *
 * `expectedPid` verildiğinde cevabın GERÇEKTEN o PID'e ait olduğu doğrulanır.
 * Bu isteğe bağlı bir titizlik değil, 2026-09-05 araç testinde yakalanan bir
 * veri bozulmasının çözümü:
 *
 *     [error] Command "010C" was not answered within 3000ms
 *     [tx] 010D
 *     [rx] 410C1D80⏎410D00⏎⏎
 *
 * Zaman aşımına uğrayan 010C'nin geç cevabı, bir sonraki komutun (010D)
 * cevabıyla birlikte geldi. Eşleştirme yapılmadığında ilk satır alınıyor ve
 * DEVİR verisi HIZ olarak kaydediliyordu — araç dururken 29 km/h. Ölçüm
 * aletinde sessizce yanlış değer, veri gelmemesinden çok daha kötüdür.
 *
 * Çoklu ECU cevabı gelirse eşleşen ilk satır kullanılır.
 */
export function extractDataHex(raw: string, expectedPid?: string): string {
  const lines = splitResponseLines(raw);

  const candidates = lines
    .map((l) => l.replace(/\s/g, '').toUpperCase())
    .filter((l) => /^[0-9A-F]+$/.test(l) && l.length >= 4);

  if (candidates.length === 0) return '';

  if (expectedPid) {
    // Mode 01 cevabı 0x40 eklenmiş mod baytıyla başlar: "41" + PID.
    const wanted = `41${expectedPid.toUpperCase()}`;
    const matched = candidates.find((l) => l.startsWith(wanted));
    // Eşleşme yoksa boş dön: yanlış PID'in verisini döndürmektense veri yok.
    return matched ? matched.slice(4) : '';
  }

  return candidates[0].slice(4);
}

/** Hex string'i bayt dizisine çevirir. "1AF8" -> [0x1A, 0xF8]. */
export function hexToBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return bytes;
}

/**
 * ELM327'nin kendi voltmetresinin cevabını okur (`ATRV` → "12.6V").
 *
 * Bu ölçüm ARAÇTAN gelmiyor: adaptör OBD soketinin 16. pinindeki beslemeyi
 * kendisi ölçüyor. Bu yüzden aracın PID 0142'yi (control module voltage)
 * desteklememesi önemli değil — bu R50 desteklemiyor ve o kanal boş
 * kalıyordu, oysa voltaj bilgisi adaptörde hazır duruyordu.
 */
export function parseAdapterVoltage(raw: string): number | null {
  const match = /(\d{1,2}(?:\.\d+)?)\s*V/i.exec(raw);
  if (!match) return null;
  const value = Number(match[1]);
  // 0 V ya da 30 V bu soketten gelmez; ölçüm değil gürültüdür.
  return Number.isFinite(value) && value > 5 && value < 20 ? value : null;
}
