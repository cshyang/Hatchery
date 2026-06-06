import { task } from '@trigger.dev/sdk';
import * as v from 'valibot';
import { RunnerDispatchSchema, RUNNER_CONTRACT_VERSION, type RunnerCallback } from '../src/agent-runs/runner-contract';

async function callback(d: { callback: { url: string; token: string } }, body: RunnerCallback) {
  await fetch(d.callback.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hatchery-agent-runner-token': d.callback.token },
    body: JSON.stringify(body),
  });
}

export const runCodingTask = task({
  id: 'run-coding-task',
  maxDuration: 2700, // matches the config default; a maxDuration kill skips cleanup — Hatchery's reaper closes the run.
  run: async (raw) => {
    const d = v.parse(RunnerDispatchSchema, raw);                 // consumer↔contract assertion
    await callback(d, { contractVersion: RUNNER_CONTRACT_VERSION, runId: d.runId, status: 'running' });
    // M0a: prove the pipe only — no pi/coding yet (that's M0b).
    await callback(d, { contractVersion: RUNNER_CONTRACT_VERSION, runId: d.runId, status: 'completed', summary: 'pipe ok (no pi yet)' });
    return { ok: true };
  },
});
