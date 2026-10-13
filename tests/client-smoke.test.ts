/**
 * Client-half smoke test for `dsh-tool-chart`.
 *
 * The browser half is a classic-script bundle (`lib/client.js`) that a real page
 * materialises through `window.__ModuleLoader__`. There is no DOM and no
 * react-dom in an offline checkout, so this test substitutes exactly two
 * things:
 *
 *   1. a `window.__ModuleLoader__` stub that captures the lazy factory, and a
 *      minimal `document` so `apply()` can insert its package-owned stylesheet;
 *   2. a hook shim: `useState`/`useRef`/`useMemo` are replaced with in-memory
 *      equivalents so the component can be invoked as a plain function and its
 *      element tree walked without a renderer.
 *
 * That is enough to prove the browser half really loads, really registers the
 * `chart` view on `tool.call.toolview`, requires nothing but `react`, and turns
 * real `output.presentationMeta` output into the expected SVG shapes and
 * degradation placeholders. It is NOT a DOM/browser render test; that gap is
 * recorded in the README's Known Limitations.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { buildChart } from '../lib/transform.js';
import { buildPresentationMeta } from '../lib/present.js';

/* ------------------------------------------------------- browser substitutes */

const APP_NODE_MODULES =
  'C:/Users/17897/AppData/Local/Programs/DSH Desktop/resources/app/node_modules/';
const appRequire = createRequire(`${APP_NODE_MODULES}noop.js`);
const React = appRequire('react');

interface LoaderEntry {
  id: string;
  factory(require: (specifier: string) => unknown): { inject?: readonly string[]; apply(ctx: unknown): void };
}

let loaded: LoaderEntry | null = null;
const styleElements: Array<{ attrs: Record<string, string>; textContent: string; removed: boolean }> = [];

function fakeElement() {
  return {
    attrs: {} as Record<string, string>,
    textContent: '',
    removed: false,
    setAttribute(name: string, value: string) {
      this.attrs[name] = value;
    },
    remove() {
      this.removed = true;
    },
    appendChild() {},
  };
}

const globals = globalThis as unknown as Record<string, unknown>;
globals.window = {
  __ModuleLoader__: {
    load(entry: LoaderEntry) {
      loaded = entry;
    },
  },
};
globals.document = {
  createElement() {
    const element = fakeElement();
    styleElements.push(element);
    return element;
  },
  head: { appendChild() {} },
};

/* ---------------------------------------------------------- the hook shim */

interface HookState {
  cursor: number;
  values: unknown[];
}

const hookState: HookState = { cursor: 0, values: [] };

(React as Record<string, unknown>).useState = (initial: unknown) => {
  const index = hookState.cursor++;
  if (hookState.values.length <= index) {
    hookState.values[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
  }
  const set = (next: unknown) => {
    hookState.values[index] = typeof next === 'function' ? (next as (prev: unknown) => unknown)(hookState.values[index]) : next;
  };
  return [hookState.values[index], set];
};
(React as Record<string, unknown>).useRef = (initial: unknown) => ({ current: initial ?? null });
(React as Record<string, unknown>).useMemo = (factory: () => unknown) => factory();
(React as Record<string, unknown>).useCallback = (callback: unknown) => callback;
(React as Record<string, unknown>).useEffect = () => undefined;

/* -------------------------------------------------------------- tree walker */

interface Walked {
  texts: string[];
  types: string[];
  className: string[];
}

function walk(node: unknown, out: Walked): void {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') {
    out.texts.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return;
  }
  if (typeof node !== 'object') return;
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  const props = element.props ?? {};
  const type = element.type;
  if (typeof props.className === 'string') out.className.push(props.className);
  if (typeof type === 'function') {
    const proto = (type as { prototype?: { render?: unknown } }).prototype;
    if (proto !== undefined && typeof proto.render === 'function') {
      // Class component (the error boundary): instantiate, and mirror React's
      // getDerivedStateFromError handling so the degradation path is testable.
      const instance = new (type as new (p: Record<string, unknown>) => {
        props: Record<string, unknown>;
        state: Record<string, unknown> | null;
        render(): unknown;
      })(props);
      hookState.cursor = 0;
      try {
        walk(instance.render(), out);
      } catch (error) {
        const derive = (type as { getDerivedStateFromError?: (cause: unknown) => Record<string, unknown> })
          .getDerivedStateFromError;
        if (typeof derive !== 'function') throw error;
        instance.state = { ...(instance.state ?? {}), ...derive(error) };
        hookState.cursor = 0;
        walk(instance.render(), out);
      }
      return;
    }
    hookState.cursor = 0;
    walk((type as (p: Record<string, unknown>) => unknown)(props), out);
    return;
  }
  if (typeof type === 'string') {
    out.types.push(type);
    walk(props.children, out);
    return;
  }
  // React fragments and portals carry children too.
  walk(props.children, out);
}

