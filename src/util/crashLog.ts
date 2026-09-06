/**
 * Yakalanmamış JS hatalarını KALICI olarak diske yazar.
 *
 * NEDEN VAR: 2026-09-06'da TestFlight'tan gelen çökme raporu
 * (EXC_CRASH/SIGABRT, `RCTExceptionsManager reportFatal` → `RCTFatal`)
 * çökmenin JS tarafında bir istisnadan geldiğini söylüyordu ama hatanın
 * METNİNİ içermiyordu — Apple'ın raporunda yalnızca yerel yığın var.
 * Metin olmadan sebep tahminden ibaret kalıyor.
 *
 * Bu modül RN'in global hata kancasına girip hatayı, yığını ve son
 * "breadcrumb" satırlarını uygulama sürecinden BAĞIMSIZ bir dosyaya
 * yazar. Yazma SENKRON (`File.write`) — çökmeden sonra async bir işin
 * tamamlanmasını beklemek mümkün değil, süreç birkaç ms içinde abort
 * ediyor.
 *
 * Kayıt Debug ekranında görünür ve paylaşılabilir; bir sonraki çökmede
 * "ne oldu?" sorusunun cevabı cihazda hazır olur.
 */

import { File, Paths } from 'expo-file-system';

const CRASH_FILE = 'last-crash.json';
const MAX_BREADCRUMBS = 40;

export interface CrashRecord {
  readonly at: number;
  readonly fatal: boolean;
  readonly message: string;
  readonly stack: string | null;
  readonly breadcrumbs: readonly string[];
}

const breadcrumbs: string[] = [];

/**
 * Çökme kaydına eklenecek tek satırlık iz. Ucuz olmalı: hiçbir I/O yok,
 * yalnızca bellekte halka tampon.
 */
export function breadcrumb(text: string): void {
  breadcrumbs.push(`${new Date().toISOString()} ${text}`);
  if (breadcrumbs.length > MAX_BREADCRUMBS) breadcrumbs.splice(0, breadcrumbs.length - MAX_BREADCRUMBS);
}

function crashFile(): File {
  return new File(Paths.document, CRASH_FILE);
}

/** Hatayı diske yazar. Kendi içinde hata verirse sessiz kalır. */
export function recordCrash(error: unknown, fatal: boolean): void {
  try {
    const record: CrashRecord = {
      at: Date.now(),
      fatal,
      message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      stack: error instanceof Error ? (error.stack ?? null) : null,
      breadcrumbs: [...breadcrumbs],
    };
    const file = crashFile();
    if (!file.exists) file.create({ intermediates: true, overwrite: true });
    file.write(JSON.stringify(record));
  } catch {
    // Çökme kaydını yazamamak çökmenin kendisini gizlememeli.
  }
}

/** Varsa son çökme kaydı. Bozuk dosya `null` döner (ve yolu tıkamaz). */
export function readLastCrash(): CrashRecord | null {
  try {
    const file = crashFile();
    if (!file.exists) return null;
    const parsed = JSON.parse(file.textSync()) as CrashRecord;
    return typeof parsed?.message === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function clearLastCrash(): void {
  try {
    const file = crashFile();
    if (file.exists) file.delete();
  } catch {
    /* yok sayılır */
  }
}

interface ErrorUtilsLike {
  getGlobalHandler?: () => (error: unknown, isFatal?: boolean) => void;
  setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
}

let installed = false;

/**
 * Global hata kancasını kurar. Yalnızca KAYDEDER — davranışı değiştirmez,
 * zincirdeki önceki kancayı da çağırır ki geliştirmede kırmızı ekran,
 * üretimde normal çökme davranışı aynen kalsın.
 */
export function installCrashLogger(): void {
  if (installed) return;
  installed = true;

  const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  const previous = errorUtils?.getGlobalHandler?.();
  errorUtils?.setGlobalHandler?.((error, isFatal) => {
    recordCrash(error, isFatal !== false);
    previous?.(error, isFatal);
  });
}
