/**
 * Oturum örneklerini geniş (wide) formatta CSV'ye çevirir.
 *
 * Uzun format değil, geniş format seçildi çünkü Excel/Sheets'te doğrudan
 * grafiklenebilir olması gerekiyor: `timestamp_ms,rpm,speed_kmh,coolant_c,...`.
 *
 * İki tasarım kararı, ikisi de gerçek veriden çıktı (2026-09-04, MINI R50):
 *
 * 1. **Pencere genişliği otomatik.** Sabit 1000ms varsayılan, hızlı PID'ler
 *    saniyede birden az örneklendiğinde satırların yarısını boş bırakıyordu.
 *    Artık pencere, hızlı PID'lerin gerçek örnekleme aralığından türetiliyor.
 *
 * 2. **Yavaş PID'ler forward-fill edilir, hızlılar edilmez.** Poller yavaş
 *    PID'leri (soğutma suyu vb.) bilerek seyrek soruyor — o yüzden aradaki
 *    boşluk "veri kaybı" değil, "değer hâlâ geçerli" demek. Hızlı bir PID'in
 *    boşluğu ise gerçekten ölçüm alınamadığı anlamına gelir ve boş bırakılır;
 *    o ikisini birbirine karıştırmak veriyi yalancı yapardı.
 *
 * Bu modül saf: sadece Sample[] alır, string döner. RN/expo'ya bağımlı
 * değil, DB'ye dokunmaz — cihazsız test edilebilir.
 */

import type { Channel } from '../data/channels';
import type { Sample } from './types';

/** Otomatik hesap yapılamadığında kullanılacak pencere. */
export const DEFAULT_STEP_MS = 1000;
const MIN_STEP_MS = 100;
const MAX_STEP_MS = 10_000;

export interface CsvOptions {
  /** Zaman ekseni pencere genişliği (ms). Verilmezse veriden türetilir. */
  stepMs?: number;
}

/**
 * Hızlı PID'lerin gerçek örnekleme aralığına bakarak makul bir pencere
 * genişliği önerir: örneklerin çoğunun kendi penceresine düşmesini sağlayan
 * en küçük değer. Medyan kullanılır (ortalama, tek bir uzun duraklamadan
 * etkilenirdi).
 */
export function suggestStepMs(
  samples: readonly Sample[],
  channels: readonly Channel[],
): number {
  const fastChannels = channels.filter((c) => c.refresh !== 'slow');
  const target = fastChannels.length > 0 ? fastChannels : channels;

  const medians: number[] = [];
  for (const channel of target) {
    const times = samples
      .filter((s) => s.pid === channel.key)
      .map((s) => s.ts)
      .sort((a, b) => a - b);
    if (times.length < 2) continue;
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
    gaps.sort((a, b) => a - b);
    medians.push(gaps[Math.floor(gaps.length / 2)]);
  }

  if (medians.length === 0) return DEFAULT_STEP_MS;

  // En yavaş hızlı-PID'i baz al ki o da her pencerede bir değer bulsun.
  const step = Math.max(...medians);
  const rounded = Math.round(step / 50) * 50;
  return Math.min(MAX_STEP_MS, Math.max(MIN_STEP_MS, rounded));
}

/**
 * `samples`'ı geniş formatta CSV string'ine çevirir. `pids` sütun sırasını
 * belirler.
 */
export function toWideCsv(
  samples: readonly Sample[],
  channels: readonly Channel[],
  options: CsvOptions = {},
): string {
  const header = ['timestamp_ms', ...channels.map((c) => c.csvKey)];

  if (samples.length === 0) {
    return header.join(',') + '\n';
  }

  const stepMs = options.stepMs ?? suggestStepMs(samples, channels);
  const maxTs = Math.max(...samples.map((s) => s.ts));
  const numWindows = Math.floor(maxTs / stepMs) + 1;

  // pid -> pencere index -> son değer
  const byPid = new Map<string, Map<number, number>>();
  for (const s of samples) {
    const windowIdx = Math.floor(s.ts / stepMs);
    let windowMap = byPid.get(s.pid);
    if (!windowMap) {
      windowMap = new Map();
      byPid.set(s.pid, windowMap);
    }
    // Aynı pencerede birden fazla örnek varsa sonuncusu kazanır.
    windowMap.set(windowIdx, s.value);
  }

  const lastSeen = new Map<string, number>();
  const rows: string[] = [header.join(',')];

  for (let w = 0; w < numWindows; w++) {
    const cells: string[] = [String(w * stepMs)];
    for (const c of channels) {
      const v = byPid.get(c.key)?.get(w);
      if (v !== undefined) {
        lastSeen.set(c.key, v);
        cells.push(formatNumber(v));
      } else if (c.refresh === 'slow') {
        // Bilerek seyrek örneklendi: son bilinen değer hâlâ geçerli.
        const carried = lastSeen.get(c.key);
        cells.push(carried === undefined ? '' : formatNumber(carried));
      } else {
        // Hızlı kanal: ölçüm gerçekten yok, uydurmuyoruz.
        cells.push('');
      }
    }
    rows.push(cells.join(','));
  }

  return rows.join('\n') + '\n';
}

function formatNumber(n: number): string {
  // Gereksiz kuyruk sıfırlarını at ama tam sayıları da bozma.
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}
