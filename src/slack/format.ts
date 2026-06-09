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

export function formatSlackText(input: string): string {
  const raw = String(input ?? '');
  const { text, tokens } = protect(raw, [/```[\s\S]*?```/g, /`[^`\n]*`/g, /<[^>\n]+>/g]);
  return restore(formatUnprotected(text), tokens);
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
