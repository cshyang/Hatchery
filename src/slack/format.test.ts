// Slack formatting invariants — run: npx tsx src/slack/format.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { chunkSlackText, convertMarkdownTables, formatSlackText } from './format';

const { test, run } = createTestRunner();

test('formatSlackText converts common Markdown while preserving Slack entities and code', () => {
  const input = [
    '# Setup',
    '',
    '**Ready** for [GitHub](https://github.com/acme/widgets) in <#C123|dev>.',
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
      '*Ready* for <https://github.com/acme/widgets|GitHub> in <#C123|dev>.',
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

test('convertMarkdownTables: 2-column table becomes *Key:* value lines (header dropped)', () => {
  const md = ['| Setting | Value |', '| --- | --- |', '| Linear team | WID (Widgets) |', '| Repo | acme/widgets |'].join('\n');
  assert.equal(convertMarkdownTables(md), '*Linear team:* WID (Widgets)\n*Repo:* acme/widgets');
});

test('convertMarkdownTables: 3+ columns become an aligned monospace block', () => {
  const md = ['| Name | Status | Age |', '|---|---|---|', '| Wren | active | 2d |', '| Owl | pending | 19m |'].join('\n');
  const out = convertMarkdownTables(md);
  assert.equal(out.startsWith('```'), true);
  assert.match(out, /Name {2}Status {3}Age/);
  assert.match(out, /Wren {2}active {3}2d/);
  assert.equal(out.endsWith('```'), true);
});

test('convertMarkdownTables: surrounding prose and non-table pipes untouched', () => {
  const md = 'Before the table\n\n| K | V |\n|---|---|\n| a | b |\n\nthis | is not a table';
  const out = convertMarkdownTables(md);
  assert.match(out, /Before the table/);
  assert.match(out, /\*a:\* b/);
  assert.match(out, /this \| is not a table/);
});

test('formatSlackText converts tables but leaves tables inside code fences alone', () => {
  const fenced = '```\n| raw | table |\n|---|---|\n| x | y |\n```';
  assert.equal(formatSlackText(fenced), fenced);
  assert.equal(formatSlackText('| K | V |\n|---|---|\n| **a** | b |'), '*a:* b');
});

await run();
