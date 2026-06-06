// GitHub helper tests — run: npx tsx trigger/github.test.ts
import assert from 'node:assert/strict';
import { createTestRunner } from '../src/shared/test-utils';
import { parseOwnerRepo, openOrUpdatePullRequest } from './github';

const { test, run } = createTestRunner();

// ---------------------------------------------------------------------------
// parseOwnerRepo
// ---------------------------------------------------------------------------

test('parseOwnerRepo: parses owner and repo without .git', () => {
  const result = parseOwnerRepo('https://github.com/acme/my-repo');
  assert.equal(result.owner, 'acme');
  assert.equal(result.repo, 'my-repo');
});

test('parseOwnerRepo: parses owner and repo with .git', () => {
  const result = parseOwnerRepo('https://github.com/acme/my-repo.git');
  assert.equal(result.owner, 'acme');
  assert.equal(result.repo, 'my-repo');
});

test('parseOwnerRepo: throws on non-github URL', () => {
  assert.throws(
    () => parseOwnerRepo('https://gitlab.com/acme/repo'),
    /https:\/\/github\.com\//,
  );
});

test('parseOwnerRepo: throws on git+ssh URL', () => {
  assert.throws(
    () => parseOwnerRepo('git@github.com:acme/repo.git'),
    /https:\/\/github\.com\//,
  );
});

// ---------------------------------------------------------------------------
// openOrUpdatePullRequest — stubbed fetchImpl
// ---------------------------------------------------------------------------

const TOKEN = 'ghp_test_secret_token';

function makeFetchStub(calls: Array<{ method: string; url: string; init: RequestInit }>): (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response> {
  return async (url, init = {}) => {
    calls.push({ method: String(init.method ?? 'GET'), url: String(url), init });
    // Responses are overridden per-test via the stub itself; this is a sentinel.
    throw new Error('fetchStub: no response configured');
  };
}

test('openOrUpdatePullRequest: existing open PR → returns created:false, makes no POST', async () => {
  const calls: Array<{ method: string; url: string; init: RequestInit }> = [];

  const fetchImpl = async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    calls.push({ method: String(init.method ?? 'GET'), url: String(url), init });
    return new Response(
      JSON.stringify([{ html_url: 'https://github.com/acme/repo/pull/5', number: 5 }]),
      { status: 200 },
    );
  };

  const result = await openOrUpdatePullRequest({
    owner: 'acme', repo: 'repo', head: 'hatchery/eng-1', base: 'main',
    title: 'Fix it', body: 'Does the thing', token: TOKEN, fetchImpl,
  });

  assert.equal(result.url, 'https://github.com/acme/repo/pull/5');
  assert.equal(result.number, 5);
  assert.equal(result.created, false);
  assert.equal(calls.length, 1, 'only a GET — no POST');
  assert.equal(calls[0].method, 'GET');
});

test('openOrUpdatePullRequest: no existing PR → POST to create, returns created:true with correct URL', async () => {
  const calls: Array<{ method: string; url: string; init: RequestInit }> = [];

  const fetchImpl = async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    calls.push({ method: String(init.method ?? 'GET'), url: String(url), init });
    const method = String(init.method ?? 'GET');
    if (method === 'GET') {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response(
      JSON.stringify({ html_url: 'https://github.com/acme/repo/pull/7', number: 7 }),
      { status: 201 },
    );
  };

  const result = await openOrUpdatePullRequest({
    owner: 'acme', repo: 'repo', head: 'hatchery/eng-2', base: 'main',
    title: 'Add feature', body: 'Details here', token: TOKEN, fetchImpl,
  });

  assert.equal(result.url, 'https://github.com/acme/repo/pull/7');
  assert.equal(result.number, 7);
  assert.equal(result.created, true);

  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, 'expected a POST call');

  // Verify POST body
  const postBody = JSON.parse(String(post!.init.body));
  assert.equal(postBody.title, 'Add feature');
  assert.equal(postBody.head, 'hatchery/eng-2');
  assert.equal(postBody.base, 'main');
  assert.equal(postBody.body, 'Details here');

  // Verify required headers
  const headers = post!.init.headers as Record<string, string>;
  assert.ok(headers.Authorization.startsWith('Bearer '), 'Authorization header set');
  assert.equal(headers.Accept, 'application/vnd.github+json');
  assert.equal(headers['X-GitHub-Api-Version'], '2022-11-28');
});

test('openOrUpdatePullRequest: non-2xx GET throws and does NOT include token in message', async () => {
  const fetchImpl = async (): Promise<Response> => {
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  };

  let thrown: Error | null = null;
  try {
    await openOrUpdatePullRequest({
      owner: 'acme', repo: 'repo', head: 'hatchery/eng-3', base: 'main',
      title: 'T', body: 'B', token: TOKEN, fetchImpl,
    });
  } catch (e) {
    thrown = e as Error;
  }

  assert.ok(thrown, 'should have thrown');
  assert.match(thrown!.message, /404/);
  assert.ok(!thrown!.message.includes(TOKEN), 'error message must not contain the token');
});

test('openOrUpdatePullRequest: non-2xx POST throws and does NOT include token in message', async () => {
  const fetchImpl = async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const method = String(init.method ?? 'GET');
    if (method === 'GET') {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response(JSON.stringify({ message: 'Validation Failed' }), { status: 422 });
  };

  let thrown: Error | null = null;
  try {
    await openOrUpdatePullRequest({
      owner: 'acme', repo: 'repo', head: 'hatchery/eng-4', base: 'main',
      title: 'T', body: 'B', token: TOKEN, fetchImpl,
    });
  } catch (e) {
    thrown = e as Error;
  }

  assert.ok(thrown, 'should have thrown');
  assert.match(thrown!.message, /422/);
  assert.ok(!thrown!.message.includes(TOKEN), 'error message must not contain the token');
});

await run();
