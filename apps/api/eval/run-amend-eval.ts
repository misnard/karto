/**
 * Amend eval (calls the real `claude -p`: run by hand, never in CI).
 * Usage: pnpm --filter @karto/api eval:amend [case-id…]   LLM_MODEL overrides the model.
 * Scores the raw amend output against the basket of each case: additions, removals, updates, untouched lines.
 */
import { randomUUID } from 'node:crypto';
import { PreferencesSchema } from '@karto/contracts';
import { z } from 'zod';
import { runClaude } from '../../../services/llm-relay/src/claude.ts';
import {
  type AmendItem,
  type AmendOutput,
  AmendOutputSchema,
  buildUser,
  jsonSchema,
  system,
} from '../src/llm/prompts/amend.ts';
import { aggregate } from '../src/pipeline/aggregate.ts';
import { loadCases, matches, normalize, type Outcome, runEval } from './lib.ts';

const model = process.env.LLM_MODEL ?? 'claude-haiku-5-5';
const UnitSchema = z.enum(['g', 'ml', 'piece']);

const CaseSchema = z.strictObject({
  id: z.string(),
  preferences: PreferencesSchema.optional(),
  servings: z.int().min(1).max(20).optional(),
  basket: z.array(
    z.strictObject({ key: z.string(), label: z.string().optional(), quantity: z.number(), unit: UnitSchema }),
  ),
  text: z.string(),
  expect: z.strictObject({
    /** Each entry: acceptable keys for one added line. */
    add: z.array(z.array(z.string()).min(1)).optional(),
    maxAdd: z.int().optional(),
    /** No added line has the key of a basket line (it should be an update instead). */
    noDuplicate: z.boolean().optional(),
    remove: z.array(z.strictObject({ key: z.string(), why: z.enum(['have_it', 'not_wanted']) })).optional(),
    update: z.array(z.strictObject({ key: z.string(), unit: UnitSchema, min: z.number(), max: z.number() })).optional(),
    /** Basket lines that must be neither removed nor updated. */
    untouched: z.array(z.string()).optional(),
  }),
});
type Case = z.infer<typeof CaseSchema>;

function score(test: Case, items: AmendItem[], output: AmendOutput): { failures: string[]; checks: number } {
  const { add = [], maxAdd, noDuplicate, remove = [], update = [], untouched = [] } = test.expect;
  const added = aggregate(output.add);
  const idOf = (key: string) => items.find((item) => item.key === key)?.itemId;
  const touched = new Set([...output.remove, ...output.update].map((change) => change.itemId));
  const known = new Set(items.map((item) => item.itemId));
  const failures = [
    ...add.filter((alts) => !added.some((line) => matches(line.key, alts))).map((alts) => `not added: ${alts[0]}`),
    ...remove
      .filter(({ key, why }) => !output.remove.some((r) => r.itemId === idOf(key) && r.why === why))
      .map(({ key, why }) => `not removed (${why}): ${key}`),
    ...update
      .filter(({ key, unit, min, max }) => {
        const change = output.update.find((u) => u.itemId === idOf(key));
        return !change || change.unit !== unit || change.quantity < min || change.quantity > max;
      })
      .map(({ key, unit, min, max }) => `not updated to ${min}..${max} ${unit}: ${key}`),
    ...untouched.filter((key) => touched.has(idOf(key) ?? '')).map((key) => `touched: ${key}`),
  ];
  if (maxAdd !== undefined && added.length > maxAdd) failures.push(`${added.length} lines added, max ${maxAdd}`);
  const basketKeys = new Set(items.map((item) => normalize(item.key)));
  const duplicates = added.filter((line) => basketKeys.has(normalize(line.key)));
  if (noDuplicate && duplicates.length > 0) failures.push(`added again: ${duplicates.map((l) => l.key).join(', ')}`);
  if ([...touched].some((id) => !known.has(id))) failures.push('itemId not from the basket');
  const checks =
    add.length +
    remove.length +
    update.length +
    untouched.length +
    (maxAdd === undefined ? 0 : 1) +
    (noDuplicate ? 1 : 0) +
    1;
  return { failures, checks };
}

async function run(test: Case): Promise<Outcome> {
  const items = test.basket.map((line) => ({ itemId: randomUUID(), label: line.label ?? line.key, ...line }));
  const started = Date.now();
  const user = buildUser(items, test.text, test.preferences, test.servings);
  const result = await runClaude({ purpose: 'amend', model, system, user, jsonSchema });
  const seconds = (Date.now() - started) / 1000;
  const parsed = AmendOutputSchema.safeParse(JSON.parse(result.text));
  const empty = { add: [], remove: [], update: [] };
  if (!parsed.success) {
    const { checks } = score(test, items, empty);
    const failures = [`invalid output: ${z.prettifyError(parsed.error)}`];
    return { id: test.id, failures, checks, seconds, usage: result.usage };
  }
  const { failures, checks } = score(test, items, parsed.data);
  const keyOf = (id: string) => items.find((item) => item.itemId === id)?.key ?? id;
  if (failures.length > 0) {
    const { add, remove, update } = parsed.data;
    failures.push(
      `got: add ${add.map((l) => `${l.key} ${l.quantity} ${l.unit}`).join(', ') || '-'} | ` +
        `remove ${remove.map((r) => `${keyOf(r.itemId)} (${r.why})`).join(', ') || '-'} | ` +
        `update ${update.map((u) => `${keyOf(u.itemId)} ${u.quantity} ${u.unit}`).join(', ') || '-'}`,
    );
  }
  return { id: test.id, failures, checks, seconds, usage: result.usage };
}

const cases = loadCases('./amend-cases.json', CaseSchema);
const checksOf = (test: Case) => score(test, [], { add: [], remove: [], update: [] }).checks;
await runEval(`Amend (${model})`, cases, run, checksOf);
