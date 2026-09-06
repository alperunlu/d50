/**
 * Rehberli test cycle'ının adımları.
 *
 * NEDEN VAR: 6 Eylül 2026 kayıtlarında teşhislerin çoğu "yetersiz veri"
 * dedi — sonda, rölanti, manifold vakumu, 0-100, silindir dengesi, aktarma
 * kaçırması. Hiçbiri arıza değildi; ölçümün gerektirdiği KOŞUL hiç
 * oluşmamıştı. Sürücü arabaya binip normal sürdüğünde rölantide durmuyor,
 * tam gaz çekmiyor, soğuk başlamıyor. Cycle bu koşulları sırayla kuruyor.
 *
 * İKİNCİ VE ASIL NEDEN: her adım YALNIZCA ihtiyacı olan kanalları açıyor.
 * 28 kanallık bir turda lambda sondası saniyede 0.29 kez sorulabiliyordu;
 * Nyquist yüzünden 0.15 Hz'in üstündeki hiçbir salınım görünmüyordu ve
 * teşhis sağlam sondaya "yaşlanmış olabilir" diyordu. Aynı sonda üç
 * kanallık bir adımda ~1.2 Hz sorulur — ölçüm ilk kez mümkün hâle gelir.
 * Cycle sadece kullanıcıyı yönlendirmiyor, ölçümü mümkün kılıyor.
 *
 * Adımlar soğuk motorla başlıyor: ısınma eğrisi ve soğuk/sıcak rölanti
 * karşılaştırması günün ilk çalıştırmasından başka hiçbir yerde alınamaz.
 */

/** Bir adımın hangi kanallarla kaydedileceği. */
export interface StepChannels {
  /** OBD PID kodları, ör. ['0C','14','15']. */
  readonly pids: readonly string[];
  /** Telefon sensör kanalları, ör. ['gps_speed','accel_magnitude','mic_db']. */
  readonly sensors: readonly string[];
}

/**
 * Adımın tamamlanma koşulu.
 *
 * `hold`: koşul KESİNTİSİZ bu kadar saniye sağlanmalı. Bir saniyeliğine
 * 80 km/h'a değip geçmek "sabit hızda sürdüm" değildir.
 */
export interface StepCondition {
  /** Kullanıcıya gösterilen kısa etiket, ör. "hız 70-90 km/h". */
  readonly label: string;
  /** Hangi kanala bakılıyor (seri anahtarı). */
  readonly channel: string;
  readonly min?: number;
  readonly max?: number;
}

export interface CycleStep {
  readonly id: string;
  readonly title: string;
  /** Sürücüye verilen emir. Kısa, tek iş, araçtayken okunabilir. */
  readonly instruction: string;
  /** Bu adımın neyi ölçtüğü — raporda ve ekranda gerekçe olarak duruyor. */
  readonly measures: string;
  readonly channels: StepChannels;
  /** Koşullar sağlanırken kaç saniye tutulacağı. */
  readonly holdSeconds: number;
  /** Tamamlanma koşulları. Boşsa yalnızca süre sayılır. */
  readonly conditions: readonly StepCondition[];
  /**
   * Sürücünün elini gerektirmeyen adımlar otomatik ilerler. Kontak açma
   * gibi adımlar ilerlemek için dokunuş bekler.
   */
  readonly manualAdvance?: boolean;
}

/** Rölanti ölçümlerinin ortak kanal seti. */
const IDLE_CHANNELS: StepChannels = {
  pids: ['0C', '05', '0B', '11', '06', '07'],
  sensors: [],
};

