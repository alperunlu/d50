/**
 * Tek dosyalık HTML rapor.
 *
 * NEDEN HTML: gerçek PDF `expo-print` ister, o da native modül — mevcut
 * derlemede yok ve OTA ile gelemez. HTML bugün çalışıyor ve iOS paylaşım
 * sayfasındaki "Print → Save as PDF" ile kullanıcı zaten PDF alabiliyor.
 * Yapı, `expo-print` bir sonraki derlemeye girdiğinde aynı HTML'in tek
 * satırla PDF'e verilebileceği şekilde: içeride hiçbir dış kaynak yok,
 * stil gömülü, sayfa kırılmaları CSS'te tanımlı.
 *
 * Rapor iki soruyu cevaplıyor:
 *   1. Bu cycle'da ne ölçüldü, hangi koşulda? (kanıtla birlikte)
 *   2. Bu sayılar geçen sefere göre nereye gidiyor? (taban çizgisiyle)
 * İkincisi olmadan rapor bir fotoğraf; onunla birlikte bir eğri.
 */

import type { Finding } from '../analysis/diagnostics';
import type { TripSummary } from '../analysis/derived';
import type { Trend } from '../analysis/trend';

export interface ReportVital {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly unit: string;
  readonly trend: Trend;
}

export interface ReportInput {
  readonly sessionId: number;
  readonly startedAt: number;
  readonly durationSec: number;
  readonly vehicle: string;
  readonly buildTag: string;
  readonly summary: TripSummary;
  readonly findings: readonly Finding[];
  readonly vitals: readonly ReportVital[];
  /** Atlanan cycle adımları — raporda "ölçülmedi" olarak görünür. */
  readonly skippedSteps: readonly string[];
}

/** HTML'e gömülecek her metin buradan geçer. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(value: number | null, unit: string, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}&thinsp;${escapeHtml(unit)}`;
}

/**
 * Trendi tek cümleye çevirir.
 *
 * Sayı vermeden "kötüye gidiyor" demek işe yaramaz; kullanıcı ne kadar
 * kaydığını ve neye göre kaydığını görmeli.
 */
function trendSentence(vital: ReportVital): string {
  const t = vital.trend;
  if (t.verdict === 'baseline') {
    return t.needMore > 0
      ? `Building a baseline — ${t.needMore} more cycle${t.needMore === 1 ? '' : 's'} before a trend means anything.`
      : 'Building a baseline.';
  }
  const change = t.change ?? 0;
  const direction = change > 0 ? 'up' : 'down';
  const base = `${direction} ${Math.abs(change).toFixed(2)} ${vital.unit} from a baseline of ${(t.baseline ?? 0).toFixed(2)}`;
  if (t.verdict === 'stable') return `Stable — within the noise of its own baseline.`;
  if (t.verdict === 'improving') return `Improving: ${base}.`;
  const rate =
    t.slopePerMonth !== null && Number.isFinite(t.slopePerMonth)
      ? ` (about ${t.slopePerMonth.toFixed(2)} ${vital.unit} per month)`
      : '';
  return `Drifting: ${base}${rate}.`;
}

