import * as v from 'valibot';

export const RUNNER_CONTRACT_VERSION = 1 as const;

export const RunnerDispatchSchema = v.object({
  contractVersion: v.literal(RUNNER_CONTRACT_VERSION),
  runId: v.pipe(v.string(), v.minLength(1)),
  projectId: v.pipe(v.string(), v.minLength(1)),
  mode: v.picklist(['initial', 'continuation']),
  targetRepo: v.pipe(v.string(), v.minLength(1)),     // https://github.com/owner/repo
  baseBranch: v.pipe(v.string(), v.minLength(1)),
  targetBranch: v.nullable(v.pipe(v.string(), v.minLength(1))), // null = initial; PR branch = continuation
  kit: v.pipe(v.string(), v.minLength(1)),
  runtime: v.literal('pi'),
  sandboxProvider: v.picklist(['local', 'e2b']),
  workspacePolicy: v.optional(v.picklist(['fresh', 'reuse_if_head_matches']), 'fresh'),
  issue: v.nullable(v.object({ id: v.string(), identifier: v.string(), url: v.string(), title: v.string(), description: v.nullable(v.string()) })),
  feedback: v.nullable(v.string()),                    // the human comment (continuation)
  prUrl: v.nullable(v.string()),
  replyTarget: v.nullable(v.object({ surface: v.picklist(['linear', 'github']), ref: v.string() })),
  githubToken: v.pipe(v.string(), v.minLength(1)),     // short-lived, repo-scoped
  callback: v.object({ url: v.pipe(v.string(), v.url()), token: v.pipe(v.string(), v.minLength(1)) }),
});
export type RunnerDispatch = v.InferOutput<typeof RunnerDispatchSchema>;

// Mirrors the EXISTING handleAgentRunCallback body (running/pr_opened/completed/failed subset).
export const RunnerCallbackSchema = v.object({
  contractVersion: v.literal(RUNNER_CONTRACT_VERSION),
  runId: v.pipe(v.string(), v.minLength(1)),
  status: v.picklist(['running', 'pr_opened', 'completed', 'failed']),
  branch: v.optional(v.nullable(v.string())),
  commitSha: v.optional(v.nullable(v.string())),
  prUrl: v.optional(v.nullable(v.string())),
  summary: v.optional(v.nullable(v.string())),
  error: v.optional(v.nullable(v.string())),
});
export type RunnerCallback = v.InferOutput<typeof RunnerCallbackSchema>;
