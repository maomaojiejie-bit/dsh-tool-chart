# dsh-tool-chart

让模型用**声明式规格**画图，并把结果渲染成会话流里的**真实可交互图表卡片**，而不是文本或 base64 图片。

一次 `chart` 调用完成三件事：

1. 宿主侧把长表/宽表数据校验、透视、下采样、统计，产出一份自描述的规范值（canonical value）；
2. 模型只看到一段紧凑的中文结论 + 关键统计（点数、均值、环比、区间），逐点数据不进上下文；
3. 浏览器侧从持久化的 `result.meta` 里重建同一张卡片，所以**日志回放不需要重跑工具**。

```text
chart({ type: 'line', title: '2026 Q3 各渠道 GMV', x: 'month', y: ['online', 'store'], dataRef: '/…/rows.json' })
  → 模型可见：已生成「2026 Q3 各渠道 GMV」折线图，含 2 个系列（online/store）、共 6 个数据点。…
  → 会话卡片：折线图 + tooltip + 图例点选 + PNG 下载（跟随深浅色主题）
```

---

## 安装与启用

```bash
dsh plugin --profile <profile> add ./dsh-tool-chart      # 或 dsh plugin add dsh-tool-chart
dsh --profile <profile> --dump-config                    # 应出现 `# == dsh-tool-chart` 层
dsh --profile <profile>
```

包内 `cordis.patch.yml` 只有一个 Loader 行：

```yaml
- insert:
    - id: tool-chart
      name: dsh-tool-chart
```

**一个 bundle 只有一行，行名即包名**：`./client` 导出由同一行的 `dsh.client` 清单带进浏览器 boot graph，因此不需要额外的 `dsh-tool-chart/client` 行（那种多行写法只在宿主与客户端是**两个包**时才需要）。

配置覆盖写在 profile 的 `cordis.patch.yml` 里（同一 `id` 只写 `config:`）：

```yaml
- id: tool-chart
  config:
    defaultTheme: dark
    enabledTypes: [line, bar, pie]
    maxSeries: 8
    themes:
      dark:
        mode: dark
        palette:
          series: ['#6E9BFF', '#F5B95C']
          positive: '#E64545'   # 中国习惯：涨=红
          negative: '#2EA84F'   # 中国习惯：跌=绿
```

---

## 工具接口

`parameters`（作者侧 schema DSL，根对象是隐式开放对象）：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `type` | `line \| bar \| area \| scatter \| pie \| heatmap \| candlestick \| boxplot` | 必填 |
| `data` | `object[]` | 内联行；与 `dataRef` 二选一 |
| `dataRef` | `string` | spill 文件定位符（本地路径）；与 `data` 二选一 |
| `x` | `string` | 类别/时间字段；缺省按行号 |
| `y` | `string \| string[]` | 数值字段；K 线必须正好 4 个（open/high/low/close），箱线 ≥1 |
| `series` | `string` | 分组字段（长表→宽表）；pie/heatmap 不支持 |
| `color` | `string` | 连续色阶字段：scatter 的点值 / heatmap 的格子值 |
| `stack` | `boolean` | 堆叠（line/area/bar） |
| `sort` | `none \| asc \| desc` | 类别排序 |
| `limit` | `number` | 先截断行；命中即 `truncated: true` |
| `axes` | `{ xLabel?, yLabel?, yMin?, yMax? }` | 轴标签与范围 |
| `annotations` | `{ x, text, kind? }[]` | 参考线/区间 |
| `theme` | `string` | 取 `Config.themes` 的键 |
| `height` | `number` | 卡片高度（px），被 `minHeight`/`maxHeight` 夹取 |

`output.schema`（规范值，`additionalProperties: false`，`required: [chartId, type, encoding, series, truncated, total]`）刻意**不含**颜色、像素、ECharts option、React props —— 那些都是表现层，写进规范值只会污染上下文并破坏回放稳定性。

失败与“不理想的结果”分开：**参数/数据错误抛异常**（registry 标记 `isError`，消息可执行，例如
`参数 \`y\`：数值字段 "nope" 在数据中不存在；可用字段：m, online, store。`），而“结果被截断/下采样”是**成功的领域结果**，写进规范值的 `truncated` 字段。

---

