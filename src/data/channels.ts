/**
 * Kanal soyutlaması — loglanabilir her veri serisinin ortak tanımı.
 *
 * OBD PID'leri, telefon sensörleri ve türetilmiş metrikler AYNI `samples`
 * tablosuna yazılır; `Sample.pid` alanı burada tanımlanan `key`'i taşır.
 * Böylece grafik, CSV export, oturum yönetimi ve silme mantığının hiçbiri
 * verinin nereden geldiğini bilmek zorunda kalmıyor — yeni bir sensör
 * eklemek yalnızca yeni bir kanal tanımlamak demek.
 *
 * Ayrı bir tablo açmak her katmanı ikiye bölerdi; bu tasarım bilinçli.
 */

import { PIDS, type PidDefinition, type RefreshClass } from '../obd/pids';

export type ChannelSource = 'obd' | 'gps' | 'motion' | 'mic' | 'derived';

export interface Channel {
  /** `Sample.pid` alanına yazılan benzersiz anahtar. */
  readonly key: string;
  readonly name: string;
  /** Izgara hücresi için kısa etiket. */
  readonly short: string;
  readonly unit: string;
  /** CSV sütun adı (ASCII, boşluksuz). */
  readonly csvKey: string;
  /** Poller/CSV önceliği — yavaş kanallar CSV'de forward-fill edilir. */
  readonly refresh: RefreshClass;
  readonly source: ChannelSource;
}

/** OBD PID tanımını kanala çevirir. */
export function channelForPid(pid: PidDefinition): Channel {
  return {
    key: pid.pid,
    name: pid.name,
    short: pid.short,
    unit: pid.unit,
    csvKey: pid.csvKey,
    refresh: pid.refresh,
    source: 'obd',
  };
}

/**
 * Telefon sensörü kanalları.
 *
 * GPS hızı bilerek ayrı bir kanal: OBD hızıyla karşılaştırmak lastik/jant
 * değişimi sonrası kilometre saati sapmasını ortaya çıkarır ve 0-100
 * ölçümünde GPS daha güvenilir referanstır (mutlak, kalibrasyona bağlı değil).
 */
export const SENSOR_CHANNELS: readonly Channel[] = [
  {
    key: 'gps_speed',
    name: 'GPS Speed',
    short: 'GPS speed',
    unit: 'km/h',
    csvKey: 'gps_speed_kmh',
    refresh: 'fast',
    source: 'gps',
  },
  {
    key: 'gps_altitude',
    name: 'Altitude',
    short: 'Altitude',
    unit: 'm',
    csvKey: 'gps_altitude_m',
    refresh: 'slow',
    source: 'gps',
  },
  {
    key: 'gps_accuracy',
    name: 'GPS Accuracy',
    short: 'GPS acc.',
    unit: 'm',
    csvKey: 'gps_accuracy_m',
    refresh: 'slow',
    source: 'gps',
  },
  {
    key: 'gps_heading',
    name: 'Heading',
    short: 'Heading',
    unit: '°',
    csvKey: 'gps_heading_deg',
    refresh: 'slow',
    source: 'gps',
  },
  {
    key: 'accel_magnitude',
    name: 'Acceleration (total)',
    short: 'Accel',
    unit: 'g',
    csvKey: 'accel_g',
    refresh: 'fast',
    source: 'motion',
  },
  {
    key: 'accel_x',
    name: 'Acceleration X (device)',
    short: 'Accel X',
    unit: 'g',
    csvKey: 'accel_x_g',
    refresh: 'fast',
    source: 'motion',
  },
  {
    key: 'accel_y',
    name: 'Acceleration Y (device)',
    short: 'Accel Y',
    unit: 'g',
    csvKey: 'accel_y_g',
    refresh: 'fast',
    source: 'motion',
  },
  {
    key: 'accel_z',
    name: 'Acceleration Z (device)',
    short: 'Accel Z',
    unit: 'g',
    csvKey: 'accel_z_g',
    refresh: 'fast',
    source: 'motion',
  },
  /**
   * Gürültü seviyesi — dB(A) SPL, yani bir desibelmetrenin gösterdiği
   * büyüklük (A-ağırlıklı ses basıncı seviyesi).
   *
   * Ham dBFS yerine bunu saklıyoruz çünkü kullanıcı için anlamlı olan bu:
   * "kabinde 72 dB" cümlesi kurulabiliyor. Mutlak doğruluk mikrofon
   * kalibrasyonuna bağlı (bkz. analysis/spl.ts); kalibrasyon ayarlanabilir.
   */
  {
    key: 'mic_db',
    name: 'Noise Level',
    short: 'Noise',
    unit: 'dB(A)',
    csvKey: 'noise_dba',
    refresh: 'fast',
    source: 'mic',
  },
  /**
   * Order takibi çıktıları (bkz. analysis/orderTracking.ts).
   *
   * Hepsi ORAN: mutlak genlik iOS'un otomatik kazancıyla kayar, order'lar
   * arası oran kaymaz. Bu yüzden birim yok.
   */
  {
    key: 'order_half_ratio',
    name: 'Half-order ratio',
    short: '½ order',
    unit: '',
    csvKey: 'order_half_ratio',
    refresh: 'fast',
    source: 'mic',
  },
  {
    key: 'order_1_ratio',
    name: 'First-order ratio',
    short: '1st order',
    unit: '',
    csvKey: 'order_1_ratio',
    refresh: 'fast',
    source: 'mic',
  },
  {
    key: 'audio_rpm',
    name: 'RPM from sound',
    short: 'Audio rpm',
    unit: 'rpm',
    csvKey: 'audio_rpm',
    refresh: 'fast',
    source: 'mic',
  },
];

