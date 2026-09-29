/**
 * Tarama sonuçlarının filtresi — BEYAZ LİSTE.
 *
 * BLE taraması ortamdaki HER şeyi görüyor: telefonlar, televizyonlar,
 * kulaklıklar, komşu araçların cihazları. Eskiden kara liste vardı ve adı
 * olan her cihaz listeleniyordu. Bu App Review'da ret sebebi oldu: reviewer'ın
 * ortamındaki bir cihaz kendi marka adıyla listede göründü ve uygulama o
 * markanın donanımını kontrol ediyormuş gibi okundu (Guideline 5.2.1).
 *
 * Artık yalnızca OBD-II adaptörü olduğu anlaşılan cihazlar gösteriliyor.
 * Adaptörü olmayan birinin listesi BOŞ kalır — ekrana hiçbir üçüncü parti
 * cihaz adı düşmez.
 *
 * Bir cihaz iki yoldan tanınır:
 *  1. Adı bir OBD adaptörü gibi: "OBD" geçiyor, kendini ELM327 diye
 *     tanıtıyor ya da vLink/vLinker ailesinden.
 *  2. OBD'ye özgü bir BLE servisini duyuruyor.
 *
 * FFE0/FFF0 gibi GENEL seri port servisleri kasıtlı olarak yok: sayısız
 * alakasız cihaz (ucuz BLE modülleri, oyuncaklar, sensörler) aynı servisleri
 * kullanıyor. Onları kabul etmek kara listeye geri dönmek olurdu. Bu
 * servisleri kullanan bir adaptör adıyla tanınır.
 *
 * BEDELİ: adında bu kalıplardan hiçbiri geçmeyen VE yalnızca genel servisleri
 * kullanan bir adaptör listede görünmez. Böyle biri çıkarsa buraya adı ya da
 * servisi eklenir.
 */

/** Adında bunlardan biri geçen cihaz bir OBD adaptörüdür. */
const ADAPTER_NAME_PATTERNS: readonly RegExp[] = [
  /obd/i,
  // "Helmet" gibi isimler eşleşmesin diye yalnızca tam model adı.
  /elm\s?-?327/i,
  /v-?link/i,
];

/** Yalnızca OBD adaptörlerinin kullandığı servisler (küçük harf, tam UUID). */
const ADAPTER_SERVICES: readonly string[] = [
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '000018f0-0000-1000-8000-00805f9b34fb',
];

/** Cihaz listede gösterilsin mi. */
export function isScanResultVisible(device: {
  readonly name: string | null;
  readonly serviceUUIDs?: readonly string[];
}): boolean {
  const name = device.name?.trim() ?? '';
  if (name && ADAPTER_NAME_PATTERNS.some((p) => p.test(name))) return true;

  return (device.serviceUUIDs ?? []).some((uuid) =>
    ADAPTER_SERVICES.includes(uuid.toLowerCase()),
  );
}
