// Tool-call audit log (migration 0028). One row per outbound provider call — the call's SHAPE
// (provider, method, path, outcome, duration), never its payload: bodies carry user content and
// query strings carry search terms, so both stay out of the table. That restraint is what makes
// the log safe to keep forever and cheap to query.
//
// Why it exists: the model's own narration is the one witness you can't trust. The log answers
// "did that call actually fire, and did it succeed?" (debugging), surfaces anomalous call patterns
// (a prompt injection that survives the method fence shows up here), and is the empirical input
// for any future per-endpoint path rules — fences get written from observed traffic, not guessed.
//
// The write is FIRE-AND-FORGET: a dead D1 must never fail a turn, so the recorder swallows errors.
// Read it with: npx wrangler d1 execute hatchery-skills --remote \
//   --command "SELECT * FROM tool_calls ORDER BY created_at DESC LIMIT 50"

import type { D1Like } from '../skills/repository';

export type ToolCallStatus = 'success' | 'http_error' | 'fetch_error' | 'blocked';

export interface ToolCallRecord {
  provider: string;
  method: string;
  /** API path; sanitized (query string stripped) before it is written. */
  path: string;
  status: ToolCallStatus;
  durationMs: number;
}

export type ToolCallRecorder = (record: ToolCallRecord) => void;

/** Strip the query string: the route shape is all forensics needs; queries are user content. */
export function sanitizePath(path: string): string {
  const q = path.indexOf('?');
  return q === -1 ? path : path.slice(0, q);
}

export async function recordToolCall(db: D1Like, projectId: string, record: ToolCallRecord): Promise<void> {
  await db
    .prepare(
      'INSERT INTO tool_calls (project_id, provider, method, path, status, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(projectId, record.provider, record.method, sanitizePath(record.path), record.status, record.durationMs, Date.now())
    .run();
}

/** Recorder bound to one project's D1. Fire-and-forget by design — never throws, never awaited. */
export function toolCallRecorder(db: D1Like, projectId: string): ToolCallRecorder {
  return (record) => {
    void recordToolCall(db, projectId, record).catch(() => {});
  };
}
