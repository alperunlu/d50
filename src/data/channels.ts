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

export type ChannelSource = 'obd' | 'gps' | 'motion' | 'derived';

export interface Channel {
  /** `Sample.pid` alanına yazılan benzersiz anahtar. */
  readonly key: string;
  readonly name: string;
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
    unit: 'km/h',
    csvKey: 'gps_speed_kmh',
    refresh: 'fast',
    source: 'gps',
  },
  {
    key: 'gps_altitude',
    name: 'Altitude',
    unit: 'm',
    csvKey: 'gps_altitude_m',
    refresh: 'slow',
    source: 'gps',
  },
  {
    key: 'gps_accuracy',
    name: 'GPS Accuracy',
    unit: 'm',
    csvKey: 'gps_accuracy_m',
    refresh: 'slow',
    source: 'gps',
  },
  {
    key: 'gps_heading',
    name: 'Heading',
    unit: '°',
    csvKey: 'gps_heading_deg',
    refresh: 'slow',
    source: 'gps',
  },
  {
    key: 'accel_magnitude',
    name: 'Acceleration (total)',
    unit: 'g',
    csvKey: 'accel_g',
    refresh: 'fast',
    source: 'motion',
  },
  {
    key: 'accel_x',
    name: 'Acceleration X (device)',
    unit: 'g',
    csvKey: 'accel_x_g',
    refresh: 'fast',
    source: 'motion',
  },
  {
    key: 'accel_y',
    name: 'Acceleration Y (device)',
    unit: 'g',
    csvKey: 'accel_y_g',
    refresh: 'fast',
    source: 'motion',
  },
  {
    key: 'accel_z',
    name: 'Acceleration Z (device)',
    unit: 'g',
    csvKey: 'accel_z_g',
    refresh: 'fast',
    source: 'motion',
  },
];

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
