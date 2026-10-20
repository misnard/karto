import type { BasketInput, BasketStatus, Unit } from '@karto/contracts';
import { ApiError } from '../api.ts';
import type { Message } from '../state.ts';

const API_ERRORS: Record<string, string> = {
  invalid_pairing_code: 'Code d’appairage invalide ou expiré.',
  invalid_request: 'Requête refusée par le serveur.',
  not_found: 'Panier introuvable.',
  conflict: 'Un envoi est déjà en cours.',
  forbidden: 'Action non autorisée.',
};

/** French text for an error thrown by the API client. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) return API_ERRORS[err.code] ?? err.message;
  if (err instanceof TypeError) return 'Impossible de joindre le serveur Karto.';
  return 'Réponse inattendue du serveur Karto.';
}

export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/** Fire-and-forget message to the executor (service worker). */
export function notifyExecutor(message: Message): void {
  chrome.runtime
    .sendMessage(message)
    .catch((err: unknown) => console.warn('[karto] executor unreachable', { type: message.type, err }));
}

const euros = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

export function formatPrice(cents: number): string {
  return euros.format(cents / 100);
}

export const BASKET_STATUS: Record<BasketStatus, { label: string; tone: 'neutral' | 'busy' | 'ok' | 'danger' }> = {
  parsing: { label: 'Lecture…', tone: 'busy' },
  searching: { label: 'Recherche…', tone: 'busy' },
  matching: { label: 'Choix…', tone: 'busy' },
  ready: { label: 'Prêt', tone: 'neutral' },
  pushing: { label: 'Envoi…', tone: 'busy' },
  pushed: { label: 'Envoyé', tone: 'ok' },
  failed: { label: 'Échec', tone: 'danger' },
};

const UNIT_LABEL = { kg: 'kg', l: 'L', piece: 'pièce' } as const;

export function formatUnitPrice(unitPrice: { cents: number; per: keyof typeof UNIT_LABEL }): string {
  return `${formatPrice(unitPrice.cents)}/${UNIT_LABEL[unitPrice.per]}`;
}

const dateFormat = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDate(epochMs: number): string {
  return dateFormat.format(epochMs);
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count > 1 ? 's' : ''}`;
}

const URL_LINE = /^https?:\/\/\S+$/;

/** Lines that are only a URL become recipe inputs; everything else stays one free-text input for the LLM. */
export function toBasketInputs(text: string): BasketInput[] {
  const lines = text.split('\n').map((line) => line.trim());
  const urls = lines.filter((line) => URL_LINE.test(line));
  const rest = lines
    .filter((line) => !URL_LINE.test(line))
    .join('\n')
    .trim();
  return [
    ...(rest ? [{ kind: 'text' as const, text: rest }] : []),
    ...urls.map((url) => ({ kind: 'recipe_url' as const, url })),
  ];
}

/** "500 g", "1,5 kg", "75 cl", "6" for pieces; null for the default single piece. */
export function formatQuantity(quantity: number, unit: Unit): string | null {
  const n = (value: number) => value.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
  if (unit === 'piece') return quantity === 1 ? null : `× ${n(quantity)}`;
  if (unit === 'g') return quantity >= 1000 ? `${n(quantity / 1000)} kg` : `${n(quantity)} g`;
  if (quantity >= 1000) return `${n(quantity / 1000)} L`;
  return quantity >= 100 ? `${n(quantity / 10)} cl` : `${n(quantity)} ml`;
}
