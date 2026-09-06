/**
 * Tarama sonuçlarının gürültü filtresi.
 *
 * BLE taraması ortamdaki HER şeyi görüyor: telefonlar, televizyonlar, beyaz
 * eşya, kulaklıklar. Aranan tek şey OBD adaptörü olduğu için liste ne kadar
 * uzarsa doğru cihazı bulmak o kadar zorlaşıyor — özellikle araç içinde,
 * park hâlinde, komşu araçların cihazları da görünürken.
 *
 * Kural basit: OBD adaptörleri KENDİLERİNİ TANITIR. Vgate iCar Pro
 * "IOS-Vlink" diye, ELM klonları "OBDII" ya da "V-LINK" diye yayın yapar.
 * İsimsiz bir cihaz ya da adı "Samsung" olan bir şey aradığımız cihaz
 * değildir.
 *
 * BEDELİ: İsmini yayınlamayan bir adaptör bu filtreye takılır ve listede
 * görünmez. Böyle bir adaptörle karşılaşılırsa filtre gevşetilmeli — bu
 * yüzden dosya ayrı ve tek bir listeye bakıyor, koda gömülü değil.
 */

/**
 * Adında bunlardan biri geçen cihaz listelenmiyor. Küçük harfle yazılır,
 * karşılaştırma büyük/küçük harf duyarsızdır.
 */
export const SCAN_NAME_BLOCKLIST: readonly string[] = ['samsung', 'fridge'];

/**
 * Cihaz listede gösterilsin mi.
 *
 * İsimsiz cihazlar elenir: ekranda "Unnamed device" diye görünüyorlardı ve
 * hiçbir zaman aranan şey olmadılar.
 */
export function isScanResultVisible(device: { readonly name: string | null }): boolean {
  const name = device.name?.trim();
  if (!name) return false;

  const lower = name.toLowerCase();
  return !SCAN_NAME_BLOCKLIST.some((blocked) => lower.includes(blocked));
}
