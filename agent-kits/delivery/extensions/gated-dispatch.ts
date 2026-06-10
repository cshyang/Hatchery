/**
 * gated_dispatch — the generator→evaluator loop as a mechanism, not prompt discipline.
 *
 * Runs: generator agent → (optional mechanical prepare commands) → matching reviewer
 * agent(s) in parallel → parse verdict frontmatter from the review ARTIFACT (not chat
 * text) → on any REJECTED, re-dispatch the generator FRESH with objections injected →
 * repeat ≤ max_cycles. Returns ONE typed outcome to the caller (the conductor):
 * approved artifact + review trail, or a typed failure.
 *
 * Children are spawned exactly like pi-subagents does it: `pi --mode json -p
 * --no-session`, agent definition resolved from `.pi/agents/<name>.md`, system prompt
 * via --system-prompt (replace) or --append-system-prompt, final text parsed from the
 * JSONL stream. No dependency on pi-subagents internals (it exposes no public API).
 *
 * Headless-safe: registers a tool, never touches ctx.ui.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const TASK_ARG_LIMIT = 8000;

// ---------- small pure helpers (exported for tests) ----------

/** Minimal frontmatter parser: `key: value` lines plus inline [a, b] and `- item` lists. */
export function parseFrontmatterLite(src: string): { fm: Record<string, unknown>; body: string } {
	const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!m) return { fm: {}, body: src };
	const fm: Record<string, unknown> = {};
	let lastKey: string | null = null;
	for (const rawLine of m[1].split(/\r?\n/)) {
		const line = rawLine.replace(/\s+$/, "");
		if (!line || line.trimStart().startsWith("#")) continue;
		const cont = line.match(/^\s+-\s+(.*)$/);
		if (cont && lastKey) {
			const arr = Array.isArray(fm[lastKey]) ? (fm[lastKey] as unknown[]) : [];
			arr.push(stripQuotes(cont[1]));
			fm[lastKey] = arr;
			continue;
		}
		const kv = line.match(/^([\w-]+):\s*(.*)$/);
		if (!kv) continue;
		lastKey = kv[1];
		const raw = kv[2].trim();
		if (raw === "") { fm[lastKey] = []; continue; } // list header — items follow
		if (raw.startsWith("[") && raw.endsWith("]")) {
			fm[lastKey] = raw.slice(1, -1).split(",").map((s) => stripQuotes(s.trim())).filter(Boolean);
		} else {
			fm[lastKey] = stripQuotes(raw);
		}
	}
	return { fm, body: src.slice(m[0].length) };
}