function render(component: unknown, props: Record<string, unknown>): Walked {
  const out: Walked = { texts: [], types: [], className: [] };
  hookState.cursor = 0;
  // Wrap in an element so the walker applies the same class/function rules.
  walk({ type: component, props }, out);
  return out;
}

/* ---------------------------------------------------------------- fixtures */

const CONFIG = {
  maxInlineRows: 5000,
  maxSeries: 20,
  defaultLimit: 5000,
  maxOutputPoints: 20000,
  enabledTypes: ['line', 'bar', 'area', 'scatter', 'pie', 'heatmap', 'candlestick', 'boxplot'],
  chartIdPrefix: 'test',
};

const THEMES = {
  light: {
    mode: 'light',
    palette: {
      series: ['#4C8DFF', '#F2A93B', '#7DD3A0'],
      positive: '#E64545',
      negative: '#2EA84F',
      axis: '#8A8A8A',
      grid: '#E2E2E2',
      label: '#333333',
      bg: '#FFFFFF',
      fontFamily: 'sans-serif',
      fontSize: 12,
    },
  },
  dark: {
    mode: 'dark',
    palette: {
      series: ['#6E9BFF', '#F5B95C', '#7DD3A0'],
      positive: '#E64545',
      negative: '#2EA84F',
      axis: '#9A9A9A',
      grid: '#3A3A3A',
      label: '#DDDDDD',
      bg: '#1B1B1B',
      fontFamily: 'sans-serif',
      fontSize: 12,
    },
  },
};

const PRESENT_OPTIONS = {
  maxPoints: 2000,
  height: 320,
  stack: false,
  themes: THEMES,
  defaultTheme: 'light',
};

const ROWS = [
  { month: '2026-01', online: 100, store: 40 },
  { month: '2026-02', online: 120, store: 55 },
  { month: '2026-03', online: 90, store: 61 },
];

async function canonical(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const outcome = await buildChart(args, {
    config: CONFIG,
    async readDataRef() {
      return null;
    },
  });
  assert.equal(outcome.ok, true, `buildChart failed: ${JSON.stringify(outcome)}`);
  if (!outcome.ok) throw new Error('unreachable');
  return outcome.value as unknown as Record<string, unknown>;
}

function resultProps(
  args: Record<string, unknown>,
  meta: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    phase: 'result',
    callId: 'call-1',
    toolName: 'chart',
    block: {
      kind: 'tool-result',
      call: { name: 'chart', argsRaw: JSON.stringify(args) },
      content: [{ type: 'text', text: '已生成图表。' }],
      isError: false,
      ...(meta === undefined ? {} : { meta }),
      ...extra,
    },
  };
}

/* ------------------------------------------------------------------ the run */

await import('../lib/client.js');

const entry = loaded as LoaderEntry | null;

test('the bundle registers a lazy factory under the package name', () => {
  assert.ok(entry, 'WindowLoader.load was never called');
  assert.equal(entry.id, 'dsh-tool-chart');
});

const requiredSpecifiers: string[] = [];
const moduleExports = (entry as LoaderEntry).factory((specifier: string) => {
  if (specifier === 'react' || specifier === 'react/jsx-runtime') return appRequire(specifier);
  requiredSpecifiers.push(specifier);
  return {};
});

test('the factory only requires react', () => {
  assert.deepEqual(requiredSpecifiers, []);
  assert.deepEqual(moduleExports.inject, ['slots']);
  assert.equal(typeof moduleExports.apply, 'function');
});

/* apply(): effects, stylesheet, slot registrations */

interface Registration {
  options: Record<string, unknown>;
  component: unknown;
}

const registrations = new Map<string, Registration>();
const injectedKeys: string[] = [];
const effectDisposers: Array<() => void> = [];
const SESSION_ID = 'session-1';
const TURN_KEY = '2';

let lastTurnDataSourceCall: { turn: number; kind: string } | null = null;
const turnToolCallNodes: unknown[] = [];

