# Karto : instructions pour les agents

Karto transforme une liste de courses ou des recettes en panier Carrefour Drive, en tenant compte des préférences de l'utilisateur. Le plan et l'état d'avancement sont dans `PLAN.md` : lis-le avant toute tâche, et mets à jour le statut de l'étape à la fin.

## Structure

```
apps/
  api/                    API (Hono), Worker Cloudflare ou Node : pipeline panier, règles, mémoire, jobs, runner LLM, cron
    src/routes/           me, baskets, jobs, admin
    src/pipeline/         advance-basket, aggregate, rank, pick, memory, amend, expire-jobs
    src/llm/              LlmClient, anthropic, runner, prompts/ (parse, pick, amend)
    src/recipes/          fetch d'URL + extraction JSON-LD
    src/db/               requêtes D1 (toujours scopées par userId)
    node/                 auto-hébergement : node:http → fetch du Worker, D1 sur node:sqlite, migrations, shim cloudflare:workers
    migrations/           SQL D1, append-only
    scripts/              create-user.ts (Node, sans dépendance)
    eval/                 éval LLM (payante, hors CI)
  extension/              Chrome MV3
    public/manifest.json  sans version : le build y écrit celle de package.json
    src/background/       exécutant : boucle de jobs, onglet, transport MAIN, session, cart-sync
    src/sidepanel/        SPA React
packages/
  contracts/              schémas zod et types partagés (domaine, API, jobs, ProviderClient)
  provider-carrefour/     SEUL endroit où vit le code Carrefour (endpoints, parsers, fixtures, tests de contrat)
services/
  llm-relay/              (option) script Node du VPS, relais claude -p
scripts/                  check-boundaries.sh
deploy/                   VPS : units systemd (API, relais), Caddyfile, karto.env.example
docs/                     spike-carrefour.md, confidentialite.md, chrome-web-store.md
```

## Commandes

Elles existent à partir de l'étape 1. Toutes se lancent depuis la racine.

| Commande | Effet |
|---|---|
| `pnpm install` | Installe le workspace |
| `pnpm dev:api` | `wrangler dev`, avec D1 local, sur http://localhost:8787 |
| `pnpm serve` | Serveur Node (`apps/api/node/server.ts`) sur http://127.0.0.1:8787, base `apps/api/data/karto.sqlite`, migrée au démarrage, avec `.dev.vars` chargé |
| `pnpm relay` | Relais LLM en local (`claude -p`), avec `RELAY_TOKEN` lu dans `.dev.vars` |
| `pnpm dev:ext` | `vite build --watch` dans `apps/extension/dist` |
| `pnpm test` / `pnpm test:watch` | Vitest dans tous les packages (aucun appel réseau réel) |
| `pnpm lint` / `pnpm format` | `biome check` / `biome check --write` |
| `pnpm typecheck` | `tsc --noEmit` dans chaque package |
| `pnpm check:boundaries` | Échoue si du code Carrefour sort de son module ou si un endpoint interdit apparaît |
| `pnpm verify` | lint, typecheck, test et check:boundaries. **Obligatoire avant de déclarer une tâche finie** |
| `pnpm build` | Build de l'API (`wrangler deploy --dry-run`) et de l'extension |
| `pnpm zip:ext` | Build de production de l'extension, puis `apps/extension/karto-<version>.zip` |
| `pnpm db:migrate:local` / `pnpm db:migrate:remote` | Applique les migrations D1 |
| `pnpm user:create <nom> [--admin] [--remote \| --db <fichier>]` | Crée un utilisateur et affiche un code d'appairage. Par défaut sur la D1 locale. `--db` vise la base SQLite du serveur Node ; un chemin relatif part de `apps/api` |
| `pnpm --filter api eval:llm` / `eval:amend` | Éval du parse et de l'amend avec `claude -p`. **Payante**, à lancer à la main |
| `pnpm --filter api deploy` | Déploie le Worker et son cron |

Pour charger l'extension en local :
1. `pnpm dev:ext`.
2. Dans `chrome://extensions`, activer le mode développeur.
3. Cliquer sur « Charger l'extension non empaquetée » et choisir `apps/extension/dist`.
4. Après chaque rebuild, recharger l'extension, puis fermer et rouvrir le side panel.

