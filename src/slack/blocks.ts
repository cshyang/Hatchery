import type { AgentRun } from '../agent-runs/repository';

export type SlackBlock = Record<string, unknown>;

const ERROR_MAX = 240;

function truncate(value: string, max = ERROR_MAX): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function repo(run: AgentRun): string {
  if (run.githubOwner && run.githubRepo) return `${run.githubOwner}/${run.githubRepo}`;
  return run.targetRepo.replace(/^https?:\/\/github\.com\//, '').replace(/^github\.com\//, '');
}

function issue(run: AgentRun): string | null {
  if (run.linearUrl && run.linearIdentifier) return `<${run.linearUrl}|${run.linearIdentifier}>`;
  return run.linearIdentifier ?? null;
}

function pr(run: AgentRun): string | null {
  return run.prUrl ? `<${run.prUrl}|Open PR>` : null;
}

function title(type: string): string {
  if (type === 'run_started') return 'Agent run started';
  if (type === 'pr_opened') return 'Agent run waiting for review';
  if (type === 'completed') return 'Agent run completed';
  if (type === 'failed') return 'Run failed';
  return 'Agent run updated';
}

function fallbackTitle(type: string): string {
  if (type === 'pr_opened') return 'PR opened — waiting for review';
  return title(type);
}

export function agentRunNotificationText(type: string, run: AgentRun): string {
  const lines = [`*${fallbackTitle(type)}*`, `Repo: ${repo(run)}`];
  const linkedIssue = issue(run);
  if (linkedIssue) lines.push(`Issue: ${linkedIssue}`);
  if (run.branch) lines.push(`Branch: \`${run.branch}\``);
  const linkedPr = pr(run);
  if (linkedPr) lines.push(`PR: ${linkedPr}`);
  if (type === 'failed' && run.error) lines.push(`Error: ${truncate(run.error)}`);
  else if (run.summary) lines.push(`Summary: ${truncate(run.summary)}`);
  return lines.join('\n');
}

function field(label: string, value: string | null | undefined): SlackBlock | null {
  if (!value) return null;
  return { type: 'mrkdwn', text: `*${label}*\n${value}` };
}

export function agentRunNotificationBlocks(type: string, run: AgentRun): SlackBlock[] {
  const fields = [
    field('Repo', repo(run)),
    field('Issue', issue(run)),
    field('Branch', run.branch ? `\`${run.branch}\`` : null),
    field('PR', pr(run)),
    field('Status', run.status),
  ].filter((v): v is SlackBlock => Boolean(v));

  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: title(type), emoji: true } },
    { type: 'section', fields },
  ];

  if (type === 'failed' && run.error) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Error*\n${truncate(run.error)}` } });
  } else if (run.summary) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: truncate(run.summary) }] });
  }

  return blocks;
}
