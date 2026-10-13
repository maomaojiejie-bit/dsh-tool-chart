/**
 * Pure data-shaping core of the `chart` tool: long -> wide pivoting, sorting,
 * truncation, numeric coercion, statistics and downsampling.
 *
 * Nothing here touches the filesystem, the clock or the session, so every
 * function is unit-testable on plain objects. The one impure dependency — the
 * `dataRef` reader — is injected by the caller.
 */

export const CHART_TYPES = [
  'line',
  'bar',
  'area',
  'scatter',
  'pie',
  'heatmap',
  'candlestick',
  'boxplot',
] as const;

export type ChartType = (typeof CHART_TYPES)[number];

export const OHLC_FIELDS = ['open', 'high', 'low', 'close'] as const;

export type PointValue = number | number[];

export interface ChartPoint {
  x: string | number;
  y: PointValue;
  label?: string;
}

export interface ChartSeries {
  name: string;
  points: ChartPoint[];
}

export interface SeriesStats {
  count: number;
  min?: number;
  max?: number;
  mean?: number;
  sum?: number;
  first?: number;
  last?: number;
  change?: number;
}

export interface ChartCanonicalValue {
  chartId: string;
  type: ChartType;
  title?: string;
  subtitle?: string;
  encoding: { x?: string; y?: string[]; series?: string; color?: string };
  series: ChartSeries[];
  axes?: { xLabel?: string; yLabel?: string; yMin?: number; yMax?: number };
  annotations?: Array<{ x: string | number; text: string; kind?: 'line' | 'band' }>;
  stats?: Record<string, SeriesStats>;
  truncated: boolean;
  total: number;
}

export interface ChartArgs {
  type?: string;
  title?: string;
  subtitle?: string;
  data?: unknown;
  dataRef?: string;
  x?: string;
  y?: string | string[];
  series?: string;
  color?: string;
  stack?: boolean;
  sort?: 'none' | 'asc' | 'desc';
  limit?: number;
  axes?: { xLabel?: string; yLabel?: string; yMin?: number; yMax?: number };
  annotations?: Array<{ x: string | number; text: string; kind?: 'line' | 'band' }>;
  theme?: string;
  height?: number;
}

export interface ChartError {
  /** Argument the caller must fix, when the failure is traceable to one. */
  field?: string;
  message: string;
  hint?: string;
}

export interface BuildOptions {
  config: {
    maxInlineRows: number;
    maxSeries: number;
    defaultLimit: number;
    maxOutputPoints: number;
    enabledTypes: readonly ChartType[];
    chartIdPrefix: string;
  };
  readDataRef(locator: string): Promise<string | null>;
  signal?: AbortSignal;
}

export type BuildOutcome = { ok: true; value: ChartCanonicalValue } | { ok: false; error: ChartError };

class BuildFailure extends Error {
  readonly error: ChartError;

  constructor(error: ChartError) {
    super(error.message);
    this.error = error;
  }
}

function fail(field: string | undefined, message: string, hint?: string): never {
  throw new BuildFailure(hint === undefined ? { field, message } : { field, message, hint });
}

/* --------------------------------------------------------------- ingestion */

interface Table {
  headers: string[];
  rows: Array<Record<string, unknown>>;
  /** All rows before any `limit` truncation; used for column validation. */
  rawRows: Array<Record<string, unknown>>;
  /** Rows present before any `limit` truncation. */
  total: number;
}

function sourceLabel(args: ChartArgs): string {
  if (args.dataRef !== undefined) return 'dataRef';
  return 'data';
}

function normalizeRows(rawRows: unknown[], label: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let index = 0; index < rawRows.length; index += 1) {
    const row = rawRows[index];
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      fail(
        label,
        `${label} 的第 ${index} 行不是对象（收到 ${Array.isArray(row) ? 'array' : typeof row}）。`,
        '每一行必须是「字段 → 标量」的扁平对象，例如 {"month":"2026-01","gmv":1240000}。',
      );
    }
    rows.push(row as Record<string, unknown>);
  }
  return rows;
}

function headersOf(rows: Array<Record<string, unknown>>): string[] {
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  return headers;
}

