// Agent Kit filesystem contract — run: npx tsx src/agent-runs/agent-kits.test.ts
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createTestRunner } from '../shared/test-utils';

const { test, run } = createTestRunner();

const requiredFiles = [
  'agents/scout.md',
  'agents/planner.md',
  'agents/worker.md',
  'agents/reviewer.md',
  'agents/oracle.md',
  'skills/test-evidence.md',
  'skills/pr-summary.md',
  'policy.md',
];

test('coding-default Agent Kit exposes required markdown assets', () => {
  const kitRoot = path.join(process.cwd(), 'agent-kits', 'coding-default');
  for (const relativePath of requiredFiles) {
    const file = path.join(kitRoot, relativePath);
    assert.equal(existsSync(file), true, `${relativePath} exists`);
    const body = readFileSync(file, 'utf8');
    assert.match(body, /^---\nname: /, `${relativePath} has minimal frontmatter`);
    assert.match(body, /^# /m, `${relativePath} has a markdown title`);
  }
});

await run();
