/**
 * Bilinen ELM327/iCar Pro GATT profilleri + generic keşif.
 *
 * Adaptörden adaptöre değişen tek şey UUID'ler değil, hangi karakteristiğin
 * notify hangisinin write olduğu da değişiyor. Bu yüzden burada iki kural var:
 *
 *   1. UUID'ler sabit yazılmaz — bilinen profiller denenir, tutmazsa
 *      property tabanlı generic keşfe düşülür.
 *   2. Bir profil "eşleşti" sayılmak için karakteristiğin sadece VAR olması
 *      yetmez, gerçekten o yeteneğe sahip olması gerekir (isNotifiable /
 *      isWritable*). Aksi hâlde yanlış profil eşleşir ve monitorCharacteristic
 *      çalışma anında patlar — 2026-09-03'te arabada tam olarak bu oldu.
 *
 * Eşleştirme mantığı (`matchProfiles`) BİLEREK saf tutuldu: react-native-ble-plx
 * tiplerine değil, düz veriye bakar. Böylece gerçek cihazların GATT düzeni
 * fixture olarak yazılıp cihazsız test edilebiliyor (tests/profiles.test.ts).
 */

import type { Device } from 'react-native-ble-plx';

export interface DiscoveredProfile {
  readonly serviceUUID: string;
  readonly notifyUUID: string;
  readonly writeUUID: string;
  /** Yazma karakteristiği "with response" destekliyor mu (yoksa "without response" kullanılır). */
  readonly writeWithResponse: boolean;
  /** Kullanıcıya gösterilecek, hangi yolla bulunduğunu açıklayan etiket. */
  readonly label: string;
}

/**
 * Cihazda bulunan tek bir servis/karakteristik çifti. Hem eşleştirme girdisi,
 * hem de otomatik eşleşme başarısız olduğunda debug ekranında listelenen ham
 * aday (kullanıcı elle notify + write seçebiliyor).
 */
export interface ProfileCandidate {
  readonly serviceUUID: string;
  readonly characteristicUUID: string;
  readonly isNotifiable: boolean;
  readonly isWritable: boolean;
  readonly isWritableWithResponse: boolean;
}

/**
 * Bilinen profiller — sırayla denenir, ilk sıradaki en güvenilir.
 *
 * DİKKAT: notify/write ataması cihazdan doğrulanmadan buraya eklenmemeli.
 * `18F0` girdisi ilk yazıldığında ters yazılmıştı (2af1 notify sanılmıştı);
 * gerçek Vgate ünitesinde 2af0 = notify, 2af1 = write.
 */
const KNOWN_PROFILES: readonly { service: string; notify: string; write: string; label: string }[] = [
  {
    // Vgate iCar Pro / "IOS-Vlink" — üreticinin kendi servisi.
    // Doğrulandı: 2026-09-03, MINI R50, cihaz adı "IOS-Vlink".
    service: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    notify: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
    write: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
    label: 'Vgate iCar Pro / Vlink (E7810A71)',
  },
  {
    service: '0000ffe0-0000-1000-8000-00805f9b34fb',
    notify: '0000ffe1-0000-1000-8000-00805f9b34fb',
    write: '0000ffe1-0000-1000-8000-00805f9b34fb',
    label: 'FFE0/FFE1 (older iCar Pro unit)',
  },
  {
    service: '0000fff0-0000-1000-8000-00805f9b34fb',
    notify: '0000fff1-0000-1000-8000-00805f9b34fb',
    write: '0000fff2-0000-1000-8000-00805f9b34fb',
    label: 'FFF0/FFF1+FFF2 (iCar Pro v3+)',
  },
  {
    service: '000018f0-0000-1000-8000-00805f9b34fb',
    notify: '00002af0-0000-1000-8000-00805f9b34fb',
    write: '00002af1-0000-1000-8000-00805f9b34fb',
    label: '18F0 (some clone adapters)',
  },
];

