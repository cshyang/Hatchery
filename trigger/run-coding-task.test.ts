// run-coding-task pure-helper tests — run: npx tsx trigger/run-coding-task.test.ts
import assert from 'node:assert/strict';
import { createTestRunner } from '../src/shared/test-utils';
import { runBranchName, extensionEntriesFromManifest, extensionFlags, parsePiStream, piRuntime } from './run-coding-task';

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
  const branch = runBranchName({ targetBranch: 'morehands/eng-12-abcd1234', issue: issue('ENG-12'), runId: 'run_1' }, 'ignored');
  assert.equal(branch, 'morehands/eng-12-abcd1234');
});

test('runBranchName: initial builds morehands/<slug(identifier)>-<short>', () => {
  const branch = runBranchName({ targetBranch: null, issue: issue('ENG-12'), runId: 'run_1' }, 'abcd1234');
  assert.equal(branch, 'morehands/eng-12-abcd1234');
});

test('runBranchName: initial falls back to runId when issue is null', () => {
  const branch = runBranchName({ targetBranch: null, issue: null, runId: 'run_ABC_99' }, 'ef567890');
  assert.equal(branch, 'morehands/run-abc-99-ef567890');
});

test('runBranchName: slug collapses runs of non-alphanumerics and trims edge hyphens', () => {
  const branch = runBranchName({ targetBranch: null, issue: issue('  Foo / Bar!! '), runId: 'run_1' }, 'deadbeef');
  assert.equal(branch, 'morehands/foo-bar-deadbeef');
});

// ---------------------------------------------------------------------------
// extensionEntriesFromManifest
// ---------------------------------------------------------------------------

test('extensionEntriesFromManifest: resolves relative entries against the package dir', () => {
  const entries = extensionEntriesFromManifest('/bundle/node_modules/pi-subagents', {
    extensions: ['./src/extension/index.ts', './sub/other.ts'],
  });
  assert.deepEqual(entries, [
    '/bundle/node_modules/pi-subagents/src/extension/index.ts',
    '/bundle/node_modules/pi-subagents/sub/other.ts',
  ]);
});

test('extensionEntriesFromManifest: missing/empty pi.extensions yields []', () => {
  assert.deepEqual(extensionEntriesFromManifest('/x', undefined), []);
  assert.deepEqual(extensionEntriesFromManifest('/x', {}), []);
  assert.deepEqual(extensionEntriesFromManifest('/x', { extensions: [] }), []);
});

// ---------------------------------------------------------------------------
// extensionFlags
// ---------------------------------------------------------------------------

test('extensionFlags: pairs each entry path with a -e flag', () => {
  assert.deepEqual(extensionFlags(['/a/x.ts', '/b/y.ts']), ['-e', '/a/x.ts', '-e', '/b/y.ts']);
});

test('extensionFlags: empty input yields no flags', () => {
  assert.deepEqual(extensionFlags([]), []);
});

// ---------------------------------------------------------------------------
// parsePiStream  (fixtures mirror real pi --mode json output)
// ---------------------------------------------------------------------------

const CLEAN_RUN = [
  '{"type":"agent_start"}',
  '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"Done."}],"stopReason":"stop"},"toolResults":[]}',
  '{"type":"agent_end","messages":[{"role":"user","content":[{"type":"text","text":"hi"}]},{"role":"assistant","content":[{"type":"text","text":"Done."}],"stopReason":"stop"}],"willRetry":false}',
].join('\n');

// Real shape from a bad-model run: pi exits 0 but the turn stopReason is "error".
const ERRORED_EXIT0 = [
  '{"type":"turn_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"400 Unknown Model, please check the model code."},"toolResults":[]}',
  '{"type":"agent_end","messages":[{"role":"assistant","content":[],"stopReason":"error","errorMessage":"400 Unknown Model, please check the model code."}],"willRetry":false}',
].join('\n');

test('parsePiStream: clean run → completed, not errored, finalText captured', () => {
  const o = parsePiStream(CLEAN_RUN);
  assert.equal(o.completed, true);
  assert.equal(o.errored, false);
  assert.equal(o.finalText, 'Done.');
});

test('parsePiStream: error-on-exit-0 is caught (the regression the exit code hid)', () => {
  const o = parsePiStream(ERRORED_EXIT0);
  assert.equal(o.completed, true);
  assert.equal(o.errored, true);
  assert.equal(o.errorMessage, '400 Unknown Model, please check the model code.');
});

test('parsePiStream: no agent_end → not completed (pi died mid-stream)', () => {
  const o = parsePiStream('{"type":"agent_start"}\n{"type":"turn_start"}');
  assert.equal(o.completed, false);
  assert.equal(o.errored, false);
});

test('parsePiStream: tolerates non-JSON noise lines', () => {
  const o = parsePiStream(`pi v0.78.0 starting...\n${CLEAN_RUN}\n\n`);
  assert.equal(o.completed, true);
  assert.equal(o.errored, false);
});

test('parsePiStream: a recovered intermediate error does not fail the run (last turn wins)', () => {
  const stream = [
    '{"type":"turn_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"transient"},"toolResults":[]}',
    '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"recovered"}],"stopReason":"stop"},"toolResults":[]}',
    '{"type":"agent_end","messages":[{"role":"assistant","content":[],"stopReason":"error","errorMessage":"transient"},{"role":"assistant","content":[{"type":"text","text":"recovered"}],"stopReason":"stop"}],"willRetry":false}',
  ].join('\n');
  const o = parsePiStream(stream);
  assert.equal(o.completed, true);
  assert.equal(o.errored, false);
  assert.equal(o.finalText, 'recovered');
});

// ---------------------------------------------------------------------------
// piRuntime (flag selection)
// ---------------------------------------------------------------------------

test('piRuntime: defaults to cli (the prod-proven path)', () => {
  assert.equal(piRuntime({}), 'cli');
  assert.equal(piRuntime({ MOREHANDS_PI_RUNTIME: 'cli' }), 'cli');
  assert.equal(piRuntime({ MOREHANDS_PI_RUNTIME: 'CLI' }), 'cli'); // only exact 'rpc' opts in
  assert.equal(piRuntime({ MOREHANDS_PI_RUNTIME: 'something' }), 'cli');
});

test('piRuntime: opts into rpc only on exact MOREHANDS_PI_RUNTIME=rpc', () => {
  assert.equal(piRuntime({ MOREHANDS_PI_RUNTIME: 'rpc' }), 'rpc');
});
await run();
