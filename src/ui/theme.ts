/**
 * MINI heritage tasarım dili.
 *
 * Kaynak: `design/R50 Diagnostics.dc.html` — derin İngiliz yarış yeşili zemin,
 * krem mürekkep, krom hairline'lar. Bir gösterge paneli değil, bir ölçüm
 * aletinin dili: dolgu yok, köşe yuvarlaması yok, sadece çizgiler ve rakamlar.
 *
 * TAŞINAN KURALLAR (tasarımın 03 numaralı panelinden, harfiyen):
 *
 *   1. Krem mürekkeptir, krom ikincil mürekkep. Yeşil ZEMİNDİR, asla vurgu değil.
 *   2. Kırmızı yalnızca MIL ve kayıt için. Amber yalnızca uyarı için.
 *      Başka HİÇBİR şey renkli değildir.
 *   3. Dolu kart yok, radius yok. Çerçeveler hairline; gruplar çizgi ve boşlukla.
 *   4. Açıklayıcı düzyazı ya bir kuralın altında tek satır, ya da hiç.
 *
 * Bu kurallar bir teşhis aletinde estetik tercih değil işlev: renk anlam
 * taşıdığı için, her yeri renklendirmek sinyali yok eder.
 */

import { StyleSheet, type TextStyle } from 'react-native';

export const color = {
  /** Derin yarış yeşili — her ekranın zemini. */
  ground: '#0F2A21',
  /** Bir ton açık yeşil — seçili/aktif yüzeyler için, çok seyrek. */
  groundAlt: '#163B2E',
  /** Krem — birincil mürekkep, ölçülen her değer. */
  ink: '#F1EBDD',
  /** Krom — ikincil mürekkep, birimler ve ikincil değerler. */
  chrome: '#B9BEC2',
  /** Soluk yeşil-gri — etiketler, üçüncül metin. */
  muted: '#8FA398',
  /** Bağlantı kurulu göstergesi ve grafik izi. */
  linked: '#7FB08E',
  /** SADECE motor arıza lambası ve aktif kayıt. Başka hiçbir yerde. */
  alert: '#C4342C',
  /** SADECE uyarı (hazır değil, dikkat). Başka hiçbir yerde. */
  caution: '#D19A3A',
  /** Çerçeve ve ayraç çizgileri. */
  hairline: 'rgba(241,235,221,0.18)',
  hairlineStrong: 'rgba(241,235,221,0.22)',
  hairlineFaint: 'rgba(241,235,221,0.10)',
  /** Krem zemin üzerine yazılan koyu metin (birincil buton). */
  onInk: '#0F2A21',
} as const;

export const font = {
  /** Etiketler, aralıklı büyük harfler, eylemler. */
  label: 'BarlowCondensed_600SemiBold',
  /** Ölçülen her değer — tabular rakamlarla. */
  measure: 'BarlowCondensed_500Medium',
  /** Açıklamalar ve düzyazı, yalnızca. */
  prose: 'Barlow_400Regular',
} as const;

/** Rakamlar değişirken zıplamasın — ölçüm aletinde şart. */
const tabular: TextStyle = { fontVariant: ['tabular-nums'] };

export const type = StyleSheet.create({
  /** Ekranın sahibi olan tek sayı. */
  /**
   * lineHeight, fontSize'dan KÜÇÜK OLAMAZ.
   *
   * 88/76 idi ve iOS metin kutusunu harflerden alçak yapınca rakamların
   * üstünü çerçeveye kırptırıyordu — gürültü kartında "45.1"in tepesi
   * kesiliyordu (6 Eylül 2026). Temadaki diğer bütün stiller zaten
   * 1.05-1.08 arasında; ölçü stilleri tek istisnaydı ve kırpılan da
   * onlardı. Sıkı görünüm oranla değil, punto ile kurulur.
   */
  heroValue: {
    fontFamily: font.measure,
    fontSize: 88,
    lineHeight: 94,
    color: color.ink,
    letterSpacing: -1.5,
    ...tabular,
  },
  /** İkincil kanal değerleri (ızgara hücreleri). */
  cellValue: {
    fontFamily: font.measure,
    fontSize: 42,
    lineHeight: 45,
    color: color.ink,
    ...tabular,
  },
  /** Arıza kodu — başlık olan kod. */
  codeValue: {
    fontFamily: font.label,
    fontSize: 32,
    lineHeight: 34,
    color: color.ink,
    letterSpacing: 1.8,
    ...tabular,
  },
  /** Bölüm/kanal etiketi — aralıklı büyük harf. */
  label: {
    fontFamily: font.label,
    fontSize: 12,
    color: color.muted,
    letterSpacing: 2.2,
    textTransform: 'uppercase',
  },
  /** Küçük etiket (ızgara hücresi başlığı). */
  labelSmall: {
    fontFamily: font.label,
    fontSize: 11,
    color: color.muted,
    letterSpacing: 1.9,
    textTransform: 'uppercase',
  },
  /** Eylem metni (buton). */
  action: {
    fontFamily: font.label,
    fontSize: 16,
    letterSpacing: 2.4,
    textTransform: 'uppercase',
    color: color.ink,
  },
  /** Araç künyesi. */
  vehicle: {
    fontFamily: font.label,
    fontSize: 19,
    letterSpacing: 1.1,
    color: color.ink,
    lineHeight: 20,
  },
  /** Durum rozeti (LINKED / RECORDING). */
  status: {
    fontFamily: font.label,
    fontSize: 13,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  /** Manşet — CHECK ENGINE ON gibi. */
  headline: {
    fontFamily: font.label,
    fontSize: 26,
    letterSpacing: 1.3,
    textTransform: 'uppercase',
    color: color.ink,
    lineHeight: 28,
  },
  /** Birim (rakamın yanındaki). */
  unit: {
    fontFamily: font.label,
    fontSize: 14,
    letterSpacing: 1.8,
    textTransform: 'uppercase',
    color: color.chrome,
  },
  unitSmall: {
    fontFamily: font.prose,
    fontSize: 12,
    color: color.chrome,
  },
  /** Açıklama düzyazısı — tek satır, kural altında. */
  prose: {
    fontFamily: font.prose,
    fontSize: 14,
    color: color.ink,
    lineHeight: 19,
  },
  /** İkincil/soluk düzyazı. */
  meta: {
    fontFamily: font.prose,
    fontSize: 11,
    color: color.muted,
    letterSpacing: 0.2,
  },
  metaSmall: {
    fontFamily: font.prose,
    fontSize: 10,
    color: color.muted,
    letterSpacing: 0.4,
  },
  /** Ham log / teknik döküm — sabit genişlik gerekir. */
  mono: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: color.chrome,
  },
});

/** 4'lük ritim. */
export const space = (n: number): number => n * 4;

export const hairlineWidth = StyleSheet.hairlineWidth;
