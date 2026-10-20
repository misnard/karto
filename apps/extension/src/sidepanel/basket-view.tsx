import {
  type Basket,
  type BasketItem,
  type BasketStatus,
  type CartSyncOutcome,
  CartSyncResultSchema,
  type JobErrorCode,
  type JobProgress,
  type JobSummary,
  type PatchItemRequest,
  type ProductOffer,
  type ReasonSource,
} from '@karto/contracts';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { ApiError, amendBasket, getBasket, patchItem, pushBasket, retryBasket, searchItem } from '../api.ts';
import { Shell } from './shell.tsx';
import {
  BASKET_STATUS,
  errorText,
  formatPrice,
  formatQuantity,
  formatUnitPrice,
  isUnauthorized,
  notifyExecutor,
  plural,
} from './ui.ts';

const POLL_MS = 1500;
const TRANSIENT: ReadonlySet<BasketStatus> = new Set(['parsing', 'searching', 'matching', 'pushing']);
const WITH_FOOTER: ReadonlySet<BasketStatus> = new Set(['ready', 'pushing', 'pushed']);
const SOURCE: Record<ReasonSource, string> = { memory: 'Mémoire', rules: 'Règle', llm: 'IA', user: 'Toi' };
const ALTERNATIVES = 3;
/** Same cap as the API (PatchItemRequest packs). */
const MAX_PACKS = 50;

type Tone = 'neutral' | 'ok' | 'warn' | 'danger';
type Badge = { label: string; tone: Tone };

const OUTCOME: Record<CartSyncOutcome, Badge> = {
  set: { label: 'Ajouté', tone: 'ok' },
  unchanged: { label: 'Déjà au panier', tone: 'neutral' },
  unavailable: { label: 'Indisponible', tone: 'warn' },
  failed: { label: 'Échec', tone: 'danger' },
};

const PUSH_LINE: Record<NonNullable<JobProgress['lines']>[number]['status'], Badge> = {
  pending: { label: 'En attente', tone: 'neutral' },
  ok: { label: 'Ajouté', tone: 'ok' },
  failed: { label: 'Échec', tone: 'danger' },
  skipped: { label: 'Déjà au panier', tone: 'neutral' },
};

const JOB_ERRORS: Record<JobErrorCode, string> = {
  auth_required: 'Connecte-toi sur le site du magasin, puis relance l’envoi.',
  challenge: 'Vérification anti-robot à faire dans l’onglet du magasin, puis relance.',
  no_store: 'Choisis ton magasin Drive sur le site, puis relance.',
  rate_limited: 'Le site du magasin limite les requêtes. Réessaie dans quelques minutes.',
  schema_mismatch: 'Le site du magasin a changé. Karto doit être mis à jour.',
  http: 'Le site du magasin a renvoyé une erreur.',
  network: 'L’onglet du magasin ne répond pas. Vérifie qu’il est ouvert et ta connexion.',
  login_timeout: 'La connexion au site du magasin n’a pas été faite à temps.',
  lease_expired: 'L’extension a été interrompue pendant la tâche.',
  cancelled: 'Tâche annulée.',
  invalid_result: 'Résultat invalide renvoyé par l’extension.',
  internal: 'Erreur interne.',
};

interface Props {
  token: string;
  basketId: string;
  initial: Basket | null;
  /** From the user's preferences: shown against the basket total. */
  budgetCents: number | null;
  banner: ReactNode;
  onUnauthorized: () => void;
  onNew: () => void;
}

