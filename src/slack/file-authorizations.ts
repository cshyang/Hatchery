import type { D1Like } from '../skills/repository';

export interface SlackFileAuthorizationInput {
  id: string;
  name?: string | null;
  mimetype?: string | null;
  size?: number | null;
}

export async function recordSlackConversationFiles(
  db: D1Like,
  input: {
    projectId: string;
    conversationId: string;
    files?: SlackFileAuthorizationInput[];
    now?: () => number;
  },
): Promise<void> {
  const files = (input.files ?? []).filter((file) => typeof file.id === 'string' && file.id.trim());
  if (!files.length) return;

  const now = input.now ? input.now() : Date.now();
  for (const file of files) {
    await db
      .prepare(
        `INSERT INTO slack_conversation_files(
           project_id, conversation_id, file_id, name, mimetype, size, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, conversation_id, file_id) DO UPDATE SET
           name=excluded.name,
           mimetype=excluded.mimetype,
           size=excluded.size,
           updated_at=excluded.updated_at`,
      )
      .bind(
        input.projectId,
        input.conversationId,
        file.id.trim(),
        normalizeOptionalText(file.name),
        normalizeOptionalText(file.mimetype),
        normalizeOptionalSize(file.size),
        now,
        now,
      )
      .run();
  }
}

export async function isSlackConversationFileAllowed(
  db: D1Like,
  input: {
    projectId: string;
    conversationId: string;
    fileId: string;
  },
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT file_id
         FROM slack_conversation_files
        WHERE project_id=? AND conversation_id=? AND file_id=?
        LIMIT 1`,
    )
    .bind(input.projectId, input.conversationId, input.fileId)
    .first<{ file_id: string }>();
  return !!row;
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text : null;
}

function normalizeOptionalSize(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}
