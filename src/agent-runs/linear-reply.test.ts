// Linear reply invariants — run: npx tsx src/agent-runs/linear-reply.test.ts
import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { postLinearComment, replyTextForCallback } from './linear-reply';

const { test, run } = createTestRunner();

// ── replyTextForCallback ─────────────────────────────────────────────────────

test('replyTextForCallback pr_opened with prUrl returns expected text', () => {
  const text = replyTextForCallback('pr_opened', { prUrl: 'https://github.com/acme/repo/pull/7' });
  assert.equal(text, '🤖 PR opened: https://github.com/acme/repo/pull/7');
});

test('replyTextForCallback pr_opened without prUrl returns null', () => {
  assert.equal(replyTextForCallback('pr_opened', { prUrl: null }), null);
  assert.equal(replyTextForCallback('pr_opened', {}), null);
});

test('replyTextForCallback failed returns expected text with error', () => {
  const text = replyTextForCallback('failed', { error: 'tests failed' });
  assert.equal(text, '🤖 Run failed: tests failed');
});

test('replyTextForCallback failed with no error falls back to "unknown error"', () => {
  const text = replyTextForCallback('failed', {});
  assert.equal(text, '🤖 Run failed: unknown error');
});

test('replyTextForCallback failed truncates long error at 300 chars with ellipsis', () => {
  const longError = 'x'.repeat(400);
  const text = replyTextForCallback('failed', { error: longError });
  assert.ok(text !== null);
  assert.equal(text!.startsWith('🤖 Run failed: '), true);
  // 300 x's + ellipsis character
  assert.equal(text!.endsWith('…'), true);
  assert.ok(text!.length < 400);
  // Exactly 300 'x' characters after the prefix
  const body = text!.replace('🤖 Run failed: ', '');
  assert.equal(body, 'x'.repeat(300) + '…');
});

test('replyTextForCallback unknown type returns null', () => {
  assert.equal(replyTextForCallback('completed', { prUrl: 'https://example.com' }), null);
  assert.equal(replyTextForCallback('running', {}), null);
  assert.equal(replyTextForCallback('', {}), null);
});

// ── postLinearComment ────────────────────────────────────────────────────────

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
const TOKEN = 'tok_test_abc123';
const ISSUE_ID = 'issue-xyz';
const BODY_TEXT = 'Hello from test';

test('postLinearComment POSTs to Linear GraphQL URL with correct mutation and variables', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];

  const stubFetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ data: { commentCreate: { success: true } } }), { status: 200 });
  };

  await postLinearComment({ issueId: ISSUE_ID, body: BODY_TEXT, token: TOKEN, fetchImpl: stubFetch as typeof fetch });

  assert.equal(calls.length, 1, 'fetch should have been called exactly once');
  const { url, init } = calls[0];
  assert.equal(url, LINEAR_GRAPHQL_URL);

  const headers = init.headers as Record<string, string>;
  assert.equal(headers['Authorization'], `Bearer ${TOKEN}`);
  assert.equal(headers['Content-Type'], 'application/json');

  const sentBody = JSON.parse(String(init.body));
  assert.ok(sentBody.query.includes('commentCreate'), 'query should include commentCreate');
  assert.ok(sentBody.query.includes('CommentCreateInput'), 'query should reference CommentCreateInput');
  assert.equal(sentBody.variables.input.issueId, ISSUE_ID);
  assert.equal(sentBody.variables.input.body, BODY_TEXT);
});

test('postLinearComment throws on non-2xx response', async () => {
  const stubFetch = async () => new Response('Unauthorized', { status: 401 });

  await assert.rejects(
    () => postLinearComment({ issueId: ISSUE_ID, body: BODY_TEXT, token: TOKEN, fetchImpl: stubFetch as typeof fetch }),
    (e: Error) => {
      assert.ok(e.message.includes('401'), 'error should mention HTTP status');
      assert.ok(!e.message.includes(TOKEN), 'token must not appear in error message');
      return true;
    },
  );
});

test('postLinearComment throws on GraphQL errors array', async () => {
  const stubFetch = async () =>
    new Response(JSON.stringify({ errors: [{ message: 'Field not found' }] }), { status: 200 });

  await assert.rejects(
    () => postLinearComment({ issueId: ISSUE_ID, body: BODY_TEXT, token: TOKEN, fetchImpl: stubFetch as typeof fetch }),
    (e: Error) => {
      assert.ok(e.message.includes('Field not found'), 'error should relay GraphQL error message');
      assert.ok(!e.message.includes(TOKEN), 'token must not appear in error message');
      return true;
    },
  );
});

test('postLinearComment does not include token in error thrown for HTTP 500', async () => {
  const stubFetch = async () => new Response('Internal Server Error', { status: 500 });

  await assert.rejects(
    () => postLinearComment({ issueId: ISSUE_ID, body: BODY_TEXT, token: TOKEN, fetchImpl: stubFetch as typeof fetch }),
    (e: Error) => {
      assert.ok(!e.message.includes(TOKEN), 'token must not appear in error message for 500');
      return true;
    },
  );
});

await run();