## 配置

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `defaultTheme` | `light` | 未传 `theme` 时使用，必须是 `themes` 的键 |
| `themes` | light/dark 两套 | 主题名 → `{ mode, palette }`；`palette.series` 必填非空 |
| `themeOverrides` | `{}` | 按主题名局部覆盖调色板（只写要改的键） |
| `enabledTypes` | 全部 8 种 | 从列表移除即对该部署禁用该类型 |
| `maxInlineRows` | `5000` | 内联 `data` 行数上限 |
| `maxPointsPerSeries` | `2000` | 卡片每系列保留点数（超出 LTTB 下采样） |
| `maxSeries` | `20` | 系列数上限，超出截断并标记 `truncated` |
| `defaultLimit` / `maxOutputPoints` | `5000` / `20000` | 行数默认上限 / 一次调用的总点数上限 |
| `defaultHeight` / `minHeight` / `maxHeight` | `320` / `160` / `1200` | 卡片高度与夹取范围 |
| `defaultAnnotations` | `[]` | 未传 `annotations` 时使用的默认标注 |
| `dataRefMode` | `spill-path` | `none` 时拒绝读文件（只允许内联数据） |
| `chartIdPrefix` | `chart` | `chartId` 前缀 |

**没有硬编码的可调项**：改主题、调色板、启用类型、上限、CDN/高度都能只改 `cordis.patch.yml` 的 `config`，不动代码。

**配置错误必须响亮**：`themes.series` 非空、`defaultTheme` 必须存在、`enabledTypes` 非空且必须是已知类型、`maxSeries ≥ 1`、`maxPointsPerSeries ≥ 3`、`defaultHeight` 落在夹取区间内 —— 任一不满足，`apply()` 在**注册工具之前**抛错，插件加载直接失败。

---

## 扩展点

* **宿主**：`apply(ctx, config)` → `ctx.tools.register(defineTool({...}))`。注册是 fiber 副作用，fiber 销毁自动反注册，代码里没有任何 `removeListener`/`clearInterval`。
* **客户端**：`apply(ctx)` 里 `ctx.effect()` 插入包自有样式表（HMR/卸载时移除），然后注册两处：
  1. `ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({ name: 'conversation.chat.turnTail', id: 'dsh-tool-chart', order: -5, inject: (sessionId) => ({ keyedHooks: { chartCards: (turn) => snapshot.nodes.turnDataSource(Number(turn), 'tool-call') } }) }, ChartTail))`
     —— **正文图表卡片**：读本回合自己的 `tool-call` 节点（`data.root` 就是调用行要渲染的那个 block，含持久化的 `meta`），不重新推导任何数据，回放因此逐字节可重建。
  2. `ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'chart', inject: () => ({ promotion: promote }) }, ChartBoundary))`
     —— 调用行视图。keyed slot 按**线上工具名**派发，`chart` 这个 key 不与内置视图冲突；命中即替换通用行。
  `promote.enabled` **只在正文条目确实注册成功后**才置真，此后调用行收敛成一行回执（标题 + 类型 +「已显示在会话正文」），避免同一张图出现两次；若该 slot 不存在（老页面或被裁剪的宿主），标志保持为假，调用行继续显示完整卡片 —— **任何情况下都不丢图**。
* 想换渲染器：只改 `src/client.tsx`。宿主与规范值不知道任何渲染细节，`meta` 里只有 `colorIndex`（语义→索引）而不是 hex。
* 想换数据源：`BuildOptions.readDataRef(locator)` 是唯一入口；`src/index.ts` 用 `ctx.get('fs')` 实现它。

### 设计取舍

* **宿主纯函数**：`presentCall` / `presentResult` / `output.presentationMeta` 无 I/O、无时钟、无随机 —— 直播与日志回放都会调用它们。`presentCall` 只画“将要画什么”（标题 + 类型 + 字段映射），不碰数据。
* **卡片数据来自 `presentationMeta`**：只有**顶层**调用会持久化 `meta`（PTC 子调用不写），所以 PTC 派发的 `chart` 子调用在客户端会降级成通用行。
* **卡片画在正文，而不是工具调用里**：聊天会把一个回合的「过程」（含全部工具行）收进可折叠的 disclosure。`conversation.chat.node` 的固定 kind 表把 `turn-tail` 列为**不受该折叠影响**的 kind（`TURN_PROCESS_INDEPENDENT_KINDS`），而 `tool-call` 不在其中 —— 所以自定义 chat node（锚点落在工具事件上）仍会被折进去，只有 Turn tail 贡献能稳定显示在正文中。`ChartTail` 因此不新增事件定义，只读本回合已有的 `tool-call` 节点。
* **客户端零主题 JS**：容器/边框用 `var(--dsw-alias-*)`，文字用 `fill: currentColor`，深浅色自动跟随，不需要订阅 `theme/change`。
* **不引第三方图表库**：平台的浏览器模块表是冻结的 9 个词（`react`、`react-dom`、`@deepseek-ai/cordis`、`dsh-client-store`、`dsh-client-ui-slots`、`dsh-client-ui-primitives`、`dsh-client-ui-dockkit` 等），`echarts`/`d3` 不在其中；要么把库 inline 进 `lib/client.js`，要么声明 `dsh.client.external` 并提供一个 provider 行。为了保持零依赖、可由 `build.mjs` 离线产出，本包用手写 SVG 渲染，只 `require('react')`。
* **客户端输入全部本地校验**：`meta` 不是对象、`schemaVersion` 不认识、系列为空、类型不支持 —— 一律降级为可读占位行。**永不返回 null、永不抛错**：抛错会让整个 slot 单元格变成 `data-slot-error`，回放就毁了。

