// Slack activity receipt invariants — run: npx tsx src/slack/activity.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import type { D1Like } from '../skills/repository';
import {
  completeSlackTurnActivity,
  createSlackTurnActivity,
  handleObservedSlackActivity,
  loadSlackTurnActivity,
  recordSlackStreamHeartbeat,
  recordSlackToolActivity,
  renderSlackActivityReceipt,
  reapStaleTurnActivities,
  STREAM_HEARTBEAT_MS,
  shouldPostFinalBelowActivity,
  TURN_DIED_RESET_TEXT,
  TURN_DIED_TEXT,
  TURN_RETRYING_TEXT,
  TURN_DOA_STALE_MS,
  TURN_STALE_MS,
  toolActivityLabel,
} from './activity';

const { test, run } = createTestRunner();

type Row = Record<string, unknown>;

class FakeD1 implements D1Like {
  rows: Row[] = [];

  prepare(query: string) {
    const db = this;
    return {
      bind(...values: unknown[]) {
        return {
          async first<T = Row>(): Promise<T | null> {
            const { results } = await this.all<T>();
            return results[0] ?? null;
          },
          async all<T = Row>(): Promise<{ results: T[] }> {
            if (query.includes("status='active' AND updated_at <")) {
              const [cutoff] = values as [number];
              // Detached copies, like real D1 — the reaper's own updates must not mutate what it read.
              return { results: db.rows.filter((row) => row.status === 'active' && (row.updated_at as number) < cutoff).map((row) => ({ ...row })) as T[] };
            }
            if (query.includes('FROM slack_turn_activity')) {
              const [projectId, sessionId] = values;
              return {
                results: db.rows.filter((row) => row.project_id === projectId && row.session_id === sessionId) as T[],
              };
            }
            return { results: [] as T[] };
          },
          async run(): Promise<{ meta: { changes: number } }> {
            if (query.startsWith('INSERT INTO slack_turn_activity')) {
              const [
                projectId,
                sessionId,
                conversationId,
                slackChannelId,
                slackThreadTs,
                ackMessageTs,
                transportTokenRef,
                status,
                activitiesJson,
                lastPostedAt,
                createdAt,
                updatedAt,
                completedAt,
              ] = values;
              const existing = db.rows.find((row) => row.project_id === projectId && row.session_id === sessionId);
              if (existing) {
                Object.assign(existing, {
                  conversation_id: conversationId,
                  slack_channel_id: slackChannelId,
                  slack_thread_ts: slackThreadTs,
                  ack_message_ts: ackMessageTs,
                  transport_token_ref: transportTokenRef,
                  status,
                  activities_json: activitiesJson,
                  last_posted_at: lastPostedAt,
                  created_at: createdAt,
                  updated_at: updatedAt,
                  completed_at: completedAt,
                });
              } else {
                db.rows.push({
                  project_id: projectId,
                  session_id: sessionId,
                  conversation_id: conversationId,
                  slack_channel_id: slackChannelId,
                  slack_thread_ts: slackThreadTs,
                  ack_message_ts: ackMessageTs,
                  transport_token_ref: transportTokenRef,
                  status,
                  activities_json: activitiesJson,
                  last_posted_at: lastPostedAt,
                  created_at: createdAt,
                  updated_at: updatedAt,
                  completed_at: completedAt,
                });
              }
              return { meta: { changes: 1 } };
            }
            if (query.includes("SET status='failed', completed_at=")) {
              const [completedAt, updatedAt, doaInc, projectId, sessionId] = values;
              const row = db.rows.find((item) => item.project_id === projectId && item.session_id === sessionId && item.status === 'active');
              if (!row) return { meta: { changes: 0 } };
              Object.assign(row, {
                status: 'failed',
                completed_at: completedAt,
                updated_at: updatedAt,
                doa_count: ((row.doa_count as number) ?? 0) + (doaInc as number),
              });
              return { meta: { changes: 1 } };
            }
            if (query.includes('SET doa_count=0')) {
              const [projectId, sessionId] = values;
              const row = db.rows.find((item) => item.project_id === projectId && item.session_id === sessionId);
              if (!row || (query.includes('doa_count>0') && !((row.doa_count as number) > 0))) return { meta: { changes: 0 } };
              row.doa_count = 0;
              return { meta: { changes: 1 } };
            }
            if (query.includes('SET updated_at=? WHERE') && query.includes("status='active' AND updated_at <=")) {
              // Stream heartbeat: throttled, no-rewind bump of updated_at only (atomic WHERE clause).
              const [now, projectId, sessionId, threshold] = values as [number, string, string, number];
              const row = db.rows.find(
                (item) =>
                  item.project_id === projectId &&
                  item.session_id === sessionId &&
                  item.status === 'active' &&
                  (item.updated_at as number) <= threshold,
              );
              if (!row) return { meta: { changes: 0 } };
              row.updated_at = now;
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('UPDATE slack_turn_activity')) {
              const [status, activitiesJson, lastPostedAt, updatedAt, completedAt, projectId, sessionId] = values;
              const row = db.rows.find((item) => item.project_id === projectId && item.session_id === sessionId);
              if (!row) return { meta: { changes: 0 } };
              Object.assign(row, {
                status,
                activities_json: activitiesJson,
                last_posted_at: lastPostedAt,
                updated_at: updatedAt,
                completed_at: completedAt,
              });
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          },
        };
      },
    };
  }
}

function input(overrides: Partial<Parameters<typeof createSlackTurnActivity>[1]> = {}) {
  return {
    projectId: 'P',
    sessionId: 'conv:slack:T:C:100.000',
    conversationId: 'slack:T:C:100.000',
    slackChannelId: 'C',
    slackThreadTs: '100.000',
    ackMessageTs: '101.000',
    transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
    now: 1000,
    ...overrides,
  };
}

function installFetchCapture(calls: Array<{ url: string; body: Record<string, unknown> }>) {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}

test('creates and loads an active receipt by project and session', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input());

