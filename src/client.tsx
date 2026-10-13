/**
 * Browser half of `dsh-tool-chart`.
 *
 * Registers a renderer for the wire tool name `chart` in the keyed slot
 * `tool.call.toolview`. The card draws a real interactive SVG chart from the
 * tool result's persisted `meta` (the projection of `output.presentationMeta`),
 * so a replayed session rebuilds the same card without re-running the tool.
 *
 * Everything is validated locally: malformed metadata, an unknown chart type,
 * or an empty point set degrade to a readable placeholder row instead of
 * throwing, because a thrown render error abdicates the slot entry and the
 * conversation cell would be lost for the rest of the session. A class error
 * boundary wraps the card so an *unexpected* render error inside the drawing
 * code still degrades to a readable message in the cell instead of an empty
 * `<div data-slot-error="tool.call.toolview">`.
 *
 * The card is drawn in the message BODY, not inside the tool row: the chat
 * collapses a Turn's process — every tool row included — into a disclosure, so
 * the chart is rendered by a `conversation.chat.turnTail` contribution that
 * reads the Turn's own `tool-call` nodes, and the call row degrades to a
 * one-line receipt. The call-row view stays as the full fallback for any page
 * where that body entry never registers.
 */

export const inject = ['slots'];

/** Wire tool name — also the `tool.call.toolview` dispatch key. */
const CHART_TOOL_NAME = 'chart';
/** Chat node kind whose `data.root` is a settled tool block carrying `meta`. */
const TOOL_CALL_NODE_KIND = 'tool-call';
const TURN_TAIL_SLOT = 'conversation.chat.turnTail';
const TURN_TAIL_ID = 'dsh-tool-chart';
/** Drawn before the shipped body contributions (deliverables/plan use 0). */
const TURN_TAIL_ORDER = -5;

const GRID = 'rgba(128,128,128,0.22)';
const AXIS = 'rgba(128,128,128,0.55)';
const DEFAULT_COLORS = ['#4C8DFF', '#F2A93B', '#7DD3A0', '#C08BFF', '#5BC8D8', '#FF8FA3', '#9CCC65'];
const SUPPORTED = ['line', 'area', 'bar', 'scatter', 'pie', 'heatmap'];
const TYPE_LABEL = {
  line: '折线图',
  area: '面积图',
  bar: '柱状图',
  scatter: '散点图',
  pie: '饼图',
  heatmap: '热力图',
  candlestick: 'K 线图',
  boxplot: '箱线图',
};

export function apply(ctx) {
  // Package-owned stylesheet: created now, removed when this client run ends
  // (HMR reload included). Never re-created per render.
  ctx.effect(() => {
    const element = document.createElement('style');
    element.setAttribute('data-plugin-css', 'dsh-tool-chart/toolview.css');
    element.textContent = CSS;
    document.head.appendChild(element);
    return () => element.remove();
  }, 'dsh-tool-chart: toolview stylesheet');

  // `promote` is a stable object (not a boolean snapshot) so the call row can
  // read the live flag whenever it renders. It flips to true only after the
  // body entry is really registered; a page without that slot keeps the full
  // card in the call row instead of losing the chart.
  const promote = { enabled: false };

  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register(
      {
        name: 'tool.call.toolview',
        key: CHART_TOOL_NAME,
        inject: () => ({ promotion: promote }),
      },
      ChartBoundary,
    ),
  );

  if (typeof ctx.inject !== 'function') return;

  ctx.inject(['sessions', 'uiConversation'], (owner) => {
    const sessions = serviceOf(owner, 'sessions');
    const uiConversation = serviceOf(owner, 'uiConversation');
    if (sessions === undefined || uiConversation === undefined) return;

    owner.slots.inject(TURN_TAIL_SLOT, () => {
      const dispose = owner.slots.register(
        {
          name: TURN_TAIL_SLOT,
          id: TURN_TAIL_ID,
          order: TURN_TAIL_ORDER,
          inject: (sessionId) => {
            const chat = chatTargetOf(sessions, uiConversation, sessionId);
            if (chat === undefined) return {};
            return {
              keyedHooks: {
                // A Turn's `tool-call` nodes carry exactly the block its call
                // row renders — `meta` included — so nothing is re-derived and
                // a replayed session rebuilds the same cards.
                chartCards: (turn) => turnToolCalls(chat, turn),
              },
            };
          },
        },
        ChartTail,
      );
      promote.enabled = true;
      return () => {
        promote.enabled = false;
        dispose();
      };
    });
  });
}

/* --------------------------------------------------------- the body entry */

/**
 * Body-level contribution: draws one chart card per `chart` call of the Turn
 * being closed. It renders in the Turn tail, which — unlike a tool row or a
 * custom chat node anchored before the answer — is not part of the collapsible
 * process disclosure, so the chart is visible without expanding a tool call.
 */
