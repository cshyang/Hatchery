import { fetchWithTimeout, jsonMessageOrText } from '../providers/http';
import type { D1Like } from '../skills/repository';
import { createAgentRun, updateAgentRun, type AgentRun, type ClockAndIds } from './repository';

const RUNNER_FETCH_TIMEOUT_MS = 12_000;
const WEBHOOK_MAX_AGE_MS = 60_000;
const DEFAULT_RUN_STATE_NAME = 'Run Agent';

export interface LinearAgentProjectConfig {
  projectId: string;
  targetRepo: string;
  baseBranch: string;
  kit: string;
  runtime: string;
  sandboxProvider: string;
  runStateName: string;
}

export interface LinearWebhookRequest {
  db: D1Like | undefined;
  signingSecret: string | undefined;
  signature: string | undefined;
  deliveryId: string | undefined;
  event: string | undefined;
  rawBody: string;
  projectsJson: string | undefined;
  nowMs?: number;
}

export interface LinearWebhookDeps extends ClockAndIds {
  runnerUrl?: string;
  runnerToken?: string;
  hatcheryPublicUrl?: string;
  fetch?: typeof fetch;
}

export interface LinearWebhookResult {
  status: number;
  body?: any;
}

interface LinearIssueSnapshot {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  team: { id: string | null; key: string | null; name: string | null };
  state: { id: string | null; name: string };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyLinearWebhook(signingSecret: string, rawBody: string, signature: string | undefined | null): Promise<boolean> {
  if (!signingSecret || !signature) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(signingSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  return constantTimeEqual(toHex(mac), signature.toLowerCase());
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max = 4096): string {
  const s = String(value ?? '').trim();
  if (!s) throw new Error(`${field} is required`);
  if (s.length > max) throw new Error(`${field} is too long`);
  return s;
}

function optionalText(value: unknown, max = 4096): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > max) throw new Error('text field is too long');
  return s;
}

function normalizeProjectConfig(input: unknown): LinearAgentProjectConfig {
  const cfg = record(input);
  return {
    projectId: text(cfg.projectId, 'projectId', 256),
    targetRepo: text(cfg.targetRepo, 'targetRepo', 512),
    baseBranch: optionalText(cfg.baseBranch, 128) ?? 'main',
    kit: optionalText(cfg.kit, 128) ?? 'coding-default',
    runtime: optionalText(cfg.runtime, 128) ?? 'claude_code',
    sandboxProvider: optionalText(cfg.sandboxProvider, 128) ?? 'e2b',
    runStateName: optionalText(cfg.runStateName, 128) ?? DEFAULT_RUN_STATE_NAME,
  };
}

export function parseLinearAgentProjects(projectsJson: string | undefined): Map<string, LinearAgentProjectConfig> {
  const out = new Map<string, LinearAgentProjectConfig>();
  if (!projectsJson) return out;
  const parsed = record(JSON.parse(projectsJson));
  for (const [key, value] of Object.entries(parsed)) out.set(key, normalizeProjectConfig(value));
  return out;
}

function parsePayload(rawBody: string): Record<string, unknown> {
  return record(JSON.parse(rawBody));
}

function objectField(parent: Record<string, unknown>, field: string): Record<string, unknown> | null {
  const value = parent[field];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stateName(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'object' && !Array.isArray(value)) return optionalText((value as Record<string, unknown>).name, 128);
  return null;
}

function issueSnapshot(data: Record<string, unknown>): LinearIssueSnapshot {
  const team = objectField(data, 'team') ?? {};
  const state = objectField(data, 'state') ?? {};
  return {
    id: text(data.id, 'issue id', 256),
    identifier: text(data.identifier, 'issue identifier', 128),
    title: text(data.title, 'issue title', 512),
    description: optionalText(data.description, 8000),
    url: text(data.url, 'issue url', 2048),
    team: {
      id: optionalText(team.id, 256),
      key: optionalText(team.key, 128),
      name: optionalText(team.name, 256),
    },
    state: {
      id: optionalText(state.id, 256),
      name: text(state.name, 'issue state name', 128),
    },
  };
}

function linearProjectFor(issue: LinearIssueSnapshot, projects: Map<string, LinearAgentProjectConfig>): LinearAgentProjectConfig | null {
  if (issue.team.key && projects.has(issue.team.key)) return projects.get(issue.team.key) ?? null;
  if (issue.team.id && projects.has(issue.team.id)) return projects.get(issue.team.id) ?? null;
  return null;
}

function previousIssueStateName(payload: Record<string, unknown>): string | null {
  const updatedFrom = objectField(payload, 'updatedFrom');
  if (!updatedFrom) return null;
  return stateName(updatedFrom.state);
}

function idempotencyKey(issue: LinearIssueSnapshot, cfg: LinearAgentProjectConfig): string {
  return `linear:issue:${issue.id}:state:${cfg.runStateName}`;
}

function callbackUrl(hatcheryPublicUrl: string | undefined): string | undefined {
  if (!hatcheryPublicUrl) return undefined;
  return `${hatcheryPublicUrl.replace(/\/+$/, '')}/__internal/agent-runs`;
}