  const activity = await loadSlackTurnActivity(db, 'P', 'conv:slack:T:C:100.000');

  assert.equal(activity?.status, 'active');
  assert.equal(activity?.conversationId, 'slack:T:C:100.000');
  assert.equal(activity?.ackMessageTs, '101.000');
  assert.deepEqual(activity?.activities, []);
});

test('a new turn in the same thread resets the receipt clock (created_at survives the upsert)', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input({ now: 0 }));
  // 19 minutes later, a NEW turn starts in the same thread → same (project, session) row.
  const later = 19 * 60_000;
  await createSlackTurnActivity(db, input({ now: later, ackMessageTs: '102.000' }));
  const activity = await loadSlackTurnActivity(db, 'P', 'conv:slack:T:C:100.000');
  assert.equal(activity?.createdAt, later, 'clock starts at the new turn, not the first turn in the thread');
  assert.match(renderSlackActivityReceipt(activity!, { now: later + 30_000 }), /<1 min/);
});

test('maps allowlisted tools to friendly labels and hides unknown tools', () => {
  assert.equal(toolActivityLabel('execute_code'), 'Running code');
  assert.equal(toolActivityLabel('github_call_api'), 'Reading GitHub');
  assert.equal(toolActivityLabel('linear_call_api'), 'Reading Linear');
  assert.equal(toolActivityLabel('notion_call_api'), 'Reading Notion');
  assert.equal(toolActivityLabel('search_channel'), 'Searching this channel');
  assert.equal(toolActivityLabel('save_memory'), 'Updating memory');
  assert.equal(toolActivityLabel('raw_internal_tool'), null);
});

test('records, dedupes, caps visible rows, and never renders args or results', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input());

  await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'execute_code', now: 1100 });
  await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'execute_code', now: 1200 });
  await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'setup_status', now: 1300 });
  await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'request_connection', now: 1400 });
  await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'github_call_api', now: 1500 });
  await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'linear_call_api', now: 1600 });
  await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'notion_call_api', now: 1700 });
  await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'search_channel', now: 1800 });
  await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'unknown_tool', now: 1900 });

  const activity = await loadSlackTurnActivity(db, 'P', 'conv:slack:T:C:100.000');
  assert.equal(activity?.activities.length, 7);
  const rendered = renderSlackActivityReceipt(activity!);

  assert.match(rendered, /Running code \(x2\)/);
  assert.match(rendered, /Checking setup/);
  assert.match(rendered, /\+1 more/);
  assert.doesNotMatch(rendered, /unknown_tool/);
  assert.doesNotMatch(rendered, /language/);
  assert.doesNotMatch(rendered, /result/);
});

