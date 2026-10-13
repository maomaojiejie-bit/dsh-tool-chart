/**
 * Offline build for `dsh-tool-chart`.
 *
 * The deployment that this package targets has no registry access and no
 * TypeScript/esbuild/tsdown installed, so this script uses the Node runtime's
 * own type stripper (`node:module` → `stripTypeScriptTypes`, Node >= 22.13) to
 * emit both halves:
 *
 *   src/transform.ts -> lib/transform.js   (plain ESM, types stripped)
 *   src/schema.ts    -> lib/schema.js
 *   src/present.ts   -> lib/present.js
 *   src/index.ts     -> lib/index.js
 *   src/client.tsx   -> lib/client.js      (classic-script ModuleLoader factory)
 *
 * `src/client.tsx` deliberately contains no JSX and no runtime imports, so the
 * browser half needs exactly two textual edits: the `export` keywords are
 * dropped and the body is wrapped in the lazy CJS factory that
 * `window.__ModuleLoader__.load` expects. `React` is provided by the factory.
 *
 * Usage: node build.mjs        (add --check to syntax-check via node --check)
 */
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, 'src');
const typesDir = join(here, 'types');
const libDir = join(here, 'lib');

const PACKAGE_NAME = 'dsh-tool-chart';

/** Rewrite explicit `.ts` / `.tsx` specifiers to the emitted `.js` files. */
function rewriteSpecifiers(code) {
  return code.replace(
    /(from\s*['"])(\.{1,2}\/[^'"]+)\.tsx?(['"])/g,
    (_match, head, specifier, tail) => `${head}${specifier}.js${tail}`,
  );
}

function emit(entry, outName) {
  const source = readFileSync(join(srcDir, entry), 'utf8');
  let code = stripTypeScriptTypes(source, { mode: 'strip' });
  code = rewriteSpecifiers(code);
  if (entry.endsWith('.tsx')) code = wrapClient(code);
  if (/from\s*['"]\.{1,2}\/[^'"]+\.tsx?['"]/.test(code)) {
    throw new Error(`build: ${entry} still has an unresolved .ts specifier after rewriting`);
  }
  writeFileSync(join(libDir, outName), code, 'utf8');
  return { entry, outName, bytes: Buffer.byteLength(code, 'utf8') };
}

/**
 * Turn a stripped ESM module with `export const inject` / `export function
 * apply` into the classic script the browser module loader materializes.
 */
function wrapClient(code) {
  const body = code
    .replace(/^export\s+(const|let|var|function|class|async)\b/gm, '$1')
    .trimEnd();
  if (/^\s*(import|export)\b/m.test(body)) {
    throw new Error('build: src/client.tsx may not keep any import/export after stripping');
  }
  return `window.__ModuleLoader__.load({
  id: ${JSON.stringify(PACKAGE_NAME)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    // The platform module table seeds React for every plugin bundle.
    const React = require('react');
${body.replace(/^/gm, '    ')}
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
`;
}

rmSync(libDir, { recursive: true, force: true });
mkdirSync(libDir, { recursive: true });

const outputs = [
  emit('transform.ts', 'transform.js'),
  emit('schema.ts', 'schema.js'),
  emit('present.ts', 'present.js'),
  emit('index.ts', 'index.js'),
  emit('client.tsx', 'client.js'),
];

for (const output of outputs) {
  console.log(`built lib/${output.outName} (${output.bytes} bytes)`);
}

// Hand-maintained declarations (no compiler available offline): `exports["."]`
// and `exports["./client"]` both point at these.
mkdirSync(join(libDir, 'types'), { recursive: true });
for (const declaration of ['index.d.ts', 'client.d.ts']) {
  const source = join(typesDir, declaration);
  if (!existsSync(source)) throw new Error(`build: missing types/${declaration}`);
  const body = readFileSync(source, 'utf8');
  writeFileSync(join(libDir, 'types', declaration), body, 'utf8');
  console.log(`built lib/types/${declaration} (${Buffer.byteLength(body, 'utf8')} bytes)`);
}

// The package `exports` map points `./client` at lib/client.js; a missing file
// makes activation fail, so assert it here.
for (const name of ['index.js', 'client.js', 'transform.js', 'schema.js', 'present.js']) {
  if (!existsSync(join(libDir, name))) throw new Error(`build: lib/${name} was not emitted`);
}
for (const name of ['types/index.d.ts', 'types/client.d.ts']) {
  if (!existsSync(join(libDir, name))) throw new Error(`build: lib/${name} was not emitted`);
}

console.log(`built ${resolve(libDir)}`);
