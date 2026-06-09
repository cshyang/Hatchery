import { defineConfig } from '@trigger.dev/sdk';
import { aptGet, additionalPackages, additionalFiles } from '@trigger.dev/build/extensions/core';

export default defineConfig({
  project: 'proj_vmlezgoianzbhanptfog',
  dirs: ['./trigger'],
  runtime: 'node-22', // pi-coding-agent requires node >=22.19; Trigger's default "node" image is 21.x → pi crashes on require(ESM).
  maxDuration: 2700, // seconds; 45 min. Hatchery's 3h reaper is the backstop (a maxDuration kill skips cleanup hooks).
  build: {
    // Cloud runner (`trigger deploy` → Debian 12 container). `trigger dev` ignores these — locally
    // pi/git/kit come from the dev machine. See docs/superpowers/plans/2026-06-07-m0b-bite2-*.
    extensions: [
      aptGet({ packages: ['git'] }), // clone/push need git; not guaranteed in the base image
      // pi is SPAWNED, not imported, so the esbuild bundler never includes it — `additionalPackages`
      // installs it (and its bin) into the bundle's node_modules. Pinned to the dev machine's version.
      // The capability extensions are loaded by run-coding-task via `-e <path>` (the container has no
      // ~/.pi settings.json, so packages can't be auto-discovered). ask-user is deliberately NOT
      // bundled: it blocks on human input and would hang a non-interactive `pi -p` run. Offline is
      // lifted in run-coding-task so web-access/mcp-adapter can reach the network.
      additionalPackages({
        packages: [
          '@earendil-works/pi-coding-agent@0.78.0',
          'pi-subagents@0.27.0',
          'pi-web-access@0.10.7',
          'pi-mcp-adapter@2.9.0',
          '@jerryan/pi-todo-lite@1.0.1',
        ],
      }),
      // ship the kit; lands at bundle root, where run-coding-task's process.cwd()-based path resolves it.
      additionalFiles({ files: ['agent-kits/coding-default/**'] }),
    ],
  },
});