/** Parse a spill file body: JSON array, JSON Lines, or CSV. */
export function parseDelimited(text: string, label: string): Array<Record<string, unknown>> {
  const trimmed = text.trim();
  if (trimmed.length === 0) fail(label, `${label} 指向的文件是空的。`);
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      fail(label, `${label} 指向的文件不是合法 JSON：${(error as Error).message}`);
    }
    if (!Array.isArray(parsed)) fail(label, `${label} 指向的 JSON 不是行数组。`);
    return normalizeRows(parsed as unknown[], label);
  }
  if (trimmed.startsWith('{')) {
    // One document (or an envelope), or JSON Lines. Try the whole body first and
    // fall through to the line-wise reader instead of rejecting it outright.
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        for (const key of ['data', 'rows', 'records', 'items', 'value']) {
          if (Array.isArray(record[key])) return normalizeRows(record[key] as unknown[], label);
        }
        return normalizeRows([record], label);
      }
      if (Array.isArray(parsed)) return normalizeRows(parsed, label);
    } catch {
      // Not a single document: handled by the JSON Lines branch below.
    }
  }

  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) fail(label, `${label} 指向的文件没有可用行。`);
  const first = lines[0];
  if (!first.startsWith('{')) {
    const headers = splitDelimitedRow(first);
    if (headers.length === 0) fail(label, `${label} 指向的 CSV 没有表头行。`);
    const rows: Array<Record<string, unknown>> = [];
    for (let index = 1; index < lines.length; index += 1) {
      const cells = splitDelimitedRow(lines[index]);
      const row: Record<string, unknown> = {};
      for (let column = 0; column < headers.length; column += 1) {
        row[headers[column]] = coerceScalar(cells[column]);
      }
      rows.push(row);
    }
    return rows;
  }

  const rows: Array<Record<string, unknown>> = [];
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const parsed: unknown = JSON.parse(lines[index]);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail(label, `${label} 的第 ${index + 1} 行不是 JSON 对象。`);
      }
      rows.push(parsed as Record<string, unknown>);
    } catch (error) {
      if (error instanceof BuildFailure) throw error;
      fail(label, `${label} 的第 ${index + 1} 行不是合法 JSON：${(error as Error).message}`);
    }
  }
  return rows;
}

function splitDelimitedRow(line: string): string[] {
  const delimiter = line.includes('\t') ? '\t' : ',';
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === delimiter) {
      cells.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function coerceScalar(raw: string | undefined): unknown {
  if (raw === undefined || raw === '') return null;
  const lowered = raw.toLowerCase();
  if (lowered === 'null' || lowered === 'na' || lowered === 'nan') return null;
  if (lowered === 'true') return true;
  if (lowered === 'false') return false;
  const numericValue = Number(raw);
  if (raw.trim().length > 0 && Number.isFinite(numericValue)) return numericValue;
  return raw;
}

/* ------------------------------------------------------------------ values */

function isRowObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed.replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  return null;
}

function fieldList(args: ChartArgs): string[] {
  if (Array.isArray(args.y)) return args.y.filter((entry) => typeof entry === 'string' && entry.length > 0);
  if (typeof args.y === 'string' && args.y.length > 0) return [args.y];
  return [];
}

function columnSamples(table: Table, field: string, limit: number): unknown[] {
  const samples: unknown[] = [];
  for (const row of table.rows) {
    const value = row[field];
    if (value === undefined || value === null) continue;
    samples.push(value);
    if (samples.length >= limit) break;
  }
  return samples;
}

