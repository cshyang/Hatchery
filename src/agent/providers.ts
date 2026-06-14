// Extra model providers registered at agent-init time. The Slack brain's model call runs INSIDE the
// project Durable Object (the createAgent initializer in .flue/agents/project.ts), not the Worker
// request isolate — and pi-ai's provider registry is module-scoped (per-isolate). So a provider the
// brain uses must be registered FROM the initializer, where env (and the secret) are in hand. The
// registry is last-write-wins, so calling this on every initializer run is safe and needs no dedupe.

import { registerProvider } from '@flue/runtime';

// Z.ai GLM coding-plan provider. Its endpoint is Anthropic-compatible, so we reuse Flue's built-in
// 'anthropic' wire protocol and just point the base URL at Z.ai. Registered under its own provider
// id so model specifiers read `zai-coding/glm-5.2[1m]` (the 1M-context GLM-5.2 variant) — keeping it
// distinct from the real 'anthropic' provider.
//
// ⚠️ UNPROVEN IN THIS PIPELINE. GLM-5.2 is a thinking model, and this stack already killed kimi-k2.6
// for exactly that (reasoning chunks, content:null on the first beat → dead-on-arrival). DO NOT make
// `zai-coding/glm-5.2[1m]` a default or add it to VALIDATED_MODELS until a real DO turn confirms a
// clean stream + valid tool calls. Pin it on ONE channel and watch `wrangler tail` first.
const ZAI_CODING_PROVIDER_ID = 'zai-coding';

export function ensureModelProviders(env: Record<string, unknown>): void {
  const zaiKey = typeof env.ZAI_CODING_API_KEY === 'string' ? env.ZAI_CODING_API_KEY : '';
  if (!zaiKey) return; // secret absent → provider simply doesn't exist; nothing pins it yet anyway

  registerProvider(ZAI_CODING_PROVIDER_ID, {
    api: 'anthropic',
    baseUrl: 'https://api.z.ai/api/anthropic',
    apiKey: zaiKey,
    // If the live probe returns 401, Z.ai's endpoint wants a Bearer token, not the x-api-key the
    // Anthropic protocol sends by default (its Claude Code integration uses ANTHROPIC_AUTH_TOKEN).
    // Flip auth by dropping `apiKey` above and adding:
    //   headers: { authorization: `Bearer ${zaiKey}` },
    // Window is set here so threshold compaction works even before the model enters VALIDATED_MODELS;
    // being in `models` is NOT validation (see the warning above).
    models: { 'glm-5.2[1m]': { contextWindow: 1_000_000 } },
  });
}