/**
 * Telefon sensörü kanallarını süren DONANIM grupları.
 *
 * Grup, izin ve donanım açma/kapama birimidir — tek bir GPS güncellemesi
 * hız, rakım ve yönü birlikte getirir, ayrı ayrı kapatılamaz.
 *
 * AMA KULLANICI GRUP SEÇMİYOR. Kullanıcı hangi KANALI kaydedeceğini/
 * göreceğini seçiyor; gereken donanım ondan türetiliyor. Aradaki fark
 * pratikte şu: desibelmetreyi açmak isteyen birinin ekranına tekleme
 * order'ları da gelmemeli, GPS hızı isteyen birine rakım kartı
 * açılmamalı. Donanımın nasıl gruplandığı kullanıcının sorunu değil.
 */
export type SensorGroupKey = 'gps' | 'motion' | 'mic';

/** Her sensör kanalının hangi donanımı gerektirdiği. */
const CHANNEL_GROUP: Readonly<Record<string, SensorGroupKey>> = {
  gps_speed: 'gps',
  gps_altitude: 'gps',
  gps_accuracy: 'gps',
  gps_heading: 'gps',
  accel_magnitude: 'motion',
  accel_x: 'motion',
  accel_y: 'motion',
  accel_z: 'motion',
  mic_db: 'mic',
  order_half_ratio: 'mic',
  order_1_ratio: 'mic',
  audio_rpm: 'mic',
};

/** Seçim ekranında gösterilen sensör kanalları, kaynak donanımıyla. */
export interface SelectableSensorChannel {
  readonly key: string;
  readonly name: string;
  readonly detail: string;
  readonly group: SensorGroupKey;
}

/**
 * Seçilebilir kanallar.
 *
 * Ham ivmeölçer eksenleri (accel_x/y/z) listede YOK: tek başlarına
 * okunabilir bir kart üretmiyorlar (telefonun kendi eksenlerindeler,
 * aracın değil) ve toplam büyüklük seçildiğinde zaten CSV'ye yazılıyorlar.
 * Listeyi kullanılabilir tutmak için gizli tutuldular.
 */
export const SELECTABLE_SENSOR_CHANNELS: readonly SelectableSensorChannel[] = [
  { key: 'mic_db', name: 'Noise Level', detail: 'dB(A) sound meter', group: 'mic' },
  { key: 'gps_speed', name: 'GPS Speed', detail: 'independent of the ECU speedo', group: 'gps' },
  { key: 'accel_magnitude', name: 'Acceleration', detail: 'total g from the phone', group: 'motion' },
  { key: 'gps_altitude', name: 'Altitude', detail: 'used for grade and vacuum', group: 'gps' },
  { key: 'gps_heading', name: 'Heading', detail: 'direction of travel', group: 'gps' },
  {
    key: 'order_half_ratio',
    name: 'Cylinder balance',
    detail: 'half-order ratio — misfire signature',
    group: 'mic',
  },
  {
    key: 'order_1_ratio',
    name: 'Rotational balance',
    detail: 'first-order ratio',
    group: 'mic',
  },
  { key: 'audio_rpm', name: 'RPM from sound', detail: 'cross-check for order tracking', group: 'mic' },
];

/** Seçili kanalların çalıştırılmasını gerektirdiği donanım grupları. */
export function sensorGroupsForChannels(keys: readonly string[]): SensorGroupKey[] {
  const groups = new Set<SensorGroupKey>();
  for (const key of keys) {
    const group = CHANNEL_GROUP[key];
    if (group) groups.add(group);
  }
  return [...groups];
}

/**
 * Bir kanal seçildiğinde oturuma yazılan anahtarlar.
 *
 * İvmeölçer seçilirse ham eksenler de kaydediliyor: CSV'de sonradan
 * analiz için değerliler ve zaten sensör açık olduğu için ek maliyetleri yok.
 * Ekranda kart olarak görünmüyorlar.
 */
export function recordedKeysForSensorChannels(keys: readonly string[]): string[] {
  const out = new Set<string>(keys);
  if (keys.includes('accel_magnitude')) {
    out.add('accel_x');
    out.add('accel_y');
    out.add('accel_z');
  }
  if (keys.some((k) => CHANNEL_GROUP[k] === 'gps')) out.add('gps_accuracy');
  return [...out];
}

const ALL_CHANNELS: readonly Channel[] = [...PIDS.map(channelForPid), ...SENSOR_CHANNELS];

const BY_KEY = new Map(ALL_CHANNELS.map((c) => [c.key, c]));

export function getChannel(key: string): Channel | undefined {
  return BY_KEY.get(key) ?? BY_KEY.get(key.toUpperCase());
}

/** Bir oturumun kaydettiği anahtarlardan kanal listesi çıkarır. */
export function channelsForKeys(keys: readonly string[]): Channel[] {
  return keys
    .map((k) => getChannel(k))
    .filter((c): c is Channel => c !== undefined);
}

export { ALL_CHANNELS };