test('marks failed activity without leaking the error text and terminal updates bypass throttle', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input({ now: 1000 }));
  await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'execute_code', now: 1100 });

  const failed = await recordSlackToolActivity(db, {
    projectId: 'P',
    sessionId: 'conv:slack:T:C:100.000',
    toolName: 'execute_code',
    isError: true,
    now: 1101,
    terminal: true,
    error: 'secret stack trace',
  });

  assert.equal(failed?.shouldPost, true);
  const rendered = renderSlackActivityReceipt(failed!.activity);
  assert.match(rendered, /Running code/);
  assert.match(rendered, /failed/i);
  assert.doesNotMatch(rendered, /secret stack trace/);
});

test('throttles normal updates but not the first update', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input({ now: 1000 }));

  const first = await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'execute_code', now: 1100 });
  const second = await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'setup_status', now: 1200 });
  const third = await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'request_connection', now: 3100 });

  assert.equal(first?.shouldPost, true);
  assert.equal(second?.shouldPost, false);
  assert.equal(third?.shouldPost, true);
});

test('renders active receipts with elapsed time and current phase', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input({ now: 0 }));

  await recordSlackToolActivity(db, {
    projectId: 'P',
    sessionId: 'conv:slack:T:C:100.000',
    toolName: 'execute_code',
    now: 12 * 60 * 1000,
  });

  const activity = await loadSlackTurnActivity(db, 'P', 'conv:slack:T:C:100.000');
  const rendered = renderSlackActivityReceipt(activity!, { now: 12 * 60 * 1000 });

  assert.match(rendered, /^⏳ Working — 12 min — running code/);
});

test('renders completed receipts with elapsed time frozen at completion', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input({ now: 0 }));
  await recordSlackToolActivity(db, {
    projectId: 'P',
    sessionId: 'conv:slack:T:C:100.000',
    toolName: 'setup_status',
    now: 60 * 1000,
  });

  const completed = await completeSlackTurnActivity(db, 'P', 'conv:slack:T:C:100.000', 'completed', 2 * 60 * 1000);
  const rendered = renderSlackActivityReceipt(completed!, { now: 30 * 60 * 1000 });

  assert.match(rendered, /^✅ Activity — 2 min/);
  assert.doesNotMatch(rendered, /30 min/);
});

test('final replies post below only when the receipt has visible activity', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input());
  assert.equal(await shouldPostFinalBelowActivity(db, 'P', 'conv:slack:T:C:100.000'), false);

  await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'execute_code', now: 1100 });

  assert.equal(await shouldPostFinalBelowActivity(db, 'P', 'conv:slack:T:C:100.000'), true);
});