/**
 * Standart Bluetooth servisleri — hiçbiri seri port değildir, generic keşifte
 * atlanır. (1800 GAP, 1801 GATT, 180A Device Information, 180F Battery)
 */
const STANDARD_SERVICES: readonly string[] = [
  '00001800-0000-1000-8000-00805f9b34fb',
  '00001801-0000-1000-8000-00805f9b34fb',
  '0000180a-0000-1000-8000-00805f9b34fb',
  '0000180f-0000-1000-8000-00805f9b34fb',
];

/**
 * Adaylardan denenmeye değer profilleri, en güvenilirden başlayarak sıralar.
 *
 * Tek bir profil değil LİSTE döner: ilk profil çalışmazsa (notify aboneliği
 * reddedilir ya da adaptör cevap vermezse) çağıran sıradakini deneyebilsin
 * diye. Arabaya her gidiş pahalı — tek denemede pes etmemeli.
 */
export function matchProfiles(candidates: readonly ProfileCandidate[]): DiscoveredProfile[] {
  const results: DiscoveredProfile[] = [];
  const seen = new Set<string>();

  const add = (p: DiscoveredProfile): void => {
    const key = `${p.serviceUUID}|${p.notifyUUID}|${p.writeUUID}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(p);
  };

  // 1) Bilinen profiller — YETENEK doğrulamasıyla birlikte.
  for (const known of KNOWN_PROFILES) {
    const notifyChar = candidates.find(
      (c) =>
        c.serviceUUID === known.service &&
        c.characteristicUUID === known.notify &&
        c.isNotifiable,
    );
    const writeChar = candidates.find(
      (c) =>
        c.serviceUUID === known.service &&
        c.characteristicUUID === known.write &&
        c.isWritable,
    );
    if (notifyChar && writeChar) {
      add({
        serviceUUID: known.service,
        notifyUUID: known.notify,
        writeUUID: known.write,
        writeWithResponse: writeChar.isWritableWithResponse,
        label: known.label,
      });
    }
  }

  // 2) Generic keşif: aynı serviste hem notify hem write yeteneği olan her servis.
  const serviceUUIDs = [...new Set(candidates.map((c) => c.serviceUUID))];
  for (const serviceUUID of serviceUUIDs) {
    if (STANDARD_SERVICES.includes(serviceUUID)) continue;
    const inService = candidates.filter((c) => c.serviceUUID === serviceUUID);
    const notifyChar = inService.find((c) => c.isNotifiable);
    const writeChar = inService.find((c) => c.isWritable);
    if (notifyChar && writeChar) {
      add({
        serviceUUID,
        notifyUUID: notifyChar.characteristicUUID,
        writeUUID: writeChar.characteristicUUID,
        writeWithResponse: writeChar.isWritableWithResponse,
        label: `Auto-discovered (${serviceUUID.slice(0, 8)})`,
      });
    }
  }

  return results;
}

/**
 * Bağlı cihazda servis/karakteristik keşfi yapar ve denenmeye değer
 * profilleri sıralı olarak döner. Hiçbiri yoksa `profiles` boş döner —
 * UI ham `candidates` listesini "profil seç" ekranında gösterir, sessiz hata yok.
 */
export async function discoverProfiles(device: Device): Promise<{
  profiles: DiscoveredProfile[];
  candidates: readonly ProfileCandidate[];
}> {
  await device.discoverAllServicesAndCharacteristics();
  const services = await device.services();

  const candidates: ProfileCandidate[] = [];
  for (const service of services) {
    const chars = await service.characteristics();
    for (const c of chars) {
      candidates.push({
        serviceUUID: service.uuid.toLowerCase(),
        characteristicUUID: c.uuid.toLowerCase(),
        isNotifiable: c.isNotifiable,
        isWritable: c.isWritableWithResponse || c.isWritableWithoutResponse,
        isWritableWithResponse: c.isWritableWithResponse,
      });
    }
  }

  return { profiles: matchProfiles(candidates), candidates };
}