Dans le panneau, l'adresse du serveur se saisit à l'appairage (http://localhost:8787 en local).

Variables d'environnement locales, toutes gitignorées :
- `apps/api/.dev.vars` : `LLM_RUNTIME` (`cli` ou `api`), `LLM_MODEL=claude-haiku-5-5`, `RELAY_TOKEN`, et `ANTHROPIC_API_KEY` en mode `api`. Pour `pnpm serve`, il faut aussi `HOST`, `PORT` et `KARTO_DB` (facultatifs) ;
- `apps/extension/.env.local` : `VITE_API_URL=http://localhost:8787`, qui ne fait que préremplir l'adresse du serveur.

La version de l'extension se change uniquement dans `apps/extension/package.json`. Le déploiement sur VPS ou Cloudflare est décrit dans `README.md`.

## Règles non négociables

1. **Le code Carrefour ne sort jamais de `packages/provider-carrefour`.** Cela couvre les URL, les chemins, les en-têtes, les noms de champs, les listes de marques et les formats de contenance. Les autres paquets ne voient que les types de `contracts`. Seule exception : `apps/extension/public/manifest.json` contient les host permissions. `pnpm check:boundaries` vérifie la règle.
2. **Aucun endpoint de paiement, de checkout, de commande, de créneau ou de code promo.** Ne jamais en porter, même en commentaire, en donnée ou en fixture. `ALLOWED_ENDPOINTS` est une liste fermée, et toute modification passe par une revue humaine. Un test vérifie que `POST /api/checkout/payment` et `/api/checkout/*` sont rejetés.
3. **Aucun secret, cookie, en-tête ou identifiant Carrefour côté serveur.** Ni dans D1, ni dans les logs, ni dans les payloads ou les résultats de jobs. Les résultats sont validés par des schémas zod `.strict()`. Les réponses brutes de Carrefour restent dans l'extension.
4. **Les appels Carrefour ne partent que du transport MAIN world, dans un onglet `www.carrefour.fr`.** Jamais depuis le Worker, le VPS, un script Node ou le service worker directement.
5. **Le backend n'envoie à l'exécutant que des intentions typées** (`provider.search`, `provider.cart_sync`), jamais une URL ou une requête HTTP à exécuter.
6. **Aucun appel réel à Carrefour ni à Anthropic dans les tests automatisés.** On utilise des fixtures et des clients factices. Les fixtures sont nettoyées des données personnelles : nom, email, adresse, carte de fidélité.
7. **Toute donnée utilisateur est filtrée par `userId`.** Les fonctions de `src/db/` le prennent en premier paramètre, et le `userId` vient toujours du token, jamais de la requête.
8. **Les appels LLM passent uniquement par les jobs `llm`.** Leur usage est enregistré, et on ne fait jamais un appel LLM par ligne : au plus 2 appels par panier (parse et pick).
9. **Modifier `packages/contracts` est un changement cassant.** Une seule tâche à la fois, qui met à jour tous les consommateurs dans le même changement.
10. **Les migrations D1 sont append-only**, avec les numéros réservés dans PLAN.md. On ne modifie jamais une migration déjà appliquée.
11. **Jamais de paiement ni de réservation de créneau**, même « pour tester ».

## Conventions

- **Langue :** le code, les identifiants et les commentaires sont en anglais ; la documentation et les textes de l'UI sont en français.
- **TypeScript :** strict, ESM, sans `any` (règle Biome), sans `!` non justifié. On préfère des fonctions et des modules simples aux classes ; les erreurs sont la seule exception.
- **API sous Node :** Node exécute `apps/api/src` tel quel (type stripping, `erasableSyntaxOnly`), donc pas de parameter properties, d'enum ni de namespace. Tout nouvel import depuis `cloudflare:workers` doit exister dans `apps/api/node/cloudflare-workers.ts`.
- **Nommage :**
  - fichiers en `kebab-case.ts` ;
  - fonctions en `camelCase`, types en `PascalCase` ;
  - schémas zod `FooSchema`, avec `type Foo = z.infer<typeof FooSchema>` ;
  - SQL en `snake_case`, JSON de l'API en `camelCase` ;
  - codes d'erreur en `snake_case`, déclarés comme une union dans `contracts`.
- **Validation :** zod à chaque frontière de confiance : requêtes HTTP entrantes, colonnes JSON de D1, réponses Carrefour, sorties LLM, messages `chrome.runtime`.
- **Erreurs :**
  - l'API lance `AppError(code, status)`, et le `onError` de Hono renvoie `{error:{code,message}}` ;
  - le provider lance `ProviderError(code, retryable)` ;
  - l'exécutant traduit chaque code en `pause`, `retry` ou `fail`.
  - Aucun `catch` vide. On logue avec du contexte (`jobId`, `basketId`), jamais avec des données Carrefour brutes.
- **Tests :**
  - Vitest, à côté du code (`foo.test.ts`) ;
  - logique pure (unités, agrégation, contenances, classement, `diffCart`) : tests en table ;
  - provider : tests de contrat sur les fixtures ;
  - API : `@cloudflare/vitest-pool-workers` avec D1 réel, LLM et exécutant factices.
- **Dépendances :** ne pas en ajouter sans justification dans la PR. Socle prévu : `hono`, `zod`, `@anthropic-ai/sdk`, `react`, `vite`, `wrangler`, `vitest`, `@cloudflare/vitest-pool-workers`, `@biomejs/biome`, `@types/chrome`.
- **Extension :** `mainWorldFetch` doit rester autonome (aucun import, aucune closure) : il est sérialisé par `executeScript`. Les appels Carrefour sont séquentiels, avec le délai défini dans `provider-carrefour`.
- **Définition de « fini » :**
  - `pnpm verify` passe au vert ;
  - les critères d'acceptation de l'étape (PLAN.md) sont vérifiés, y compris les manuels, dont on note le résultat ;
  - le statut est mis à jour dans PLAN.md.
