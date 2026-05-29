// Slack request signature verification (Web Crypto — runs on Workers).
// https://api.slack.com/authentication/verifying-requests-from-slack

const FIVE_MINUTES = 60 * 5;

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify the `v0=` HMAC-SHA256 signature over `v0:<ts>:<rawBody>`, and reject
 * stale timestamps (replay protection). Returns false on any missing input.
 */
export async function verifySlackSignature(
  signingSecret: string,
  rawBody: string,
  timestamp: string | undefined | null,
  signature: string | undefined | null,
): Promise<boolean> {
  if (!signingSecret || !timestamp || !signature) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > FIVE_MINUTES) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${timestamp}:${rawBody}`));
  const expected = `v0=${toHex(mac)}`;
  return constantTimeEqual(expected, signature);
}
