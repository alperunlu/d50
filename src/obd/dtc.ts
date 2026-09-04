/**
 * Arıza kodu (DTC) okuma ve çözme.
 *
 * Üç mod da SALT-OKUNURDUR — ECU'nun hafızasında ne yazdığını sorar,
 * hiçbir şey değiştirmez:
 *   03 = kayıtlı kodlar (MIL'i yakanlar)
 *   07 = bekleyen kodlar (henüz doğrulanmamış)
 *   0A = kalıcı kodlar (silinemeyen, emisyon takibi)
 *
 * Mode 04 (SİLME) bu dosyada da, allowlist'te de yoktur ve olmayacaktır.
 *
 * Çözme mantığı saf: ham metin alır, kod listesi döner. Cihazsız test edilebilir.
 */

import { splitResponseLines } from './elm327';
import { lookupMiniDtc } from './dtcMini';

export type DtcKind = 'stored' | 'pending' | 'permanent';

export interface Dtc {
  /** Standart kod, ör. "P0301". */
  readonly code: string;
  readonly kind: DtcKind;
  /** Açıklama — önce araca özel tablo, sonra jenerik SAE tablosu. */
  readonly description: string | null;
  /** MINI/BMW servis cihazlarının gösterdiği fault code numarası (varsa). */
  readonly miniFaultCode: string | null;
  /** Açıklama araca özel tablodan mı geldi? */
  readonly vehicleSpecific: boolean;
}

/** Mod → komut ve cevabın başındaki mod baytı. */
export const DTC_MODES: Record<DtcKind, { command: string; responsePrefix: string }> = {
  stored: { command: '03', responsePrefix: '43' },
  pending: { command: '07', responsePrefix: '47' },
  permanent: { command: '0A', responsePrefix: '4A' },
};

/**
 * İki baytlık ham DTC'yi standart koda çevirir.
 *
 * Kodlama (SAE J2012): ilk baytın üst 2 biti sistem harfini, sonraki 2 biti
 * ilk haneyi verir; kalan 3 nibble kodun son üç hanesidir.
 *   00 -> P (powertrain), 01 -> C (chassis), 10 -> B (body), 11 -> U (network)
 *
 * Örnek: 0x03 0x01 -> "P0301" (1. silindir tekleme)
 */
export function decodeDtcBytes(a: number, b: number): string {
  const letter = ['P', 'C', 'B', 'U'][(a >> 6) & 0x03];
  const digit1 = (a >> 4) & 0x03;
  const digit2 = a & 0x0f;
  const digit3 = (b >> 4) & 0x0f;
  const digit4 = b & 0x0f;
  return `${letter}${digit1}${hex(digit2)}${hex(digit3)}${hex(digit4)}`;
}

/**
 * Mode 03/07/0A cevabından kod listesini çıkarır.
 *
 * Gerçek dünyada bu cevap üç farklı şekilde gelebiliyor, üçü de tolere edilir:
 *  - K-line (bizim R50): `43 01 33 00 00` — mod baytı + 2'şerli kod çiftleri
 *  - CAN: mod baytından sonra fazladan bir "kaç kod var" baytı gelir
 *  - Çoklu ECU / çoklu satır: her satır kendi mod baytıyla başlar
 *  - CAN çok-çerçeveli: satır başında `0:` `1:` gibi çerçeve numarası olur
 *
 * `00 00` çiftleri dolgudur, kod değildir — atılır.
 */
export function parseDtcResponse(raw: string, kind: DtcKind): Dtc[] {
  const prefix = DTC_MODES[kind].responsePrefix;
  const codes: string[] = [];

  for (const line of splitResponseLines(raw)) {
    if (/^(NO DATA|ERROR|UNABLE|STOPPED|SEARCHING|BUS)/i.test(line)) continue;

    // CAN çok-çerçeve satır numarasını at ("0:", "1:" ...).
    const withoutFrameIndex = line.replace(/^[0-9A-F]:\s*/i, '');
    const hexOnly = withoutFrameIndex.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    if (hexOnly.length < 2) continue;

    let payload = hexOnly;
    if (payload.startsWith(prefix)) payload = payload.slice(2);
    // Mod baytından sonra tek sayıda bayt kaldıysa ilki "kod adedi"dir (CAN).
    if ((payload.length / 2) % 2 === 1) payload = payload.slice(2);

    for (let i = 0; i + 3 < payload.length; i += 4) {
      const a = parseInt(payload.slice(i, i + 2), 16);
      const b = parseInt(payload.slice(i + 2, i + 4), 16);
      if (Number.isNaN(a) || Number.isNaN(b)) continue;
      if (a === 0 && b === 0) continue; // dolgu
      codes.push(decodeDtcBytes(a, b));
    }
  }

  // Çoklu ECU aynı kodu iki kez bildirebilir.
  const unique = [...new Set(codes)];
  return unique.map((code) => {
    const mini = lookupMiniDtc(code);
    return {
      code,
      kind,
      description: mini?.text ?? describeDtc(code),
      miniFaultCode: mini?.fc ?? null,
      vehicleSpecific: mini !== undefined,
    };
  });
}

