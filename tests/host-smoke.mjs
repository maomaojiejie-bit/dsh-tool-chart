/**
 * Host-half smoke test against the REAL `@deepseek-ai/dsh-tools` validators.
 *
 * Run with the resolver hook that maps `@deepseek-ai/*` to the desktop
 * deployment's app node_modules:
 *
 *   node --import ./tests/harness-resolver.mjs tests/host-smoke.mjs
 *
 * What it proves (the parts unit tests over `src/transform.ts` cannot):
 *  1. `Config` fills defaults and rejects an illegal config loudly.
 *  2. `apply(ctx, config)` registers exactly one tool whose `parameters` and
 *     `output.schema` were compiled by `defineTool` into raw JSON Schema.
 *  3. The canonical value returned by `execute` is accepted by the registry's
 *     own `validateJsonSchemaValue` against `tool.output.schema`.
 *  4. `output.render` returns text blocks and `output.presentationMeta` returns
 *     a JSON-safe projection carrying no React props and no hex colours in the
 *     colour-assignment slots.
 *  5. An argument-schema violation is rejected by `defineTool` (ToolArgsError)
 *     and a domain violation throws a readable Chinese Error.
 */
import assert from 'node:assert/strict';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { Config, apply, inject, name } from '../lib/index.js';

const failures = [];
function check(label, fn) {
  try {
    fn();
    console.log(`ok   ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    console.log(`FAIL ${label}: ${error.message}`);
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    console.log(`ok   ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    console.log(`FAIL ${label}: ${error.message}`);
  }
}

let registered;

/** Minimal stand-in for the host Context: `tools.register` plus `ctx.get('fs')`. */
function fakeContext() {
  registered = undefined;
  return {
    tools: {
      register(tool) {
        registered = tool;
        return () => {};
      },
    },
    get(serviceName) {
      if (serviceName !== 'fs') return undefined;
      return {
        async readText(locator) {
          return locator === 'rows.json' ? '[{"m":"a","v":1}]' : Promise.reject(new Error('ENOENT'));
        },
      };
    },
  };
}

/* 1. Config ----------------------------------------------------------------- */
let config;
check('Config({}) fills every default', () => {
  config = Config({});
  assert.equal(config.defaultTheme, 'light');
  assert.equal(config.maxSeries, 20);
  assert.equal(config.maxPointsPerSeries, 2000);
  assert.ok(config.themes.light && config.themes.dark, 'both themes must have defaults');
  assert.ok(Array.isArray(config.themes.light.palette.series));
  assert.equal(config.themes.light.palette.positive, '#E64545');
  assert.equal(config.themes.light.palette.negative, '#2EA84F');
  assert.deepEqual(config.enabledTypes.length, 8);
});

check('an illegal config fails loudly at load', () => {
  // A dynamic key set (theme names, enabled types) cannot be expressed in the
  // Config schema, so `apply` performs the self-completeness checks and throws
  // before registering anything.
  assert.throws(
    () => apply(fakeContext(), Config({ defaultTheme: 'nope' })),
    /未声明的主题|defaultTheme/,
  );
  assert.throws(
    () => apply(fakeContext(), Config({ enabledTypes: ['sunburst'] })),
    /未声明的图表类型|sunburst/,
  );
  assert.throws(() => apply(fakeContext(), Config({ maxSeries: 0 })), /maxSeries 必须 >= 1/);
  assert.throws(() => apply(fakeContext(), Config({ maxPointsPerSeries: 1 })), /maxPointsPerSeries/);
  assert.throws(
    () => apply(fakeContext(), Config({ themes: { light: { mode: 'light' } } })),
    /themes|palette|Expected/,
  );
  assert.equal(registered, undefined, 'a rejected config must not register a tool');
});

/* 2. registration ----------------------------------------------------------- */
check('apply registers one tool compiled to raw JSON Schema', () => {
  const ctx = fakeContext();
  apply(ctx, config);
  assert.equal(name, 'tool-chart');
  assert.deepEqual(inject, ['tools']);
  assert.ok(registered, 'apply must register a tool');
  assert.equal(registered.name, 'chart');
  assert.deepEqual(registered.parameters.type, 'object');
  assert.equal(registered.parameters.additionalProperties, undefined, 'the parameters root stays implicit');
  assert.equal(registered.parameters.properties.type.enum.length, 8);
  assert.deepEqual(registered.parameters.properties.y.oneOf.length, 2);
  assert.equal(registered.output.schema.type, 'object');
  assert.equal(registered.output.schema.additionalProperties, false);
  assert.deepEqual(registered.output.schema.required, ['chartId', 'type', 'encoding', 'series', 'truncated', 'total']);
  assert.equal(typeof registered.output.render, 'function');
  assert.equal(typeof registered.output.presentationMeta, 'function');
  assert.equal(typeof registered.presentCall, 'function');
  assert.equal(typeof registered.presentResult, 'function');
});

/* 3. execute + registry validation ------------------------------------------ */
const ROWS = [
  { m: '2026-01', online: 100, store: 40 },
  { m: '2026-02', online: 130, store: 55 },
  { m: '2026-03', online: 120, store: 60 },
];

await checkAsync('execute returns a value the registry schema accepts', async () => {
  const ctx = fakeContext();
  apply(ctx, config);
  const args = { type: 'line', data: ROWS, x: 'm', y: ['online', 'store'], title: '渠道 GMV' };
  const value = await registered.execute(args, { signal: new AbortController().signal });
  const violations = validateJsonSchemaValue(registered.output.schema, value, 'value');
  assert.deepEqual(violations, [], `schema violations: ${JSON.stringify(violations)}`);
  assert.equal(value.type, 'line');
  assert.equal(value.series.length, 2);
  assert.equal(value.total, 6);
  assert.equal(value.truncated, false);
  assert.deepEqual(value.encoding, { x: 'm', y: ['online', 'store'] });
  assert.ok(value.chartId.startsWith('chart-'), value.chartId);

  const content = registered.output.render(args, value);
  assert.equal(content.length, 1);
  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /已生成「渠道 GMV」折线图，含 2 个系列（online\/store）、共 6 个数据点。/);
  assert.match(content[0].text, /online：均值/);
  assert.match(content[0].text, /完整数据见图表卡片/);
  assert.doesNotMatch(content[0].text, /\[object/, 'no object stringification');
  assert.ok(content[0].text.length < 700, 'model-visible text must stay compact');
});

await checkAsync('presentationMeta is JSON-safe, colour-free and replay-shaped', async () => {
  const ctx = fakeContext();
  apply(ctx, config);
  const args = { type: 'bar', data: ROWS, x: 'm', y: 'online', title: 'GMV' };
  const value = await registered.execute(args, { signal: new AbortController().signal });
  const meta = registered.output.presentationMeta(args, value);
  assert.doesNotThrow(() => structuredClone(meta), 'meta must be losslessly clonable');
  assert.equal(meta.schemaVersion, 1);
  assert.equal(meta.chartType, 'bar');
  assert.deepEqual(meta.series[0].points[0], ['2026-01', 100]);
  assert.equal(meta.series[0].colorIndex, 0);
  assert.ok(!('color' in meta.series[0]), 'series must not carry a resolved colour');
  assert.ok(!('palette' in meta) || !JSON.stringify(meta).includes('#FFFFFF'), 'no invented colours');
  assert.equal(meta.theme.palette.positive, '#E64545', 'the palette travels as data');
  assert.equal(typeof meta.height, 'number');

  const call = registered.presentCall(args);
  assert.equal(call.card, 'generic');
  assert.equal(typeof call.title, 'string');
  const result = registered.presentResult(args, { isError: false, content: [], meta });
  assert.ok(result === undefined || result.card === 'generic');
});

await checkAsync('presentationMeta survives an unknown theme by falling back', async () => {
  const ctx = fakeContext();
  apply(ctx, config);
  const args = { type: 'pie', data: ROWS, x: 'm', y: 'online', theme: 'missing-theme' };
  const value = await registered.execute(args, { signal: new AbortController().signal });
  const meta = registered.output.presentationMeta(args, value);
  assert.equal(meta.theme.name, 'light');
  assert.match(meta.hint, /missing-theme/);
});

await checkAsync('an inline dataRef is read through ctx.fs', async () => {
  const ctx = fakeContext();
  apply(ctx, config);
  const value = await registered.execute({ type: 'bar', dataRef: 'rows.json', x: 'm', y: 'v' }, {
    signal: new AbortController().signal,
  });
  assert.equal(value.total, 1);
  assert.equal(value.series[0].points[0].y, 1);
});

/* 4. failures --------------------------------------------------------------- */
await checkAsync('a bad enum value is rejected by defineTool before execute', async () => {
  const ctx = fakeContext();
  apply(ctx, config);
  await assert.rejects(
    registered.execute({ type: 'sunburst', data: ROWS, x: 'm', y: 'online' }, {}),
    (error) => {
      assert.match(String(error.name), /ToolArgsError|Error/);
      assert.match(String(error.message), /type/);
      return true;
    },
  );
});

await checkAsync('a domain violation throws a readable Chinese error', async () => {
  const ctx = fakeContext();
  apply(ctx, config);
  await assert.rejects(
    registered.execute({ type: 'line', data: ROWS, x: 'm', y: 'nope' }, {}),
    /参数 `y`：数值字段 "nope" 在数据中不存在；可用字段：m, online, store。/,
  );
});

await checkAsync('pie rejects grouping', async () => {
  const ctx = fakeContext();
  apply(ctx, config);
  await assert.rejects(
    registered.execute({ type: 'pie', data: ROWS, x: 'm', y: 'online', series: 'store' }, {}),
    /series/,
  );
});

console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} host smoke check(s) FAILED`);
  for (const failure of failures) console.log(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('all host smoke checks passed');
}
