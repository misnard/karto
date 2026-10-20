/** Shared by the LLM evals: key matching, concurrency, reporting. Node, no dependency. */
import { readFileSync } from 'node:fs';
import type { z } from 'zod';

const CONCURRENCY = 3;
const PASS_RATE = 0.9;
/** claude-haiku-5-5 API rates (USD per million tokens), for the cost estimate only. */
const RATES = { input: 0.1, output: 0.5 };

export interface Outcome {
  id: string;
  failures: string[];
  checks: number;
  seconds: number;
  usage: { inputTokens: number; outputTokens: number };
}

/** Lower case, no accents, œ → oe, no plural s/x: "Pâtes" and "pâte" compare equal. */
export function normalize(key: string): string {
  return key
    .toLowerCase()
    .replaceAll('œ', 'oe')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/[sx]$/, ''))
    .join(' ');
}

/** A key matches an alternative when equal, or more specific ("lait demi-écrémé" matches "lait"). */
export function matches(key: string, alternatives: string[]): boolean {
  const k = normalize(key);
  return alternatives.map(normalize).some((alt) => k === alt || k.startsWith(`${alt} `));
}

/** Cases of `file` (next to this module), filtered by the ids given on the command line. */
export function loadCases<T extends z.ZodType<{ id: string }>>(file: string, schema: T): z.output<T>[] {
  const only = process.argv.slice(2);
  const all: z.output<T>[] = schema.array().parse(JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8')));
  return all.filter((test) => only.length === 0 || only.includes(test.id));
}

async function pool<T, R>(items: T[], size: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) {
      const item = items[i];
      if (item !== undefined) results[i] = await task(item);
    }
  };
  await Promise.all(Array.from({ length: size }, worker));
  return results;
}

/** Runs every case (3 at a time), prints each result and the totals; exit code 1 below 90 % of checks. */
export async function runEval<C extends { id: string }>(
  name: string,
  cases: C[],
  run: (test: C) => Promise<Outcome>,
  checksOf: (test: C) => number,
): Promise<void> {
  console.log(`${name} eval: ${cases.length} cases, concurrency ${CONCURRENCY}\n`);
  const outcomes = await pool(cases, CONCURRENCY, async (test) => {
    const outcome = await run(test).catch(
      (err: unknown): Outcome => ({
        id: test.id,
        failures: [`error: ${err instanceof Error ? err.message : String(err)}`],
        checks: checksOf(test),
        seconds: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    );
    const { inputTokens, outputTokens } = outcome.usage;
    const mark = outcome.failures.length === 0 ? '✓' : '✗';
    console.log(`${mark} ${outcome.id} (${outcome.seconds.toFixed(1)} s, ${inputTokens} in / ${outputTokens} out)`);
    for (const failure of outcome.failures) console.log(`    ${failure}`);
    return outcome;
  });

  const checks = outcomes.reduce((sum, o) => sum + o.checks, 0);
  const failed = outcomes.reduce((sum, o) => sum + o.failures.filter((f) => !f.startsWith('got:')).length, 0);
  const rate = checks === 0 ? 0 : Math.max(0, checks - failed) / checks;
  const input = outcomes.reduce((sum, o) => sum + o.usage.inputTokens, 0);
  const output = outcomes.reduce((sum, o) => sum + o.usage.outputTokens, 0);
  const cost = (input * RATES.input + output * RATES.output) / 1_000_000;
  console.log(`\nCases: ${outcomes.filter((o) => o.failures.length === 0).length}/${outcomes.length}`);
  console.log(
    `Score: ${(rate * 100).toFixed(1)} % of checks (${checks - failed}/${checks}), target ${PASS_RATE * 100} %`,
  );
  console.log(`Tokens: ${input} in / ${output} out (≈ $${cost.toFixed(4)} at claude-haiku-5-5 API rates)`);
  process.exitCode = rate >= PASS_RATE ? 0 : 1;
}