/** `0101` cevabından MIL durumu ve kayıtlı kod sayısı. */
export interface MilStatus {
  /** Motor arıza lambası yanıyor mu. */
  readonly milOn: boolean;
  /** ECU'nun bildirdiği kayıtlı arıza kodu sayısı. */
  readonly dtcCount: number;
}

/**
 * Mode 01 PID 01 cevabını çözer: A baytının en üst biti MIL'i, kalan 7 bit
 * kod sayısını taşır. Bu PID zaten Mode 01 içinde olduğu için DTC modları
 * kapalıyken bile "arıza var mı?" sorusuna cevap verebilir.
 */
export function decodeMilStatus(bytes: readonly number[]): MilStatus | null {
  if (bytes.length < 1) return null;
  const a = bytes[0];
  return { milOn: (a & 0x80) !== 0, dtcCount: a & 0x7f };
}

/**
 * I/M hazırlık monitörü — emisyon muayenesi için "bu test tamamlandı mı?".
 *
 * `complete: false` olan bir monitör arıza olduğu anlamına GELMEZ; testin
 * henüz çalışmadığı anlamına gelir (akü sökülmüş, kod silinmiş ya da yeterli
 * sürüş yapılmamış olabilir). Muayeneye gitmeden önce bakmak, "hazır değil"
 * diye geri çevrilmeyi önler.
 */
export interface ReadinessMonitor {
  readonly name: string;
  /** Bu araçta bu monitör destekleniyor mu. */
  readonly supported: boolean;
  /** Testi tamamlandı mı (destekleniyorsa). */
  readonly complete: boolean;
}

export interface ReadinessStatus {
  /** Motor çalışıyorken bile geçerli olan sürekli monitörler. */
  readonly continuous: readonly ReadinessMonitor[];
  /** Yalnızca uygun sürüş koşullarında çalışan monitörler. */
  readonly nonContinuous: readonly ReadinessMonitor[];
  /** Desteklenen tüm monitörler tamamlandı mı — muayene için özet cevap. */
  readonly allComplete: boolean;
}

/**
 * `0101` cevabının B, C, D baytlarından hazırlık durumunu çözer (SAE J1979).
 *
 * B baytı: alt 3 bit sürekli monitörlerin desteği, üst yarısı tamamlanma
 * durumu. C/D baytları benzin motorları için süreksiz monitörler.
 * Bit anlamı TERS: 1 = "tamamlanmadı", 0 = "tamamlandı".
 */
export function decodeReadiness(bytes: readonly number[]): ReadinessStatus | null {
  if (bytes.length < 4) return null;
  const [, b, c, d] = bytes;

  const continuous: ReadinessMonitor[] = [
    { name: 'Misfire', supported: (b & 0x01) !== 0, complete: (b & 0x10) === 0 },
    { name: 'Fuel system', supported: (b & 0x02) !== 0, complete: (b & 0x20) === 0 },
    { name: 'Components', supported: (b & 0x04) !== 0, complete: (b & 0x40) === 0 },
  ];

  const nonContinuousNames = [
    'Catalyst',
    'Heated catalyst',
    'Evaporative system',
    'Secondary air system',
    'A/C refrigerant',
    'Oxygen sensor',
    'Oxygen sensor heater',
    'EGR system',
  ];

  const nonContinuous: ReadinessMonitor[] = nonContinuousNames.map((name, i) => ({
    name,
    supported: (c & (1 << i)) !== 0,
    complete: (d & (1 << i)) === 0,
  }));

  const all = [...continuous, ...nonContinuous];
  const allComplete = all.filter((m) => m.supported).every((m) => m.complete);

  return { continuous, nonContinuous, allComplete };
}

/**
 * Jenerik OBD-II kodları için kısa açıklamalar.
 *
 * Yalnızca standart (SAE) kodlar burada. P1xxx gibi üretici-özel kodların
 * anlamı markaya göre değişir ve MINI için kamuya açık güvenilir bir liste
 * yok — onlarda `null` dönüp kodu ham gösteriyoruz, uydurmuyoruz.
 */
