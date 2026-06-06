// Scratch M0a probe (NOT committed). Proves the Trigger integration end-to-end:
//   REST trigger  →  run-coding-task executes (in `trigger.dev dev`)  →  it calls back  →  we catch it.
// Requires `npm run trigger:dev` running in another terminal (registers the task in the dev env).
// Run: npx tsx verify-m0a.ts
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import * as v from 'valibot';
import { RunnerDispatchSchema, RUNNER_CONTRACT_VERSION } from './src/agent-runs/runner-contract';

const PORT = 9991;
const TRIGGER_API = 'https://api.trigger.dev';

// Pull the dev key from .dev.vars (don't hardcode secrets).
const secret = readFileSync('.dev.vars', 'utf8')
  .split('\n')
  .find((l) => l.startsWith('TRIGGER_SECRET_KEY='))
  ?.split('=')[1]
  ?.trim();
if (!secret) throw new Error('TRIGGER_SECRET_KEY not found in .dev.vars');

const runId = `verify-${Date.now()}`;
const token = 'verify-callback-token';

// A valid RunnerDispatch (initial mode). Self-validate before sending so a probe bug != a pipe bug.
const dispatch = v.parse(RunnerDispatchSchema, {
  contractVersion: RUNNER_CONTRACT_VERSION,
  runId,
  projectId: 'verify-project',
  mode: 'initial',
  targetRepo: 'https://github.com/o/r',
  baseBranch: 'main',
  targetBranch: null,
  kit: 'coding-default',
  runtime: 'pi',
  sandboxProvider: 'local',
  issue: { id: 'i1', identifier: 'ENG-1', url: 'https://linear.app/x', title: 'probe', description: null },
  feedback: null,
  prUrl: null,
  replyTarget: null,
  githubToken: 'placeholder-pat',
  callback: { url: `http://localhost:${PORT}/cb`, token },
});

const seen = new Set<string>();
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const auth = req.headers['x-hatchery-agent-runner-token'];
    let body: any = {};
    try { body = JSON.parse(raw); } catch {}
    console.log(`← callback: status=${body.status} runId=${body.runId} auth=${auth === token ? 'ok' : 'MISMATCH'}${body.summary ? ` summary="${body.summary}"` : ''}`);
    if (body.runId === runId && typeof body.status === 'string') seen.add(body.status);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
    if (seen.has('running') && seen.has('completed')) {
      console.log('\n✅ PASS — full pipe: dispatch → task ran → running + completed callbacks received with matching runId.');
      server.close();
      process.exit(0);
    }
  });
});

server.listen(PORT, async () => {
  console.log(`listening for callbacks on http://localhost:${PORT}/cb`);
  console.log(`→ triggering run-coding-task (idempotencyKey=${runId}) ...`);
  let res: Response;
  try {
    res = await fetch(`${TRIGGER_API}/api/v1/tasks/run-coding-task/trigger`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ payload: dispatch, options: { idempotencyKey: runId } }),
    });
  } catch (e) {
    console.error(`✖ trigger request failed (network): ${e}`);
    process.exit(1);
  }
  const text = await res.text();
  if (!res.ok) {
    console.error(`✖ trigger returned ${res.status}: ${text.slice(0, 300)}`);
    console.error('   (404/"task not found" → is `npm run trigger:dev` running and the task registered?)');
    process.exit(1);
  }
  let id: unknown;
  try { id = JSON.parse(text).id; } catch {}
  console.log(`→ triggered ok. Trigger run id (would persist as trigger_run_id): ${id}`);
  console.log('  waiting for callbacks (≤90s) ...');
});

setTimeout(() => {
  console.error(`\n✖ TIMEOUT — saw statuses [${[...seen].join(', ') || 'none'}]. Task didn't call back. Check the trigger:dev terminal for errors/exceptions.`);
  process.exit(1);
}, 90_000);