test('Flue observer ignores non-Slack sessions and non-project agents', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input());
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const restore = installFetchCapture(calls);
  try {
    await handleObservedSlackActivity(
      { type: 'tool_start', instanceId: 'project:P:agent:default/heartbeat', session: 'default', toolName: 'execute_code', toolCallId: 'tc1' } as never,
      { env: { DB: db, SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test' } } as never,
    );
    await handleObservedSlackActivity(
      { type: 'tool_start', instanceId: 'bad-instance', session: 'default', toolName: 'execute_code', toolCallId: 'tc1' } as never,
      { env: { DB: db, SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test' } } as never,
    );
  } finally {
    restore();
  }

  assert.equal(calls.length, 0);
});

test('Flue observer edits the ack with friendly labels for known tool starts', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input());
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const restore = installFetchCapture(calls);
  try {
    await handleObservedSlackActivity(
      { type: 'tool_start', instanceId: 'project:P:agent:default/conv:slack:T:C:100.000', session: 'default', toolName: 'execute_code', toolCallId: 'tc1' } as never,
      { env: { DB: db, SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test' } } as never,
    );
  } finally {
    restore();
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://slack.com/api/chat.update');
  assert.equal(calls[0].body.channel, 'C');
  assert.equal(calls[0].body.ts, '101.000');
  assert.match(String(calls[0].body.text), /Running code/);
});

test('Flue observer shows stream-response phase only after visible work exists', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input());
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const restore = installFetchCapture(calls);
  try {
    await handleObservedSlackActivity(
      { type: 'message_start', instanceId: 'project:P:agent:default/conv:slack:T:C:100.000', session: 'default' } as never,
      { env: { DB: db, SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test' } } as never,
    );
    await handleObservedSlackActivity(
      { type: 'tool_start', instanceId: 'project:P:agent:default/conv:slack:T:C:100.000', session: 'default', toolName: 'execute_code', toolCallId: 'tc1' } as never,
      { env: { DB: db, SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test' } } as never,
    );
    await handleObservedSlackActivity(
      { type: 'message_start', instanceId: 'project:P:agent:default/conv:slack:T:C:100.000', session: 'default' } as never,
      { env: { DB: db, SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test' } } as never,
    );
  } finally {
    restore();
  }

  assert.equal(calls.length, 2);
  assert.doesNotMatch(String(calls[0].body.text), /Receiving stream response/);
  assert.match(String(calls[1].body.text), /Receiving stream response/);
  assert.match(String(calls[1].body.text), /^⏳ Working .* receiving stream response/m);
});

test('Flue observer hides unknown tools and never posts args or results', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input());
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const restore = installFetchCapture(calls);
  try {
    await handleObservedSlackActivity(
      {
        type: 'tool_start',
        instanceId: 'project:P:agent:default/conv:slack:T:C:100.000',
        session: 'default',
        toolName: 'secret_debug_tool',
        toolCallId: 'tc1',
        args: { token: 'secret-token' },
      } as never,
      { env: { DB: db, SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test' } } as never,
    );
    await handleObservedSlackActivity(
      {
        type: 'tool',
        instanceId: 'project:P:agent:default/conv:slack:T:C:100.000',
        session: 'default',
        toolName: 'execute_code',
        toolCallId: 'tc2',
        isError: true,
        result: 'secret stack trace',
        durationMs: 42,
      } as never,
      { env: { DB: db, SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test' } } as never,
    );
  } finally {
    restore();
  }

  assert.equal(calls.length, 1);
  assert.match(String(calls[0].body.text), /Running code/);
  assert.match(String(calls[0].body.text), /failed/i);
  assert.doesNotMatch(String(calls[0].body.text), /secret_debug_tool/);
  assert.doesNotMatch(String(calls[0].body.text), /secret-token/);
  assert.doesNotMatch(String(calls[0].body.text), /secret stack trace/);
});

test('reapStaleTurnActivities: marks long-stale active turns failed and edits the receipt', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input({ now: 0 }));
  const edits: Array<{ token: string; channel: string; ts: string; text: string }> = [];
  const logs: string[] = [];
  const reaped = await reapStaleTurnActivities(db, { SLACK_BOT_TOKEN_DEFAULT: 'xoxb-1' }, {
    now: TURN_STALE_MS + 1000,
    editMessage: async (token, channel, ts, text) => { edits.push({ token, channel, ts, text }); },
    log: (m) => logs.push(m),
  });
  assert.equal(reaped, 1);
  const activity = await loadSlackTurnActivity(db, 'P', 'conv:slack:T:C:100.000');
  assert.equal(activity?.status, 'failed');
  assert.equal(edits[0].text, TURN_DIED_TEXT);
  assert.equal(edits[0].ts, '101.000');
});

test('reapStaleTurnActivities: leaves fresh and completed turns alone; edit failure still reaps', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input({ now: 1000 }));
  assert.equal(await reapStaleTurnActivities(db, {}, { now: 2000, editMessage: async () => {} }), 0, 'fresh turn untouched');

  const reaped = await reapStaleTurnActivities(db, { SLACK_BOT_TOKEN_DEFAULT: 'xoxb-1' }, {
    now: TURN_STALE_MS + 5000,
    editMessage: async () => { throw new Error('slack down'); },
    log: () => {},
  });
  assert.equal(reaped, 1, 'edit failure does not block the reap');
  assert.equal((await loadSlackTurnActivity(db, 'P', 'conv:slack:T:C:100.000'))?.status, 'failed');
  assert.equal(await reapStaleTurnActivities(db, {}, { now: TURN_STALE_MS + 9000, editMessage: async () => {} }), 0, 'already-failed row not re-reaped');
});

test('reaper two-tier: zero-beat turn reaps at the DOA window; mid-flight turn waits for the long one', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input({ now: 0 }));
  await createSlackTurnActivity(db, input({ now: 0, sessionId: 'conv:slack:T:C:200.000', conversationId: 'slack:T:C:200.000', ackMessageTs: '201.000' }));
  await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:200.000', toolName: 'execute_code', now: 1000 });

  const edits: Array<{ text: string }> = [];
  const reaped = await reapStaleTurnActivities(db, { SLACK_BOT_TOKEN_DEFAULT: 'xoxb-1' }, {
    now: TURN_DOA_STALE_MS + 5000, // past the DOA window, well inside the 10-min one
    editMessage: async (_t, _c, _ts, text) => { edits.push({ text }); },
    log: () => {},
  });
  assert.equal(reaped, 1, 'only the zero-beat turn reaps early');
  assert.equal((await loadSlackTurnActivity(db, 'P', 'conv:slack:T:C:100.000'))?.status, 'failed');
  assert.equal((await loadSlackTurnActivity(db, 'P', 'conv:slack:T:C:200.000'))?.status, 'active', 'turn with beats survives the DOA window');
  assert.equal(edits[0].text, TURN_DIED_TEXT);
});

test('reaper self-heal: second consecutive DOA bumps the session epoch and says so', async () => {
  const db = new FakeD1();
  const bumps: string[] = [];
  const edits: string[] = [];
  const deps = {
    editMessage: async (_t: string, _c: string, _ts: string, text: string) => { edits.push(text); },
    bumpEpoch: async (projectId: string, conversationId: string) => { bumps.push(`${projectId}/${conversationId}`); return bumps.length; },
    log: () => {},
  };

  await createSlackTurnActivity(db, input({ now: 0 }));
  await reapStaleTurnActivities(db, { SLACK_BOT_TOKEN_DEFAULT: 'x' }, { ...deps, now: TURN_DOA_STALE_MS + 1000 });
  assert.equal(bumps.length, 0, 'first DOA is treated as a transient flake');
  assert.equal(edits[0], TURN_DIED_TEXT);

  // The user retries; the turn dies on arrival again.
  await createSlackTurnActivity(db, input({ now: TURN_DOA_STALE_MS + 60_000, ackMessageTs: '102.000' }));
  await reapStaleTurnActivities(db, { SLACK_BOT_TOKEN_DEFAULT: 'x' }, { ...deps, now: 2 * TURN_DOA_STALE_MS + 120_000 });
  assert.deepEqual(bumps, ['P/slack:T:C:100.000'], 'second consecutive DOA declares the session wedged');
  assert.equal(edits[1], TURN_DIED_RESET_TEXT);
  assert.equal((await loadSlackTurnActivity(db, 'P', 'conv:slack:T:C:100.000'))?.status, 'failed');
});

test('reaper auto-retry: first-strike DOA re-dispatches and shows the retrying note', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input({ now: 0 }));
  const retries: string[] = [];
  const edits: string[] = [];
  const reaped = await reapStaleTurnActivities(db, { SLACK_BOT_TOKEN_DEFAULT: 'x' }, {
    now: TURN_DOA_STALE_MS + 1000,
    editMessage: async (_t, _c, _ts, text) => { edits.push(text); },
    retryTurn: async (row) => { retries.push(row.conversationId); return true; },
    bumpEpoch: async () => { throw new Error('must not bump on strike one'); },
    log: () => {},
  });
  assert.equal(reaped, 1);
  assert.deepEqual(retries, ['slack:T:C:100.000']);
  assert.deepEqual(edits, [TURN_RETRYING_TEXT], 'retrying note instead of a death notice');
});

test('reaper auto-retry: retry dispatch failure falls back to the death notice', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input({ now: 0 }));
  const edits: string[] = [];
  await reapStaleTurnActivities(db, { SLACK_BOT_TOKEN_DEFAULT: 'x' }, {
    now: TURN_DOA_STALE_MS + 1000,
    editMessage: async (_t, _c, _ts, text) => { edits.push(text); },
    retryTurn: async () => { throw new Error('dispatch down'); },
    log: () => {},
  });
  assert.deepEqual(edits, [TURN_DIED_TEXT]);
});