export function BasketView({ token, basketId, initial, budgetCents, banner, onUnauthorized, onNew }: Props) {
  const [basket, setBasket] = useState<Basket | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);
  const [refresh, setRefresh] = useState(0);
  /** The row whose choices are open, kept while its manual search runs so the results show up in place. */
  const [openId, setOpenId] = useState<string | null>(null);
  const [searchedId, setSearchedId] = useState<string | null>(null);

  // Poll while the basket is in a transient status. `refresh` restarts polling after a push.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` is a restart trigger, not read inside.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const next = await getBasket(token, basketId);
        if (stopped) return;
        setBasket(next);
        setError(null);
        // A search job appears once the LLM has parsed the list: wake the executor instead of waiting for its alarm.
        if (next.job?.status === 'pending' && next.job.kind !== 'llm') notifyExecutor({ type: 'wake' });
        if (TRANSIENT.has(next.status)) timer = setTimeout(tick, POLL_MS);
      } catch (err) {
        if (stopped) return;
        if (isUnauthorized(err)) return onUnauthorized();
        setError(errorText(err));
        // Client errors (e.g. basket gone) will not fix themselves; network errors might.
        if (!(err instanceof ApiError && err.status < 500)) timer = setTimeout(tick, POLL_MS * 2);
      }
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [token, basketId, refresh, onUnauthorized]);

  /** Push or retry: both queue a job for the executor, then restart polling. */
  async function act(action: () => Promise<unknown>) {
    setPushing(true);
    setError(null);
    try {
      await action();
      notifyExecutor({ type: 'wake' });
      setRefresh((n) => n + 1);
    } catch (err) {
      if (isUnauthorized(err)) onUnauthorized();
      else setError(errorText(err));
    } finally {
      setPushing(false);
    }
  }
  const push = () => act(() => pushBasket(token, basketId));
  const retry = () => act(() => retryBasket(token, basketId));
  const amend = (text: string) => act(() => amendBasket(token, basketId, text));
  const search = (itemId: string, query: string) => {
    setSearchedId(itemId);
    return act(() => searchItem(token, basketId, itemId, query));
  };

  /** Per-line edit: the API answers with the updated basket, no job involved. */
  async function edit(itemId: string, request: PatchItemRequest) {
    setError(null);
    try {
      setBasket(await patchItem(token, basketId, itemId, request));
    } catch (err) {
      if (isUnauthorized(err)) onUnauthorized();
      else setError(errorText(err));
    }
  }

  const job = basket?.job ?? null;
  const items = basket?.items.filter((item) => item.status !== 'removed') ?? [];
  const removed = basket?.items.filter((item) => item.status === 'removed') ?? [];
  const editable = basket?.status === 'ready' || basket?.status === 'pushed';
  const unmatched = items.filter((item) => item.status === 'unmatched').length;
  const status = basket ? BASKET_STATUS[basket.status] : null;
  const jobError = job?.status === 'failed' && job.error ? JOB_ERRORS[job.error.code] : null;
  const badges = rowBadges(job);

  return (
    <Shell
      action={
        <button type="button" className="btn btn-ghost" onClick={onNew}>
          Nouvelle liste
        </button>
      }
      footer={
        basket &&
        (WITH_FOOTER.has(basket.status) ? (
          <Footer basket={basket} budgetCents={budgetCents} pushing={pushing} onPush={push} />
        ) : (
          canRetry(basket) && (
            <button type="button" className="btn btn-primary btn-block" onClick={retry} disabled={pushing}>
              {pushing ? 'Relance…' : job?.kind === 'llm' ? 'Relancer la lecture' : 'Relancer la recherche'}
            </button>
          )
        ))
      }
    >
      {job && <JobProgressBar job={job} />}
      {banner}
      <div className="basket-head">
        <h1 className="title">Ton panier</h1>
        {status && (
          <span className={`chip chip-${status.tone}`} role="status">
            {job?.status === 'pending' && job.kind !== 'llm' ? 'En attente de l’extension' : status.label}
          </span>
        )}
      </div>
      {(error || jobError || basket?.error) && (
        <p role="alert" className="alert">
          {error ?? jobError ?? basket?.error}
        </p>
      )}
      {basket?.status === 'parsing' && items.length === 0 ? (
        <>
          <p className="muted">
            {job?.error?.code === 'invalid_result'
              ? 'La première lecture n’a pas abouti. Karto fait un nouvel essai.'
              : 'Karto lit ta liste et prépare les articles. Compte une dizaine de secondes.'}
          </p>
          <LoadingList />
        </>
      ) : basket ? (
        <>
          {basket.status === 'parsing' && <p className="muted">Karto applique ta modification…</p>}
          {basket.status === 'matching' && (
            <p className="muted">Karto compare les produits pour choisir les meilleurs…</p>
          )}
          <ul className="list" aria-label="Articles">
            {items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                searching={basket.status === 'searching' || basket.status === 'parsing'}
                busy={basket.status === 'searching' && searchedId === item.id}
                badge={item.productRef ? badges.get(item.productRef) : undefined}
                actions={
                  editable
                    ? {
                        open: openId === item.id,
                        // Opening a row closes the others; their toggle events must not close it back.
                        onToggle: (open) => setOpenId((id) => (open ? item.id : id === item.id ? null : id)),
                        onChoose: (ref) => edit(item.id, { op: 'choose', ref }),
                        onPacks: (packs) => edit(item.id, { op: 'packs', packs }),
                        onSearch: (query) => search(item.id, query),
                        onRemove: () => edit(item.id, { op: 'remove' }),
                      }
                    : undefined
                }
              />
            ))}
          </ul>
          {removed.length > 0 && (
            <RemovedItems items={removed} onRestore={editable ? (id) => edit(id, { op: 'restore' }) : undefined} />
          )}
          {editable && unmatched > 0 && (
            <button type="button" className="btn btn-secondary" onClick={retry} disabled={pushing}>
              {unmatched > 1
                ? `Relancer la recherche des ${unmatched} articles sans produit`
                : 'Relancer la recherche de l’article sans produit'}
            </button>
          )}
          {editable && <AmendForm busy={pushing} onSubmit={amend} />}
        </>
      ) : (
        !error && <LoadingList />
      )}
    </Shell>
  );
}

