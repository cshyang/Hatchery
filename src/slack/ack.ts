import { postMessage as defaultPostMessage } from './post';

// The instant, deterministic "working" acknowledgement. Posted from the gateway into the reply's
// thread the moment we engage, so a person never stares at silence while the agent turn spins up.
// Naming the specific step is the model's job via update_status; this is just the guaranteed baseline.
export const WORKING_ACK = '👀 On it…';

interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

type SlackPostMessage = (token: string, channel: string, text: string, threadTs?: string) => Promise<void>;

export interface QueueWorkingAckInput {
  executionCtx: WaitUntilContext;
  token?: string;
  channel: string;
  threadTs: string;
  text?: string;
}

export interface QueueWorkingAckDeps {
  postMessage?: SlackPostMessage;
  log?: (message: string) => void;
}

export function queueWorkingAck(
  { executionCtx, token, channel, threadTs, text = WORKING_ACK }: QueueWorkingAckInput,
  deps: QueueWorkingAckDeps = {},
): void {
  if (!token) return;

  const postMessage = deps.postMessage ?? defaultPostMessage;
  const log = deps.log ?? console.log;

  // waitUntil, not await: the ACK is best-effort chrome and must not spend Slack's 3s ack budget.
  executionCtx.waitUntil(
    postMessage(token, channel, text, threadTs).catch((e) =>
      log(`[ack] working-ack failed to post: ${e instanceof Error ? e.message : 'error'}`),
    ),
  );
}
