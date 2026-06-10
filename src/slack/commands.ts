// Slack slash-command layer: /hatchery <subcommand>. One slash entry point (no per-command
// manifest entries, no namespace collisions with other workspace apps); subcommands route here.
// Read-only BY DESIGN: a group channel has no per-user privilege tiers, so slash commands are
// observability views — mutations stay with the agent's gated tools and the /__admin routes.
// Replies are ephemeral mrkdwn returned directly to the slash request (every command is a fast
// D1 read, well inside Slack's 3-second response window — no response_url dance needed).

import type { Binding } from '../project/bindings';
import { resolveModel } from '../project/bindings';
import type { D1Like } from '../skills/repository';
import { loadSkillCatalog } from '../skills/repository';
import { listReminders } from '../gateway/reminders-store';
import { listRecentAgentRuns } from '../agent-runs/repository';
import { loadConnectionSpecs, connectionState } from '../connections/repository';
import { KL_OFFSET_MIN } from '../gateway/cron';

export interface SlashCommandPayload {
  command: string;
  text: string;
  userId: string;
  channelId: string;
  teamId: string;
}

/** Decode Slack's application/x-www-form-urlencoded slash payload. Missing fields → ''. */
export function parseSlashCommandPayload(raw: string): SlashCommandPayload {
  const form = new URLSearchParams(raw);
  return {
    command: form.get('command') ?? '',
    text: (form.get('text') ?? '').trim(),
    userId: form.get('user_id') ?? '',
    channelId: form.get('channel_id') ?? '',
    teamId: form.get('team_id') ?? '',
  };
}

export interface SlashCommandContext {
  binding: Binding;
  db?: D1Like;
  env: Record<string, unknown>;
}

const RUNS_LIMIT = 10;

const HELP = [
  '*Hatchery commands*',
  '• `/hatchery status` — binding, model, connections, and wiring for this channel',
  '• `/hatchery runs` — recent agent runs (Linear → Trigger.dev coding runs)',
  '• `/hatchery reminders` — scheduled reminders for this project',
  '• `/hatchery skills` — active skill catalog',
  '• `/hatchery help` — this list',
].join('\n');

const NO_DB = 'This command needs the database binding, which is not configured on this deployment.';

function hasSecret(env: Record<string, unknown>, name: string): boolean {
  const v = env[name];
  return typeof v === 'string' && v.length > 0;
}

function wiring(label: string, configured: boolean): string {
  return `• ${label}: ${configured ? 'configured' : 'not configured'}`;
}

// Epoch ms → "YYYY-MM-DD HH:mm KL" (the reminder store schedules in KL wall-clock time).
function formatKlTime(ms: number): string {
  return `${new Date(ms + KL_OFFSET_MIN * 60_000).toISOString().slice(0, 16).replace('T', ' ')} KL`;
}

async function statusCommand(ctx: SlashCommandContext): Promise<string> {
  const { binding, db, env } = ctx;
  const specs = await loadConnectionSpecs(db, binding);
  const connections = connectionState(specs, env)
    .map((s) => `${s.provider} ${s.status === 'connected' ? 'connected' : 'not connected'}`)
    .join(', ');
  return [
    `*Hatchery status — project \`${binding.projectId}\`*`,
    `• Model: \`${resolveModel(binding.model)}\` (${binding.model ? 'pinned' : 'default'})`,
    `• Connections: ${connections || 'none declared'}`,
    wiring('Linear ingress', hasSecret(env, 'LINEAR_WEBHOOK_SECRET')),
    wiring('Trigger.dev runner', hasSecret(env, 'TRIGGER_SECRET_KEY')),
    wiring('Nango', hasSecret(env, 'NANGO_SECRET_KEY')),
  ].join('\n');
}

async function runsCommand(ctx: SlashCommandContext): Promise<string> {
  if (!ctx.db) return NO_DB;
  const runs = await listRecentAgentRuns(ctx.db, ctx.binding.projectId, RUNS_LIMIT);
  if (runs.length === 0) return 'No agent runs for this project yet.';
  const lines = runs.map((r) => {
    const ident = r.linearIdentifier ?? r.id.slice(0, 12);
    const pr = r.prUrl ? ` — <${r.prUrl}|PR>` : '';
    const error = r.status === 'failed' && r.error ? ` — ${r.error}` : '';
    return `• ${ident} \`${r.status}\` kit=${r.kit}${pr}${error}`;
  });
  return ['*Recent agent runs*', ...lines].join('\n');
}

async function remindersCommand(ctx: SlashCommandContext): Promise<string> {
  if (!ctx.db) return NO_DB;
  const rows = await listReminders(ctx.db, ctx.binding.projectId);
  if (rows.length === 0) return 'No reminders for this project.';
  const lines = rows.map((r) => {
    const when = r.enabled ? `next ${formatKlTime(r.next_run)}` : 'paused';
    const schedule = r.cron ? ` cron \`${r.cron}\`` : '';
    return `• ${r.id} (${r.kind})${schedule} — ${when}`;
  });
  return ['*Reminders*', ...lines].join('\n');
}

async function skillsCommand(ctx: SlashCommandContext): Promise<string> {
  if (!ctx.db) return NO_DB;
  const catalog = await loadSkillCatalog(ctx.db, ctx.binding.projectId);
  if (catalog.length === 0) return 'No skills for this project yet.';
  const lines = catalog.map((s) => `• ${s.name} — ${s.description}`);
  return ['*Skills*', ...lines].join('\n');
}

/** Dispatch `/hatchery <subcommand>` to its handler. Unknown/empty input → help. */
export async function runSlashCommand(text: string, ctx: SlashCommandContext): Promise<string> {
  const sub = text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  switch (sub) {
    case '':
    case 'help':
      return HELP;
    case 'status':
      return statusCommand(ctx);
    case 'runs':
      return runsCommand(ctx);
    case 'reminders':
      return remindersCommand(ctx);
    case 'skills':
      return skillsCommand(ctx);
    default:
      return `Unknown command \`${sub}\`. Try \`/hatchery help\`.`;
  }
}
