// Runner dispatch/callback contract — run: npx tsx src/agent-runs/runner-contract.test.ts
import assert from 'node:assert/strict';
import * as v from 'valibot';
import { createTestRunner } from '../shared/test-utils';
import { RunnerDispatchSchema, RunnerCallbackSchema, RUNNER_CONTRACT_VERSION } from './runner-contract';

const { test, run } = createTestRunner();

test('a continuation dispatch parses against the contract', () => {
  const d = v.parse(RunnerDispatchSchema, {
    contractVersion: RUNNER_CONTRACT_VERSION, runId: 'r1', projectId: 'p1', mode: 'continuation',
    targetRepo: 'https://github.com/o/r', baseBranch: 'main', targetBranch: 'morehands/eng-1',
    kit: 'coding-default', runtime: 'pi', sandboxProvider: 'local',
    issue: null, feedback: 'use authGuard()', prUrl: 'https://github.com/o/r/pull/5',
    replyTarget: { surface: 'linear', ref: 'ISSUE-1' }, githubToken: 'ghp_x',
    callback: { url: 'https://h.dev/__internal/agent-runs', token: 't' },
  });
  assert.equal(d.workspacePolicy, 'fresh'); // default applied
});

test('an initial dispatch parses against the contract', () => {
  v.parse(RunnerDispatchSchema, {
    contractVersion: RUNNER_CONTRACT_VERSION, runId: 'r1', projectId: 'p1', mode: 'initial',
    targetRepo: 'https://github.com/o/r', baseBranch: 'main', targetBranch: null,
    kit: 'coding-default', runtime: 'pi', sandboxProvider: 'e2b',
    issue: { id: 'i1', identifier: 'ENG-1', url: 'https://linear.app/x', title: 'T', description: null },
    feedback: null, prUrl: null, replyTarget: null, githubToken: 'ghp_x',
    callback: { url: 'https://h.dev/__internal/agent-runs', token: 't' },
  });
});

test('a runner callback parses against the contract', () => {
  const c = v.parse(RunnerCallbackSchema, { contractVersion: RUNNER_CONTRACT_VERSION, runId: 'r1', status: 'pr_opened', prUrl: 'https://github.com/o/r/pull/5' });
  assert.equal(c.status, 'pr_opened');
});

test('a wrong contractVersion is rejected', () => {
  assert.throws(() => v.parse(RunnerDispatchSchema, { contractVersion: 999 } as any));
});

await run();
