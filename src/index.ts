/**
 * `dsh-tool-chart` host half.
 *
 * Registers one model-facing tool, `chart`, which turns a declarative chart
 * spec into a canonical, replayable JSON value plus a compact text summary.
 * The interactive card lives in the client half (`./client`), which reads the
 * persisted `output.presentationMeta` projection carried by the tool result.
 *
 * Everything deployment-variable (theme names, palettes, enabled chart types,
 * data caps, defaults) is a Config field so a `cordis.patch.yml` layer can
 * change it without editing this file.
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { InferArgs, InferValue, ToolResult } from '@deepseek-ai/dsh-tools';
import Schema from '@deepseek-ai/schemastery';

import { buildChart, CHART_TYPES } from './transform.ts';
import type { ChartError } from './transform.ts';
import { outputSchema, parameters } from './schema.ts';
import { applyThemeOverride, buildPresentationMeta, presentChartCall, presentChartResult } from './present.ts';
import type { ChartPaletteMeta } from './present.ts';

export const name = 'tool-chart';
export const inject = ['tools'];

/** Chinese chart-type names for the model-facing summary. */
const TYPE_LABEL_ZH: Record<string, string> = {
  line: '折线图',
  bar: '柱状图',
  area: '面积图',
  scatter: '散点图',
  pie: '饼图',
  heatmap: '热力图',
  candlestick: 'K 线图',
  boxplot: '箱线图',
};

const PALETTE_KEYS = ['series', 'positive', 'negative', 'axis', 'grid', 'label', 'bg'] as const;

const colorList = Schema.array(Schema.string()).description('按顺序分配的颜色（CSS 颜色值）');

const paletteFields = {
  series: colorList.description('系列颜色，按系列索引循环分配'),
  positive: Schema.string().description('“上涨/正向”语义色（中国习惯为红）'),
  negative: Schema.string().description('“下跌/负向”语义色（中国习惯为绿）'),
  axis: Schema.string().description('坐标轴文字颜色（客户端优先使用主题令牌）'),
  grid: Schema.string().description('网格线颜色（客户端优先使用主题令牌）'),
  label: Schema.string().description('数据标签颜色（客户端优先使用主题令牌）'),
  bg: Schema.string().description('图表背景色（客户端优先使用主题令牌）'),
  fontFamily: Schema.string().description('图表字体族；留空则继承界面字体'),
  fontSize: Schema.number().description('图表基准字号（px）'),
};

const paletteSchema = Schema.object(paletteFields);

/** Same fields, nothing required: this is the partial-override shape. */
const paletteOverrideSchema = Schema.object({ ...paletteFields }).description('按主题名覆盖调色板局部字段（只写要改的键）');

const themeSchema = Schema.object({
  mode: Schema.union(['light', 'dark']).required(true).description('该主题属于浅色还是深色'),
  palette: paletteSchema.required(true).description('该主题使用的调色板（series 至少一项）'),
});

