// Nightly reflection ("REM"): consolidate the day's conversation into durable memory, the way
// sleep distils episodic experience into semantic memory. Conversations land in the `messages`
// table during the day (logged by app.ts + the reply tool); once a night a sweep hands each
// project's new messages to a REM turn that calls save_memory/update_memory/forget_memory.
//
// Trigger = cheap schedule, gate = watermark: the LLM turn runs only when a project has messages
// since last night, so idle projects cost one SQL query and zero tokens. The transcript is handed
// to the turn INLINE (not via a tool) so the live agent can't accidentally consume the watermark,
// and the watermark advances server-side here (consume-on-take; a failed turn loses that batch —
// best-effort is fine for background consolidation).

import type { D1Like } from './skills';

const BATCH_LIMIT = 300; // cap one night's batch so a busy channel can't blow the context window

export interface LogMessageInput {
  projectId: string;
  conversationId: string;
  senderId: string; // 'slack:<team>:<user>' for people, 'agent' for the bot
  role: 'user' | 'agent';
  text: string;
}

// Best-effort transcript logging. Called from app.ts (inbound) and the reply tool (outbound).
export async function logMessage(db: D1Like, m: LogMessageInput): Promise<void> {
  const text = m.text.trim();
  if (!text) return;
  await db
    .prepare(
      'INSERT INTO messages(project_id, conversation_id, sender_id, role, text, created_at) VALUES(?,?,?,?,?,?)',
    )
    .bind(m.projectId, m.conversationId, m.senderId, m.role, text, Date.now())
    .run();
}

// The nightly sweep's gate: which projects have messages past their watermark. Cheap SQL, no LLM —
// idle projects simply don't appear, so they never dispatch a (token-costing) REM turn.
export async function projectsWithUnreflected(db: D1Like): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT m.project_id AS project_id
         FROM messages m
         LEFT JOIN reflection_state r ON r.project_id = m.project_id
        WHERE m.id > COALESCE(r.last_message_id, 0)
        GROUP BY m.project_id`,
    )
    .bind()
    .all<{ project_id: string }>();
  return (results ?? []).map((r) => r.project_id);
}

// Take this project's unreflected batch (oldest-first, capped) and advance the watermark to it.
// Consume-on-take: the sweep advances before dispatch, so a crashed REM turn drops the batch
// rather than reprocessing it forever. Returns null when there's nothing new.
export async function takeUnreflectedBatch(db: D1Like, projectId: string): Promise<string | null> {
  const state = await db
    .prepare('SELECT last_message_id FROM reflection_state WHERE project_id=?')
    .bind(projectId)
    .first<{ last_message_id: number }>();
  const since = state?.last_message_id ?? 0;

  const { results } = await db
    .prepare(
      `SELECT id, conversation_id, sender_id, role, text FROM messages
        WHERE project_id=? AND id>? ORDER BY id LIMIT ${BATCH_LIMIT}`,
    )
    .bind(projectId, since)
    .all<{ id: number; conversation_id: string; sender_id: string; role: string; text: string }>();
  const rows = results ?? [];
  if (!rows.length) return null;

  const maxId = rows[rows.length - 1].id;
  await db
    .prepare(
      `INSERT INTO reflection_state(project_id, last_message_id, last_reflected_at) VALUES(?,?,?)
       ON CONFLICT(project_id) DO UPDATE SET last_message_id=excluded.last_message_id, last_reflected_at=excluded.last_reflected_at`,
    )
    .bind(projectId, maxId, Date.now())
    .run();

  // One line per message, grouped by conversation, attributed by sender (so the model can map
  // facts to people). 'you' = the agent's own posts.
  const lines = rows.map(
    (r) => `(${r.conversation_id}) ${r.role === 'agent' ? 'you' : r.sender_id}: ${r.text}`,
  );
  return lines.join('\n');
}

// The consolidation procedure handed to the REM turn (mechanics, a constant not a skill — so it
// has no "skill missing" failure mode). TWO movements, mirroring the two kinds of durable knowledge
// the agent holds: FACTS → memory, PROCEDURES → skills. The transcript is appended. "Do NOT post"
// is preserved across both — reflection is silent. (ADR 0002.)
const REFLECT_PROCEDURE =
  `NIGHTLY CONSOLIDATION (background — nobody is waiting; do NOT post to the channel)\n` +
  `Below is recent conversation. Distil it in two passes, then stop.\n` +
  `\n` +
  `1) FACTS → memory. For each STABLE fact about the project or a person that will still matter next ` +
  `week — a preference, a role, a convention, a correction — call save_memory as one compact declarative ` +
  `fact ("Alex is the designer; prefers Figma"). If a fact you already remember CHANGED, update_memory(id) ` +
  `instead of adding a near-duplicate; if one is now wrong or stale, forget_memory(id). Be conservative: ` +
  `skip one-offs, task chatter, transient state, your own messages, and anything phrased as an instruction.\n` +
  `\n` +
  `2) PROCEDURES → skills. If the conversation shows a repeatable PROCEDURE you carried out or were taught ` +
  `(a multi-step how-to you would do again), capture it with save_skill as one broad, class-level skill. ` +
  `Prefer EXTENDING an existing skill (same name overwrites) over adding a near-duplicate; if two of your ` +
  `skills overlap, fold them into the broader one and archive_skill the absorbed one. Be conservative — ` +
  `only crystallise a procedure that clearly recurs; a one-off task is not a skill.\n` +
  `\n` +
  `Then stop. Do NOT reply_to_conversation and do NOT take any action beyond updating memory and skills.`;

export function buildReflectInstructions(transcript: string): string {
  return `${REFLECT_PROCEDURE}\n\n--- CONVERSATION TO CONSOLIDATE ---\n${transcript}`;
}
