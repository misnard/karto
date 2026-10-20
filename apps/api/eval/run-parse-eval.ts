/**
 * Parse eval (calls the real `claude -p`: run by hand, never in CI).
 * Usage: pnpm --filter @karto/api eval:llm [case-id…]   LLM_MODEL overrides the model.
 * Scores the aggregated lines like the API writes them: required keys, forbidden keys, quantity ranges.
 */
import { PreferencesSchema } from '@karto/contracts';
import { z } from 'zod';
import { runClaude } from '../../../services/llm-relay/src/claude.ts';
import { buildUser, jsonSchema, ParseOutputSchema, system } from '../src/llm/prompts/parse.ts';
import { type AggregatedLine, aggregate } from '../src/pipeline/aggregate.ts';
import { loadCases, matches, normalize, type Outcome, runEval } from './lib.ts';

const model = process.env.LLM_MODEL ?? 'claude-haiku-5-5';

const KeysSchema = z.array(z.string()).min(1);
const CaseSchema = z.strictObject({
  id: z.string(),
  servings: z.int().min(1).max(20).optional(),
  preferences: PreferencesSchema.optional(),
  inputs: z.array(
    z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('text'), text: z.string() }),
      z.strictObject({ kind: z.literal('recipe_text'), text: z.string() }),
    ]),
  ),
  expect: z.strictObject({
    /** Each entry: acceptable keys for one expected line. */
    required: z.array(KeysSchema),
    forbidden: z.array(z.string()).optional(),
    quantities: z
      .array(z.strictObject({ key: KeysSchema, unit: z.enum(['g', 'ml', 'piece']), min: z.number(), max: z.number() }))
      .optional(),
    lineCount: z.strictObject({ min: z.int().optional(), max: z.int().optional() }).optional(),
    /** The query of the line with one of these keys contains `includes` (or one of them). */
    queries: z
      .array(z.strictObject({ key: KeysSchema, includes: z.union([z.string(), z.array(z.string()).min(1)]) }))
      .optional(),
  }),
});
type Case = z.infer<typeof CaseSchema>;

function score(test: Case, lines: AggregatedLine[]): { failures: string[]; checks: number } {
  const { required, forbidden = [], quantities = [], lineCount, queries = [] } = test.expect;
  const failures = [
    ...required.filter((alts) => !lines.some((line) => matches(line.key, alts))).map((alts) => `missing ${alts[0]}`),
    ...forbidden.filter((key) => lines.some((line) => matches(line.key, [key]))).map((key) => `forbidden ${key}`),
    ...quantities
      .filter(({ key, unit, min, max }) => {
        const line = lines.find((l) => matches(l.key, key) && l.unit === unit);
        return !line || line.quantity < min || line.quantity > max;
      })
      .map(({ key, unit, min, max }) => `quantity ${key[0]} not in ${min}..${max} ${unit}`),
    ...queries
      .filter(({ key, includes }) => {
        const line = lines.find((l) => matches(l.key, key));
        const texts = [includes].flat().map(normalize);
        return !line || !texts.some((text) => normalize(line.query).includes(text));
      })
      .map(({ key, includes }) => `query of ${key[0]} without "${[includes].flat().join('" or "')}"`),
  ];
  if (lineCount && !(lines.length >= (lineCount.min ?? 0) && lines.length <= (lineCount.max ?? Infinity))) {
    failures.push(`${lines.length} lines, expected ${lineCount.min ?? 0}..${lineCount.max ?? '∞'}`);
  }
  const checks = required.length + forbidden.length + quantities.length + queries.length + (lineCount ? 1 : 0);
  return { failures, checks };
}

async function run(test: Case): Promise<Outcome> {
  const started = Date.now();
  const payload = {
    purpose: 'parse' as const,
    model,
    system,
    user: buildUser(test.inputs, test.servings, test.preferences),
    jsonSchema,
  };
  const result = await runClaude(payload);
  const seconds = (Date.now() - started) / 1000;
  const parsed = ParseOutputSchema.safeParse(JSON.parse(result.text));
  if (!parsed.success) {
    const { checks } = score(test, []);
    return {
      id: test.id,
      failures: [`invalid output: ${z.prettifyError(parsed.error)}`],
      checks,
      seconds,
      usage: result.usage,
    };
  }
  const lines = aggregate(parsed.data.lines);
  const { failures, checks } = score(test, lines);
  if (failures.length > 0) failures.push(`got: ${lines.map((l) => `${l.key} ${l.quantity} ${l.unit}`).join(' | ')}`);
  return { id: test.id, failures, checks, seconds, usage: result.usage };
}

await runEval(`Parse (${model})`, loadCases('./parse-cases.json', CaseSchema), run, (test) => score(test, []).checks);
