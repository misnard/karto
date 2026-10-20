# Karto : plan v1

Karto fait les courses Carrefour Drive à partir d'une entrée libre. Ce document fait référence. À la fin de chaque étape, on met à jour son statut et les décisions prises.

## 0. Décisions structurantes (validées)

| Sujet | Décision | Écarté | Pourquoi |
|---|---|---|---|
| UI v1 | **Side panel de l'extension** (SPA React) | Web app servie par le Worker | Un seul livrable. Le panneau est à côté de l'onglet Carrefour, donc le login et le suivi du push se font au même endroit. Pas de login web, pas d'`externally_connectable`. La SPA ne parle au backend qu'en HTTP, plus un message `wake` à l'exécutant : on peut la ré-héberger (static assets d'un Worker, webview Tauri) sans la réécrire. |
| Recherche produits | **Par l'exécutant**, dans l'onglet de l'utilisateur. Les produits déjà mémorisés sont rafraîchis en un seul `POST /products`. | Recherche côté serveur ; catalogue serveur partagé | Côté serveur, Cloudflare bloque tout client qui n'est pas un navigateur, et le magasin est un état de la session Carrefour : c'est la seule source des prix et de la dispo du magasin de l'utilisateur. Le catalogue partagé est une piste pour la v2. |
| Matching | **Mémoire, puis règles, puis un appel LLM groupé.** Au plus 2 appels LLM par panier. | Tout au LLM ; règles seules | Coût borné et qui baisse avec l'usage. Filtres durs garantis. Choix explicable. |
| Runtime LLM | **API Anthropic appelée depuis le Worker** par défaut. Relais `claude -p` sur le VPS en option (`LLM_RUNTIME=api\|cli`). | VPS seul | L'API évite de maintenir un serveur, répond en quelques secondes et coûte moins d'un centime par panier avec Haiku 5.5. Le relais reste branchable sans refacto, car chaque appel LLM est un job. |
| Specs Carrefour | On porte **environ 7 endpoints** en fonctions typées avec des schémas zod. | Les 43 specs plus un moteur générique | Moins de surface. Une liste fermée d'endpoints sert de garde-fou anti-paiement. Les specs de checkout et de paiement n'entrent jamais dans le repo. |
| Clé de la mémoire | (utilisateur, ingrédient) → EAN | Une clé par magasin | L'EAN est national, et la dispo est vérifiée à chaque panier. Le magasin ne sert qu'aux prix. |
| File de jobs | Table `jobs` dans D1, avec bail (lease) et un cron | Queues, KV | Un seul mécanisme pour l'exécutant, le runner LLM et le relais VPS. Pas besoin de KV en v1. |

## 1. Ce qu'on sait de Carrefour