---

## Model Experience

### Request context and condition

模型通常在“刚拿到一批结构化结果”的时刻调用 `chart`：查询/脚本/文件工具返回了几十到几万行、需要按类别或时间看图才能判断趋势。触发条件是**要看分布/趋势/对比，而不是要逐点数值**——逐点数值用 `read`/搜索更便宜。

工具描述里写明了可用类型与“`data` 与 `dataRef` 二选一 + `x`/`y`/`series` 映射”的最小心智模型，所以模型不必看文档就能构造第一次调用；写错字段时抛出的错误会指名**哪个参数、期望什么、实际收到什么、可用字段有哪些**，模型可直接改一次参数重试。

### What the model sees

只有 `output.render` 的文本块，两段结构：

* 结论行：`已生成「2026 Q3 各渠道 GMV」折线图，含 2 个系列（online/store）、共 6 个数据点。`
* 每系列一行统计：`online：均值 116.67，环比 +10.0%，区间 [100, 130]，合计 350`（数值按 K/M/B 缩写）
* 收尾提示：`（完整数据见图表卡片；如需逐点数值可用 dataRef 引用或读取 spill 文件。）`
* 被截断时追加一行明确警告：`注意：结果已截断（原始 … 个数据点），图表只包含已保留的部分。`

**逐点数据不进模型上下文**：点集只在规范值（工具结果本体）与卡片 `meta` 里。这让“画一张 5000 点的图”对上下文的成本约等于“读一条统计行”。

### Token effect

* 每次调用模型可见文本 ≈ 1 条结论 + 每系列 1 行 + 1 条提示，通常 **80–250 token**，与数据规模基本无关（点数只影响一个整数）。
* 作为对比：把 5000 行的逐点数据塞回上下文通常是 **数万 token**；本工具把这块恒定压到零。
* 参数侧反而要求**不要**内联大数据：`data` 超过 `maxInlineRows` 直接报错并提示改用 `dataRef`，从机制上阻止“把 5000 行 JSON 塞进 tool args”。`dataRef` 只传一个路径字符串（几十字节）。
* 统计行按需出现，缺失的统计字段不会输出空占位。

### KV Cache effect

* 规范值里的 `chartId` 由 `chartIdPrefix` + 类型 + 稳定 slug 派生（不含时间戳/随机数），同样的输入得到同样的 id，**重放与重试不会改写前缀**。
* `render`/`presentationMeta`/`presentCall`/`presentResult` 都是纯函数：同一 `(args, value)` 永远产出同一投影。工具结果因此在同一会话里是**字节稳定**的，追加历史不会让旧前缀失效。
* 模型可见内容里没有逐点数据，所以后续轮次即使重新渲染该结果，也不会把大块点集重新写进 prompt 前缀。
* 唯一会让前缀变化的是工具本身的 `description`/`parameters`（改代码或配置）——这是加载时一次性成本，不是每轮成本。

---

## Known Limitations and Deferred Work

* **消费方可见缺口 —— 缺少“通用会话事件引用”解析（`dataRef` 只支持 spill 文件定位符）。**
  PROMPT 举例的 `dataRef: "$.steps[2].toolResult.value"` 那种表达式引用**没有**实现：本部署里没有文档化的 JSONPath/指针入口（`ctx.sessionQuery` 的过滤器是“语义文本扫描”，不是指针解析），凭猜测实现会变成会静默取错数据的假能力。当前行为是：`dataRef` 当作 spill 定位符交给 `ctx.get('fs').readText()`；读不到就抛出可执行提示（`dataRef 只支持 spill 文件定位符…请改用内联 data`），配置 `dataRefMode: 'none'` 时直接拒绝读文件。
  **后果**：消费方“引用上一次工具结果直接画图”的路径不可用，必须先自己把数据写进 spill（或内联）。**维护者约束**：要补这个能力，必须先在宿主里确定一个受支持的“会话事件取值”入口（session-query 的 `readEvent`/`readSurface` 之上再定义选择器语义），而不是在工具里自造路径方言。
