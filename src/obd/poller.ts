/**
 * Seçili PID'leri round-robin sorgulayan döngü.
 *
 * K-line'da (bkz. plan, Kısıt #3) tek seferde tek PID sorulabilir, bu yüzden
 * bu döngü PID'leri sırayla, birer birer sorar. Cevaplar bir bellek
 * tamponunda birikir ve `flushIntervalMs`'de bir (varsayılan 1000ms) toplu
 * olarak `onFlush` callback'i ile dışarı verilir — DB'ye örnek başına ayrı
 * yazma yapmamak için (bkz. plan).
 *
 * Bu modül DB'yi bilmez; `onFlush` çağıranı (UI/store) tarafından
 * `repo.insertSamples()`'a bağlanır. Böylece poller mock ile de, gerçek
 * transport ile de, DB'siz de test edilebilir.
 */

import { CommandQueue } from './elm327';
import { extractDataHex, hexToBytes } from './elm327';
import { commandFor, getPidDefinition, type PidDefinition } from './pids';

export interface PollSample {
  readonly ts: number; // poller başlangıcından beri geçen ms
  readonly pid: string;
  readonly value: number;
}

export interface PollerOptions {
  readonly pids: readonly PidDefinition[];
  readonly queue: CommandQueue;
  readonly onFlush: (samples: PollSample[]) => void;
  /** Ne sıklıkla toplu flush yapılacağı. Varsayılan 1000ms. */
  readonly flushIntervalMs?: number;
  /** Her PID sorgusunun timeout'u. Varsayılan 3000ms (K-line yavaş). */
  readonly commandTimeoutMs?: number;
  /**
   * Yavaş kanalların hedef aralığı (ms). Varsayılan 10 sn.
   * Bkz. `buildPollSchedule` — kıt bus kapasitesini hızlı değişen
   * değerlere ayırmanın yolu bu.
   */
  readonly slowIntervalMs?: number;
  /** Cevap vermeyen bir PID geri çekildiğinde haber verir (debug log'u için). */
  readonly onBackoff?: (pid: string, failures: number) => void;
}

/**
 * Bir turda hangi PID'lerin, kaç kez sorulacağını belirler.
 *
 * ÜÇ KURAL, üçü de gerçek ölçümden çıktı (MINI R50, K-line ~3.3 istek/sn):
 *
 * 1. AĞIRLIK. Her hızlı PID `weight` kadar kez turda yer alır ve
 *    tekrarlar tura yayılır (yan yana gelmez). Devir ve hız 2 ağırlıklı;
 *    ikisi de saniyede birkaç kez değişiyor ve üstlerine ivme, güç, tork,
 *    order takibi kuruluyor. Eşit bölüşüm bunları gereksiz yere seyreltiyordu.
 *
 * 2. YAVAŞLAR ZAMANA GÖRE. Önce "her N turda bir" idi; tur uzunluğu seçilen
 *    kanal sayısıyla değiştiği için soğutma suyu bazen 3, bazen 15 saniyede
 *    bir okunuyordu. Artık son okunma ZAMANINA bakılıyor: kaç kanal seçilirse
 *    seçilsin yavaş kanallar sabit aralıkla geliyor.
 *
 * 3. CEVAP VERMEYENDEN GERİ ÇEKİLME. Cevapsız her PID timeout kadar (3 sn)
 *    hattı işgal ediyor. Üst üste başarısız olan bir PID giderek daha seyrek
 *    soruluyor; tek bir cevapsız kanalın toplam hızı yarıya düşürmesi
 *    böyle engelleniyor. Bir kez cevap verirse ceza sıfırlanır.
 *
 * Saf fonksiyon: bütün durum dışarıdan geçiliyor, cihazsız test edilebilir.
 */
export interface PollScheduleState {
  /** Şu anki zaman (ms). */
  readonly nowMs: number;
  /** PID -> en son ne zaman soruldu (ms). Hiç sorulmadıysa alan yok. */
  readonly lastPolledMs: Readonly<Record<string, number>>;
  /** PID -> üst üste kaç kez cevapsız kaldı. */
  readonly failures: Readonly<Record<string, number>>;
  /** Yavaş kanalların hedef aralığı (ms). */
  readonly slowIntervalMs?: number;
}

