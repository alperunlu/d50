/** Basit, koyu temalı renk paleti — araba içi ekranda parlaklık rahatsız etmesin diye. */
export const theme = {
  bg: '#0B0F14',
  surface: '#141B22',
  surfaceAlt: '#1C2530',
  border: '#28323D',
  text: '#E7EDF3',
  textDim: '#8A97A5',
  accent: '#4FD1C5',
  danger: '#F26D6D',
  warning: '#F2B84B',
  ok: '#5FCB6B',
  chartLine: '#4FD1C5',
  chartGrid: '#233039',
} as const;

export const spacing = (n: number): number => n * 8;
