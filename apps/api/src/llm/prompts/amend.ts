/**
 * LLM amend prompt: free-text change to an existing basket → lines to add, remove or resize.
 * Pure TypeScript (no cloudflare:* import): the eval script imports it from Node.
 */
import type { Preferences, Unit } from '@karto/contracts';
import { z } from 'zod';
import {
  contextHeader,
  DATA_NOTE,
  LINE_FIELDS,
  LINE_RULES,
  ParseLineSchema,
  PREFERENCE_RULES,
  toPlainJsonSchema,
} from './parse.ts';

export const AmendOutputSchema = z.strictObject({
  add: z.array(ParseLineSchema).max(100),
  remove: z.array(z.strictObject({ itemId: z.string(), why: z.enum(['have_it', 'not_wanted']) })).max(200),
  update: z
    .array(z.strictObject({ itemId: z.string(), quantity: z.number().positive(), unit: z.enum(['g', 'ml', 'piece']) }))
    .max(200),
});
export type AmendOutput = z.infer<typeof AmendOutputSchema>;

/** A line of the current basket, as shown to the model. */
export interface AmendItem {
  itemId: string;
  label: string;
  key: string;
  quantity: number;
  unit: Unit;
}

export const system = `Tu modifies un panier de courses existant d'après la demande de l'utilisateur. Le panier est donné ligne par ligne, avec son itemId.

Réponds avec trois listes :
- remove : lignes à retirer. why = have_it quand l'utilisateur les a déjà (« j'en ai déjà », « j'ai déjà du sel ») ; not_wanted quand il n'en veut plus (« enlève », « pas de », « plus besoin de »).
- update : nouvelle quantité totale d'une ligne existante (« double le fromage », « 2 kg de pommes au lieu d'un », « plus de tomates »).
- add : nouveaux produits (« ajoute », « je veux », « il me faut »), développe les plats en ingrédients comme pour une liste.

Règles :
- N'utilise que des itemId de la liste fournie.
- Ne touche jamais une ligne que l'utilisateur n'a pas mentionnée, directement ou par un plat.
- Un produit à ajouter qui est déjà dans le panier : mets à jour sa quantité (update) au lieu de l'ajouter.
- « plus de X » sans négation veut dire davantage ; « plus du tout de X » ou « pas de X » veut dire retirer.
- Laisse une liste vide quand rien ne la concerne.

Lignes de add :
${LINE_RULES}

${PREFERENCE_RULES}

Champs de add (sourceIndex vaut toujours 0) :
${LINE_FIELDS}

${DATA_NOTE}`;

export function buildUser(items: AmendItem[], text: string, preferences?: Preferences, servings?: number): string {
  const basket = items.length > 0 ? items.map((item) => JSON.stringify(item)).join('\n') : '(vide)';
  return [contextHeader(servings, preferences), `Panier :\n${basket}`, `Demande :\n${text.trim()}`].join('\n\n');
}

export const jsonSchema = toPlainJsonSchema(AmendOutputSchema);
