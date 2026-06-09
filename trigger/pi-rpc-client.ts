// Minimal RPC client for the pi coding agent — PROTOTYPE.
//
// Why hand-rolled: pi ships a typed `RpcClient` in `@earendil-works/pi-coding-agent`, but importing
// it pulls pi's ESM graph into Trigger's esbuild bundle — the `require(ESM)` crash trigger.config.ts
// deliberately avoids. We talk the wire protocol instead (docs/rpc.md): strict LF-only JSONL over the
// child's stdin/stdout. Nothing from pi is imported, so the bundle is untouched.
//
// Two deliberate improvements over the shipped client:
//   1. runPrompt() rejects if pi dies mid-run (shipped waitForIdle only resolves on agent_end or times
//      out — a crash/OOM would hang until the timeout).
//   2. extension_ui_request events are auto-cancelled, so a clarify/confirm can't hang a headless run.
//
// NOTE: outcomeFromEvents() mirrors run-coding-task.ts parsePiStream()'s success/failure logic. When the
// runner migrates from `-p --mode json` to RPC, collapse the two onto this one helper.
import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

interface PiMessage {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  content?: Array<{ type?: string; text?: string; name?: string }>;
}
/** Subset of pi's AgentEvent / RPC envelope we read (full union: @earendil-works/pi-agent-core). */
interface PiEvent {
  type?: string;
  id?: string;
  message?: PiMessage;
  messages?: PiMessage[];
  willRetry?: boolean;
  method?: string;
  toolName?: string;
  args?: unknown;
  isError?: boolean;
}

/** A live progress beat distilled from the event stream — for surfacing to Linear/Slack mid-run. */
export type PiProgress =
  | { kind: 'turn'; text?: string; toolCalls: string[] } // an assistant turn finished
  | { kind: 'tool_start'; tool: string; summary?: string } // a tool began running
  | { kind: 'tool_end'; tool: string; isError: boolean }; // a tool finished

export interface PiOutcome {
  completed: boolean; // saw terminal agent_end (absent ⇒ pi died mid-stream)
  errored: boolean; // final assistant turn stopped with "error"
  errorMessage?: string;
  finalText?: string;
  willRetry: boolean;
}

export interface PiRpcOptions {
  command?: string; // binary to spawn (default: 'pi' — resolved via PATH like the existing runner)
  cwd?: string;
  env?: Record<string, string>;
  provider?: string;
  model?: string;
  args?: string[]; // extra startup flags: --no-session, --thinking, -e <ext>, --skill, --append-system-prompt …
}

function assistantText(msg?: PiMessage): string | undefined {
  const text = (msg?.content ?? [])
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim();
  return text || undefined;
}

/** Distill an ordered AgentEvent list into a pass/fail outcome. Last assistant turn wins. */
export function outcomeFromEvents(events: PiEvent[]): PiOutcome {
  let completed = false;
  let willRetry = false;
  let lastStop: string | undefined;
  let lastError: string | undefined;
  let lastText: string | undefined;
  const consider = (msg?: PiMessage): void => {
    if (msg?.role !== 'assistant') return;
    if (typeof msg.stopReason === 'string') lastStop = msg.stopReason;
    if (typeof msg.errorMessage === 'string') lastError = msg.errorMessage;
    const text = assistantText(msg);
    if (text) lastText = text;
  };
  for (const ev of events) {
    if (ev.type === 'turn_end') consider(ev.message);
    else if (ev.type === 'agent_end') {
      completed = true;
      willRetry = ev.willRetry === true;
      for (const m of ev.messages ?? []) consider(m);
    }
  }
  return { completed, errored: lastStop === 'error', errorMessage: lastError, finalText: lastText, willRetry };
}

/**
 * Parse pi's `--mode json` stdout (newline-delimited JSON) into an outcome — the CLI-path sibling of
 * outcomeFromEvents (the RPC path gets events as objects, the CLI path as JSONL text). Tolerant of
 * non-JSON lines (banners, partial chunks).
 */
export function parsePiStream(stdout: string): PiOutcome {
  const events: PiEvent[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as PiEvent);
    } catch {
      /* tolerate banners / partial lines / non-JSON noise */
    }
  }
  return outcomeFromEvents(events);
}

function toolCallNames(msg?: PiMessage): string[] {
  return (msg?.content ?? [])
    .filter((p) => p?.type === 'toolCall' && typeof p.name === 'string')
    .map((p) => p.name as string);
}

/** A short human-readable hint for what a tool call is doing (file path, bash command). */
function toolSummary(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as { path?: unknown; command?: unknown };
  if (typeof a.path === 'string') return a.path;
  if (typeof a.command === 'string') return a.command.length > 80 ? `${a.command.slice(0, 77)}...` : a.command;
  return undefined;
}

/** Distill a single event into a progress beat, or null if it isn't a progress-worthy event. */
export function progressFromEvent(ev: PiEvent): PiProgress | null {
  switch (ev.type) {
    case 'turn_end':
      return { kind: 'turn', text: assistantText(ev.message), toolCalls: toolCallNames(ev.message) };
    case 'tool_execution_start':
      return { kind: 'tool_start', tool: ev.toolName ?? '', summary: toolSummary(ev.args) };
    case 'tool_execution_end':
      return { kind: 'tool_end', tool: ev.toolName ?? '', isError: ev.isError === true };
    default:
      return null;
  }
}

const UI_BLOCKING = new Set(['select', 'confirm', 'input', 'editor']);

