/** LlmClient on the Anthropic API (LLM_RUNTIME=api). No cloudflare:* import: Node scripts can use it too. */
import Anthropic from '@anthropic-ai/sdk';
import type { LlmClient } from './client.ts';

const MAX_TOKENS = 16_000;
/** Two tries (one SDK retry on 429, 5xx or network) stay under the 120 s job lease. */
const TIMEOUT_MS = 50_000;

/** `fetchImpl` exists for tests. */
export function anthropicClient(apiKey: string, fetchImpl?: typeof fetch): LlmClient {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: TIMEOUT_MS, fetch: fetchImpl });
  return {
    async complete(payload) {
      const message = await client.messages.create({
        model: payload.model,
        max_tokens: MAX_TOKENS,
        system: payload.system,
        messages: [{ role: 'user', content: payload.user }],
        output_config: { format: { type: 'json_schema', schema: payload.jsonSchema } },
      });
      // A refusal or a truncated output still returns its text and usage: the caller's validation rejects it.
      if (message.stop_reason !== 'end_turn') {
        console.warn('llm stopped early', { purpose: payload.purpose, stopReason: message.stop_reason });
      }
      const { usage } = message;
      return {
        text: message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(''),
        usage: {
          inputTokens:
            usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
          outputTokens: usage.output_tokens,
        },
      };
    },
  };
}