function assertColumn(
  table: Table,
  field: string,
  role: string,
  parameter: string,
  numeric: boolean,
): void {
  const available = table.headers.length > 0 ? table.headers.join(', ') : '(无字段)';
  const definedCount = table.rawRows.filter((row) => row[field] !== undefined).length;
  const presentCount = table.rawRows.filter((row) => row[field] !== undefined && row[field] !== null).length;
  if (definedCount === 0) {
    fail(parameter, `${role}字段 "${field}" 在数据中不存在；可用字段：${available}。`);
  }
  if (presentCount === 0) {
    fail(parameter, `${role}字段 "${field}" 在所有行里都是空值；可用字段：${available}。`);
  }
  if (presentCount < table.rawRows.length) {
    fail(
      parameter,
      `${role}字段 "${field}" 只在部分行中出现（${presentCount}/${table.rawRows.length} 行），无法作为稳定的${role}。`,
      `补齐缺失的 "${field}" 值，或改用其他字段。`,
    );
  }
  if (!numeric) return;
  const samples = columnSamples(table, field, 200);
  if (samples.filter((value) => toNumber(value) !== null).length === 0) {
    fail(
      parameter,
      `${role}字段 "${field}" 无法解析为数字（样例：${samples.slice(0, 3).map((value) => JSON.stringify(value)).join(', ')}）。`,
      '确认该字段是度量值而不是文本标签。',
    );
  }
}

/* ---------------------------------------------------------------- category */

type Category = { value: string | number; sortKey: number | string; firstIndex: number };

function buildCategories(table: Table, xField: string | undefined, sort: ChartArgs['sort']): Category[] {
  if (xField === undefined) {
    return table.rows.map((_row, index) => ({ value: index, sortKey: index, firstIndex: index }));
  }
  const byKey = new Map<string, Category>();
  table.rows.forEach((row, index) => {
    const raw = row[xField];
    if (raw === undefined || raw === null) return;
    const key = String(raw);
    if (byKey.has(key)) return;
    const asNumber = toNumber(raw);
    byKey.set(key, {
      value: typeof raw === 'number' ? raw : key,
      sortKey: asNumber !== null ? asNumber : key,
      firstIndex: index,
    });
  });
  const categories = [...byKey.values()];
  if (sort === 'asc' || sort === 'desc') {
    const direction = sort === 'asc' ? 1 : -1;
    categories.sort((left, right) => {
      if (typeof left.sortKey === 'number' && typeof right.sortKey === 'number') {
        return (left.sortKey - right.sortKey) * direction;
      }
      return String(left.sortKey).localeCompare(String(right.sortKey)) * direction;
    });
  } else {
    categories.sort((left, right) => left.firstIndex - right.firstIndex);
  }
  return categories;
}

/* ------------------------------------------------------------------- build */

