/**
 * Tasarım dilinin yapı taşları.
 *
 * Hepsi tek bir kuraldan türüyor: dolgu yok, radius yok — bir yüzeyi
 * tanımlayan tek şey hairline çerçeve ve köşelerdeki registration işareti.
 * Bu, bir teknik çizim dili; ekranı "kartlar"dan değil "çerçeveler"den
 * kuruyor, böylece hiçbir şey diğerinden daha "dolu" görünmüyor.
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet, type ViewStyle, type StyleProp } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';
import { color, type, space, hairlineWidth } from './theme';
import { extentOf } from '../util/agg';

/**
 * Köşe registration işareti — 11×11 artı, çerçeve köşesine binen.
 * Tasarımda `.corner` sınıfının birebir karşılığı.
 */
function CornerMark({
  position,
  tint,
}: {
  position: 'tl' | 'tr' | 'bl' | 'br';
  tint: string;
}) {
  const edge: ViewStyle = {
    position: 'absolute',
    width: 11,
    height: 11,
    ...(position[0] === 't' ? { top: -6 } : { bottom: -6 }),
    ...(position[1] === 'l' ? { left: -6 } : { right: -6 }),
  };
  return (
    <View style={edge} pointerEvents="none">
      <View style={{ position: 'absolute', left: 5, top: 0, width: 1, height: 11, backgroundColor: tint }} />
      <View style={{ position: 'absolute', top: 5, left: 0, height: 1, width: 11, backgroundColor: tint }} />
    </View>
  );
}

/**
 * Hairline çerçeve + köşe işaretleri. Uygulamadaki her "kutu" bu.
 * `overflow: visible` şart — köşe işaretleri çerçevenin dışına taşıyor.
 */
export function Frame({
  children,
  style,
  borderColor = color.hairline,
  cornerTint = 'rgba(241,235,221,0.42)',
}: {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  borderColor?: string;
  cornerTint?: string;
}) {
  return (
    <View style={[styles.frame, { borderColor }, style]}>
      <CornerMark position="tl" tint={cornerTint} />
      <CornerMark position="tr" tint={cornerTint} />
      <CornerMark position="bl" tint={cornerTint} />
      <CornerMark position="br" tint={cornerTint} />
      {children}
    </View>
  );
}

/** Aralıklı büyük harf bölüm etiketi. */
export function Label({ children, small }: { children: React.ReactNode; small?: boolean }) {
  return <Text style={small ? type.labelSmall : type.label}>{children}</Text>;
}

/**
 * Bölüm başlığı: solda etiket, sağda açıklayıcı meta, altında kural çizgisi.
 * Gruplar kutuyla değil bu şekilde ayrılıyor.
 */
export function SectionRule({
  label,
  meta,
  metaColor,
  style,
}: {
  label: string;
  meta?: string;
  metaColor?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.sectionRule, style]}>
      <Text style={type.label}>{label}</Text>
      {meta ? (
        <Text style={[type.metaSmall, metaColor ? { color: metaColor } : null]}>{meta}</Text>
      ) : null}
    </View>
  );
}

/** Ölçülen değer + birimi, taban hizalı. */
export function Measure({
  value,
  unit,
  hero,
}: {
  /** `null` = henüz ölçüm yok. Sıfır göstermek yanıltıcı olurdu. */
  value: string | null;
  unit: string;
  hero?: boolean;
}) {
  // Boş değeri hero boyutunda em-dash ile göstermek koca bir blok üretiyordu.
  // Ölçüm yokken rakam yerine soluk, küçük bir işaret koyuyoruz — birim yine
  // görünür kalıyor ki hücrenin ne olduğu okunsun.
  if (value === null) {
    return (
      <View style={styles.measureRow}>
        <Text
          style={[
            hero ? type.heroValue : type.cellValue,
            { fontSize: hero ? 40 : 24, lineHeight: hero ? 60 : 30, color: color.muted },
          ]}
        >
          ·
        </Text>
        <Text style={hero ? type.unit : type.unitSmall}>{unit}</Text>
      </View>
    );
  }
  return (
    <View style={styles.measureRow}>
      {/*
        Rakam kutuya sığmalı, kutuyu taşırmamalı.

        Ölçü fontu 88 punto; "76.7" + "dB(A)" gürültü kartında çerçeveden
        taşıyordu (6 Eylül 2026). Satırın kendisi küçülmediği için fazlalık
        dışarı akıyordu. Artık rakam gerektiği kadar küçülüyor — birim
        küçülmüyor, çünkü ölçünün NE olduğu okunmaya devam etmeli.
      */}
      <Text
        style={[hero ? type.heroValue : type.cellValue, styles.measureValue]}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.5}
      >
        {value}
      </Text>
      <Text style={[hero ? type.unit : type.unitSmall, styles.measureUnit]}>{unit}</Text>
    </View>
  );
}