export class PiRpcClient {
  private proc: ChildProcess | null = null;
  private decoder = new StringDecoder('utf8');
  private buf = '';
  private listeners = new Set<(e: PiEvent) => void>();
  private exitWaiters = new Set<(e: Error) => void>();
  private pending = new Map<string, { resolve: (r: PiEvent) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private reqId = 0;
  private stderr = '';
  private exitError: Error | null = null;

  constructor(private opts: PiRpcOptions = {}) {}

  /** PID of the spawned pi process (for logging / observability), or undefined before start/after exit. */
  get pid(): number | undefined {
    return this.proc?.pid;
  }

  async start(): Promise<void> {
    if (this.proc) throw new Error('PiRpcClient already started');
    const args = ['--mode', 'rpc'];
    if (this.opts.provider) args.push('--provider', this.opts.provider);
    if (this.opts.model) args.push('--model', this.opts.model);
    if (this.opts.args) args.push(...this.opts.args);
    const proc = spawn(this.opts.command ?? 'pi', args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    proc.stderr?.on('data', (c) => { this.stderr += c.toString(); });
    proc.stdout?.on('data', (c: Buffer) => this.onStdout(c));
    proc.once('exit', (code, signal) => this.onExit(`pi exited (code=${code} signal=${signal})`));
    proc.once('error', (err) => this.onExit(`pi spawn error: ${err.message}`));
    proc.stdin?.on('error', () => {}); // EPIPE: the exit handler drives the outcome
    await new Promise((r) => setTimeout(r, 100)); // let it boot / fail fast
    if (proc.exitCode !== null) throw this.exitError ?? new Error(`pi exited at startup (code=${proc.exitCode})`);
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 1000);
      proc.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }

  onEvent(listener: (e: PiEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Collected stderr from the pi process (diagnostics). */
  getStderr(): string {
    return this.stderr;
  }

  /**
   * Send a prompt and resolve with the outcome once `agent_end` arrives.
   * Rejects if pi dies mid-run or the timeout elapses. Default timeout 25 min (a coding run is long).
   *
   * `onProgress` fires live for each turn/tool beat — wire it to a Linear/Slack updater to stream
   * progress instead of reporting only at the end. It's best-effort: a throw in the callback is
   * swallowed so a flaky progress sink can't fail the run.
   */
  async runPrompt(
    message: string,
    opts: { onProgress?: (p: PiProgress) => void; timeoutMs?: number } = {},
  ): Promise<PiOutcome> {
    const timeoutMs = opts.timeoutMs ?? 1_500_000;
    const events: PiEvent[] = [];
    const done = new Promise<PiOutcome>((resolve, reject) => {
      let offEvent = () => {};
      let offExit = () => {};
      const timer = setTimeout(() => { settle(); reject(new Error(`pi run timed out after ${timeoutMs}ms`)); }, timeoutMs);
      const settle = () => { clearTimeout(timer); offEvent(); offExit(); };
      offEvent = this.onEvent((ev) => {
        events.push(ev);
        if (opts.onProgress) {
          const beat = progressFromEvent(ev);
          if (beat) {
            try { opts.onProgress(beat); } catch { /* a flaky progress sink must not fail the run */ }
          }
        }
        if (ev.type === 'agent_end') { settle(); resolve(outcomeFromEvents(events)); }
      });
      offExit = this.onExitReject((e) => { settle(); reject(e); });
    });
    await this.send({ type: 'prompt', message }); // throws if pi rejects the prompt before acceptance
    return done;
  }

  private onExitReject(fn: (e: Error) => void): () => void {
    if (this.exitError) { fn(this.exitError); return () => {}; }
    this.exitWaiters.add(fn);
    return () => this.exitWaiters.delete(fn);
  }

  private send(command: Record<string, unknown>): Promise<PiEvent> {
    const stdin = this.proc?.stdin;
    if (!this.proc || !stdin) return Promise.reject(new Error('PiRpcClient not started'));
    if (this.exitError) return Promise.reject(this.exitError);
    const id = `req_${++this.reqId}`;
    return new Promise<PiEvent>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout waiting for ${command.type} response`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    }).then((res) => {
      if ((res as { success?: boolean }).success === false) throw new Error((res as { error?: string }).error ?? `${command.type} failed`);
      return res;
    });
  }

  private onStdout(chunk: Buffer): void {
    this.buf += this.decoder.write(chunk);
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      let line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim()) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let data: PiEvent & { success?: boolean };
    try { data = JSON.parse(line); } catch { return; } // tolerate banners / non-JSON
    if (data.type === 'response' && data.id && this.pending.has(data.id)) {
      const p = this.pending.get(data.id)!;
      this.pending.delete(data.id);
      clearTimeout(p.timer);
      p.resolve(data);
      return;
    }
    if (data.type === 'extension_ui_request') { this.autoCancelUi(data); return; }
    for (const l of this.listeners) l(data);
  }

  /** Autonomous run: decline any UI prompt so the agent proceeds instead of blocking on a human. */
  private autoCancelUi(req: PiEvent): void {
    if (req.method && UI_BLOCKING.has(req.method) && req.id) {
      this.proc?.stdin?.write(`${JSON.stringify({ type: 'extension_ui_response', id: req.id, cancelled: true })}\n`);
    }
  }

  private onExit(message: string): void {
    if (!this.exitError) this.exitError = new Error(`${message}. Stderr: ${this.stderr.slice(-800)}`);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(this.exitError); }
    this.pending.clear();
    for (const w of this.exitWaiters) w(this.exitError);
    this.exitWaiters.clear();
  }
}
