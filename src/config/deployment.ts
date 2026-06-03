// Account-coupled deployment config — the values that change when you move this app to another
// Cloudflare account / Slack workspace. WHY this exists: relocating should mean "set env vars",
// not "edit source in three files". Each value is read from `env` with the original literal as a
// fallback, so an existing deployment that sets none of these behaves byte-for-byte as before.
//
// HARD CONSTRAINT: read ONLY from a passed-in `env`. Workers have no ambient env, and the test
// suite runs under tsx (plain Node), so importing `cloudflare:workers` at module scope would break
// tests. Callers (app.ts handlers, the agent initializer) pass `c.env` where it's available.

export interface DeploymentEnv {
  /** Comma-separated Slack team ids allowed to auto-provision a channel on first @mention. */
  KNOWN_TEAM_IDS?: unknown;
  /** Bot user id, for @mention parsing and the auto-created binding's transport_bot_id. */
  SLACK_BOT_ID?: unknown;
  /** Worker-secret NAME holding the default bot token (never the token itself). */
  SLACK_DEFAULT_TOKEN_REF?: unknown;
  [key: string]: unknown;
}

export interface DeploymentConfig {
  knownTeamIds: readonly string[];
  slackBotId: string;
  slackTokenRef: string;
}

// Historical defaults (the original Ecodark workspace). Kept as fallback so a deployment that does
// not set the env vars is unchanged. A new account overrides all three via .env.deploy → secrets.
const DEFAULT_KNOWN_TEAM_IDS: readonly string[] = ['T0B6VB415TQ'];
const DEFAULT_SLACK_BOT_ID = 'U0B6UB2E5HT';
const DEFAULT_SLACK_TOKEN_REF = 'SLACK_BOT_TOKEN_DEFAULT';

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function list(value: unknown): string[] | undefined {
  const s = str(value);
  if (!s) return undefined;
  const items = s.split(',').map((x) => x.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

export function deploymentConfig(env: DeploymentEnv = {}): DeploymentConfig {
  return {
    knownTeamIds: list(env.KNOWN_TEAM_IDS) ?? DEFAULT_KNOWN_TEAM_IDS,
    slackBotId: str(env.SLACK_BOT_ID) ?? DEFAULT_SLACK_BOT_ID,
    slackTokenRef: str(env.SLACK_DEFAULT_TOKEN_REF) ?? DEFAULT_SLACK_TOKEN_REF,
  };
}

// The auto-provision wall: a stray @mention from an unlisted workspace is never auto-bound. Reads
// the allowlist from env per call so a new account's KNOWN_TEAM_IDS takes effect without a code edit.
export function isKnownTeam(env: DeploymentEnv, teamId: string): boolean {
  return !!teamId && deploymentConfig(env).knownTeamIds.includes(teamId);
}
