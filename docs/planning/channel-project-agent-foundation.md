# Channel Project Agent Foundation

**Date**: 2026-05-29  
**Status**: draft  
**Primary goal**: Build the smallest durable slice of a multi-channel project agent system, starting with Slack + Flue + Cloudflare.

## Context

We want a system where a communication channel can become an agent-backed project space. Slack is the first channel provider, but the product model should not be Slack-shaped forever. The stable abstraction is:

```text
workspace/team -> tenant
channel        -> project
thread         -> session
message        -> operation/input
agent turn     -> model/tool step inside an operation
```

Flue is the preferred agent framework because its concepts map cleanly to this model:

```text
Flue profile       -> reusable behavior: instructions, model, tools, skills, subagents
Flue agent module  -> deployed agent entrypoint
Flue agent instance -> stable project identity
Flue harness       -> initialized runtime boundary inside an instance
Flue session       -> named conversation stream inside a harness
Flue sandbox       -> filesystem/shell environment used by tools
```

Cloudflare is the preferred deployment target for the first slice because Flue can build to Workers + Durable Objects, giving us cheap idle behavior and durable per-instance state. A Cloudflare Durable Object is the hibernating runtime/actor boundary, not the full Linux sandbox. Flue's default virtual sandbox should be used first; Cloudflare Sandbox, Daytona, or E2B should be attached only when a project needs real Linux, persistent filesystem, browser automation, native dependencies, or repo-level coding work.

## Decision Frame

The goal is not to build "a Slack bot." Hermes already has broad messaging integrations and can do that quickly. The goal is to build a foundation for project-scoped agents with clean routing, isolation, and future channel/provider extension.

The foundation should include extension seams now, not every extension:

- Provider-neutral inbound message shape.
- Project and session routing independent of Slack internals.
- Control-plane config for channel access and runtime selection.
- Flue profile/runtime boundaries that do not hard-code Slack permissions.
- Tool guards that enforce allowed channels, threads, and project resources.
- Sandbox provider abstraction, initially backed by Flue's virtual sandbox.

## First Implementation Scope

Build the first usable slice:

```text
Slack Events API
  -> Cloudflare Worker route
  -> Slack request verification
  -> durable admission/idempotency
  -> normalize event into CanonicalMessage
  -> lookup project config by team_id + channel_id
  -> dispatch to Flue agent instance
  -> use thread_ts/root ts as Flue session
  -> agent replies through an explicit Slack tool
```

### Included

- Cloudflare-targeted Flue project setup.
- One Slack adapter for Events API messages.
- One project agent module.
- One default Flue profile for project agents.
- Project routing: `team_id + channel_id -> project_id`.
- Session routing: `thread_ts ?? ts -> session_id`.
- Durable event idempotency using Slack event identifiers.
- Slack reply tool with enforced project/channel/thread allowlist.
- Default virtual sandbox.
- Config shape for future sandbox provider selection.

### Excluded

- Admin UI.
- Billing.
- Multiple channel providers.
- Hermes adapter.
- Full sandbox lifecycle manager.
- Per-thread full Linux sandbox allocation.
- Complex permission management UI.
- Full workflow/job orchestration for long-running work.

These exclusions are deliberate. Build the foundation so they can be added, but do not implement them before the core loop works.

## Core Model

### Project

A project is the product-level unit represented by a channel-like collaboration space.

```ts
type Project = {
  id: string;
  tenantId: string;
  name: string;
  defaultProfile: string;
  sandboxMode: "virtual" | "cloudflare-sandbox" | "daytona" | "e2b";
  status: "active" | "disabled";
};
```

### Channel Binding

Channel bindings live in the gateway/control plane, not inside Flue profiles. They determine where an agent may operate.

```ts
type ChannelBinding = {
  id: string;
  provider: "slack";
  tenantId: string;
  projectId: string;
  externalTeamId: string;
  externalChannelId: string;
  botTokenRef: string;
  status: "active" | "disabled";
};
```

### Canonical Message

Provider adapters normalize inbound events before Flue sees them.

```ts
type CanonicalMessage = {
  provider: "slack";
  providerEventId: string;
  tenantId: string;
  projectId: string;
  sessionId: string;
  senderId: string;
  text: string;
  raw: unknown;
};
```

## Flue Mapping

For the first slice:

```text
agent module: .flue/agents/project.ts
agent instance id: project:<project_id>
harness: default harness for that project instance
session id: slack-thread:<thread_ts_or_root_ts>
```

