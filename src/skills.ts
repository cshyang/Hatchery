// Agent-authored skills, stored in D1 (the "what"). Skills are SKILL.md text the
// agent writes for itself — the same SKILL.md format Flue/Claude use — so a future swap to
// Flue's native skill loader is cheap. Progressive disclosure is a query split:
//   L1 (always in context): SELECT name, description   — see loadSkillCatalog
//   L2 (on demand):         SELECT body_md WHERE name  — load_skill tool / fire-time inject
// No filesystem needed: the "files" were only ever a key->content lookup; D1 is that.
//
// Lifecycle (ADR 0002): a skill is 'active' or 'archived'. Active = catalogued, loadable,
// runnable. Archived = retired from automation: hidden from the catalog, not loadable, and
// REFUSED by scheduled fire (an archived skill is stale/wrong by definition — running it on a
// schedule is stale automation, not safety). Archiving is reversible (restore_skill); we never
// hard-delete. The read API is split by intent so these rules can't be bypassed:
//   loadSkillCatalog      → active only (the prompt's L1 list)
//   loadActiveSkillBody   → active only (load_skill, and the personality skill)
//   loadRunnableSkillBody → status-aware (scheduled fire; lets the caller refuse archived/absent)

import { defineTool, Type, type ToolDefinition } from '@flue/runtime';

// Minimal D1 surface we use (avoids pulling all of @cloudflare/workers-types here).
export interface D1Like {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
      first<T = Record<string, unknown>>(): Promise<T | null>;
    };
  };
}

