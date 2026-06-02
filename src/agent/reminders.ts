// Reminder tools (the "when"). The agent programs the SchedulerDO in the scheduler
// worker via the TICKER service binding. A reminder references a skill by NAME (or
// carries a one-off prompt) — never the skill body, so edits to the skill apply to
// all future scheduled runs (reference, not copy).

import { defineTool, Type, type ToolDefinition } from '@flue/runtime';

type Fetcher = { fetch(request: Request): Promise<Response> };

export function reminderTools(ticker: Fetcher | undefined, token: string, projectId: string): ToolDefinition[] {
  const base = `https://scheduler.internal/internal/projects/${encodeURIComponent(projectId)}/schedules`;
  const call = async (path: string, method: string, body?: unknown): Promise<string> => {
    if (!ticker) throw new Error('Reminders are unavailable (no TICKER binding).');
    const res = await ticker.fetch(
      new Request(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-hatchery-token': token },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
    const text = await res.text();
    if (!res.ok) throw new Error(`scheduler ${method} ${path || '/'} -> ${res.status}: ${text.slice(0, 120)}`);
    return text;
  };

  const setReminder = defineTool({
    name: 'set_reminder',
    description:
      'Schedule future autonomous work for yourself. Give each reminder a stable `id` (reuse to replace, new to add). ' +
      'Pick ONE timing: `cron` (wall-clock in KL/UTC+8, 5 fields, e.g. "0 9 * * *" = 9am daily), `everyMs` (interval), ' +
      '`inMs` (once, after a delay), or `runAt` (once, at an epoch-ms time — use the "now" field to compute it). ' +
      'Point it at work with `skill` (name of one of your saved skills — loaded fresh each run) and/or `prompt` ' +
      '(a one-off instruction). When it fires you get a heartbeat turn carrying that skill/prompt.',
    parameters: Type.Object({
      id: Type.String({ description: 'Stable reminder id, e.g. "daily-digest".' }),
      cron: Type.Optional(Type.String({ description: 'KL-time cron "min hour dom mon dow", e.g. "0 9 * * 1" = Mondays 9am.' })),
      everyMs: Type.Optional(Type.Number({ description: 'Recurring interval in ms.' })),
      inMs: Type.Optional(Type.Number({ description: 'One-shot delay from now, in ms.' })),
      runAt: Type.Optional(Type.Number({ description: 'One-shot absolute epoch-ms time.' })),
      skill: Type.Optional(Type.String({ description: 'Name of a saved skill to run when this fires.' })),
      prompt: Type.Optional(Type.String({ description: 'A one-off instruction for the run (with or instead of a skill).' })),
    }),
    async execute({ id, cron, everyMs, inMs, runAt, skill, prompt }) {
      const out = await call('', 'POST', {
        id,
        kind: 'heartbeat',
        cron,
        everyMs,
        inMs,
        runAt,
        payload: { skill, prompt },
      });
      const parsed = JSON.parse(out) as { id: string; nextRun: number };
      return `reminder "${parsed.id}" set — next run ${new Date(parsed.nextRun).toISOString()} (UTC).`;
    },
  });

  const listReminders = defineTool({
    name: 'list_reminders',
    description: 'List your scheduled reminders (id, timing, next run, paused state).',
    parameters: Type.Object({}),
    async execute() {
      const jobs = JSON.parse(await call('', 'GET')) as Array<Record<string, unknown>>;
      if (!jobs.length) return 'No reminders set.';
      return jobs
        .map((j) => {
          const when = j.cron ? `cron "${j.cron}"` : j.every_ms ? `every ${j.every_ms}ms` : 'once';
          const next = new Date(Number(j.next_run)).toISOString();
          return `• ${j.id} — ${when}, next ${next}${j.enabled ? '' : ' (paused)'}`;
        })
        .join('\n');
    },
  });

  const cancelReminder = defineTool({
    name: 'cancel_reminder',
    description: 'Delete a reminder by id (permanent).',
    parameters: Type.Object({ id: Type.String({ description: 'Reminder id to cancel.' }) }),
    async execute({ id }) {
      await call(`/${encodeURIComponent(String(id))}`, 'DELETE');
      return `cancelled "${id}".`;
    },
  });

  const pauseReminder = defineTool({
    name: 'pause_reminder',
    description: 'Pause a reminder — keeps it but stops it firing, until you resume it.',
    parameters: Type.Object({ id: Type.String({ description: 'Reminder id to pause.' }) }),
    async execute({ id }) {
      await call(`/${encodeURIComponent(String(id))}`, 'PATCH', { enabled: false });
      return `paused "${id}".`;
    },
  });

  const resumeReminder = defineTool({
    name: 'resume_reminder',
    description: 'Resume a paused reminder.',
    parameters: Type.Object({ id: Type.String({ description: 'Reminder id to resume.' }) }),
    async execute({ id }) {
      await call(`/${encodeURIComponent(String(id))}`, 'PATCH', { enabled: true });
      return `resumed "${id}".`;
    },
  });

  return [setReminder, listReminders, cancelReminder, pauseReminder, resumeReminder];
}
