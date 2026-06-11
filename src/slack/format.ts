export const SLACK_TEXT_LIMIT = 38_000;

interface ChunkOptions {
  maxChars?: number;
  label?: boolean;
}

interface ProtectedToken {
  key: string;
  value: string;
}

function protect(input: string, patterns: RegExp[]): { text: string; tokens: ProtectedToken[] } {
  const tokens: ProtectedToken[] = [];
  let text = input;
  for (const pattern of patterns) {
    text = text.replace(pattern, (value) => {
      const key = `\uE000${tokens.length}\uE000`;
      tokens.push({ key, value });
      return key;
    });
  }
  return { text, tokens };
}

function restore(input: string, tokens: ProtectedToken[]): string {
  return tokens.reduce((out, token) => out.replaceAll(token.key, token.value), input);
}

function formatUnprotected(input: string): string {
  return input
    .replace(/^(#{1,6})[ \t]+(.+)$/gm, (_m, _hashes, title: string) => `*${title.trim()}*`)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => `<${url}|${label}>`)
    .replace(/\*\*([^*\n](?:.*?[^*\n])?)\*\*/g, (_m, value: string) => `*${value}*`);
}

const TABLE_SEPARATOR_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

function tableCells(line: string): string[] {
  const cells = line.split('|').map((c) => c.trim());
  if (cells.length && cells[0] === '') cells.shift(); // leading boundary pipe
  if (cells.length && cells[cells.length - 1] === '') cells.pop(); // trailing boundary pipe
  return cells;
}

/** Slack renders markdown tables as raw pipes, so the transport adapter translates them — the
 *  agent stays transport-neutral and writes whatever markdown fits (ADR 0001's seam). Two-column
 *  tables (the overwhelmingly common key-value case) become `*Key:* value` lines; wider tables
 *  become an aligned monospace block, which Slack DOES render legibly. Exported for tests. */
export function convertMarkdownTables(input: string): string {
  const lines = input.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const isHeader = lines[i].includes('|') && i + 1 < lines.length && TABLE_SEPARATOR_RE.test(lines[i + 1]) && lines[i + 1].includes('-');
    if (!isHeader) {
      out.push(lines[i]);
      continue;
    }
    const header = tableCells(lines[i]);
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length && lines[j].includes('|'); j++) rows.push(tableCells(lines[j]));
    if (header.length === 2) {
      // Key-value: the header is structural labeling; the keys themselves carry it. The key cell
      // gets bolded wholesale, so emphasis markers inside it would only nest badly — drop them.
      out.push(...rows.map((r) => `*${(r[0] ?? '').replace(/\*/g, '')}:* ${r[1] ?? ''}`));
    } else {
      const all = [header, ...rows];
      const widths = header.map((_, col) => Math.max(...all.map((r) => (r[col] ?? '').length)));
      const pad = (r: string[]) => widths.map((w, col) => (r[col] ?? '').padEnd(w)).join('  ').trimEnd();
      out.push('```', pad(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(pad), '```');
    }
    i = j - 1; // resume after the table block
  }
  return out.join('\n');
}

export function formatSlackText(input: string): string {
  const raw = String(input ?? '');
  const { text, tokens } = protect(raw, [/```[\s\S]*?```/g, /`[^`\n]*`/g, /<[^>\n]+>/g]);
  return restore(formatUnprotected(convertMarkdownTables(text)), tokens);
}

function splitUnits(input: string): string[] {
  const units: string[] = [];
  const lines = input.split('\n');
  let current: string[] = [];
  let inFence = false;

  const flush = () => {
    const unit = current.join('\n').trim();
    if (unit) units.push(unit);
    current = [];
  };

  for (const line of lines) {
    const fence = line.trim().startsWith('```');
    if (!inFence && !line.trim()) {
      flush();
      continue;
    }

    current.push(line);
    if (fence) inFence = !inFence;
  }

  flush();
  return units;
}

function splitLongUnit(unit: string, maxChars: number): string[] {
  const out: string[] = [];
  let rest = unit.trim();

  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1);
    const breakAt = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
    const cut = breakAt > Math.floor(maxChars * 0.4) ? breakAt : maxChars;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) out.push(rest);
  return out;
}

export function chunkSlackText(input: string, options: ChunkOptions = {}): string[] {
  const maxChars = Math.max(1, options.maxChars ?? SLACK_TEXT_LIMIT);
  const text = String(input ?? '').trim();
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let current = '';

  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  const addUnit = (unit: string) => {
    if (unit.length > maxChars) {
      pushCurrent();
      chunks.push(...splitLongUnit(unit, maxChars));
      return;
    }
    if (!current) {
      current = unit;
      return;
    }
    const candidate = `${current}\n\n${unit}`;
    if (candidate.length <= maxChars) current = candidate;
    else {
      pushCurrent();
      current = unit;
    }
  };

  for (const unit of splitUnits(text)) addUnit(unit);
  pushCurrent();

  if (!options.label || chunks.length <= 1) return chunks;
  const total = chunks.length;
  return chunks.map((chunk, i) => `Part ${i + 1}/${total}\n\n${chunk}`);
}