/** A failed parse or search can be retried without redoing the steps before it (a failed push goes back to 'ready'). */
function canRetry(basket: Basket): boolean {
  return basket.status === 'failed' && (basket.job?.kind === 'llm' || basket.job?.kind === 'provider.search');
}

/** Per-ref badge: live progress while pushing, final outcome once the push is done. */
function rowBadges(job: JobSummary | null): Map<string, Badge> {
  const badges = new Map<string, Badge>();
  if (job?.kind !== 'provider.cart_sync') return badges;
  const result = job.status === 'done' ? CartSyncResultSchema.safeParse(job.result) : null;
  if (result?.success) {
    for (const line of result.data.lines) badges.set(line.ref, OUTCOME[line.outcome]);
  } else if (job.status !== 'failed') {
    for (const line of job.progress?.lines ?? []) badges.set(line.key, PUSH_LINE[line.status]);
  }
  return badges;
}

function JobProgressBar({ job }: { job: JobSummary }) {
  const active = job.status === 'pending' || job.status === 'running' || job.status === 'paused';
  // LLM jobs report no progress: a bar stuck at 0 would look broken.
  if (!active || job.kind === 'llm') return null;
  const done = job.progress?.done ?? 0;
  const total = Math.max(job.progress?.total ?? 1, 1);
  const label = job.kind === 'provider.cart_sync' ? 'Envoi au panier' : 'Recherche des produits';
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
    >
      <div className="progress-bar" style={{ width: `${Math.round((done / total) * 100)}%` }} />
    </div>
  );
}

/** Edits of a row, only while the basket is editable. */
interface RowActions {
  open: boolean;
  onToggle: (open: boolean) => void;
  onChoose: (ref: string) => void;
  onPacks: (packs: number) => void;
  onSearch: (query: string) => void;
  onRemove: () => void;
}

