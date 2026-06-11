// Client-side wall-clock bound on awaits that cross a runtime boundary (Dynamic
// Worker RPC, sandbox container exec). Remote-side limits (cpuMs, container
// timeout) stop runaway *work*, but a peer killed mid-call — e.g. every deploy
// or secret change replaces containers and dynamic workers — leaves the RPC
// await pending forever with no error. This race converts that silent hang into
// a tool error the model can see and retry within the same turn.

export async function withWallClock<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${what} timed out after ${ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`} (wall clock) — the runtime may have restarted mid-call; retry the call`,
              ),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
