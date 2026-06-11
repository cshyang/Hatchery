// Soul assignment invariants — run: npx tsx src/project/souls.test.ts

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestRunner } from '../shared/test-utils';
import { assignSoul, pickDisplayName, soulAliases, soulBaseName, soulAvatarUrl } from './souls';
import { MAX_PERSONALITY_BODY, parseSkillFrontmatter, skillBody, type D1Like } from '../skills/repository';

const { test, run } = createTestRunner();

const SOUL_WREN = `---
name: soul-wren
description: Wren — laconic fixer.
aliases: Wrenna, Ren
---

# Personality

PERSONA: Wren

## Who you are

Short declaratives. Allergic to ceremony.

## SPINE

- Honesty outranks agreeableness.
`;

const SOUL_OWL = SOUL_WREN.replaceAll('Wren', 'Owl').replace('aliases: Owlna, Ren', 'aliases: Strix');

interface SkillRow {
  project_id: string;
  name: string;
  description: string;
  body_md: string;
  state: string;
  created_by: string;
}
interface PersonaRow {
  project_id: string;
  name: string;
  icon_emoji: string | null;
  icon_url: string | null;
}

// Pattern-matched fake covering the five queries assignSoul + setPersona issue.
class FakeD1 implements D1Like {
  skills: SkillRow[] = [];
  personas: PersonaRow[] = [];

  seedSoul(md: string): void {
    const name = md.match(/^name:\s*(.+)$/m)![1].trim();
    this.skills.push({ project_id: '__global__', name, description: 'soul', body_md: md, state: 'active', created_by: 'seed' });
  }

  prepare(query: string) {
    const self = this;
    return {
      bind(...values: unknown[]) {
        return {
          async run(): Promise<unknown> {
            if (query.includes('INSERT INTO skills')) {
              const [projectId, name, description, bodyMd] = values as [string, string, string, string];
              if (!self.skills.some((s) => s.project_id === projectId && s.name === name)) {
                self.skills.push({ project_id: projectId, name, description, body_md: bodyMd, state: 'active', created_by: 'system' });
              }
              return {};
            }
            if (query.includes('INSERT INTO personas')) {
              const [projectId, name, iconEmoji, iconUrl] = values as [string, string, string | null, string | null];
              const existing = self.personas.find((p) => p.project_id === projectId);
              if (existing) Object.assign(existing, { name, icon_emoji: iconEmoji, icon_url: iconUrl });
              else self.personas.push({ project_id: projectId, name, icon_emoji: iconEmoji, icon_url: iconUrl });
              return {};
            }
            throw new Error(`unexpected run: ${query}`);
          },
          async all<T>(): Promise<{ results: T[] }> {
            if (query.includes("name LIKE 'soul-%'")) {
              const [projectId] = values as [string];
              return {
                results: self.skills
                  .filter((s) => s.project_id === projectId && s.name.startsWith('soul-') && s.state === 'active')
                  .map((s) => ({ name: s.name, body_md: s.body_md })) as T[],
              };
            }
            if (query.includes('SELECT name FROM personas') && !query.includes('WHERE')) {
              return { results: self.personas.map((p) => ({ name: p.name })) as T[] };
            }
            throw new Error(`unexpected all: ${query}`);
          },
          async first<T = Record<string, unknown>>(): Promise<T | null> {
            if (query.includes('FROM skills')) {
              const [projectId, name] = values as [string, string];
              return self.skills.some((s) => s.project_id === projectId && s.name === name) ? ({ x: 1 } as T) : null;
            }
            if (query.includes('FROM personas')) {
              const [projectId] = values as [string];
              const row = self.personas.find((p) => p.project_id === projectId);
              return row ? ({ name: row.name } as T) : null;
            }
            throw new Error(`unexpected first: ${query}`);
          },
        };
      },
    };
  }
}

test('soul parsing: base name from PERSONA line, aliases from frontmatter', () => {
  assert.equal(soulBaseName(SOUL_WREN), 'Wren');
  assert.deepEqual(soulAliases(SOUL_WREN), ['Wrenna', 'Ren']);
  assert.equal(soulBaseName('---\nname: x\n---\nno persona line'), null);
  assert.deepEqual(soulAliases('---\nname: x\n---\nbody'), []);
});

