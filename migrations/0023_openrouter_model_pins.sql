-- Z.ai is gone: the Worker agent now routes through OpenRouter (DEFAULT_MODEL in
-- src/project/bindings.ts). Clear stale zai/* model pins so those bindings fall back to the
-- new default instead of warning-and-failing against a provider whose key no longer exists.
UPDATE bindings SET model = NULL WHERE model LIKE 'zai/%';
