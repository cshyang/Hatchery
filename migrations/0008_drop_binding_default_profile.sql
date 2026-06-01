-- Drop the dead `default_profile` column from bindings (in the hatchery-skills D1 db).
-- Apply: npx wrangler d1 execute hatchery-skills --remote --file=migrations/0008_drop_binding_default_profile.sql
--
-- Why: default_profile (added in 0006) was vestigial — written by the gateway/operator and
-- read by NOTHING to build agent config. The de-facto persona is the per-project `personality`
-- skill (D1, runtime-editable), not this static label. Persona/voice stays dynamic in the skill
-- system; a future multi-persona-per-channel slice would key on agent_slug + a PersonaConfig row,
-- not this column. So it goes. Forward-only: 0006 still creates it on a fresh DB, this drops it.
--
-- Not in any index (idx_bindings_slack) or the PK (project_id), so DROP COLUMN is a clean ALTER.

ALTER TABLE bindings DROP COLUMN default_profile;
