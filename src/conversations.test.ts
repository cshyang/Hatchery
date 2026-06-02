// Conversation target invariants: ingress stores a provider-native reply target, while the
// agent only receives Hatchery's stable conversationId and resolves the target at send time.

import assert from 'node:assert/strict';
import { createTestRunner } from './test-utils';
import type { Binding } from './bindings';
import {
  loadConversationTarget,
  resolveTarget,
  sendToConversationTarget,
  topLevelTargetFromBinding,
  upsertConversationTarget,
  type ConversationTarget,
} from './conversations';
import { normalizeSlackMessage } from './canonical';
import type { D1Like } from './skills';

interface TargetRow {
  project_id: string;
  agent_slug: string;
  conversation_id: string;
  provider: 'slack';
  external_account_id: string;
  external_space_id: string;
  external_conversation_id: string;
  transport_token_ref: string;
  created_at: number;
  updated_at: number;
}

class FakeD1 implements D1Like {
  rows: TargetRow[] = [];

  prepare(query: string) {
    const db = this;
    return {
      bind(...v: unknown[]) {
        return {
          async run(): Promise<unknown> {
            return db.exec(query, v);
          },
          async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
            return { results: db.select(query, v) as T[] };
          },
          async first<T = Record<string, unknown>>(): Promise<T | null> {
            return (db.select(query, v)[0] ?? null) as T | null;
          },
        };
      },
    };
  }

  private select(q: string, v: unknown[]): Record<string, unknown>[] {
    if (q.includes('FROM conversation_targets')) {
      const [project_id, agent_slug, conversation_id] = v as [string, string, string];
      return this.rows
        .filter(
          (r) =>
            r.project_id === project_id &&
            r.agent_slug === agent_slug &&
            r.conversation_id === conversation_id,
        )
        .map((r) => ({
          project_id: r.project_id,
          agent_slug: r.agent_slug,
          conversation_id: r.conversation_id,
          provider: r.provider,
          external_account_id: r.external_account_id,
          external_space_id: r.external_space_id,
          external_conversation_id: r.external_conversation_id,
          transport_token_ref: r.transport_token_ref,
        }));
    }
    return [];
  }

  private exec(q: string, v: unknown[]): { meta: { changes: number } } {
    if (q.startsWith('INSERT INTO conversation_targets')) {
      const [
        project_id,
        agent_slug,
        conversation_id,
        provider,
        external_account_id,
        external_space_id,
        external_conversation_id,
        transport_token_ref,
        created_at,
        updated_at,
      ] = v as [string, string, string, 'slack', string, string, string, string, number, number];
      const existing = this.rows.find(
        (r) =>
          r.project_id === project_id &&
          r.agent_slug === agent_slug &&
          r.conversation_id === conversation_id,
      );
      if (existing) {
        existing.provider = provider;
        existing.external_account_id = external_account_id;
        existing.external_space_id = external_space_id;
        existing.external_conversation_id = external_conversation_id;
        existing.transport_token_ref = transport_token_ref;
        existing.updated_at = updated_at;
        return { meta: { changes: 1 } };
      }
      this.rows.push({
        project_id,
        agent_slug,
        conversation_id,
        provider,
        external_account_id,
        external_space_id,
        external_conversation_id,
        transport_token_ref,
        created_at,
        updated_at,
      });
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
}

const binding: Binding = {
  provider: 'slack',
  externalAccountId: 'T1',
  externalSpaceId: 'C1',
  transportBotId: 'Ubot',
  projectId: 'demo',
  sandboxMode: 'virtual',
  transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
  status: 'active',
};

const { test, run } = createTestRunner();

test('Slack normalization separates stable conversation id from native thread id', async () => {
  const msg = normalizeSlackMessage(
    'Ev1',
    'T1',
    { channel: 'C1', ts: '111.222', thread_ts: '100.000', user: 'U1', text: '<@Ubot> hi' },
    binding,
  );

  assert.equal(msg.conversationId, 'slack:T1:C1:100.000');
  assert.equal(msg.externalConversationId, '100.000');
  assert.equal(msg.senderId, 'slack:T1:U1');
});

test('conversation targets upsert and resolve by project, agent, and conversation', async () => {
  const db = new FakeD1();
  await upsertConversationTarget(db, {
    projectId: 'demo',
    conversationId: 'slack:T1:C1:100.000',
    provider: 'slack',
    externalAccountId: 'T1',
    externalSpaceId: 'C1',
    externalConversationId: '100.000',
    transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
  });
  await upsertConversationTarget(db, {
    projectId: 'demo',
    conversationId: 'slack:T1:C1:100.000',
    provider: 'slack',
    externalAccountId: 'T1',
    externalSpaceId: 'C1',
    externalConversationId: '100.000',
    transportTokenRef: 'SLACK_BOT_TOKEN_ROTATED',
  });

  const target = await loadConversationTarget(db, 'demo', 'default', 'slack:T1:C1:100.000');
  assert.equal(target?.externalSpaceId, 'C1');
  assert.equal(target?.externalConversationId, '100.000');
  assert.equal(target?.transportTokenRef, 'SLACK_BOT_TOKEN_ROTATED');
  assert.equal(await loadConversationTarget(db, 'demo', 'other-agent', 'slack:T1:C1:100.000'), null);
});

test('Slack send uses the stored provider target, not model-supplied channel fields', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown>; token: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      token: headers.get('authorization'),
    });
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const target: ConversationTarget = {
      projectId: 'demo',
      agentSlug: 'default',
      conversationId: 'slack:T1:C1:100.000',
      provider: 'slack',
      externalAccountId: 'T1',
      externalSpaceId: 'C1',
      externalConversationId: '100.000',
      transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
    };
    await sendToConversationTarget({ SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test' }, target, 'hello');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://slack.com/api/chat.postMessage');
    assert.equal(calls[0].token, 'Bearer xoxb-test');
    assert.deepEqual(calls[0].body, { channel: 'C1', text: 'hello', thread_ts: '100.000' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('top-level project posts omit provider-native thread id', async () => {
  const target = topLevelTargetFromBinding(binding);
  assert.equal(target.conversationId, '');
  assert.equal(target.externalConversationId, null);
  assert.equal(target.externalSpaceId, 'C1');
});

test('resolveTarget: top-level for empty conversationId, stored target otherwise, null without db', async () => {
  const db = new FakeD1();
  await upsertConversationTarget(db, {
    projectId: 'demo',
    conversationId: 'slack:T1:C1:100.000',
    provider: 'slack',
    externalAccountId: 'T1',
    externalSpaceId: 'C1',
    externalConversationId: '100.000',
    transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
  });

  // No conversationId → top-level project target (new post / heartbeat).
  const top = await resolveTarget(db, binding, 'demo', 'default', '');
  assert.equal(top?.conversationId, '');
  assert.equal(top?.externalConversationId, null);

  // conversationId relayed → the stored per-conversation target (lands in-thread).
  const stored = await resolveTarget(db, binding, 'demo', 'default', 'slack:T1:C1:100.000');
  assert.equal(stored?.externalConversationId, '100.000');

  // conversationId given but no db → null (can't resolve a stored target).
  assert.equal(await resolveTarget(undefined, binding, 'demo', 'default', 'slack:T1:C1:100.000'), null);
});

await run();
