// Worker-level Cloudflare exports, separate from agent modules. Named exports become
// top-level Worker exports — this is how the Sandbox DO class reaches the Worker on
// Flue 0.11+ (replaces the ≤0.9.1 "class_name ends with Sandbox" auto-wiring).
// The default export may contribute non-fetch handlers (e.g. `scheduled`) later — that's
// the phase-2 path for retiring the external ticker Worker.
export { Sandbox } from '@cloudflare/sandbox';
