// Seed a project's skill catalog with the starter set (general + overwritable).
//
// Usage:
//   node seeds/seed.mjs [projectId] > /tmp/seed.sql      # default projectId = "demo"
//   npx wrangler d1 execute hatchery-skills --remote --file=/tmp/seed.sql
//
// These seeds describe FUNCTION and writing quality only — never a fixed purpose. The
// agent can edit or delete any of them (save_skill / delete_skill). `personality` is
// intentionally NOT seeded: empty = a general default; the user/agent sets it later.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const projectId = process.argv[2] || 'demo';
const esc = (s) => s.replace(/'/g, "''"); // SQL single-quote escaping

const stmts = readdirSync(dir)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((f) => {
    const md = readFileSync(join(dir, f), 'utf8');
    const fm = md.match(/^\s*---\s*\n([\s\S]*?)\n---/)[1];
    const name = fm.match(/^name:\s*(.+)$/m)[1].trim();
    const description = fm.match(/^description:\s*(.+)$/m)[1].trim();
    if (description.length > 1024) throw new Error(`${name}: description exceeds 1024 chars`);
    // created_by='seed' marks these as platform-shipped starters (vs 'agent' for self-authored);
    // state='active' + archived_at=NULL so a re-seed also reactivates anything the agent archived.
    return `INSERT INTO skills(project_id,name,description,body_md,state,created_by,updated_by,created_at,updated_at,archived_at) VALUES('${esc(projectId)}','${esc(name)}','${esc(description)}','${esc(md)}','active','seed','seed',1780000000000,1780000000000,NULL) ON CONFLICT(project_id,name) DO UPDATE SET description=excluded.description, body_md=excluded.body_md, state='active', updated_by='seed', updated_at=excluded.updated_at, archived_at=NULL;`;
  });

process.stdout.write(stmts.join('\n') + '\n');