function ChartTail(props) {
  const hook = props && typeof props.useChartCards === 'function' ? props.useChartCards : null;
  const turn = props && isRecord(props.turn) ? props.turn.turn : undefined;
  const turnKey = typeof turn === 'number' || typeof turn === 'string' ? String(turn) : '';
  let nodes;
  try {
    nodes = hook !== null && turnKey !== '' ? hook(turnKey) : undefined;
  } catch (error) {
    nodes = undefined;
  }
  const blocks = chartBlocksOf(Array.isArray(nodes) ? nodes : []);
  if (blocks.length === 0) return null;
  return React.createElement(
    'div',
    { className: 'dsh-chart-tail' },
    blocks.map((block, index) =>
      React.createElement(ChartBoundary, { key: `${callIdOf(block)}:${index}`, phase: 'result', block }),
    ),
  );
}

/** Keep this Turn's settled `chart` blocks that carry replayable metadata. */
function chartBlocksOf(nodes) {
  const blocks = [];
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    const root = isRecord(node.root) ? node.root : null;
    if (root === null || root.isError === true) continue;
    if (!isChartBlock(root)) continue;
    if (readMeta(root) === null) continue;
    blocks.push(root);
  }
  return blocks;
}

/**
 * Recognize a `chart` call. The tool name is authoritative; when a call's start
 * block did not survive (assembler replay) the durable meta shape is the only
 * remaining evidence.
 */
function isChartBlock(block) {
  const call = isRecord(block.call) ? block.call : null;
  if (call !== null && typeof call.name === 'string') return call.name === CHART_TOOL_NAME;
  if (typeof block.name === 'string') return block.name === CHART_TOOL_NAME;
  return readMeta(block) !== null;
}

function callIdOf(block) {
  if (typeof block.callId === 'string' && block.callId.length > 0) return block.callId;
  const call = isRecord(block.call) ? block.call : null;
  if (call !== null && typeof call.id === 'string' && call.id.length > 0) return call.id;
  return 'chart';
}

/** Read a service off the injected scope without letting a failure escape. */
function serviceOf(scope, name) {
  try {
    if (scope === null || scope === undefined) return undefined;
    const direct = scope[name];
    if (direct !== undefined) return direct;
    return typeof scope.get === 'function' ? scope.get(name) : undefined;
  } catch (error) {
    return undefined;
  }
}

/** Resolve the session's chat store, or undefined when it is not available. */
function chatTargetOf(sessions, uiConversation, sessionId) {
  try {
    if (typeof sessions.binding !== 'function' || typeof uiConversation.binding !== 'function') return undefined;
    const binding = sessions.binding(sessionId);
    if (binding === undefined || binding === null) return undefined;
    const target = uiConversation.binding(binding);
    if (target === null || target === undefined || typeof target.target !== 'function') return undefined;
    const chat = target.target('chat');
    return chat === null ? undefined : chat;
  } catch (error) {
    return undefined;
  }
}

/**
 * The Turn's `tool-call` node data, in anchor order. Returning undefined keeps
 * the renderer's absent-source path (the hook then yields undefined), which the
 * card treats as "nothing to draw".
 */
function turnToolCalls(chat, turn) {
  try {
    if (chat === undefined || chat === null || typeof chat.getSnapshot !== 'function') return undefined;
    const snapshot = chat.getSnapshot();
    if (!isRecord(snapshot) || !isRecord(snapshot.nodes)) return undefined;
    if (typeof snapshot.nodes.turnDataSource !== 'function') return undefined;
    const turnNumber = Number(turn);
    if (!Number.isFinite(turnNumber)) return undefined;
    return snapshot.nodes.turnDataSource(turnNumber, TOOL_CALL_NODE_KIND);
  } catch (error) {
    return undefined;
  }
}

/* ------------------------------------------------------------------ utils */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'number') {
    return Number.isFinite(value[0]) ? value[0] : null;
  }
  return null;
}

function niceTicks(min, max, count) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const span = max - min;
  const rawStep = span / Math.max(1, count);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = factor * magnitude;
  const ticks = [];
  for (let value = Math.ceil(min / step) * step; value <= max + step * 1e-9; value += step) {
    ticks.push(Math.abs(value) < step * 1e-9 ? 0 : value);
    if (ticks.length > 60) break;
  }
  return ticks;
}

function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e4) return `${(value / 1e3).toFixed(0)}K`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  if (abs === 0) return '0';
  if (abs < 0.01) return value.toPrecision(2);
  if (abs < 1) return String(Number(value.toFixed(3)));
  return String(Number(value.toFixed(2)));
}

function formatX(value) {
  const text = typeof value === 'number' ? formatNumber(value) : String(value);
  return text.length > 14 ? `${text.slice(0, 13)}…` : text;
}

