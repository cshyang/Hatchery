// Crypto invariants (ADR 0003, D5/D10) — run: npx tsx src/crypto.test.ts
// AES-GCM envelope + args hashing. The IV-freshness invariant is the load-bearing one.

import assert from 'node:assert/strict';
import { encryptSecret, decryptSecret, fingerprint, argsHash } from './crypto';

const KEY = 'a'.repeat(64); // 32 bytes hex
const KEY2 = 'b'.repeat(64);

const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

test('round-trip: decrypt(encrypt(x)) === x', async () => {
  const secret = 'github_pat_11ABCDEF_supersecrettoken';
  const ct = await encryptSecret(secret, KEY);
  assert.equal(await decryptSecret(ct, KEY), secret);
});

test('fresh IV: encrypting the same plaintext twice yields different ciphertext', async () => {
  const a = await encryptSecret('same', KEY);
  const b = await encryptSecret('same', KEY);
  assert.notEqual(a, b, 'IV reuse! ciphertexts must differ (random nonce per encrypt)');
  // both still decrypt back
  assert.equal(await decryptSecret(a, KEY), 'same');
  assert.equal(await decryptSecret(b, KEY), 'same');
});

test('wrong key fails to decrypt (GCM auth tag)', async () => {
  const ct = await encryptSecret('secret', KEY);
  await assert.rejects(decryptSecret(ct, KEY2));
});

test('tampered ciphertext fails to decrypt', async () => {
  const ct = await encryptSecret('secret', KEY);
  // Corrupt one raw byte (decode → flip last byte → re-encode) to reliably break the GCM
  // auth tag, independent of which base64 chars sit where.
  const raw = Uint8Array.from(atob(ct), (c) => c.charCodeAt(0));
  raw[raw.length - 1] ^= 0xff;
  let s = '';
  for (const b of raw) s += String.fromCharCode(b);
  await assert.rejects(decryptSecret(btoa(s), KEY));
});

test('bad key length is rejected loudly', async () => {
  await assert.rejects(encryptSecret('x', 'tooshort'), /64 hex/);
});

test('fingerprint is stable, prefixed, and not the secret', async () => {
  const fp = await fingerprint('mytoken');
  assert.equal(fp, await fingerprint('mytoken'), 'stable');
  assert.match(fp, /^sha256:[0-9a-f]{12}$/);
  assert.ok(!fp.includes('mytoken'));
  assert.notEqual(fp, await fingerprint('othertoken'));
});

test('argsHash is order-independent over object keys but value-sensitive', async () => {
  const h1 = await argsHash({ repo: 'o/r', title: 'Bug', body: 'x' });
  const h2 = await argsHash({ body: 'x', title: 'Bug', repo: 'o/r' }); // reordered
  assert.equal(h1, h2, 'key order must not change the hash');
  const h3 = await argsHash({ repo: 'o/r', title: 'Bug', body: 'y' }); // changed value
  assert.notEqual(h1, h3, 'a changed value MUST change the hash (D10 confused-deputy guard)');
});

const main = async () => {
  let pass = 0;
  let fail = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      pass++;
    } catch (e) {
      console.log(`  ✗ ${name}\n    ${(e as Error).message}`);
      fail++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
};

await main();
