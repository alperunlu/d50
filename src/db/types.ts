/** Repo ve csv katmanları arasında paylaşılan saf veri tipleri. */

export interface Session {
  readonly id: number;
  readonly startedAt: number; // epoch ms
  readonly endedAt: number | null;
  readonly note: string | null;
  /** Bu oturumda loglanan PID kodları (ör. ["0C", "0D", "05"]). */
  readonly pids: readonly string[];
  /**
   * ECU'nun desteklediğini iddia ettiği PID bitmask'i (0100/0120/0140).
   * Eski oturumlarda ve bağlantısız kayıtlarda null.
   */
  readonly supportedPids: SupportedPidMap | null;
  /**
   * Bu oturumun alındığı aracın VIN'i. `null` = bilinmiyor: VIN okuması
   * eklenmeden önceki oturumlar ve Mode 09'u desteklemeyen ECU'lar.
   * "Başka araç" anlamına GELMEZ.
   */
  readonly vin: string | null;
}

/** `0100`/`0120`/`0140` cevaplarındaki destek bitmask'leri. */
export interface SupportedPidMap {
  readonly block00?: string;
  readonly block20?: string;
  readonly block40?: string;
}

export interface Sample {
  readonly sessionId: number;
  /** Oturum başından beri geçen ms. */
  readonly ts: number;
  readonly pid: string;
  readonly value: number;
}