function buildSeriesFor(
  type: ChartType,
  table: Table,
  categories: Category[],
  xField: string | undefined,
  yFields: string[],
  groupField: string | undefined,
  maxSeries: number,
  rowField: string | undefined = undefined,
): { series: ChartSeries[]; truncated: boolean } {
  const heatmapValueField = rowField ?? yFields[0] ?? '';
  const series: ChartSeries[] = [];
  let truncated = false;

  if (type === 'heatmap') {
    // `groupField` is the ROW dimension (the distinct values of `y`), and
    // `heatmapValueField` holds the value that colours the cell.
    const rowValues = groupField === undefined ? [] : uniqueValues(table, groupField);
    const hasRows = rowValues.length > 0;
    const selected: Array<string | number | null> = rowValues.slice(0, Math.max(1, maxSeries));
    if (selected.length < rowValues.length) truncated = true;
    const buckets = new Map<string, Map<string, number>>();
    for (const rowValue of selected) {
      buckets.set(rowValue === null ? '\u0000' : String(rowValue), new Map());
    }
    for (const row of table.rows) {
      const rowKey = !hasRows
        ? '\u0000'
        : row[groupField as string] === undefined || row[groupField as string] === null
          ? '\u0000'
          : String(row[groupField as string]);
      const bucket = buckets.get(rowKey);
      if (bucket === undefined) continue;
      const value = toNumber(row[heatmapValueField]);
      if (value === null) continue;
      const categoryValue = xField === undefined ? '' : row[xField];
      if (categoryValue === undefined || categoryValue === null) continue;
      bucket.set(String(categoryValue), value);
    }
    for (const rowValue of selected) {
      const bucket = buckets.get(rowValue === null ? '\u0000' : String(rowValue));
      if (bucket === undefined || bucket.size === 0) continue;
      const points: ChartPoint[] = [];
      for (const category of categories) {
        const value = bucket.get(String(category.value));
        if (value === undefined) continue;
        points.push({ x: category.value, y: value });
      }
      if (points.length === 0) continue;
      series.push({ name: hasRows ? String(rowValue) : heatmapValueField, points });
    }
    return { series, truncated };
  }

  if (type === 'candlestick') {
    const points: ChartPoint[] = [];
    for (const category of categories) {
      const row = rowFor(table, xField, category.value);
      if (row === undefined) continue;
      const values = yFields.map((field) => toNumber(row[field]));
      if (values.some((value) => value === null)) continue;
      const open = values[0] as number;
      const high = values[1] as number;
      const low = values[2] as number;
      const close = values[3] as number;
      points.push({ x: category.value, y: [open, close, low, high] });
    }
    if (points.length > 0) series.push({ name: yFields.join('/'), points });
    return { series, truncated: false };
  }

  if (type === 'boxplot') {
    const field = yFields[0];
    const points: ChartPoint[] = [];
    for (const category of categories) {
      const values: number[] = [];
      for (const row of rowsFor(table, xField, category.value)) {
        const value = toNumber(row[field]);
        if (value !== null) values.push(value);
      }
      if (values.length === 0) continue;
      values.sort((left, right) => left - right);
      points.push({ x: category.value, y: boxplotSummary(values) });
    }
    if (points.length > 0) series.push({ name: field, points });
    return { series, truncated: false };
  }

  if (groupField !== undefined) {
    const groupValues = uniqueValues(table, groupField);
    const selected = groupValues.slice(0, Math.max(1, maxSeries));
    if (selected.length < groupValues.length) truncated = true;
    for (const groupValue of selected) {
      const grouped = table.rows.filter((row) => String(row[groupField]) === String(groupValue));
      yFields.forEach((field, fieldIndex) => {
        const points: ChartPoint[] = [];
        for (const category of categories) {
          const values: number[] = [];
          for (const row of grouped) {
            if (xField !== undefined && String(row[xField]) !== String(category.value)) continue;
            const value = toNumber(row[field]);
            if (value !== null) values.push(value);
          }
          if (values.length === 0) continue;
          points.push({ x: category.value, y: values.reduce((sum, value) => sum + value, 0) / values.length });
        }
        if (points.length > 0) {
          series.push({ name: yFields.length > 1 ? `${String(groupValue)} · ${field}` : String(groupValue), points });
        }
        void fieldIndex;
      });
    }
    return { series, truncated };
  }

  for (const field of yFields) {
    const points: ChartPoint[] = [];
    for (const category of categories) {
      const values: number[] = [];
      for (const row of rowsFor(table, xField, category.value)) {
        const value = toNumber(row[field]);
        if (value !== null) values.push(value);
      }
      if (values.length === 0) continue;
      points.push({ x: category.value, y: values.reduce((sum, value) => sum + value, 0) / values.length });
    }
    if (points.length > 0) series.push({ name: field, points });
  }
  return { series, truncated };
}

