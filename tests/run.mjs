/**
 * Offline test entry point.
 *
 * `node --test tests/` makes the runner spawn a child process per file, which
 * the DSH file sandbox blocks (EPERM on piped stdio). Importing the test files
 * in-process runs exactly the same `node:test` assertions without spawning:
 *
 *   node --test tests/run.mjs      # or simply:
 *   node tests/run.mjs
 */

import test from 'node:test';

import './transform.test.ts';
import './validate.test.ts';
import './client-smoke.test.ts';

// Registering one test in this entry keeps `node:test`'s root harness alive, so
// the imported files' own test cases are reported by the normal reporter.
test('test files loaded', () => {});
