// Slack formatting invariants — run: npx tsx src/slack/format.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { chunkSlackText, formatSlackText } from './format';

const { test, run } = createTestRunner();

test('formatSlackText converts common Markdown while preserving Slack entities and code', () => {
  const input = [
    '# Setup',
    '',
    '**Ready** for [GitHub](https://github.com/Calibrax-ai/autoship) in <#C123|dev>.',
    'Use `2 ** 3` and keep <https://linear.app|Linear> unchanged.',
    '',
    '```ts',
    'const v = "**not bold** [not a link](https://example.com)";',
    '```',
  ].join('\n');

  assert.equal(
    formatSlackText(input),
    [
      '*Setup*',
      '',
      '*Ready* for <https://github.com/Calibrax-ai/autoship|GitHub> in <#C123|dev>.',
      'Use `2 ** 3` and keep <https://linear.app|Linear> unchanged.',
      '',
      '```ts',
      'const v = "**not bold** [not a link](https://example.com)";',
      '```',
    ].join('\n'),
  );
});

test('formatSlackText is idempotent for already-Slack-formatted links', () => {
  const once = formatSlackText('See <https://example.com|Example> and **bold**.');
  assert.equal(once, 'See <https://example.com|Example> and *bold*.');
  assert.equal(formatSlackText(once), once);
});

test('chunkSlackText leaves short messages alone', () => {
  assert.deepEqual(chunkSlackText('short answer', { maxChars: 40 }), ['short answer']);
});

test('chunkSlackText splits long messages deterministically at paragraph boundaries', () => {
  const chunks = chunkSlackText('First paragraph.\n\nSecond paragraph is longer.\n\nThird paragraph.', {
    maxChars: 34,
  });

  assert.deepEqual(chunks, ['First paragraph.', 'Second paragraph is longer.', 'Third paragraph.']);
});

test('chunkSlackText avoids splitting inside fenced code blocks when the block fits', () => {
  const text = ['Intro', '', '```ts', 'const value = 1;', '```', '', 'After'].join('\n');
  const chunks = chunkSlackText(text, { maxChars: 30 });

  assert.deepEqual(chunks, ['Intro', '```ts\nconst value = 1;\n```', 'After']);
});

test('chunkSlackText labels chunks only when requested after final count is known', () => {
  const chunks = chunkSlackText('Alpha beta gamma delta epsilon zeta', { maxChars: 12, label: true });

  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].startsWith('Part 1/3\n\n'), true);
  assert.equal(chunks[2].startsWith('Part 3/3\n\n'), true);
});

await run();