export const Config = Schema.object({
  defaultTheme: Schema.string().default('light').description('未显式传 theme 时使用的主题名，必须是 themes 的键'),
  themes: Schema.dict(themeSchema)
    .default({
      light: {
        mode: 'light',
        palette: {
          series: ['#2F6FED', '#F2A93B', '#2EA84F', '#9C5BD6', '#37A6C4', '#D9548B', '#7C8A3B'],
          positive: '#E64545',
          negative: '#2EA84F',
          axis: '#5B6068',
          grid: 'rgba(128,128,128,0.22)',
          label: '#3C4046',
          bg: '#FFFFFF',
          fontSize: 12,
        },
      },
      dark: {
        mode: 'dark',
        palette: {
          series: ['#6E9BFF', '#F5B95C', '#4CC47A', '#B77EF0', '#5FC7E0', '#F08BAE', '#A8B85C'],
          positive: '#E64545',
          negative: '#2EA84F',
          axis: '#9BA1AA',
          grid: 'rgba(200,200,200,0.18)',
          label: '#D5D8DD',
          bg: '#151517',
          fontSize: 12,
        },
      },
    })
    .description('可用主题表；键名即工具参数 theme 的取值'),
  themeOverrides: Schema.dict(paletteOverrideSchema)
    .default({})
    .description('按主题名覆盖调色板局部字段（只写要改的键）'),
  enabledTypes: Schema.array(Schema.union(CHART_TYPES))
    .default([...CHART_TYPES])
    .description('允许模型使用的图表类型；从列表移除即对该部署禁用'),
  maxInlineRows: Schema.number().default(5000).description('内联 data 允许的最大行数，超出即报错'),
  maxPointsPerSeries: Schema.number().default(2000).description('单系列保留的最大数据点数（超出按 LTTB 下采样）'),
  maxSeries: Schema.number().default(20).description('系列数上限；超出时截断并在结果中标记 truncated'),
  defaultLimit: Schema.number().default(5000).description('未传 limit 时单系列的点数上限'),
  maxOutputPoints: Schema.number().default(20000).description('一次调用允许写入结果的最大点数'),
  defaultHeight: Schema.number().default(320).description('未传 height 时卡片高度（px）'),
  minHeight: Schema.number().default(160).description('height 下限'),
  maxHeight: Schema.number().default(1200).description('height 上限'),
  defaultAnnotations: Schema.array(
    Schema.object({
      x: Schema.union([Schema.string(), Schema.number()]).required(true),
      text: Schema.string().required(true),
      kind: Schema.union(['line', 'band']),
    }),
  )
    .default([])
    .description('未传 annotations 时附加的默认注释'),
  dataRefMode: Schema.union(['spill-path', 'none'])
    .default('spill-path')
    .description('dataRef 的解释方式：spill-path 读取本地 spill 文件，none 直接拒绝 dataRef'),
  chartIdPrefix: Schema.string().default('chart').description('chartId 前缀，便于在日志中区分来源'),
});

export { parameters, outputSchema };

