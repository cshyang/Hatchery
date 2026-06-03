// Hatchery scheduler worker (deploy name: hatchery-ticker).
//
// Two responsibilities:
//   1. SchedulerDO — the durable per-project alarm the agent programs via its
//      `schedule_self` tool. This is the "agent schedules its own work" engine.
//      Flue can't host an alarm (it abstracts the DO away), so it lives here in a
//      plain Worker. See ./scheduler.ts.
//   2. Cron backstop — a fixed-cadence heartbeat-of-last-resort. If a turn crashes
//      before re-arming its schedule, the project would otherwise go dark forever;
//      this keeps a baseline beat. (Flue's generated entry forwards only `fetch`,
//      so the cron can't live in Hatchery itself.)
//
// Worker→Worker on the same account is blocked over the public workers.dev URL
// (CF error 1042), so we reach Hatchery via a SERVICE BINDING (env.HATCHERY).

import { SchedulerDO } from './scheduler';

export { SchedulerDO };

interface Env {
  HATCHERY: { fetch(request: Request): Promise<Response> };
  SCHEDULER: DurableObjectNamespace<SchedulerDO>;
  HEARTBEAT_TOKEN: string;
}

// Cron backstop: fire the default heartbeat across active projects. Separate path
// from the SchedulerDO's per-job fires — this is the safety net, not the engine.
async function tick(env: Env): Promise<string> {
  const res = await env.HATCHERY.fetch(
    new Request('https://hatchery.internal/__heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hatchery-token': env.HEARTBEAT_TOKEN },
      body: '{}',
    }),
  );
  const body = (await res.text()).slice(0, 160);
  console.log(`[ticker] backstop heartbeat -> HTTP ${res.status}: ${body}`);
  return `HTTP ${res.status}: ${body}`;
}

// Nightly REM: poke Hatchery's reflection sweep. Hatchery's gate (cheap SQL) decides which
// projects actually have new messages to consolidate, so this is safe to fire unconditionally.
async function reflectSweep(env: Env): Promise<string> {
  const res = await env.HATCHERY.fetch(
    new Request('https://hatchery.internal/__internal/reflect-sweep', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hatchery-token': env.HEARTBEAT_TOKEN },
      body: '{}',
    }),
  );
  const body = (await res.text()).slice(0, 160);
  console.log(`[ticker] nightly reflect-sweep -> HTTP ${res.status}: ${body}`);
  return `HTTP ${res.status}: ${body}`;
}

// Frequent backstop for the agent-run outbox: dispatch queued runs, reclaim runs stuck mid-dispatch,
// and time out runners that went dark. Hatchery's gate (cheap SQL) decides what actually needs work,
// so this is safe to fire unconditionally.
async function reconcileRuns(env: Env): Promise<string> {
  const res = await env.HATCHERY.fetch(
    new Request('https://hatchery.internal/__internal/agent-runs/reconcile', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hatchery-token': env.HEARTBEAT_TOKEN },
      body: '{}',
    }),
  );
  const body = (await res.text()).slice(0, 160);
  console.log(`[ticker] agent-run reconcile -> HTTP ${res.status}: ${body}`);
  return `HTTP ${res.status}: ${body}`;
}

const REFLECT_CRON = '0 19 * * *'; // 03:00 KL
const RECONCILE_CRON = '*/2 * * * *'; // agent-run outbox backstop

function unauthorized(req: Request, env: Env): boolean {
  return req.headers.get('x-hatchery-token') !== env.HEARTBEAT_TOKEN;
}

// Agent-facing schedule API, routed to the per-project SchedulerDO. Reached from
// Hatchery's `schedule_self` tool over the TICKER service binding. Publicly
// addressable (this worker has a workers.dev URL), so token-guard every route.
//   POST   /internal/projects/:projectId/schedules        -> enqueue (add/replace)
//   GET    /internal/projects/:projectId/schedules        -> list
//   DELETE /internal/projects/:projectId/schedules/:jobId  -> cancel
//   PATCH  /internal/projects/:projectId/schedules/:jobId  -> pause/resume (body {enabled})
const SCHEDULE_ROUTE = /^\/internal\/projects\/([^/]+)\/schedules(?:\/([^/]+))?$/;

export default {
  async scheduled(event: { cron?: string }, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    const job = event.cron === RECONCILE_CRON ? reconcileRuns : event.cron === REFLECT_CRON ? reflectSweep : tick;
    ctx.waitUntil(job(env));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    const m = url.pathname.match(SCHEDULE_ROUTE);
    if (m) {
      if (unauthorized(req, env)) return new Response('not found', { status: 404 });
      const projectId = decodeURIComponent(m[1]);
      const jobId = m[2] ? decodeURIComponent(m[2]) : undefined;
      const scheduler = env.SCHEDULER.getByName(projectId);

      if (req.method === 'POST' && !jobId) {
        const args = (await req.json()) as Parameters<SchedulerDO['enqueue']>[1];
        return Response.json(await scheduler.enqueue(projectId, args));
      }
      if (req.method === 'GET' && !jobId) {
        return Response.json(await scheduler.list());
      }
      if (req.method === 'DELETE' && jobId) {
        return Response.json(await scheduler.cancel(jobId));
      }
      // Pause / resume: PATCH .../schedules/:jobId  body { enabled: boolean }
      if (req.method === 'PATCH' && jobId) {
        const { enabled } = (await req.json()) as { enabled?: boolean };
        return Response.json(await scheduler.setEnabled(jobId, enabled !== false));
      }
      return new Response('method not allowed', { status: 405 });
    }

    // Token-guarded manual trigger of the cron backstop, for on-demand testing.
    if (req.method === 'POST' && url.pathname === '/run') {
      if (unauthorized(req, env)) return new Response('not found', { status: 404 });
      return new Response(`ticked -> ${await tick(env)}\n`);
    }

    return new Response('hatchery-scheduler: alive\n');
  },
};
