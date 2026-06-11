// Burst-absorb invariants — run: npx tsx src/slack/absorb.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import type { D1Like } from '../skills/repository';
import {
  ABSORB_FRESH_MS,
  SWEEP_GRACE_MS,
  claimPendingMessages,
  drainNoticeForReply,
  findAbsorbingTurn,
  insertPendingMessage,
  listStragglerConversations,
  renderPendingMessages,
} from './absorb';

const { test, run } = createTestRunner();

type Row = Record<string, unknown>;

class FakeD1 implements D1Like {
  activities: Row[] = [];
  pending: Row[] = [];
  nextId = 1;

  prepare(sql: string) {
    const db = this;
    const query = sql.trim();
    return {
      bind(...values: unknown[]) {
        return {
          async first<T = Row>(): Promise<T | null> {
            const { results } = await this.all<T>();
            return results[0] ?? null;
          },
          async all<T = Row>(): Promise<{ results: T[] }> {
            if (query.includes('FROM slack_turn_activity')) {
              const [projectId, sessionId] = values;
              return { results: db.activities.filter((r) => r.project_id === projectId && r.session_id === sessionId) as T[] };
            }
            if (query.includes('SELECT DISTINCT project_id, conversation_id FROM pending_messages')) {
              const [cutoff, limit] = values;
              const seen = new Set<string>();
              const out: Row[] = [];
              for (const r of db.pending) {
                if (r.status !== 'pending' || Number(r.created_at) >= Number(cutoff)) continue;
                const key = `${r.project_id}|${r.conversation_id}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({ project_id: r.project_id, conversation_id: r.conversation_id });
              }
              return { results: out.slice(0, Number(limit)) as T[] };
            }
            if (query.includes('FROM pending_messages')) {
              const [projectId, conversationId] = values;
              const rows = db.pending
                .filter((r) => r.project_id === projectId && r.conversation_id === conversationId && r.status === 'pending')
                .sort((a, b) => Number(a.id) - Number(b.id));
              return { results: rows as T[] };
            }
            return { results: [] as T[] };
          },
          async run(): Promise<unknown> {
            if (query.startsWith('INSERT INTO pending_messages')) {
              const [projectId, conversationId, senderId, text, slackTs, createdAt] = values;
              db.pending.push({
                id: db.nextId++,
                project_id: projectId,
                conversation_id: conversationId,
                sender_id: senderId,
                text,
                slack_ts: slackTs,
                status: 'pending',
                created_at: createdAt,
                claimed_at: null,
              });
            }
            if (query.startsWith('UPDATE pending_messages SET status=?')) {
              const [status, claimedAt, id] = values;
              const row = db.pending.find((r) => r.id === id && r.status === 'pending');
              if (row) {
                row.status = status;
                row.claimed_at = claimedAt;
              }
            }
            return {};
          },
        };
      },
    };
  }
}

function activity(over: Row = {}): Row {
  return {
    project_id: 'P',
    session_id: 'conv:slack:T:C:100.000',
    conversation_id: 'slack:T:C:100.000',
    slack_channel_id: 'C',
    slack_thread_ts: '100.000',
    ack_message_ts: '101.000',
    transport_token_ref: 'SLACK_BOT_TOKEN_DEFAULT',
    status: 'active',
    activities_json: '[]',
    last_posted_at: null,
    created_at: 1000,
    updated_at: 1000,
    completed_at: null,
    ...over,
  };
}

const CONV = 'slack:T:C:100.000';

async function park(db: FakeD1, text: string, now: number, senderId = 'U1') {
  await insertPendingMessage(db, { projectId: 'P', conversationId: CONV, senderId, text, slackTs: `${now}.0`, now });
}

test('findAbsorbingTurn: only a FRESH active receipt absorbs', async () => {
  const db = new FakeD1();
  assert.equal(await findAbsorbingTurn(db, 'P', CONV, 5000), null, 'no receipt → no absorb');

  db.activities.push(activity({ updated_at: 1000 }));
  assert.ok(await findAbsorbingTurn(db, 'P', CONV, 1000 + ABSORB_FRESH_MS - 1), 'fresh active absorbs');
  assert.equal(await findAbsorbingTurn(db, 'P', CONV, 1000 + ABSORB_FRESH_MS), null, 'stale active = presumed dead, no absorb');

  db.activities[0].status = 'completed';
  assert.equal(await findAbsorbingTurn(db, 'P', CONV, 1001), null, 'terminal receipt never absorbs');
});

test('claimPendingMessages: oldest-first, exactly-once delivery', async () => {
  const db = new FakeD1();
  await park(db, 'first', 1000);
  await park(db, 'second', 2000, 'U2');

  const claimed = await claimPendingMessages(db, 'P', CONV, 'absorbed', 3000);
  assert.deepEqual(claimed.map((m) => m.text), ['first', 'second']);
  assert.deepEqual(claimed.map((m) => m.senderId), ['U1', 'U2']);
  assert.ok(db.pending.every((r) => r.status === 'absorbed' && r.claimed_at === 3000));

  assert.deepEqual(await claimPendingMessages(db, 'P', CONV, 'absorbed'), [], 'second claim drains nothing');
});

test('drainNoticeForReply: pending → NOT SENT notice with the messages; empty → null', async () => {
  const db = new FakeD1();
  assert.equal(await drainNoticeForReply(db, 'P', CONV), null);
  assert.equal(await drainNoticeForReply(undefined, 'P', CONV), null, 'no db degrades to posting');
  assert.equal(await drainNoticeForReply(db, 'P', ''), null, 'heartbeat posts (no conversation) skip the drain');

  await park(db, 'wait, also check the README', 1000);
  const notice = await drainNoticeForReply(db, 'P', CONV, 2000);
  assert.match(notice ?? '', /^NOT SENT — 1 new message/);
  assert.match(notice ?? '', /\[U1\]: wait, also check the README/);
  assert.match(notice ?? '', /reply_to_conversation again/);
  assert.equal(await drainNoticeForReply(db, 'P', CONV, 2001), null, 'drained rows are not re-delivered');
});

test('listStragglerConversations: only pending rows past the grace window, distinct', async () => {
  const db = new FakeD1();
  const now = 100_000;
  await park(db, 'old A', now - SWEEP_GRACE_MS - 1);
  await park(db, 'old A again', now - SWEEP_GRACE_MS - 1);
  await insertPendingMessage(db, { projectId: 'P2', conversationId: 'slack:T:C2:1.0', senderId: 'U1', text: 'fresh', slackTs: '1.0', now: now - 10 });

  const stragglers = await listStragglerConversations(db, now);
  assert.deepEqual(stragglers, [{ projectId: 'P', conversationId: CONV }], 'one distinct stale conversation; fresh row waits');
});

test('renderPendingMessages: sender-attributed lines', () => {
  const out = renderPendingMessages([
    { id: 1, projectId: 'P', conversationId: CONV, senderId: 'U1', text: 'a', slackTs: '1.0', createdAt: 1 },
    { id: 2, projectId: 'P', conversationId: CONV, senderId: 'U2', text: 'b', slackTs: '2.0', createdAt: 2 },
  ]);
  assert.equal(out, '[U1]: a\n[U2]: b');
});

await run();
