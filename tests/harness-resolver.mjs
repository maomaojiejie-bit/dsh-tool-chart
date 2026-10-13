/**
 * Development-only module resolver hook.
 *
 * The workspace has no node_modules and no registry access, but the desktop
 * deployment ships every `@deepseek-ai/*` package under the app's
 * node_modules. This hook lets a smoke test import `lib/index.js` with the
 * REAL `defineTool`/schema validators, so host-side wiring is verified against
 * the same code the harness runs.
 *
 * Usage: node --import ./tests/harness-resolver.mjs tests/host-smoke.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const APP_MODULES = 'C:/Users/17897/AppData/Local/Programs/DSH Desktop/resources/app/node_modules';

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('@deepseek-ai/')) return nextResolve(specifier, context);
  const packageDir = path.join(APP_MODULES, specifier);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  } catch {
    return nextResolve(specifier, context);
  }
  let entry = manifest.exports?.['.'] ?? manifest.main ?? 'index.js';
  if (typeof entry === 'object') entry = entry.default ?? entry.import ?? entry.require;
  return { url: pathToFileURL(path.join(packageDir, entry)).href, shortCircuit: true };
}
