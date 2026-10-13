/**
 * Public type surface of `dsh-tool-chart` (host half).
 *
 * Hand-maintained: the deployment has no TypeScript compiler, so these
 * declarations are the contract rather than a compiler product. They mirror
 * `src/index.ts`, `src/schema.ts` and `src/transform.ts`.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools';

export declare const name: 'tool-chart';
export declare const inject: readonly ['tools'];

/** Shape of one palette; every field is optional in an override. */
export interface ChartPaletteConfig {
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

export interface ChartThemeConfig {
  mode: 'light' | 'dark';
  palette: ChartPaletteConfig;
}

/** Plugin configuration; every field has a default in the Config schema. */
export interface ChartPluginConfig {
  defaultTheme: string;
  themes: Record<string, ChartThemeConfig>;
  themeOverrides: Record<string, Partial<ChartPaletteConfig>>;
  enabledTypes: string[];
  maxInlineRows: number;
  maxPointsPerSeries: number;
  maxSeries: number;
  defaultLimit: number;
  maxOutputPoints: number;
  defaultHeight: number;
  minHeight: number;
  maxHeight: number;
  defaultAnnotations: Array<{ x: string | number; text: string; kind?: 'line' | 'band' }>;
  dataRefMode: 'spill-path' | 'none';
  chartIdPrefix: string;
}

/**
 * Schemastery schema. It is callable: `Config(input)` validates the value and
 * fills defaults, throwing on an illegal value. Dynamic key sets (theme names,
 * enabled chart types) cannot be expressed in the schema, so `apply` performs
 * those self-completeness checks and throws before registering anything.
 */
export declare const Config: (input?: Partial<ChartPluginConfig>) => ChartPluginConfig;

export declare const parameters: ParameterSchemaSpec;
export declare const outputSchema: ValueSchemaSpec;

/** Registers the `chart` tool. Registration is a side effect of the fiber. */
export declare function apply(ctx: Context, config: ChartPluginConfig): void;
