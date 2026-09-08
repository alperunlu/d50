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
   * Komut sonuna eklenecek "beklenen cevap sayısı" (ör. `010C1`).
   *
   * Adaptörün bunu desteklediği bağlantı başında sınanıyor
   * (`InitResult.supportsReplyCount`); desteklemiyorsa verilmiyor ve
   * komutlar eski biçiminde gidiyor.
   */
  readonly expectedReplies?: number;
  /** Araçta bulunmadığı anlaşılan bir PID çıkarıldığında haber verir. */
  readonly onBackoff?: (pid: string, failures: number) => void;
  /**
   * HİÇBİR PID bu kadar süredir cevap vermiyorsa çağrılır.
   *
   * Tek bir PID'in susması normaldir (araç o sensöre sahip olmayabilir);
   * HEPSİNİN birden susması başka bir şeydir. 7 Eylül 2026 saha testinde
   * ECU 563. saniyede sustu, 782 kez `NO DATA` döndü ve uygulama 12 dakika
   * boyunca hiçbir şey fark etmeden sormaya devam etti — üstelik geri
   * çekilme mantığı yüzünden gitgide daha seyrek. O sırada `ATRV` cevap
   * veriyordu, yani BLE ve adaptör sağlamdı; kopan şey ECU protokolüydü ve
   * çözümü yeniden başlatmaktı. Poller bunu kendi başına yapmıyor; haber
   * veriyor, kararı store veriyor.
   */
  readonly onSilence?: (seconds: number) => void;
  /** Sessizlik eşiği (ms). Varsayılan 10 sn. */
  readonly silenceTimeoutMs?: number;
  /**
   * Örnek zaman damgalarının sıfır noktası (epoch ms).
   *
   * Verilmezse poller'ın kendi başlangıcı kullanılır. Rehberli test
   * cycle'ında kanal seti adım adım değiştiği için poller kayıt ortasında
   * yeniden kuruluyor; zaman tabanı poller'ın içinde kalsaydı her yeniden
   * kurulumda `ts` sıfırlanır ve TEK bir oturumun zaman ekseni başa
   * sarardı — 0-100, ivme ve seri eşleştirmelerinin tamamı bozulurdu.
   * Oturumla birlikte bir kez üretilip her poller'a aynısı geçiliyor.
   * `SensorLogger` bunu zaten böyle alıyordu.
   */
  readonly startedAt?: number;
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
}

/**
 * Sıradaki PID: hedefine göre EN ÇOK GECİKMİŞ olan.
 *
 * NEDEN BÖYLE (7 Eylül 2026 saha kaydı): eskiden sabit bir ağırlık tablosu
 * ve tur sayacı vardı. Bus çöktüğünde her PID tek tek "cevap vermiyor"
 * damgası yedi ve 16 turda bire düşürüldü; bus düzeldikten SONRA da öyle
 * kaldı. Ölçülen sonuç: MAP 25 saniyede bir, soğutma suyu 150 saniyede bir.
 * Bir kanal sıranın dibine düştüğünde kendi başına çıkamıyordu.
 *
 * Gecikme oranı (`geçen süre / hedef aralık`) bunu yapısal olarak
 * imkânsız kılıyor: sorulmayan kanalın oranı sınırsız büyür, er geç
 * birinci olur. Bütçe yetmediğinde de herkes ORANTILI yavaşlar — biri
 * çökmez.
 *
 * Hiçbir kanal hedefine ulaşmamışsa (`ratio < 1`) yine de en gecikmiş olan
 * sorulur: hattı boş bekletmenin kimseye faydası yok.
 */
export function selectNextPid(
  pids: readonly PidDefinition[],
  state: PollScheduleState,
): PidDefinition | null {
  let best: PidDefinition | null = null;
  let bestRatio = -Infinity;

  for (const pid of pids) {
    // Hiç sorulmamış bir kanal her şeyin önüne geçer: ilk örneği almadan
    // o kanal hakkında hiçbir şey bilmiyoruz.
    const last = state.lastPolledMs[pid.pid];
    if (last === undefined) return pid;

    const ratio = (state.nowMs - last) / Math.max(1, pid.targetIntervalMs);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = pid;
    }
  }

  return best;
}

/**
 * Bir kanala "desteklenmiyor" damgası vurmak için bus'ın bu kadar yakın
 * zamanda BAŞKA bir kanala cevap vermiş olması gerekir.
 */
const BUS_ALIVE_WINDOW_MS = 5_000;
/** Çalışan bir bus'ta bu kadar üst üste susan kanal gerçekten yoktur. */
const UNSUPPORTED_AFTER_FAILURES = 3;

const DEFAULT_FLUSH_MS = 1000;
const DEFAULT_TIMEOUT_MS = 3000;
/** Yavaş kanalların hedef örnekleme aralığı. Soğutma suyu için fazlasıyla yeterli. */
const DEFAULT_SLOW_INTERVAL_MS = 10_000;
/** Bu kadar süre HİÇBİR PID cevap vermezse bağlantı kopmuş sayılır. */
const DEFAULT_SILENCE_MS = 10_000;