const fakeChat = {
  getSnapshot() {
    return {
      nodes: {
        turnDataSource(turn: number, kind: string) {
          lastTurnDataSourceCall = { turn, kind };
          return kind === 'tool-call' ? turnToolCallNodes : [];
        },
      },
    };
  },
};
const fakeSessions = {
  binding(sessionId: string) {
    return sessionId === SESSION_ID ? { id: sessionId } : undefined;
  },
};
const fakeUiConversation = {
  binding() {
    return { target: (name: string) => (name === 'chat' ? fakeChat : undefined) };
  },
};

const recordingSlots = {
  inject(key: string, callback: () => unknown) {
    injectedKeys.push(key);
    callback();
    return () => undefined;
  },
  register(options: Record<string, unknown>, component: unknown) {
    registrations.set(String(options.name), { options, component });
    return () => undefined;
  },
};

const fakeContext = {
  effect(callback: () => (() => void) | undefined) {
    const disposer = callback();
    if (typeof disposer === 'function') effectDisposers.push(disposer);
    return () => undefined;
  },
  slots: recordingSlots,
  inject(_deps: readonly string[], callback: (owner: unknown) => void) {
    callback({ slots: recordingSlots, sessions: fakeSessions, uiConversation: fakeUiConversation });
    return () => undefined;
  },
};

moduleExports.apply(fakeContext);

const toolviewRegistration = registrations.get('tool.call.toolview') as Registration;
const tailRegistration = registrations.get('conversation.chat.turnTail') as Registration;
const registeredOptions = toolviewRegistration.options;
const registeredComponent = toolviewRegistration.component;

test('apply() owns its stylesheet through ctx.effect', () => {
  assert.equal(styleElements.length, 1, 'exactly one stylesheet is created');
  assert.equal(styleElements[0].attrs['data-plugin-css'], 'dsh-tool-chart/toolview.css');
  assert.ok(styleElements[0].textContent.includes('.dsh-chart-card'), 'the stylesheet carries the card styles');
  assert.ok(styleElements[0].textContent.includes('.dsh-chart-tail'), 'the stylesheet carries the body wrapper');
  assert.equal(effectDisposers.length, 1);
  effectDisposers[0]();
  assert.equal(styleElements[0].removed, true, 'the effect disposer removes the stylesheet');
});

test('apply() registers the chart view on the keyed toolview slot', () => {
  assert.deepEqual(injectedKeys, ['tool.call.toolview', 'conversation.chat.turnTail']);
  assert.equal(registeredOptions.name, 'tool.call.toolview');
  assert.equal(registeredOptions.key, 'chart');
  assert.equal(typeof registeredOptions.inject, 'function', 'the call row gets the live promotion flag');
  assert.equal(typeof registeredComponent, 'function');
});

test('apply() registers a body contribution and only then flips the receipt flag', () => {
  assert.equal(typeof tailRegistration.component, 'function');
  assert.equal(tailRegistration.options.id, 'dsh-tool-chart');
  assert.equal(tailRegistration.options.order, -5);
  const face = (registeredOptions.inject as () => Record<string, unknown>)();
  const promotion = face.promotion as { enabled: boolean };
  assert.equal(promotion.enabled, true, 'the body entry really registered before the flag flipped');
});

/* degradation paths — the card must never throw and never disappear */

test('a preparing call renders the pending hint', () => {
  const out = render(registeredComponent, { phase: 'preparing', callId: 'c', toolName: 'chart', block: { phase: 'preparing' } });
  assert.ok(out.texts.join('|').includes('正在准备图表参数'), out.texts.join('|'));
  assert.deepEqual(out.types.includes('svg'), false);
});

test('a started call renders the running hint', () => {
  const out = render(registeredComponent, {
    phase: 'start',
    callId: 'c',
    toolName: 'chart',
    block: { phase: 'start', argsRaw: JSON.stringify({ type: 'bar', title: '渠道 GMV' }) },
  });
  const text = out.texts.join('|');
  assert.ok(text.includes('渠道 GMV'), text);
  assert.ok(text.includes('正在读取数据'), text);
});

test('an errored call renders the failure text from the result content', () => {
  const out = render(registeredComponent, {
    phase: 'result',
    callId: 'c',
    toolName: 'chart',
    block: {
      kind: 'tool-result',
      call: { name: 'chart', argsRaw: JSON.stringify({ type: 'line', title: '坏图' }) },
      content: [{ type: 'text', text: '参数 `y`：数值字段 "nope" 在数据中不存在。' }],
      isError: true,
    },
  });
  const text = out.texts.join('|');
  assert.ok(text.includes('生成失败'), text);
  assert.ok(text.includes('在数据中不存在'), text);
});

