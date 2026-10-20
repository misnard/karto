import { PreferencesSchema } from '@karto/contracts';
import { describe, expect, it } from 'vitest';
import { parseLine } from '../../test/helpers.ts';
import { AmendOutputSchema, buildUser, jsonSchema } from './amend.ts';

describe('amend prompt', () => {
  it('lists the basket as JSON lines after the context, then the request', () => {
    const items = [{ itemId: 'a1', label: 'Lait', key: 'lait', quantity: 1000, unit: 'ml' as const }];
    const preferences = PreferencesSchema.parse({ diet: ['vegetarian'] });
    expect(buildUser(items, ' enlève le lait ', preferences)).toBe(
      'Nombre de personnes : non précisé\nRégime : végétarien\n\nPanier :\n' +
        '{"itemId":"a1","label":"Lait","key":"lait","quantity":1000,"unit":"ml"}\n\nDemande :\nenlève le lait',
    );
    expect(buildUser([], 'ajoute du pain')).toContain('Panier :\n(vide)');
  });

  it('exposes a plain JSON Schema with the parse line shape for additions', () => {
    const text = JSON.stringify(jsonSchema);
    for (const keyword of ['$schema', 'default', 'minimum', 'maximum', 'minLength', 'maxItems']) {
      expect(text).not.toContain(`"${keyword}"`);
    }
    expect(jsonSchema).toMatchObject({ required: ['add', 'remove', 'update'], additionalProperties: false });
  });

  it('validates the output strictly', () => {
    const valid = {
      add: [parseLine('mayonnaise')],
      remove: [{ itemId: 'a1', why: 'have_it' }],
      update: [{ itemId: 'a2', quantity: 2, unit: 'piece' }],
    };
    expect(AmendOutputSchema.safeParse(valid).success).toBe(true);
    expect(AmendOutputSchema.safeParse({ ...valid, remove: [{ itemId: 'a1', why: 'bored' }] }).success).toBe(false);
    expect(AmendOutputSchema.safeParse({ add: [], remove: [] }).success).toBe(false);
  });
});