export const CYCLE_STEPS: readonly CycleStep[] = [
  {
    id: 'ignition',
    title: 'Ignition on',
    instruction:
      'Turn the ignition on but do NOT start the engine. Wait for the adapter to link.',
    measures: 'Establishes the link and the cold reference before anything runs.',
    channels: { pids: ['0C'], sensors: [] },
    holdSeconds: 0,
    conditions: [],
    manualAdvance: true,
  },
  {
    id: 'cold-idle',
    title: 'Cold idle',
    instruction:
      'Start the engine and leave it idling. Do not touch the throttle. Air conditioning off.',
    measures:
      'Cold idle speed and the warm-up enrichment — the fuel trims here are the only ones taken on a cold engine.',
    channels: IDLE_CHANNELS,
    holdSeconds: 90,
    conditions: [{ label: 'engine idling', channel: '0C', min: 400, max: 1400 }],
  },
  {
    id: 'o2',
    title: 'Oxygen sensor',
    instruction: 'Keep idling. Nothing to do — this step reads the sensors faster.',
    measures:
      'Pre-cat sensor switching rate and converter storage. Only three channels are polled so the sensor is sampled fast enough to actually see it switch.',
    channels: { pids: ['0C', '14', '15'], sensors: [] },
    holdSeconds: 60,
    conditions: [{ label: 'engine idling', channel: '0C', min: 400, max: 1400 }],
  },
  {
    id: 'rev-sweep',
    title: 'Rev sweep',
    instruction:
      'Still parked, in neutral: raise the revs to about 3000 and let them fall. Three times, slowly.',
    measures:
      'Cylinder balance and rotational balance from engine sound. Parked, so road and wind noise cannot inflate the orders.',
    channels: { pids: ['0C'], sensors: ['mic_db'] },
    holdSeconds: 60,
    conditions: [{ label: 'engine running', channel: '0C', min: 400 }],
  },
  {
    id: 'warm-up-drive',
    title: 'Warm-up drive',
    instruction: 'Drive normally until the coolant stops climbing. Five minutes is usually enough.',
    measures: 'The thermostat curve — how long the engine takes to reach operating temperature.',
    channels: {
      pids: ['0C', '0D', '05', '0B', '0F', '11'],
      sensors: ['gps_speed', 'accel_magnitude'],
    },
    holdSeconds: 300,
    conditions: [{ label: 'coolant above 85 °C', channel: '05', min: 85 }],
  },
  {
    id: 'cruise',
    title: 'Steady cruise',
    instruction: 'Hold about 80 km/h in one gear, steady throttle. Do not change gear.',
    measures:
      'Drive ratio, rolling circumference and speedometer error — all of which need a constant gear and constant speed.',
    channels: {
      pids: ['0C', '0D', '0B', '0F'],
      sensors: ['gps_speed', 'gps_altitude'],
    },
    holdSeconds: 60,
    conditions: [{ label: 'speed 70-90 km/h', channel: '0D', min: 70, max: 90 }],
  },
  {
    id: 'pull',
    title: 'Full-throttle pull',
    instruction:
      'From a standstill on a clear, level road: full throttle to 100 km/h in one continuous pull.',
    measures: '0-100 time, peak power and torque, and transmission slip.',
    channels: {
      pids: ['0C', '0D', '11', '04', '0B'],
      sensors: ['gps_speed', 'accel_magnitude'],
    },
    holdSeconds: 0,
    conditions: [{ label: 'reached 100 km/h', channel: '0D', min: 100 }],
  },
  {
    id: 'coast',
    title: 'Coast down',
    instruction: 'From about 80 km/h, lift off completely and coast in gear down to 40. No braking.',
    measures: 'Road load — rolling resistance and drag, which every power estimate leans on.',
    channels: { pids: ['0C', '0D'], sensors: ['gps_speed', 'accel_magnitude'] },
    holdSeconds: 0,
    conditions: [{ label: 'slowed below 45 km/h', channel: '0D', max: 45 }],
  },
  {
    id: 'warm-idle',
    title: 'Warm idle',
    instruction: 'Park, leave it idling one more minute. Air conditioning off.',
    measures:
      'The same measurement as the first step, now warm. The difference between them is what a single idle recording can never show.',
    channels: IDLE_CHANNELS,
    holdSeconds: 60,
    conditions: [{ label: 'engine idling', channel: '0C', min: 400, max: 1400 }],
  },
];

/** Bir adımın kaydedeceği tüm kanal anahtarları (CSV sütunları için). */
export function channelKeysForStep(step: CycleStep): string[] {
  return [...step.channels.pids, ...step.channels.sensors];
}
