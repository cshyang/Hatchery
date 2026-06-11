// Why this lives in our repo when the bug is in @flue/runtime:
//
// Flue's StreamChunkWriter persists every assistant-message stream event verbatim
// to the per-DO SQLite journal so an interrupted turn can be replayed. Each event
// carries a `partial: AssistantMessage` snapshot of the message-so-far, and its
// `content` array grows with every delta. Persisting it on every delta makes a
// single 3-second flush segment O(deltas × message-length) — quadratic — which
// crosses Durable-Object SQLite's ~2 MB per-value ceiling on long/tool-heavy turns
// and throws SQLITE_TOOBIG. The writer then latches `failed = true` and stops
// journaling entirely, so the turn becomes unrecoverable.
//
// `partial.content` is dead weight in the journal: Flue's reconstructInterruptedStream
// rebuilds content from the deltas and *overwrites* partial.content, reading only the
// scalar metadata (id/role/model/usage/...). So dropping it before persistence is
// lossless. This module is the canonical, tested implementation of that transform;
// patches/@flue+runtime+*.patch inlines an identical copy into StreamChunkWriter.write.
// Keeping it here gives the logic regression coverage the node_modules patch can't.

export interface MaybePartialEvent {
  partial?: { content?: unknown[]; [k: string]: unknown };
  [k: string]: unknown;
}

/** Shallow-copy an assistant-message stream event with `partial.content` emptied.
 *  Never mutates the input (the live message_update consumers still need it intact). */
export function stripPartialContent<E extends MaybePartialEvent>(event: E): E {
  if (!event || typeof event !== 'object' || !event.partial || typeof event.partial !== 'object') {
    return event;
  }
  return { ...event, partial: { ...event.partial, content: [] } };
}
