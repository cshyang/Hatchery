import { defineTool, type ToolDefinition } from '@flue/runtime';
import { Type } from '@earendil-works/pi-ai';
import type { D1Like } from '../skills/repository';
import { activateAgentRunRoute, createAgentRunRoute } from './events';

/** With `autoActivate` (the ROUTES_AUTO_ACTIVATE deployment flag — single-tenant dogfood), a
 *  proposed route goes live immediately, skipping the admin curl. The boundary this relaxes is
 *  the human counter-signature on spend/target — NOT the repo allowlist: createAgentRunRoute
 *  still refuses any repo missing from the project's human-consented GitHub connection. Leave
 *  the flag unset in multi-tenant deployments and the propose→admin-activate flow is unchanged. */
export function proposeAgentRouteTool(args: { db: D1Like; projectId: string; createdBy?: string; autoActivate?: boolean }): ToolDefinition {
  return defineTool({
    name: 'propose_agent_route',
    description: args.autoActivate
      ? 'Create an agent-run route for this project (auto-activated in this deployment). The target repo must already be allowed on the project\'s GitHub connection.'
      : 'Propose a pending agent-run route for this project. This never activates launch routes; an admin must review and activate it separately.',
    parameters: Type.Object({
      provider: Type.String({ description: 'Provider that emits the trigger, e.g. linear.' }),
      externalKey: Type.String({ description: 'Provider workspace/team/project key, e.g. a Linear team key.' }),
      triggerType: Type.String({ description: 'Trigger type: state, label, or command.' }),
      triggerValue: Type.String({ description: 'Exact trigger value, e.g. Run Agent.' }),
      githubOwner: Type.String({ description: 'GitHub owner for the target repository.' }),
      githubRepo: Type.String({ description: 'GitHub repository name.' }),
      baseBranch: Type.String({ description: 'Base branch for runner PRs, usually main.' }),
      kit: Type.Optional(Type.String({ description: 'Agent Kit id. Defaults to coding-default.' })),
      reason: Type.String({ description: 'Why this route should exist, for admin review.' }),
    }),
    async execute(input) {
      let route = await createAgentRunRoute(args.db, {
        projectId: args.projectId,
        provider: input.provider,
        externalKey: input.externalKey,
        triggerType: input.triggerType,
        triggerValue: input.triggerValue,
        githubOwner: input.githubOwner,
        githubRepo: input.githubRepo,
        baseBranch: input.baseBranch,
        kit: input.kit ?? 'coding-default',
        runtime: 'pi',
        sandboxProvider: 'e2b',
        reason: input.reason,
        createdByType: 'model',
        createdBy: args.createdBy ?? 'agent',
      });
      let note = 'Route is pending. An admin must activate it before it can launch runs.';
      if (args.autoActivate) {
        try {
          route = await activateAgentRunRoute(args.db, route.id, 'auto-activate');
          note = 'Route is ACTIVE (auto-activation is on in this deployment). assign_coding_run and trigger events can launch runs now.';
        } catch (e) {
          // Conflicting active route etc. — fall back to pending rather than failing the proposal.
          note = `Route created but NOT auto-activated: ${e instanceof Error ? e.message : 'activation failed'}. An admin can resolve and activate it.`;
        }
      }
      return JSON.stringify({
        id: route.id,
        projectId: route.projectId,
        provider: route.provider,
        externalKey: route.externalKey,
        triggerType: route.triggerType,
        triggerValue: route.triggerValue,
        githubOwner: route.githubOwner,
        githubRepo: route.githubRepo,
        baseBranch: route.baseBranch,
        kit: route.kit,
        runtime: route.runtime,
        sandboxProvider: route.sandboxProvider,
        status: route.status,
        note,
      });
    },
  });
}
