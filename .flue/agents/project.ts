import { createAgent, defineTool, Type, type AgentRuntimeConfig, type ToolDefinition } from '@flue/runtime';
import { bindingByProject, parseAgentInstanceId, DEFAULT_MODEL, resolveModel } from '../../src/project/bindings';
import { loadPersona, personaTools } from '../../src/project/persona';
import { assignSoul, SOUL_NAME_PREFIX } from '../../src/project/souls';
import { resolveTarget, sendFinalToConversationTarget, sendToConversationTarget } from '../../src/project/conversations';
import { fetchChannelHistory, fetchThreadReplies, renderThreadBackscroll } from '../../src/slack/threads';
import { proactiveReplyTool } from '../../src/review';
import { withToolLogging, withReplyReminder } from '../../src/agent/observability';
import { skillTools, loadSkillCatalog, loadActiveSkillBody, skillBody, type D1Like } from '../../src/skills/repository';
import { reminderTools } from '../../src/agent/reminders';
import { buildInstructions } from '../../src/agent/prompt';
import { selfStatusTool } from '../../src/agent/self';
import { loadProjectMemory, memoryTools, renderMemory } from '../../src/knowledge/memory';
import { peopleTools } from '../../src/knowledge/people';
import { userTools } from '../../src/knowledge/users';
import { searchTools } from '../../src/knowledge/search';
import { workbenchTools } from '../../src/workbench/tools';
import { sourceChangeTools } from '../../src/workbench/source-change';
import { logMessage } from '../../src/knowledge/reflection';
import { buildConnectionRuntime } from '../../src/connections/runtime';
import { setupStatusTool } from '../../src/setup/status';
import { codeModeLimits, codeModeTools, hasCodeModeCapability, type DynamicWorkerLoaderLike } from '../../src/code-mode/code-mode';
import { getSandbox } from '@cloudflare/sandbox';
import { hasWorkspaceCapability, workspaceLimits, workspaceTools, type SandboxLike } from '../../src/workspace/workspace';
import { workspaceSlackFileTools } from '../../src/workspace/slack-files';

// The project agent. Addressed at /agents/project/<id>, id = "project:<projectId>:agent:<slug>"
// (slug = "default" until a channel hosts multiple personas). Each instance is a persistent
// Durable Object — the per-(project, persona) boundary.
//
// Access is enforced by TOOLS, not the prompt: replies resolve a stored conversation target
// plus token ref from trusted config; skills/reminders/memory are scoped to this projectId.
// The model controls only the content, never the destination or another project's data.
//
// NOTE: the work below runs in Flue's `createAgent` INITIALIZER (which may be async), NOT
// the Durable Object constructor. The DO constructor stays boring — no D1/network there.