function ItemRow(props: {
  item: BasketItem;
  searching: boolean;
  /** A manual search of this row is running. */
  busy: boolean;
  badge: Badge | undefined;
  actions?: RowActions;
}) {
  const { item, searching, busy, badge, actions } = props;
  const removeButton = actions && (
    <button type="button" className="btn-link" onClick={actions.onRemove} aria-label={`Retirer ${item.label}`}>
      Retirer
    </button>
  );
  const busyBadge = busy && <span className="badge">Recherche…</span>;
  const offer = item.candidates.find((candidate) => candidate.ref === item.productRef);
  const quantity = formatQuantity(item.quantity, item.unit);
  const query = (
    <span className="row-query">
      {item.label}
      {quantity && ` · ${quantity}`}
    </span>
  );

  if (item.status === 'pending') {
    if (!searching) {
      return (
        <li className="row">
          <span className="thumb thumb-empty" />
          <div className="row-main">
            {query}
            <span className="row-name muted">Recherche non aboutie</span>
          </div>
        </li>
      );
    }
    return (
      <li className="row" aria-busy="true">
        <span className="skeleton skeleton-thumb" />
        <div className="row-main">
          {query}
          <span className="skeleton" style={{ width: '72%' }} />
          <span className="skeleton" style={{ width: '40%' }} />
        </div>
        <span className="skeleton" style={{ width: 44 }} />
      </li>
    );
  }

  if (!offer) {
    return (
      <li className="row row-warn">
        <span className="thumb thumb-empty" />
        <div className="row-main">
          {query}
          <span className="row-name">Aucun produit trouvé</span>
          <span className="small muted">Cet article ne sera pas envoyé.</span>
          {/* The rules' reason repeats "aucun produit"; the LLM's or the user's says why. */}
          {item.reasonSource !== 'rules' && <Reason item={item} />}
          {busyBadge}
        </div>
        <div className="row-side">{removeButton}</div>
        {actions && <Choices item={item} actions={actions} />}
      </li>
    );
  }

  return (
    <li className="row row-enter">
      <Thumb offer={offer} />
      <div className="row-main">
        {query}
        <span className="row-name">{offer.name}</span>
        {offer.brand && !offer.name.toLowerCase().includes(offer.brand.toLowerCase()) && (
          <span className="small muted">{offer.brand}</span>
        )}
        {offer.nutriscore && (
          <span className={`nutri nutri-${offer.nutriscore}`} title={`Nutri-Score ${offer.nutriscore}`}>
            Nutri-Score {offer.nutriscore}
          </span>
        )}
        {badge ? (
          <span className="row-badges">
            <span className={`badge badge-${badge.tone}`}>{badge.label}</span>
          </span>
        ) : (
          <Reason item={item} />
        )}
        {busyBadge}
      </div>
      <div className="row-side">
        <span className="price">
          {offer.priceCents === undefined ? 'Prix inconnu' : formatPrice(offer.priceCents * (item.packs ?? 1))}
        </span>
        {actions && item.packs !== null ? (
          <Packs
            label={item.label}
            packs={item.packs}
            max={Math.min(MAX_PACKS, offer.maxQuantity ?? MAX_PACKS)}
            onChange={actions.onPacks}
          />
        ) : (
          item.packs !== null && item.packs > 1 && <span className="small muted">× {item.packs}</span>
        )}
        {offer.unitPrice && <span className="small muted">{formatUnitPrice(offer.unitPrice)}</span>}
        {removeButton}
      </div>
      {actions && <Choices item={item} actions={actions} />}
    </li>
  );
}

/** Who chose the product (Mémoire, Règle, IA, Toi) and why. */
function Reason({ item }: { item: BasketItem }) {
  if (!item.reason) return null;
  return (
    <span className="row-badges">
      {item.reasonSource && (
        <span className={`badge source source-${item.reasonSource}`}>{SOURCE[item.reasonSource]}</span>
      )}
      <span className="small muted">{item.reason}</span>
    </span>
  );
}

function Packs(props: { label: string; packs: number; max: number; onChange: (packs: number) => void }) {
  const { label, packs, max, onChange } = props;
  return (
    <span className="stepper">
      <button
        type="button"
        onClick={() => onChange(packs - 1)}
        disabled={packs <= 1}
        aria-label={`Un article de moins : ${label}`}
      >
        −
      </button>
      <output aria-label={`Nombre d’articles : ${label}`}>{packs}</output>
      <button
        type="button"
        onClick={() => onChange(packs + 1)}
        disabled={packs >= max}
        aria-label={`Un article de plus : ${label}`}
      >
        +
      </button>
    </span>
  );
}