test('a missing meta falls back to a readable placeholder', () => {
  const out = render(registeredComponent, {
    phase: 'result',
    callId: 'c',
    toolName: 'chart',
    block: {
      kind: 'tool-result',
      call: { name: 'chart', argsRaw: JSON.stringify({ type: 'line', title: '图' }) },
      content: [],
      isError: false,
    },
  });
  const text = out.texts.join('|');
  assert.ok(text.includes('无法渲染'), text);
  assert.ok(text.includes('缺少可重放的元数据'), text);
});

test('a missing meta still surfaces the tool text when the result carries one', () => {
  const out = render(registeredComponent, resultProps({ type: 'line', title: '图' }, undefined));
  const text = out.texts.join('|');
  assert.ok(text.includes('无法渲染'), text);
  assert.ok(text.includes('已生成图表。'), text);
});

test('unreadable meta (wrong schemaVersion) is rejected locally', () => {
  const out = render(registeredComponent, resultProps({ type: 'line' }, { schemaVersion: 99, chartType: 'line', series: [] }));
  assert.ok(out.texts.join('|').includes('无法渲染'), out.texts.join('|'));
});

test('an empty series set reports no data', () => {
  const out = render(
    registeredComponent,
    resultProps({ type: 'line' }, { schemaVersion: 1, chartType: 'line', series: [] }),
  );
  const text = out.texts.join('|');
  assert.ok(text.includes('无数据'), text);
  assert.ok(text.includes('没有可绘制的数据点'), text);
});

test('a type this renderer cannot draw degrades instead of lying', () => {
  const out = render(
    registeredComponent,
    resultProps(
      { type: 'candlestick' },
      { schemaVersion: 1, chartType: 'candlestick', series: [{ name: 's', points: [['a', [1, 2, 3, 4]]] }] },
    ),
  );
  const text = out.texts.join('|');
  assert.ok(text.includes('暂不支持渲染'), text);
  assert.ok(text.includes('不受支持'), text);
});

/* the happy paths, driven by real host-side projections */

test('a line chart renders an SVG with a path per series and a working legend', async () => {
  const value = await canonical({ type: 'line', title: '渠道 GMV', x: 'month', y: ['online', 'store'], data: ROWS });
  const meta = buildPresentationMeta(value, PRESENT_OPTIONS);
  const out = render(registeredComponent, resultProps({ type: 'line', title: '渠道 GMV', x: 'month', y: ['online', 'store'], data: ROWS }, meta));
  const text = out.texts.join('|');
  assert.ok(out.types.includes('svg'), 'an <svg> is rendered');
  assert.equal(out.types.filter((t) => t === 'path').length, 2, 'one path per series');
  assert.ok(text.includes('渠道 GMV'), text);
  assert.ok(text.includes('折线图 · 2 个系列 · 6 个数据点'), text);
  assert.ok(text.includes('online') && text.includes('store'), text);
  assert.ok(text.includes('下载 PNG'), text);
  assert.ok(out.className.includes('dsh-chart-card'), 'the card shell class is present');
});

test('a bar chart draws rects and a heatmap draws a rect grid', async () => {
  const barValue = await canonical({ type: 'bar', title: 'Bar', x: 'month', y: 'online', data: ROWS });
  const barMeta = buildPresentationMeta(barValue, PRESENT_OPTIONS);
  const barOut = render(registeredComponent, resultProps({ type: 'bar' }, barMeta));
  assert.ok(barOut.types.filter((t) => t === 'rect').length >= 3, 'one rect per point');

  const heatRows = [
    { day: 'mon', hour: '09', value: 3 },
    { day: 'mon', hour: '10', value: 5 },
    { day: 'tue', hour: '09', value: 7 },
    { day: 'tue', hour: '10', value: 2 },
  ];
  const heatValue = await canonical({ type: 'heatmap', title: 'Heat', x: 'hour', y: 'day', color: 'value', data: heatRows });
  const heatMeta = buildPresentationMeta(heatValue, PRESENT_OPTIONS);
  const heatOut = render(registeredComponent, resultProps({ type: 'heatmap' }, heatMeta));
  assert.ok(heatOut.types.filter((t) => t === 'rect').length >= 4, 'one rect per heat cell');
  assert.ok(heatOut.texts.join('|').includes('热力图'), heatOut.texts.join('|'));
});

