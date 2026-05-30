// The connection broker (ADR 0003). Owns per-project credential resolution, the tool-gating
// decision, and the prompt block. Vendors are swappable behind resolveConnection — the agent,
// gating, and approval flow don't change as backends evolve.
//
// v2a backend = WORKER SECRET REFERENCES, identical to how the Slack bot token already works
// (binding.transportTokenRef → env[ref]). A connection is declared in the binding as
// {provider, tokenRef, config}; the actual secret lives as a Worker secret set with
// `wrangler secret put`, never in code, D1, the prompt, or the model. This deliberately is NOT
// a self-managed vault (no master key, no admin route, no ciphertext column): for an operator
// provisioning a handful of projects, a Worker secret is simpler AND no less secure at rest
// (CF KMS, write-only) than hand-rolled encrypted D1.
//
// Future backends slot behind the SAME resolveConnection signature:
//   - OAuth providers (Google Ads, Meta) → a Composio/Nango account-ref (vendor holds the token)
//   - static-key SELF-SERVICE (a client pastes a key at runtime) → encrypted D1 or a managed
//     vault — built only when that pain is real (the crypto.ts version lives in git history).

import type { ToolDefinition } from '@flue/runtime';
import type { Binding } from './bindings';
import { githubReadTools } from './github';

export interface ConnectionState {
  provider: string;
  status: 'connected' | 'not_connected';
  config: Record<string, unknown>;
}

/** Derive each declared connection's state from the binding + whether its Worker secret is
 *  present. Drives gating + the prompt block. Never exposes the secret. */
export function connectionState(binding: Binding, env: Record<string, unknown>): ConnectionState[] {
  const specs = binding.connections ?? [];
  return specs.map((s) => {
    const token = env[s.tokenRef];
    return {
      provider: s.provider,
      status: typeof token === 'string' && token ? 'connected' : 'not_connected',
      config: s.config ?? {},
    };
  });
}

/** Resolve a project's token + config for a provider, or null if not declared / secret missing.
 *  The ONE resolution path (the swappable seam). Today it reads a Worker secret by ref. */
export function resolveConnection(
  binding: Binding,
  env: Record<string, unknown>,
  provider: string,
): { secret: string; config: Record<string, unknown> } | null {
  const spec = (binding.connections ?? []).find((s) => s.provider === provider);
  if (!spec) return null;
  const token = env[spec.tokenRef];
  if (typeof token !== 'string' || !token) return null;
  return { secret: token, config: spec.config ?? {} };
}

// The provider catalog (what Hatchery supports at all). v2a: GitHub only. Curated platform-side;
// the agent picks from it, never adds to it.
export const PROVIDER_CATALOG: { provider: string; summary: string }[] = [
  { provider: 'github', summary: 'read issues/code, search (creating issues comes later, with approval)' },
];

// The CONNECTIONS prompt block (mirrors the skills catalog injection). Tells the agent what it
// can reach and what is connectable but not yet wired by an operator.
export function connectionsBlock(state: ConnectionState[], catalog: { provider: string; summary: string }[]): string {
  const byProvider = new Map(state.map((s) => [s.provider, s]));
  const lines = catalog.map((c) => {
    const s = byProvider.get(c.provider);
    if (s?.status === 'connected') return `  ✅ ${c.provider} (connected) — ${c.summary}`;
    return `  ⚪ ${c.provider} (not connected) — ${c.summary}`;
  });
  return (
    'YOUR CONNECTIONS\n' +
    'External services you can reach. Connected ones expose tools you can call now; the rest must be ' +
    'wired by an operator first (mention that you need it — you cannot connect it yourself).\n' +
    lines.join('\n')
  );
}

/** Tools contributed by connections, gated on state (ADR D6): the initializer pushes these only
 *  for connected providers. v2a = READS only. The github_create_issue PROPOSE tool is v2b — it
 *  ships together with the gateway executor + Block Kit approval + hard-gate tests, so we don't
 *  leave a propose tool whose other half doesn't exist. `secrets` maps provider → resolved
 *  {secret, config}. */
export function connectionTools(
  state: ConnectionState[],
  secrets: Record<string, { secret: string; config: Record<string, unknown> }>,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  const github = state.find((s) => s.provider === 'github' && s.status === 'connected');
  const ghCreds = secrets['github'];
  if (github && ghCreds) {
    const repo = typeof ghCreds.config.repo === 'string' ? ghCreds.config.repo : undefined;
    tools.push(...githubReadTools(ghCreds.secret, repo));
    // v2b plugs the github_create_issue propose-tool in here.
  }

  return tools;
}
