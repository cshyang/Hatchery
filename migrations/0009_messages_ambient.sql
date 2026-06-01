-- Ambient-ingestion flag for the transcript (Layer 2). Apply:
-- npx wrangler d1 execute hatchery-skills --remote --file=migrations/0009_messages_ambient.sql
--
-- ambient=1 marks a message the bot OVERHEARD in a bound channel but did not engage with
-- (no @mention, not a thread it's in). These rows build the cross-thread index (Layer 3) and
-- feed the proactive review (Layer 4). Nightly REM (reflection) filters them out with
-- `AND ambient = 0`, so overheard chatter never gets consolidated into the curated memory.
--
-- No backfill: every existing row is an engaged message, and DEFAULT 0 classifies it correctly.

ALTER TABLE messages ADD COLUMN ambient INTEGER NOT NULL DEFAULT 0;
