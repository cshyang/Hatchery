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

test('prompt allows a few meaningful status updates but rejects raw tool traces', async () => {
  const prompt = buildInstructions({
    projectName: 'project_1',
    personality: null,
    catalog: [],
  });

  assert.match(prompt, /up to 3 meaningful phase updates/i);
  assert.match(prompt, /Checking the repo/i);
  assert.match(prompt, /do not list raw tool names/i);
});

test('prompt tells the agent to include concise memory notices after memory changes', async () => {
  const prompt = buildInstructions({
    projectName: 'project_1',
    personality: null,
    catalog: [],
    memoryBlock: 'WHAT YOU REMEMBER\nMemory [1% — 20/2000]\n[1] This channel uses Calibrax-ai/autoship.',
  });

  assert.match(prompt, /Remembered:/);
  assert.match(prompt, /Memory updated:/);
  assert.match(prompt, /include a short memory notice/i);
});

await run();