test('reaper auto-retry: second strike skips retry and resets the session', async () => {
  const db = new FakeD1();
  const retries: string[] = [];
  const bumps: string[] = [];
  const edits: string[] = [];
  const deps = {
    editMessage: async (_t: string, _c: string, _ts: string, text: string) => { edits.push(text); },
    retryTurn: async (row: { conversationId: string }) => { retries.push(row.conversationId); return true; },
    bumpEpoch: async (p: string, c: string) => { bumps.push(`${p}/${c}`); return 1; },
    log: () => {},
  };
  await createSlackTurnActivity(db, input({ now: 0 }));
  await reapStaleTurnActivities(db, { SLACK_BOT_TOKEN_DEFAULT: 'x' }, { ...deps, now: TURN_DOA_STALE_MS + 1000 });
  assert.equal(retries.length, 1, 'strike one retries');
  // The retried turn ALSO dies on arrival.
  await createSlackTurnActivity(db, input({ now: TURN_DOA_STALE_MS + 60_000, ackMessageTs: '102.000' }));
  await reapStaleTurnActivities(db, { SLACK_BOT_TOKEN_DEFAULT: 'x' }, { ...deps, now: 2 * TURN_DOA_STALE_MS + 120_000 });
  assert.equal(retries.length, 1, 'strike two does NOT retry again');
  assert.deepEqual(bumps, ['P/slack:T:C:100.000'], 'strike two resets the session');
  assert.equal(edits[1], TURN_DIED_RESET_TEXT);
});

