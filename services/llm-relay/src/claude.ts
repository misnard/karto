import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LlmPayload, type LlmResult, LlmResultSchema } from '@karto/contracts';
import { z } from 'zod';

const DEFAULT_TIMEOUT_MS = 100_000;
/** Not passed to claude: an API key would bill the API instead of the subscription, and the relay token is ours. */
const STRIPPED_ENV = ['ANTHROPIC_API_KEY', 'RELAY_TOKEN'];

/** Arguments for `claude -p`. The user prompt goes on stdin, never in argv. */
export function claudeArgs(payload: LlmPayload): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--model',
    payload.model,
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--tools',
    '',
    '--system-prompt',
    payload.system,
    '--json-schema',
    JSON.stringify(payload.jsonSchema),
  ];
}

const ClaudeOutputSchema = z.looseObject({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  api_error_status: z.number().nullish(),
  result: z.string().nullish(),
  structured_output: z.unknown().optional(),
  usage: z.looseObject({
    input_tokens: z.int().nonnegative(),
    output_tokens: z.int().nonnegative(),
    cache_read_input_tokens: z.int().nonnegative().nullish(),
    cache_creation_input_tokens: z.int().nonnegative().nullish(),
  }),
});
type ClaudeOutput = z.infer<typeof ClaudeOutputSchema>;

/** Error messages describe the failure only: never the prompt nor the model output. */
export function parseClaudeOutput(stdout: string): LlmResult {
  const out = readOutput(stdout);
  if (typeof out === 'string') throw new Error(out);
  if (out.is_error || out.subtype !== 'success') throw new Error(`claude returned an error (${errorDetail(out)})`);

  const text = out.structured_output != null ? JSON.stringify(out.structured_output) : out.result;
  if (text == null) throw new Error('claude output has neither structured_output nor result');
  const { usage } = out;
  return LlmResultSchema.parse({
    text,
    usage: {
      inputTokens: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens,
    },
  });
}

/** The parsed output, or why it could not be parsed. */
function readOutput(stdout: string): ClaudeOutput | string {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return 'claude output is not JSON';
  }
  const parsed = ClaudeOutputSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  return `unexpected claude output (${issue?.code} at ${issue?.path.map(String).join('.') || '<root>'})`;
}

function errorDetail(out: ClaudeOutput): string {
  return `subtype ${out.subtype}${out.api_error_status ? `, API status ${out.api_error_status}` : ''}`;
}

/** Runs one LLM call through `claude -p`, in a fresh empty directory so no project settings or CLAUDE.md load. */
export async function runClaude(payload: LlmPayload, opts?: { bin?: string; timeoutMs?: number }): Promise<LlmResult> {
  const bin = opts?.bin ?? 'claude';
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = await mkdtemp(join(tmpdir(), 'karto-llm-'));
  try {
    const { code, signal, stdout, stderr } = await spawnClaude(bin, claudeArgs(payload), payload.user, cwd, timeoutMs);
    if (code !== 0) {
      const exit = signal ? `signal ${signal}` : `code ${code}`;
      const out = readOutput(stdout);
      const detail = typeof out === 'string' ? '' : ` (${errorDetail(out)})`;
      const firstLine = stderr.trim().split('\n')[0]?.slice(0, 200);
      throw new Error(`claude exited with ${exit}${detail}${firstLine ? `: ${firstLine}` : ''}`);
    }
    return parseClaudeOutput(stdout);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function spawnClaude(
  bin: string,
  args: string[],
  input: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const env = { ...process.env };
  for (const name of STRIPPED_ENV) delete env[name];

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    // claude may exit before reading all of stdin: its exit status is what matters then.
    child.stdin.on('error', () => undefined);
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(`could not start ${bin}: ${err.code ?? err.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`claude timed out after ${timeoutMs} ms`));
      else resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}
