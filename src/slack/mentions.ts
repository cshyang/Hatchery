// Slack mention parsing. Slack renders an @mention as "<@U0B6UB2E5HT>" (or "<@U…|label>").
// Provider-specific, so it lives behind the adapter — the front controller passes the binding's
// neutral transportBotId in; the Slack syntax knowledge stays here.

export function mentionsBot(text: string, botUserId: string): boolean {
  return text.includes(`<@${botUserId}`);
}

export function stripMention(text: string, botUserId: string): string {
  return text
    .replace(new RegExp(`<@${botUserId}(\\|[^>]*)?>`, 'g'), '')
    .replace(/\s+/g, ' ')
    .trim();
}
