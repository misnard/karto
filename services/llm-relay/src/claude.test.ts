import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LlmPayload, LlmResultSchema } from '@karto/contracts';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { claudeArgs, parseClaudeOutput, runClaude } from './claude.ts';

const payload: LlmPayload = {
  purpose: 'parse',
  model: 'claude-haiku-5-5',
  system: 'You parse shopping lists.',
  user: 'SECRET-PROMPT lait, oeufs',
  jsonSchema: { type: 'object', properties: { items: { type: 'array' } }, required: ['items'] },
};

const usage = { input_tokens: 2, output_tokens: 53, cache_read_input_tokens: 100, cache_creation_input_tokens: 1154 };
const output = (fields: Record<string, unknown>) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, usage, total_cost_usd: 0.0003, ...fields });

describe('claudeArgs', () => {
  it('builds the verified invocation, prompt excluded', () => {
    expect(claudeArgs(payload)).toEqual([
      '-p',
      '--output-format',
      'json',
      '--model',
      'claude-haiku-5-5',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--tools',
      '',
      '--system-prompt',
      'You parse shopping lists.',
      '--json-schema',
      '{"type":"object","properties":{"items":{"type":"array"}},"required":["items"]}',
    ]);
    expect(claudeArgs(payload).join(' ')).not.toContain('SECRET-PROMPT');
  });
});

describe('parseClaudeOutput', () => {
  it('uses structured_output and sums all input tokens', () => {
    const result = parseClaudeOutput(output({ result: 'ignored', structured_output: { items: ['lait'] } }));
    expect(result).toEqual({ text: '{"items":["lait"]}', usage: { inputTokens: 1256, outputTokens: 53 } });
    expect(() => LlmResultSchema.parse(result)).not.toThrow();
  });

  it('falls back to result without structured_output', () => {
    const stdout = output({ result: 'plain text', usage: { input_tokens: 5, output_tokens: 7 } });
    expect(parseClaudeOutput(stdout)).toEqual({ text: 'plain text', usage: { inputTokens: 5, outputTokens: 7 } });
  });

  it.each([
    ['is_error', output({ is_error: true, api_error_status: 404, result: 'MODEL-OUTPUT' }), /API status 404/],
    ['error subtype', output({ subtype: 'error_max_turns', result: 'MODEL-OUTPUT' }), /error_max_turns/],
    ['not JSON', 'MODEL-OUTPUT is not json', /not JSON/],
    [
      'missing usage',
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'MODEL-OUTPUT' }),
      /usage/,
    ],
    ['no text', output({}), /neither structured_output nor result/],
  ])('throws on %s without leaking the output', (_name, stdout, message) => {
    expect(() => parseClaudeOutput(stdout)).toThrow(message);
    try {
      parseClaudeOutput(stdout);
    } catch (err) {
      expect((err as Error).message).not.toContain('MODEL-OUTPUT');
    }
  });
});

describe('runClaude', () => {
  // A stand-in for the claude binary: reports what it received through its structured output.
  const binDir = mkdtempSync(join(tmpdir(), 'karto-fake-claude-'));
  const bin = join(binDir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
let stdin = '';
process.stdin.on('data', (c) => (stdin += c));
process.stdin.on('end', () => {
  const mode = process.env.FAKE_CLAUDE_MODE;
  if (mode === 'hang') return setTimeout(() => {}, 60_000);
  if (mode === 'error') {
    process.stderr.write('[claude-code:unrecognized_model] ' + 'x'.repeat(300) + '\\nsecond line');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 404,
      result: 'MODEL-OUTPUT', usage: { input_tokens: 0, output_tokens: 0 } }));
    process.exit(1);
  }
  const report = { stdin, args: process.argv.slice(2), cwd: process.cwd(), cwdEntries: fs.readdirSync('.'),
    apiKey: process.env.ANTHROPIC_API_KEY ?? null, relayToken: process.env.RELAY_TOKEN ?? null };
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '',
    structured_output: report, usage: { input_tokens: 1, output_tokens: 2 } }));
});
`,
  );
  chmodSync(bin, 0o755);

  afterEach(() => {
    vi.unstubAllEnvs();
  });
  afterAll(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  it('passes the prompt on stdin, in an empty temp dir, without secrets in env', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('RELAY_TOKEN', 'relay-test');
    const result = await runClaude(payload, { bin });
    const report = JSON.parse(result.text);

    expect(report).toMatchObject({ stdin: payload.user, args: claudeArgs(payload), cwdEntries: [] });
    expect(report.apiKey).toBeNull();
    expect(report.relayToken).toBeNull();
    expect(existsSync(report.cwd)).toBe(false);
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
  });

  it('reports a non-zero exit with status and the first stderr line, never the output', async () => {
    vi.stubEnv('FAKE_CLAUDE_MODE', 'error');
    const err: Error = await runClaude(payload, { bin }).then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: Error) => e,
    );
    expect(err.message).toMatch(
      /^claude exited with code 1 \(subtype success, API status 404\): \[claude-code:unrecognized_model\] x+$/,
    );
    expect(err.message).not.toContain('MODEL-OUTPUT');
    expect(err.message).not.toContain('second line');
    expect(err.message).not.toContain('SECRET-PROMPT');
  });

  it('kills claude after the timeout', async () => {
    vi.stubEnv('FAKE_CLAUDE_MODE', 'hang');
    await expect(runClaude(payload, { bin, timeoutMs: 300 })).rejects.toThrow('claude timed out after 300 ms');
  });

  it('fails clearly when the binary is missing', async () => {
    await expect(runClaude(payload, { bin: join(binDir, 'missing') })).rejects.toThrow(/could not start .*ENOENT/);
  });
});