/** Up to 3 alternatives to choose from, and a manual search whose results replace them. */
function Choices({ item, actions }: { item: BasketItem; actions: RowActions }) {
  const [query, setQuery] = useState(item.label);
  const alternatives = item.candidates
    .filter((candidate) => candidate.available && candidate.ref !== item.productRef)
    .slice(0, ALTERNATIVES);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (query.trim()) actions.onSearch(query.trim());
  }

  return (
    <details className="choices" open={actions.open} onToggle={(e) => actions.onToggle(e.currentTarget.open)}>
      <summary>{item.productRef ? 'Changer de produit' : 'Choisir un produit'}</summary>
      {alternatives.length > 0 && (
        <ul className="alternatives" aria-label={`Autres produits pour ${item.label}`}>
          {alternatives.map((alternative) => (
            <li key={alternative.ref}>
              <span className="alternative-name">
                {alternative.name}
                {alternative.unitPrice && (
                  <span className="small muted"> · {formatUnitPrice(alternative.unitPrice)}</span>
                )}
              </span>
              <span className="price">
                {alternative.priceCents === undefined ? '' : formatPrice(alternative.priceCents)}
              </span>
              <button
                type="button"
                className="btn-link"
                onClick={() => actions.onChoose(alternative.ref)}
                aria-label={`Choisir ${alternative.name}`}
              >
                Choisir
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="amend-row" onSubmit={submit}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={`Chercher un autre produit pour ${item.label}`}
          maxLength={200}
        />
        <button type="submit" className="btn btn-secondary" disabled={!query.trim()}>
          Chercher
        </button>
      </form>
    </details>
  );
}

function Thumb({ offer }: { offer: ProductOffer }) {
  const [broken, setBroken] = useState(false);
  if (!offer.imageUrl || broken) return <span className="thumb thumb-empty" />;
  return <img className="thumb" src={offer.imageUrl} alt="" loading="lazy" onError={() => setBroken(true)} />;
}

function LoadingList() {
  return (
    <ul className="list" aria-busy="true" aria-label="Chargement du panier">
      {[0, 1, 2].map((key) => (
        <li key={key} className="row">
          <span className="skeleton skeleton-thumb" />
          <div className="row-main">
            <span className="skeleton" style={{ width: '30%' }} />
            <span className="skeleton" style={{ width: '70%' }} />
          </div>
          <span className="skeleton" style={{ width: 44 }} />
        </li>
      ))}
    </ul>
  );
}

function Footer(props: { basket: Basket; budgetCents: number | null; pushing: boolean; onPush: () => void }) {
  const { basket, budgetCents, pushing, onPush } = props;
  const chosen = basket.items.filter((item) => item.status === 'proposed' && item.productRef).length;
  const sending = pushing || basket.status === 'pushing';

  return (
    <>
      <div className="footer-summary">
        <span className="muted">
          {basket.status === 'pushed'
            ? `${plural(chosen, 'article')} dans ton panier du magasin`
            : `Total pour ${plural(chosen, 'article')}`}
        </span>
        <span className="footer-total">{formatPrice(basket.totalCents)}</span>
      </div>
      {budgetCents !== null && basket.status !== 'pushed' && (
        <p className={`small ${basket.totalCents > budgetCents ? 'budget-over' : 'muted'}`}>
          {basket.totalCents > budgetCents
            ? `Dépasse ton budget de ${formatPrice(basket.totalCents - budgetCents)}`
            : `Budget ${formatPrice(budgetCents)}, il reste ${formatPrice(budgetCents - basket.totalCents)}`}
        </p>
      )}
      <div className="footer-actions">
        {basket.status === 'pushed' ? (
          <>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => notifyExecutor({ type: 'focusCarrefour' })}
            >
              Ouvrir le site du magasin
            </button>
            <button type="button" className="btn btn-secondary" onClick={onPush} disabled={sending}>
              Renvoyer
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-primary" onClick={onPush} disabled={sending || chosen === 0}>
            {sending ? 'Envoi en cours…' : 'Envoyer au panier'}
          </button>
        )}
      </div>
    </>
  );
}

function RemovedItems({ items, onRestore }: { items: BasketItem[]; onRestore?: (itemId: string) => void }) {
  return (
    <details className="removed">
      <summary>{items.length > 1 ? `${items.length} articles retirés` : '1 article retiré'}</summary>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <span>
              {item.label}
              {item.reason && <span className="small muted"> · {item.reason}</span>}
            </span>
            {onRestore && (
              <button
                type="button"
                className="btn-link"
                onClick={() => onRestore(item.id)}
                aria-label={`Remettre ${item.label}`}
              >
                Remettre
              </button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function AmendForm({ busy, onSubmit }: { busy: boolean; onSubmit: (text: string) => Promise<void> }) {
  const [text, setText] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    await onSubmit(text.trim());
    setText('');
  }

  return (
    <form className="amend" onSubmit={submit}>
      <label htmlFor="amend-text" className="section-title">
        Modifier la liste
      </label>
      <div className="amend-row">
        <input
          id="amend-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="ajoute de la mayo, j’ai déjà du sel…"
          maxLength={2000}
        />
        <button type="submit" className="btn btn-secondary" disabled={busy || !text.trim()}>
          Modifier
        </button>
      </div>
    </form>
  );
}
