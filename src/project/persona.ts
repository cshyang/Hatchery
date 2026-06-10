// Channel persona — the structured display identity (name + emoji icon) the agent's Slack
// posts appear under. The hatching/rewrite flow sets it via the set_persona tool; the post
// layer reads it for every fresh chat.postMessage. chat.update inherits the identity a
// message was posted with, so the ack→reply edit chain keeps the persona automatically.
// Needs the chat:write.customize scope on the Slack app; src/slack/post.ts degrades to the
// app's default name when the scope is missing.

import { defineTool, Type, type ToolDefinition } from '@flue/runtime';
import type { D1Like } from '../skills/repository';

export interface Persona {
  name: string;
  iconEmoji: string | null;
}

// Slack truncates long usernames; keep names chat-sized.
export const PERSONA_NAME_MAX = 40;
const ICON_EMOJI_RE = /^:[a-z0-9_+'-]+:$/;

export async function loadPersona(db: D1Like, projectId: string): Promise<Persona | null> {
  const row = await db
    .prepare('SELECT name, icon_emoji FROM personas WHERE project_id=?')
    .bind(projectId)
    .first<{ name: string; icon_emoji: string | null }>();
  return row ? { name: row.name, iconEmoji: row.icon_emoji ?? null } : null;
}

export async function setPersona(
  db: D1Like,
  projectId: string,
  input: { name: string; iconEmoji?: string | null },
  updatedBy = 'agent',
): Promise<Persona> {
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('persona requires a non-empty name');
  if (name.length > PERSONA_NAME_MAX) throw new Error(`persona name exceeds ${PERSONA_NAME_MAX} characters`);
  const iconEmoji = input.iconEmoji ? String(input.iconEmoji).trim() : null;
  if (iconEmoji && !ICON_EMOJI_RE.test(iconEmoji)) {
    throw new Error('icon_emoji must be Slack emoji syntax like ":owl:"');
  }
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO personas(project_id, name, icon_emoji, updated_by, created_at, updated_at)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(project_id) DO UPDATE SET
         name=excluded.name,
         icon_emoji=excluded.icon_emoji,
         updated_by=excluded.updated_by,
         updated_at=excluded.updated_at`,
    )
    .bind(projectId, name, iconEmoji, updatedBy, now, now)
    .run();
  return { name, iconEmoji };
}

export function personaTools(db: D1Like | undefined, projectId: string): ToolDefinition[] {
  const store = (): D1Like => {
    if (!db) throw new Error('Persona is unavailable (no DB binding).');
    return db;
  };

  const setPersonaTool = defineTool({
    name: 'set_persona',
    description:
      'Set the display identity your Slack messages appear under (name + emoji avatar). Call this when you ' +
      'hatch, and again whenever the channel renames you — alongside saving your personality skill. People ' +
      'still summon you by @mentioning the app (that handle never changes); this only controls the name and ' +
      'icon shown on your posts.',
    parameters: Type.Object({
      name: Type.String({ description: 'Display name, e.g. "Wren". Short — it appears on every message.' }),
      iconEmoji: Type.Optional(
        Type.String({ description: 'Emoji avatar in Slack syntax, e.g. ":owl:" or ":bird:". Omit to keep the app icon.' }),
      ),
    }),
    async execute({ name, iconEmoji }) {
      const p = await setPersona(store(), projectId, {
        name: String(name),
        iconEmoji: iconEmoji ? String(iconEmoji) : null,
      });
      return `persona set — your posts will appear as "${p.name}"${p.iconEmoji ? ` ${p.iconEmoji}` : ''} from the next turn.`;
    },
  });

  return [setPersonaTool];
}
