import { postMessage as defaultPostMessage } from './post';

// The instant, deterministic "working" acknowledgement. Posted from the gateway into the reply's
// thread the moment we engage, so a person never stares at silence while the agent turn spins up.
// Naming the specific step is the model's job via update_status; this is just the guaranteed baseline.
export const WORKING_ACK = '👀 On it…';
export const SETUP_FAILURE_FALLBACK =
  'I hit an internal error after starting. Try again in a moment; if it repeats, an operator needs to check the logs.';

interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

export type SlackPostMessage = (token: string, channel: string, text: string, threadTs?: string) => Promise<void>;

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

export function queueSetupFailureFallback(
  input: QueueWorkingAckInput,
  deps: QueueWorkingAckDeps = {},
): void {
  queueSlackMessage({ ...input, text: input.text ?? SETUP_FAILURE_FALLBACK }, '[ack] setup-failure fallback failed to post', deps);
}

function queueSlackMessage(
  { executionCtx, token, channel, threadTs, text }: QueueWorkingAckInput & { text: string },
  logPrefix: string,
  deps: QueueWorkingAckDeps,
): void {
  if (!token) return;

  const postMessage = deps.postMessage ?? defaultPostMessage;
  const log = deps.log ?? console.log;

  executionCtx.waitUntil(
    postMessage(token, channel, text, threadTs).catch((e) =>
      log(`${logPrefix}: ${e instanceof Error ? e.message : 'error'}`),
    ),
  );
}