const DESCRIPTIONS: Readonly<Record<string, string>> = {
  P0010: 'Camshaft position actuator circuit (bank 1)',
  P0011: 'Camshaft position - timing over-advanced (bank 1)',
  P0014: 'Exhaust camshaft position - timing over-advanced (bank 1)',
  P0016: 'Crankshaft/camshaft position correlation (bank 1 sensor A)',
  P0030: 'O2 sensor heater control circuit (bank 1 sensor 1)',
  P0100: 'Mass air flow circuit malfunction',
  P0101: 'Mass air flow circuit range/performance',
  P0102: 'Mass air flow circuit low input',
  P0103: 'Mass air flow circuit high input',
  P0105: 'Manifold absolute pressure circuit malfunction',
  P0106: 'Manifold absolute pressure range/performance',
  P0110: 'Intake air temperature circuit malfunction',
  P0113: 'Intake air temperature circuit high input',
  P0115: 'Engine coolant temperature circuit malfunction',
  P0116: 'Engine coolant temperature range/performance',
  P0117: 'Engine coolant temperature circuit low input',
  P0118: 'Engine coolant temperature circuit high input',
  P0120: 'Throttle position sensor circuit malfunction',
  P0121: 'Throttle position sensor range/performance',
  P0130: 'O2 sensor circuit malfunction (bank 1 sensor 1)',
  P0133: 'O2 sensor slow response (bank 1 sensor 1)',
  P0134: 'O2 sensor no activity detected (bank 1 sensor 1)',
  P0135: 'O2 sensor heater circuit malfunction (bank 1 sensor 1)',
  P0136: 'O2 sensor circuit malfunction (bank 1 sensor 2)',
  P0141: 'O2 sensor heater circuit malfunction (bank 1 sensor 2)',
  P0170: 'Fuel trim malfunction (bank 1)',
  P0171: 'System too lean (bank 1)',
  P0172: 'System too rich (bank 1)',
  P0201: 'Injector circuit malfunction - cylinder 1',
  P0202: 'Injector circuit malfunction - cylinder 2',
  P0203: 'Injector circuit malfunction - cylinder 3',
  P0204: 'Injector circuit malfunction - cylinder 4',
  P0300: 'Random/multiple cylinder misfire detected',
  P0301: 'Cylinder 1 misfire detected',
  P0302: 'Cylinder 2 misfire detected',
  P0303: 'Cylinder 3 misfire detected',
  P0304: 'Cylinder 4 misfire detected',
  P0325: 'Knock sensor circuit malfunction (bank 1)',
  P0327: 'Knock sensor circuit low input (bank 1)',
  P0335: 'Crankshaft position sensor circuit malfunction',
  P0340: 'Camshaft position sensor circuit malfunction',
  P0420: 'Catalyst system efficiency below threshold (bank 1)',
  P0441: 'EVAP system incorrect purge flow',
  P0442: 'EVAP system small leak detected',
  P0443: 'EVAP purge control valve circuit malfunction',
  P0455: 'EVAP system large leak detected',
  P0480: 'Cooling fan 1 control circuit malfunction',
  P0500: 'Vehicle speed sensor malfunction',
  P0505: 'Idle control system malfunction',
  P0506: 'Idle control system RPM lower than expected',
  P0507: 'Idle control system RPM higher than expected',
  P0562: 'System voltage low',
  P0563: 'System voltage high',
  P0601: 'Internal control module memory checksum error',
  P0603: 'Internal control module KAM error',
  P0605: 'Internal control module ROM error',
};

/**
 * Açıklama arar: önce araca özel tablo (R50'nin kendi servis verisi), sonra
 * jenerik SAE tablosu. Araca özel tablo P1xxx kodlarını da kapsadığı için
 * "üretici-özel, açıklama yok" durumu R50'de neredeyse hiç oluşmuyor.
 */
export function describeDtc(code: string): string | null {
  const mini = lookupMiniDtc(code);
  if (mini) return mini.text;
  return DESCRIPTIONS[code.toUpperCase()] ?? null;
}

/** Kod üretici-özel mi (P1xxx, C1xxx, B1xxx, U1xxx)? */
export function isManufacturerSpecific(code: string): boolean {
  return /^[PCBU]1/.test(code.toUpperCase());
}

/** Paylaşılabilir düz metin rapor. */
export function formatDtcReport(
  groups: Readonly<Record<DtcKind, readonly Dtc[]>>,
  mil: MilStatus | null,
  readiness?: ReadinessStatus | null,
): string {
  const lines: string[] = [];
  lines.push('OBD-II fault code report');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  if (mil) {
    lines.push(`MIL (check engine light): ${mil.milOn ? 'ON' : 'off'}`);
    lines.push(`DTC count reported by ECU: ${mil.dtcCount}`);
  } else {
    lines.push('MIL status: unknown (PID 0101 not answered)');
  }
  lines.push('');

  const titles: Record<DtcKind, string> = {
    stored: 'Stored codes (Mode 03)',
    pending: 'Pending codes (Mode 07)',
    permanent: 'Permanent codes (Mode 0A)',
  };

  for (const kind of ['stored', 'pending', 'permanent'] as DtcKind[]) {
    const list = groups[kind] ?? [];
    lines.push(`${titles[kind]}: ${list.length}`);
    for (const d of list) {
      const desc =
        d.description ?? (isManufacturerSpecific(d.code) ? '(manufacturer-specific)' : '(no description)');
      const fc = d.miniFaultCode ? `  [MINI FC ${d.miniFaultCode}]` : '';
      lines.push(`  ${d.code}  ${desc}${fc}`);
    }
    lines.push('');
  }

  lines.push('NOTE: this app only READS fault codes. It never clears them (Mode 04 is blocked).');
  return lines.join('\n') + '\n';
}

function hex(n: number): string {
  return n.toString(16).toUpperCase();
}
