import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Node runtime tests (node:sqlite, node:http) run in plain Node, not in the Workers pool of ../vitest.config.ts.
// The alias plays the part of the resolve hook of server.ts for src/ imports.
export default defineConfig({
  resolve: { alias: { 'cloudflare:workers': fileURLToPath(new URL('./cloudflare-workers.ts', import.meta.url)) } },
  test: { root: import.meta.dirname, environment: 'node' },
});
