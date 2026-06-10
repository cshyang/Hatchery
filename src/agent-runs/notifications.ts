import { bindingByProject as defaultBindingByProject, type Binding } from '../project/bindings';
import { loadPersona } from '../project/persona';
import type { D1Like } from '../skills/repository';
import { postMessage as defaultPostMessage, type SlackPostOptions } from '../slack/post';
import { agentRunNotificationBlocks, agentRunNotificationText } from '../slack/blocks';
import { getAgentRunById, type AgentRun, type ClockAndIds } from './repository';

const DELIVERY_LIMIT = 20;

interface NotificationRow {
  id: string;
  project_id: string;
  run_id: string;
  notification_type: string;
}

type BindingLookup = (projectId: string, db?: D1Like) => Promise<Binding | undefined>;
type SlackPost = (
  token: string,
  channel: string,
  text: string,
  threadTs?: string,
  options?: SlackPostOptions,
) => Promise<string | undefined>;

export interface SlackNotificationSummary {
  sent: number;
  failed: number;
  skipped: number;
}

async function listPendingSlackNotifications(db: D1Like, limit: number): Promise<NotificationRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, project_id, run_id, notification_type
         FROM agent_run_notifications
        WHERE channel='slack' AND status='pending'
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .bind(limit)
    .all<NotificationRow>();
  return results ?? [];
}

async function markNotification(
  db: D1Like,
  id: string,
  input: { status: 'sent' | 'failed'; providerMessageId?: string | null; error?: string | null; sentAt?: number | null },
): Promise<void> {
  await db
    .prepare(
      `UPDATE agent_run_notifications
          SET status=?, provider_message_id=?, error=?, sent_at=?
        WHERE id=?`,
    )
    .bind(input.status, input.providerMessageId ?? null, input.error ?? null, input.sentAt ?? null, id)
    .run();
}

function threadFor(run: AgentRun): string | undefined {
  return run.slackThreadTs ?? undefined;
}

export async function deliverPendingSlackRunNotifications(
  args: { db: D1Like; env: Record<string, unknown>; limit?: number },
  deps: ClockAndIds & {
    bindingByProject?: BindingLookup;
    postMessage?: SlackPost;
    log?: (message: string) => void;
  } = {},
): Promise<SlackNotificationSummary> {
  const bindingByProject = deps.bindingByProject ?? defaultBindingByProject;
  const postMessage = deps.postMessage ?? defaultPostMessage;
  const log = deps.log ?? console.log;
  const now = deps.now?.() ?? Date.now();
  const summary: SlackNotificationSummary = { sent: 0, failed: 0, skipped: 0 };

  for (const notification of await listPendingSlackNotifications(args.db, args.limit ?? DELIVERY_LIMIT)) {
    const run = await getAgentRunById(args.db, notification.run_id);
    if (!run) {
      await markNotification(args.db, notification.id, { status: 'failed', error: 'agent run not found', sentAt: now });
      summary.failed++;
      continue;
    }

    const binding = await bindingByProject(notification.project_id, args.db).catch(() => undefined);
    if (!binding || binding.status !== 'active') {
      await markNotification(args.db, notification.id, { status: 'failed', error: 'no active Slack binding', sentAt: now });
      summary.failed++;
      continue;
    }

    const token = args.env[binding.transportTokenRef];
    if (typeof token !== 'string' || !token) {
      await markNotification(args.db, notification.id, { status: 'failed', error: `missing Slack token ${binding.transportTokenRef}`, sentAt: now });
      summary.failed++;
      continue;
    }

    try {
      const text = agentRunNotificationText(notification.notification_type, run);
      const blocks = agentRunNotificationBlocks(notification.notification_type, run);
      const channel = run.slackChannelId ?? binding.externalSpaceId;
      const persona = await loadPersona(args.db, notification.project_id).catch(() => null);
      const ts = await postMessage(token, channel, text, threadFor(run), {
        blocks,
        ...(persona ? { username: persona.name, ...(persona.iconEmoji ? { iconEmoji: persona.iconEmoji } : {}) } : {}),
      });
      await markNotification(args.db, notification.id, { status: 'sent', providerMessageId: ts ?? null, sentAt: now });
      summary.sent++;
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Slack notification failed';
      log(`[agent-runs] Slack notification ${notification.id} failed: ${message}`);
      await markNotification(args.db, notification.id, { status: 'failed', error: message, sentAt: now });
      summary.failed++;
    }
  }

  return summary;
}
