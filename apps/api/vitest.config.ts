import { join } from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // Tests run inside workerd with the wrangler.jsonc bindings (local D1). Migrations are read here, in Node,
    // and applied by the setup file inside the worker.
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Explicit test values: never the local .dev.vars secrets.
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(join(import.meta.dirname, 'migrations')),
          LLM_RUNTIME: 'cli',
          LLM_MODEL: 'test-model',
          RELAY_TOKEN: 'test-relay-token',
        },
      },
    })),
  ],
  // node/ tests have their own config (plain Node): `pnpm test` runs both.
  test: { include: ['src/**/*.test.ts'], setupFiles: ['./src/test/apply-migrations.ts'] },
});