const VERDICT_CLASS: Record<string, string> = {
  attention: 'attention',
  ok: 'ok',
  inconclusive: 'muted',
};

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
    color: #14201b; background: #fff;
  }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: .02em; }
  h2 {
    font-size: 12px; letter-spacing: .12em; text-transform: uppercase;
    color: #5c6b64; margin: 32px 0 8px; border-bottom: 1px solid #d8ded9; padding-bottom: 6px;
  }
  .meta { color: #5c6b64; font-size: 12px; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 7px 0; border-bottom: 1px solid #eceeeb; vertical-align: top; }
  td.value { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .label { color: #14201b; }
  .why { color: #7b8a82; font-size: 12px; }
  .finding { padding: 10px 0 10px 12px; border-bottom: 1px solid #eceeeb; border-left: 3px solid #d8ded9; }
  .finding.attention { border-left-color: #b5701f; }
  .finding.ok { border-left-color: #2f7d5a; }
  .finding .head { font-size: 12px; color: #5c6b64; }
  .finding .headline { font-size: 15px; margin: 2px 0 4px; }
  .finding .detail { color: #3d4a44; }
  .finding .evidence { color: #7b8a82; font-size: 12px; margin-top: 4px; }
  .trend { font-size: 12px; margin-top: 2px; }
  .trend.drifting { color: #b5701f; }
  .trend.improving { color: #2f7d5a; }
  .trend.stable, .trend.baseline { color: #7b8a82; }
  .note { color: #7b8a82; font-size: 12px; margin-top: 24px; }
  @media print {
    body { padding: 0; }
    h2 { break-after: avoid; }
    .finding { break-inside: avoid; }
  }
`;

export function buildReportHtml(input: ReportInput): string {
  const started = new Date(input.startedAt);
  const minutes = Math.round(input.durationSec / 60);

  const summaryRows: [string, string][] = [
    ['Max speed', fmt(input.summary.maxSpeedKmh, 'km/h', 0)],
    ['Average speed', fmt(input.summary.avgSpeedKmh, 'km/h', 0)],
    ['0-100', fmt(input.summary.zeroToHundredSec, 's', 2)],
    ['Warm-up', fmt(input.summary.warmupSec, 's', 0)],
    ['Peak power', fmt(input.summary.maxPowerKw, 'kW', 1)],
    ['Peak torque', fmt(input.summary.maxEngineTorqueNm, 'Nm', 0)],
    ['Consumption', fmt(input.summary.avgFuelPer100Km, 'L/100km', 1)],
    ['Speedometer error', fmt(input.summary.speedometerErrorPct, '%', 1)],
    ['Idle stability', fmt(input.summary.idleRpmStdDev, 'rpm σ', 0)],
  ];

  const vitalsHtml = input.vitals.length
    ? input.vitals
        .map(
          (v) => `
      <tr>
        <td class="label">${escapeHtml(v.label)}
          <div class="trend ${v.trend.verdict}">${escapeHtml(trendSentence(v))}</div>
        </td>
        <td class="value">${fmt(v.value, v.unit, 2)}</td>
      </tr>`,
        )
        .join('')
    : `<tr><td class="why">No vitals were extracted — the steps they come from were skipped or produced too little data.</td></tr>`;

  const findingsHtml = input.findings
    .map(
      (f) => `
    <div class="finding ${VERDICT_CLASS[f.verdict] ?? 'muted'}">
      <div class="head">${escapeHtml(f.title)}</div>
      <div class="headline">${escapeHtml(f.headline)}</div>
      <div class="detail">${escapeHtml(f.detail)}</div>
      ${f.evidence ? `<div class="evidence">${escapeHtml(f.evidence)}</div>` : ''}
    </div>`,
    )
    .join('');

  const skipped = input.skippedSteps.length
    ? `<p class="note">Steps skipped in this cycle, so anything that depends on them was not measured: ${escapeHtml(input.skippedSteps.join(', '))}.</p>`
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>D50 report — ${escapeHtml(started.toLocaleDateString())}</title>
<style>${STYLE}</style></head>
<body>
  <h1>D50 vehicle report</h1>
  <div class="meta">${escapeHtml(input.vehicle)}</div>
  <div class="meta">${escapeHtml(started.toLocaleString())} · ${minutes} min · session ${input.sessionId}</div>

  <h2>Vitals and trend</h2>
  <table>${vitalsHtml}</table>

  <h2>Trip summary</h2>
  <table>
    ${summaryRows.map(([k, v]) => `<tr><td class="label">${escapeHtml(k)}</td><td class="value">${v}</td></tr>`).join('')}
  </table>

  <h2>Diagnostics</h2>
  ${findingsHtml}

  ${skipped}
  <p class="note">
    Power, torque and consumption are estimates derived from vehicle mass and air mass flow,
    not dynamometer measurements. Trends compare this car against its own earlier readings
    taken under the same guided-cycle conditions; they are not a prediction of remaining life.
  </p>
  <p class="note">Generated by D50 ${escapeHtml(input.buildTag)}</p>
</body></html>`;
}