* **`card: 'chart'` 不是真实的 presenter 变体。** `ToolCallView` 的联合只有 `generic`/`terminal`/`diff`，`ToolResultView` 再多 `search`/`read`/`web`；且内置 Web Client **不消费** `presentCall`/`presentResult`。所以宿主 presenter 只发 `card: 'generic'`，真正的卡片来自客户端 `tool.call.toolview`。
* **candlestick / boxplot 客户端降级。** 宿主侧完整校验并持久化（K 线打包 `[open, close, low, high]`、箱线五位摘要），但与 ECharts 不同，手写 SVG 目前只画 line/area/bar/scatter/pie/heatmap；K 线/箱线在客户端显示为**可读占位行**（说明“该类型暂无本渲染器的图形实现”），不会假装画出错误的图。补齐方式：在 `src/client.tsx` 里加两个画布分支（宿主契约已就绪）。
* **PTC 子调用没有卡片。** 规范值只在顶层调用写 `meta`（registry 行为），因此通过 PTC 派发（`parentCallId` 存在）的 `chart` 调用在客户端降级为通用行。这是宿主约定，不是本包的选择。
* **数据标签/图例不做虚拟化。** 系列数上限 20、点数 2000 已足够避免主线程卡顿，但极端情况下（20×2000 个 `<circle>`）仍是重 DOM；后续可改为 canvas 渲染或点在 SVG 上按需抽稀。
* **`prepare` 与 `pnpm-workspace.yaml` 的 `allowBuilds`。** 走 git:/tarball 分发时，`prepare` 会执行 `node build.mjs`（离线可用，只依赖 Node 内建 `stripTypeScriptTypes`）；若宿主 pnpm 要求显式允许构建脚本，需在 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 里放行本包，或直接分发**已构建**的 `lib/`（`files` 已包含 `lib`，推荐）。
* **依赖声明与 PROMPT 的字面要求有一处偏差。** `@deepseek-ai/schemastery` 放在 `peerDependencies`（optional）并镜像进 `devDependencies`，**没有**放进 `dependencies`。原因：本部署没有 registry 访问，`dependencies` 会让安装阶段尝试解析套件包而失败；而实测（`dsh-image-gen` 以及 profile 内其他插件）表明宿主自己解析 `@deepseek-ai/*`，声明为 peer 即可在运行时可用。若要改成 `dependencies`，请同时确认安装环境能解析该包。
* **没有跑通的可视化验证环境。** `dsh-tool-chart` 的宿主半边已对**真实** `@deepseek-ai/dsh-tools`（0.2.0-rc.2）验证：参数 schema 编译、规范值通过 registry 的 `validateJsonSchemaValue`、`render`/`presentationMeta` 输出形状、`ToolArgsError` 与领域错误路径，共 10 项 smoke 检查（`npm run test:host`）。浏览器半边只做了**语法**与**契约**级验证（`node --check`、slot key/descriptor 形状、`meta` 防御式读取），未经真实 Web 客户端渲染验证。
* **`presentationMeta` 里存了调色板 hex。** 规范值保持无颜色，但 `meta.theme.palette` 会带上主题调色板（这样回放时即使配置改了主题，卡片仍按当时的样子重建）。它仍是 JSON 安全的纯数据，不含 React props 或渲染器实例。

---

## 开发

```bash
node build.mjs                                    # 离线构建 lib/（Node 内建类型剥离）
node tests/run.mjs                                # 68 项：42 纯函数/校验单测 + 26 项客户端半区 smoke
node --import ./tests/harness-register.mjs tests/host-smoke.mjs   # 10 项宿主 smoke（真实 dsh-tools）
```

`tests/client-smoke.test.ts` 用 `window.__ModuleLoader__` 桩 + 极简 `document` + 内存版 React hooks 加载真实的
`lib/client.js`，断言：工厂只 `require('react')`、`apply` 通过 `ctx.effect` 托管样式表、注册键恰为
`tool.call.toolview/key: 'chart'` 与 `conversation.chat.turnTail/id: 'dsh-tool-chart'`、正文条目按回合读 `tool-call`
节点并在无图/其它工具/无 meta/失败/坏 hook 时静默、回执与回退两条路径，以及 preparing/start/error/缺 meta/schemaVersion
不符/空数据/不支持类型等降级分支与折线、柱状、热力图、饼图、截断、未知主题回退的正常渲染路径。它不渲染真实 DOM（无 react-dom），
因此「像素级外观」仍属于浏览器人工验证，见 Known Limitations。

`build.mjs` 用 Node ≥22.13 的 `stripTypeScriptTypes` 剥类型，并把 `src/client.tsx`（无 JSX、无运行时 import）文本包装成平台要求的
`window.__ModuleLoader__.load({ id: 'dsh-tool-chart', factory })` 经典脚本；`tests/harness-resolver.mjs` 负责把 `@deepseek-ai/*` 解析到本机部署的 app node_modules，从而在无 node_modules 的仓库里也能对着真实校验器测试。有工具链的环境可改用 `tsdown.config.ts`。