export function apply(ctx: Context, config: Config) {
  // ---- load-time self checks: illegal configuration must fail loudly here ----
  const themeNames = Object.keys(config.themes);
  if (themeNames.length === 0) throw new Error('[tool-chart] Config.themes 不能为空，至少要声明一个主题。');
  if (!themeNames.includes(config.defaultTheme)) {
    throw new Error(
      `[tool-chart] Config.defaultTheme "${config.defaultTheme}" 不在 Config.themes 中；可用值：${themeNames.join(', ')}`,
    );
  }
  for (const [themeName, override] of Object.entries(config.themeOverrides)) {
    if (!themeNames.includes(themeName)) {
      throw new Error(`[tool-chart] Config.themeOverrides 引用了未声明的主题 "${themeName}"。`);
    }
    for (const key of Object.keys(override)) {
      if (!PALETTE_KEYS.includes(key as (typeof PALETTE_KEYS)[number]) && key !== 'fontFamily' && key !== 'fontSize') {
        throw new Error(`[tool-chart] Config.themeOverrides.${themeName} 含未知调色板字段 "${key}"。`);
      }
    }
  }
  for (const [themeName, definition] of Object.entries(config.themes)) {
    const series = definition.palette.series;
    if (!Array.isArray(series) || series.length === 0) {
      throw new Error(`[tool-chart] Config.themes.${themeName}.palette.series 必须是非空的颜色数组。`);
    }
  }
  if (config.enabledTypes.length === 0) throw new Error('[tool-chart] Config.enabledTypes 不能为空。');
  for (const type of config.enabledTypes) {
    if (!CHART_TYPES.includes(type)) throw new Error(`[tool-chart] Config.enabledTypes 含未知图表类型 "${type}"。`);
  }
  if (config.maxSeries < 1) throw new Error('[tool-chart] Config.maxSeries 必须 >= 1。');
  if (config.maxPointsPerSeries < 3) throw new Error('[tool-chart] Config.maxPointsPerSeries 必须 >= 3（下采样需要至少 3 个点）。');
  if (config.defaultHeight < config.minHeight || config.defaultHeight > config.maxHeight) {
    throw new Error(
      `[tool-chart] Config.defaultHeight (${config.defaultHeight}) 必须落在 [minHeight=${config.minHeight}, maxHeight=${config.maxHeight}] 内。`,
    );
  }

  const themes: Record<string, { mode: 'light' | 'dark'; palette: ChartPaletteMeta }> = {};
  for (const [themeName, definition] of Object.entries(config.themes)) {
    themes[themeName] = applyThemeOverride(
      { mode: definition.mode, palette: definition.palette as ChartPaletteMeta },
      config.themeOverrides[themeName],
    );
  }

  ctx.tools.register(
    defineTool({
      name: 'chart',
      description: [
        'Render a declarative chart card in the dsh web conversation.',
        'Pass `type` plus either `data` (inline rows) or `dataRef` (a spill file path produced by an earlier tool),',
        'then map fields with `x`, `y`, optional `series`/`color`.',
        'Returns a compact text summary; the interactive chart (tooltip, legend toggle, PNG export) is drawn by the client card.',
        `Available types: ${CHART_TYPES.join(', ')}.`,
      ].join(' '),
      parameters,
      output: {
        schema: outputSchema,
        render(args: InferArgs<typeof parameters>, value: InferValue<typeof outputSchema>) {
          const lines: string[] = [];
          const title = value.title !== undefined && value.title.length > 0 ? value.title : value.chartId;
          const typeLabel = TYPE_LABEL_ZH[value.type] ?? value.type;
          const seriesNames = value.series.map((entry) => entry.name).join('/');
          lines.push(
            `已生成「${title}」${typeLabel}，含 ${value.series.length} 个系列（${seriesNames}）、共 ${value.total} 个数据点。`,
          );
          const stats = value.stats;
          if (stats !== undefined) {
            for (const entry of value.series) {
              const stat = stats[entry.name];
              if (stat === undefined) continue;
              const parts: string[] = [];
              if (typeof stat.mean === 'number') parts.push(`均值 ${formatStat(stat.mean)}`);
              if (typeof stat.change === 'number') {
                parts.push(`环比 ${stat.change >= 0 ? '+' : ''}${(stat.change * 100).toFixed(1)}%`);
              }
              if (typeof stat.min === 'number' && typeof stat.max === 'number') {
                parts.push(`区间 [${formatStat(stat.min)}, ${formatStat(stat.max)}]`);
              }
              if (typeof stat.sum === 'number') parts.push(`合计 ${formatStat(stat.sum)}`);
              if (parts.length > 0) lines.push(`${entry.name}：${parts.join('，')}`);
            }
          }
          if (value.truncated === true) {
            lines.push(`注意：结果已截断（原始 ${value.total} 个数据点），图表只包含已保留的部分。`);
          }
          lines.push('（完整数据见图表卡片；如需逐点数值可用 dataRef 引用或读取 spill 文件。）');
          void args;
          return [{ type: 'text', text: lines.join('\n') }];
        },
        presentationMeta(args: InferArgs<typeof parameters>, value: InferValue<typeof outputSchema>) {
          return buildPresentationMeta(value as never, {
            maxPoints: config.maxPointsPerSeries,
            height: clampHeight(
              typeof args.height === 'number' ? args.height : config.defaultHeight,
              config.minHeight,
              config.maxHeight,
            ),
            stack: args.stack === true,
            themes,
            defaultTheme: config.defaultTheme,
            ...(args.theme !== undefined ? { theme: args.theme } : {}),
          }) as never;
        },
      },
      presentCall(args: InferArgs<typeof parameters>) {
        return presentChartCall(args as never);
      },
      presentResult(_args: InferArgs<typeof parameters>, result: ToolResult) {
        return presentChartResult(_args, result);
      },
      async execute(args: InferArgs<typeof parameters>, exec) {
        const outcome = await buildChart(args as never, {
          config,
          async readDataRef(locator: string) {
            if (config.dataRefMode === 'none') return null;
            const fs = ctx.get('fs') as { readText?: (path: string, options?: { signal?: AbortSignal }) => Promise<string> } | undefined;
            if (fs === undefined || typeof fs.readText !== 'function') return null;
            return fs.readText(locator, exec.signal !== undefined ? { signal: exec.signal } : undefined);
          },
          signal: exec.signal,
        });
        if (!outcome.ok) throw chartError(outcome.error);
        return outcome.value as never;
      },
    }),
  );
}

function clampHeight(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function formatStat(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return String(Number(value.toFixed(4)));
}

function chartError(error: ChartError): Error {
  const where = error.field !== undefined ? `参数 \`${error.field}\`：` : '';
  const hint = error.hint !== undefined ? `\n提示：${error.hint}` : '';
  return new Error(`${where}${error.message}${hint}`);
}