function labelIndices(count, width) {
  if (count === 0) return [];
  const maxLabels = Math.max(2, Math.min(12, Math.floor(width / 78)));
  const step = Math.max(1, Math.ceil(count / maxLabels));
  const picked = new Set();
  for (let index = 0; index < count; index += step) picked.add(index);
  picked.add(count - 1);
  return [...picked].sort((a, b) => a - b);
}

function readMeta(block) {
  if (!isRecord(block)) return null;
  const meta = block.meta;
  if (!isRecord(meta)) return null;
  if (meta.schemaVersion !== 1) return null;
  if (typeof meta.chartType !== 'string') return null;
  if (!Array.isArray(meta.series)) return null;
  return meta;
}

function normalizeSeries(meta) {
  const out = [];
  for (const raw of meta.series) {
    if (!isRecord(raw) || !Array.isArray(raw.points)) continue;
    const points = [];
    for (const point of raw.points) {
      if (!Array.isArray(point) || point.length < 2) continue;
      if (numeric(point[1]) === null) continue;
      points.push([point[0], point[1]]);
    }
    if (points.length === 0) continue;
    out.push({
      name: typeof raw.name === 'string' ? raw.name : `系列 ${out.length + 1}`,
      colorIndex: typeof raw.colorIndex === 'number' ? raw.colorIndex : out.length,
      points,
      downsampled: raw.downsampled === true,
    });
  }
  return out;
}

function firstText(block) {
  if (!isRecord(block) || !Array.isArray(block.content)) return '';
  for (const item of block.content) {
    if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') return item.text.slice(0, 400);
  }
  return '';
}

function paletteOf(meta) {
  const theme = isRecord(meta.theme) ? meta.theme : null;
  const palette = theme !== null && isRecord(theme.palette) ? theme.palette : null;
  const colors = palette !== null && Array.isArray(palette.series) && palette.series.length > 0
    ? palette.series.filter((entry) => typeof entry === 'string')
    : [];
  return colors.length > 0 ? colors : DEFAULT_COLORS;
}

function colorAt(colors, index) {
  const safe = Number.isInteger(index) && index >= 0 ? index : 0;
  return colors[safe % colors.length];
}

/* -------------------------------------------------------------- the card */

/**
 * Last-resort degradation: React error boundaries must be class components, so
 * this thin wrapper exists only to keep a broken cell readable. The slot entry
 * stays claimed and the cell shows "卡片渲染出错：…", which is strictly better
 * than the empty `data-slot-error` div React leaves behind when a render
 * throws out of the slot.
 */
class ChartBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    const message = error && typeof error.message === 'string' && error.message.length > 0
      ? error.message
      : String(error);
    return { error: message.slice(0, 300) };
  }

  render() {
    if (this.state.error !== null) {
      return Shell({
        title: '图表渲染失败',
        subtitle: '已降级为文本',
        body: React.createElement(Placeholder, {
          text: `卡片渲染出错：${this.state.error}。请展开原始结果查看文本摘要。`,
          tone: 'error',
        }),
      });
    }
    return React.createElement(ChartCard, this.props);
  }
}

