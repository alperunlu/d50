/**
 * Araç PID tarama raporu.
 *
 * "Bu PID MINI'de var mı?" sorusunun otoritesi forum ya da doküman değil,
 * aracın ECU'sudur. Ama bitmask (`0100`/`0120`/`0140`) yalnızca ECU'nun
 * NE İDDİA ETTİĞİNİ söyler — nadiren bir ECU "destekliyorum" deyip sorunca
 * `NO DATA` ya da sabit/anlamsız değer döndürür.
 *
 * Bu modül ikisini yan yana koyar: iddia edilen her PID tek tek sorulur ve
 * ham cevap kaydedilir. Tek bir araç ziyaretinde "gerçekte neyimiz var"
 * sorusu kesin olarak cevaplanır ve rapor .txt olarak paylaşılabilir.
 *
 * Tarama salt-okunurdur: yalnızca `01XX` (Mode 01) sorguları gönderilir,
 * hepsi zaten allowlist'ten geçer.
 */

import type { CommandQueue } from './elm327';
import { extractDataHex, hexToBytes } from './elm327';
import { getPidDefinition, type SupportedPidMap } from './pids';

/** Taranabilecek en yüksek PID (0x60 = üçüncü bloğun sonu). */
const MAX_PID = 0x60;

/**
 * Bitmask'lerin "destekliyorum" dediği PID'lerin listesi.
 *
 * Saf fonksiyon — cihazsız test edilebilir. Her bloğun en düşük biti
 * "sonraki blok da var" anlamına gelir ve bir PID değildir; o yüzden
 * 0x20/0x40/0x60 sınır PID'leri listeye alınmaz.
 */
export function listClaimedPids(mask: SupportedPidMap): string[] {
  const claimed: string[] = [];

  const blocks: [string | undefined, number][] = [
    [mask.block00, 0x00],
    [mask.block20, 0x20],
    [mask.block40, 0x40],
  ];

  for (const [hex, offset] of blocks) {
    if (!hex || hex.length < 8) continue;
    const bits = hexToBits(hex);
    // Son bit (index 31) "sonraki blok var" bayrağı, PID değil.
    for (let i = 0; i < 31; i++) {
      if (bits[i] === '1') {
        const pidNum = offset + i + 1;
        if (pidNum <= MAX_PID) {
          claimed.push(pidNum.toString(16).toUpperCase().padStart(2, '0'));
        }
      }
    }
  }

  return claimed;
}

export interface PidScanRow {
  readonly pid: string;
  /** Katalogda tanımlıysa insan okur adı. */
  readonly name: string | null;
  /** Adaptörden dönen ham cevap (kırpılmış). */
  readonly rawResponse: string;
  /** Katalogda tanımlı ve çözülebildiyse fiziksel değer. */
  readonly value: number | null;
  readonly unit: string | null;
  /** ECU iddia etti ama gerçek cevap gelmedi mi? */
  readonly answered: boolean;
}

export interface PidScanProgress {
  readonly done: number;
  readonly total: number;
  readonly currentPid: string;
}

/**
 * İddia edilen her PID'i tek tek sorar ve sonucu kaydeder.
 *
 * Tarama K-line'da PID başına ~300ms sürer; 30 PID ≈ 10 saniye. `onProgress`
 * ile UI ilerlemeyi gösterebilir.
 */
export async function scanPids(
  queue: CommandQueue,
  mask: SupportedPidMap,
  onProgress?: (p: PidScanProgress) => void,
  timeoutMs = 3000,
): Promise<PidScanRow[]> {
  const claimed = listClaimedPids(mask);
  const rows: PidScanRow[] = [];

  for (let i = 0; i < claimed.length; i++) {
    const pid = claimed[i];
    onProgress?.({ done: i, total: claimed.length, currentPid: pid });

    let rawResponse = '';
    let value: number | null = null;
    let answered = false;

    try {
      rawResponse = (await queue.send(`01${pid}`, timeoutMs)).trim();
      const hex = extractDataHex(rawResponse);
      answered = hex.length > 0;

      const def = getPidDefinition(pid);
      if (def && answered) {
        const bytes = hexToBytes(hex);
        if (bytes.length >= def.bytes) value = def.decode(bytes);
      }
    } catch (e) {
      rawResponse = e instanceof Error ? `ERROR: ${e.message}` : String(e);
    }

    const def = getPidDefinition(pid);
    rows.push({
      pid,
      name: def?.name ?? null,
      rawResponse: rawResponse.replace(/\r/g, ' ').trim(),
      value,
      unit: def?.unit ?? null,
      answered,
    });
  }

  onProgress?.({ done: claimed.length, total: claimed.length, currentPid: '' });
  return rows;
}

/** Raporu paylaşılabilir düz metne çevirir. Saf fonksiyon. */
export function formatScanReport(rows: readonly PidScanRow[], mask: SupportedPidMap): string {
  const lines: string[] = [];
  lines.push('OBD-II PID scan report');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('Support bitmask blocks (what the ECU claims):');
  lines.push(`  0100: ${mask.block00 ?? '(not answered)'}`);
  lines.push(`  0120: ${mask.block20 ?? '(not answered)'}`);
  lines.push(`  0140: ${mask.block40 ?? '(not answered)'}`);
  lines.push('');
  lines.push(`Claimed PIDs: ${rows.length}`);
  lines.push(`Actually answered: ${rows.filter((r) => r.answered).length}`);
  lines.push('');
  lines.push('PID  | answered | value            | name                     | raw');
  lines.push('-----+----------+------------------+--------------------------+--------------------');

  for (const r of rows) {
    const valueText =
      r.value !== null ? `${round3(r.value)} ${r.unit ?? ''}`.trim() : r.answered ? '(not in catalog)' : '-';
    lines.push(
      [
        r.pid.padEnd(4),
        (r.answered ? 'yes' : 'NO').padEnd(8),
        valueText.padEnd(16),
        (r.name ?? '-').padEnd(24),
        r.rawResponse,
      ].join(' | '),
    );
  }

  const unanswered = rows.filter((r) => !r.answered);
  if (unanswered.length > 0) {
    lines.push('');
    lines.push('NOTE: the ECU claimed these PIDs but returned no usable data:');
    lines.push('  ' + unanswered.map((r) => r.pid).join(', '));
  }

  return lines.join('\n') + '\n';
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function hexToBits(hex: string): string {
  return hex
    .split('')
    .map((c) => parseInt(c, 16).toString(2).padStart(4, '0'))
    .join('');
}
