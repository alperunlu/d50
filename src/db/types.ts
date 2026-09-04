/** Repo ve csv katmanları arasında paylaşılan saf veri tipleri. */

export interface Session {
  readonly id: number;
  readonly startedAt: number; // epoch ms
  readonly endedAt: number | null;
  readonly note: string | null;
  /** Bu oturumda loglanan PID kodları (ör. ["0C", "0D", "05"]). */
  readonly pids: readonly string[];
}

export interface Sample {
  readonly sessionId: number;
  /** Oturum başından beri geçen ms. */
  readonly ts: number;
  readonly pid: string;
  readonly value: number;
}
