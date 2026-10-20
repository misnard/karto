import { PreferencesSchema } from '@karto/contracts';
import { describe, expect, it } from 'vitest';
import { parseLine } from '../../test/helpers.ts';
import { buildUser, jsonSchema, ParseOutputSchema } from './parse.ts';

const CONSTRAINTS = ['minimum', 'maximum', 'exclusiveMinimum', 'minLength', 'maxLength', 'minItems', 'maxItems'];

/** Every schema node of a JSON Schema, with its path. */
function nodes(schema: unknown, path = '#'): [string, Record<string, unknown>][] {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return [];
  const node = Object.fromEntries(Object.entries(schema));
  const children = [
    ...Object.entries(Object(node.properties)).map(([key, child]) => nodes(child, `${path}/${key}`)),
    nodes(node.items, `${path}[]`),
    ...(Array.isArray(node.anyOf) ? node.anyOf.map((child, i) => nodes(child, `${path}|${i}`)) : []),
  ];
  return [[path, node], ...children.flat()];
}

describe('parse prompt', () => {
  it('exposes a plain JSON Schema accepted by structured outputs', () => {
    expect(jsonSchema).not.toHaveProperty('$schema');
    for (const [path, node] of nodes(jsonSchema)) {
      for (const key of [...CONSTRAINTS, 'default']) expect(node, `${path}.${key}`).not.toHaveProperty(key);
      if (node.type === 'object') {
        expect(node.additionalProperties, path).toBe(false);
        expect(node.required, path).toEqual(Object.keys(Object(node.properties)));
      }
    }
    const line = nodes(jsonSchema).find(([path]) => path === '#/lines[]')?.[1];
    expect(line?.required).toEqual([
      'sourceIndex',
      'key',
      'label',
      'quantity',
      'unit',
      'query',
      'excludeTerms',
      'approx',
      'pieceWeightG',
    ]);
    expect(nodes(jsonSchema).find(([path]) => path === '#/lines[]/pieceWeightG')?.[1]).toEqual({
      anyOf: [{ type: 'number' }, { type: 'null' }],
    });
  });

  it('validates the output strictly', () => {
    const line = parseLine('lait', { unit: 'ml', quantity: 1000 });
    expect(ParseOutputSchema.safeParse({ lines: [line] }).success).toBe(true);
    expect(ParseOutputSchema.safeParse({ lines: [] }).success).toBe(false);
    expect(ParseOutputSchema.safeParse({ lines: [{ ...line, quantity: 0 }] }).success).toBe(false);
    expect(ParseOutputSchema.safeParse({ lines: [{ ...line, brand: 'x' }] }).success).toBe(false);
    const { pieceWeightG: _, ...withoutWeight } = line;
    expect(ParseOutputSchema.safeParse({ lines: [withoutWeight] }).success).toBe(false);
  });

  it('builds the user message with indexed inputs and servings', () => {
    const inputs = [
      { kind: 'text', text: ' lait, oeufs ' },
      { kind: 'recipe_text', text: 'Pour 6 personnes : 200 g de farine' },
    ] as const;
    expect(buildUser([...inputs], 4)).toBe(
      'Nombre de personnes : 4\n\n[0] Liste :\nlait, oeufs\n\n[1] Recette :\nPour 6 personnes : 200 g de farine',
    );
    expect(buildUser([inputs[0]])).toBe('Nombre de personnes : non précisé\n\n[0] Liste :\nlait, oeufs');
  });

  it('adds diet, allergies and notes when the user has some', () => {
    const preferences = PreferencesSchema.parse({
      diet: ['vegan', 'gluten_free', 'halal'],
      allergies: ['arachide', 'sésame'],
      goals: ['high_protein', 'low_salt'],
      notes: ' bio de préférence ',
      bannedBrands: ['X'],
    });
    expect(buildUser([{ kind: 'text', text: 'lait' }], 2, preferences)).toBe(
      'Nombre de personnes : 2\nRégime : végétalien, sans gluten, halal\nAllergies : arachide, sésame\n' +
        'Objectifs : riche en protéines, peu salé\nNotes : bio de préférence\n\n[0] Liste :\nlait',
    );
    expect(buildUser([{ kind: 'text', text: 'lait' }], 2, PreferencesSchema.parse({}))).toBe(
      'Nombre de personnes : 2\n\n[0] Liste :\nlait',
    );
  });
});
