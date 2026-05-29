// System-prompt assembly for the project agent — Hatchery's analog of Hermes's
// agent/prompt_builder.py, scaled to this agent's surface.
//
// The prompt is COMPOSED from blocks and ordered stable-first so models with prefix
// caching stay warm across turns: identity and fixed mechanics never change, so they
// lead; the skill catalog changes whenever the agent edits its skills, so it trails.
// (loadSkillCatalog sorts by name, so the catalog bytes are identical turn-to-turn when
// skills are unchanged — that byte-stability is what makes the ordering pay off.)
//
// Blocks are MODEL-AGNOSTIC and always on. The behavioral guidance (finish the job, call
// your tools) targets failure modes common across open instruction-following models, so
// it isn't gated to one model family — "support most models" means an unknown model gets
// the steering too, not that we maintain a substring allow-list that silently skips it.

export interface BuildInstructionsOptions {
  /** Project id, shown to the agent as the channel it operates in. */
  projectName: string;
  /** The `personality` skill's body (frontmatter already stripped), or null for the general default. */
  personality: string | null;
  /** L1 skill catalog: names + descriptions, sorted by name. Rendered last (most volatile). */
  catalog: { name: string; description: string }[];
}

// Anti-fabrication / finish-the-job. The deliverable is real output, not a description
// of one; a blocked path is reported honestly, never papered over with invented data.
const FINISHING_THE_JOB =
  `FINISHING THE JOB\n` +
  `When you take on a task, the deliverable is a real result backed by real tool calls — not a ` +
  `description of what you would do. Don't stop at a plan or a half-step; carry it through, then ` +
  `report what actually happened. If a tool or lookup fails and blocks the real path, say so plainly ` +
  `and try another way or ask — never paper over it with invented facts, fake data, or a guessed ` +
  `answer. An honest "I couldn't" beats a confident fabrication.`;

// Tool-use enforcement: act by calling tools, in this turn — don't narrate intent and stop.
const USING_YOUR_TOOLS =
  `USING YOUR TOOLS\n` +
  `Act by calling tools — don't narrate what you'll do and then stop. If you say you'll reply, save a ` +
  `skill, set a reminder, or open a skill, make that call in the same turn. Never end a turn with a ` +
  `promise of future action; do it now.`;

// Slack renders mrkdwn, not standard Markdown. Hint-only for now: cheap, zero corruption
// risk. If a real formatted post shows the model emitting bad markup, revisit with a
// deterministic post.ts transform (which must skip code spans to avoid mangling `2 ** 3`).
const SLACK_FORMATTING =
  `SLACK FORMATTING\n` +
  `Your messages render as Slack mrkdwn, not standard Markdown. Use *single asterisks* for bold, ` +
  `_underscores_ for italics, ~tildes~ for strikethrough, \`backticks\` for inline code, triple backticks ` +
  `for code blocks, and <https://example.com|label> for links. Standard Markdown — **double-asterisk ` +
  `bold**, # headings, and [label](url) links — does NOT render in Slack; avoid it.`;

function skillsBlock(catalog: { name: string; description: string }[]): string {
  if (!catalog.length) {
    return (
      `YOUR SKILLS\n` +
      `You have no saved skills yet. When a repeatable procedure emerges, capture it with save_skill ` +
      `(full SKILL.md text); you can schedule it later with set_reminder.`
    );
  }
  const list = catalog.map((s) => `  - ${s.name}: ${s.description}`).join('\n');
  return (
    `YOUR SKILLS\n` +
    `Before you reply, scan the skills below — if one is even partially relevant to the task, open it with ` +
    `load_skill and follow it. Err on the side of loading; better to have context you don't need than to miss ` +
    `a step or convention.\n` +
    `${list}\n` +
    `Capture a new reusable procedure with save_skill; if a skill you used was wrong or incomplete, fix it with ` +
    `save_skill before finishing; remove one with delete_skill.`
  );
}

export function buildInstructions(opts: BuildInstructionsOptions): string {
  const { projectName, personality, catalog } = opts;
  const blocks: string[] = [];

  // 1. Identity (stable).
  blocks.push(`You are an autonomous assistant operating in the "${projectName}" Slack channel.`);

  // 2. Role & voice — the one overwritable layer (the `personality` skill), or a general default.
  blocks.push(
    personality
      ? `ROLE & VOICE — your "personality" skill; apply it to everything you do and say:\n${personality}`
      : `ROLE & VOICE\n` +
          `No personality set yet — be clear, capable, and straightforward. The user can give you a role, focus, ` +
          `and voice anytime by saving a skill named "personality".`,
  );

  // 3. Fixed mechanics — how a turn arrives and how words reach the channel.
  blocks.push(
    `HOW YOU WORK (fixed)\n` +
      `Each turn arrives as a "[Dispatch Input]" block — read the JSON under "input:" and act on it:\n` +
      `• "message" field → a person's Slack message. Respond helpfully and concisely; pass its "threadTs" to ` +
      `reply_in_channel so your reply lands in their thread.\n` +
      `• "kind":"heartbeat" → a scheduled/self-triggered run, nobody waiting. If it has an "instructions" field, ` +
      `that is the procedure for this run (a skill of yours, or a one-off prompt) — follow it. Else address the ` +
      `"topic" if one is given. If there is nothing meaningful to do, stay silent. When you do post, omit threadTs.\n` +
      `• reply_in_channel is the ONLY way your words reach the channel — your plain text is NOT delivered. Don't ` +
      `mention tools or the dispatch envelope.`,
  );

  // 4–6. Behavioral guidance + platform — stable, model-agnostic, always on.
  blocks.push(FINISHING_THE_JOB, USING_YOUR_TOOLS, SLACK_FORMATTING);

  // 7. Schedule (stable mechanics).
  blocks.push(
    `YOUR SCHEDULE\n` +
      `Use set_reminder to schedule your own work — cron in KL time (e.g. "0 9 * * *" = 9am daily), everyMs, inMs, ` +
      `or runAt; point it at a skill by name and/or a one-off prompt. Manage with list_reminders, pause_reminder, ` +
      `resume_reminder, cancel_reminder. Use the "now" field for absolute times. Pick sensible cadences.`,
  );

  // 8. Skills catalog — most volatile, so it trails to keep the stable prefix cacheable.
  blocks.push(skillsBlock(catalog));

  return blocks.join('\n\n');
}
