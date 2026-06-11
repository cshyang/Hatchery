-- Session epoch + dead-on-arrival tracking: the wedged-thread cure. Apply:
-- npx wrangler d1 execute hatchery-skills --remote --file=migrations/0025_conversation_epoch.sql
--
-- A turn that dies mid-stream can leave the conversation's Flue session (DO-internal history)
-- in a state every later model request chokes on — the thread is wedged forever while the rest
-- of the system is healthy (observed live 2026-06-11). Flue exposes no session repair/delete, but
-- the DO instance id is OURS: agent_epoch versions the id's scope ("conv:<id>~e<n>"), so bumping
-- it abandons the poisoned DO and the next turn starts a fresh session, rehydrated from the
-- durable D1 state (transcript, memory, skills) + thread backscroll. The session is a disposable
-- cache; everything that matters lives here.
--
-- doa_count counts CONSECUTIVE dead-on-arrival turns (receipt created, zero beats, reaped) per
-- conversation. One DOA can be a transient provider flake; two in a row means wedged → the reaper
-- bumps agent_epoch automatically (self-healing, no operator). Any completed turn resets it.

ALTER TABLE conversation_targets ADD COLUMN agent_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE slack_turn_activity ADD COLUMN doa_count INTEGER NOT NULL DEFAULT 0;
