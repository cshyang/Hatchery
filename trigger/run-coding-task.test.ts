// run-coding-task pure-helper tests — run: npx tsx trigger/run-coding-task.test.ts
import assert from 'node:assert/strict';
import { createTestRunner } from '../src/shared/test-utils';
import { runBranchName } from './run-coding-task';

const { test, run } = createTestRunner();

const issue = (identifier: string) => ({
  id: 'i1',
  identifier,
  url: 'https://linear.app/x/issue/' + identifier,
  title: 'T',
  description: null,
});

// ---------------------------------------------------------------------------
// runBranchName
// ---------------------------------------------------------------------------

test('runBranchName: continuation returns targetBranch verbatim', () => {
  const branch = runBranchName({ targetBranch: 'hatchery/eng-12-abcd1234', issue: issue('ENG-12'), runId: 'run_1' }, 'ignored');
  assert.equal(branch, 'hatchery/eng-12-abcd1234');
});

test('runBranchName: initial builds hatchery/<slug(identifier)>-<short>', () => {
  const branch = runBranchName({ targetBranch: null, issue: issue('ENG-12'), runId: 'run_1' }, 'abcd1234');
  assert.equal(branch, 'hatchery/eng-12-abcd1234');
});

test('runBranchName: initial falls back to runId when issue is null', () => {
  const branch = runBranchName({ targetBranch: null, issue: null, runId: 'run_ABC_99' }, 'ef567890');
  assert.equal(branch, 'hatchery/run-abc-99-ef567890');
});

test('runBranchName: slug collapses runs of non-alphanumerics and trims edge hyphens', () => {
  const branch = runBranchName({ targetBranch: null, issue: issue('  Foo / Bar!! '), runId: 'run_1' }, 'deadbeef');
  assert.equal(branch, 'hatchery/foo-bar-deadbeef');
});

await run();
