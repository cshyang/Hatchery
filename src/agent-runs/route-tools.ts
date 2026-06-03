import { defineTool, Type, type ToolDefinition } from '@flue/runtime';
import type { D1Like } from '../skills/repository';
import { createAgentRunRoute } from './events';

export function proposeAgentRouteTool(args: { db: D1Like; projectId: string; createdBy?: string }): ToolDefinition {
  return defineTool({
    name: 'propose_agent_route',
    description:
      'Propose a pending agent-run route for this project. This never activates launch routes; an admin must review and activate it separately.',
    parameters: Type.Object({
      provider: Type.String({ description: 'Provider that emits the trigger, e.g. linear.' }),
      externalKey: Type.String({ description: 'Provider workspace/team/project key, e.g. a Linear team key.' }),
      triggerType: Type.String({ description: 'Trigger type: state, label, or command.' }),
      triggerValue: Type.String({ description: 'Exact trigger value, e.g. Run Agent.' }),
      githubOwner: Type.String({ description: 'GitHub owner for the target repository.' }),
      githubRepo: Type.String({ description: 'GitHub repository name.' }),
      baseBranch: Type.String({ description: 'Base branch for runner PRs, usually main.' }),
      kit: Type.String({ description: 'Runner kit, currently coding-default.' }),
      runtime: Type.String({ description: 'Runner runtime, currently opencode.' }),
      sandboxProvider: Type.String({ description: 'Sandbox provider, currently e2b.' }),
      reason: Type.String({ description: 'Why this route should exist, for admin review.' }),
    }),
    async execute(input) {
      const route = await createAgentRunRoute(args.db, {
        projectId: args.projectId,
        provider: input.provider,
        externalKey: input.externalKey,
        triggerType: input.triggerType,
        triggerValue: input.triggerValue,
        githubOwner: input.githubOwner,
        githubRepo: input.githubRepo,
        baseBranch: input.baseBranch,
        kit: input.kit,
        runtime: input.runtime,
        sandboxProvider: input.sandboxProvider,
        reason: input.reason,
        createdByType: 'model',
        createdBy: args.createdBy ?? 'agent',
      });
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
        note: 'Route is pending. An admin must activate it before it can launch runs.',
      });
    },
  });
}
