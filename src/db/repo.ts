/**
 * SQLite üzerinde oturum/örnek CRUD işlemleri.
 *
 * Örnekler tek tek değil TOPLU (batch) yazılır — poller.ts saniyede bir
 * biriktirdiği örnekleri insertSamples() ile tek seferde gönderir. Örnek
 * başına ayrı INSERT iOS'ta hem yavaş hem gereksiz pil tüketir.
 */

import type { SQLiteDatabase } from 'expo-sqlite';
import { getDb } from './index';
import type { Sample, Session, SupportedPidMap } from './types';

/**
 * TÜM yazma işlemleri tek bir zincirden geçer.
 *
 * 2026-09-05 araç testinde saniyede iki kez "cannot start a transaction within
 * a transaction" alındı ve o oturumda DİSKE HİÇBİR ÖRNEK YAZILMADI. Sebep:
 * üç bağımsız yazıcı (OBD poller flush'ı, sensör logger flush'ı, oturum log
 * flush'ı) aynı SQLite bağlantısında eşzamanlı `withTransactionAsync`
 * çağırıyordu; expo-sqlite tek bağlantıda iç içe transaction'a izin vermiyor.
 *
 * Kilit yerine kuyruk: her yazma bir öncekinin bitmesini bekler. Yazma
 * hacmimiz saniyede birkaç toplu insert olduğu için sıraya almanın maliyeti
 * yok, kazancı ise çakışmanın yapısal olarak imkânsız hâle gelmesi.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(work, work);
  // Zincir bir hatayla kopmamalı; hata çağırana iletilir ama kuyruk devam eder.
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Oturumu açar. `supportedPids` verilirse ECU'nun destek bitmask'i de
 * saklanır; sonraki analizlerde "kanal seçilmemiş" ile "araçta o sensör
 * yok" ayrımı buna dayanıyor.
 */
export async function startSession(
  pids: readonly string[],
  supportedPids?: SupportedPidMap | null,
): Promise<Session> {
  return serialize(async () => {
  const db = await getDb();
  const startedAt = Date.now();
  const result = await db.runAsync(
    'INSERT INTO sessions (started_at, ended_at, note, pids, supported_pids) VALUES (?, NULL, NULL, ?, ?)',
    startedAt,
    JSON.stringify(pids),
    supportedPids ? JSON.stringify(supportedPids) : null,
  );
  return {
    id: result.lastInsertRowId,
    startedAt,
    endedAt: null,
    note: null,
    pids,
    supportedPids: supportedPids ?? null,
  };
  });
}

export async function endSession(sessionId: number): Promise<void> {
  return serialize(async () => {
    const db = await getDb();
    await db.runAsync('UPDATE sessions SET ended_at = ? WHERE id = ?', Date.now(), sessionId);
  });
}

/** Bir örnek grubunu tek transaction içinde toplu yazar. */
export async function insertSamples(samples: readonly Sample[]): Promise<void> {
  if (samples.length === 0) return;
  return serialize(async () => {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const s of samples) {
        await db.runAsync(
          'INSERT INTO samples (session_id, ts, pid, value) VALUES (?, ?, ?, ?)',
          s.sessionId,
          s.ts,
          s.pid,
          s.value,
        );
      }
    });
  });
}

export async function listSessions(): Promise<Session[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: number;
    started_at: number;
    ended_at: number | null;
    note: string | null;
    pids: string;
    supported_pids: string | null;
  }>(
    'SELECT id, started_at, ended_at, note, pids, supported_pids FROM sessions ORDER BY started_at DESC',
  );

  return rows.map(rowToSession);
}

export async function getSession(sessionId: number): Promise<Session | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{
    id: number;
    started_at: number;
    ended_at: number | null;
    note: string | null;
    pids: string;
    supported_pids: string | null;
  }>(
    'SELECT id, started_at, ended_at, note, pids, supported_pids FROM sessions WHERE id = ?',
    sessionId,
  );
  return row ? rowToSession(row) : null;
}

export async function readSamples(sessionId: number): Promise<Sample[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    session_id: number;
    ts: number;
    pid: string;
    value: number;
  }>('SELECT session_id, ts, pid, value FROM samples WHERE session_id = ? ORDER BY ts ASC', sessionId);

  return rows.map((r) => ({ sessionId: r.session_id, ts: r.ts, pid: r.pid, value: r.value }));
}

/** Oturuma ait ham log satırlarını toplu yazar. */
export async function insertSessionLogs(
  sessionId: number,
  entries: readonly { ts: number; direction: string; text: string }[],
): Promise<void> {
  if (entries.length === 0) return;
  return serialize(async () => {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const e of entries) {
        await db.runAsync(
          'INSERT INTO session_logs (session_id, ts, direction, text) VALUES (?, ?, ?, ?)',
          sessionId,
          e.ts,
          e.direction,
          e.text,
        );
      }
    });
  });
}