test('completed turn resets the DOA streak', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input({ now: 0 }));
  await reapStaleTurnActivities(db, {}, { now: TURN_DOA_STALE_MS + 1000, editMessage: async () => {}, log: () => {} });
  // Retry succeeds this time.
  await createSlackTurnActivity(db, input({ now: TURN_DOA_STALE_MS + 60_000, ackMessageTs: '102.000' }));
  await completeSlackTurnActivity(db, 'P', 'conv:slack:T:C:100.000', 'completed', TURN_DOA_STALE_MS + 90_000);
  const row = db.rows.find((r) => r.session_id === 'conv:slack:T:C:100.000');
  assert.equal(row?.doa_count, 0, 'success clears the wedge counter');
});

// ── stream heartbeat (token-level proof of life) ──────────────────────────────

test('stream heartbeat: a delta past the throttle window refreshes the liveness clock', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input({ now: 1000 }));
  const t = 1000 + STREAM_HEARTBEAT_MS + 1;
  await recordSlackStreamHeartbeat(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', now: t });
  const activity = await loadSlackTurnActivity(db, 'P', 'conv:slack:T:C:100.000');
  assert.equal(activity?.updatedAt, t, 'a token delta bumps updated_at — the model is provably alive');
});

test('stream heartbeat: throttled to one write per window regardless of token rate', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input({ now: 1000 }));
  // A burst of deltas inside the window — none may move the clock (or we hammer D1 per token).
  await recordSlackStreamHeartbeat(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', now: 1001 });
  await recordSlackStreamHeartbeat(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', now: 1500 });
  let activity = await loadSlackTurnActivity(db, 'P', 'conv:slack:T:C:100.000');
  assert.equal(activity?.updatedAt, 1000, 'deltas within the throttle window do not write');
  // One delta a full window later does write.
  await recordSlackStreamHeartbeat(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', now: 1000 + STREAM_HEARTBEAT_MS });
  activity = await loadSlackTurnActivity(db, 'P', 'conv:slack:T:C:100.000');
  assert.equal(activity?.updatedAt, 1000 + STREAM_HEARTBEAT_MS, 'a delta past the window refreshes the clock');
});

test('stream heartbeat: never revives a completed or failed turn', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input({ now: 1000 }));
  await completeSlackTurnActivity(db, 'P', 'conv:slack:T:C:100.000', 'completed', 2000);
  await recordSlackStreamHeartbeat(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', now: 2000 + STREAM_HEARTBEAT_MS + 1 });
  const activity = await loadSlackTurnActivity(db, 'P', 'conv:slack:T:C:100.000');
  assert.equal(activity?.status, 'completed');
  assert.equal(activity?.updatedAt, 2000, 'a stray late delta cannot bump a finished turn');
});

test('stream heartbeat: a fresh delta keeps a turn the reaper would otherwise lose, and reaping still works once tokens stop', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input({ now: 0 }));
  // Last tool beat was early; without a heartbeat this clock would be long stale.
  await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'execute_code', now: 1000 });
  const streamingNow = TURN_STALE_MS + 60_000;
  await recordSlackStreamHeartbeat(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', now: streamingNow });

  const reaped = await reapStaleTurnActivities(db, {}, { now: streamingNow + 1000, editMessage: async () => {}, log: () => {} });
  assert.equal(reaped, 0, 'a turn still emitting tokens is not reaped, even long after its last tool beat');

  // Tokens stop — once the clock goes stale again, the reaper claims it as before.
  const reapedLater = await reapStaleTurnActivities(db, { SLACK_BOT_TOKEN_DEFAULT: 'x' }, { now: streamingNow + TURN_STALE_MS + 1000, editMessage: async () => {}, log: () => {} });
  assert.equal(reapedLater, 1, 'once the deltas stop the stale turn is reaped — the heartbeat shifts the deadline, it does not remove it');
});

await run();
