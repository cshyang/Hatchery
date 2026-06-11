// Seed the __global__ project's shared skill baseline (inherited by every channel).
//
// Usage:
//   node seeds/seed-global.mjs > /tmp/seed-global.sql
//   npx wrangler d1 execute hatchery-skills --remote --file=/tmp/seed-global.sql
//
// These are the shared baseline every auto-provisioned channel inherits (a channel can override any
// of them by saving its own skill of the same name). Operator/seed-written ONLY — a channel agent
// can never write __global__.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'global');
const projectId = '__global__';
const esc = (s) => s.replace(/'/g, "''");

// Flat baseline skills, plus the soul templates (souls/) that assignSoul copies at provision time.
const files = [
  ...readdirSync(dir).filter((f) => f.endsWith('.md')),
  ...readdirSync(join(dir, 'souls')).map((f) => join('souls', f)),
];

const stmts = files
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((f) => {
    const md = readFileSync(join(dir, f), 'utf8');
    const fm = md.match(/^\s*---\s*\n([\s\S]*?)\n---/)[1];
    const name = fm.match(/^name:\s*(.+)$/m)[1].trim();
    const description = fm.match(/^description:\s*(.+)$/m)[1].trim();
    if (description.length > 1024) throw new Error(`${name}: description exceeds 1024 chars`);
    return `INSERT INTO skills(project_id,name,description,body_md,state,created_by,updated_by,created_at,updated_at,archived_at) VALUES('${esc(projectId)}','${esc(name)}','${esc(description)}','${esc(md)}','active','seed','seed',1780000000000,1780000000000,NULL) ON CONFLICT(project_id,name) DO UPDATE SET description=excluded.description, body_md=excluded.body_md, state='active', updated_by='seed', updated_at=excluded.updated_at, archived_at=NULL;`;
  });

process.stdout.write(stmts.join('\n') + '\n');