function uniqueValues(table: Table, field: string): Array<string | number> {
  const seen = new Set<string>();
  const values: Array<string | number> = [];
  for (const row of table.rows) {
    const raw = row[field];
    if (raw === undefined || raw === null) continue;
    const key = String(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(typeof raw === 'number' ? raw : key);
  }
  return values;
}

function rowsFor(table: Table, xField: string | undefined, categoryValue: string | number): Array<Record<string, unknown>> {
  if (xField === undefined) {
    return typeof categoryValue === 'number' && categoryValue < table.rows.length ? [table.rows[categoryValue]] : [];
  }
  return table.rows.filter((row) => String(row[xField]) === String(categoryValue));
}

function rowFor(table: Table, xField: string | undefined, categoryValue: string | number): Record<string, unknown> | undefined {
  return rowsFor(table, xField, categoryValue)[0];
}

/** [min, Q1, median, Q3, max] — the five numbers the client draws as a box. */
export function boxplotSummary(sorted: number[]): number[] {
  const at = (fraction: number): number => {
    if (sorted.length === 1) return sorted[0];
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.min(sorted.length - 1, lower + 1);
    const weight = position - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  };
  return [sorted[0], at(0.25), at(0.5), at(0.75), sorted[sorted.length - 1]];
}

/* --------------------------------------------------------------- statistics */

export function computeStats(points: ChartPoint[]): SeriesStats {
  const values: number[] = [];
  for (const point of points) {
    if (typeof point.y === 'number') values.push(point.y);
    else if (Array.isArray(point.y) && point.y.length > 0) values.push(point.y[0]);
  }
  if (values.length === 0) return { count: 0 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const sum = values.reduce((total, value) => total + value, 0);
  const first = values[0];
  const last = values[values.length - 1];
  const stats: SeriesStats = { count: values.length, min, max, mean: sum / values.length, sum, first, last };
  if (first !== 0) stats.change = (last - first) / Math.abs(first);
  return stats;
}

/** Largest-Triangle-Three-Buckets downsampling; returns the input when it is short enough. */
export function downsample(points: ChartPoint[], threshold: number): ChartPoint[] {
  if (threshold >= points.length || threshold < 3) return points;
  const sampled: ChartPoint[] = [points[0]];
  const every = (points.length - 2) / (threshold - 2);
  let anchor = 0;
  for (let bucket = 0; bucket < threshold - 2; bucket += 1) {
    const rangeStart = Math.floor((bucket + 1) * every) + 1;
    const rangeEnd = Math.min(Math.floor((bucket + 2) * every) + 1, points.length);
    let averageX = 0;
    let averageY = 0;
    let count = 0;
    for (let index = rangeStart; index < rangeEnd; index += 1) {
      const numeric = typeof points[index].y === 'number' ? (points[index].y as number) : Number.NaN;
      if (Number.isFinite(numeric)) {
        averageY += numeric;
        count += 1;
      }
      averageX += typeof points[index].x === 'number' ? (points[index].x as number) : index;
    }
    if (count > 0) averageY /= count;
    if (rangeEnd > rangeStart) averageX /= rangeEnd - rangeStart;
    const anchorY = typeof points[anchor].y === 'number' ? (points[anchor].y as number) : Number.NaN;
    const anchorX = typeof points[anchor].x === 'number' ? (points[anchor].x as number) : anchor;
    let bestArea = -1;
    let bestIndex = rangeStart;
    for (let index = rangeStart; index < rangeEnd; index += 1) {
      const y = typeof points[index].y === 'number' ? (points[index].y as number) : Number.NaN;
      if (!Number.isFinite(y)) continue;
      const x = typeof points[index].x === 'number' ? (points[index].x as number) : index;
      const area = Math.abs((anchorX - averageX) * (y - anchorY) - (anchorX - x) * (averageY - anchorY));
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

/* ------------------------------------------------------------------ entry */

export async function buildChart(args: ChartArgs, options: BuildOptions): Promise<BuildOutcome> {
  try {
    const type = args.type as ChartType | undefined;
    if (type === undefined || !CHART_TYPES.includes(type)) {
      fail('type', `不支持的图表类型 ${JSON.stringify(args.type)}；可用类型：${CHART_TYPES.join(', ')}。`);
    }
    if (!options.config.enabledTypes.includes(type)) {
      fail('type', `本部署已禁用图表类型 "${type}"；可用类型：${options.config.enabledTypes.join(', ')}。`);
    }
    if (args.data !== undefined && args.dataRef !== undefined) {
      fail('dataRef', '`data` 与 `dataRef` 只能提供其中一个。', '行数少时用 data，数据较多时用 dataRef。');
    }
    if (args.data === undefined && args.dataRef === undefined) {
      fail('data', '缺少数据：请提供 `data`（内联行）或 `dataRef`（spill 文件路径）。');
    }

    let rawRows: Array<Record<string, unknown>>;
    if (args.dataRef !== undefined) {
      const text = await options.readDataRef(args.dataRef);
      if (text === null) {
        fail(
          'dataRef',
          `无法读取 dataRef "${args.dataRef}"。`,
          'dataRef 只支持 spill 文件定位符（本地文件路径）；表达式引用（例如 $.steps[2]...）尚未实现，请改用内联 data。',
        );
      }
      rawRows = parseDelimited(text, 'dataRef');
    } else {
      if (!Array.isArray(args.data)) fail('data', '`data` 必须是对象数组。');
      const rows = args.data as unknown[];
      if (rows.length === 0) fail('data', '数据为空：至少需要 1 行。', '先确认上游工具确实返回了行。');
      if (rows.length > options.config.maxInlineRows) {
        fail(
          'data',
          `内联数据 ${rows.length} 行超过上限 ${options.config.maxInlineRows} 行。`,
          '把结果写入 spill 文件后改用 dataRef，或在 Config 中提高 maxInlineRows。',
        );
      }
      rawRows = normalizeRows(rows, 'data');
    }
    if (rawRows.length === 0) fail('data', '数据为空：至少需要 1 行。');

    const headers = headersOf(rawRows);
    let rows = rawRows;
    const effectiveLimit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : options.config.defaultLimit;
    let truncated = false;
    if (effectiveLimit > 0 && rows.length > effectiveLimit) {
      rows = rows.slice(0, effectiveLimit);
      truncated = true;
    }
    const table: Table = { headers, rows, rawRows, total: rawRows.length };

    const yFields = resolveYFields(args, type);
    // A heatmap's `y` names the row dimension, not a measure: it is the `color`
    // field that carries the value, so `y` only has to exist.
    const dimensionField = type === 'heatmap' ? yFields[0] : undefined;
    for (const field of yFields) {
      assertColumn(table, field, '数值', 'y', field !== dimensionField);
    }
    if (args.series !== undefined) assertColumn(table, args.series, '分组', 'series', false);
    if (args.color !== undefined) {
      assertColumn(table, args.color, '色彩', 'color', type === 'heatmap' || type === 'scatter');
    }
    if (type === 'heatmap') {
      if (typeof args.color !== 'string' || args.color.length === 0) {
        fail('color', 'heatmap 需要 `color` 指定用于着色的数值字段。', '例如 "color": "load"，并让 `y` 指定行维度、`x` 指定列维度。');
      }
      if (dimensionField === args.color) {
        fail('color', 'heatmap 的 `color` 与 `y` 指向同一字段。', '让 `y` 指定行维度字段、`color` 指定数值字段。');
      }
    }
    if (type === 'scatter' && args.color !== undefined && yFields.includes(args.color)) {
      fail('color', 'scatter 的 `color` 不能与 `y` 相同；它用于映射点的大小或色阶。');
    }

    assertSingleValue(args, type, yFields);
    const groupField = args.series;
    if (groupField !== undefined && yFields.length > 1) {
      fail('series', '`series` 分组不能与数组形式的 `y` 同时使用。', '要么用 `series` 分组，要么在 `y` 中列出多个字段。');
    }
    if ((type === 'pie' || type === 'heatmap') && args.x === undefined) {
      fail('x', `${type} 需要 \`x\` 指定类别字段。`);
    }
    if (args.x !== undefined) assertColumn(table, args.x, '类别', 'x', false);

    const xField = args.x;
    const categories = buildCategories(table, xField, args.sort ?? 'none');
    if (categories.length === 0) {
      fail('x', `类别字段 "${xField ?? '(行号)'}" 没有产生任何类别值。`);
    }

    // A heatmap's rows are the distinct values of its `y` dimension and its
    // cells are coloured by `color`; other types group by `series`.
    const rowDimension = type === 'heatmap' ? yFields[0] : groupField;
    const built = buildSeriesFor(
      type,
      table,
      categories,
      xField,
      yFields,
      rowDimension,
      options.config.maxSeries,
      type === 'heatmap' ? args.color : undefined,
    );
    let series = built.series.filter((entry) => entry.points.length > 0);
    truncated = truncated || built.truncated;
    if (series.length === 0) {
      fail('y', '数据中没有该图表类型可用的数据点。', '检查 `x`/`y` 的字段映射是否与数据列一致。');
    }
    if (series.length > options.config.maxSeries) {
      series = series.slice(0, options.config.maxSeries);
      truncated = true;
    }

    const pointCount = series.reduce((sum, entry) => sum + entry.points.length, 0);
    if (pointCount > options.config.maxOutputPoints) {
      fail(
        'limit',
        `结果包含 ${pointCount} 个数据点，超过上限 ${options.config.maxOutputPoints}。`,
        '提高聚合粒度（例如按天而不是按秒），或用 limit 与更少的系列缩小结果。',
      );
    }

    const stats: Record<string, SeriesStats> = {};
    for (const entry of series) stats[entry.name] = computeStats(entry.points);

    const annotations = normalizeAnnotations(args, categories);
    const encoding: ChartCanonicalValue['encoding'] = {};
    if (xField !== undefined) encoding.x = xField;
    encoding.y = yFields;
    if (groupField !== undefined) encoding.series = groupField;
    if (args.color !== undefined) encoding.color = args.color;

    const value: ChartCanonicalValue = {
      chartId: `${options.config.chartIdPrefix}-${slug(args.title ?? type)}-${pointCount}`,
      type,
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.subtitle !== undefined ? { subtitle: args.subtitle } : {}),
      encoding,
      series,
      ...(args.axes !== undefined ? { axes: args.axes } : {}),
      ...(annotations !== undefined ? { annotations } : {}),
      stats,
      truncated,
      total: pointCount,
    };
    return { ok: true, value };
  } catch (error) {
    if (error instanceof BuildFailure) return { ok: false, error: error.error };
    throw error;
  }
}

function resolveYFields(args: ChartArgs, type: ChartType): string[] {
  const explicit = fieldList(args);
  if (type === 'candlestick') {
    if (explicit.length === 0) {
      fail('y', 'candlestick 需要 `y` 给出四个字段，顺序为 [open, high, low, close]。', '例如 "y": ["open","high","low","close"]。');
    }
    if (explicit.length !== 4) {
      fail('y', `candlestick 的 \`y\` 必须是 4 个字段 [open, high, low, close]，收到 ${explicit.length} 个。`);
    }
    return explicit;
  }
  if (type === 'boxplot') {
    if (explicit.length < 1) {
      fail('y', 'boxplot 需要 `y` 给出用于分箱的数值字段列表。', '例如 "y": ["latency"]。');
    }
    return explicit;
  }
  if (explicit.length === 0) {
    fail('y', `${type} 需要 \`y\` 指定至少一个数值字段。`, '先查看数据中的字段名，例如 "y": "gmv"。');
  }
  return explicit;
}

function assertSingleValue(args: ChartArgs, type: ChartType, yFields: string[]): void {
  if (type !== 'pie' && type !== 'heatmap') return;
  if (yFields.length !== 1) {
    fail('y', `${type} 只接受一个数值字段，收到 ${yFields.length} 个。`, '去掉多余的 y 字段。');
  }
  if (args.series !== undefined) {
    fail('series', `${type} 不支持 \`series\` 分组，请直接提供 category 与 value 两列。`);
  }
  if (args.stack === true) {
    fail('stack', `${type} 不支持堆叠。`);
  }
}

function slug(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 24) : 'chart';
}

function normalizeAnnotations(args: ChartArgs, categories: Category[]): ChartCanonicalValue['annotations'] {
  const annotations = args.annotations;
  if (annotations === undefined || annotations.length === 0) return undefined;
  const known = new Set(categories.map((category) => String(category.value)));
  const resolved: NonNullable<ChartCanonicalValue['annotations']> = [];
  for (const annotation of annotations) {
    const kind = annotation.kind !== undefined ? { kind: annotation.kind } : {};
    if (typeof annotation.x === 'number') {
      resolved.push({ x: annotation.x, text: annotation.text, ...kind });
      continue;
    }
    if (known.has(String(annotation.x))) {
      resolved.push({ x: annotation.x, text: annotation.text, ...kind });
      continue;
    }
    const numeric = toNumber(annotation.x);
    if (numeric !== null) {
      resolved.push({ x: numeric, text: annotation.text, ...kind });
      continue;
    }
    fail(
      'annotations',
      `注释位置 "${annotation.x}" 既不是已有类别，也不是数字。`,
      `已有类别：${[...known].slice(0, 12).join(', ')}${known.size > 12 ? ' …' : ''}；或改用数字位置。`,
    );
  }
  return resolved;
}

