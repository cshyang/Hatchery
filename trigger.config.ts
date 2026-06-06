import { defineConfig } from '@trigger.dev/sdk';

export default defineConfig({
  project: 'proj_vmlezgoianzbhanptfog',
  dirs: ['./trigger'],
  maxDuration: 2700, // seconds; 45 min. Hatchery's 3h reaper is the backstop (a maxDuration kill skips cleanup hooks).
});
