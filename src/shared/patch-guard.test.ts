// Patch-applied guard — run: npx tsx src/shared/patch-guard.test.ts
//
// patches/@flue+runtime+0.11.0.patch strips partial.content from journaled stream
// events to prevent SQLITE_TOOBIG (see src/shared/stream-journal.ts). patch-package
// reapplies it on every install, but a @flue/runtime version bump silently drops it
// (the bundled filename carries a content hash). This test fails loudly if the marker
// is missing from the installed runtime, so a bump can't quietly reintroduce the bug.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTestRunner } from './test-utils';

const { test, run } = createTestRunner();

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '../../node_modules/@flue/runtime/dist');

test('Flue stream-journal patch is applied in the installed runtime', () => {
  const files = readdirSync(distDir).filter((f) => f.startsWith('sandbox-') && f.endsWith('.mjs'));
  assert.ok(files.length > 0, 'expected a sandbox-*.mjs bundle in @flue/runtime/dist');

  const patched = files.some((f) =>
    readFileSync(join(distDir, f), 'utf8').includes('stripPartialContentForJournal'),
  );
  assert.ok(
    patched,
    'PATCH(hatchery) stripPartialContentForJournal not found in @flue/runtime — ' +
      'run `npx patch-package @flue/runtime` after re-applying the edit, or regenerate ' +
      'patches/@flue+runtime+*.patch for the new version (see src/shared/stream-journal.ts).',
  );
});

await run();