export async function readSessionLogs(
  sessionId: number,
): Promise<{ ts: number; direction: string; text: string }[]> {
  const db = await getDb();
  return db.getAllAsync<{ ts: number; direction: string; text: string }>(
    'SELECT ts, direction, text FROM session_logs WHERE session_id = ? ORDER BY ts ASC',
    sessionId,
  );
}

export async function countSessionLogs(sessionId: number): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) AS n FROM session_logs WHERE session_id = ?',
    sessionId,
  );
  return row?.n ?? 0;
}

export async function deleteSession(sessionId: number): Promise<void> {
  return serialize(async () => {
    const db = await getDb();
    // ON DELETE CASCADE ile samples de silinir (PRAGMA foreign_keys = ON).
    await db.runAsync('DELETE FROM sessions WHERE id = ?', sessionId);
  });
}

/** Ayar okur. Yoksa null. */
export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    key,
  );
  return row?.value ?? null;
}

/** Ayar yazar (upsert). Diğer yazımlarla aynı kuyruktan geçer. */
export async function setSetting(key: string, value: string): Promise<void> {
  return serialize(async () => {
    const db = await getDb();
    await db.runAsync(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  });
}

function rowToSession(row: {
  id: number;
  started_at: number;
  ended_at: number | null;
  note: string | null;
  pids: string;
  supported_pids?: string | null;
}): Session {
  return {
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    note: row.note,
    pids: JSON.parse(row.pids) as string[],
    // Bozuk/eksik JSON oturumu okunamaz yapmamalı; en kötü ihtimalle
    // maskeyi bilmeden eski davranışa düşeriz.
    supportedPids: parseMask(row.supported_pids),
  };
}

function parseMask(raw: string | null | undefined): SupportedPidMap | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SupportedPidMap;
  } catch {
    return null;
  }
}

/** Test/tip amaçlı re-export — repo dışında SQLiteDatabase tipine ihtiyaç duyan olmasın diye. */
export type { SQLiteDatabase };

/**
 * Cycle adım sınırlarını ve çıkarılan vitals'ı yazar.
 *
 * İkisi tek bir çağrıda çünkü ayrı düşmeleri anlamsız: adım sınırları
 * olmadan vitals'ın hangi koşulda ölçüldüğü bilinmez, vitals olmadan
 * sınırlar tek başına bir işe yaramaz.
 */
export async function saveCycleResult(
  sessionId: number,
  windows: readonly { stepId: string; fromMs: number; toMs: number; skipped: boolean }[],
  vitals: readonly { key: string; value: number; unit: string }[],
  context: string | null,
): Promise<void> {
  return serialize(async () => {
    const db = await getDb();
    const recordedAt = Date.now();
    await db.withTransactionAsync(async () => {
      for (const w of windows) {
        await db.runAsync(
          'INSERT INTO cycle_steps (session_id, step_id, from_ms, to_ms, skipped) VALUES (?, ?, ?, ?, ?)',
          sessionId, w.stepId, w.fromMs, w.toMs, w.skipped ? 1 : 0,
        );
      }
      for (const v of vitals) {
        await db.runAsync(
          'INSERT INTO cycle_vitals (session_id, key, value, unit, recorded_at, context) VALUES (?, ?, ?, ?, ?, ?)',
          sessionId, v.key, v.value, v.unit, recordedAt, context,
        );
      }
    });
  });
}

/** Bir vital'in bütün geçmişi, eskiden yeniye. Trend bunun üstüne kuruluyor. */
export async function readVitalHistory(
  key: string,
): Promise<{ at: number; value: number; sessionId: number }[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ recorded_at: number; value: number; session_id: number }>(
    'SELECT recorded_at, value, session_id FROM cycle_vitals WHERE key = ? ORDER BY recorded_at ASC',
    key,
  );
  return rows.map((r) => ({ at: r.recorded_at, value: r.value, sessionId: r.session_id }));
}

/** Bir oturumun vitals'ı — raporda o cycle'ın kendi tablosu için. */
export async function readSessionVitals(
  sessionId: number,
): Promise<{ key: string; value: number; unit: string }[]> {
  const db = await getDb();
  return db.getAllAsync<{ key: string; value: number; unit: string }>(
    'SELECT key, value, unit FROM cycle_vitals WHERE session_id = ?',
    sessionId,
  );
}

/** Bir oturumda atlanan cycle adımlarının id'leri. */
export async function readSkippedSteps(sessionId: number): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ step_id: string }>(
    'SELECT step_id FROM cycle_steps WHERE session_id = ? AND skipped = 1',
    sessionId,
  );
  return rows.map((r) => r.step_id);
}
