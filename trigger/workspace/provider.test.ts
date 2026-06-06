// WorkspaceProvider pure-helper tests — run: npx tsx trigger/workspace/provider.test.ts
import assert from 'node:assert/strict';
import { createTestRunner } from '../../src/shared/test-utils';
import { authenticatedCloneUrl, branchToClone } from './provider';

const { test, run } = createTestRunner();

// ---------------------------------------------------------------------------
// authenticatedCloneUrl
// ---------------------------------------------------------------------------

test('authenticatedCloneUrl: injects token in the right place', () => {
  const url = authenticatedCloneUrl('https://github.com/owner/repo', 'ghp_abc123');
  assert.equal(url, 'https://x-access-token:ghp_abc123@github.com/owner/repo.git');
});

test('authenticatedCloneUrl: appends .git when missing', () => {
  const url = authenticatedCloneUrl('https://github.com/owner/repo', 'tok');
  assert.ok(url.endsWith('.git'), `expected .git suffix, got: ${url}`);
});

test('authenticatedCloneUrl: does not double-append .git when already present', () => {
  const url = authenticatedCloneUrl('https://github.com/owner/repo.git', 'tok');
  assert.ok(url.endsWith('.git'), `expected .git suffix, got: ${url}`);
  assert.ok(!url.endsWith('.git.git'), `should not double-.git, got: ${url}`);
});

test('authenticatedCloneUrl: includes x-access-token: prefix', () => {
  const url = authenticatedCloneUrl('https://github.com/owner/repo', 'mytoken');
  assert.ok(url.includes('x-access-token:mytoken@'), `expected x-access-token:<token>@, got: ${url}`);
});

test('authenticatedCloneUrl: throws on a non-github input', () => {
  assert.throws(
    () => authenticatedCloneUrl('https://gitlab.com/owner/repo', 'tok'),
    /only https:\/\/github\.com\//,
  );
});

test('authenticatedCloneUrl: throws on a non-https input', () => {
  assert.throws(
    () => authenticatedCloneUrl('git@github.com:owner/repo.git', 'tok'),
    /only https:\/\/github\.com\//,
  );
});

test('authenticatedCloneUrl: throws on a look-alike domain (security boundary)', () => {
  assert.throws(
    () => authenticatedCloneUrl('https://github.com.evil.com/owner/repo', 'tok'),
    /only https:\/\/github\.com\//,
  );
});

// ---------------------------------------------------------------------------
// branchToClone
// ---------------------------------------------------------------------------

test('branchToClone: returns targetBranch when set', () => {
  assert.equal(branchToClone('feature/foo', 'main'), 'feature/foo');
});

test('branchToClone: returns baseBranch when targetBranch is null', () => {
  assert.equal(branchToClone(null, 'main'), 'main');
});

await run();