export class Poller {
  private running = false;
  private buffer: PollSample[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly startedAt: number;
  private loopPromise: Promise<void> | null = null;

  /** Son bir saniyede tamamlanan örnek sayısı — UI'da "~N örnek/sn" göstermek için. */
  private recentSampleCount = 0;
  private lastRateWindowStart = Date.now();
  private currentRate = 0;

  constructor(private readonly opts: PollerOptions) {
    this.startedAt = opts.startedAt ?? Date.now();
  }

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
  /**
   * Araçta bulunmadığı anlaşılan kanallar — SEYRELTİLMEZ, tamamen çıkarılır.
   *
   * Seyreltmek yanlış cevaptı: olmayan bir sensör 16 turda bir sorulunca da
   * yok, ve her sorgusu çalışan kanallardan çalınmış bir zaman dilimi.
   */
  private unsupported = new Set<string>();
  /** Son GEÇERLİ cevabın alındığı an. Sessizlik bunun üstünden ölçülüyor. */
  private lastAnswerAt = Date.now();
  /** Sessizlik bir kez bildirildi mi — her turda tekrar bildirmemek için. */
  private silenceReported = false;

  private async loop(): Promise<void> {
    while (this.running) {
      const pid = selectNextPid(
        this.opts.pids.filter((p) => !this.unsupported.has(p.pid)),
        { nowMs: Date.now(), lastPolledMs: this.lastPolledMs },
      );

      // Sorulacak kanal kalmadıysa (kanal seti boş) CPU yakmayalım.
      if (!pid) {
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        continue;
      }

      await this.pollOne(pid);
      this.checkSilence();
      // Her sorgudan sonra makro göreve dön (aşağıdaki nota bak).
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  /**
   * Bütün kanalların sustuğu durumu bildirir. Bir kez bildirir; kurtarma
   * denendikten sonra ilk geçerli cevap sayacı sıfırlar.
   */
  private checkSilence(): void {
    if (this.silenceReported) return;
    const silentMs = Date.now() - this.lastAnswerAt;
    if (silentMs < (this.opts.silenceTimeoutMs ?? DEFAULT_SILENCE_MS)) return;
    this.silenceReported = true;
    this.opts.onSilence?.(Math.round(silentMs / 1000));
  }

  /**
   * Kurtarma sonrası çağrılır: geri çekilme cezaları silinir.
   *
   * Sessizlik boyunca her PID defalarca cevapsız kaldı ve seyreltildi.
   * Protokol geri geldiğinde o cezalarla devam etmek, sağlam bir bağlantıyı
   * dakikalarca yavaş tutmak demek olurdu.
   */
  resetAfterRecovery(): void {
    this.failures = {};
    /**
     * Damgalar da siliniyor. Kurtarma öncesi "desteklenmiyor" kararı
     * sessiz bir bus üstünde verilmiş olabilir; protokol geri geldiğinde
     * kanala yeniden şans vermek, sağlam bir kanalı oturum boyunca kapalı
     * tutmaktan iyidir.
     */
    this.unsupported.clear();
    this.lastAnswerAt = Date.now();
    this.silenceReported = false;
  }

  private async pollOne(pid: PidDefinition): Promise<void> {
    this.lastPolledMs[pid.pid] = Date.now();
    try {
      const raw = await this.opts.queue.send(
        commandFor(pid, this.opts.expectedReplies),
        this.opts.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      const value = decode(pid, raw);
      if (value !== null) {
        this.buffer.push({ ts: Date.now() - this.startedAt, pid: pid.pid, value });
        this.recordSample();
        // Tek bir başarılı cevap cezayı siler: geçici bir aksaklık yüzünden
        // bir kanalı kalıcı olarak seyreltmek istemiyoruz.
        this.failures[pid.pid] = 0;
        this.lastAnswerAt = Date.now();
        this.silenceReported = false;
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
   * Cevapsız kalan PID'i kaydeder.
   *
   * KRİTİK AYRIM (7 Eylül 2026): "bu kanal desteklenmiyor" ile "bus çökmüş"
   * aynı şey değil, ve eskiden ayırt edilmiyorlardı. Bağlantı koptuğunda
   * her PID sırayla cevapsız kaldı, her biri ayrı ayrı damgalandı ve
   * seyreltildi — geçici bir arıza kalıcı bir bozulmaya dönüştü.
   *
   * Artık bir kanala kusur yazmanın şartı, BAŞKA bir kanalın yakın zamanda
   * cevap vermiş olması: bus çalışıyor ama bu kanal susuyorsa kanal
   * gerçekten yok demektir. Bus tümden sessizse kimse suçlanmaz; o durumu
   * `checkSilence` zaten ayrıca bildiriyor ve kurtarma çalışıyor.
   */
  private registerFailure(pid: PidDefinition): void {
    const busAlive = Date.now() - this.lastAnswerAt < BUS_ALIVE_WINDOW_MS;
    if (!busAlive) return;

    const next = (this.failures[pid.pid] ?? 0) + 1;
    this.failures[pid.pid] = next;
    if (next === UNSUPPORTED_AFTER_FAILURES) {
      this.unsupported.add(pid.pid);
      this.opts.onBackoff?.(pid.pid, next);
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
  // Beklenen PID geçiliyor: geç gelen bir cevabın yanlış kanala yazılmasını
  // engelleyen tek şey bu (bkz. extractDataHex).
  const hex = extractDataHex(raw, pid.pid);
  if (!hex) return null;
  const bytes = hexToBytes(hex);
  if (bytes.length < pid.bytes) return null;
  return pid.decode(bytes);
}

export { getPidDefinition };
