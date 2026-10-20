import type { LlmPayload } from '@karto/contracts';
import { describe, expect, it, vi } from 'vitest';
import { anthropicClient } from './anthropic.ts';

const payload: LlmPayload = {
  purpose: 'parse',
  model: 'claude-haiku-5-5',
  system: 'Tu convertis une demande de courses.',
  user: '[0] Liste :\nlait',
  jsonSchema: { type: 'object', properties: { lines: { type: 'array' } }, required: ['lines'] },
};

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: '{"lines":' },
      { type: 'text', text: '[]}' },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 150, cache_read_input_tokens: 100, cache_creation_input_tokens: null },
    ...overrides,
  };
}

/** A fetch double answering every call with `body` (status 200 unless given), recording the calls. */
function fakeFetch(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(async () => Response.json(body, { status }));
}

describe('anthropicClient', () => {
  it('asks for structured output and returns the text and usage', async () => {
    const fetchImpl = fakeFetch(message());
    const result = await anthropicClient('test-key', fetchImpl).complete(payload);

    expect(result).toEqual({ text: '{"lines":[]}', usage: { inputTokens: 1000, outputTokens: 150 } });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [input, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(input)).toBe('https://api.anthropic.com/v1/messages');
    expect(new Headers(init?.headers).get('x-api-key')).toBe('test-key');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 16_000,
      system: payload.system,
      messages: [{ role: 'user', content: payload.user }],
      output_config: { format: { type: 'json_schema', schema: payload.jsonSchema } },
    });
  });

  it('returns a truncated output with its usage, for the caller to reject', async () => {
    const truncated = message({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"lin' }] });
    const result = await anthropicClient('test-key', fakeFetch(truncated)).complete(payload);
    expect(result).toEqual({ text: '{"lin', usage: { inputTokens: 1000, outputTokens: 150 } });
  });

  it('throws on an API error', async () => {
    const error = { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } };
    await expect(anthropicClient('bad-key', fakeFetch(error, 401)).complete(payload)).rejects.toThrow(/401/);
  });
});
