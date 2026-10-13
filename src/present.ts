/**
 * Pure presentation projectors for the `chart` tool.
 *
 * These functions run during live streaming AND during session-log replay, so
 * they must be pure: they read only their arguments, never the clock, never the
 * filesystem, never a session. Everything the client half draws is produced
 * here and persisted with the tool result.
 */

import type { ToolResult } from '@deepseek-ai/dsh-tools';
import type { ChartSeries, ChartCanonicalValue } from './transform.ts';

export interface ChartPaletteMeta {
  series: string[];
  positive: string;
  negative: string;
  axis: string;
  grid: string;
  label: string;
  bg: string;
  fontFamily?: string;
  fontSize?: number;
}

export interface ChartThemeMeta {
  name: string;
  mode: 'light' | 'dark';
  palette: ChartPaletteMeta;
}

export interface ChartSeriesMeta {
  name: string;
  colorIndex: number;
  points: Array<[string | number, number | number[]]>;
  downsampled: boolean;
}

export interface ChartPresentationMeta {
  schemaVersion: 1;
  chartId: string;
  chartType: string;
  title?: string;
  subtitle?: string;
  encoding: { x?: string; y?: string[]; series?: string; color?: string };
  series: ChartSeriesMeta[];
  axes: {
    xLabel?: string;
    yLabel?: string;
    yMin?: number;
    yMax?: number;
    xKind?: string;
    yFields?: string[];
  };
  annotations?: Array<{ y: number; text: string; kind?: string; to?: number }>;
  stats?: ChartCanonicalValue['stats'];
  truncated: boolean;
  total?: number;
  height: number;
  stack: boolean;
  theme: ChartThemeMeta;
  downsampled: boolean;
  hint?: string;
}

const TYPE_LABEL: Record<string, string> = {
  line: '折线图',
  bar: '柱状图',
  area: '面积图',
  scatter: '散点图',
  pie: '饼图',
  heatmap: '热力图',
  candlestick: 'K 线图',
  boxplot: '箱线图',
};

/** Largest-Triangle-Three-Buckets, duplicated here so the projector stays pure. */
function downsample(points: ChartSeries['points'], threshold: number): ChartSeries['points'] {
  const yOf = (point: ChartSeries['points'][number]): number => {
    if (typeof point.y === 'number') return point.y;
    if (Array.isArray(point.y) && point.y.length > 0) return point.y[0];
    return Number.NaN;
  };
  if (threshold >= points.length || threshold < 3) return points;
  const sampled: ChartSeries['points'] = [points[0]];
  const every = (points.length - 2) / (threshold - 2);
  let anchor = 0;
  for (let bucket = 0; bucket < threshold - 2; bucket += 1) {
    const start = Math.floor((bucket + 1) * every) + 1;
    const end = Math.min(Math.floor((bucket + 2) * every) + 1, points.length);
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (let index = start; index < end; index += 1) {
      const y = yOf(points[index]);
      if (Number.isFinite(y)) {
        sumY += y;
        count += 1;
      }
      sumX += typeof points[index].x === 'number' ? (points[index].x as number) : index;
    }
    if (count > 0) sumY /= count;
    if (end > start) sumX /= end - start;
    const last = Math.min(Math.floor((bucket + 1) * every) + 1, points.length);
    const first = Math.floor(bucket * every) + 1;
    const anchorY = yOf(points[anchor]);
    const anchorX = typeof points[anchor].x === 'number' ? (points[anchor].x as number) : anchor;
    let bestArea = -1;
    let bestIndex = first;
    for (let index = first; index < last; index += 1) {
      const y = yOf(points[index]);
      if (!Number.isFinite(y)) continue;
      const x = typeof points[index].x === 'number' ? (points[index].x as number) : index;
      const area = Math.abs((anchorX - sumX) * (y - anchorY) - (anchorX - x) * (sumY - anchorY));
      if (area > bestArea) {
        bestArea = area;
        bestIndex = index;
      }
    }
    sampled.push(points[bestIndex]);
    anchor = bestIndex;
  }
  sampled.push(points[points.length - 1]);
  return sampled;
}

export interface MetaOptions {
  maxPoints: number;
  height: number;
  stack: boolean;
  themes: Record<string, { mode: 'light' | 'dark'; palette: ChartPaletteMeta }>;
  defaultTheme: string;
  theme?: string;
}

/** Resolve the requested theme name, falling back loudly-but-gracefully. */
export function resolveThemeMeta(options: MetaOptions): { theme: ChartThemeMeta; warning?: string } {
  const requested = options.theme;
  if (requested !== undefined) {
    const entry = options.themes[requested];
    if (entry === undefined) {
      return {
        theme: { name: options.defaultTheme, ...options.themes[options.defaultTheme] },
        warning: `unknown theme "${requested}"`,
      };
    }
    return { theme: { name: requested, mode: entry.mode, palette: entry.palette } };
  }
  const fallback = options.themes[options.defaultTheme];
  if (fallback === undefined) {
    const first = Object.keys(options.themes)[0];
    if (first === undefined) throw new Error('Config `themes` is empty; declare at least one theme.');
    return { theme: { name: first, ...options.themes[first] } };
  }
  return { theme: { name: options.defaultTheme, mode: fallback.mode, palette: fallback.palette } };
}

/**
 * Build the replayable presentation metadata from the canonical value. Colour
 * is stored as a palette INDEX, never a hex, so changing the theme re-colours a
 * replayed card without rewriting history.
 */