function runnerPayload(args: {
  run: AgentRun;
  deliveryId: string;
  issue: LinearIssueSnapshot;
  callback?: string;
}) {
  return {
    runId: args.run.id,
    projectId: args.run.projectId,
    source: { type: 'linear', id: args.deliveryId },
    linearIssue: args.issue,
    targetRepo: args.run.targetRepo,
    baseBranch: args.run.baseBranch,
    kit: args.run.kit,
    runtime: args.run.runtime,
    sandboxProvider: args.run.sandboxProvider,
    callback: {
      ...(args.callback ? { url: args.callback } : { path: '/__internal/agent-runs' }),
      authHeader: 'x-hatchery-agent-runner-token',
    },
  };
}

async function dispatchToRunner(args: {
  runnerUrl: string;
  runnerToken: string;
  payload: unknown;
  fetchImpl?: typeof fetch;
}): Promise<{ sandboxId?: string | null }> {
  const res = await fetchWithTimeout(
    args.runnerUrl,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hatchery-agent-runner-token': args.runnerToken },
      body: JSON.stringify(args.payload),
    },
    {
      timeoutMs: RUNNER_FETCH_TIMEOUT_MS,
      timeoutMessage: `agent runner timed out after ${RUNNER_FETCH_TIMEOUT_MS}ms`,
      failurePrefix: 'agent runner dispatch failed',
      fetchImpl: args.fetchImpl,
    },
  );
  const textBody = await res.text();
  if (!res.ok) throw new Error(`agent runner ${res.status}: ${jsonMessageOrText(textBody, 160)}`);
  try {
    const parsed = JSON.parse(textBody) as { sandboxId?: unknown };
    return { sandboxId: typeof parsed.sandboxId === 'string' ? parsed.sandboxId : null };
  } catch {
    return {};
  }
}

async function dispatchAgentRun(db: D1Like, deliveryId: string, run: AgentRun, issue: LinearIssueSnapshot, deps: LinearWebhookDeps) {
  if (!deps.runnerUrl || !deps.runnerToken) {
    const failed = await updateAgentRun(db, { id: run.id, status: 'failed', error: 'agent runner is not configured' }, deps);
    return { run: failed, dispatchStatus: 'failed', dispatchError: 'agent runner is not configured' };
  }

  const dispatching = await updateAgentRun(db, { id: run.id, status: 'dispatching' }, deps);
  const payload = runnerPayload({ run: dispatching, deliveryId, issue, callback: callbackUrl(deps.hatcheryPublicUrl) });
  try {
    const result = await dispatchToRunner({ runnerUrl: deps.runnerUrl, runnerToken: deps.runnerToken, payload, fetchImpl: deps.fetch });
    const updated = await updateAgentRun(db, { id: run.id, status: 'running', sandboxId: result.sandboxId }, deps);
    return { run: updated, dispatchStatus: 'dispatched' };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'agent runner dispatch failed';
    const failed = await updateAgentRun(db, { id: run.id, status: 'failed', error: message }, deps);
    return { run: failed, dispatchStatus: 'failed', dispatchError: message };
  }
}

export async function handleLinearWebhook(req: LinearWebhookRequest, deps: LinearWebhookDeps): Promise<LinearWebhookResult> {
  if (!(await verifyLinearWebhook(req.signingSecret ?? '', req.rawBody, req.signature))) return { status: 404 };
  if (!req.db) return { status: 500, body: { error: 'no DB binding' } };
  if (!req.deliveryId) return { status: 400, body: { error: 'Linear-Delivery is required' } };
  if (req.event !== 'Issue') return { status: 200, body: { skipped: 'not an Issue event' } };

  try {
    const payload = parsePayload(req.rawBody);
    const timestamp = Number(payload.webhookTimestamp);
    if (!Number.isFinite(timestamp) || Math.abs((req.nowMs ?? Date.now()) - timestamp) > WEBHOOK_MAX_AGE_MS) {
      return { status: 400, body: { error: 'stale Linear webhook' } };
    }
    if (payload.action !== 'update' || payload.type !== 'Issue') return { status: 200, body: { skipped: 'not an Issue update' } };

    const data = objectField(payload, 'data');
    if (!data) return { status: 400, body: { error: 'Issue data is required' } };
    const issue = issueSnapshot(data);
    const projects = parseLinearAgentProjects(req.projectsJson);
    const cfg = linearProjectFor(issue, projects);
    if (!cfg) return { status: 200, body: { skipped: 'no Linear agent project config' } };

    const prevStateName = previousIssueStateName(payload);
    if (issue.state.name !== cfg.runStateName || !prevStateName || prevStateName === cfg.runStateName) {
      return { status: 200, body: { skipped: 'not a Run Agent transition' } };
    }

    const created = await createAgentRun(
      req.db,
      {
        projectId: cfg.projectId,
        sourceType: 'linear',
        sourceId: req.deliveryId,
        idempotencyKey: idempotencyKey(issue, cfg),
        linearIssueId: issue.id,
        linearIdentifier: issue.identifier,
        linearUrl: issue.url,
        targetRepo: cfg.targetRepo,
        baseBranch: cfg.baseBranch,
        kit: cfg.kit,
        runtime: cfg.runtime,
        sandboxProvider: cfg.sandboxProvider,
      },
      deps,
    );
    if (created.duplicate) {
      return { status: 200, body: { run: created.run, duplicate: true, dispatchStatus: 'deduped' } };
    }

    const dispatched = await dispatchAgentRun(req.db, req.deliveryId, created.run, issue, deps);
    return { status: 200, body: { ...dispatched, duplicate: false } };
  } catch (e) {
    return { status: 400, body: { error: e instanceof Error ? e.message : 'bad request' } };
  }
}
