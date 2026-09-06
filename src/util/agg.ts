/**
 * Büyük diziler için güvenli min/max.
 *
 * NEDEN AYRI BİR MODÜL: `Math.max(...dizi)` diziyi çağrı argümanına açar.
 * Hermes'te (ve JSC'de) argüman sayısının bir tavanı var; bu tavan aşılınca
 * çağrı `RangeError: Maximum call stack size exceeded` ile patlar. Tavan
 * on binler mertebesinde — yani günlük kullanımda hiç görünmez, uzun bir
 * kayıtta ise kaçınılmazdır.
 *
 * 2026-09-06'da TestFlight'ta bunun yakınından geçildi: 4473 saniyelik bir
 * oturum kaydedildi. Yalnızca ivmeölçer 10 Hz × 4 kanal = saniyede 40 örnek
 * üretir; o oturumda toplam örnek sayısı 180.000'i aşıyor. Oturum açılınca
 * `summarizeTrip` bütün kanalların zaman damgalarını tek dizide birleştirip
 * `Math.max(...allTs)` çağırıyordu — kayıt ne kadar uzunsa çökme o kadar
 * kesin. Uzunlukla ölçeklenen HİÇBİR dizi bir daha spread edilmemeli.
 */

/** Dizideki en büyük değer. Boş dizide `null`. NaN'lar atlanır. */
export function maxOf(values: readonly number[]): number | null {
  let out: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (out === null || v > out) out = v;
  }
  return out;
}

/** Dizideki en küçük değer. Boş dizide `null`. NaN'lar atlanır. */
export function minOf(values: readonly number[]): number | null {
  let out: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (out === null || v < out) out = v;
  }
  return out;
}

/** Tek geçişte hem min hem max — iki kez dolaşmaya gerek kalmasın diye. */
export function extentOf(values: readonly number[]): { min: number; max: number } | null {
  let min: number | null = null;
  let max: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (min === null || v < min) min = v;
    if (max === null || v > max) max = v;
  }
  return min === null || max === null ? null : { min, max };
}
