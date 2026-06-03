// Project-agent prompt setup guidance invariants — run: npx tsx src/agent/prompt.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { buildInstructions } from './prompt';

const { test, run } = createTestRunner();

test('Slack setup prompt tells the agent to call setup_status before request_connection', async () => {
  const prompt = buildInstructions({
    projectName: 'project_1',
    personality: null,
    catalog: [],
    connectionsBlock: 'YOUR CONNECTIONS\n  ⚪ github (not connected)\n  ⚪ linear (not connected)\ncall request_connection',
  });

  assert.match(prompt, /setup_status/i);
  assert.match(prompt, /request_connection/i);
  assert.ok(
    prompt.indexOf('setup_status') < prompt.indexOf('request_connection'),
    'setup_status guidance must appear before request_connection guidance',
  );
});

await run();