test('a pie chart draws slices and percentage legend values', async () => {
  const rows = [
    { channel: 'online', gmv: 100 },
    { channel: 'store', gmv: 40 },
    { channel: 'partner', gmv: 60 },
  ];
  const value = await canonical({ type: 'pie', title: '渠道占比', x: 'channel', y: 'gmv', data: rows });
  const meta = buildPresentationMeta(value, PRESENT_OPTIONS);
  const out = render(registeredComponent, resultProps({ type: 'pie', title: '渠道占比', x: 'channel', y: 'gmv', data: rows }, meta));
  const text = out.texts.join('|');
  assert.equal(out.types.filter((t) => t === 'path').length, 3, 'one slice per category');
  assert.ok(text.includes('饼图'), text);
  assert.ok(text.includes('%'), text);
  assert.ok(text.includes('online') && text.includes('store') && text.includes('partner'), text);
});

test('the truncation and hint notes are surfaced on the card', async () => {
  const value = await canonical({ type: 'line', title: '大图', x: 'month', y: 'online', limit: 2, data: ROWS });
  const meta = buildPresentationMeta(value, PRESENT_OPTIONS);
  assert.equal(meta.truncated, true, 'the host marks the truncation');
  const out = render(registeredComponent, resultProps({ type: 'line', limit: 2 }, meta));
  assert.ok(out.texts.join('|').includes('数据已截断'), out.texts.join('|'));
});

test('an unknown theme still renders, using the fallback palette carried in meta', async () => {
  const value = await canonical({ type: 'line', title: '主题回退', x: 'month', y: 'online', data: ROWS });
  const meta = buildPresentationMeta(value, { ...PRESENT_OPTIONS, theme: 'missing-theme' });
  assert.equal(meta.theme.name, 'light', 'meta records the fallback theme');
  const out = render(registeredComponent, resultProps({ type: 'line' }, meta));
  assert.ok(out.types.includes('svg'), 'the card still draws');
  assert.ok(out.texts.join('|').includes('已回退到主题'), out.texts.join('|'));
});

test('a malformed point set is filtered out rather than crashing the card', () => {
  const out = render(
    registeredComponent,
    resultProps(
      { type: 'line' },
      {
        schemaVersion: 1,
        chartType: 'line',
        series: [{ name: 'good', colorIndex: 0, points: [['a', 1], ['b', null], 'nope'] }],
        theme: { name: 'light', mode: 'light', palette: { series: ['#4C8DFF'] } },
      },
    ),
  );
  assert.ok(out.types.includes('svg'), 'the card survives a malformed point');
  assert.ok(out.texts.join('|').includes('good'), out.texts.join('|'));
});

test('an unexpected render error degrades to a readable message, never an empty cell', async () => {
  const value = await canonical({ type: 'bar', title: '崩溃降级', x: 'month', y: 'online', data: ROWS });
  const meta = buildPresentationMeta(value, PRESENT_OPTIONS);
  const stats = {};
  Object.defineProperty(stats, 'online', {
    enumerable: true,
    get() {
      throw new Error('boom-stats');
    },
  });
  const out = render(registeredComponent, resultProps({ type: 'bar' }, { ...meta, stats }));
  const text = out.texts.join('|');
  assert.ok(text.includes('图表渲染失败'), text);
  assert.ok(text.includes('boom-stats'), text);
});

/* the message-body contribution (conversation.chat.turnTail) */

function tailProps(nodes: unknown): Record<string, unknown> {
  return {
    turn: { sessionId: SESSION_ID, turn: Number(TURN_KEY) },
    seq: 9,
    openFile() {},
    useChartCards: () => nodes,
  };
}

function chartToolCallNode(meta: unknown, callId = 'call-9'): Record<string, unknown> {
  return {
    root: {
      kind: 'tool-result',
      callId,
      call: { name: 'chart', argsRaw: JSON.stringify({ type: 'bar', title: '正文柱状' }) },
      content: [{ type: 'text', text: '已生成图表。' }],
      isError: false,
      meta,
    },
  };
}

test("the body entry reads the Turn's tool-call nodes through the session chat store", () => {
  turnToolCallNodes.length = 0;
  turnToolCallNodes.push(chartToolCallNode({ schemaVersion: 1, chartType: 'bar', series: [] }));
  const face = (tailRegistration.options.inject as (sessionId: string) => Record<string, unknown>)(SESSION_ID);
  const keyedHooks = face.keyedHooks as { chartCards: (turn: string) => unknown };
  const nodes = keyedHooks.chartCards(TURN_KEY);
  assert.equal(Array.isArray(nodes), true, 'the keyed hook resolves the Turn data source');
  assert.deepEqual(lastTurnDataSourceCall, { turn: 2, kind: 'tool-call' });
});

