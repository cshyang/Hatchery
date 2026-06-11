export interface ProviderCatalogEntry {
  provider: string;
  summary: string;
}

// The CURATED provider catalog — the premium tier with hand-written profiles/summaries. Not the
// ceiling: any integration enabled in the Nango project is also connectable (request_connection
// validates live; the webhook persists a fetched API spec; tools fall back to dynamic/proxy
// profiles). Enabling an integration in the Nango dashboard is the only step to add a provider.
export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  { provider: 'github', summary: 'read issues/code, search (creating issues comes later, with approval)' },
  { provider: 'linear', summary: 'team issue workflow and agent-run trigger routes (route activation needs admin approval)' },
  { provider: 'notion', summary: 'read pages/databases, search (read-only token)' },
  { provider: 'tavily', summary: 'web search for current information (read-only search API)' },
];

// Providers that ship hand-written typed tools as a fallback. For these, the generic call_api tool
// is opt-IN via config.apiMode='generic'. Everyone else defaults to the generic tool whenever a
// provider API profile exists.
const TYPED_TOOL_PROVIDERS = new Set<string>(['github']);

export function providerUsesGenericApi(provider: string, config: Record<string, unknown>): boolean {
  if (config.apiMode === 'typed') return false;
  if (config.apiMode === 'generic') return true;
  return !TYPED_TOOL_PROVIDERS.has(provider);
}

export function isCatalogProvider(provider: string, catalog: ProviderCatalogEntry[] = PROVIDER_CATALOG): boolean {
  return catalog.some((p) => p.provider === provider);
}
