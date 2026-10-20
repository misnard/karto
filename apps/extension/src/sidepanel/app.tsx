import type { Basket, BasketSummary, Preferences } from '@karto/contracts';
import { type FormEvent, type KeyboardEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { createBasket, getMe, listBaskets, pair } from '../api.ts';
import {
  clearToken,
  EXECUTOR_KEY,
  type ExecutorState,
  getExecutorState,
  getServerUrl,
  getToken,
  parseExecutorState,
  parseServerUrl,
  STORE_REF_KEY,
  setServerUrl,
  setToken,
} from '../state.ts';
import { AccountView } from './account-view.tsx';
import { BasketView } from './basket-view.tsx';
import { ContractCheck } from './contract-check.tsx';
import { PreferencesView } from './preferences-view.tsx';
import { Shell } from './shell.tsx';
import {
  BASKET_STATUS,
  errorText,
  formatDate,
  formatPrice,
  isUnauthorized,
  notifyExecutor,
  plural,
  toBasketInputs,
} from './ui.ts';

const BASKET_KEY = 'basketId';
const SERVINGS_KEY = 'servings';

type Session = { token: string | null; basketId: string | null };

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [created, setCreated] = useState<Basket | null>(null);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [editing, setEditing] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [account, setAccount] = useState(false);
  const executor = useExecutorState();

  useEffect(() => {
    Promise.all([getToken(), chrome.storage.local.get(BASKET_KEY)])
      .then(([token, stored]) => {
        const basketId = stored[BASKET_KEY];
        setSession({ token, basketId: typeof basketId === 'string' ? basketId : null });
      })
      .catch((err: unknown) => console.error('[karto] could not read storage', err));
  }, []);

  const openBasket = useCallback((basketId: string | null) => {
    setSession((s) => s && { ...s, basketId });
    const write = basketId
      ? chrome.storage.local.set({ [BASKET_KEY]: basketId })
      : chrome.storage.local.remove(BASKET_KEY);
    write.catch((err: unknown) => console.error('[karto] could not store the basket id', err));
  }, []);

  const token = session?.token ?? null;
  useEffect(() => {
    if (!token) return;
    getMe(token)
      .then((me) => {
        setPreferences(me.preferences);
        setIsAdmin(me.user.isAdmin);
      })
      .catch((err: unknown) => console.warn('[karto] could not load preferences', err));
  }, [token]);

  const onUnauthorized = useCallback(() => {
    clearToken().catch((err: unknown) => console.error('[karto] could not clear the token', err));
    setSession((s) => s && { ...s, token: null });
  }, []);

  if (!session) return null;
  if (!session.token) return <PairView onPaired={(token) => setSession({ token, basketId: null })} />;
  const banner = (
    <>
      <ExecutorBanner state={executor} />
      <CurrentStore />
      {import.meta.env.MODE === 'development' && <ContractCheck />}
    </>
  );

  if (account) {
    return (
      <AccountView
        token={session.token}
        isAdmin={isAdmin}
        onBack={() => setAccount(false)}
        onUnauthorized={onUnauthorized}
      />
    );
  }

  if (editing && preferences) {
    return (
      <PreferencesView
        token={session.token}
        initial={preferences}
        onBack={() => setEditing(false)}
        onUnauthorized={onUnauthorized}
        onChangeServer={() => {
          // Unpairs: the token and the open basket belong to the current server.
          setEditing(false);
          openBasket(null);
          onUnauthorized();
        }}
        onSaved={(saved) => {
          setPreferences(saved);
          setEditing(false);
        }}
      />
    );
  }

  return session.basketId ? (
    <BasketView
      key={session.basketId}
      token={session.token}
      basketId={session.basketId}
      initial={created?.id === session.basketId ? created : null}
      budgetCents={preferences?.budgetCents ?? null}
      banner={banner}
      onUnauthorized={onUnauthorized}
      onNew={() => openBasket(null)}
    />
  ) : (
    <ComposeView
      token={session.token}
      banner={banner}
      action={
        <div className="topbar-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setAccount(true)}>
            Appareils
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setEditing(true)} disabled={!preferences}>
            Préférences
          </button>
        </div>
      }
      onUnauthorized={onUnauthorized}
      onOpen={openBasket}
      onCreated={(basket) => {
        setCreated(basket);
        openBasket(basket.id);
      }}
    />
  );
}