test('the body entry degrades to an empty contribution when the chat target is unknown', () => {
  const face = (tailRegistration.options.inject as (sessionId: string) => Record<string, unknown>)('missing-session');
  assert.deepEqual(face, {}, 'an unknown session injects nothing instead of throwing');
});

test("the body entry draws a real chart from the Turn's tool-call nodes", async () => {
  const value = await canonical({ type: 'bar', title: '正文柱状', x: 'month', y: 'online', data: ROWS });
  const meta = buildPresentationMeta(value, PRESENT_OPTIONS);
  const nodes = [chartToolCallNode(meta)];
  const out = render(tailRegistration.component, tailProps(nodes));
  const text = out.texts.join('|');
  assert.ok(out.className.includes('dsh-chart-tail'), 'the contribution is wrapped in its own container');
  assert.ok(out.types.includes('svg'), 'the body draws an SVG');
  assert.ok(out.types.filter((t) => t === 'rect').length >= 3, 'one rect per point');
  assert.ok(text.includes('正文柱状'), text);
});

test('the body entry stays silent without a drawable chart call', () => {
  const empty = render(tailRegistration.component, tailProps([]));
  assert.deepEqual([empty.texts.length, empty.types.length], [0, 0]);

  const absent = render(tailRegistration.component, tailProps(undefined));
  assert.deepEqual([absent.texts.length, absent.types.length], [0, 0]);

  const noHook = render(tailRegistration.component, { turn: { turn: 2 }, seq: 2, openFile() {} });
  assert.deepEqual([noHook.texts.length, noHook.types.length], [0, 0]);

  const broken = render(tailRegistration.component, {
    ...tailProps([]),
    useChartCards: () => {
      throw new Error('boom-hook');
    },
  });
  assert.deepEqual([broken.texts.length, broken.types.length], [0, 0], 'a broken hook never escapes');

  const otherTool = render(
    tailRegistration.component,
    tailProps([{ root: { kind: 'tool-result', call: { name: 'read', argsRaw: '{}' }, content: [], isError: false } }]),
  );
  assert.deepEqual([otherTool.texts.length, otherTool.types.length], [0, 0], 'other tools are not hoisted');

  const noMeta = render(tailRegistration.component, tailProps([{ root: { kind: 'tool-result', call: { name: 'chart', argsRaw: '{}' }, content: [], isError: false } }]));
  assert.deepEqual([noMeta.texts.length, noMeta.types.length], [0, 0], 'an unreadable meta stays in the call row');

  const failed = render(
    tailRegistration.component,
    tailProps([{ root: { kind: 'tool-result', call: { name: 'chart', argsRaw: '{}' }, content: [], isError: true } }]),
  );
  assert.deepEqual([failed.texts.length, failed.types.length], [0, 0], 'a failed call stays in the call row');
});

test('the call row turns into a one-line receipt once the body entry is live', async () => {
  const value = await canonical({ type: 'bar', title: '正文图', x: 'month', y: 'online', data: ROWS });
  const meta = buildPresentationMeta(value, PRESENT_OPTIONS);
  const face = (registeredOptions.inject as () => Record<string, unknown>)();
  const out = render(registeredComponent, {
    ...resultProps({ type: 'bar', title: '正文图' }, meta),
    promotion: face.promotion,
  });
  const text = out.texts.join('|');
  assert.ok(text.includes('已显示在会话正文'), text);
  assert.ok(text.includes('已作为正文卡片绘制'), text);
  assert.equal(out.types.includes('svg'), false, 'the receipt does not redraw the chart');
});

test('without the body entry the call row keeps the full chart', async () => {
  const value = await canonical({ type: 'bar', title: '回退柱状', x: 'month', y: 'online', data: ROWS });
  const meta = buildPresentationMeta(value, PRESENT_OPTIONS);
  const out = render(registeredComponent, {
    ...resultProps({ type: 'bar', title: '回退柱状' }, meta),
    promotion: { enabled: false },
  });
  assert.ok(out.types.includes('svg'), 'the call row still draws the chart');
  assert.ok(out.types.filter((t) => t === 'rect').length >= 3, 'one rect per point');
});
