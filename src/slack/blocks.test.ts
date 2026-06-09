// Slack Block Kit renderer invariants — run: npx tsx src/slack/blocks.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { agentRunNotificationText, agentRunNotificationBlocks } from './blocks';
import type { AgentRun } from '../agent-runs/repository';

const { test, run } = createTestRunner();

const agentRun: AgentRun = {
  id: 'run-1',
  projectId: 'project_1',
  routeId: 'route-1',
  sourceType: 'linear',
  sourceId: 'delivery-1',
  idempotencyKey: 'linear:issue:issue-1:run-agent',
  linearIssueId: 'issue-1',
  linearIdentifier: 'EDK-42',
  linearUrl: 'https://linear.app/acme/issue/EDK-42/fix-slack',
  slackTeamId: null,
  slackChannelId: null,
  slackThreadTs: null,
  githubOwner: 'Calibrax-ai',
  githubRepo: 'autoship',
  targetRepo: 'github.com/Calibrax-ai/autoship',
  baseBranch: 'main',
  kit: 'coding-default',
  runtime: 'pi',
  sandboxProvider: 'e2b',
  sandboxId: null,
  triggerRunId: null,
  status: 'waiting_approval',
  branch: 'agent/EDK-42',
  commitSha: 'abc123',
  prUrl: 'https://github.com/Calibrax-ai/autoship/pull/7',
  ciUrl: null,
  summary: 'Implemented Slack rendering.',
  error: null,
  statusNote: null,
  lastEventId: null,
  lastHeartbeatAt: null,
  dispatchAttempts: 1,
  lastDispatchError: null,
  dispatchedAt: 123,
  dispatchPayload: null,
  createdAt: 100,
  updatedAt: 200,
  completedAt: null,
};

test('agentRunNotificationText renders a Slack-ready PR opened fallback', () => {
  const text = agentRunNotificationText('pr_opened', agentRun);

  assert.match(text, /PR opened/);
  assert.match(text, /<https:\/\/github\.com\/Calibrax-ai\/autoship\/pull\/7\|Open PR>/);
  assert.match(text, /EDK-42/);
  assert.doesNotMatch(text, /undefined|null/);
});

test('agentRunNotificationBlocks renders backend-owned Block Kit with fallback fields', () => {
  const blocks = agentRunNotificationBlocks('pr_opened', agentRun);

  assert.equal(blocks[0].type, 'header');
  assert.deepEqual(blocks[0], {
    type: 'header',
    text: { type: 'plain_text', text: 'Agent run waiting for review', emoji: true },
  });
  assert.equal(blocks.some((block) => JSON.stringify(block).includes('Calibrax-ai/autoship')), true);
  assert.equal(blocks.some((block) => JSON.stringify(block).includes('Open PR')), true);
});

test('agentRunNotificationBlocks keeps failed errors bounded', () => {
  const failed = { ...agentRun, status: 'failed' as const, error: 'x'.repeat(500) };
  const text = JSON.stringify(agentRunNotificationBlocks('failed', failed));

  assert.equal(text.includes('x'.repeat(500)), false);
  assert.match(text, /Run failed/);
});

await run();
