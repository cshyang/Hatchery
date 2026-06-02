export interface FetchWithTimeoutOptions {
  timeoutMs: number;
  timeoutMessage: string;
  failurePrefix: string;
  fetchImpl?: typeof fetch;
}

export async function fetchWithTimeout(
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  options: FetchWithTimeoutOptions,
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    return await fetchImpl(input, { ...init, signal: AbortSignal.timeout(options.timeoutMs) });
  } catch (e) {
    throw new Error(isTimeoutError(e) ? options.timeoutMessage : `${options.failurePrefix}: ${errorMessage(e)}`);
  }
}

export function jsonMessageOrText(text: string, maxChars: number): string {
  const fallback = text.slice(0, maxChars);
  try {
    return (JSON.parse(text) as { message?: string }).message ?? fallback;
  } catch {
    return fallback;
  }
}

function isTimeoutError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
