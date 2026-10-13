/**
 * Public type surface of the browser half (`dsh-tool-chart/client`).
 *
 * The module is loaded as a classic script through
 * `window.__ModuleLoader__.load({ id: 'dsh-tool-chart', factory })`; the bundle
 * resolves only the platform-seeded `react` and registers a renderer in the
 * keyed slot `tool.call.toolview` under the key `chart`.
 */
export declare const inject: readonly ['slots'];

/** Registers the chart toolview. Styles and the slot entry are fiber effects. */
export declare function apply(ctx: unknown): void;
