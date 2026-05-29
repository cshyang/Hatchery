// Hatchery heartbeat ticker. On each cron tick, call Hatchery's /__heartbeat,
// which wakes the project agent(s) to do autonomous content work. This is the
// external "clock" — Flue's generated Worker entry forwards only `fetch`, so a
// Flue app can't host a `scheduled()` handler itself.
//
// Worker→Worker on the same account is blocked over the public workers.dev URL
// (CF error 1042), so we reach Hatchery via a SERVICE BINDING (env.HATCHERY),
// which invokes its fetch handler directly — private and fast.

interface Env {
  HATCHERY: { fetch(request: Request): Promise<Response> };
  HEARTBEAT_TOKEN: string;
}

async function tick(env: Env): Promise<string> {
  // Host is irrelevant over a service binding — only the path routes. Token still
  // sent so the same /__heartbeat guard works for the public path too.
  const res = await env.HATCHERY.fetch(
    new Request('https://hatchery.internal/__heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hatchery-token': env.HEARTBEAT_TOKEN },
      body: '{}', // v1: default topic on the Hatchery side. Later: per-project topic/cadence.
    }),
  );
  const body = (await res.text()).slice(0, 160);
  console.log(`[ticker] heartbeat -> HTTP ${res.status}: ${body}`);
  return `HTTP ${res.status}: ${body}`;
}

export default {
  // Cron-driven: the production entry point.
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    ctx.waitUntil(tick(env));
  },
  // Liveness + a token-guarded manual trigger (POST /run) to fire a tick on demand.
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/run') {
      if (req.headers.get('x-hatchery-token') !== env.HEARTBEAT_TOKEN) {
        return new Response('not found', { status: 404 });
      }
      return new Response(`ticked -> ${await tick(env)}\n`);
    }
    return new Response('hatchery-ticker: alive (cron-driven)\n');
  },
};
