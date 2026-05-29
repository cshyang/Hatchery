// Agent-authored skills, stored in D1 (the "what"). Skills are SKILL.md text the
// agent writes for itself — same format as Flue/Hermes/Claude — so a future swap to
// Flue's native skill loader is cheap. Progressive disclosure is a query split:
//   L1 (always in context): SELECT name, description   — see loadSkillCatalog
//   L2 (on demand):         SELECT body_md WHERE name  — load_skill tool / fire-time inject
// No filesystem needed: the "files" were only ever a key->content lookup; D1 is that.

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

// L1: the cheap catalog (names + descriptions) injected into the system prompt.
export async function loadSkillCatalog(db: D1Like, projectId: string): Promise<{ name: string; description: string }[]> {
  const { results } = await db
    .prepare('SELECT name, description FROM skills WHERE project_id=? ORDER BY name')
    .bind(projectId)
    .all<{ name: string; description: string }>();
  return results ?? [];
}

// L2: full skill body, loaded on demand (by the load_skill tool AND fresh at fire time).
export async function loadSkillBody(db: D1Like, projectId: string, name: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT body_md FROM skills WHERE project_id=? AND name=?')
    .bind(projectId, name)
    .first<{ body_md: string }>();
  return row?.body_md ?? null;
}

export function skillTools(db: D1Like, projectId: string): ToolDefinition[] {
  const saveSkill = defineTool({
    name: 'save_skill',
    description:
      'Create or update one of your own reusable skills (a saved "how-to" you can run on demand or schedule). ' +
      'Pass the full skill as SKILL.md text: a `---` frontmatter block with `name` (lowercase-kebab — this is its id) ' +
      'and `description` (one line: when to use it), then a markdown body of steps. Reusing a name overwrites it.',
    parameters: Type.Object({
      skill_md: Type.String({ description: 'Full SKILL.md: `---` name/description frontmatter `---` then the body.' }),
    }),
    async execute({ skill_md }) {
      const md = String(skill_md);
      const { name, description } = parseSkillFrontmatter(md);
      if (!name || !description) throw new Error('skill_md needs frontmatter with both `name` and `description`.');
      if (!SKILL_NAME.test(name)) throw new Error(`skill name must be lowercase-kebab (a-z 0-9 -); got "${name}".`);
      await db
        .prepare(
          `INSERT INTO skills(project_id, name, description, body_md, updated_at)
           VALUES(?,?,?,?,?)
           ON CONFLICT(project_id, name) DO UPDATE SET
             description=excluded.description, body_md=excluded.body_md, updated_at=excluded.updated_at`,
        )
        .bind(projectId, name, description, md, Date.now())
        .run();
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
      const body = await loadSkillBody(db, projectId, String(name));
      return body ?? `No skill named "${name}".`;
    },
  });

  const deleteSkill = defineTool({
    name: 'delete_skill',
    description: 'Delete one of your saved skills by name.',
    parameters: Type.Object({ name: Type.String({ description: 'Skill name to delete.' }) }),
    async execute({ name }) {
      await db.prepare('DELETE FROM skills WHERE project_id=? AND name=?').bind(projectId, String(name)).run();
      return `deleted skill "${name}".`;
    },
  });

  return [saveSkill, loadSkill, deleteSkill];
}
