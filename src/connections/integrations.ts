export type ConnectionAuthMode = 'oauth' | 'pat' | 'app';

export type NangoIntegrationKeys = Record<string, string | Partial<Record<ConnectionAuthMode, string>>>;

const DEFAULT_KEYS: Record<string, Partial<Record<ConnectionAuthMode, string>>> = {
  github: { oauth: 'github', pat: 'github-pat', app: 'github-app' },
  linear: { oauth: 'linear' },
  notion: { oauth: 'notion' },
};

const AUTH_MODES: Record<string, ConnectionAuthMode[]> = {
  github: ['oauth', 'pat', 'app'],
  linear: ['oauth'],
  notion: ['oauth'],
};

function clean(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

export function parseNangoIntegrationKeys(raw: unknown): NangoIntegrationKeys {
  if (!raw) return {};
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const out: NangoIntegrationKeys = {};
  for (const [provider, value] of Object.entries(parsed as Record<string, unknown>)) {
    const p = clean(provider)?.toLowerCase();
    if (!p) continue;
    if (typeof value === 'string') {
      const key = clean(value);
      if (key) out[p] = key;
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const modes: Partial<Record<ConnectionAuthMode, string>> = {};
    for (const mode of ['oauth', 'pat', 'app'] as const) {
      const key = clean((value as Record<string, unknown>)[mode]);
      if (key) modes[mode] = key;
    }
    if (Object.keys(modes).length) out[p] = modes;
  }
  return out;
}

export function supportedAuthModes(provider: string): ConnectionAuthMode[] {
  return AUTH_MODES[provider] ?? ['oauth'];
}

export function normalizeAuthMode(provider: string, value: unknown): ConnectionAuthMode | null {
  const mode = (clean(value) ?? 'oauth').toLowerCase();
  if (mode !== 'oauth' && mode !== 'pat' && mode !== 'app') return null;
  return supportedAuthModes(provider).includes(mode) ? mode : null;
}

export function nangoIntegrationKey(
  provider: string,
  authMode: ConnectionAuthMode,
  configured: NangoIntegrationKeys = {},
): string {
  const p = provider.toLowerCase();
  const entry = configured[p];
  if (typeof entry === 'string' && authMode === 'oauth') return entry;
  if (entry && typeof entry === 'object') {
    const key = clean(entry[authMode]);
    if (key) return key;
  }
  return DEFAULT_KEYS[p]?.[authMode] ?? p;
}

export function connectionProviderConfigKey(provider: string, config: Record<string, unknown>): string {
  return clean(config.nangoIntegrationKey) ?? provider;
}

export function normalizeGithubRepo(value: unknown): string | null {
  const raw = clean(value);
  if (!raw) return null;
  const withoutProtocol = raw.replace(/^https?:\/\/github\.com\//i, '').replace(/^git@github\.com:/i, '');
  const withoutSuffix = withoutProtocol.replace(/\.git$/i, '');
  const parts = withoutSuffix.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const repo = parts[1];
  const valid = /^[A-Za-z0-9_.-]+$/;
  if (!valid.test(owner) || !valid.test(repo)) return null;
  return `${owner}/${repo}`;
}

export function nangoConnectionConfig(input: {
  provider: string;
  providerConfigKey: string;
  tags?: Record<string, unknown>;
}): Record<string, unknown> {
  const config: Record<string, unknown> = { nangoIntegrationKey: input.providerConfigKey };
  const provider = input.provider.toLowerCase();
  const taggedMode = clean(input.tags?.auth_mode);
  const authMode = taggedMode ? normalizeAuthMode(provider, taggedMode) : null;
  if (authMode) config.authMode = authMode;
  if (provider === 'github') {
    const repo = normalizeGithubRepo(input.tags?.repo);
    if (repo) config.repo = repo;
  }
  return config;
}