/**
 * Üst üste başarısız olan bir PID kaç turda bir sorulsun.
 * 0-1 hata: her tur · 2-3 hata: 4 turda bir · 4+: 16 turda bir.
 */
export function backoffCycles(failures: number): number {
  if (failures < 2) return 1;
  if (failures < 4) return 4;
  return 16;
}

export function buildPollSchedule(
  pids: readonly PidDefinition[],
  cycleIndex: number,
  state: PollScheduleState,
): PidDefinition[] {
  const slowIntervalMs = state.slowIntervalMs ?? DEFAULT_SLOW_INTERVAL_MS;

  const active = pids.filter((p) => {
    const every = backoffCycles(state.failures[p.pid] ?? 0);
    return cycleIndex % every === 0;
  });

  const fast = active.filter((p) => p.refresh !== 'slow');
  const slow = active.filter((p) => p.refresh === 'slow');

  // Yavaş kanallardan zamanı GELMİŞ olanlar; en uzun süredir beklemiş
  // olan öne alınıyor ki hiçbiri sürekli sıranın sonunda kalmasın.
  const dueSlow = slow
    .filter((p) => state.nowMs - (state.lastPolledMs[p.pid] ?? 0) >= slowIntervalMs)
    .sort(
      (a, b) =>
        (state.lastPolledMs[a.pid] ?? 0) - (state.lastPolledMs[b.pid] ?? 0),
    );

  // Hiç hızlı PID seçilmemişse yavaşları kısmak anlamsız — hepsi her turda.
  if (fast.length === 0) return slow.length > 0 ? [...slow] : [];

  return [...spreadByWeight(fast), ...dueSlow.slice(0, 1)];
}

/**
 * Ağırlıklı PID'leri tekrarları yan yana gelmeyecek şekilde sıralar.
 *
 * Ağırlığı 2 olan devir için [devir, devir, hız] yerine [devir, hız, devir]
 * üretilmesi önemli: iki ölçüm arasındaki boşluğun EŞİT olması, ivme ve
 * order analizinin dayandığı düzgün zaman eksenini veriyor.
 */
function spreadByWeight(pids: readonly PidDefinition[]): PidDefinition[] {
  const slots: { pid: PidDefinition; position: number }[] = [];
  for (const pid of pids) {
    const weight = Math.max(1, Math.round(pid.weight ?? 1));
    for (let k = 0; k < weight; k++) {
      // Bresenham benzeri yayma: her tekrar kendi diliminin ortasına düşer.
      slots.push({ pid, position: (k + 0.5) / weight });
    }
  }
  slots.sort((a, b) => a.position - b.position);
  return slots.map((s) => s.pid);
}

const DEFAULT_FLUSH_MS = 1000;
const DEFAULT_TIMEOUT_MS = 3000;
/** Yavaş kanalların hedef örnekleme aralığı. Soğutma suyu için fazlasıyla yeterli. */
const DEFAULT_SLOW_INTERVAL_MS = 10_000;

