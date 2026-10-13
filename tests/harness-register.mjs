/**
 * Registers the `@deepseek-ai/*` resolver hook for the host smoke test.
 *
 *   node --import ./tests/harness-register.mjs tests/host-smoke.mjs
 */
import { register } from 'node:module';

register('./harness-resolver.mjs', import.meta.url);