// Pull name + description from a SKILL.md frontmatter fence. Minimal — not a full
// YAML parser; matches `name:` / `description:` lines inside the leading --- --- block.
export function parseSkillFrontmatter(md: string): { name?: string; description?: string } {
  const fence = md.match(/^\s*---\s*\n([\s\S]*?)\n---/);
  if (!fence) return {};
  const fm = fence[1];
  const get = (key: string): string | undefined => {
    const line = fm.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm'));
    return line ? line[1].trim().replace(/^["']|["']$/g, '').trim() : undefined;
  };
  return { name: get('name'), description: get('description') };
}

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_DESCRIPTION = 1024; // matches the SKILL.md convention; the description is the L1 line

// The markdown body after the frontmatter fence (used to apply a `personality` skill).
export function skillBody(md: string): string {
  const fence = md.match(/^\s*---\s*\n[\s\S]*?\n---\s*\n?/);
  return (fence ? md.slice(fence[0].length) : md).trim();
}

// L1: the cheap catalog (names + descriptions of ACTIVE skills) injected into the system prompt.
export async function loadSkillCatalog(db: D1Like, projectId: string): Promise<{ name: string; description: string }[]> {
  const { results } = await db
    .prepare("SELECT name, description FROM skills WHERE project_id=? AND state='active' ORDER BY name")
    .bind(projectId)
    .all<{ name: string; description: string }>();
  return results ?? [];
}

// L2 (active-only): full body of an ACTIVE skill. Used by the load_skill tool and to apply the
// `personality` skill. An archived skill is not loadable — returns null, same as a missing one.
export async function loadActiveSkillBody(db: D1Like, projectId: string, name: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT body_md FROM skills WHERE project_id=? AND name=? AND state='active'")
    .bind(projectId, name)
    .first<{ body_md: string }>();
  return row?.body_md ?? null;
}

// What a scheduled fire learns when it resolves a reminder's skill name: the body if active,
// or *why* it can't run (archived vs absent) so the caller can log a precise diagnostic and skip
// instead of silently running stale automation or silently no-op'ing.
export type RunnableSkill =
  | { status: 'active'; body: string }
  | { status: 'archived' }
  | { status: 'absent' };

// L2 (status-aware): for scheduled fire only. Reads any state so the caller can DISTINGUISH
// archived from absent and refuse both with a clear reason (see .flue/app.ts).
export async function loadRunnableSkillBody(db: D1Like, projectId: string, name: string): Promise<RunnableSkill> {
  const row = await db
    .prepare('SELECT body_md, state FROM skills WHERE project_id=? AND name=?')
    .bind(projectId, name)
    .first<{ body_md: string; state: string }>();
  if (!row) return { status: 'absent' };
  if (row.state === 'archived') return { status: 'archived' };
  return { status: 'active', body: row.body_md };
}

export function skillTools(db: D1Like, projectId: string): ToolDefinition[] {
  const saveSkill = defineTool({
    name: 'save_skill',
    description:
      'Create or update one of your own reusable skills — a saved "how-to" you can run on demand or schedule. ' +
      'Pass the full skill as SKILL.md text: a `---` frontmatter block with `name` (lowercase-kebab, its id) and ' +
      '`description` (≤1024 chars, and START it with "Use when …" naming the trigger — that one line is all you see ' +
      'until you open the skill), then the body. Structure the body Overview → When to use → numbered steps; keep it ' +
      'to roughly a screenful; do not duplicate an existing skill — extend it instead. Reusing a name overwrites it ' +
      '(and reactivates it if it was archived).',
    parameters: Type.Object({
      skill_md: Type.String({ description: 'Full SKILL.md: `---` name/description frontmatter `---` then the body.' }),
    }),
    async execute({ skill_md }) {
      const md = String(skill_md);
      const { name, description } = parseSkillFrontmatter(md);
      if (!name || !description) throw new Error('skill_md needs frontmatter with both `name` and `description`.');
      if (!SKILL_NAME.test(name)) throw new Error(`skill name must be lowercase-kebab (a-z 0-9 -); got "${name}".`);
      if (description.length > MAX_DESCRIPTION) {
        throw new Error(`description must be ≤ ${MAX_DESCRIPTION} chars (got ${description.length}).`);
      }
      const now = Date.now();
      // Re-saving a name reactivates it: state forced back to 'active', archived_at cleared.
      // created_at / created_by are NOT overwritten on conflict (first authorship is preserved).
      await db
        .prepare(
          `INSERT INTO skills(project_id, name, description, body_md, state, created_by, updated_by, created_at, updated_at, archived_at)
           VALUES(?,?,?,?,'active','agent','agent',?,?,NULL)
           ON CONFLICT(project_id, name) DO UPDATE SET
             description=excluded.description, body_md=excluded.body_md,
             state='active', updated_by='agent', updated_at=excluded.updated_at, archived_at=NULL`,
        )
        .bind(projectId, name, description, md, now, now)
        .run();
      console.log(`[skills] save project=${projectId} name=${name}`);
      return `saved skill "${name}".`;
    },
  });

  const loadSkill = defineTool({
    name: 'load_skill',
    description:
      'Open the full steps of one of your saved skills by name. Your skill list (names + descriptions) is already ' +
      'in context; call this when you need a specific skill’s detailed body.',
    parameters: Type.Object({ name: Type.String({ description: 'Skill name from your skill list.' }) }),
    async execute({ name }) {
      const body = await loadActiveSkillBody(db, projectId, String(name));
      return body ?? `No active skill named "${name}".`;
    },
  });

  const archiveSkill = defineTool({
    name: 'archive_skill',
    description:
      'Retire one of your saved skills by name. It leaves your skill list and stops running (a reminder pointing at ' +
      'it will refuse to fire rather than run stale steps). Reversible with restore_skill. Use this instead of ' +
      'deleting — for a skill that is stale, wrong, or has been folded into a broader one.',
    parameters: Type.Object({ name: Type.String({ description: 'Skill name to archive.' }) }),
    async execute({ name }) {
      const now = Date.now();
      const res = (await db
        .prepare(
          "UPDATE skills SET state='archived', archived_at=?, updated_by='agent', updated_at=? WHERE project_id=? AND name=? AND state='active'",
        )
        .bind(now, now, projectId, String(name))
        .run()) as { meta?: { changes?: number } };
      const changed = res?.meta?.changes ?? 0;
      console.log(`[skills] archive project=${projectId} name=${name} changed=${changed}`);
      return changed ? `archived skill "${name}".` : `No active skill named "${name}" to archive.`;
    },
  });

  const restoreSkill = defineTool({
    name: 'restore_skill',
    description: 'Bring back a skill you archived, by name — it returns to your skill list and can run again.',
    parameters: Type.Object({ name: Type.String({ description: 'Archived skill name to restore.' }) }),
    async execute({ name }) {
      const now = Date.now();
      const res = (await db
        .prepare(
          "UPDATE skills SET state='active', archived_at=NULL, updated_by='agent', updated_at=? WHERE project_id=? AND name=? AND state='archived'",
        )
        .bind(now, projectId, String(name))
        .run()) as { meta?: { changes?: number } };
      const changed = res?.meta?.changes ?? 0;
      console.log(`[skills] restore project=${projectId} name=${name} changed=${changed}`);
      return changed ? `restored skill "${name}".` : `No archived skill named "${name}" to restore.`;
    },
  });

  return [saveSkill, loadSkill, archiveSkill, restoreSkill];
}
