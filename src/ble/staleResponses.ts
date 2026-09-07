/**
 * Zaman aşımına uğramış komutların GEÇ GELEN cevaplarını ayıklar.
 *
 * NEDEN AYRI BİR DOSYA: burası bu projenin en pahalıya mal olmuş
 * hatasının bulunduğu yer, ve `BleTransport`'un içinde kaldığı sürece
 * cihazsız test edilemiyordu. Test edilemeyen bir kural, er geç yeniden
 * bozulan bir kuraldır.
 *
 * ARIZA (7 Eylül 2026 saha kaydı): `send()` zaman aşımında yalnızca
 * bekleyen isteği düşürüyordu. Adaptörün geç gelen cevabı, o sırada
 * bekleyen BİR SONRAKİ komutu çözüyordu. Bir kez kaydığında hiç
 * toparlanmıyordu, çünkü her cevap bir öncekinin sorusuna gidiyordu:
 *
 *     [tx] ATZ
 *     [rx] 010D⏎ATZ⏎⏎⏎ELM327 v2.3
 *     [tx] 010B  → zaman aşımı
 *     [tx] ATE0
 *     [rx] 010B⏎SEARCHING...⏎STOPPED     ← 010B'nin cevabı, ATE0'a yazıldı
 *     ...
 *     [info] Protocol re-established: 010BSEARCHING...STOPPED, 0111SEARCH...
 *
 * Son satır uygulamanın kendi çöpünü protokol numarası sanıp "kurtarma
 * başarılı" demesi. Bir ölçüm aletinde yanlış veri, veri yokluğundan
 * tehlikelidir.
 *
 * NEDEN SAYAÇ DEĞİL DE ZAMAN: sayaç, adaptör gerçekten ölmüşse geri
 * sayılamaz — beklenen cevaplar hiç gelmez, sayaç sıfırlanmaz ve
 * sonrasındaki her SAĞLAM cevap düşürülür. Bu, kendini besleyen bir kısır
 * döngü olurdu. Zaman penceresi kendi kendini iyileştirir: kimse gelmezse
 * kayıt unutulur ve normal işleyiş döner.
 */
export class StaleResponseGuard {
  private deadlines: number[] = [];

  /**
   * @param windowMs Geç cevabın bu süre içinde gelmesi beklenir. Sahada
   *   geç cevaplar 200-600 ms içinde geldi; 4 saniye rahat bir üst sınır.
   */
  constructor(private readonly windowMs = 4000) {}

  /** Bir komut zaman aşımına uğradı: cevabı hâlâ gelebilir. */
  recordTimeout(nowMs: number): void {
    this.deadlines.push(nowMs);
  }

  /**
   * Gelen çerçeve, zaman aşımına uğramış bir komuda mı ait?
   *
   * `true` dönerse çağıran çerçeveyi ATMALI, hiçbir isteği çözmemelidir.
   */
  shouldDrop(nowMs: number): boolean {
    const cutoff = nowMs - this.windowMs;
    while (this.deadlines.length > 0 && this.deadlines[0] < cutoff) {
      this.deadlines.shift();
    }
    return this.deadlines.shift() !== undefined;
  }

  /** Yeni bağlantı temiz sayfa: eski bağlantının borçları taşınmaz. */
  reset(): void {
    this.deadlines = [];
  }

  /** Bekleyen geç cevap sayısı — yalnızca teşhis ve test için. */
  get pending(): number {
    return this.deadlines.length;
  }
}
