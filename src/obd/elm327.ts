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
    .filter((l) => l.length > 0 && l !== 'SEARCHING...');
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
): Promise<InitResult> {
  const reset = await queue.send('ATZ', RESET_TIMEOUT_MS);
  if (!/ELM327/i.test(reset)) {
    throw new Error(`ATZ returned an unexpected response: ${JSON.stringify(reset)}`);
  }

  await queue.send('ATE0');
  await queue.send('ATL0');
  await queue.send('ATS0');
  await queue.send('ATH0');
  await queue.send('ATAT1');

  const spCmd = preferredProtocol ? `ATSP${preferredProtocol}` : 'ATSP0';
  await queue.send(spCmd);

  // Destek bitmask'i 32'lik bloklar hâlinde gelir. 0100 zorunlu; 0120 ve
  // 0140 yalnızca bir önceki blok "sıradaki blok var" bitini (en düşük bit)
  // set etmişse sorulur — desteklenmeyen bloğu sormak K-line'da boşa
  // timeout beklemek demek.
  const block00 = extractDataHex(await queue.send('0100'));
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

  return {
    adapterInfo: info.trim(),
    protocolNumber: dpn.trim(),
    supportedPids,
  };
}

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