Sources : [rs-carrefour-cli](https://github.com/misnard/rs-carrefour-cli) et [CarrefourDriveMCP](https://github.com/maximeallanic/CarrefourDriveMCP), tous deux sous licence MIT. On conserve la notice de copyright dans `packages/provider-carrefour`.

- **Authentification par cookies uniquement**, sans CSRF ni bearer. En-têtes à envoyer :
  - `x-requested-with: XMLHttpRequest` ;
  - `accept: application/json, text/plain, */*` ;
  - `content-type: application/json` quand il y a un corps.

  Les appels se font en `fetch(url, { credentials: 'include' })` depuis une page `www.carrefour.fr`.
- **Le magasin est un état de session côté Carrefour.** Aucun endpoint ne permet de le choisir : l'utilisateur le choisit sur le site. `GET /api/cart` renvoie :
  - `cart.facilityServiceId` (ex. `0678-150-7052`), à réutiliser comme `basketServiceId` ;
  - `cart.type` (ex. `drive_clcv`), à réutiliser comme `subBasketType`.
- **Recherche**, sans authentification, par l'un de deux endpoints (le spike tranchera) :
  - `GET /autocomplete?q=&productCard=true&maxResults=` renvoie les produits et leurs offres. Les offres sont indexées par EAN puis par offerId : `price.price`, `price.perUnitLabel`, `availability.purchasable`.
  - `GET /s?q=&page=`.
- **Offres par EAN :** `POST /products {gtins[], facilityServiceId}`.
- **Panier** (confirmé par le spike, voir `docs/spike-carrefour.md`) :
  - `GET /api/cart` pour lire.
  - `PATCH /api/cart?refresh=true {trackingRequest:{pageType:"basket",pageId:"basket"}, items:[{basketServiceId, counter, ean, subBasketType}]}` pour fixer une quantité ≥ 1. `counter` est une **quantité absolue**, bornée par `ordering.min` (1) et `ordering.max` (10, 20 ou 50). `counter: 0` ne retire **pas** l'article : il est ramené à 1.
  - `PATCH /api/cart/items {trackingRequest, basketServiceId, ean, subBasketType}` pour **retirer** l'article : la ligne entière part, et l'appel est idempotent sur un article absent.
- **En-tête `x-requested-with` obligatoire :** sans lui, Carrefour renvoie un 404 en HTML.
- **Session :**
  - Le SSO `c4iamsecuretk` (sur moncompte.carrefour.fr) vit 24 h au plus et expire après 60 min d'inactivité. Les cookies de la boutique ont une durée courte.
  - **Une session expirée ne renvoie pas d'erreur** (constaté au spike). `/api/cart` répond 200 avec un panier anonyme, qui garde le magasin, et un `PATCH` irait le remplir sans rien signaler. La connexion se détecte uniquement par `GET /api/me` : `userId` et `email` sont vides quand la session est anonyme.
  - Les 401 et 403 restent gérés par précaution. Cloudflare renvoie aussi des 403, mais avec l'en-tête `cf-mitigated: challenge` : c'est cet en-tête qui permet de distinguer les deux cas.
  - La recherche marche en anonyme, avec les prix du magasin. Seul le push exige d'être connecté.
  - **Refresh silencieux :** on navigue vers `https://moncompte.carrefour.fr/iam/oauth2/CarrefourConnect/authorize?client_id=carrefour_onecarrefour_web&redirect_uri=https://www.carrefour.fr/login/check&response_type=code&scope=openid%20iam`. Si on revient sur www, la session est renouvelée. Sinon, il faut un login manuel (Turnstile et code email, non automatisable).
- **Cloudflare bloque les clients qui ne sont pas un navigateur.** Un `fetch` Node prend un 403 dès la première requête.
- **Inconnues, à lever au spike :**
  - forme exacte des réponses (aucune fixture dans les deux repos) ;
  - indices bio, MDD et format dans les données produit ;
  - prix renvoyés en navigation anonyme ;
  - limites de débit ;
  - vente au poids des fruits et légumes.
- **Interdits, jamais portés :**
  - `/api/checkout/*`, dont `POST /api/checkout/payment` ;
  - `PUT /api/cart/slot` et `/api/cart/attach-slot` ;
  - `POST /api/cart/promo_code` ;
  - tout appel qui vide le panier (« Vider mon panier », `/api/cart?only-unavailable=1`), puisque Karto ne touche qu'aux EAN qu'il gère.

## 2. Architecture

### 2.1 Composants

```
┌──────────────────────────── Chrome desktop de l'utilisateur ────────────────────────────┐
│  Side panel (SPA React) ──wake──► Service worker = Exécutant ──executeScript(MAIN)──►     │
│        │ HTTP + token                  │ HTTP + token          Onglet www.carrefour.fr  │
│        │                               │                       (session, cookies, CF)   │
└────────┼───────────────────────────────┼─────────────────────────────────────────────────┘
         ▼                               ▼
┌──────────── Worker Cloudflare `api` (Hono) ────────────┐   pull HTTPS   ┌─ VPS (option) ─┐
│ auth · préférences · pipeline panier · règles · mémoire │◄──── token ────│ llm-relay      │
│ jobs D1 (bail) · runner LLM (mode api) · cron 1 min     │                │ claude -p      │
└──────────┬───────────────────────────┬─────────────────┘                └────────────────┘
           ▼                           ▼
          D1                     API Anthropic
```

| Composant | Fait | Ne fait jamais |
|---|---|---|
| `apps/extension`, side panel | Saisie, revue, préférences, appairage, suivi du push. Lit l'état de l'exécutant dans `chrome.storage.session`. | Appeler Carrefour, contenir de la logique de matching |
| `apps/extension`, service worker (l'« exécutant ») | Garde le token d'appareil (`chrome.storage.local`). Réserve (claim) les jobs `provider.*` et pilote un onglet carrefour.fr dédié. Fournit le transport en MAIN world. Synchronise le panier par diff. Gère la session : refresh, pause pour login, reprise. Remonte la progression ligne par ligne. | Choisir des produits, appeler une URL fournie par le backend |
| `packages/provider-carrefour` | Construit les requêtes, valide les réponses avec zod et les normalise en `ProductOffer`. Détecte MDD, bio et format. Tient la liste fermée des endpoints. Le transport est injecté, donc tout est testable sous Node. | Accéder au réseau directement, connaître le backend |
| `packages/contracts` | Schémas zod et types partagés : domaine, DTO de l'API, jobs, `ProviderClient`, protocole de l'exécutant. | Contenir de la logique ou des noms propres à Carrefour |
| `apps/api` (Worker) | Seul détenteur de l'état. Machine à états du panier, règles, mémoire, jobs, LLM, cron. | Appeler Carrefour, dépendre de l'extension (il ne connaît que le protocole des jobs) |
| `services/llm-relay` (VPS, option) | Réserve les jobs `llm`, lance `claude -p` et renvoie le texte brut. | Contenir de la logique métier ou accepter des connexions entrantes |

### 2.2 Flux de bout en bout

1. **Saisie.** Le panel envoie `POST /v1/baskets {inputs}`. Le panier est créé avec le statut `parsing`.
2. **Parse.**
   - Le Worker récupère les URL de recettes et en extrait le JSON-LD `Recipe`.
   - Il crée un job `llm` (`purpose: parse`), exécuté par le runner : `waitUntil` en mode `api`, le relais en mode `cli`.
   - La sortie est validée par zod. On obtient des lignes normalisées : clé d'ingrédient, quantité en g, ml ou pièces, requête de recherche, termes exclus.
   - Le code applique ensuite, de façon déterministe, la mise à l'échelle des portions et l'agrégation des lignes. Le résultat va dans `basket_items`.
3. **Mémoire.** Pour chaque ligne, on cherche `choices(user, provider, ingredient_key)` pour savoir si un EAN est déjà connu.
4. **Recherche.**
   - Le Worker crée **un seul** job `provider.search` : des requêtes pour les lignes inconnues, des EAN pour les lignes mémorisées. Le panier passe à `searching`.
   - Le panel envoie `wake`. L'exécutant réserve le job et l'exécute séquentiellement dans l'onglet, avec 0,7 à 1,5 s entre deux appels.
   - Il termine par `complete {context, byItem, byRef}`.
5. **Matching.** Le panier passe à `matching`.
   - Les règles s'appliquent : filtres durs, nombre de paquets, score.
   - Une ligne mémorisée dont le produit est disponible est choisie directement.
   - Les autres lignes partent dans **un seul** job `llm` (`purpose: pick`), avec le top 6 des candidats pour chaque ligne. Le LLM renvoie choix, alternatives et justification.
   - Le panier passe à `ready`.
6. **Revue.** Le panel affiche le panier. L'utilisateur choisit, ajuste les paquets, retire ou restaure des lignes avec `PATCH /v1/baskets/:id/items/:itemId`.
7. **Push.**
   - `POST /v1/baskets/:id/push` écrit la mémoire et crée un job `provider.cart_sync {lines}`.
   - L'exécutant lit le panier Carrefour et calcule le diff, **uniquement sur les EAN gérés par Karto**.
   - Il applique les `PATCH` avec des quantités absolues, relit le panier, puis renvoie `complete` avec un résultat par ligne. Le panier passe à `pushed`.
8. L'utilisateur choisit son créneau et paie sur carrefour.fr. Karto s'arrête là.

Rejouer un job est toujours sûr :
- une recherche ne fait que lire ;
- `cart_sync` est un diff sur des quantités absolues.

C'est ce qui rend la reprise triviale : après un crash, une session expirée ou un bail expiré, on relance le job depuis le début.

Le mode du push est **merge** : les articles ajoutés à la main dans le panier Carrefour ne sont jamais touchés. Si deux lignes Karto pointent vers le même EAN, leurs quantités s'additionnent.

### 2.3 Choix techniques

- **Monorepo :** pnpm workspaces, TypeScript strict, Biome (lint et format), Vitest. Pas de Turborepo : pnpm `-r` suffit.
- **Backend :** Worker Cloudflare avec Hono et zod. D1 en SQL direct, sans ORM. Tests avec `@cloudflare/vitest-pool-workers`, sur une vraie base D1 locale. Logs via `observability` de Workers.
- **Extension :** Vite et React, manifest MV3 statique, pas de framework d'extension. WXT seulement si le build MV3 devient pénible. Permissions : `storage`, `scripting`, `sidePanel`, `alarms`. Host permissions : `www.carrefour.fr`, `moncompte.carrefour.fr` (pour suivre l'URL pendant le refresh) et l'origine de l'API. Pas de permission `tabs` : les host permissions suffisent pour filtrer les onglets par URL.
- **UI :** React et CSS simple. Pas de routeur (une vue = un état), pas de gestionnaire d'état, pas de bibliothèque de composants. Polling de `GET /v1/baskets/:id` toutes les 1,5 s tant que le panier est dans un statut transitoire.
- **LLM :**
  - SDK officiel `@anthropic-ai/sdk`, compatible Workers.
  - Sorties structurées via `output_config.format` (JSON schema), toujours revalidées avec zod.
  - Modèle par défaut : `claude-haiku-5-5`, configurable par `LLM_MODEL`. On passe à `claude-sonnet-5-5` si l'éval l'exige.
  - La consommation (usage) est enregistrée sur chaque job `llm`.
- **Auth :** un code d'appairage à usage unique, valable 15 min, s'échange contre un token d'appareil de 256 bits. D1 n'en stocke que le hash SHA-256. Pas de mot de passe ni d'OAuth.
- **Session Carrefour :** pas de keep-alive périodique. On ne touche Carrefour que pendant un job.
- **Écartés :**
  - KV : rien à mettre en cache en v1 ;
  - Queues : D1 suffit ;
  - Durable Objects : le polling suffit ;
  - Pages : l'UI est dans le side panel.

### 2.4 Sécurité

- L'exécutant n'exécute que des **intentions typées** (`search`, `cart_sync`). Il n'exécute jamais une URL ou une requête venue du backend.
- Le transport MAIN rejette toute requête hors de `ALLOWED_ENDPOINTS` (méthode, chemin, origine `https://www.carrefour.fr`).
- Les résultats de jobs passent par des schémas zod `.strict()`. Aucun cookie, en-tête ou corps de réponse brut ne remonte au backend.
- Les diagnostics (réponses brutes) restent en local dans l'extension. On les exporte à la main, en mode dev.
- Secrets :
  - `ANTHROPIC_API_KEY` et `RELAY_TOKEN` via `wrangler secret` ;
  - en local, dans `.dev.vars`, qui est gitignoré.
- Relais VPS : connexions sortantes uniquement (pull HTTPS avec bearer), aucun port entrant. Pour faire tourner le token : `wrangler secret put RELAY_TOKEN`.

## 3. Modèle de données (D1)

| Table | Colonnes | Contraintes |
|---|---|---|
| `users` | `id` (uuid), `name`, `is_admin`, `preferences` (JSON `Preferences`, défaut `{}`), `created_at` | |
| `devices` | `id`, `user_id`, `label`, `token_hash`, `created_at`, `last_seen_at`, `revoked_at` | `token_hash` UNIQUE ; FK vers `users` |
| `pairing_codes` | `code_hash` (PK), `user_id`, `expires_at`, `used_at` | usage unique |
| `baskets` | `id`, `user_id`, `provider`, `store_ref`, `status`, `inputs` (JSON), `error` (JSON), `created_at`, `updated_at` | `status` CHECK ∈ `parsing`, `searching`, `matching`, `ready`, `pushing`, `pushed`, `failed` ; index (`user_id`, `created_at`) |
| `basket_items` | `id`, `basket_id`, `position`, `ingredient_key`, `label`, `quantity`, `unit`, `sources` (JSON), `search_query`, `exclude_terms` (JSON), `status`, `product_ref`, `packs`, `candidates` (JSON, au plus 8 instantanés `ProductOffer`), `reason`, `reason_source` | FK CASCADE vers `baskets` ; `unit` ∈ `g`, `ml`, `piece` ; `status` ∈ `pending`, `proposed`, `unmatched`, `removed` ; `reason_source` ∈ `memory`, `rules`, `llm`, `user` |
| `choices` | `user_id`, `provider`, `ingredient_key`, `product_ref`, `product_label`, `source` (`validated` ou `replaced`), `use_count`, `updated_at` | PK (`user_id`, `provider`, `ingredient_key`) |
| `jobs` | `id`, `user_id`, `basket_id`, `kind`, `status`, `payload`, `progress`, `result`, `error`, `usage` (JSON), `attempts`, `claimed_by`, `lease_until`, `created_at`, `updated_at` | `kind` ∈ `provider.search`, `provider.cart_sync`, `llm` ; `status` ∈ `pending`, `running`, `paused`, `done`, `failed`, `cancelled` ; index (`status`, `kind`, `created_at`) ; index unique partiel : un seul `cart_sync` actif par utilisateur |

Le schéma `Preferences` (zod, dans `contracts`) contient :
- `budgetCents?` : budget par panier ;
- `diet[]` : `vegetarian`, `vegan`, `gluten_free`, `lactose_free`, `no_pork`, `halal` ;
- `allergies[]` : texte libre ;
- `organic` : `no`, `prefer` ou `require` ;
- `privateLabel` : `prefer`, `neutral` ou `avoid` ;
- `favoriteBrands[]` et `bannedBrands[]` ;
- `packSize` : `small`, `neutral` ou `value` ;
- `notes?` : texte libre transmis au LLM.

**Règles d'accès**
- Toute fonction de `apps/api/src/db/` prend `userId` en premier paramètre et filtre dessus. Aucune route n'accepte un `userId` en entrée : il vient toujours du token.
- L'exécutant ne peut réserver que des jobs `provider.*` dont `user_id` est celui de son appareil.
- Le relais ne peut réserver que des jobs `llm`, quel que soit l'utilisateur. Il ne voit que le prompt.
- L'admin peut créer des utilisateurs et générer des codes d'appairage. Aucune route ne lui permet de lire le panier d'un autre utilisateur.
- **Jamais stockés :** cookies, en-têtes et identifiants Carrefour, réponses brutes, adresse, carte de fidélité.

Les migrations sont append-only, avec des numéros réservés :
- `0001_init` (étape 1) : toutes les tables sauf `choices` ;
- `0002_choices` (étape 7).

## 4. Interfaces à figer à l'étape 1

Figées dans `packages/contracts` : en cas d'écart, c'est le code qui fait foi, et cette section doit être mise à jour.

### 4.1 Domaine (`packages/contracts`)

```ts
type ProviderId = 'carrefour';
type Unit = 'g' | 'ml' | 'piece';

interface ProductOffer {
  provider: ProviderId;
  ref: string;                                  // EAN
  name: string;
  brand?: string;
  pack?: { amount: number; unit: Unit };        // contenance d'un article
  priceCents?: number;
  unitPrice?: { cents: number; per: 'kg' | 'l' | 'piece' };
  available: boolean;
  maxQuantity?: number;                         // plafond par article (ordering.max chez Carrefour)
  variableWeight?: boolean;                     // vrac / poids estimé : affichage « ≈ »
  category?: string;                            // rayon de premier niveau (frais ou transformé)
  isOrganic?: boolean;
  isPrivateLabel?: boolean;
  imageUrl?: string;
}
interface StoreContext { provider: ProviderId; storeRef: string; label?: string }
interface CartLine { ref: string; quantity: number }

type BasketInput =
  | { kind: 'text'; text: string }
  | { kind: 'recipe_url'; url: string; servings?: number }
  | { kind: 'recipe_text'; text: string; servings?: number };
```

### 4.2 Interface Provider (`contracts`, implémentée par `provider-carrefour`)

```ts
interface ProviderClient {
  id: ProviderId;
  getContext(opts?: { requireLogin?: boolean }): Promise<StoreContext>; // ProviderError 'no_store' | 'auth_required' (session anonyme via /api/me)
  search(query: string, max: number): Promise<ProductOffer[]>;
  getOffers(refs: string[]): Promise<ProductOffer[]>;
  getCart(): Promise<CartLine[]>;
  setQuantity(ref: string, quantity: number): Promise<void>; // absolu ; 0 = retirer (endpoint dédié chez Carrefour)
  session: { siteUrl: string; tabUrlPattern: string; refreshUrl: string; loginUrl: string; isOnSite(url: string): boolean };
}
type Transport = (req: { method: 'GET' | 'POST' | 'PATCH'; url: string; headers: Record<string, string>; body?: string })
  => Promise<{ status: number; cfMitigated: boolean; contentType: string | null; body: string }>;
// ProviderError.code : auth_required | challenge | rate_limited | no_store | schema_mismatch | http | network
// createCarrefourClient(transport: Transport): ProviderClient
```

### 4.3 Interface Exécutant : le protocole HTTP des jobs

C'est ce contrat que l'exécutant implémente. Le plan B (Tauri avec rs-carrefour-cli) devra l'implémenter tel quel.

| Route | Appelant | Corps → réponse |
|---|---|---|
| `POST /v1/jobs/claim` | exécutant, relais | `{kinds, agent:{name, version}}` → `200 Job` ou `204` |
| `POST /v1/jobs/:id/progress` | exécutant, relais | `{done, total, label?, lines?}` → `{leaseUntil, cancel}` |
| `POST /v1/jobs/:id/pause` | exécutant | `{reason: 'login_required' \| 'challenge'}` → 204 |
| `POST /v1/jobs/:id/resume` | exécutant | `{}` → `{leaseUntil}` |
| `POST /v1/jobs/:id/complete` | exécutant, relais | `{result}` → 204 (validé selon `kind`) |
| `POST /v1/jobs/:id/fail` | exécutant, relais | `{error:{code, message, retryable}}` → 204 |

| `kind` | payload | result |
|---|---|---|
| `provider.search` | `{provider, items:[{itemId, query}], refs: string[], max}` | `{context, byItem:[{itemId, offers}], byRef: ProductOffer[]}` |
| `provider.cart_sync` | `{provider, lines:[{ref, quantity, label}]}` | `{context, lines:[{ref, outcome: 'set'\|'unchanged'\|'unavailable'\|'failed', before, after, error?}]}` |
| `llm` | `{purpose: 'parse'\|'pick', model, system, user, jsonSchema}` | `{text, usage:{inputTokens, outputTokens}}` |

**Bail (lease)**
- Un job réservé a un bail de 120 s, prolongé à chaque `progress`.
- Le cron remet en `pending` un job `running` dont le bail a expiré, tant que `attempts < 3`. Au-delà, le job passe en `failed`.
- Un job `paused` passe en `failed (login_timeout)` après 20 min.

### 4.4 API utilisée par l'UI

| Route | Corps → réponse |
|---|---|
| `POST /v1/pair` (publique) | `{code, label}` → `{token, user}` |
| `GET /v1/me` · `PUT /v1/me/preferences` | → `{user, preferences}` · `Preferences` → `Preferences` |
| `POST /v1/me/pairing-codes` | → `{code, expiresAt}` (appairer un autre appareil) |
| `POST /v1/admin/users` (admin) | `{name}` → `{user, code}` |
| `POST /v1/baskets` | `{inputs: BasketInput[]}` → `202 Basket` |
| `GET /v1/baskets` · `GET /v1/baskets/:id` | historique · panier, lignes et job en cours avec sa progression |
| `PATCH /v1/baskets/:id/items/:itemId` | `{op:'choose', ref}` \| `{op:'packs', packs}` \| `{op:'remove'}` \| `{op:'restore'}` → ligne |
| `POST /v1/baskets/:id/items/:itemId/search` | `{query}` → 202 (job de recherche sur une seule ligne, pour remplacer à la main) |
| `POST /v1/baskets/:id/push` | → `{jobId}` ; 409 si un push est déjà actif |
| `POST /v1/baskets/:id/retry` | relance l'étape en échec |
| `GET /v1/jobs/:id` | job et progression |

Les erreurs ont toujours la forme `{error:{code, message}}`. Les codes sont une union dans `contracts`.

### 4.5 Messages internes à l'extension

- **Panel → SW :** `{type:'wake'}` déclenche un claim immédiat, puis une alarme d'une minute tant que des jobs sont actifs. `{type:'focusCarrefour'}` met l'onglet Carrefour au premier plan.
- **SW → panel :** pas de message. Le SW écrit la clé `executor` dans `chrome.storage.session`, avec la forme `{state: 'unpaired'|'idle'|'busy'|'login_required'|'challenge'|'no_store', jobId?, detail?}`. Le panel l'écoute via `chrome.storage.onChanged`.
- **SW → onglet :** `chrome.scripting.executeScript({target:{tabId}, world:'MAIN', func: mainWorldFetch, args:[req]})`. `mainWorldFetch` est autonome (aucun import, aucune closure) et renvoie `{status, cfMitigated, body}`.

### 4.6 LLM

- `LlmClient.complete({purpose, model, system, user, jsonSchema}) → {text, usage}`. Une seule implémentation : `anthropic`.
- Les prompts sont versionnés dans `apps/api/src/llm/prompts/{parse,pick}.ts`. Chacun exporte `{system, buildUser(input), schema}`.
- Le Worker valide la sortie dans les deux runtimes, avec un seul nouvel essai si elle est invalide.
- **Sortie de `parse`**, une ligne par ingrédient, avec ces champs :
  - `sourceIndex` ;
  - `key`, en français, au singulier, sans marque (ex. `lait demi-écrémé`) ;
  - `label` ;
  - `quantity` et `unit` (`g`, `ml` ou `piece`) ;
  - `pieceWeightG?` ;
  - `query` ;
  - `excludeTerms[]` ;
  - `approx`.
- **Entrée de `pick` :** un résumé des préférences, plus pour chaque ligne `{itemId, label, need, candidates[≤6]}`.
- **Sortie de `pick` :** pour chaque ligne, `{itemId, ref|null, alternatives[≤3], reason}`. `reason` fait au plus 80 caractères.

## 5. Étapes

Les étapes marquées ⚑ demandent plus de réflexion. Une étape n'est finie que si deux conditions sont réunies :
- `pnpm verify` passe au vert ;
- ses critères d'acceptation sont vérifiés et notés ici.

### Étape 0 : spike Carrefour (manuel) ⚑
- **Statut :** ✅ fait le 2026-10-18. Résultats dans `docs/spike-carrefour.md`, fixtures dans `packages/provider-carrefour/fixtures/`. Go pour le contexte navigateur. Seul reste non testé : l'expiration après 60 min d'inactivité, couverte par la détection via `/api/me`.
- **Objectif :** remplir les inconnues de la section 1 avant de coder. C'est aussi le go/no-go du contexte navigateur.
- **Fichiers :**
  - `docs/spike-carrefour.md`, rempli à partir du gabarit de l'annexe A ;
  - `packages/provider-carrefour/fixtures/*.json`, réponses brutes nettoyées des données personnelles (nom, email, adresse, carte de fidélité).
- **Critères :**
  - chaque ligne du gabarit a une réponse (OK ou KO, plus la preuve) ;
  - fixtures présentes pour `autocomplete`, `s`, `api/cart` (vide et rempli), `products` et la réponse du `PATCH` ;
  - choix fait entre `/autocomplete` et `/s` ;
  - méthode de retrait confirmée ;
  - signal d'expiration identifié ;
  - débit toléré mesuré.
- **No-go :** si le `PATCH` échoue depuis la console de la page, on passe à l'analyse du plan B (Tauri) avant toute autre étape.

### Étape 1 : squelette bout en bout, 3 items vers un vrai panier Carrefour
- **Statut :** ✅ livrée le 2026-10-19, testée en réel dans Arc. Critères vérifiés :
  - 1 : `pnpm verify` passe, 195 tests ;
  - 2 : deux paniers poussés, un de 3 lignes et un de 9, toutes les lignes en `set` ;
  - 5 : aucun cookie dans D1.

  Restent à vérifier à la main : 3 (second push sans écriture), 4 (article ajouté à la main intact) et 6 (push refusé quand on est déconnecté).

  Décision prise pendant le test : Arc ne gère pas le side panel et gèle les onglets en arrière-plan. Le clic sur l'icône ouvre donc le panneau dans un onglet, et chaque job met l'onglet du magasin au premier plan, puis rend l'onglet précédent.
- **Objectif :** saisir « lait, oeufs, pâtes » dans le side panel, valider, et retrouver 3 produits dans le panier carrefour.fr. Pas de LLM : on découpe sur les virgules et les retours à la ligne, avec une quantité de 1, et on prend la première offre disponible.
- **Fichiers :**
  - racine : `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `scripts/check-boundaries.sh`, `scripts/create-user.ts` ;
  - `packages/contracts` : sections 4.1 à 4.3 ;
  - `packages/provider-carrefour` : `getContext` (via `/api/me` et `/api/cart`), `search` (`/autocomplete`), `getCart`, `setQuantity` (`PATCH /api/cart?refresh=true`, et `PATCH /api/cart/items` pour 0), `ALLOWED_ENDPOINTS`, tests sur les fixtures ;
  - `apps/api` : `0001_init.sql`, auth par token, `/v1/pair`, `/v1/baskets` (création naïve, GET, push), `/v1/jobs/*`, `advanceBasket` ;
  - `apps/extension` : manifest, SW (boucle de claim, onglet, transport MAIN, `cart-sync` par diff), panel minimal (appairage, saisie, liste, bouton Envoyer, progression).
- **Critères :**
  1. `pnpm verify` passe au vert : tests sur les fixtures, `diffCart` et claim/bail sur D1 local.
  2. En manuel : 3 lignes proposées, avec leur prix, en moins d'une minute. Après le push, le panier carrefour.fr contient les 3 produits en quantité 1.
  3. Un second push du même panier se termine avec 3 résultats `unchanged`, sans aucun `PATCH` envoyé (vérifié dans le log de l'extension).
  4. Un article ajouté à la main dans le panier Carrefour avant le push est toujours là après.
  5. `wrangler d1 export` filtré par `rg -i 'FRONTONE|c4iam|cf_bm|cookie'` ne renvoie rien.
  6. Déconnecté de Carrefour, un push échoue avec `auth_required` et n'écrit rien, même pas dans le panier anonyme. La pause et la reprise après login arrivent à l'étape 2.
- **Dépend de :** l'étape 0.

### Étape 2 : robustesse de l'exécutant ⚑
- **Statut :** en partie faite pendant le test réel (2026-10-19). Fait :
  - délai maximal de 15 s par injection ;
  - onglet du magasin mis au premier plan pendant les jobs, ce qu'Arc exige ;
  - rechargement automatique de l'onglet sur un challenge Cloudflare ;
  - reprise d'un job dont le bail a expiré au `claim` suivant ;
  - bouton « Relancer » sur un panier en échec.

  Reste : la pause sur `login_required` avec refresh silencieux puis reprise, le cron de bail, et le bouton « Vérifier le contrat ».
- **Objectif :** gérer la session, les erreurs, la reprise et l'annulation.
- **Fichiers :** `apps/extension/src/background/{session,runner,tab}.ts`, le cron (`scheduled`) de `apps/api` qui fait expirer les baux, et un bouton dev « Vérifier le contrat Carrefour » (lectures seules : recherche « lait », lecture du panier, parsing).
- **Comportement :**
  - `cart_sync` appelle `getContext({requireLogin: true})` au début et de nouveau à la vérification finale. Une session anonyme est traitée comme un `auth_required`.
  - `auth_required`, 401, ou 403 sans `cf-mitigated` : refresh silencieux, puis un seul nouvel essai.
  - Si le refresh échoue : pause `login_required`, onglet de login mis au premier plan. On attend que `tabs.onUpdated` revienne sur www hors `/mon-compte/login`, puis on reprend.
  - 403 avec `cf-mitigated` : pause `challenge`, onglet au premier plan.
  - 429, 5xx ou erreur réseau : backoff de 2 s, puis 5 s, puis 15 s, en respectant `Retry-After`.
  - `schema_mismatch` : échec sans nouvel essai, et diagnostic conservé en local.
- **Critères :**
  1. Une déconnexion dans un autre onglet pendant un push met le job en pause et ouvre le login. Après reconnexion, le push se termine sans doublon.
  2. Si on tue Chrome pendant un push, le bail expire et le job est repris au redémarrage. Le panier final est correct.
  3. Avec un transport factice qui renvoie 429 puis 200, la ligne finit `set`. Avec 3 réponses 500, le job finit `failed` avec `retryable: true`.
  4. L'annulation depuis le panel arrête le job à la ligne suivante.
- **Dépend de :** l'étape 1.

### Étape 3 : parse LLM, runtime API ⚑
- **Statut :** ✅ faite le 2026-10-19 avec le runtime `cli` (`claude -p` en local via le relais de l'étape 9) : l'utilisateur n'a pas de clé API. L'éval passe 23 cas sur 23, en 3 à 19 s par liste. Le runtime `api` reste à brancher, à l'emplacement marqué dans `POST /v1/baskets`.
- **Objectif :** remplacer le découpage naïf. Normaliser et développer les plats (« de quoi faire un guacamole »), convertir dans l'unité canonique, agréger les lignes.
- **Fichiers :** `apps/api/src/llm/{client,anthropic,runner}.ts`, `prompts/parse.ts`, `pipeline/{aggregate,units}.ts` et `eval/` (environ 20 cas, plus la commande `pnpm eval:llm`).
- **Critères :**
  1. L'éval atteint au moins 90 % de lignes correctes (bonne clé, quantité à ±20 % près).
  2. « lait, 6 oeufs, pâtes, de quoi faire un guacamole » donne avocat, citron vert, oignon, coriandre, tomate, plus les 3 autres lignes.
  3. Un parse de 30 items coûte moins de 0,005 $ (lu dans `jobs.usage`).
  4. Les tests du pipeline passent avec un `LlmClient` factice.
  5. Un job `llm` en erreur est relancé par le cron, 3 tentatives au plus.
- **Dépend de :** l'étape 1.

### Étape 4 : recettes
- **Statut :** extraction faite et testée (`apps/api/src/recipes/`, 5 fixtures réelles), mais pas encore branchée. `recipe_url` répond encore 400. L'extension envoie déjà les lignes qui ne contiennent qu'une URL en `recipe_url`.
- **Objectif :** récupérer une URL, extraire le JSON-LD `Recipe` (y compris dans un `@graph`) et lire `recipeYield`. Mettre à l'échelle les portions, agréger plusieurs recettes, et accepter une recette collée en texte en repli.
- **Fichiers :** `apps/api/src/recipes/`, avec des fixtures HTML de Marmiton, 750g, CuisineAZ, Journal des Femmes et un blog.
- **Critères :**
  1. Les 5 fixtures HTML donnent la bonne liste d'ingrédients et le bon nombre de portions.
  2. Deux recettes, pour 4 et pour 6 personnes, donnent des quantités agrégées correctes (test).
  3. Une URL qui bloque le Worker renvoie une erreur claire qui propose de coller le texte.
- **Dépend de :** l'étape 3 pour l'intégration. L'extraction seule est parallélisable.

### Étape 5 : préférences, règles et formats ⚑
- **Statut :** ✅ faite le 2026-10-19. Inclut :
  - lecture des contenances, 27 formats réels couverts ;
  - `packsNeeded` ;
  - filtres durs, dont un test de propriété sur 2 000 paniers qui vérifie qu'une marque bannie n'est jamais choisie ;
  - score et raisons en français ;
  - préférences transmises au LLM ;
  - écran Préférences et budget dans le panneau.

  Reste à tester en réel.
- **Objectif :**
  - formulaire de préférences et `PUT /v1/me/preferences` ;
  - parsing des contenances Carrefour (« 4x125g », « 1L », « x6 »), qui va dans `provider-carrefour` ;
  - détection MDD (liste de marques Carrefour) et bio ;
  - `packsNeeded`, filtres durs (termes exclus, marques bannies, bio exigé) et score (prix unitaire, bio, MDD, marques favorites, gaspillage) ;
  - total du panier comparé au budget.
- **Critères :**
  1. Au moins 30 cas de parsing de contenance, tirés des fixtures, passent.
  2. Une marque bannie n'est jamais choisie : test sur toutes les fixtures.
  3. Des tests en table couvrent `packsNeeded`, par exemple : 1 000 ml pour une brique de 1 L donne 1 ; 6 œufs pour une boîte de 12 donnent 1 ; 300 g pour un paquet de 250 g donnent 2.
  4. Le dépassement de budget est affiché.
- **Dépend de :** l'étape 1 et les fixtures de l'étape 0.

### Étape 6 : choix LLM groupé et revue complète ⚑
- **Statut :** à faire
- **Objectif :**
  - prompt `pick`, avec le top 6 des candidats pour chaque ligne non résolue ;
  - lignes avec alternatives, chip « source » (Mémoire, Règle, IA, Toi) et justification ;
  - +/− sur le nombre de paquets, retrait et restauration ;
  - recherche manuelle pour remplacer un produit.
- **Critères :**
  1. Un panier de 30 lignes déclenche au plus 2 jobs `llm` (assertion sur D1).
  2. Chaque ligne proposée a une `reason` et une `reason_source`.
  3. Remplacer un produit par une alternative met le total à jour.
  4. La recherche manuelle répond en moins de 10 s.
- **Dépend de :** les étapes 3 et 5.

### Étape 7 : mémoire
- **Statut :** à faire
- **Objectif :**
  - au push, écrire `choices` : `validated` pour toutes les lignes, `replaced` pour les lignes que l'utilisateur a corrigées ;
  - avant de chercher, résoudre les lignes par la mémoire et rafraîchir leurs EAN avec `getOffers` ;
  - si le produit mémorisé est indisponible, revenir à la recherche suivie de `pick`, avec une note.
- **Fichiers :** `migrations/0002_choices.sql`, `pipeline/memory.ts`.
- **Critères :**
  1. Si on rejoue une liste identique, aucune recherche n'est lancée pour les lignes mémorisées, un seul `POST /products` est envoyé, et aucun job `pick` n'est créé si tout est mémorisé.
  2. Un produit remplacé revient au panier suivant avec la raison « Ton choix du … ».
- **Dépend de :** l'étape 6.

### Étape 8 : multi-utilisateur
- **Statut :** à faire
- **Objectif :** `POST /v1/admin/users` avec son écran admin, appairage d'un second appareil, révocation d'un appareil, affichage du magasin.
- **Critères :**
  1. La suite de tests d'isolation passe :
     - A ne peut ni lire ni modifier les paniers de B (404) ;
     - l'exécutant de A ne peut pas réserver les jobs de B ;
     - un token révoqué renvoie 401.
  2. Un ami est appairé de zéro en moins de 5 minutes, en suivant le README.
- **Dépend de :** l'étape 1.

### Étape 9 : relais `claude -p` sur le VPS
- **Statut :** relais écrit et utilisé en local (`pnpm relay`), 25 tests. Le processus `claude` est isolé : dossier temporaire, aucun réglage utilisateur, aucun outil ni MCP, et l'environnement est nettoyé de `ANTHROPIC_API_KEY` et `RELAY_TOKEN`. Reste le déploiement sur le VPS avec systemd.
- **Objectif :** `services/llm-relay`, un script Node d'une centaine de lignes. Il réserve des jobs `llm`, lance `claude -p` et termine le job en `complete` ou en `fail`. Il tourne en unit systemd. Avec `LLM_RUNTIME=cli`, le runner interne du Worker ignore les jobs `llm`.
- **Critères :**
  1. L'éval de l'étape 3 passe en mode `cli`.
  2. Si on tue le relais au milieu d'un job, le bail expire et le job est repris.
  3. Aucun port entrant n'est ouvert sur le VPS.
- **Dépend de :** l'étape 3.

### Étape 10 : distribution
- **Statut :** à faire
- **Objectif :** fiche Chrome Web Store non répertoriée, page de politique de confidentialité (exigée par le Web Store), versioning, guide d'onboarding pour les amis.
- **Critères :** un ami installe l'extension depuis le lien non répertorié, s'appaire et pousse un panier.
- **Dépend de :** les étapes 2 et 8.

## 6. Parallélisation

```
0 ─► 1 ─┬─► 2 ──────────────────────────┐
        ├─► 3 ─┬─► 6 ─► 7               ├─► 10
        │      ├─► 9                    │
        │      └─► 4 (intégration)      │
        ├─► 4 (extraction seule)        │
        ├─► 5 ─► 6                      │
        └─► 8 ──────────────────────────┘
```

- **Séquentiel obligatoire :**
  - 0, puis 1 : le squelette fige `packages/contracts` ;
  - 6 a besoin de 3 et de 5 ;
  - 7 a besoin de 6 ;
  - 10 a besoin de 2 et de 8.
- **En parallèle après l'étape 1**, un agent par piste, chacun dans son répertoire :

  | Piste | Étapes | Répertoires |
  |---|---|---|
  | A | 2 | `apps/extension` |
  | B | 3, puis 9 | `apps/api/src/llm`, `services/llm-relay` |
  | C | 4 (extraction) | `apps/api/src/recipes` |
  | D | 5 | `pipeline/rank`, contenances dans `provider-carrefour` |
  | E | 8 | `routes/admin`, tests d'isolation |

- **Règles pour les agents en parallèle :**
  - `packages/contracts` n'est modifié que par une seule tâche à la fois, et ses consommateurs sont mis à jour dans le même changement ;
  - les numéros de migration sont réservés (section 3) ;
  - un agent ne modifie pas les fichiers d'une autre piste.
- **À ne pas déléguer sans revue humaine :**
  - l'étape 0 (navigateur réel, compte réel) ;
  - les critères manuels des étapes 1 et 2 (vrai panier Carrefour) ;
  - toute modification de `ALLOWED_ENDPOINTS`.

## 7. Risques et décisions ouvertes

| Risque | Mitigation |
|---|---|
| L'API Carrefour change sans préavis | Module unique, schémas zod, erreur `schema_mismatch` explicite, fixtures, bouton dev « Vérifier le contrat » à lancer avant chaque release. |
| Cloudflare détecte un rythme de requêtes non humain | Appels séquentiels, jitter de 0,7 à 1,5 s, aucun keep-alive, mémoire pour réduire les recherches. On suit le taux de 403 `cf-mitigated`. |
| Sanction du compte (CGU Carrefour) | Usage personnel, volume faible, chaque ami sur son propre compte. Aucun paiement automatisé. |
| Fruits et légumes vendus au poids ou à la pièce | Spike, puis règle dédiée. L'UI affiche « ≈ » quand la quantité est approximative. |
| Pas d'attributs fiables pour bio, MDD ou régime | Heuristiques sur la marque et le titre. Régimes et allergies sont appliqués au mieux, avec un avertissement visible ; **aucune garantie sur les allergènes**. |
| Durée de vie du service worker MV3 pendant une pause | L'état est dans D1 et dans `chrome.storage`, et la reprise est déclenchée par des événements (`tabs.onUpdated`, alarmes). |
| Revue du Chrome Web Store (automatisation d'un site tiers) | Politique de confidentialité, justification des permissions. En attendant : installation non empaquetée pour les amis. |
| Qualité du parse en français | Éval de 20 cas. Passage à Sonnet 5.5 si Haiku 5.5 n'atteint pas le seuil. |
| Sites de recettes qui bloquent le Worker | Erreur claire et repli sur le texte collé. Plus tard, éventuellement : récupération par l'extension. |
| Conditions d'usage de `claude -p` pour servir des amis | Le relais est optionnel ; l'API reste le défaut. |

**Spikes :**
- l'étape 0 ;
- un mini-spike à l'étape 5 sur les contenances et le poids.

**Décisions ouvertes, valeurs par défaut v1 entre parenthèses :**
- mode de push (merge seulement ; « vider le panier » plus tard) ;
- budget (par panier, affiché sans rééquilibrage automatique) ;
- cache de recherche (aucun) ;
- liste explicite de produits « ne plus proposer » (non).

## Annexe A : spike console (étape 0)

À coller dans la console DevTools d'un onglet `www.carrefour.fr`, connecté, avec un magasin Drive choisi. La console s'exécute en MAIN world, comme le fera l'extension.

Tout le script est dans une IIFE : le site déclare déjà des globales minifiées (`j`, etc.), et un `const` au niveau global ferait échouer tout le bloc. Les outils restent accessibles via `window.__karto`.

```js
(async () => {
  const H = { 'x-requested-with': 'XMLHttpRequest', accept: 'application/json, text/plain, */*' };
  const k = (window.__karto = { log: [] });
  const call = async (path, o = {}) => {
    const r = await fetch(path, { credentials: 'include', ...o, headers: { ...H, ...o.headers } });
    const res = { path, method: o.method ?? 'GET', status: r.status, cf: r.headers.get('cf-mitigated'),
      type: r.headers.get('content-type'), body: await r.text() };
    k.log.push(res);
    return res;
  };
  const json = (r) => { try { return JSON.parse(r.body); } catch { return null; } };
  k.call = call;
  k.cart = async () => json(await call('/api/cart'))?.cart;
  k.qty = async (ean) => (await k.cart())?.items?.flatMap((i) => i.products ?? [])
    .find((x) => x.product?.attributes?.ean === ean)?.counter ?? 0;
  k.patch = async (ean, counter) => {
    const c = await k.cart();
    const r = await call('/api/cart', { method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trackingRequest: { pageType: 'search', pageId: 'search' },
        items: [{ basketServiceId: c.facilityServiceId, counter, ean, subBasketType: c.type }] }) });
    return { status: r.status, cf: r.cf, qtyAfter: await k.qty(ean) };
  };
  k.products = async (gtins) => {
    const c = await k.cart();
    return call('/products', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ gtins, facilityServiceId: c.facilityServiceId }) });
  };
  k.burst = async (n = 20, ms = 1000) => {
    for (let i = 0; i < n; i++) {
      const q = ['lait', 'pain', 'riz', 'beurre', 'pomme'][i % 5];
      const r = await call(`/autocomplete?q=${q}&productCard=true&maxResults=5`);
      console.log(i, r.status, r.cf);
      await new Promise((ok) => setTimeout(ok, ms));
    }
  };
  k.save = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(k.log, null, 2)], { type: 'application/json' }));
    a.download = 'carrefour-spike.json';
    a.click();
  };

  const ac = await call('/autocomplete?q=lait&productCard=true&maxResults=10');
  await call('/s?q=lait');
  const c = await k.cart();
  console.table(k.log.map(({ path, status, cf, type, body }) => ({ path, status, cf, type, size: body.length })));
  console.log('magasin', { facilityServiceId: c?.facilityServiceId, type: c?.type });
  console.table((json(ac)?.data?.products ?? []).map((p) => ({ ean: p.attributes?.ean, titre: p.attributes?.title, marque: p.attributes?.brand })));
})();
```

Ensuite, en un seul collage, avec un vrai EAN pas cher qui n'est **pas** déjà dans le panier (remplacer l'EAN en dernière ligne) :

```js
(async (ean) => {
  for (const n of [1, 2, 0]) console.log('counter', n, await __karto.patch(ean, n)); // attendu : qtyAfter 1, puis 2, puis 0
  console.log('products', (await __karto.products([ean])).status);
  await __karto.burst();  // 20 recherches à 1 req/s : surveiller 429 / 403
  __karto.save();         // télécharge carrefour-spike.json (toutes les réponses brutes)
})('3560071267964');
```

Pour tester l'expiration : se déconnecter dans un autre onglet, puis, **sans recharger** l'onglet du spike, lancer `await __karto.call('/api/cart')` et refaire `__karto.save()`.

Gabarit de `docs/spike-carrefour.md` :

| Question | Résultat (OK/KO, preuve) |
|---|---|
| `/autocomplete` : JSON ? prix, format, marque et dispo présents ? | |
| `/s` : JSON ? champs en plus (facettes, labels) ? | |
| Prix du magasin en anonyme, ou session requise ? | |
| `PATCH counter=1` ajoute ? `=2` met bien 2 (absolu) ? `=0` retire ? | |
| `POST /products` : prix et dispo du magasin ? | |
| Sans `x-requested-with` : du HTML au lieu du JSON ? | |
| Expiration (déconnexion dans un autre onglet) : statut, `cf-mitigated`, corps ? | |
| Le refresh silencieux (URL `authorize`) renouvelle la session ? | |
| 20 recherches à 1 req/s : un 429 ou un 403 ? | |
| Bio et MDD : quels champs ou indices ? | |
| Fruits et légumes : vente à la pièce ou au kg, sens du `counter` ? | |
