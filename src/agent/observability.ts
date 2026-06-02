// Lightweight turn observability.
//
// Flue exposes no tool-call/step hook, and `wrangler tail` shows logs:[] by default — so a turn
// that runs `outcome:ok` but never replies is a black box. We wrap each tool's execute() to emit
// one structured line per call: name, arg digest, ok/error, duration. With observability enabled
// in wrangler.jsonc, this surfaces the whole tool sequence of a turn in tail — the only window
// into WHY a turn behaved as it did (ran a tool, errored, answered in plain text, never replied).

import type { ToolDefinition } from '@flue/runtime';

function digest(v: unknown, max = 240): string {
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  s = s ?? String(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Delivery nudge. Confirmed failure mode: the model gathers data via tools, then ends the turn in
// plain text without calling the reply tool, so the answer is never delivered. A system-prompt line
// is too distant from that decision; appending a short reminder to each *non-delivery* tool's RESULT
// places it exactly where the model decides its next step. Mitigation, not a guarantee — the durable
// fixes are a more reliable model or a Flue end-of-turn hook.
const DELIVERY_TOOLS = new Set(['reply_to_conversation', 'update_status']);
const REPLY_REMINDER =
  '\n\n[System note — not shown to the user: to say anything you MUST call reply_to_conversation. ' +
  'Text written outside that tool is discarded and the user sees nothing.]';

export function withReplyReminder(tool: ToolDefinition): ToolDefinition {
  if (DELIVERY_TOOLS.has(tool.name)) return tool;
  const orig = tool.execute as ((...a: unknown[]) => Promise<string>) | undefined;
  if (typeof orig !== 'function') return tool;
  return {
    ...tool,
    async execute(...args: unknown[]): Promise<string> {
      return `${await orig(...args)}${REPLY_REMINDER}`;
    },
  } as ToolDefinition;
}

/** Wrap a tool's execute() with entry/exit/error logging. Identity for tools without an execute. */
export function withToolLogging(tool: ToolDefinition): ToolDefinition {
  const orig = tool.execute as ((...a: unknown[]) => Promise<string>) | undefined;
  if (typeof orig !== 'function') return tool;
  return {
    ...tool,
    async execute(...args: unknown[]): Promise<string> {
      const t0 = Date.now();
      console.log(`[tool→] ${tool.name} args=${digest(args[0])}`);
      try {
        const result = await orig(...args);
        console.log(`[tool✓] ${tool.name} ${Date.now() - t0}ms result=${digest(result)}`);
        return result;
      } catch (e) {
        console.log(`[tool✗] ${tool.name} ${Date.now() - t0}ms ERROR=${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
    },
  } as ToolDefinition;
}
