/**
 * SQLite üzerinde oturum/örnek CRUD işlemleri.
 *
 * Örnekler tek tek değil TOPLU (batch) yazılır — poller.ts saniyede bir
 * biriktirdiği örnekleri insertSamples() ile tek seferde gönderir. Örnek
 * başına ayrı INSERT iOS'ta hem yavaş hem gereksiz pil tüketir.
 */

import type { SQLiteDatabase } from 'expo-sqlite';
import { getDb } from './index';
import type { Sample, Session } from './types';

export async function startSession(pids: readonly string[]): Promise<Session> {
  const db = await getDb();
  const startedAt = Date.now();
  const result = await db.runAsync(
    'INSERT INTO sessions (started_at, ended_at, note, pids) VALUES (?, NULL, NULL, ?)',
    startedAt,
    JSON.stringify(pids),
  );
  return {
    id: result.lastInsertRowId,
    startedAt,
    endedAt: null,
    note: null,
    pids,
  };
}

export async function endSession(sessionId: number): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE sessions SET ended_at = ? WHERE id = ?', Date.now(), sessionId);
}

/** Bir örnek grubunu tek transaction içinde toplu yazar. */
export async function insertSamples(samples: readonly Sample[]): Promise<void> {
  if (samples.length === 0) return;
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
}

export async function listSessions(): Promise<Session[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: number;
    started_at: number;
    ended_at: number | null;
    note: string | null;
    pids: string;
  }>('SELECT id, started_at, ended_at, note, pids FROM sessions ORDER BY started_at DESC');

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
  }>('SELECT id, started_at, ended_at, note, pids FROM sessions WHERE id = ?', sessionId);
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
  const db = await getDb();
  // ON DELETE CASCADE ile samples de silinir (PRAGMA foreign_keys = ON).
  await db.runAsync('DELETE FROM sessions WHERE id = ?', sessionId);
}

function rowToSession(row: {
  id: number;
  started_at: number;
  ended_at: number | null;
  note: string | null;
  pids: string;
}): Session {
  return {
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    note: row.note,
    pids: JSON.parse(row.pids) as string[],
  };
}

/** Test/tip amaçlı re-export — repo dışında SQLiteDatabase tipine ihtiyaç duyan olmasın diye. */
export type { SQLiteDatabase };