export function buildPresentationMeta(
  value: ChartCanonicalValue,
  options: MetaOptions,
): ChartPresentationMeta {
  const { theme, warning } = resolveThemeMeta(options);
  let downsampled = false;
  const series: ChartSeriesMeta[] = value.series.map((entry, index) => {
    const points = options.maxPoints > 0 && entry.points.length > options.maxPoints
      ? downsample(entry.points, options.maxPoints)
      : entry.points;
    if (points !== entry.points) downsampled = true;
    return {
      name: entry.name,
      colorIndex: index % Math.max(1, theme.palette.series.length),
      points: points.map((point) => [point.x, point.y]),
      downsampled: points !== entry.points,
    };
  });

  const hintParts: string[] = [];
  if (warning !== undefined) hintParts.push(`${warning}；已回退到主题 "${theme.name}"。`);
  if (value.truncated) hintParts.push('数据已按 limit 或输出上限截断。');
  const hint = hintParts.length > 0 ? hintParts.join('') : undefined;

  return {
    schemaVersion: 1,
    chartId: value.chartId,
    chartType: value.type,
    ...(value.title !== undefined ? { title: value.title } : {}),
    ...(value.subtitle !== undefined ? { subtitle: value.subtitle } : {}),
    encoding: value.encoding,
    series,
    axes: value.axes ?? { yFields: value.encoding.y },
    ...(value.annotations !== undefined ? { annotations: value.annotations } : {}),
    ...(value.stats !== undefined ? { stats: value.stats } : {}),
    truncated: value.truncated,
    ...(value.total !== undefined ? { total: value.total } : {}),
    height: options.height,
    stack: options.stack,
    theme,
    downsampled,
    ...(hint !== undefined ? { hint } : {}),
  };
}

/** Merge a base theme palette with the user's `Config.themeOverrides` entry. */
export function applyThemeOverride(
  base: { mode: 'light' | 'dark'; palette: ChartPaletteMeta },
  override: Partial<ChartPaletteMeta> | undefined,
): { mode: 'light' | 'dark'; palette: ChartPaletteMeta } {
  if (override === undefined) return base;
  return {
    mode: base.mode,
    palette: {
      series: override.series ?? base.palette.series,
      positive: override.positive ?? base.palette.positive,
      negative: override.negative ?? base.palette.negative,
      axis: override.axis ?? base.palette.axis,
      grid: override.grid ?? base.palette.grid,
      label: override.label ?? base.palette.label,
      bg: override.bg ?? base.palette.bg,
      ...(override.fontFamily !== undefined || base.palette.fontFamily !== undefined
        ? { fontFamily: override.fontFamily ?? base.palette.fontFamily }
        : {}),
      fontSize: override.fontSize ?? base.palette.fontSize,
    },
  };
}

export interface PresentCallArgs {
  type?: string;
  title?: string;
  x?: string;
  y?: string | string[];
  series?: string;
  color?: string;
  data?: unknown[];
  dataRef?: string;
}

/**
 * Pending-card intent. Runs before `execute`, so it has no data: it describes
 * only what is about to be drawn. Returns a plain `GenericCallView`; the Web
 * client ignores host presenters and keys its own card off the tool name.
 */
export function presentChartCall(args: PresentCallArgs) {
  const type = typeof args.type === 'string' ? args.type : undefined;
  const label = type !== undefined ? (TYPE_LABEL[type] ?? type) : '图表';
  const title = typeof args.title === 'string' && args.title.length > 0 ? args.title : label;
  const mapping: string[] = [];
  if (typeof args.x === 'string' && args.x.length > 0) mapping.push(`x=${args.x}`);
  const yFields = Array.isArray(args.y) ? args.y : typeof args.y === 'string' ? [args.y] : [];
  if (yFields.length > 0) mapping.push(`y=${yFields.join(',')}`);
  if (typeof args.series === 'string' && args.series.length > 0) mapping.push(`series=${args.series}`);
  if (typeof args.color === 'string' && args.color.length > 0) mapping.push(`color=${args.color}`);
  const rows = Array.isArray(args.data) ? `${args.data.length} 行` : typeof args.dataRef === 'string' ? 'dataRef' : '无数据';
  return {
    card: 'generic' as const,
    title: `绘制${label}：${title}`,
    kind: 'execute' as const,
    rawInput: `${rows}${mapping.length > 0 ? ` · ${mapping.join(' · ')}` : ''}`,
  };
}

/**
 * Result-card intent. Only used by host-local consumers; the Web client draws
 * the card from `meta` instead. Malformed or absent metadata degrades to
 * `undefined` so a replay never throws.
 */
export function presentChartResult(_args: unknown, result: ToolResult) {
  if (result.isError === true) return undefined;
  const meta = result.meta;
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined;
  const metaRecord = meta as Record<string, unknown>;
  if (metaRecord.schemaVersion !== 1) return undefined;
  const chartType = typeof metaRecord.chartType === 'string' ? metaRecord.chartType : 'chart';
  const title = typeof metaRecord.title === 'string' ? metaRecord.title : undefined;
  const series = Array.isArray(metaRecord.series) ? metaRecord.series.length : 0;
  const truncated = metaRecord.truncated === true;
  return {
    card: 'generic' as const,
    title: `${title ?? TYPE_LABEL[chartType] ?? chartType}（${series} 个系列${truncated ? '，已截断' : ''}）`,
  };
}
