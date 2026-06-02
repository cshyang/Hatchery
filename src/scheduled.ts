import { loadRunnableSkillBody, type D1Like } from './skills';

export interface ScheduledPayload {
  skill?: string;
  prompt?: string;
  topic?: string;
}

export type ScheduledInputResult =
  | { input: Record<string, unknown>; skipped?: undefined }
  | { input?: undefined; skipped: 'nothing to run (skill missing, no prompt/topic)' };

/** Build the input for a scheduled agent turn. A scheduled job may reference a skill by NAME; resolve
 *  it fresh at fire time so edits affect future runs. Archived/missing skill-only jobs are refused
 *  instead of silently running stale or empty automation. */
export async function buildScheduledInput(
  args: {
    db: D1Like | undefined;
    projectId: string;
    kind?: string;
    payload?: ScheduledPayload;
    now: string;
  },
  deps: {
    loadRunnableSkillBody?: typeof loadRunnableSkillBody;
    log?: (message: string) => void;
  } = {},
): Promise<ScheduledInputResult> {
  const { db, projectId, kind, now } = args;
  const payload = args.payload ?? {};
  const input: Record<string, unknown> = { kind: kind ?? 'heartbeat', now };
  const loadSkill = deps.loadRunnableSkillBody ?? loadRunnableSkillBody;
  const log = deps.log ?? console.log;
  let procedure = '';

  if (payload.skill) {
    const resolved = db ? await loadSkill(db, projectId, payload.skill) : ({ status: 'absent' } as const);
    if (resolved.status === 'active') {
      input.skill = payload.skill;
      procedure = resolved.body;
    } else if (resolved.status === 'archived') {
      log(
        `[scheduled] skill "${payload.skill}" is archived for project ${projectId} — refusing stale automation; restore it or repoint the reminder`,
      );
    } else {
      log(`[scheduled] skill "${payload.skill}" not found for project ${projectId}`);
    }
  }

  if (payload.prompt) procedure = procedure ? `${procedure}\n\n${payload.prompt}` : String(payload.prompt);
  if (procedure) input.instructions = procedure;
  else if (payload.topic) input.topic = String(payload.topic);

  if (!input.instructions && !input.topic) {
    return { skipped: 'nothing to run (skill missing, no prompt/topic)' };
  }
  return { input };
}
