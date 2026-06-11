-- Overhearing (Layer 4 v2): per-channel opt-in for instant, capability-judged proactive engagement.
-- 0 (default) = the agent only speaks when @mentioned or following up in its own thread. 1 = it
-- evaluates every non-trivial message on receipt and replies (budgeted) when it can genuinely help.
-- DMs don't use this flag — a 1:1 is always engaged (handled in the ingest path by channel_type).
ALTER TABLE bindings ADD COLUMN overhear INTEGER NOT NULL DEFAULT 0;