function stripQuotes(s: string): string {
	return s.replace(/^["']/, "").replace(/["']$/, "");
}

/** Next review file path: scan dir for `<prefix>NN.md`, return max+1 zero-padded to 2. */
export function nextReviewPath(dir: string, prefix: string): string {
	let max = 0;
	if (fs.existsSync(dir)) {
		for (const f of fs.readdirSync(dir)) {
			const m = f.match(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)\\.md$`));
			if (m) max = Math.max(max, Number(m[1]));
		}
	}
	return path.join(dir, `${prefix}${String(max + 1).padStart(2, "0")}.md`);
}

/** Pull the actionable objections out of a REJECTED review: frontmatter fields + the "Specific objections" / "must do next" sections. */
export function extractObjections(fm: Record<string, unknown>, body: string): string {
	const parts: string[] = [];
	if (fm["blocking-objection"] && fm["blocking-objection"] !== "null") {
		parts.push(`Blocking objection: ${fm["blocking-objection"]}`);
	}
	const failed = fm["failed-checks"];
	if (Array.isArray(failed) && failed.length) parts.push(`Failed checks: ${failed.join(", ")}`);
	for (const heading of ["Specific objections", "What the author must do next", "What the deliver-planner must do next"]) {
		const start = body.search(new RegExp(`^##[^\\n]*${heading}`, "m"));
		if (start === -1) continue;
		const afterHeading = body.indexOf("\n", start) + 1;
		if (afterHeading === 0) continue;
		const nextSection = body.indexOf("\n## ", afterHeading);
		const sec = body.slice(afterHeading, nextSection === -1 ? undefined : nextSection).trim();
		if (sec) parts.push(`${heading}:\n${sec}`);
	}
	return parts.join("\n\n");
}

export function applyThinkingSuffix(model: string | undefined, thinking: string | undefined): string | undefined {
	if (!model || !thinking || thinking === "off") return model;
	const idx = model.lastIndexOf(":");
	if (idx !== -1 && THINKING_LEVELS.includes(model.slice(idx + 1))) return model;
	return `${model}:${thinking}`;
}

function substitute(template: string, vars: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
}

// ---------- agent resolution ----------

interface AgentDef {
	name: string;
	systemPrompt: string;
	systemPromptMode: "append" | "replace";
	tools?: string[];
	model?: string;
	thinking?: string;
}

function resolveAgent(name: string, cwd: string): AgentDef {
	const candidates: string[] = [];
	let dir = cwd;
	for (;;) {
		candidates.push(path.join(dir, ".pi", "agents", `${name}.md`));
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	candidates.push(path.join(os.homedir(), ".pi", "agent", "agents", `${name}.md`));
	const file = candidates.find((p) => fs.existsSync(p));
	if (!file) throw new Error(`agent definition not found: ${name} (looked in .pi/agents up from ${cwd})`);
	const { fm, body } = parseFrontmatterLite(fs.readFileSync(file, "utf8"));
	const tools = typeof fm.tools === "string"
		? (fm.tools as string).split(",").map((t) => t.trim()).filter((t) => t && t !== "subagent" && t !== "gated_dispatch")
		: undefined;
	return {
		name,
		systemPrompt: body,
		systemPromptMode: fm.systemPromptMode === "append" ? "append" : "replace",
		tools,
		model: typeof fm.model === "string" ? (fm.model as string) : undefined,
		thinking: typeof fm.thinking === "string" ? (fm.thinking as string) : undefined,
	};
}

// ---------- child spawn ----------

interface ChildResult { exitCode: number; finalText: string; stderrTail: string; }

function runPiChild(
	agent: AgentDef,
	task: string,
	model: string | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
	sessionFile?: string,
): Promise<ChildResult> {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gated-dispatch-"));
	const args = ["--mode", "json", "-p"];
	if (sessionFile) args.push("--session", sessionFile);
	else args.push("--no-session");
	const modelArg = applyThinkingSuffix(model ?? agent.model, agent.thinking);
	if (modelArg) args.push("--model", modelArg);
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
	const promptPath = path.join(tempDir, "prompt.md");
	fs.writeFileSync(promptPath, agent.systemPrompt, { mode: 0o600 });
	args.push(agent.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", promptPath);
	if (task.length > TASK_ARG_LIMIT) {
		const taskPath = path.join(tempDir, "task.md");
		fs.writeFileSync(taskPath, `Task: ${task}`, { mode: 0o600 });
		args.push(`@${taskPath}`);
	} else {
		args.push(`Task: ${task}`);
	}

	return new Promise<ChildResult>((resolve) => {
		const child = spawn("pi", args, { cwd, stdio: ["ignore", "pipe", "pipe"], signal });
		let buf = "";
		let finalText = "";
		const stderrChunks: string[] = [];
		child.stdout.on("data", (d: Buffer) => {
			buf += d.toString();
			let nl: number;
			while ((nl = buf.indexOf("\n")) !== -1) {
				const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
				if (!line.trim()) continue;
				try {
					const ev = JSON.parse(line);
					if (ev.type === "message_end" && ev.message?.role === "assistant") {
						const text = (ev.message.content ?? [])
							.filter((c: { type: string }) => c.type === "text")
							.map((c: { text: string }) => c.text).join("\n");
						if (text.trim()) finalText = text;
					}
				} catch { /* non-JSON line — ignore */ }
			}
		});
		child.stderr.on("data", (d: Buffer) => {
			stderrChunks.push(d.toString());
			while (stderrChunks.length > 20) stderrChunks.shift();
		});
		child.on("error", (err) => resolve({ exitCode: -1, finalText, stderrTail: String(err) }));
		child.on("close", (code) => {
			fs.rmSync(tempDir, { recursive: true, force: true });
			resolve({ exitCode: code ?? -1, finalText, stderrTail: stderrChunks.join("").slice(-2000) });
		});
	});
}

function runShell(command: string, cwd: string, timeoutS: number): Promise<{ exitCode: number; tail: string }> {
	return new Promise((resolve) => {
		const child = spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutS * 1000 });
		const chunks: string[] = [];
		const keep = (d: Buffer) => { chunks.push(d.toString()); while (chunks.length > 20) chunks.shift(); };
		child.stdout.on("data", keep);
		child.stderr.on("data", keep);
		child.on("error", (err) => resolve({ exitCode: -1, tail: String(err) }));
		child.on("close", (code) => resolve({ exitCode: code ?? -1, tail: chunks.join("").slice(-2000) }));
	});
}

// ---------- the tool ----------

interface ReviewerSpec {
	agent: string;
	artifact_kind?: string;
	task_template: string;
	review_dir: string;
	review_prefix: string;
	model?: string;
	context?: "fresh" | "warm";
}

interface GateParams {
	generator: string;
	task: string;
	artifacts: { path: string; kind?: string }[];
	reviewers: ReviewerSpec[];
	generator_model?: string;
	generator_context?: "fresh" | "warm";
	max_cycles?: number;
	prepare?: { command: string; timeout_s?: number }[];
	cwd?: string;
}

interface ReviewRecord { cycle: number; agent: string; path: string; verdict: string; }
interface GateDetails {
	status: "approved" | "rejected-beyond-cycles" | "generator-error" | "missing-artifact"
		| "prepare-error" | "reviewer-error" | "malformed-verdict";
	cycles: number;
	artifact_path?: string;
	artifact_kind?: string;
	reviews: ReviewRecord[];
	last_objections?: string;
	error?: string;
}

const parametersSchema = {
	type: "object",
	properties: {
		generator: { type: "string", description: "Agent name of the artifact author (resolved from .pi/agents)" },
		task: { type: "string", description: "Full rendered task prompt for the generator — pre-inject ALL context, exactly as a manual dispatch" },
		artifacts: {
			type: "array", minItems: 1,
			items: { type: "object", properties: { path: { type: "string", description: "Path the generator may write" }, kind: { type: "string", description: "Artifact kind override; defaults to the artifact's `artifact:` frontmatter" } }, required: ["path"] },
			description: "Candidate artifact paths the generator may produce (e.g. spec.md AND decomposition.md); the one written this cycle is reviewed",
		},
		reviewers: {
			type: "array", minItems: 1,
			items: {
				type: "object",
				properties: {
					agent: { type: "string" },
					artifact_kind: { type: "string", description: "Only dispatch this reviewer when the produced artifact has this kind; omit = always" },
					task_template: { type: "string", description: "Reviewer prompt; placeholders {artifact_path} {artifact_kind} {review_path} {cycle} {prior_reviews} (paths+verdicts of this gate's earlier reviews — include it so a fresh reviewer gets objection continuity from disk)" },
					review_dir: { type: "string", description: "Directory for review artifacts" },
					review_prefix: { type: "string", description: "Review filename prefix, e.g. 'review-' → review-NN.md (NN auto-incremented, append-only)" },
					model: { type: "string", description: "Full model string, e.g. openrouter/deepseek/deepseek-v4-pro:high" },
					context: { type: "string", enum: ["fresh", "warm"], description: "Replan context policy for THIS reviewer. 'fresh' (default): new judge each cycle — pair with {prior_reviews} for disk-backed continuity without conversational momentum. 'warm': cycles ≥2 resume this reviewer's own session (knows exactly what it objected to; cheaper) — risk is comment-addressed tunnel vision, so warm rounds are auto-prefixed with a re-judge-the-entire-artifact guard" },
				},
				required: ["agent", "task_template", "review_dir", "review_prefix"],
			},
			description: "Evaluators. All matching reviewers run in parallel each cycle; ANY REJECTED loops the generator with objections injected",
		},
		generator_model: { type: "string", description: "Full model string for the generator; omit to use the agent default / parent model" },
		generator_context: { type: "string", enum: ["fresh", "warm"], description: "Replan context policy for the GENERATOR. 'fresh' (default): every cycle is a brand-new child seeing task+objections — anti-anchoring, forces a real rewrite. 'warm': cycles ≥2 resume the generator's own session (it keeps its exploration and reasoning; objections arrive as the next message) — cheaper, but the generator may defend instead of rewrite. Each reviewer has its own per-entry `context` knob. All sessions are gate-scoped scratch, deleted when the gate returns — durability stays with committed artifacts" },
		max_cycles: { type: "number", description: "Generator attempts before rejected-beyond-cycles (default 3)" },
		prepare: {
			type: "array",
			items: { type: "object", properties: { command: { type: "string", description: "bash command run between generator and reviewers each cycle; placeholders {artifact_path} {artifact_kind} {cycle}" }, timeout_s: { type: "number" } }, required: ["command"] },
			description: "Mechanical pre-review steps (extract diff, assertions, baseline runs). Non-zero exit fails the gate as prepare-error",
		},
		cwd: { type: "string", description: "Working directory (defaults to session cwd)" },
	},
	required: ["generator", "task", "artifacts", "reviewers"],
} as const;

export default function gatedDispatch(pi: ExtensionAPI) {
	pi.registerTool({
		name: "gated_dispatch",
		label: "Gated dispatch",
		description:
			"Run a generator→reviewer loop as one mechanical operation: dispatch the generator agent (fresh context), run optional prepare commands, dispatch the matching reviewer agent(s) in parallel, parse the review artifact's verdict frontmatter, and on any REJECTED re-dispatch the generator fresh with the objections injected — up to max_cycles. Returns one typed outcome: approved (artifact path + review trail) or a typed failure (rejected-beyond-cycles, malformed-verdict, generator-error, reviewer-error, prepare-error, missing-artifact). Use for every generator–evaluator pair (plan→spec/decomposition review, oracle write→oracle review, implement→implementation/security review). Do NOT hand-route those legs with individual subagent calls.",
		parameters: parametersSchema as never,
		async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
			const p = rawParams as unknown as GateParams;
			const cwd = p.cwd ?? ctx.cwd;
			const maxCycles = p.max_cycles ?? 3;
			const reviews: ReviewRecord[] = [];
			const fail = (status: GateDetails["status"], error: string, extra: Partial<GateDetails> = {}) => ({
				content: [{ type: "text" as const, text: `gated_dispatch ${status}: ${error}` }],
				details: { status, cycles: reviews.length ? reviews[reviews.length - 1].cycle : 0, reviews, error, ...extra } as GateDetails,
				isError: true,
			});

			let generatorDef: AgentDef;
			let reviewerDefs: Map<string, AgentDef>;
			try {
				generatorDef = resolveAgent(p.generator, cwd);
				reviewerDefs = new Map(p.reviewers.map((r) => [r.agent, resolveAgent(r.agent, cwd)]));
			} catch (e) {
				return fail("generator-error", String(e instanceof Error ? e.message : e));
			}

			// warm mode: session files are gate-scoped scratch — they let cycle N+1 resume an
			// agent's own context instead of cold-starting. Deleted on return: durability
			// stays with committed artifacts, never with sessions.
			const warm = p.generator_context === "warm";
			const anyWarm = warm || p.reviewers.some((r) => r.context === "warm");
			const gateTmp = anyWarm ? fs.mkdtempSync(path.join(os.tmpdir(), "gated-session-")) : undefined;
			const genSession = warm && gateTmp ? path.join(gateTmp, "generator-session.jsonl") : undefined;
			try {
			let objections = "";
			for (let cycle = 1; cycle <= maxCycles; cycle++) {
				// 1. generator — fresh child each cycle (default), or warm-resumed session; objections injected
				onUpdate?.({ status: `cycle ${cycle}/${maxCycles}: ${p.generator}`, cycles: cycle, reviews } as never);
				const genTask = !objections
					? p.task
					: warm
						? `## Reviewer objections (cycle ${cycle - 1}) — address every one and revise your artifact in place\n\n${objections}\n\nVerify each objection against the artifact before changing anything; fix what is right, and record (in the artifact, not in chat) why anything you decline to change is technically wrong. Do not start a new artifact.`
						: `${p.task}\n\n## Prior review objections (cycle ${cycle - 1}) — fix these, do not relitigate\n\n${objections}`;
				const genStart = Date.now();
				const gen = await runPiChild(generatorDef, genTask, p.generator_model, cwd, signal, genSession);
				if (gen.exitCode !== 0) return fail("generator-error", `${p.generator} exited ${gen.exitCode}: ${gen.stderrTail || gen.finalText}`);

				// 2. locate the produced artifact among candidates (written/updated this cycle)
				const produced = p.artifacts
					.map((a) => ({ ...a, abs: path.resolve(cwd, a.path) }))
					.filter((a) => fs.existsSync(a.abs) && fs.statSync(a.abs).mtimeMs >= genStart - 2000);
				const artifact = produced[0]
					?? p.artifacts.map((a) => ({ ...a, abs: path.resolve(cwd, a.path) })).find((a) => fs.existsSync(a.abs));
				if (!artifact) return fail("missing-artifact", `${p.generator} returned 0 but wrote none of: ${p.artifacts.map((a) => a.path).join(", ")}`);
				const artifactFm = parseFrontmatterLite(fs.readFileSync(artifact.abs, "utf8")).fm;
				const kind = (typeof artifactFm.artifact === "string" && artifactFm.artifact)
					|| artifact.kind || path.basename(artifact.path, ".md");

				// 3. mechanical prepare steps
				const vars = { artifact_path: artifact.abs, artifact_kind: String(kind), cycle: String(cycle) };
				for (const prep of p.prepare ?? []) {
					const r = await runShell(substitute(prep.command, vars), cwd, prep.timeout_s ?? 120);
					if (r.exitCode !== 0) return fail("prepare-error", `prepare \`${prep.command}\` exited ${r.exitCode}: ${r.tail}`, { artifact_path: artifact.abs, artifact_kind: String(kind) });
				}

				// 4. matching reviewers, in parallel; each reads/writes its own review artifact
				const matching = p.reviewers.filter((r) => !r.artifact_kind || r.artifact_kind === kind);
				if (!matching.length) return fail("reviewer-error", `no reviewer matches artifact kind "${kind}"`, { artifact_path: artifact.abs, artifact_kind: String(kind) });
				onUpdate?.({ status: `cycle ${cycle}/${maxCycles}: reviewing (${matching.map((m) => m.agent).join(", ")})`, cycles: cycle, reviews } as never);
				const priorReviews = reviews.length
					? reviews.map((rv) => `${rv.path} (${rv.agent}, cycle ${rv.cycle}: ${rv.verdict})`).join("\n")
					: "(none)";
				const legs = await Promise.all(matching.map(async (r) => {
					const reviewPath = nextReviewPath(path.resolve(cwd, r.review_dir), r.review_prefix);
					fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
					let task = substitute(r.task_template, { ...vars, review_path: reviewPath, prior_reviews: priorReviews });
					const warmReviewer = r.context === "warm" && gateTmp !== undefined;
					if (warmReviewer && cycle > 1) {
						// guard against comment-addressed tunnel vision: a warm round must re-judge
						// the whole artifact, not just check its own prior objections off
						task = `Re-judge the ENTIRE revised artifact against the full rubric — not only whether your prior objections were addressed. Defects newly introduced by the revision are equally in scope, and every rubric check needs fresh evidence from the current artifact.\n\n${task}`;
					}
					const sessionFile = warmReviewer
						? path.join(gateTmp!, `reviewer-${r.agent.replace(/[^\w-]/g, "_")}.jsonl`)
						: undefined;
					const res = await runPiChild(reviewerDefs.get(r.agent)!, task, r.model, cwd, signal, sessionFile);
					return { spec: r, reviewPath, res };
				}));

				// 5. parse verdicts from the review ARTIFACTS (artifacts are truth, chat text is not)
				objections = "";
				let anyRejected = false;
				for (const leg of legs) {
					if (leg.res.exitCode !== 0) return fail("reviewer-error", `${leg.spec.agent} exited ${leg.res.exitCode}: ${leg.res.stderrTail || leg.res.finalText}`, { artifact_path: artifact.abs, artifact_kind: String(kind) });
					if (!fs.existsSync(leg.reviewPath)) return fail("malformed-verdict", `${leg.spec.agent} wrote no review artifact at ${leg.reviewPath}`, { artifact_path: artifact.abs, artifact_kind: String(kind) });
					const { fm, body } = parseFrontmatterLite(fs.readFileSync(leg.reviewPath, "utf8"));
					const verdict = typeof fm.verdict === "string" ? fm.verdict : "";
					if (verdict !== "APPROVED" && verdict !== "REJECTED") {
						return fail("malformed-verdict", `${leg.spec.agent} verdict "${verdict}" is not APPROVED|REJECTED (${leg.reviewPath})`, { artifact_path: artifact.abs, artifact_kind: String(kind) });
					}
					reviews.push({ cycle, agent: leg.spec.agent, path: leg.reviewPath, verdict });
					if (verdict === "REJECTED") {
						anyRejected = true;
						const obj = extractObjections(fm, body);
						objections += `### Objections from ${leg.spec.agent} (${path.basename(leg.reviewPath)})\n\n${obj || body.slice(0, 4000)}\n\n`;
					}
				}

				if (!anyRejected) {
					return {
						content: [{ type: "text" as const, text: `APPROVED after ${cycle} cycle(s): ${artifact.path} (${kind}). Reviews: ${reviews.map((r) => `${r.agent}#${r.cycle}=${r.verdict}`).join(", ")}` }],
						details: { status: "approved", cycles: cycle, artifact_path: artifact.abs, artifact_kind: String(kind), reviews } as GateDetails,
					};
				}
			}

			return fail("rejected-beyond-cycles", `still REJECTED after ${maxCycles} cycle(s) — park the issue with the latest objections`, { last_objections: objections.slice(0, 6000) });
			} finally {
				if (gateTmp) fs.rmSync(gateTmp, { recursive: true, force: true });
			}
		},
	});
}
