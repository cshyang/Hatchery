// Bounded-text helpers shared by audit-ledger modules (code-mode, workspace).
// Previews stored in D1 must be byte-bounded and secret-redacted; raw values
// never leave the executing module.

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function truncateToBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  let out = '';
  let total = 0;
  for (const ch of value) {
    const next = byteLength(ch);
    if (total + next > maxBytes) break;
    out += ch;
    total += next;
  }
  return out;
}

export function redactSecrets(value: string): string {
  return value
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+/g, '[redacted]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]+/g, '[redacted]')
    .replace(/\blin_wh_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/\be2b_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/\bnk_[A-Za-z0-9_]+/g, '[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]');
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify(String(value));
  }
}
