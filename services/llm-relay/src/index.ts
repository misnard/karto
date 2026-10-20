import { setTimeout as delay } from 'node:timers/promises';
import { runClaude } from './claude.ts';
import { runRelay } from './relay.ts';

// Entry point of `pnpm relay`: polls the Karto API for `llm` jobs and runs them through the local `claude -p`.

const token = process.env.RELAY_TOKEN;
if (!token) {
  console.error('RELAY_TOKEN is missing: set it in apps/api/.dev.vars (loaded by `pnpm relay`) or in the environment.');
  process.exit(1);
}
const apiUrl = (process.env.KARTO_API_URL || 'http://localhost:8787').replace(/\/+$/, '');
const bin = process.env.CLAUDE_BIN || 'claude';

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const controller = new AbortController();
const { signal } = controller;

for (const name of ['SIGINT', 'SIGTERM'] as const) {
  process.on(name, () => {
    if (signal.aborted) process.exit(130);
    log(`${name}: stopping after the current job (send again to quit now)`);
    controller.abort();
  });
}

log(`polling ${apiUrl} for llm jobs, running ${bin}`);
try {
  await runRelay({
    apiUrl,
    token,
    fetch,
    run: (payload) => runClaude(payload, { bin }),
    // An abort only means shutdown: resolve so the loop can exit.
    sleep: (ms) => delay(ms, undefined, { signal }).catch(() => undefined),
    log,
    signal,
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
log('stopped');
