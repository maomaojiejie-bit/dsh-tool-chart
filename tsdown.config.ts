/**
 * tsdown configuration (optional path).
 *
 * `pnpm run build` runs `node build.mjs`, which is the only build that works in
 * a deployment without registry access and without a TypeScript toolchain: it
 * uses the Node runtime's `stripTypeScriptTypes` and wraps the browser half in
 * the classic-script `window.__ModuleLoader__.load` factory by hand.
 *
 * This file exists so that an environment WITH the toolchain emits the same
 * two artifacts via tsdown:
 *
 *   lib/index.js   ESM host half   (src/index.ts)
 *   lib/client.js  browser half    (src/client.tsx)
 *
 * `src/client.tsx` contains no JSX and imports nothing at runtime except the
 * platform-seeded `react`, so nothing needs to be inlined and no dependency may
 * be declared external: a bare `require()` miss for anything outside the frozen
 * platform module table fails bundle activation at runtime.
 */
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/client.tsx'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'neutral',
  target: 'es2023',
  dts: false,
  clean: false,
  sourcemap: false,
  // Bundle everything that is not a type-only import; the host resolves
  // `@deepseek-ai/*` itself, and the browser half must ship the chart renderer.
  external: ['react', 'react/jsx-runtime'],
  outputOptions: {
    // dsh source splitting compiles dynamic import() to require.async(); the
    // client entry must stay a single file, so keep chunks off.
    manualChunks: undefined,
    inlineDynamicImports: true,
  },
});