The agent initializer should resolve stable project runtime concerns from the instance id:

```ts
export default createAgent(async ({ id, env }) => {
  const project = await loadProjectConfig(env, id);

  return {
    profile: resolveProfile(project.defaultProfile),
    sandbox: await resolveSandbox(project, id, env),
    cwd: "/workspace",
  };
});
```

The profile defines behavior. The channel binding defines access. The Slack tool enforces access.

## Security And Isolation

The dominant isolation risk is not filesystem escape. It is context/tool confusion: an agent acting in one project using memory, defaults, or credentials from another project.

The first slice must enforce these boundaries:

- Project config is loaded by `project_id`, not inferred from prompt text.
- Slack tool receives allowed `team_id`, `channel_id`, and thread scope from trusted config.
- Slack tool rejects calls outside the bound channel/thread.
- Bot tokens are referenced by `botTokenRef`; tokens are not placed into prompts or sandbox files.
- Flue session ids are namespaced by provider/thread to avoid collisions.
- Long-term project memory, when added, must be scoped by `project_id`.

## Sandbox Strategy

Start with Flue's default virtual sandbox.

Use a real sandbox only when a project requires capabilities the virtual sandbox cannot provide:

| Mode | Use When | Notes |
| --- | --- | --- |
| `virtual` | normal chat, small files, project notes, skills | default; fast and cheap |
| `cloudflare-sandbox` | full Linux while staying on Cloudflare | requires Cloudflare Workers target, `@cloudflare/sandbox`, Dockerfile, container binding |
| `daytona` | persistent dev workspace, repo work, provider-managed lifecycle | normal SDK connector; easier outside Cloudflare |
| `e2b` | short-lived microVM-style execution | useful for isolated execution and experiments |

Do not allocate one real sandbox per Slack thread by default. Threads are sessions. Sandboxes are project resources or task resources.

## Data Flow

```text
1. Slack sends event.
2. Worker verifies Slack signature.
3. Worker ignores unsupported events and bot echoes.
4. Worker writes/claims idempotency record.
5. Worker looks up active ChannelBinding.
6. Worker derives CanonicalMessage.
7. Worker dispatches to Flue:
     agent = "project"
     id = "project:<project_id>"
     session = "slack-thread:<thread_ts_or_ts>"
     input = CanonicalMessage
8. Flue project agent processes input.
9. Agent calls Slack reply tool.
10. Slack reply tool verifies binding and posts to the same thread.
```

Slack acknowledgment should not wait for model completion. The gateway should admit the event durably and return quickly.

## Error Handling

- Invalid Slack signature: return unauthorized and do not dispatch.
- Disabled/missing channel binding: acknowledge without dispatching, optionally log.
- Duplicate Slack event: acknowledge and skip dispatch.
- Flue dispatch accepted but processing fails: store/log failure with provider event id and project id.
- Slack post failure: return a tool error visible to the agent and log the failed external call.
- External side effects must use provider event ids or application idempotency keys.

## Testing Strategy

Start with tests around boundaries, not model quality:

- Slack signature verification.
- Slack event normalization.
- Channel binding lookup.
- Thread/session id derivation.
- Idempotency behavior.
- Slack reply tool refuses wrong team/channel/thread.
- Flue dispatch receives expected `id`, `session`, and input shape.

Manual smoke test:

```text
1. Install Slack app into a test workspace.
2. Bind one test channel to one project.
3. Mention/post to the bot in the channel.
4. Confirm a reply appears in the same thread.
5. Continue in the thread.
6. Confirm the Flue session continues context.
7. Post in an unbound channel.
8. Confirm no agent response occurs.
```

## Open Questions

- Should the first project/config store be D1, Durable Object storage, or a simple typed config file for local development?
- Should the first Slack integration support only app mentions, or all channel messages where the bot is present?
- Should replies always happen in thread, even when the original message is not threaded?
- How should project profiles be selected: explicit project config only, or channel template default with project override?
- Which sandbox provider should be implemented second after virtual: Cloudflare Sandbox or Daytona?

## Success Criteria

The foundation slice is successful when:

- A Slack channel can be bound to one project.
- A Slack thread maps to one persistent Flue session.
- The agent can respond in the same Slack thread.
- Unbound channels are ignored safely.
- Slack access is enforced by tool guards, not prompts.
- The system runs on Cloudflare with Flue session persistence.
- The code has clear seams for future channel adapters and real sandbox providers.

