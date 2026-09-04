/**
 * Minimal zaman serisi grafiği — react-native-svg üzerine elle yazılmış tek
 * bir polyline. Ayrı bir grafik kütüphanesi (ör. react-native-gifted-charts)
 * eklemek yerine bilerek bu yol seçildi: tek PID'lik kayan bir çizgi
 * çizmek için ihtiyacımız olan her şey zaten react-native-svg'de var,
 * ekstra bağımlılık = ekstra native yüzey alanı = build başına ekstra risk
 * (bkz. plan, Kısıt #2 — native build sayısını minimize etme).
 */

import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Polyline, Line, Text as SvgText } from 'react-native-svg';
import { theme } from './theme';

export interface ChartPoint {
  readonly ts: number;
  readonly value: number;
}

interface Props {
  readonly points: readonly ChartPoint[];
  readonly unit: string;
  readonly height?: number;
  /** Kaç saniyelik pencere gösterilsin (kayan grafik). Varsayılan 60sn. */
  readonly windowMs?: number;
}

const DEFAULT_HEIGHT = 160;
const DEFAULT_WINDOW_MS = 60_000;
const PADDING = 8;

export function LineChart({ points, unit, height = DEFAULT_HEIGHT, windowMs = DEFAULT_WINDOW_MS }: Props) {
  const [width, setWidth] = React.useState(300);

  const { polylinePoints, minV, maxV, visible } = useMemo(() => {
    if (points.length === 0) {
      return { polylinePoints: '', minV: 0, maxV: 0, visible: [] as ChartPoint[] };
    }
    const latestTs = points[points.length - 1].ts;
    const cutoff = latestTs - windowMs;
    const vis = points.filter((p) => p.ts >= cutoff);
    if (vis.length === 0) {
      return { polylinePoints: '', minV: 0, maxV: 0, visible: [] as ChartPoint[] };
    }

    const values = vis.map((p) => p.value);
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) {
      // Düz çizgi olmasın diye görsel olarak biraz aralık aç.
      min -= 1;
      max += 1;
    }

    const tMin = vis[0].ts;
    const tMax = vis[vis.length - 1].ts;
    const tSpan = Math.max(1, tMax - tMin);
    const innerW = width - PADDING * 2;
    const innerH = height - PADDING * 2;

    const coords = vis.map((p) => {
      const x = PADDING + ((p.ts - tMin) / tSpan) * innerW;
      const y = PADDING + innerH - ((p.value - min) / (max - min)) * innerH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    return { polylinePoints: coords.join(' '), minV: min, maxV: max, visible: vis };
  }, [points, width, height, windowMs]);

  const latest = points[points.length - 1];

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.latestValue}>
          {latest ? formatValue(latest.value) : '—'}
          <Text style={styles.unit}> {unit}</Text>
        </Text>
      </View>
      <View
        style={{ height }}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      >
        <Svg width={width} height={height}>
          <Line
            x1={PADDING}
            y1={height / 2}
            x2={width - PADDING}
            y2={height / 2}
            stroke={theme.chartGrid}
            strokeWidth={1}
          />
          {visible.length > 1 && (
            <Polyline
              points={polylinePoints}
              fill="none"
              stroke={theme.chartLine}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}
          {visible.length > 0 && (
            <>
              <SvgText x={PADDING} y={height - 2} fill={theme.textDim} fontSize={10}>
                {formatValue(minV)}
              </SvgText>
              <SvgText x={PADDING} y={12} fill={theme.textDim} fontSize={10}>
                {formatValue(maxV)}
              </SvgText>
            </>
          )}
        </Svg>
      </View>
    </View>
  );
}

function formatValue(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: theme.surface,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: theme.border,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  latestValue: {
    color: theme.text,
    fontSize: 28,
    fontWeight: '700',
  },
  unit: {
    color: theme.textDim,
    fontSize: 14,
    fontWeight: '400',
  },
});
