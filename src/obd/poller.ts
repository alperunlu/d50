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
   * `slow` işaretli PID'ler kaç turda bir sorulsun. Varsayılan 8.
   * Bkz. `buildPollSchedule` — kıt bus kapasitesini hızlı değişen
   * değerlere ayırmanın yolu bu.
   */
  readonly slowEveryNCycles?: number;
}

/**
 * Bir "tur"da hangi PID'lerin sorulacağını belirler.
 *
 * Her tur TÜM hızlı PID'leri içerir; yavaş PID'lerden ise turda en fazla
 * bir tane, sırayla (round-robin) eklenir ve yalnızca her `slowEveryN`
 * turda bir. Böylece 6 PID'lik bir seçimde RPM saniyede ~1.5 kez okunurken
 * soğutma suyu birkaç saniyede bir okunur — ikisi de ihtiyaca yeter.
 *
 * Saf fonksiyon: cihazsız test edilebilir.
 */
export function buildPollSchedule(
  pids: readonly PidDefinition[],
  cycleIndex: number,
  slowEveryN = DEFAULT_SLOW_EVERY_N,
): PidDefinition[] {
  const fast = pids.filter((p) => p.refresh !== 'slow');
  const slow = pids.filter((p) => p.refresh === 'slow');

  // Hiç hızlı PID seçilmemişse yavaşları kısmak anlamsız — hepsi her turda.
  if (fast.length === 0) return [...slow];

  const cycle = [...fast];
  if (slow.length > 0 && cycleIndex % slowEveryN === 0) {
    const slowIndex = Math.floor(cycleIndex / slowEveryN) % slow.length;
    cycle.push(slow[slowIndex]);
  }
  return cycle;
}

const DEFAULT_FLUSH_MS = 1000;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_SLOW_EVERY_N = 8;

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

  private async loop(): Promise<void> {
    let cycleIndex = 0;
    while (this.running) {
      const cycle = buildPollSchedule(
        this.opts.pids,
        cycleIndex,
        this.opts.slowEveryNCycles ?? DEFAULT_SLOW_EVERY_N,
      );
      cycleIndex++;

      for (const pid of cycle) {
        if (!this.running) break;
        await this.pollOne(pid);
        // Her sorgudan sonra makro göreve dön (aşağıdaki nota bak).
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  private async pollOne(pid: PidDefinition): Promise<void> {
      try {
        const raw = await this.opts.queue.send(
          commandFor(pid),
          this.opts.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
        const value = decode(pid, raw);
        if (value !== null) {
          this.buffer.push({ ts: Date.now() - this.startedAt, pid: pid.pid, value });
          this.recordSample();
        }
      } catch {
        // Tek bir PID'in başarısız olması döngüyü durdurmaz — bir sonraki
        // PID'e geçilir. Kalıcı bağlantı hataları transport tarafından
        // ayrı olarak ele alınır (onStateChange).
      }
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
  const hex = extractDataHex(raw);
  if (!hex) return null;
  const bytes = hexToBytes(hex);
  if (bytes.length < pid.bytes) return null;
  return pid.decode(bytes);
}

export { getPidDefinition };
