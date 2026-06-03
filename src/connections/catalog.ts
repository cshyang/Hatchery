export interface ProviderCatalogEntry {
  provider: string;
  summary: string;
}

// The provider catalog (what Hatchery supports at all). Curated platform-side; the agent picks
// from it, never adds to it.
export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  { provider: 'github', summary: 'read issues/code, search (creating issues comes later, with approval)' },
  { provider: 'linear', summary: 'team issue workflow and agent-run trigger routes (route activation needs admin approval)' },
  { provider: 'notion', summary: 'read pages/databases, search (read-only token)' },
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
