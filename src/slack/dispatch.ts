import { queueSetupFailureFallback, type QueueWorkingAckInput, type SlackPostMessage } from './ack';

export interface DispatchSlackTurnDeps {
  dispatch(request: unknown): Promise<unknown>;
  postMessage?: SlackPostMessage;
  log?: (message: string) => void;
}

export async function dispatchSlackTurnWithFallback(
  dispatchRequest: unknown,
  fallbackTarget: QueueWorkingAckInput,
  deps: DispatchSlackTurnDeps,
): Promise<{ dispatched: boolean }> {
  try {
    await deps.dispatch(dispatchRequest);
    return { dispatched: true };
  } catch (e) {
    const log = deps.log ?? console.log;
    log(`[slack] agent dispatch failed after working ack: ${e instanceof Error ? e.message : 'error'}`);
    queueSetupFailureFallback(fallbackTarget, { postMessage: deps.postMessage, log });
    return { dispatched: false };
  }
}