test('pickDisplayName: base, then aliases, then roman numerals', () => {
  const aliases = ['Wrenna', 'Ren'];
  assert.equal(pickDisplayName('Wren', aliases, new Set()), 'Wren');
  assert.equal(pickDisplayName('Wren', aliases, new Set(['Wren'])), 'Wrenna');
  assert.equal(pickDisplayName('Wren', aliases, new Set(['Wren', 'Wrenna', 'Ren'])), 'Wren II');
  assert.equal(pickDisplayName('Wren', [], new Set(['Wren', 'Wren II'])), 'Wren III');
});

test('assignSoul: writes the personality skill AND the personas row', async () => {
  const db = new FakeD1();
  db.seedSoul(SOUL_WREN);
  const assigned = await assignSoul(db, 'C1', { random: () => 0, log: () => {} });
  assert.deepEqual(assigned, { soul: 'soul-wren', displayName: 'Wren' });

  const skill = db.skills.find((s) => s.project_id === 'C1' && s.name === 'personality');
  assert.ok(skill, 'channel personality skill written');
  assert.match(skill!.body_md, /PERSONA: Wren/);
  assert.doesNotMatch(skill!.body_md, /aliases:/, 'soul frontmatter not leaked into the personality body');

  const persona = db.personas.find((p) => p.project_id === 'C1');
  assert.equal(persona?.name, 'Wren');
  assert.equal(persona?.icon_url, soulAvatarUrl('Wren'));
});

test('assignSoul: idempotent — second call no-ops, identity untouched', async () => {
  const db = new FakeD1();
  db.seedSoul(SOUL_WREN);
  db.seedSoul(SOUL_OWL);
  await assignSoul(db, 'C1', { random: () => 0, log: () => {} });
  const again = await assignSoul(db, 'C1', { random: () => 0.99, log: () => {} });
  assert.equal(again, null);
  assert.equal(db.personas.length, 1);
});

test('assignSoul: name collision across channels resolves via alias and updates the PERSONA line', async () => {
  const db = new FakeD1();
  db.seedSoul(SOUL_WREN);
  await assignSoul(db, 'C1', { random: () => 0, log: () => {} });
  const second = await assignSoul(db, 'C2', { random: () => 0, log: () => {} });
  assert.equal(second?.displayName, 'Wrenna');
  const skill = db.skills.find((s) => s.project_id === 'C2' && s.name === 'personality');
  assert.match(skill!.body_md, /PERSONA: Wrenna/);
});

test('assignSoul: no souls seeded → null, nothing written (LLM hatching fallback)', async () => {
  const db = new FakeD1();
  const assigned = await assignSoul(db, 'C1', { log: () => {} });
  assert.equal(assigned, null);
  assert.equal(db.skills.length, 0);
  assert.equal(db.personas.length, 0);
});

test('assignSoul: respects an existing channel personality (LLM-hatched) even without a personas row', async () => {
  const db = new FakeD1();
  db.seedSoul(SOUL_WREN);
  db.skills.push({ project_id: 'C1', name: 'personality', description: 'mine', body_md: 'PERSONA: Custom', state: 'active', created_by: 'agent' });
  assert.equal(await assignSoul(db, 'C1', { log: () => {} }), null);
  assert.equal(db.personas.length, 0);
});

test('seeded soul files: well-formed, spined, and within the personality cap', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'seeds', 'global', 'souls');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 8, `expected a full flock, found ${files.length}`);
  for (const f of files) {
    const md = readFileSync(join(dir, f), 'utf8');
    const { name, description } = parseSkillFrontmatter(md);
    assert.match(name ?? '', /^soul-[a-z]+$/, `${f}: skill name`);
    assert.ok(description, `${f}: description`);
    const base = soulBaseName(md);
    assert.ok(base, `${f}: PERSONA line`);
    assert.ok(soulAliases(md).length >= 2, `${f}: needs aliases for collision fallback`);
    assert.match(md, /## SPINE/, `${f}: spine present`);
    assert.match(md, /## First meeting/i, `${f}: first-meeting note`);
    // Mirror assignSoul's generated personality skill and hold it to the same cap it enforces.
    const generated = `---\nname: personality\ndescription: Use always — identity, voice, and judgment. This channel's soul: ${base}.\n---\n\n${skillBody(md)}\n`;
    assert.ok(generated.length <= MAX_PERSONALITY_BODY, `${f}: generated personality ${generated.length} > ${MAX_PERSONALITY_BODY}`);
  }
});

test('assignSoul: never assigns to __global__', async () => {
  const db = new FakeD1();
  db.seedSoul(SOUL_WREN);
  assert.equal(await assignSoul(db, '__global__', { log: () => {} }), null);
});

void run();