export class Poller {
  private running = false;
  private buffer: PollSample[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly startedAt = Date.now();
  private loopPromise: Promise<void> | null = null;

  /** Son bir saniyede tamamlanan örnek sayısı — UI'da "~N örnek/sn" göstermek için. */
  private recentSampleCount = 0;
  private lastRateWindowStart = Date.now();
  private currentRate = 0;

  constructor(private readonly opts: PollerOptions) {}

  start(): void {
    if (this.running) return;
    if (this.opts.pids.length === 0) {
      throw new Error('Poller: at least one PID must be selected');
    }
    this.running = true;

    this.flushTimer = setInterval(() => this.flush(), this.opts.flushIntervalMs ?? DEFAULT_FLUSH_MS);
    this.loopPromise = this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush(); // kalan tamponu at
  }

  /** Testler için: döngünün en az bir tur atmasını beklemek üzere. */
  waitForCurrentLoop(): Promise<void> {
    return this.loopPromise ?? Promise.resolve();
  }

  /** Gerçek zamanlı örnek/sn oranı (yaklaşık). */
  get sampleRate(): number {
    return this.currentRate;
  }

  /** PID -> son sorulma zamanı; yavaş kanalların zamanlaması buna dayanıyor. */
  private lastPolledMs: Record<string, number> = {};
  /** PID -> üst üste cevapsız kalma sayısı; geri çekilme buna dayanıyor. */
  private failures: Record<string, number> = {};

  private async loop(): Promise<void> {
    let cycleIndex = 0;
    while (this.running) {
      const cycle = buildPollSchedule(this.opts.pids, cycleIndex, {
        nowMs: Date.now(),
        lastPolledMs: this.lastPolledMs,
        failures: this.failures,
        slowIntervalMs: this.opts.slowIntervalMs,
      });
      cycleIndex++;

      // Hiçbir PID sıraya girmediyse (hepsi geri çekilmişse) boş dönüp
      // CPU yakmayalım.
      if (cycle.length === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        continue;
      }

      for (const pid of cycle) {
        if (!this.running) break;
        await this.pollOne(pid);
        // Her sorgudan sonra makro göreve dön (aşağıdaki nota bak).
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  private async pollOne(pid: PidDefinition): Promise<void> {
    this.lastPolledMs[pid.pid] = Date.now();
    try {
      const raw = await this.opts.queue.send(
        commandFor(pid),
        this.opts.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      const value = decode(pid, raw);
      if (value !== null) {
        this.buffer.push({ ts: Date.now() - this.startedAt, pid: pid.pid, value });
        this.recordSample();
        // Tek bir başarılı cevap cezayı siler: geçici bir aksaklık yüzünden
        // bir kanalı kalıcı olarak seyreltmek istemiyoruz.
        this.failures[pid.pid] = 0;
      } else {
        this.registerFailure(pid);
      }
    } catch {
      // Tek bir PID'in başarısız olması döngüyü durdurmaz — bir sonraki
      // PID'e geçilir. Kalıcı bağlantı hataları transport tarafından
      // ayrı olarak ele alınır (onStateChange).
      this.registerFailure(pid);
    }
  }

  /**
   * Cevapsız kalan PID'in sayacını artırır ve geri çekilme eşiği
   * geçildiğinde haber verir — kullanıcı neden bir kanalın seyreldiğini
   * debug log'unda görebilsin.
   */
  private registerFailure(pid: PidDefinition): void {
    const next = (this.failures[pid.pid] ?? 0) + 1;
    this.failures[pid.pid] = next;
    if (next === 2 || next === 4) this.opts.onBackoff?.(pid.pid, next);
  }
  // NOT: Her sorgudan sonra bilerek makro göreve dönülüyor (loop içinde).
  // Transport anında (senkron mikro görevle) cevap verirse — mock'ta olduğu
  // gibi — await zinciri event loop'un zamanlayıcı kuyruğunu (setInterval/
  // setTimeout) hiç işleyemeden CPU'yu sürekli meşgul eder; flush() ve
  // stop() hiç tetiklenemez.

  private recordSample(): void {
    const now = Date.now();
    if (now - this.lastRateWindowStart >= 1000) {
      this.currentRate = this.recentSampleCount;
      this.recentSampleCount = 0;
      this.lastRateWindowStart = now;
    }
    this.recentSampleCount++;
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    this.opts.onFlush(batch);
  }
}

function decode(pid: PidDefinition, raw: string): number | null {
  // Beklenen PID geçiliyor: geç gelen bir cevabın yanlış kanala yazılmasını
  // engelleyen tek şey bu (bkz. extractDataHex).
  const hex = extractDataHex(raw, pid.pid);
  if (!hex) return null;
  const bytes = hexToBytes(hex);
  if (bytes.length < pid.bytes) return null;
  return pid.decode(bytes);
}

export { getPidDefinition };
