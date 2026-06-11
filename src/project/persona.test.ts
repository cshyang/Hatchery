// Persona store invariants — run: npx tsx src/project/persona.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { loadPersona, setPersona, personaIdentity, PERSONA_NAME_MAX } from './persona';
import type { D1Like } from '../skills/repository';

const { test, run } = createTestRunner();

interface PersonaRow {
  project_id: string;
  name: string;
  icon_emoji: string | null;
  icon_url: string | null;
  updated_by: string;
}

// Pattern-matched fake for the two queries the store issues.
class FakeD1 implements D1Like {
  rows: PersonaRow[] = [];

  prepare(query: string) {
    const self = this;
    return {
      bind(...values: unknown[]) {
        return {
          async run(): Promise<unknown> {
            if (query.startsWith('INSERT INTO personas')) {
              const [projectId, name, iconEmoji, iconUrl, updatedBy] = values as [string, string, string | null, string | null, string];
              const existing = self.rows.find((r) => r.project_id === projectId);
              if (existing) Object.assign(existing, { name, icon_emoji: iconEmoji, icon_url: iconUrl, updated_by: updatedBy });
              else self.rows.push({ project_id: projectId, name, icon_emoji: iconEmoji, icon_url: iconUrl, updated_by: updatedBy });
              return { meta: { changes: 1 } };
            }
            throw new Error(`unexpected run query: ${query}`);
          },
          async all<T>(): Promise<{ results: T[] }> {
            throw new Error('unused');
          },
          async first<T = Record<string, unknown>>(): Promise<T | null> {
            if (query.includes('FROM personas')) {
              const [projectId] = values as [string];
              const row = self.rows.find((r) => r.project_id === projectId);
              return row ? ({ name: row.name, icon_emoji: row.icon_emoji, icon_url: row.icon_url } as T) : null;
            }
            throw new Error(`unexpected first query: ${query}`);
          },
        };
      },
    };
  }
}

test('setPersona inserts, loadPersona reads it back', async () => {
  const db = new FakeD1();
  const set = await setPersona(db, 'P', { name: 'Wren', iconEmoji: ':bird:' });
  assert.deepEqual(set, { name: 'Wren', iconEmoji: ':bird:', iconUrl: null });
  assert.deepEqual(await loadPersona(db, 'P'), { name: 'Wren', iconEmoji: ':bird:', iconUrl: null });
  assert.equal(await loadPersona(db, 'OTHER'), null);
});

test('setPersona replaces the whole identity in place and trims', async () => {
  const db = new FakeD1();
  await setPersona(db, 'P', { name: 'Wren', iconEmoji: ':bird:' });
  await setPersona(db, 'P', { name: '  Owl  ', iconUrl: 'https://api.dicebear.com/9.x/thumbs/png?seed=Owl' });
  assert.equal(db.rows.length, 1);
  // The emoji from the previous call does NOT linger — each call replaces both icon fields.
  assert.deepEqual(await loadPersona(db, 'P'), {
    name: 'Owl',
    iconEmoji: null,
    iconUrl: 'https://api.dicebear.com/9.x/thumbs/png?seed=Owl',
  });
});

test('setPersona validates name, emoji, and url', async () => {
  const db = new FakeD1();
  await assert.rejects(() => setPersona(db, 'P', { name: '' }), /non-empty name/);
  await assert.rejects(() => setPersona(db, 'P', { name: 'x'.repeat(PERSONA_NAME_MAX + 1) }), /exceeds/);
  await assert.rejects(() => setPersona(db, 'P', { name: 'Wren', iconEmoji: 'bird' }), /emoji syntax/);
  await assert.rejects(() => setPersona(db, 'P', { name: 'Wren', iconEmoji: ':NOT VALID:' }), /emoji syntax/);
  await assert.rejects(() => setPersona(db, 'P', { name: 'Wren', iconUrl: 'http://insecure.example/a.png' }), /https/);
  await assert.rejects(() => setPersona(db, 'P', { name: 'Wren', iconUrl: `https://x.example/${'a'.repeat(512)}` }), /https/);
});

test('personaIdentity emits at most one icon field, emoji first', () => {
  assert.deepEqual(personaIdentity(null), {});
  assert.deepEqual(personaIdentity({ name: 'Wren', iconEmoji: null, iconUrl: null }), { username: 'Wren' });
  assert.deepEqual(personaIdentity({ name: 'Wren', iconEmoji: ':bird:', iconUrl: 'https://x.example/a.png' }), {
    username: 'Wren',
    iconEmoji: ':bird:',
  });
  assert.deepEqual(personaIdentity({ name: 'Wren', iconEmoji: null, iconUrl: 'https://x.example/a.png' }), {
    username: 'Wren',
    iconUrl: 'https://x.example/a.png',
  });
});

await run();
