import type { LlmPayload, LlmResult } from '@karto/contracts';

/** One LLM call: the payload of an `llm` job in, its raw result out (validated by the caller, like the relay's). */
export interface LlmClient {
  complete(payload: LlmPayload): Promise<LlmResult>;
}