export default createAgent(async (ctx): Promise<AgentRuntimeConfig> => {
  const { projectId, slug } = parseAgentInstanceId(ctx.id);
  const env = ctx.env as Record<string, unknown>;
  const db = env.DB as D1Like | undefined;
  const binding = await bindingByProject(projectId, db);

  // No active binding → an inert agent with no posting capability.
  if (!binding) {
    return {
      model: DEFAULT_MODEL,
      instructions: `No active binding for project "${projectId}". Do not attempt to post anywhere.`,
    };
  }

  // Persona (structured display identity) resolves FIRST: no `personas` row means the channel has
  // never hatched — backfill a random pre-authored soul (channels bound before souls shipped get
  // one here too) so this very turn is already in character. assignSoul no-ops for any channel
  // with an existing identity; .catch keeps identity a nicety, never a turn-blocker.
  let persona = db ? await loadPersona(db, projectId).catch(() => null) : null;
  if (db && !persona) {
    const assigned = await assignSoul(db, projectId).catch(() => null);
    if (assigned) persona = await loadPersona(db, projectId).catch(() => null);
  }

  // L1 catalog query — cheap, every turn. .catch keeps a D1 hiccup from breaking the agent.
  const skills = db ? await loadSkillCatalog(db, projectId).catch(() => []) : [];
  // Personality (overwritable): a skill named `personality` defines the agent's role/voice and is
  // applied to EVERY turn. Absent → a general default. This is the only purpose-layer; everything
  // else below is fixed FUNCTION. Loaded eagerly (not on demand) so it colors all output.
  const personality =
    db && skills.some((s) => s.name === 'personality')
      ? await loadActiveSkillBody(db, projectId, 'personality').catch(() => null)
      : null;
  // `personality` is applied above (not load-on-demand); `soul-*` are assignment templates, not
  // channel how-tos — both stay out of the L1 list.
  const catalog = skills.filter((s) => s.name !== 'personality' && !s.name.startsWith(SOUL_NAME_PREFIX));

  // Memory (always-injected, bounded, project-scoped — shared channel facts). NOTE: per-author
  // user memory can't be injected here — Flue's dispatch leaves the initializer blind to the
  // turn's author (ctx.payload is undefined on dispatch; only the model sees senderId). People-
  // facts therefore live in project memory; a future self-scheduled reflection job distils them
  // from thread history. .catch keeps a D1 hiccup from breaking the agent.
  const projectMem = db ? await loadProjectMemory(db, projectId).catch(() => []) : [];
  const memoryBlock = renderMemory(projectMem);

  const connectionRuntime = await buildConnectionRuntime({ db, binding, env, projectId });

  const replyToConversation = defineTool({
    name: 'reply_to_conversation',
    description:
      "Send your reply to the current conversation. Call this with your final response text; pass conversationId for user-message replies, and ackMessageTs so your reply replaces the working note in place.",
    parameters: Type.Object({
      text: Type.String({ description: 'The message to post.' }),
      conversationId: Type.Optional(
        Type.String({
          description:
            "When replying to a user message, copy the conversationId from the [Dispatch Input] block. OMIT for a heartbeat/new top-level post.",
        }),
      ),
      ackMessageTs: Type.Optional(
        Type.String({
          description:
            "Copy ackMessageTs from the [Dispatch Input] block (alongside conversationId) so your reply edits the working note into your answer instead of posting a second message. OMIT for heartbeat/new posts.",
        }),
      ),
    }),
    async execute({ text, conversationId, ackMessageTs }) {
      const conv = conversationId ? String(conversationId) : '';
      const target = await resolveTarget(db, binding, projectId, slug, conv);
      if (!target) {
        throw new Error(`No reply target found for conversationId "${conv}".`);
      }
      await sendFinalToConversationTarget(env, target, String(text), {
        db,
        projectId,
        sessionId: conv ? `conv:${conv}` : '',
        ackMessageTs: ackMessageTs ? String(ackMessageTs) : undefined,
        persona,
      });
      // Log the agent's own post to the transcript (the other half of the conversation reflection
      // consolidates). REM turns are told not to post, so this never logs reflection's own output.
      if (db) await logMessage(db, { projectId, conversationId: conv, senderId: 'agent', role: 'agent', text: String(text) }).catch(() => {});
      return 'sent';
    },
  });

  // Ephemeral progress note for slow, multi-step turns. Reuses the reply path's target resolution,
  // but NEVER logs to the transcript (it's chrome, not conversation) and NEVER throws — a failed
  // status must not derail the real answer. Model-driven; the prompt says when to call it.
  const updateStatus = defineTool({
    name: 'update_status',
    description:
      "Update the working note BEFORE slow, multi-step work (several searches/API calls before you can " +
      "answer) to show the person the SPECIFIC step you're on. Pass ackMessageTs so this replaces the generic " +
      "working note in place (don't post a duplicate ack). Use up to 3 meaningful phase updates for long turns, " +
      "with human-readable activity like Checking the repo or Running tests; do not list raw tool names or argument dumps. " +
      "Skip it for quick answers and for heartbeat/scheduled runs. Lead with an emoji. This is NOT your " +
      "reply: always send the actual answer via reply_to_conversation.",
    parameters: Type.Object({
      text: Type.String({ description: "Short friendly note, e.g. '🔍 Checking the GitHub repo…'" }),
      conversationId: Type.Optional(
        Type.String({ description: 'Copy from the [Dispatch Input] block, same as your reply.' }),
      ),
      ackMessageTs: Type.Optional(
        Type.String({
          description:
            "Copy from the [Dispatch Input] block so this note edits the working-note message in place. OMIT for heartbeat/new posts.",
        }),
      ),
    }),
    async execute({ text, conversationId, ackMessageTs }) {
      const target = await resolveTarget(db, binding, projectId, slug, conversationId ? String(conversationId) : '');
      if (!target) return 'no target — status skipped';
      try {
        await sendToConversationTarget(env, target, String(text), ackMessageTs ? String(ackMessageTs) : undefined, persona);
        return 'posted';
      } catch (e) {
        return `status not posted: ${e instanceof Error ? e.message : 'error'}`;
      }
    },
  });

  // Bot token (for resolving Slack user names via users.info). Same ref the reply path uses.
  const botToken = env[binding.transportTokenRef] as string | undefined;

  // Real Slack history on demand — the channel's actual past (conversations.history/replies),
  // not the bot's own transcript, which only holds turns the bot saw. This is what makes
  // "what happened in this channel?" and "catch up on this thread" answerable.
  const readChannelHistory = defineTool({
    name: 'read_channel_history',
    description:
      'Read the REAL recent message history of this Slack channel (or one thread) straight from Slack — ' +
      'includes messages from before you joined and threads you never participated in. Your own transcript ' +
      'search only covers turns you were part of; use THIS when asked about channel activity, to catch up on ' +
      'a thread, or whenever someone references a discussion you do not remember. Pass threadTs (a thread ' +
      "root ts) to read that thread; omit it for the channel's recent top-level messages.",
    parameters: Type.Object({
      threadTs: Type.Optional(Type.String({ description: 'Thread root ts (e.g. "1718000000.123456") to read one thread instead of the channel.' })),
      limit: Type.Optional(Type.Number({ description: 'Max channel messages to fetch (default 50, cap 200). Ignored for threads.' })),
    }),
    async execute({ threadTs, limit }) {
      if (!botToken) throw new Error('No Slack token available for history reads.');
      const channel = binding.externalSpaceId;
      const messages = threadTs
        ? await fetchThreadReplies(botToken, channel, String(threadTs))
        : await fetchChannelHistory(botToken, channel, { limit: Number(limit) || 50 });
      const rendered = renderThreadBackscroll(messages, binding.transportBotId, { maxChars: 12_000 });
      return rendered || 'No messages found (empty history, or the bot lacks access to this channel).';
    },
  });
  const model = resolveModel(binding.model);
  const codingRunnerUrl = typeof env.CODING_RUNNER_URL === 'string' ? env.CODING_RUNNER_URL : '';
  const workbenchRunnerToken = typeof env.WORKBENCH_RUNNER_TOKEN === 'string' ? env.WORKBENCH_RUNNER_TOKEN : '';
  const agentRunnerToken = typeof env.AGENT_RUNNER_TOKEN === 'string' ? env.AGENT_RUNNER_TOKEN : '';
  const triggerSecretKey = typeof env.TRIGGER_SECRET_KEY === 'string' ? env.TRIGGER_SECRET_KEY : '';
  const runnerGithubToken = typeof env.RUNNER_GITHUB_PAT_TEMP === 'string' ? env.RUNNER_GITHUB_PAT_TEMP : '';
  const hatcheryPublicUrl = typeof env.HATCHERY_PUBLIC_URL === 'string' ? env.HATCHERY_PUBLIC_URL : '';
  const dynamicWorkerLoader = env.DYNAMIC_WORKER_LOADER as DynamicWorkerLoaderLike | undefined;
  const hasCodeMode = hasCodeModeCapability({ db, loader: dynamicWorkerLoader });
  const limits = codeModeLimits(env);
  // One sandbox container per project, resolved lazily so the container only
  // boots when a workspace tool actually runs (~6s cold start after idle).
  const sandboxNamespace = env.SANDBOX as Parameters<typeof getSandbox>[0] | undefined;
  const sandbox = sandboxNamespace
    ? () => getSandbox(sandboxNamespace, projectId) as unknown as SandboxLike
    : undefined;
  const hasWorkspace = hasWorkspaceCapability({ db, sandbox });

  const tools: ToolDefinition[] = [
    replyToConversation,
    updateStatus,
    selfStatusTool({
      projectId,
      agentSlug: slug,
      model,
      hasDb: !!db,
      hasBotToken: !!botToken,
      hasCodingRunner: !!codingRunnerUrl && !!workbenchRunnerToken,
      // GitHub write credential mirrors resolveDispatchGithubToken: the project's connected
      // GitHub App installation token (preferred) or the RUNNER_GITHUB_PAT_TEMP fallback.
      hasAgentRunner:
        !!triggerSecretKey &&
        !!agentRunnerToken &&
        (connectionRuntime.state.some((s) => s.provider === 'github' && s.status === 'connected') || !!runnerGithubToken) &&
        !!hatcheryPublicUrl,
      hasLinearAgentIngress: typeof env.LINEAR_WEBHOOK_SECRET === 'string',
      hasCodeMode,
      codeModeLimits: hasCodeMode ? limits : null,
      hasWorkspace,
      workspaceLimits: hasWorkspace ? workspaceLimits(env) : null,
      canRequestConnections: connectionRuntime.canRequestConnections,
      providerCatalog: connectionRuntime.providerCatalog,
      connectionState: connectionRuntime.state,
      connectionToolNames: connectionRuntime.tools.map((tool) => tool.name),
    }),
    setupStatusTool({ db, binding, projectId, env }),
    ...(db ? skillTools(db, projectId) : []),
    ...personaTools(db, projectId),
    ...reminderTools(db, projectId),
    ...(db ? memoryTools(db, projectId) : []),
    ...peopleTools(db, projectId),
    ...userTools(db, botToken),
    readChannelHistory,
    // Layer 4's only mouth: unprompted posts go through here (budgets + thread-only + shadow
    // mode enforced in the tool). Registered always, used only by review-sweep turns per prompt.
    ...(db
      ? [
          proactiveReplyTool({
            db,
            projectId,
            binding,
            mode: typeof env.REVIEW_MODE === 'string' ? env.REVIEW_MODE : undefined,
            send: async (target, text) => {
              await sendToConversationTarget(env, target, text, undefined, persona);
              await logMessage(db, { projectId, conversationId: target.conversationId, senderId: 'agent', role: 'agent', text }).catch(() => {});
            },
          }),
        ]
      : []),
    ...(db ? searchTools(db, projectId) : []),
    ...codeModeTools({ db, loader: dynamicWorkerLoader, projectId, env }),
    ...workspaceTools({ db, sandbox, projectId, env }),
    ...workspaceSlackFileTools({
      db,
      sandbox,
      projectId,
      env,
      token: botToken,
      // Same trust line as reply_to_conversation: the model names a conversation,
      // trusted config supplies channel/thread/token.
      resolveTarget: async (conversationId) => {
        const target = await resolveTarget(db, binding, projectId, slug, conversationId);
        if (!target) return null;
        const token = env[target.transportTokenRef] as string | undefined;
        if (!token) return null;
        return { channelId: target.externalSpaceId, threadTs: target.externalConversationId, token };
      },
    }),
    ...(db ? workbenchTools(db, projectId) : []),
    ...(db ? sourceChangeTools({ db, projectId, runnerUrl: codingRunnerUrl, runnerToken: workbenchRunnerToken }) : []),
    ...connectionRuntime.tools,
  ];

  return {
    model,
    instructions: buildInstructions({
      projectName: binding.projectId,
      personality: personality ? skillBody(personality) : null,
      catalog,
      memoryBlock,
      connectionsBlock: connectionRuntime.connectionsBlock,
    }),
    // withReplyReminder is OUTER (logs capture the original result; the model gets result+reminder).
    tools: tools.map(withToolLogging).map(withReplyReminder),
  };
});
