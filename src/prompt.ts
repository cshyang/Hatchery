// System-prompt assembly for the project agent — a block-composed system prompt scaled to
// this agent's surface.
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
  /** Project id, shown to the agent as the workspace it operates in. */
  projectName: string;
  /** The `personality` skill's body (frontmatter already stripped), or null for the general default. */
  personality: string | null;
  /** L1 skill catalog: names + descriptions, sorted by name. Rendered near the end (semi-volatile). */
  catalog: { name: string; description: string }[];
  /** Pre-rendered "WHAT YOU REMEMBER" block (see src/memory.ts), or null when there's nothing to show.
   *  Passed as an opaque string so this assembler stays pure; it's the most volatile block (changes
   *  whenever memory changes), so it goes LAST. */
  memoryBlock?: string | null;
  /** Pre-rendered "YOUR CONNECTIONS" block (see src/connections.ts), or null. Semi-stable (changes
   *  only when a connection is added/removed), so it sits with the skills catalog, before memory. */
  connectionsBlock?: string | null;
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

// Guidance on AUTHORING skills — kept consistent whether or not the catalog is empty, because
// the failure mode of a self-improving agent is skill SPRAWL (many narrow one-off skills nobody
// finds), not too few skills. So: write broad/class-level, extend before adding, archive (never
// silently abandon) what's wrong. Discovery matches on descriptions, so one umbrella skill with
// labelled sections beats five narrow siblings.
const SKILL_AUTHORING =
  `When a procedure is reusable, capture it with save_skill (full SKILL.md text) — you can schedule it ` +
  `later with set_reminder. Write skills BROAD and class-level, about a screenful: one "research a topic" ` +
  `skill, not five near-duplicates. Before adding one, check your list — if a similar skill exists, EXTEND ` +
  `it (save_skill with its name overwrites) rather than create a sibling. If a skill is wrong or stale, fix ` +
  `it with save_skill; if it's obsolete or folded into another, archive_skill it (reversible — restore_skill ` +
  `brings it back). Don't hoard dead skills.`;

function skillsBlock(catalog: { name: string; description: string }[]): string {
  if (!catalog.length) {
    return `YOUR SKILLS\n` + `You have no saved skills yet. ${SKILL_AUTHORING}`;
  }
  const list = catalog.map((s) => `  - ${s.name}: ${s.description}`).join('\n');
  return (
    `YOUR SKILLS\n` +
    `Before you reply, scan the skills below — if one is even partially relevant to the task, open it with ` +
    `load_skill and follow it. Err on the side of loading; better to have context you don't need than to miss ` +
    `a step or convention.\n` +
    `${list}\n` +
    SKILL_AUTHORING
  );
}

export function buildInstructions(opts: BuildInstructionsOptions): string {
  const { projectName, personality, catalog, memoryBlock, connectionsBlock } = opts;
  const blocks: string[] = [];

  // 1. Identity (stable).
  blocks.push(`You are an autonomous assistant operating in the "${projectName}" project space.`);

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
      `• "message" field → a person's message. Respond helpfully and concisely; pass its "conversationId" to ` +
      `reply_to_conversation so your reply lands in the originating thread/chat.\n` +
      `• "kind":"heartbeat" → a scheduled/self-triggered run, nobody waiting. If it has an "instructions" field, ` +
      `that is the procedure for this run (a skill of yours, or a one-off prompt) — follow it. Else address the ` +
      `"topic" if one is given. If there is nothing meaningful to do, stay silent. When you do post, omit conversationId.\n` +
      `• reply_to_conversation is the ONLY way your words reach the project space. Plain text you write — INCLUDING a ` +
      `complete answer you compose after tool calls — is silently DISCARDED; the user sees nothing. So your turn's FINAL ` +
      `action is ALWAYS a reply_to_conversation call carrying your full answer. Gathering data with tools and then stopping ` +
      `= the user gets silence and the turn has FAILED. Don't mention tools or the dispatch envelope.\n` +
      `• update_status — the moment a person messages, the system already posts a quick "on it" for you, so don't bother with a ` +
      `generic acknowledgement. Reach for update_status only on a SLOW, multi-step turn to name the SPECIFIC thing you're doing ` +
      `(lead with an emoji, e.g. "🔍 Checking the GitHub repo…"), passing the same conversationId. Post it once, up front; skip it ` +
      `for quick answers and heartbeat runs. It is NOT your reply; still send the answer with reply_to_conversation.`,
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

  // 8. Skills catalog — semi-volatile (changes when skills change), so it trails the stable prefix.
  blocks.push(skillsBlock(catalog));

  // 9. Connections — semi-volatile (changes when a connection is added/removed), after skills.
  if (connectionsBlock) blocks.push(connectionsBlock);

  // 10. Memory — MOST volatile (changes per turn and per author), so it goes dead last.
  if (memoryBlock) blocks.push(memoryBlock);

  // 11. Terminal delivery mandate — placed LAST for recency weight. The confirmed silent-agent
  // failure mode is the model gathering data via tools, then ending the turn in plain text without
  // calling reply_to_conversation. This last line fights that directly, after everything else.
  blocks.push(
    `BEFORE YOU STOP\n` +
      `End every turn by calling reply_to_conversation with your complete answer. If you used tools to gather ` +
      `information, you STILL must deliver the result through reply_to_conversation — text written outside that tool is ` +
      `discarded and the user sees nothing. A turn that ends without a reply_to_conversation call has failed.`,
  );

  return blocks.join('\n\n');
}
