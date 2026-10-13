/**
 * Unit tests for the pure data core (`src/transform.ts`).
 *
 * Written for the Node built-in test runner so the package needs no extra
 * dependency to be verified in an offline checkout:
 *
 *   node --test tests/
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHART_TYPES,
  boxplotSummary,
  buildChart,
  computeStats,
  downsample,
  parseDelimited,
} from '../src/transform.ts';
import type { BuildOptions, ChartCanonicalValue, ChartError } from '../src/transform.ts';

const CONFIG: BuildOptions['config'] = {
  maxInlineRows: 5000,
  maxSeries: 20,
  defaultLimit: 5000,
  maxOutputPoints: 20000,
  enabledTypes: [...CHART_TYPES],
  chartIdPrefix: 'test',
};

function options(overrides: Partial<BuildOptions> = {}): BuildOptions {
  return {
    config: CONFIG,
    async readDataRef() {
      return null;
    },
    ...overrides,
  };
}

async function ok(args: Record<string, unknown>, overrides: Partial<BuildOptions> = {}): Promise<ChartCanonicalValue> {
  const outcome = await buildChart(args, options(overrides));
  assert.equal(outcome.ok, true, `expected success, got ${JSON.stringify(outcome)}`);
  if (!outcome.ok) throw new Error('unreachable');
  return outcome.value;
}

async function failure(args: Record<string, unknown>, overrides: Partial<BuildOptions> = {}): Promise<ChartError> {
  const outcome = await buildChart(args, options(overrides));
  assert.equal(outcome.ok, false, `expected failure, got ${JSON.stringify(outcome)}`);
  if (outcome.ok) throw new Error('unreachable');
  return outcome.error;
}

const MONTHS = [
  { month: '2026-01', channel: 'online', gmv: 100 },
  { month: '2026-02', channel: 'online', gmv: 120 },
  { month: '2026-03', channel: 'online', gmv: 90 },
  { month: '2026-01', channel: 'store', gmv: 40 },
  { month: '2026-02', channel: 'store', gmv: 45 },
  { month: '2026-03', channel: 'store', gmv: 50 },
];

test('parseDelimited reads a JSON array, JSON Lines and CSV', () => {
  assert.deepEqual(parseDelimited('[{"a":1},{"a":2}]', 'data'), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(parseDelimited('{"rows":[{"a":1}]}', 'data'), [{ a: 1 }]);
  assert.deepEqual(parseDelimited('{"a":1}\n{"a":2}\n', 'data'), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(parseDelimited('a,b\n1,2\n3,4\n', 'data'), [
    { a: 1, b: 2 },
    { a: 3, b: 4 },
  ]);
  assert.deepEqual(parseDelimited('a,b\n"x,1",2\n', 'data'), [{ a: 'x,1', b: 2 }]);
});

test('line chart groups a long table into one series per group', async () => {
  const value = await ok({ type: 'line', data: MONTHS, x: 'month', y: 'gmv', series: 'channel' });
  assert.equal(value.type, 'line');
  assert.deepEqual(value.encoding, { x: 'month', y: ['gmv'], series: 'channel' });
  const names = value.series.map((entry) => entry.name).sort();
  assert.deepEqual(names, ['online', 'store']);
  const online = value.series.find((entry) => entry.name === 'online');
  assert.deepEqual(online?.points, [
    { x: '2026-01', y: 100 },
    { x: '2026-02', y: 120 },
    { x: '2026-03', y: 90 },
  ]);
  assert.equal(value.total, 6);
  assert.equal(value.truncated, false);
  assert.equal(value.stats?.online?.min, 90);
  assert.equal(value.stats?.online?.max, 120);
});

test('several y fields become several series when there is no grouping', async () => {
  const rows = [
    { m: 'a', p50: 1, p99: 9 },
    { m: 'b', p50: 2, p99: 8 },
  ];
  const value = await ok({ type: 'line', data: rows, x: 'm', y: ['p50', 'p99'] });
  assert.deepEqual(value.series.map((entry) => entry.name), ['p50', 'p99']);
  assert.deepEqual(value.series[1].points, [
    { x: 'a', y: 9 },
    { x: 'b', y: 8 },
  ]);
});

test('sort reorders categories and averages duplicate rows', async () => {
  const rows = [
    { m: 'b', v: 2 },
    { m: 'a', v: 1 },
    { m: 'a', v: 3 },
  ];
  const value = await ok({ type: 'bar', data: rows, x: 'm', y: 'v', sort: 'asc' });
  assert.deepEqual(value.series[0].points, [
    { x: 'a', y: 2 },
    { x: 'b', y: 2 },
  ]);
});

test('numeric strings are coerced and thousands separators tolerated', async () => {
  const value = await ok({
    type: 'bar',
    data: [
      { m: 'a', v: '1,200' },
      { m: 'b', v: '800' },
    ],
    x: 'm',
    y: 'v',
  });
  assert.deepEqual(value.series[0].points, [
    { x: 'a', y: 1200 },
    { x: 'b', y: 800 },
  ]);
});

test('pie accepts a single y and rejects grouping and stacking', async () => {
  const rows = [
    { channel: 'online', gmv: 60 },
    { channel: 'store', gmv: 40 },
  ];
  const value = await ok({ type: 'pie', data: rows, x: 'channel', y: 'gmv' });
  assert.equal(value.series.length, 1);
  assert.equal(value.total, 2);

  const grouped = await failure({ type: 'pie', data: MONTHS, x: 'month', y: 'gmv', series: 'channel' });
  assert.equal(grouped.field, 'series');
  const multi = await failure({ type: 'pie', data: rows, x: 'channel', y: ['gmv', 'gmv'] });
  assert.equal(multi.field, 'y');
});

test('pie requires exactly one measure', async () => {
  const rows = [
    { c: 'a', v1: 1, v2: 2 },
    { c: 'b', v1: 3, v2: 4 },
  ];
  const error = await failure({ type: 'pie', data: rows, x: 'c', y: ['v1', 'v2'] });
  assert.equal(error.field, 'y');
  const stacked = await failure({ type: 'pie', data: rows, x: 'c', y: 'v1', stack: true });
  assert.equal(stacked.field, 'stack');
});

test('heatmap needs x, a row dimension in y and a numeric color field', async () => {
  const rows = [
    { day: 'mon', hour: '09', load: 3 },
    { day: 'mon', hour: '10', load: 5 },
    { day: 'tue', hour: '09', load: 7 },
    { day: 'tue', hour: '10', load: 1 },
  ];
  const value = await ok({ type: 'heatmap', data: rows, x: 'hour', y: 'day', color: 'load' });
  assert.deepEqual(value.series.map((entry) => entry.name), ['mon', 'tue']);
  assert.deepEqual(value.series[0].points, [
    { x: '09', y: 3 },
    { x: '10', y: 5 },
  ]);

  const missingColor = await failure({ type: 'heatmap', data: rows, x: 'hour', y: 'day' });
  assert.equal(missingColor.field, 'color');
  const same = await failure({ type: 'heatmap', data: rows, x: 'hour', y: 'load', color: 'load' });
  assert.equal(same.field, 'color');
  const noX = await failure({ type: 'heatmap', data: rows, y: 'day', color: 'load' });
  assert.equal(noX.field, 'x');
});

test('candlestick packs [open, close, low, high] and needs four fields', async () => {
  const rows = [
    { d: '2026-01-01', open: 10, high: 14, low: 9, close: 13 },
    { d: '2026-01-02', open: 13, high: 15, low: 11, close: 12 },
  ];
  const value = await ok({ type: 'candlestick', data: rows, x: 'd', y: ['open', 'high', 'low', 'close'] });
  assert.deepEqual(value.series[0].points, [
    { x: '2026-01-01', y: [10, 13, 9, 14] },
    { x: '2026-01-02', y: [13, 12, 11, 15] },
  ]);

  const three = await failure({ type: 'candlestick', data: rows, x: 'd', y: ['open', 'high', 'low'] });
  assert.equal(three.field, 'y');
  const none = await failure({ type: 'candlestick', data: rows, x: 'd' });
  assert.equal(none.field, 'y');
});

test('boxplot reduces each category to a five-number summary', async () => {
  const rows = [
    { g: 'a', v: 4 },
    { g: 'a', v: 1 },
    { g: 'a', v: 3 },
    { g: 'a', v: 2 },
    { g: 'b', v: 10 },
  ];
  const value = await ok({ type: 'boxplot', data: rows, x: 'g', y: 'v' });
  assert.deepEqual(value.series[0].points, [
    { x: 'a', y: [1, 1.75, 2.5, 3.25, 4] },
    { x: 'b', y: [10, 10, 10, 10, 10] },
  ]);
});

test('boxplotSummary interpolates quartiles and handles a single value', () => {
  assert.deepEqual(boxplotSummary([1, 2, 3, 4]), [1, 1.75, 2.5, 3.25, 4]);
  assert.deepEqual(boxplotSummary([7]), [7, 7, 7, 7, 7]);
});

test('limit truncates rows and marks truncated with the kept total', async () => {
  const rows = Array.from({ length: 10 }, (_entry, index) => ({ i: String(index), v: index }));
  const value = await ok({ type: 'line', data: rows, x: 'i', y: 'v', limit: 4 });
  assert.equal(value.truncated, true);
  assert.equal(value.total, 4);
  assert.equal(value.series[0].points.length, 4);
});

test('the series cap truncates and marks truncated', async () => {
  const rows: Array<Record<string, unknown>> = [];
  for (let index = 0; index < 10; index += 1) {
    rows.push({ m: `m${index}`, g: `g${index}`, v: index });
  }
  const value = await ok(
    { type: 'bar', data: rows, x: 'm', y: 'v', series: 'g' },
    { config: { ...CONFIG, maxSeries: 3 } },
  );
  assert.equal(value.series.length, 3);
  assert.equal(value.truncated, true);
});

test('computeStats reports count, range and change', () => {
  const stats = computeStats([
    { x: 1, y: 10 },
    { x: 2, y: 20 },
    { x: 3, y: 30 },
  ]);
  assert.deepEqual(stats, {
    count: 3,
    min: 10,
    max: 30,
    mean: 20,
    sum: 60,
    first: 10,
    last: 30,
    change: 2,
  });
  assert.deepEqual(computeStats([]), { count: 0 });
});

test('downsample keeps the endpoints and honours the threshold', () => {
  const points = Array.from({ length: 500 }, (_entry, index) => ({ x: index, y: Math.sin(index) }));
  const sampled = downsample(points, 100);
  assert.ok(sampled.length <= 101, `expected <=101 points, got ${sampled.length}`);
  assert.deepEqual(sampled[0], points[0]);
  assert.deepEqual(sampled[sampled.length - 1], points[points.length - 1]);
  assert.equal(downsample(points, 1000), points);
});

test('dataRef is read through the injected reader and parsed', async () => {
  const csv = 'month,gmv\n2026-01,10\n2026-02,20\n';
  const value = await ok(
    { type: 'line', dataRef: '/tmp/spill.csv', x: 'month', y: 'gmv' },
    {
      async readDataRef(locator) {
        assert.equal(locator, '/tmp/spill.csv');
        return csv;
      },
    },
  );
  assert.deepEqual(value.series[0].points, [
    { x: '2026-01', y: 10 },
    { x: '2026-02', y: 20 },
  ]);
});

test('an unreadable dataRef fails with an actionable hint', async () => {
  const error = await failure({ type: 'line', dataRef: '/nope.csv', x: 'm', y: 'v' });
  assert.equal(error.field, 'dataRef');
  assert.match(error.message, /无法读取/);
  assert.match(error.hint ?? '', /spill/);
});

test('annotations resolve to existing categories and reject unknown strings', async () => {
  const value = await ok({
    type: 'line',
    data: MONTHS,
    x: 'month',
    y: 'gmv',
    annotations: [{ x: '2026-02', text: 'promo', kind: 'band' }],
  });
  assert.deepEqual(value.annotations, [{ x: '2026-02', text: 'promo', kind: 'band' }]);

  const error = await failure({
    type: 'line',
    data: MONTHS,
    x: 'month',
    y: 'gmv',
    annotations: [{ x: 'nope', text: 'x' }],
  });
  assert.equal(error.field, 'annotations');
});

test('chartId is stable for the same input and prefixed from config', async () => {
  const args = { type: 'line', title: 'GMV', data: MONTHS, x: 'month', y: 'gmv' };
  const first = await ok(args);
  const second = await ok(args);
  assert.equal(first.chartId, second.chartId);
  assert.match(first.chartId, /^test-/);
});

test('CHART_TYPES covers the documented type list', () => {
  assert.deepEqual([...CHART_TYPES], [
    'line',
    'bar',
    'area',
    'scatter',
    'pie',
    'heatmap',
    'candlestick',
    'boxplot',
  ]);
});
