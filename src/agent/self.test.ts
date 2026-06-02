import assert from 'node:assert/strict';
import type { ToolDefinition } from '@flue/runtime';
import { createTestRunner } from '../shared/test-utils';
import { buildSelfStatus, selfStatusTool } from './self';

const { test, run } = createTestRunner();

const invoke = (tool: ToolDefinition) =>
  (tool as { execute: (args: Record<string, unknown>) => Promise<string> }).execute({});

test('buildSelfStatus reports the live runtime manifest without exposing connection config values', () => {
  const status = buildSelfStatus({
    projectId: 'C_PROJECT',
    agentSlug: 'default',
    model: 'gpt-test',
    hasDb: true,
    hasTicker: false,
    hasHeartbeatToken: false,
    hasBotToken: true,
    canRequestConnections: true,
    hasCodingRunner: true,
    providerCatalog: [
      { provider: 'github', summary: 'read repos' },
      { provider: 'notion', summary: 'read docs' },
    ],
    connectionState: [
      { provider: 'github', status: 'connected', config: { repo: 'owner/private-repo' } },
      { provider: 'notion', status: 'not_connected', config: {} },
    ],
    connectionToolNames: ['github_call_api', 'request_connection'],
  });

  assert.deepEqual(status.identity, { projectId: 'C_PROJECT', agentSlug: 'default' });
  assert.deepEqual(status.runtime, {
    harness: 'flue',
    substrate: 'cloudflare_durable_object',
    model: 'gpt-test',
  });
  assert.equal(status.capabilities.skills.enabled, true);
  assert.equal(status.capabilities.reminders.enabled, false);
  assert.equal(status.capabilities.sourceEvolution.enabled, true);
  assert.deepEqual(status.capabilities.sourceEvolution.tools, ['propose_self_change', 'dispatch_coding_run']);
  assert.match(status.capabilities.reminders.note, /TICKER/);
  assert.deepEqual(status.connections.providers, [
    { provider: 'github', status: 'connected', configKeys: ['repo'] },
    { provider: 'notion', status: 'not_connected', configKeys: [] },
  ]);
  assert.deepEqual(status.connections.requestableProviders, ['github', 'notion']);
  assert.deepEqual(status.connections.toolNames, ['github_call_api', 'request_connection']);
  assert.equal(JSON.stringify(status).includes('owner/private-repo'), false);
  assert.ok(status.limits.some((line) => line.includes('no filesystem')));
  assert.ok(status.limits.some((line) => line.includes('No raw environment access')));
});

test('self_status tool returns the manifest as formatted JSON', async () => {
  const tool = selfStatusTool({
    projectId: 'P',
    agentSlug: 'helper',
    model: 'gpt-test',
    hasDb: true,
    hasTicker: true,
    hasHeartbeatToken: true,
    hasBotToken: false,
    canRequestConnections: false,
    hasCodingRunner: false,
    providerCatalog: [],
    connectionState: [],
    connectionToolNames: [],
  });

  const parsed = JSON.parse(await invoke(tool));
  assert.equal(parsed.identity.projectId, 'P');
  assert.equal(parsed.capabilities.memory.enabled, true);
  assert.equal(parsed.capabilities.reminders.enabled, true);
  assert.equal(parsed.capabilities.sourceEvolution.enabled, true);
  assert.deepEqual(parsed.capabilities.sourceEvolution.tools, ['propose_self_change']);
});

run();
