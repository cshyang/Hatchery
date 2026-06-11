// Souls — pre-authored personas assigned at provision time. The __global__ project seeds a
// flock of `soul-*` skills (seeds/global/souls/), each a complete personality: voice, quirks,
// a first-meeting note, and the SPINE baked in verbatim at authoring time. When a channel is
// bound (or first speaks while still unhatched), assignSoul rolls a random soul, picks a free
// display name, and writes BOTH halves of the channel's identity in one go:
//   - the channel's `personality` skill (copied soul body, PERSONA line set to the display name)
//   - the `personas` row (display name + DiceBear avatar) the Slack post layer renders
// Idempotent and failure-isolated: a channel with any existing identity is left alone, and a
// missing soul seed degrades to the old LLM hatching path rather than erroring.

import { GLOBAL_PROJECT_ID, MAX_PERSONALITY_BODY, skillBody, type D1Like } from '../skills/repository';
import { setPersona } from './persona';

export const SOUL_NAME_PREFIX = 'soul-';

// Distinct face for free: the avatar is seeded with the DISPLAY name, so "Wren" and "Wrenna"
// in two channels get different portraits without hosting anything.
export function soulAvatarUrl(displayName: string): string {
  return `https://api.dicebear.com/9.x/thumbs/png?seed=${encodeURIComponent(displayName)}`;
}

/** The base persona name is the body's `PERSONA: <name>` line — single source of truth. */
export function soulBaseName(md: string): string | null {
  const m = skillBody(md).match(/^PERSONA:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

/** Optional `aliases: Wrenna, Ren` frontmatter line — fallback display names on collision. */
export function soulAliases(md: string): string[] {
  const fence = md.match(/^\s*---\s*\n([\s\S]*?)\n---/);
  const line = fence?.[1].match(/^aliases:\s*(.+)$/m);
  if (!line) return [];
  return line[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const ROMAN = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/** Base name → first free alias → "Wren II"… Distinct names keep shared sidebars unambiguous. */
export function pickDisplayName(base: string, aliases: string[], taken: ReadonlySet<string>): string {
  for (const candidate of [base, ...aliases]) if (!taken.has(candidate)) return candidate;
  for (const numeral of ROMAN) if (!taken.has(`${base} ${numeral}`)) return `${base} ${numeral}`;
  return base; // 11+ duplicates: collisions are cosmetic, stop inventing names
}

export interface AssignedSoul {
  soul: string; // the soul skill's name, e.g. "soul-wren"
  displayName: string;
}

export interface AssignSoulDeps {
  /** Injectable randomness for tests; defaults to Math.random. */
  random?: () => number;
  log?: (message: string) => void;
}

/** Give an identity-less channel a random pre-authored soul. No-op (null) when the channel
 *  already has ANY identity — its own `personality` skill row (even archived: that was a
 *  deliberate channel act) or a `personas` row — or when no souls are seeded. Never throws
 *  on bad soul data; callers still wrap it so a D1 failure can't block binding creation. */
export async function assignSoul(db: D1Like, projectId: string, deps: AssignSoulDeps = {}): Promise<AssignedSoul | null> {
  if (projectId === GLOBAL_PROJECT_ID) return null;
  const random = deps.random ?? Math.random;
  const log = deps.log ?? console.log;

  const hasPersonality = await db
    .prepare('SELECT 1 AS x FROM skills WHERE project_id=? AND name=?')
    .bind(projectId, 'personality')
    .first<{ x: number }>();
  if (hasPersonality) return null;
  const hasPersona = await db.prepare('SELECT name FROM personas WHERE project_id=?').bind(projectId).first<{ name: string }>();
  if (hasPersona) return null;

  const { results: souls } = await db
    .prepare("SELECT name, body_md FROM skills WHERE project_id=? AND name LIKE 'soul-%' AND state='active'")
    .bind(GLOBAL_PROJECT_ID)
    .all<{ name: string; body_md: string }>();
  if (!souls?.length) {
    log(`[souls] no soul-* seeds in __global__; ${projectId} stays on the LLM hatching fallback`);
    return null;
  }

  const pick = souls[Math.min(Math.floor(random() * souls.length), souls.length - 1)];
  const base = soulBaseName(pick.body_md);
  if (!base) {
    log(`[souls] ${pick.name} has no "PERSONA:" line; skipping assignment for ${projectId}`);
    return null;
  }

  const { results: personaRows } = await db.prepare('SELECT name FROM personas').bind().all<{ name: string }>();
  const taken = new Set((personaRows ?? []).map((r) => r.name));
  const displayName = pickDisplayName(base, soulAliases(pick.body_md), taken);

  const body = skillBody(pick.body_md).replace(/^PERSONA:\s*.+$/m, `PERSONA: ${displayName}`);
  const md = `---\nname: personality\ndescription: Use always — identity, voice, and judgment. This channel's soul: ${displayName}.\n---\n\n${body}\n`;
  if (md.length > MAX_PERSONALITY_BODY) {
    log(`[souls] ${pick.name} exceeds the personality cap (${md.length} > ${MAX_PERSONALITY_BODY}); skipping`);
    return null;
  }

  const now = Date.now();
  // ON CONFLICT DO NOTHING: two racing first-turns assign exactly one identity.
  await db
    .prepare(
      `INSERT INTO skills(project_id, name, description, body_md, state, created_by, updated_by, created_at, updated_at, archived_at)
       VALUES(?,?,?,?,'active','system','system',?,?,NULL)
       ON CONFLICT(project_id, name) DO NOTHING`,
    )
    .bind(projectId, 'personality', `Use always — identity, voice, and judgment. This channel's soul: ${displayName}.`, md, now, now)
    .run();
  await setPersona(db, projectId, { name: displayName, iconUrl: soulAvatarUrl(displayName) }, 'system');

  log(`[souls] assigned ${pick.name} to ${projectId} as "${displayName}"`);
  return { soul: pick.name, displayName };
}
