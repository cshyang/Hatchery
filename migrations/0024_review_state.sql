-- Proactive review (Layer 4) state: watermark + split noise budgets, plus the ingest-time
-- candidate flag on messages. Apply:
-- npx wrangler d1 execute hatchery-skills --remote --file=migrations/0024_review_state.sql
--
-- review_state is separate from reflection_state — the review consumes every ~2 min on its own
-- watermark; reflection consumes nightly on its own. A message is independently seen by both.
-- Budgets are split (spec revision 2026-06-11): answering a question WITH a receipt is service
-- (several/day); an unprompted observation is an interruption (one/day).

CREATE TABLE IF NOT EXISTS review_state (
  project_id               TEXT    PRIMARY KEY,
  last_reviewed_message_id INTEGER NOT NULL DEFAULT 0, -- watermark, advanced by takeReviewBatch (consume-on-take)
  last_reviewed_at         INTEGER,
  last_observation_post_at INTEGER,                    -- ≤1/24h budget for unprompted observations
  answer_posts_today       INTEGER NOT NULL DEFAULT 0, -- ≤N/day budget for proactive answers…
  answer_posts_day         TEXT                        -- …scoped to this UTC calendar day (YYYY-MM-DD)
);

-- Ingest-time heuristic: 1 = the message looks like an answerable question/request (cheap regex,
-- no LLM). The Tier-1 sweep gate only wakes a review turn for projects with unreviewed candidates.
ALTER TABLE messages ADD COLUMN review_candidate INTEGER NOT NULL DEFAULT 0;