function PairView({ onPaired }: { onPaired: (token: string) => void }) {
  const [server, setServer] = useState(import.meta.env.VITE_API_URL ?? '');
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('Chrome');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The last server used wins over the build-time default.
  useEffect(() => {
    getServerUrl()
      .then((stored) => stored && setServer(stored))
      .catch((err: unknown) => console.error('[karto] could not read the server address', err));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const serverUrl = parseServerUrl(server);
    if (!serverUrl) {
      setError('Adresse du serveur invalide : elle doit commencer par https:// (http:// seulement pour localhost).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { token } = await pair(code.trim(), label.trim(), serverUrl);
      // Server first: the executor starts as soon as a token exists.
      await setServerUrl(serverUrl);
      await setToken(token);
      notifyExecutor({ type: 'paired' });
      onPaired(token);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <div className="stack">
        <h1 className="title">Relie ce navigateur</h1>
        <p className="lead">
          Entre l’adresse du serveur Karto et le code d’appairage reçus pour connecter Karto à ton compte. Le code ne
          sert qu’une fois.
        </p>
      </div>
      <form className="form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="pair-server">Adresse du serveur</label>
          <input
            id="pair-server"
            type="url"
            value={server}
            onChange={(e) => setServer(e.target.value)}
            placeholder="https://karto.exemple.fr"
            autoComplete="url"
            spellCheck={false}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="pair-code">Code d’appairage</label>
          <input
            id="pair-code"
            className="code-input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="pair-label">Nom de cet appareil</label>
          <input id="pair-label" value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={100} />
          <span className="small muted">Par exemple « Chrome du bureau ».</span>
        </div>
        {error && (
          <p role="alert" className="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="btn btn-primary btn-block"
          disabled={busy || code.trim() === '' || server.trim() === ''}
        >
          {busy ? 'Connexion…' : 'Relier ce navigateur'}
        </button>
      </form>
    </Shell>
  );
}

function ComposeView(props: {
  token: string;
  banner: ReactNode;
  action: ReactNode;
  onCreated: (basket: Basket) => void;
  onOpen: (basketId: string) => void;
  onUnauthorized: () => void;
}) {
  const [text, setText] = useState('');
  const [servings, setServings] = useServings();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const basket = await createBasket(props.token, { inputs: toBasketInputs(text), servings });
      notifyExecutor({ type: 'wake' });
      props.onCreated(basket);
    } catch (err) {
      if (isUnauthorized(err)) props.onUnauthorized();
      else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  // Cmd/Ctrl+Enter submits from the textarea.
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit();
  }

  return (
    <Shell action={props.action}>
      {props.banner}
      <form className="form" onSubmit={submit}>
        <div className="stack">
          <h1 className="title" id="compose-title">
            Ta liste de courses
          </h1>
          <p className="lead" id="compose-hint">
            Des articles, des plats ou une recette collée. Karto trouve les produits dans ton magasin Drive.
          </p>
        </div>
        <textarea
          id="basket-text"
          aria-labelledby="compose-title"
          aria-describedby="compose-hint"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={'lait, 6 oeufs\nde quoi faire des lasagnes\nshampoing'}
          // biome-ignore lint/a11y/noAutofocus: the list is the only thing to do on this screen.
          autoFocus
          required
        />
        <div className="inline-field">
          <label htmlFor="servings">Pour combien de personnes ?</label>
          <input
            id="servings"
            type="number"
            min={1}
            max={20}
            value={servings}
            onChange={(e) => setServings(Number(e.target.value))}
            required
          />
        </div>
        {error && (
          <p role="alert" className="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || text.trim() === ''}>
          {busy ? 'Préparation…' : 'Préparer le panier'}
        </button>
      </form>
      <Recents token={props.token} onOpen={props.onOpen} onUnauthorized={props.onUnauthorized} />
    </Shell>
  );
}

function Recents(props: { token: string; onOpen: (basketId: string) => void; onUnauthorized: () => void }) {
  const [baskets, setBaskets] = useState<BasketSummary[]>([]);
  const { token, onUnauthorized } = props;

  useEffect(() => {
    listBaskets(token, 5)
      .then(setBaskets)
      .catch((err: unknown) => {
        if (isUnauthorized(err)) onUnauthorized();
        else console.warn('[karto] could not list recent baskets', err);
      });
  }, [token, onUnauthorized]);

  if (baskets.length === 0) return null;
  return (
    <section className="recents" aria-labelledby="recents-title">
      <h2 className="section-title" id="recents-title">
        Paniers récents
      </h2>
      <div className="list">
        {baskets.map((basket) => (
          <button key={basket.id} type="button" className="recent" onClick={() => props.onOpen(basket.id)}>
            <span>{formatDate(basket.createdAt)}</span>
            <span className="price">{formatPrice(basket.totalCents)}</span>
            <span className="small muted">{plural(basket.itemCount, 'article')}</span>
            <span className="small muted">{BASKET_STATUS[basket.status].label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

const BANNERS: Partial<Record<ExecutorState['state'], { title: string; text: string }>> = {
  login_required: {
    title: 'Connexion requise',
    text: 'Connecte-toi sur le site du magasin, puis relance l’envoi.',
  },
  challenge: {
    title: 'Vérification anti-robot',
    text: 'Le site du magasin demande une vérification. Fais-la dans son onglet, puis relance.',
  },
  no_store: {
    title: 'Aucun magasin choisi',
    text: 'Choisis ton magasin Drive sur le site du magasin, puis relance.',
  },
};

function ExecutorBanner({ state }: { state: ExecutorState | null }) {
  const banner = state && BANNERS[state.state];
  if (!banner) return null;
  return (
    <div role="status" className="banner">
      <p>
        <strong>{banner.title}</strong>
        {state.detail ?? banner.text}
      </p>
      <button type="button" className="btn" onClick={() => notifyExecutor({ type: 'focusCarrefour' })}>
        Ouvrir l’onglet du magasin
      </button>
    </div>
  );
}

/** The store seen by the executor's last job (chrome.storage.local), once there is one. */
function CurrentStore() {
  const [storeRef, setStoreRef] = useState<string | null>(null);
  useEffect(() => {
    const show = (value: unknown) => setStoreRef(typeof value === 'string' ? value : null);
    chrome.storage.local
      .get(STORE_REF_KEY)
      .then((stored) => show(stored[STORE_REF_KEY]))
      .catch((err: unknown) => console.error('[karto] could not read the store', err));
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes[STORE_REF_KEY]) show(changes[STORE_REF_KEY].newValue);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);
  return storeRef && <p className="small muted">Magasin Drive : {storeRef}</p>;
}

/** Number of people, remembered between baskets. */
function useServings(): [number, (value: number) => void] {
  const [servings, setServings] = useState(4);
  useEffect(() => {
    chrome.storage.local
      .get(SERVINGS_KEY)
      .then((stored) => {
        const value = stored[SERVINGS_KEY];
        if (typeof value === 'number') setServings(value);
      })
      .catch((err: unknown) => console.error('[karto] could not read servings', err));
  }, []);
  const update = useCallback((value: number) => {
    const next = Number.isFinite(value) ? Math.min(20, Math.max(1, Math.round(value))) : 4;
    setServings(next);
    chrome.storage.local
      .set({ [SERVINGS_KEY]: next })
      .catch((err: unknown) => console.error('[karto] could not store servings', err));
  }, []);
  return [servings, update];
}

/** Executor state written by the service worker in chrome.storage.session. */
function useExecutorState(): ExecutorState | null {
  const [state, setState] = useState<ExecutorState | null>(null);
  useEffect(() => {
    getExecutorState()
      .then(setState)
      .catch((err: unknown) => console.error('[karto] could not read the executor state', err));
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes[EXECUTOR_KEY]) setState(parseExecutorState(changes[EXECUTOR_KEY].newValue));
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);
  return state;
}
