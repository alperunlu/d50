/**
 * SQLite açılışı ve şema migration'ı.
 *
 * expo-sqlite kullanır; bu dosya RN'e bağımlı olan tek db modülüdür,
 * repo.ts ve csv.ts saf mantık içerir ve ayrı test edilebilir olmalıdır.
 */

import * as SQLite from 'expo-sqlite';

const DB_NAME = 'obd_logger.db';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/**
 * Veritabanını açar (ilk çağrıda) ve şemayı kurar. Sonraki çağrılar aynı
 * açık bağlantıyı döner.
 */
export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = openAndMigrate();
  }
  return dbPromise;
}

async function openAndMigrate(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DB_NAME);

  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      note TEXT,
      pids TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS samples (
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL,
      pid TEXT NOT NULL,
      value REAL NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_samples_session_ts
      ON samples(session_id, ts);

    -- Oturum sırasındaki ham adaptör trafiği. Bellek içi halka tampon
    -- uygulama kapanınca kayboluyordu; arabadan dönüp "ne olmuştu?" diye
    -- bakabilmek için oturumla birlikte kalıcılaşıyor.
    CREATE TABLE IF NOT EXISTS session_logs (
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL,
      direction TEXT NOT NULL,
      text TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_logs_session_ts
      ON session_logs(session_id, ts);

    -- Kullanıcı ayarları (ör. takılı lastik ebadı). Anahtar/değer, çünkü
    -- ayarların sayısı ve şekli zamanla değişecek; her yeni ayar için
    -- migration yazmak istemiyoruz.
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  await migrateSupportedPids(db);

  return db;
}

/**
 * `sessions.supported_pids` sütunu — ECU'nun desteklediğini İDDİA ETTİĞİ
 * PID bitmask'i (0100/0120/0140), oturumla birlikte saklanıyor.
 *
 * Neden gerekiyor: bir oturum sonradan analiz edilirken "bu metrik neden
 * boş?" sorusunun iki farklı cevabı var — kanal seçilmemiş (kullanıcı
 * düzeltebilir) ya da araç o sensöre sahip değil (asla düzelmeyecek).
 * İkisini ayırmak ancak o oturumun aracının ne desteklediğini bilmekle
 * mümkün; bağlantı koptuktan sonra bu bilgi başka hiçbir yerde yok.
 *
 * SQLite'ta "ADD COLUMN IF NOT EXISTS" olmadığı için sütun varlığı
 * PRAGMA ile kontrol ediliyor. Eski oturumlar NULL kalır ve eskisi gibi
 * davranır — veri kaybı yok.
 */
async function migrateSupportedPids(db: SQLite.SQLiteDatabase): Promise<void> {
  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(sessions)');
  if (columns.some((c) => c.name === 'supported_pids')) return;
  await db.execAsync('ALTER TABLE sessions ADD COLUMN supported_pids TEXT');
}
