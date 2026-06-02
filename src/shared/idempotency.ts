// Slack delivers events at-least-once: when we don't ack within 3s it retries,
// redelivering the same `event_id`. With auto-continue enabled, an un-deduped
// retry becomes a second reply in the thread. claimEvent() records each handled
// event_id so a retry is skipped.
//
// CAVEAT: KV is eventually consistent and get-then-put is not atomic, so this is
// "catches essentially every real Slack retry" — retries arrive seconds-to-minutes
// apart, well outside KV's propagation window — NOT a hard exactly-once guarantee.
// If exact dedup ever matters, move this into a Durable Object (strongly
// consistent, single-threaded → atomic check-and-set).

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

const TTL_SECONDS = 60 * 60 * 3; // 3h — comfortably covers Slack's retry window

/**
 * Returns true if this is the first time we've seen `eventId` (caller should
 * proceed), false if it's a duplicate (caller should skip). Fails OPEN when no
 * KV is bound (e.g. a bare local run) — never blocks a real first delivery.
 */
export async function claimEvent(kv: KVLike | undefined, eventId: string): Promise<boolean> {
  if (!kv) return true;
  const key = `evt:${eventId}`;
  if (await kv.get(key)) return false;
  await kv.put(key, '1', { expirationTtl: TTL_SECONDS });
  return true;
}
