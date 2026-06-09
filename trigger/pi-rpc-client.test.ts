// pi-rpc-client pure-helper tests — run: npx tsx trigger/pi-rpc-client.test.ts
import assert from 'node:assert/strict';
import { createTestRunner } from '../src/shared/test-utils';
import { outcomeFromEvents, progressFromEvent } from './pi-rpc-client';

const { test, run } = createTestRunner();

test('outcomeFromEvents: clean run → completed, not errored, finalText', () => {
  const o = outcomeFromEvents([
    { type: 'agent_start' },
    { type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], stopReason: 'stop' } },
    { type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Done.' }], stopReason: 'stop' }], willRetry: false },
  ]);
  assert.equal(o.completed, true);
  assert.equal(o.errored, false);
  assert.equal(o.finalText, 'Done.');
});

test('outcomeFromEvents: error turn caught even though the loop ended (agent_end present)', () => {
  const o = outcomeFromEvents([
    { type: 'turn_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '400 Unknown Model' } },
    { type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: '400 Unknown Model' }], willRetry: false },
  ]);
  assert.equal(o.completed, true);
  assert.equal(o.errored, true);
  assert.equal(o.errorMessage, '400 Unknown Model');
});

test('outcomeFromEvents: no agent_end → not completed (pi died mid-stream)', () => {
  const o = outcomeFromEvents([{ type: 'agent_start' }, { type: 'turn_start' }]);
  assert.equal(o.completed, false);
  assert.equal(o.errored, false);
});

test('outcomeFromEvents: recovered intermediate error does not fail the run (last turn wins)', () => {
  const o = outcomeFromEvents([
    { type: 'turn_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'transient' } },
    { type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text: 'recovered' }], stopReason: 'stop' } },
    { type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'recovered' }], stopReason: 'stop' }], willRetry: false },
  ]);
  assert.equal(o.completed, true);
  assert.equal(o.errored, false);
  assert.equal(o.finalText, 'recovered');
});

// ---------------------------------------------------------------------------
// progressFromEvent
// ---------------------------------------------------------------------------

test('progressFromEvent: turn_end → turn beat with text and tool-call names', () => {
  const beat = progressFromEvent({
    type: 'turn_end',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Editing the file.' },
        { type: 'toolCall', name: 'edit' },
        { type: 'toolCall', name: 'bash' },
      ],
    },
  });
  assert.deepEqual(beat, { kind: 'turn', text: 'Editing the file.', toolCalls: ['edit', 'bash'] });
});

test('progressFromEvent: tool_execution_start → tool_start with path/command summary', () => {
  assert.deepEqual(progressFromEvent({ type: 'tool_execution_start', toolName: 'edit', args: { path: 'README.md' } }), {
    kind: 'tool_start',
    tool: 'edit',
    summary: 'README.md',
  });
  assert.deepEqual(progressFromEvent({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'npm test' } }), {
    kind: 'tool_start',
    tool: 'bash',
    summary: 'npm test',
  });
});

test('progressFromEvent: tool_execution_end → tool_end carries isError', () => {
  assert.deepEqual(progressFromEvent({ type: 'tool_execution_end', toolName: 'bash', isError: true }), {
    kind: 'tool_end',
    tool: 'bash',
    isError: true,
  });
});

test('progressFromEvent: non-progress events → null', () => {
  assert.equal(progressFromEvent({ type: 'agent_start' }), null);
  assert.equal(progressFromEvent({ type: 'message_update' }), null);
  assert.equal(progressFromEvent({ type: 'agent_end' }), null);
});

await run();
