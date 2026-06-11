// Worker-level Cloudflare exports, separate from agent modules. Named exports become
// top-level Worker exports — this is how the Sandbox DO class reaches the Worker on
// Flue 0.11+ (replaces the ≤0.9.1 "class_name ends with Sandbox" auto-wiring).
//
// The default export hosts the cron clock the external ticker worker used to provide
// (0.9.1's generated entry dropped `scheduled`; 0.11 forwards it). Each cron calls the
// existing token-guarded internal routes IN-PROCESS via app.fetch — same routes, same
// guards, same KV dedupe, minus the second worker and the HTTP hop.

import type { D1Like } from '../src/skills/repository';
import { takeDueReminders } from '../src/gateway/reminders-store';
import app from './app';

export { Sandbox } from '@cloudflare/sandbox';

export const HEARTBEAT_CRON = '0 */6 * * *'; // liveness backstop, fans out to active projects
export const REFLECT_CRON = '0 19 * * *'; // nightly REM at 03:00 KL (UTC+8, crons are UTC)
export const RECONCILE_CRON = '*/2 * * * *'; // agent-run outbox backstop
export const REMINDERS_CRON = '* * * * *'; // due-scan for agent-set reminders (minute precision)

interface ScheduledEnv {
  HEARTBEAT_TOKEN?: string;
  DB?: D1Like;
  [binding: string]: unknown;
}

// The scheduled() controller context — structurally a subset of ExecutionContext;
// Hono's app.fetch only ever calls waitUntil, so the cast below is safe.
type ExecutionCtx = { waitUntil(p: Promise<unknown>): void };

// Call one of our own internal routes without leaving the Worker. The URL host is
// irrelevant (never resolved); the token guard in the route still applies.
async function callInternal(env: ScheduledEnv, ctx: ExecutionCtx, path: string, body: unknown): Promise<void> {
  const res = await app.fetch(
    new Request(`https://hatchery.internal${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hatchery-token': env.HEARTBEAT_TOKEN ?? '' },
      body: JSON.stringify(body ?? {}),
    }),
    env,
    ctx as Parameters<typeof app.fetch>[2],
  );
  const text = (await res.text()).slice(0, 160);
  console.log(`[cron] ${path} -> HTTP ${res.status}: ${text}`);
}

async function scanReminders(env: ScheduledEnv, ctx: ExecutionCtx): Promise<void> {
  if (!env.DB) return;
  const due = await takeDueReminders(env.DB);
  for (const job of due) {
    // Same body shape the SchedulerDO used to POST; the route's KV fireId claim and
    // active-binding gate are unchanged.
    await callInternal(env, ctx, '/__internal/scheduled', job);
  }
}

export default {
  async scheduled(controller: { cron?: string }, env: ScheduledEnv, ctx: ExecutionCtx): Promise<void> {
    const job =
      controller.cron === REMINDERS_CRON
        ? scanReminders(env, ctx)
        : controller.cron === RECONCILE_CRON
          ? Promise.all([
              callInternal(env, ctx, '/__internal/agent-runs/reconcile', {}),
              // Layer 4 rides the same 2-min tick: the review-sweep gate is one cheap SQL query,
              // so sharing the reconcile cadence costs nothing on quiet channels.
              callInternal(env, ctx, '/__internal/review-sweep', {}),
            ]).then(() => undefined)
          : controller.cron === REFLECT_CRON
            ? callInternal(env, ctx, '/__internal/reflect-sweep', {})
            : callInternal(env, ctx, '/__heartbeat', {});
    ctx.waitUntil(job.catch((e) => console.log(`[cron] ${controller.cron} failed: ${e instanceof Error ? e.message : String(e)}`)));
  },
};
