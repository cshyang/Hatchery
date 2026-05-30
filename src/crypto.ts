// Envelope encryption for stored credentials (ADR 0003, D5). AES-256-GCM via WebCrypto
// (available in Workers and Node 19+). Key = MASTER_ENCRYPTION_KEY (64 hex chars = 32 bytes),
// a Worker secret.
//
// THE one line to get right: a FRESH random 12-byte IV per encrypt, prepended to the
// ciphertext. GCM nonce reuse under the same key is catastrophic (leaks the auth key), so the
// IV is never fixed or a counter.
//
// Honest scope: the key lives in the same Worker env as this code and the DB binding, so this
// defends a credential-STORE-only leak (a D1 dump / read replica / backup where Worker secrets
// don't travel) — NOT Worker or CF-account compromise (which hands over the key too). A narrow,
// real win, not "strong encryption at rest." Upgrade to a KMS-held key if the threat model hardens.

const IV_BYTES = 12;

// Returns an ArrayBuffer-backed view so it satisfies WebCrypto's BufferSource under TS's
// strict lib.dom (a plain Uint8Array can be SharedArrayBuffer-backed in the type system).
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('MASTER_ENCRYPTION_KEY must be 64 hex chars (32 bytes, e.g. `openssl rand -hex 32`).');
  }
  const out = new Uint8Array(new ArrayBuffer(32));
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function importKey(keyHex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', hexToBytes(keyHex), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypt plaintext → base64(iv ‖ ciphertext). Fresh random IV every call. */
export async function encryptSecret(plaintext: string, keyHex: string): Promise<string> {
  const key = await importKey(keyHex);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES)); // FRESH per encrypt — never fixed
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)),
  );
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(iv, 0);
  out.set(ct, IV_BYTES);
  return b64encode(out);
}

/** Decrypt base64(iv ‖ ciphertext) → plaintext. Throws on a wrong key or tampered bytes (GCM auth). */
export async function decryptSecret(b64: string, keyHex: string): Promise<string> {
  const key = await importKey(keyHex);
  const all = b64decode(b64);
  const iv = all.slice(0, IV_BYTES);
  const ct = all.slice(IV_BYTES);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Short, non-reversible display fingerprint (NOT the secret) — answers "which key is this". */
export async function fingerprint(plaintext: string): Promise<string> {
  return 'sha256:' + (await sha256Hex(plaintext)).slice(0, 12);
}

// Stable, key-order-independent JSON for hashing. (Not a full canonicalizer — args are flat
// tool params, so sorted keys + recursion is enough and predictable.)
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

/** Hash of proposed args (ADR D10). The executor recomputes this from the stored row and
 *  refuses on mismatch, so the approved artifact is exactly the executed artifact. */
export async function argsHash(args: unknown): Promise<string> {
  return sha256Hex(canonical(args));
}