/** Hairline çerçeveli küçük etiket (MIXTURE, MINI gibi). */
export function Tag({ text, tint = color.chrome }: { text: string; tint?: string }) {
  return (
    <View style={[styles.tag, { borderColor: tint }]}>
      <Text style={[type.status, { fontSize: 11, letterSpacing: 1.4, color: tint }]}>{text}</Text>
    </View>
  );
}

/** Durum noktası + metin (LINKED, RECORDING). Kare, daire değil. */
export function StatusDot({ text, tint }: { text: string; tint: string }) {
  return (
    <View style={styles.statusRow}>
      <View style={{ width: 6, height: 6, backgroundColor: tint }} />
      <Text style={[type.status, { color: tint }]}>{text}</Text>
    </View>
  );
}

/**
 * Birincil eylem: krem dolgu, yeşil metin. Ekranda en fazla bir tane olmalı —
 * dolgu bu dilde nadir olduğu için tek başına hiyerarşi kuruyor.
 */
export function PrimaryAction({
  label,
  onPress,
  disabled,
  style,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      style={[styles.primaryAction, disabled && styles.disabled, style]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={[type.action, { color: color.onInk }]}>{label}</Text>
    </Pressable>
  );
}

/**
 * İkincil eylem.
 *
 * Tasarımın "dolgu yok" kuralı VERİ yüzeyleri içindi — çerçeveler ve hücreler.
 * Eylemler için birebir uygulandığında butonlar zeminle aynı renkte kalıyor ve
 * dokunulabilir oldukları anlaşılmıyordu. Çözüm dili bozmadan: zeminden bir ton
 * ayrışan yüzey (groundAlt) + belirgin kenarlık. Hâlâ radius yok, hâlâ renk yok.
 */
export function GhostAction({
  label,
  onPress,
  disabled,
  tint = 'rgba(241,235,221,0.45)',
  textTint = color.ink,
  style,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tint?: string;
  textTint?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      style={[styles.ghostAction, { borderColor: tint }, disabled && styles.disabled, style]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={[type.action, { color: textTint }]}>{label}</Text>
    </Pressable>
  );
}

/**
 * Değerin altındaki iz. Eksen yok, ızgara yok, etiket yok — sadece şeklin
 * kendisi. Sayı zaten değeri söylüyor; iz yalnızca yönü söylüyor.
 */
export function Sparkline({
  points,
  height = 30,
  tint = color.chrome,
  windowMs = 60_000,
}: {
  points: readonly { ts: number; value: number }[];
  height?: number;
  tint?: string;
  windowMs?: number;
}) {
  const [width, setWidth] = React.useState(120);

  const polyline = React.useMemo(() => {
    if (points.length < 2) return '';
    const latest = points[points.length - 1].ts;
    const visible = points.filter((p) => p.ts >= latest - windowMs);
    if (visible.length < 2) return '';

    const extent = extentOf(visible.map((p) => p.value));
    if (!extent) return '';
    let { min, max } = extent;
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const tMin = visible[0].ts;
    const tSpan = Math.max(1, visible[visible.length - 1].ts - tMin);

    return visible
      .map((p) => {
        const x = ((p.ts - tMin) / tSpan) * width;
        const y = height - ((p.value - min) / (max - min)) * height;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [points, width, height, windowMs]);

  return (
    <View style={{ height, marginTop: space(2) }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {polyline ? (
        <Svg width={width} height={height}>
          <Polyline points={polyline} fill="none" stroke={tint} strokeWidth={1.5} />
        </Svg>
      ) : null}
    </View>
  );
}

/** Yatay ayraç kuralı. */
export function Rule({ strong, style }: { strong?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      style={[
        { height: hairlineWidth, backgroundColor: strong ? color.hairlineStrong : color.hairlineFaint },
        style,
      ]}
    />
  );
}

/**
 * Kural altına asılan tek satırlık açıklama. Sol kenarında dikey hairline
 * var — düzyazının ölçüm değil yorum olduğunu belli ediyor.
 */
export function Note({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.note}>
      <Text style={[type.meta, { lineHeight: 16 }]}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    borderWidth: hairlineWidth,
    padding: space(4),
    // Köşe işaretleri çerçevenin dışına taşıyor.
    overflow: 'visible',
  },
  sectionRule: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.hairlineStrong,
    paddingBottom: space(1.5),
  },
  measureRow: { flexDirection: 'row', alignItems: 'baseline', gap: space(2) },
  // flexShrink + minWidth:0 olmadan uzun bir rakam satırı taşırır.
  measureValue: { flexShrink: 1, minWidth: 0 },
  measureUnit: { flexShrink: 0 },
  tag: {
    borderWidth: hairlineWidth,
    paddingHorizontal: space(2),
    paddingVertical: space(1),
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: space(1.5) },
  primaryAction: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.ink,
    paddingHorizontal: space(4),
  },
  ghostAction: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: hairlineWidth,
    paddingHorizontal: space(4),
    backgroundColor: color.groundAlt,
  },
  disabled: { opacity: 0.35 },
  note: {
    borderLeftWidth: hairlineWidth,
    borderLeftColor: color.hairlineStrong,
    paddingLeft: space(3),
    marginTop: space(2),
  },
});
