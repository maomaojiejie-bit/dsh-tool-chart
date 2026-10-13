/**
 * Validation tests: every rejection path must be a model-actionable error that
 * names the offending argument. These cover the hand-written checks in
 * `buildChart`, which the declarative schema cannot express.
 *
 *   node --test tests/
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CHART_TYPES, buildChart } from '../src/transform.ts';
import type { BuildOptions, ChartError } from '../src/transform.ts';

const CONFIG: BuildOptions['config'] = {
  maxInlineRows: 5000,
  maxSeries: 20,
  defaultLimit: 5000,
  maxOutputPoints: 20000,
  enabledTypes: [...CHART_TYPES],
  chartIdPrefix: 'test',
};

function options(overrides: Partial<BuildOptions['config']> = {}): BuildOptions {
  return {
    config: { ...CONFIG, ...overrides },
    async readDataRef() {
      return null;
    },
  };
}

async function rejection(
  args: Record<string, unknown>,
  overrides: Partial<BuildOptions['config']> = {},
): Promise<ChartError> {
  const outcome = await buildChart(args, options(overrides));
  assert.equal(outcome.ok, false, `expected a rejection, got ${JSON.stringify(outcome)}`);
  if (outcome.ok) throw new Error('unreachable');
  return outcome.error;
}

const ROWS = [
  { m: 'a', v: 1 },
  { m: 'b', v: 2 },
];

test('an unknown chart type names the supported set', async () => {
  const error = await rejection({ type: 'donut', data: ROWS, x: 'm', y: 'v' });
  assert.equal(error.field, 'type');
  assert.match(error.message, /donut/);
  assert.match(error.message, /line/);
});

test('a missing type is rejected', async () => {
  const error = await rejection({ data: ROWS, x: 'm', y: 'v' });
  assert.equal(error.field, 'type');
});

test('a type disabled by config is rejected with the enabled set', async () => {
  const error = await rejection({ type: 'pie', data: ROWS, x: 'm', y: 'v' }, { enabledTypes: ['line', 'bar'] });
  assert.equal(error.field, 'type');
  assert.match(error.message, /禁用/);
  assert.match(error.message, /line, bar/);
});

test('data and dataRef are mutually exclusive', async () => {
  const error = await rejection({ type: 'line', data: ROWS, dataRef: '/tmp/x.csv', x: 'm', y: 'v' });
  assert.equal(error.field, 'dataRef');
});

test('neither data nor dataRef is rejected', async () => {
  const error = await rejection({ type: 'line', x: 'm', y: 'v' });
  assert.equal(error.field, 'data');
  assert.match(error.message, /dataRef/);
});

test('a non-array data argument is rejected', async () => {
  const error = await rejection({ type: 'line', data: { a: 1 }, x: 'm', y: 'v' });
  assert.equal(error.field, 'data');
});

test('an empty dataset is rejected', async () => {
  const error = await rejection({ type: 'line', data: [], x: 'm', y: 'v' });
  assert.equal(error.field, 'data');
  assert.match(error.message, /空/);
});

test('inline rows above maxInlineRows are rejected with the suggestion to spill', async () => {
  const rows = Array.from({ length: 5 }, (_entry, index) => ({ m: String(index), v: index }));
  const error = await rejection({ type: 'line', data: rows, x: 'm', y: 'v' }, { maxInlineRows: 3 });
  assert.equal(error.field, 'data');
  assert.match(error.message, /5 行/);
  assert.match(error.hint ?? '', /dataRef/);
});

test('a missing column lists the available fields', async () => {
  const error = await rejection({ type: 'line', data: ROWS, x: 'm', y: 'gmv' });
  assert.equal(error.field, 'y');
  assert.match(error.message, /gmv/);
  assert.match(error.message, /m, v/);
});

test('a missing category column is rejected', async () => {
  const error = await rejection({ type: 'line', data: ROWS, x: 'month', y: 'v' });
  assert.equal(error.field, 'x');
  assert.match(error.message, /month/);
});

test('a category column present only in some rows is rejected as unstable', async () => {
  const rows = [{ m: 'a', v: 1 }, { v: 2 }];
  const error = await rejection({ type: 'line', data: rows, x: 'm', y: 'v' });
  assert.equal(error.field, 'x');
  assert.match(error.message, /部分行/);
});

test('a missing y is rejected per type', async () => {
  const error = await rejection({ type: 'line', data: ROWS, x: 'm' });
  assert.equal(error.field, 'y');
  assert.match(error.message, /至少一个数值字段/);
});

test('an all-null measure column is rejected', async () => {
  const rows = [
    { m: 'a', v: null },
    { m: 'b', v: null },
  ];
  const error = await rejection({ type: 'line', data: rows, x: 'm', y: 'v' });
  assert.equal(error.field, 'y');
  assert.match(error.message, /空值/);
});

test('a non-numeric measure column prints sample values', async () => {
  const rows = [
    { m: 'a', v: 'fast' },
    { m: 'b', v: 'slow' },
  ];
  const error = await rejection({ type: 'line', data: rows, x: 'm', y: 'v' });
  assert.equal(error.field, 'y');
  assert.match(error.message, /无法解析为数字/);
  assert.match(error.message, /fast/);
});

test('scatter rejects a colour field that is also the measure', async () => {
  const rows = [
    { m: 'a', v: 1 },
    { m: 'b', v: 2 },
  ];
  const error = await rejection({ type: 'scatter', data: rows, x: 'm', y: 'v', color: 'v' });
  assert.equal(error.field, 'color');
});

test('grouping cannot be combined with an array y', async () => {
  const rows = [
    { m: 'a', g: 'x', v1: 1, v2: 2 },
  ];
  const error = await rejection({ type: 'line', data: rows, x: 'm', y: ['v1', 'v2'], series: 'g' });
  assert.equal(error.field, 'series');
});

test('a missing grouping column is rejected', async () => {
  const rows = [
    { m: 'a', v: 1 },
    { m: 'b', v: 2 },
  ];
  const error = await rejection({ type: 'line', data: rows, x: 'm', y: 'v', series: 'channel' });
  assert.equal(error.field, 'series');
  assert.match(error.message, /channel/);
});

test('a missing colour column is rejected', async () => {
  const error = await rejection({ type: 'scatter', data: ROWS, x: 'm', y: 'v', color: 'size' });
  assert.equal(error.field, 'color');
});

test('a point count above maxOutputPoints is rejected with a coarsening hint', async () => {
  const rows = Array.from({ length: 20 }, (_entry, index) => ({ m: `m${index}`, v: index }));
  const error = await rejection({ type: 'line', data: rows, x: 'm', y: 'v' }, { maxOutputPoints: 5 });
  assert.equal(error.field, 'limit');
  assert.match(error.message, /20 个数据点/);
  assert.match(error.hint ?? '', /聚合/);
});

test('an empty category set is rejected', async () => {
  const rows = [{ m: null, v: 1 }];
  const error = await rejection({ type: 'line', data: rows, x: 'm', y: 'v' });
  assert.equal(error.field, 'x');
});

test('every rejection carries a non-empty Chinese message', async () => {
  const cases: Array<Record<string, unknown>> = [
    { type: 'nope', data: ROWS, x: 'm', y: 'v' },
    {},
    { type: 'line', data: ROWS, x: 'm', y: 'v', dataRef: 'x' },
    { type: 'line', data: ROWS, x: 'm', y: 'zzz' },
    { type: 'pie', data: ROWS, x: 'm' },
    { type: 'heatmap', data: ROWS, x: 'm', y: 'v' },
    { type: 'candlestick', data: ROWS, x: 'm', y: ['v'] },
  ];
  for (const args of cases) {
    const error = await rejection(args);
    assert.ok(error.message.length > 0, `empty message for ${JSON.stringify(args)}`);
    assert.match(error.message, /[\u4e00-\u9fff]/, `no Chinese text in ${error.message}`);
  }
});