function ChartCard(props) {
  const phase = props.phase;
  const block = props.block;
  const svgRef = React.useRef(null);
  const [hover, setHover] = React.useState(null);
  const [hidden, setHidden] = React.useState(() => new Set());
  const [note, setNote] = React.useState('');

  const args = React.useMemo(() => {
    if (!isRecord(block)) return null;
    const raw = phase === 'result' ? (block.call ? block.call.argsRaw : null) : phase === 'start' ? block.argsRaw : null;
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try {
      const parsed = JSON.parse(raw);
      return isRecord(parsed) ? parsed : null;
    } catch (error) {
      return null;
    }
  }, [phase, block]);

  const meta = React.useMemo(() => {
    if (phase !== 'result' || !isRecord(block) || block.isError === true) return null;
    return readMeta(block);
  }, [phase, block]);

  if (phase === 'preparing') {
    return Shell({
      title: args && typeof args.title === 'string' && args.title.length > 0 ? args.title : '图表',
      subtitle: '等待参数',
      body: React.createElement(Placeholder, { text: '正在准备图表参数…' }),
    });
  }

  if (phase === 'start') {
    const typeName = args && typeof args.type === 'string' ? TYPE_LABEL[args.type] || args.type : '';
    return Shell({
      title: args && typeof args.title === 'string' && args.title.length > 0 ? args.title : '图表',
      subtitle: typeName ? `正在绘制${typeName}…` : '正在生成图表…',
      body: React.createElement(Placeholder, { text: '正在读取数据并生成图表…' }),
    });
  }

  if (isRecord(block) && block.isError === true) {
    return Shell({
      title: args && typeof args.title === 'string' && args.title.length > 0 ? args.title : '图表',
      subtitle: '生成失败',
      body: React.createElement(Placeholder, { text: firstText(block) || '工具执行失败。', tone: 'error' }),
    });
  }

  if (meta === null) {
    return Shell({
      title: args && typeof args.title === 'string' && args.title.length > 0 ? args.title : '图表',
      subtitle: '无法渲染',
      body: React.createElement(Placeholder, {
        text:
          firstText(block) ||
          '这张图表卡片缺少可重放的元数据（meta），或元数据格式不受支持；可展开原始结果查看文本摘要。',
      }),
    });
  }

  // The chart itself is drawn in the message body by the Turn-tail
  // contribution; this row degrades to a receipt so the same chart is not shown
  // twice — but only when that body entry really registered. Otherwise the full
  // card stays here, so a page without the tail slot never loses the chart.
  if (isRecord(props.promotion) && props.promotion.enabled === true) {
    const metaSeries = Array.isArray(meta.series) ? meta.series : [];
    let pointCount = 0;
    for (const entry of metaSeries) {
      if (isRecord(entry) && Array.isArray(entry.points)) pointCount += entry.points.length;
    }
    const receiptTitle =
      args && typeof args.title === 'string' && args.title.length > 0
        ? args.title
        : typeof meta.title === 'string' && meta.title.length > 0
          ? meta.title
          : '图表';
    return Shell({
      title: receiptTitle,
      subtitle: `${TYPE_LABEL[meta.chartType] || meta.chartType} · 已显示在会话正文`,
      body: React.createElement(Placeholder, {
        text: `图表已作为正文卡片绘制在本次回复中（${metaSeries.length} 个系列 / ${pointCount} 个数据点）。`,
      }),
    });
  }

  const series = normalizeSeries(meta);
  const title = typeof meta.title === 'string' && meta.title.length > 0 ? meta.title : '图表';
  if (series.length === 0) {
    return Shell({
      title,
      subtitle: '无数据',
      body: React.createElement(Placeholder, { text: '图表结果中没有可绘制的数据点。' }),
    });
  }
  if (!SUPPORTED.includes(meta.chartType)) {
    return Shell({
      title,
      subtitle: `${meta.chartType} 暂不支持渲染`,
      body: React.createElement(Placeholder, {
        text: `图表类型「${meta.chartType}」在当前客户端渲染器中不受支持，已回退为文本摘要。`,
      }),
    });
  }

  const colors = paletteOf(meta);
  const height = typeof meta.height === 'number' && meta.height > 0 ? meta.height : 320;
  const stats = isRecord(meta.stats) ? meta.stats : {};

  const toggle = (name) => {
    setHidden((previous) => {
      const next = new Set(previous);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const download = () => {
    try {
      const node = svgRef.current;
      if (!node) return;
      const blob = new Blob([node.outerHTML], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(320, node.clientWidth || 960);
          canvas.height = Math.max(180, node.clientHeight || height);
          const context = canvas.getContext('2d');
          if (context) {
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            const link = document.createElement('a');
            link.href = canvas.toDataURL('image/png');
            link.download = `${title.replace(/[\\/:*?"<>|]/g, '_')}.png`;
            link.click();
          }
        } catch (error) {
          setNote('导出 PNG 失败，可改用截图。');
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        setNote('导出 PNG 失败，可改用截图。');
      };
      image.src = url;
    } catch (error) {
      setNote('导出 PNG 失败，可改用截图。');
    }
  };

  const body = React.createElement(
    'div',
    { className: 'dsh-chart-body' },
    React.createElement(ChartCanvas, {
      meta,
      series,
      hidden,
      colors,
      height,
      hover,
      onHover: setHover,
      svgRef,
    }),
    React.createElement(Legend, { series, hidden, colors, onToggle: toggle }),
    React.createElement(StatsTable, { series, stats, colors }),
    meta.truncated === true
      ? React.createElement('div', { className: 'dsh-chart-note', key: 'truncated' }, '数据已截断，图表只显示已保留的部分。')
      : null,
    meta.downsampled === true
      ? React.createElement('div', { className: 'dsh-chart-note', key: 'downsampled' }, '数据点过多，绘图前已下采样（LTTB）。')
      : null,
    typeof meta.hint === 'string' && meta.hint.length > 0
      ? React.createElement('div', { className: 'dsh-chart-note', key: 'hint' }, meta.hint)
      : null,
    note.length > 0 ? React.createElement('div', { className: 'dsh-chart-note dsh-chart-error', key: 'note' }, note) : null,
  );

  return Shell({
    title,
    subtitle: typeof meta.subtitle === 'string' && meta.subtitle.length > 0 ? meta.subtitle : subtitleFor(meta, series),
    actions: React.createElement(
      'button',
      { type: 'button', className: 'dsh-chart-btn', onClick: download, title: '下载 PNG' },
      '下载 PNG',
    ),
    body,
  });
}

function subtitleFor(meta, series) {
  const label = TYPE_LABEL[meta.chartType] || meta.chartType;
  const points = series.reduce((sum, entry) => sum + entry.points.length, 0);
  return `${label} · ${series.length} 个系列 · ${points} 个数据点`;
}

function Shell(parts) {
  return React.createElement(
    'div',
    { className: 'dsh-chart-card' },
    React.createElement(
      'div',
      { className: 'dsh-chart-head' },
      React.createElement(
        'div',
        { className: 'dsh-chart-titles' },
        React.createElement('span', { className: 'dsh-chart-title' }, parts.title),
        parts.subtitle ? React.createElement('span', { className: 'dsh-chart-subtitle' }, parts.subtitle) : null,
      ),
      parts.actions || null,
    ),
    parts.body,
  );
}

function Placeholder(props) {
  return React.createElement(
    'div',
    { className: props.tone === 'error' ? 'dsh-chart-placeholder dsh-chart-error' : 'dsh-chart-placeholder' },
    props.text,
  );
}

/* --------------------------------------------------------------- drawing */

function ChartCanvas(props) {
  const { meta, series, hidden, colors, height, hover, onHover, svgRef } = props;
  if (meta.chartType === 'pie') {
    return React.createElement(PieCanvas, { series, colors, height, hover, onHover, svgRef });
  }

  const width = 960;
  const pad = { left: 62, right: 18, top: 16, bottom: 42 };
  const visible = series.filter((entry) => !hidden.has(entry.name));
  if (visible.length === 0) {
    return React.createElement('div', { className: 'dsh-chart-placeholder' }, '所有系列都已隐藏，点击图例可以恢复。');
  }

  const isHeat = meta.chartType === 'heatmap';
  const xPositions = [];
  const xIndex = new Map();
  for (const entry of visible) {
    for (const point of entry.points) {
      const key = String(point[0]);
      if (!xIndex.has(key)) {
        xIndex.set(key, xPositions.length);
        xPositions.push(point[0]);
      }
    }
  }
  const categoryCount = xPositions.length;
  const values = [];
  for (const entry of visible) {
    for (const point of entry.points) {
      const value = numeric(point[1]);
      if (value !== null) values.push(value);
    }
  }
  if (values.length === 0 || categoryCount === 0) {
    return React.createElement('div', { className: 'dsh-chart-placeholder' }, '没有可绘制的数值。');
  }

  const axes = isRecord(meta.axes) ? meta.axes : {};
  const stacked = meta.stack === true && (meta.chartType === 'bar' || meta.chartType === 'area');
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  let yMin = typeof axes.yMin === 'number' ? axes.yMin : undefined;
  let yMax = typeof axes.yMax === 'number' ? axes.yMax : undefined;
  if (stacked) {
    const totals = new Map();
    for (const entry of visible) {
      for (const point of entry.points) {
        const value = numeric(point[1]);
        if (value === null) continue;
        const key = String(point[0]);
        totals.set(key, (totals.get(key) || 0) + value);
      }
    }
    yMax = Math.max(...totals.values());
    yMin = 0;
  }
  if (yMin === undefined) yMin = isHeat || meta.chartType === 'bar' ? Math.min(0, dataMin) : dataMin;
  if (yMax === undefined) yMax = dataMax;
  if (yMax === yMin) {
    yMax += 1;
    yMin -= 1;
  }
  const span = yMax - yMin;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const xAt = (index) =>
    isHeat
      ? pad.left + ((index + 0.5) / categoryCount) * plotW
      : pad.left + (categoryCount === 1 ? plotW / 2 : (index / (categoryCount - 1)) * plotW);
  const yAt = (value) => pad.top + plotH - ((value - yMin) / span) * plotH;
  const zeroY = yAt(Math.min(Math.max(0, yMin), yMax));

  const children = [];
  for (const tick of niceTicks(yMin, yMax, 5)) {
    const y = yAt(tick);
    children.push(
      React.createElement('line', {
        key: `grid-${tick}`,
        x1: pad.left,
        x2: width - pad.right,
        y1: y,
        y2: y,
        stroke: GRID,
        strokeWidth: 1,
      }),
    );
    children.push(
      React.createElement(
        'text',
        { key: `ylabel-${tick}`, x: pad.left - 8, y: y + 4, textAnchor: 'end', fontSize: 11, fill: 'currentColor', opacity: 0.72 },
        formatNumber(tick),
      ),
    );
  }
  const lastIndex = categoryCount - 1;
  for (const index of labelIndices(categoryCount, width)) {
    children.push(
      React.createElement(
        'text',
        {
          key: `xlabel-${index}`,
          x: xAt(index),
          y: height - pad.bottom + 16,
          textAnchor: isHeat ? 'middle' : index === 0 ? 'start' : index === lastIndex ? 'end' : 'middle',
          fontSize: 11,
          fill: 'currentColor',
          opacity: 0.7,
        },
        formatX(xPositions[index]),
      ),
    );
  }
  children.push(
    React.createElement('line', {
      key: 'axis',
      x1: pad.left,
      x2: width - pad.right,
      y1: pad.top + plotH,
      y2: pad.top + plotH,
      stroke: AXIS,
      strokeWidth: 1,
    }),
  );

  const valueRange = dataMax - dataMin || 1;

  if (isHeat) {
    const cellW = plotW / categoryCount;
    const cellH = plotH / Math.max(1, visible.length);
    visible.forEach((entry, rowIndex) => {
      for (const point of entry.points) {
        const columnIndex = xIndex.get(String(point[0]));
        const value = numeric(point[1]);
        if (columnIndex === undefined || value === null) continue;
        const ratio = (value - dataMin) / valueRange;
        children.push(
          React.createElement('rect', {
            key: `heat-${rowIndex}-${columnIndex}`,
            x: pad.left + columnIndex * cellW,
            y: pad.top + rowIndex * cellH,
            width: Math.max(1, cellW - 1.5),
            height: Math.max(1, cellH - 1.5),
            fill: colorAt(colors, Math.floor(ratio * (colors.length - 1) + 0.5)),
            opacity: 0.35 + ratio * 0.65,
            onMouseEnter: () => onHover({ label: `${entry.name} · ${formatX(point[0])}`, value: formatNumber(value) }),
            onMouseLeave: () => onHover(null),
          }),
        );
      }
    });
  } else if (meta.chartType === 'bar') {
    const groupWidth = plotW / Math.max(1, categoryCount);
    const barWidth = Math.max(1, (groupWidth * 0.72) / visible.length);
    visible.forEach((entry, seriesIndex) => {
      for (const point of entry.points) {
        const columnIndex = xIndex.get(String(point[0]));
        const value = numeric(point[1]);
        if (columnIndex === undefined || value === null) continue;
        const x = pad.left + columnIndex * groupWidth + groupWidth * 0.14 + seriesIndex * barWidth;
        const y = yAt(value);
        children.push(
          React.createElement('rect', {
            key: `bar-${seriesIndex}-${columnIndex}`,
            x,
            y: Math.min(y, zeroY),
            width: Math.max(1, barWidth - (barWidth > 3 ? 1 : 0)),
            height: Math.max(1, Math.abs(zeroY - y)),
            fill: colorAt(colors, entry.colorIndex),
            rx: barWidth > 6 ? 2 : 0,
            onMouseEnter: () => onHover({ label: `${entry.name} · ${formatX(point[0])}`, value: formatNumber(value) }),
            onMouseLeave: () => onHover(null),
          }),
        );
      }
    });
  } else if (meta.chartType === 'scatter') {
    visible.forEach((entry, seriesIndex) => {
      for (const point of entry.points) {
        const columnIndex = xIndex.get(String(point[0]));
        const value = numeric(point[1]);
        if (columnIndex === undefined || value === null) continue;
        children.push(
          React.createElement('circle', {
            key: `dot-${seriesIndex}-${columnIndex}`,
            cx: xAt(columnIndex),
            cy: yAt(value),
            r: 3.2,
            fill: colorAt(colors, entry.colorIndex),
            opacity: 0.85,
            onMouseEnter: () => onHover({ label: `${entry.name} · ${formatX(point[0])}`, value: formatNumber(value) }),
            onMouseLeave: () => onHover(null),
          }),
        );
      }
    });
  } else {
    const baselines = new Map();
    visible.forEach((entry, seriesIndex) => {
      const color = colorAt(colors, entry.colorIndex);
      const ordered = [...entry.points].sort(
        (a, b) => (xIndex.get(String(a[0])) || 0) - (xIndex.get(String(b[0])) || 0),
      );
      const lineCommands = [];
      const areaPoints = [];
      ordered.forEach((point) => {
        const columnIndex = xIndex.get(String(point[0]));
        const value = numeric(point[1]);
        if (columnIndex === undefined || value === null) return;
        const key = String(point[0]);
        let plotted = value;
        let base = Math.max(yMin, 0);
        if (stacked) {
          const previous = baselines.get(key) || 0;
          baselines.set(key, previous + value);
          plotted = previous + value;
          base = previous;
        }
        const x = xAt(columnIndex);
        lineCommands.push(`${lineCommands.length === 0 ? 'M' : 'L'}${x.toFixed(2)},${yAt(plotted).toFixed(2)}`);
        areaPoints.push(`${x.toFixed(2)},${yAt(plotted).toFixed(2)}`);
        areaPoints.push(`${x.toFixed(2)},${yAt(base).toFixed(2)}`);
      });
      if (lineCommands.length === 0) return;
      if (meta.chartType === 'area') {
        children.push(
          React.createElement('polygon', {
            key: `area-${seriesIndex}`,
            points: areaPoints.join(' '),
            fill: color,
            opacity: 0.22,
          }),
        );
      }
      children.push(
        React.createElement('path', {
          key: `line-${seriesIndex}`,
          d: lineCommands.join(' '),
          fill: 'none',
          stroke: color,
          strokeWidth: 1.8,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
        }),
      );
      if (ordered.length <= 90) {
        const running = new Map();
        ordered.forEach((point) => {
          const columnIndex = xIndex.get(String(point[0]));
          const value = numeric(point[1]);
          if (columnIndex === undefined || value === null) return;
          const key = String(point[0]);
          let plotted = value;
          if (stacked) {
            const previous = running.get(key) || 0;
            running.set(key, previous + value);
            plotted = previous + value;
          }
          children.push(
            React.createElement('circle', {
              key: `node-${seriesIndex}-${columnIndex}`,
              cx: xAt(columnIndex),
              cy: yAt(plotted),
              r: 2.6,
              fill: color,
              onMouseEnter: () => onHover({ label: `${entry.name} · ${formatX(point[0])}`, value: formatNumber(value) }),
              onMouseLeave: () => onHover(null),
            }),
          );
        });
      }
    });
  }

  return React.createElement(
    'div',
    { className: 'dsh-chart-plot' },
    React.createElement(
      'svg',
      {
        viewBox: `0 0 ${width} ${height}`,
        width: '100%',
        height,
        preserveAspectRatio: 'xMidYMid meet',
        role: 'img',
        ref: svgRef,
      },
      ...children,
    ),
    hover ? React.createElement('div', { className: 'dsh-chart-tip' }, `${hover.label}：${hover.value}`) : null,
  );
}

function PieCanvas(props) {
  const { series, colors, height, hover, onHover, svgRef } = props;
  // A pie has one slice per category, i.e. per point of the (single) series the
  // host projects — not per series. The category name is the point's x.
  const entries = series
    .flatMap((entry) =>
      entry.points.map((point, index) => ({
        name: typeof point[2] === 'string' && point[2].length > 0 ? point[2] : String(point[0] ?? `#${index + 1}`),
        value: numeric(point[1]) || 0,
      })),
    )
    .filter((entry) => entry.value > 0);
  if (entries.length === 0) {
    return React.createElement('div', { className: 'dsh-chart-placeholder' }, '饼图需要正数数值。');
  }
  const total = entries.reduce((sum, entry) => sum + entry.value, 0);
  const width = 960;
  const centerX = 250;
  const centerY = height / 2;
  const radius = Math.max(40, Math.min(height / 2 - 18, 150));
  const children = [];
  let angle = -Math.PI / 2;
  entries.forEach((entry, index) => {
    const sweep = (entry.value / total) * Math.PI * 2;
    const start = angle;
    const end = angle + sweep;
    angle = end;
    const x1 = centerX + radius * Math.cos(start);
    const y1 = centerY + radius * Math.sin(start);
    const x2 = centerX + radius * Math.cos(end);
    const y2 = centerY + radius * Math.sin(end);
    const share = ((entry.value / total) * 100).toFixed(1);
    children.push(
      React.createElement('path', {
        key: `slice-${index}`,
        d:
          entries.length === 1
            ? `M${centerX - radius},${centerY} a${radius},${radius} 0 1 0 ${radius * 2},0 a${radius},${radius} 0 1 0 ${-radius * 2},0`
            : `M${centerX},${centerY} L${x1.toFixed(2)},${y1.toFixed(2)} A${radius},${radius} 0 ${sweep > Math.PI ? 1 : 0} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z`,
        fill: colorAt(colors, index),
        stroke: 'rgba(0,0,0,0.18)',
        strokeWidth: 0.6,
        onMouseEnter: () => onHover({ label: entry.name, value: `${formatNumber(entry.value)}（${share}%）` }),
        onMouseLeave: () => onHover(null),
      }),
    );
  });
  return React.createElement(
    'div',
    { className: 'dsh-chart-plot' },
    React.createElement(
      'svg',
      { viewBox: `0 0 ${width} ${height}`, width: '100%', height, preserveAspectRatio: 'xMidYMid meet', role: 'img', ref: svgRef },
      ...children,
    ),
    React.createElement(
      'div',
      { className: 'dsh-chart-pielegend' },
      ...entries.map((entry, index) =>
        React.createElement(
          'div',
          { className: 'dsh-chart-legend-item', key: `pielegend-${index}` },
          React.createElement('span', { className: 'dsh-chart-swatch', style: { background: colorAt(colors, index) } }),
          React.createElement('span', { className: 'dsh-chart-legend-name' }, entry.name),
          React.createElement('span', { className: 'dsh-chart-legend-value' }, `${((entry.value / total) * 100).toFixed(1)}%`),
        ),
      ),
    ),
    hover ? React.createElement('div', { className: 'dsh-chart-tip' }, `${hover.label}：${hover.value}`) : null,
  );
}

function Legend(props) {
  const { series, hidden, colors, onToggle } = props;
  if (series.length <= 1) return null;
  return React.createElement(
    'div',
    { className: 'dsh-chart-legend' },
    ...series.map((entry) =>
      React.createElement(
        'button',
        {
          type: 'button',
          key: entry.name,
          className: hidden.has(entry.name) ? 'dsh-chart-legend-item dsh-chart-legend-off' : 'dsh-chart-legend-item',
          onClick: () => onToggle(entry.name),
        },
        React.createElement('span', { className: 'dsh-chart-swatch', style: { background: colorAt(colors, entry.colorIndex) } }),
        React.createElement('span', { className: 'dsh-chart-legend-name' }, entry.name),
      ),
    ),
  );
}

function StatsTable(props) {
  const { series, stats, colors } = props;
  return React.createElement(
    'div',
    { className: 'dsh-chart-stats' },
    ...series.map((entry) => {
      const stat = isRecord(stats[entry.name]) ? stats[entry.name] : {};
      const parts = [];
      if (typeof stat.mean === 'number') parts.push(`均值 ${formatNumber(stat.mean)}`);
      if (typeof stat.min === 'number' && typeof stat.max === 'number') {
        parts.push(`区间 [${formatNumber(stat.min)}, ${formatNumber(stat.max)}]`);
      }
      if (typeof stat.change === 'number') {
        parts.push(`变化 ${stat.change >= 0 ? '+' : ''}${(stat.change * 100).toFixed(1)}%`);
      }
      if (typeof stat.sum === 'number') parts.push(`合计 ${formatNumber(stat.sum)}`);
      if (parts.length === 0) parts.push(`${entry.points.length} 个数据点`);
      return React.createElement(
        'div',
        { className: 'dsh-chart-stat-row', key: entry.name },
        React.createElement('span', { className: 'dsh-chart-swatch', style: { background: colorAt(colors, entry.colorIndex) } }),
        React.createElement('span', { className: 'dsh-chart-legend-name' }, entry.name),
        React.createElement('span', { className: 'dsh-chart-legend-value' }, parts.join(' · ')),
      );
    }),
  );
}

const CSS = `
.dsh-chart-card{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));border-radius:10px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);padding:10px 12px 12px;margin:4px 0;font-size:13px;line-height:1.5}
.dsh-chart-tail{display:flex;flex-direction:column;gap:10px;margin:10px 0}
.dsh-chart-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px}
.dsh-chart-titles{display:flex;flex-direction:column;min-width:0}
.dsh-chart-title{font-weight:600;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-chart-subtitle{color:var(--dsw-alias-label-secondary,inherit);opacity:.85;font-size:12px}
.dsh-chart-btn{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:inherit;border-radius:6px;padding:2px 8px;font-size:12px;cursor:pointer}
.dsh-chart-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12))}
.dsh-chart-plot{position:relative;width:100%}
.dsh-chart-plot svg{display:block;overflow:visible}
.dsh-chart-tip{position:absolute;top:6px;right:8px;background:var(--dsw-alias-bg-overlay,rgba(20,20,20,.86));color:var(--dsw-alias-label-primary,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:6px;padding:3px 8px;font-size:12px;pointer-events:none;white-space:nowrap;z-index:2}
.dsh-chart-legend,.dsh-chart-pielegend{display:flex;flex-wrap:wrap;gap:6px 12px;margin-top:6px}
.dsh-chart-legend-item{display:inline-flex;align-items:center;gap:5px;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;padding:1px 2px;border-radius:4px}
.dsh-chart-legend-item:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12))}
.dsh-chart-legend-off{opacity:.4;text-decoration:line-through}
.dsh-chart-swatch{width:9px;height:9px;border-radius:2px;display:inline-block;flex:0 0 auto}
.dsh-chart-legend-name{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-chart-legend-value{color:var(--dsw-alias-label-secondary,inherit);opacity:.85}
.dsh-chart-stats{margin-top:8px;border-top:1px dashed var(--dsw-alias-border-l1,rgba(128,128,128,.28));padding-top:6px;display:flex;flex-direction:column;gap:3px}
.dsh-chart-stat-row{display:flex;align-items:center;gap:6px;font-size:12px}
.dsh-chart-note{margin-top:6px;font-size:12px;color:var(--dsw-alias-label-secondary,inherit);opacity:.9}
.dsh-chart-error{color:var(--dsw-alias-state-error-primary,#E64545)}
.dsh-chart-placeholder{padding:14px 4px;color:var(--dsw-alias-label-secondary,inherit);font-size:12.5px;white-space:pre-wrap}
`;
