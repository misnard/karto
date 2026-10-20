# Karto

Karto transforme une liste de courses ou des recettes en panier Carrefour Drive. Tu tapes « lait, 6 oeufs, de quoi faire un guacamole », Karto trouve les produits dans ton magasin selon tes préférences, tu relis, et il remplit ton panier sur carrefour.fr. Le créneau et le paiement, c'est toi qui les fais sur le site : Karto ne paie jamais et ne réserve jamais de créneau.

Karto se compose d'une extension Chrome et d'un serveur. Chaque groupe d'amis utilise le serveur de la personne qui l'héberge.

- [Utiliser Karto](#utiliser-karto) : tu as reçu une adresse de serveur et un code.
- [Héberger un serveur](#héberger-un-serveur) : sur un VPS ou sur Cloudflare.
- [Confidentialité](docs/confidentialite.md).

## Utiliser Karto

Il te faut Chrome sur un ordinateur (pas de mobile), un compte carrefour.fr, et deux informations envoyées par la personne qui héberge Karto :
- l'**adresse du serveur**, par exemple `https://karto.exemple.fr` ;
- un **code d'appairage** de 10 caractères. Il ne sert qu'une fois et expire 15 minutes après sa création : demande-le quand tu es prêt.

### 1. Installer l'extension (2 min)

Pour l'instant, l'extension s'installe à la main. Un lien Chrome Web Store (non répertorié) remplacera ces étapes.

1. Télécharge `karto-<version>.zip` depuis la [page des versions](https://github.com/misnard/karto/releases), ou prends celui que l'hébergeur t'a envoyé.
2. Décompresse-le dans un dossier que tu gardes, par exemple `Documents/karto`. Si tu supprimes ce dossier, l'extension disparaît.
3. Ouvre `chrome://extensions` et active le **Mode développeur** en haut à droite.
4. Clique sur **Charger l'extension non empaquetée** et choisis le dossier décompressé (celui qui contient `manifest.json`).
5. Épingle Karto : icône puzzle de la barre d'outils, puis l'épingle à côté de Karto.

### 2. Préparer carrefour.fr (1 min)

Ouvre [www.carrefour.fr](https://www.carrefour.fr), connecte-toi et choisis ton magasin Drive. Karto utilise cet onglet et ta session : il ne connaît ni ton mot de passe ni tes cookies.

### 3. Relier ton navigateur (1 min)

1. Clique sur l'icône Karto : le panneau latéral s'ouvre sur « Relie ce navigateur ».
2. **Adresse du serveur** : colle l'adresse reçue. Elle doit commencer par `https://`.
3. **Code d'appairage** : tape le code. Majuscules, espaces et tirets n'ont pas d'importance.
4. **Nom de cet appareil** : par exemple « Chrome du bureau ».
5. Clique sur **Relier ce navigateur**.

Si le code est refusé, il a expiré ou il a déjà servi : demandes-en un autre.

### 4. Faire tes courses

1. Dans « Ta liste de courses », tape ce que tu veux : des articles (« lait, 6 oeufs »), des plats (« de quoi faire des lasagnes »), un lien de recette ou une recette collée. Indique le nombre de personnes.
2. Clique sur **Préparer le panier**. Karto lit la liste, cherche dans ton magasin, puis choisit (« Lecture… », « Recherche… », « Choix… », puis « Prêt »). L'onglet carrefour.fr passe au premier plan pendant la recherche : c'est normal.
3. Relis. Chaque ligne indique pourquoi ce produit (Mémoire, Règle, IA ou Toi). Tu peux changer de produit, chercher autre chose, ajuster le nombre de paquets avec +/− ou retirer une ligne.
4. Clique sur **Envoyer au panier**. Karto ajoute les produits dans ton panier carrefour.fr. Il ne touche pas aux articles que tu y as mis toi-même.
5. Sur carrefour.fr, choisis ton créneau et paie, comme d'habitude.

Bon à savoir :
- Si le panneau affiche « Connexion requise », reconnecte-toi dans l'onglet carrefour.fr : Karto reprend tout seul.
- **Préférences** : régime, allergies, bio, marques préférées ou bannies, budget. Karto en tient compte au mieux, **sans garantie sur les allergènes** : vérifie les produits.
- Karto retient les produits que tu envoies et les repropose la fois suivante (« Ton choix du … »).
- **Appareils** : la liste de tes navigateurs reliés. « Appairer un autre appareil » donne un code pour un autre navigateur, et « Révoquer » en déconnecte un.
- Sur Arc, le panneau s'ouvre dans un onglet.

## Héberger un serveur

Le serveur (`apps/api`) tourne au choix :
- **sur un VPS**, avec Node : une base SQLite, aucun compte cloud ;
- **sur Cloudflare** : un Worker avec une base D1.

Il a aussi besoin d'un LLM (Claude) pour lire les listes et choisir les produits. Deux façons de l'appeler :
- `LLM_RUNTIME=api` : le serveur appelle l'API Anthropic avec `ANTHROPIC_API_KEY`. Moins d'un centime par panier avec Haiku.
- `LLM_RUNTIME=cli` : le relais (`services/llm-relay`) lance `claude -p` avec un Claude Code connecté à ton abonnement.

Le code est sur [github.com/misnard/karto](https://github.com/misnard/karto).

### Option A : VPS

Il faut un serveur Linux avec systemd, Node ≥ 22.18 (24 LTS conseillé), git, pnpm (`corepack enable`) et [Caddy](https://caddyserver.com/docs/install). Il faut aussi un nom de domaine qui pointe sur le VPS, avec les ports 80 et 443 ouverts. Caddy obtient le certificat TLS tout seul. L'API n'écoute que sur `127.0.0.1:8787`, et le relais n'ouvre aucun port.

1. Créer l'utilisateur système et installer le code :
   ```sh
   sudo useradd --system --create-home --home-dir /var/lib/karto --shell /usr/sbin/nologin karto
   sudo git clone https://github.com/misnard/karto.git /opt/karto
   cd /opt/karto && sudo pnpm install --frozen-lockfile --prod
   ```
2. Configurer :
   ```sh
   sudo mkdir -p /etc/karto
   sudo cp deploy/karto.env.example /etc/karto/karto.env
   sudo chmod 600 /etc/karto/karto.env
   openssl rand -base64 32   # à coller dans RELAY_TOKEN
   sudo nano /etc/karto/karto.env
   ```
   Choisis `LLM_RUNTIME` : `cli` (relais) ou `api` (et décommente `ANTHROPIC_API_KEY`). La base va dans `KARTO_DB` (`/var/lib/karto/karto.sqlite`). Elle est créée et migrée au démarrage.
3. Démarrer l'API :
   ```sh
   command -v node   # si ce n'est pas /usr/bin/node, corrige ExecStart dans les deux units
   sudo cp deploy/karto-api.service deploy/karto-relay.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now karto-api
   journalctl -u karto-api -n 20   # « Karto API listening on http://127.0.0.1:8787 »
   ```
4. Ajouter le TLS : copie `deploy/Caddyfile` dans `/etc/caddy/Caddyfile`, remplace `karto.example.fr` par ton domaine, puis lance `sudo systemctl reload caddy`. Ensuite, `curl https://<domaine>/v1/me` doit renvoyer une erreur 401 en JSON.
5. LLM :
   - en mode `cli`, connecte Claude Code une fois pour l'utilisateur `karto`. Installe `claude` pour cet utilisateur (sinon renseigne `CLAUDE_BIN`), lance `sudo -u karto -H claude`, tape `/login`, puis :
     ```sh
     sudo systemctl enable --now karto-relay
     journalctl -u karto-relay -n 5   # « polling http://127.0.0.1:8787 for llm jobs »
     ```
   - en mode `api`, rien de plus : pas de relais.
6. Créer ton compte administrateur, avec l'utilisateur `karto` pour qu'il possède la base :
   ```sh
   sudo -u karto node /opt/karto/apps/api/scripts/create-user.ts Moi --admin --db /var/lib/karto/karto.sqlite
   ```
   C'est la commande `pnpm user:create <nom> --admin --db <fichier>`. Elle affiche le code d'appairage. Relie ton navigateur avec l'adresse `https://<domaine>`.

Mise à jour :
```sh
cd /opt/karto && sudo git pull && sudo pnpm install --frozen-lockfile --prod
sudo systemctl restart karto-api karto-relay   # les nouvelles migrations s'appliquent au démarrage
```

Sauvegarde : copie `/var/lib/karto/karto.sqlite` avec `sqlite3 /var/lib/karto/karto.sqlite ".backup /chemin/karto.bak"`.

### Option B : Cloudflare

Depuis un clone du dépôt, avec Node ≥ 22.18 et pnpm :

```sh
pnpm install
pnpm --filter api exec wrangler login
pnpm --filter api exec wrangler d1 create karto   # recopie le database_id dans apps/api/wrangler.jsonc
pnpm db:migrate:remote
```

Pour le mode `api`, mets `"LLM_RUNTIME": "api"` dans les `vars` de `apps/api/wrangler.jsonc` (la valeur par défaut est `cli`). Puis :

```sh
pnpm --filter api deploy                 # affiche l'adresse https://karto-api.<compte>.workers.dev
pnpm --filter api exec wrangler secret put ANTHROPIC_API_KEY   # mode api
pnpm --filter api exec wrangler secret put RELAY_TOKEN         # mode cli
pnpm user:create Moi --admin --remote    # code d'appairage de ton compte
```

En mode `cli`, fais tourner le relais sur une machine où `claude` est connecté :

```sh
KARTO_API_URL=https://karto-api.<compte>.workers.dev RELAY_TOKEN=<le même> pnpm --filter @karto/llm-relay start
```

Le déploiement enregistre aussi un cron chaque minute : il fait expirer les tâches bloquées et, en mode `api`, lance les appels LLM en attente. Après une mise à jour qui ajoute une migration, lance `pnpm db:migrate:remote` **avant** `pnpm --filter api deploy`.

### Inviter des amis

- Dans le panneau : **Appareils**, section **Admin** (visible des administrateurs seulement). Saisis le **Nom du nouvel utilisateur**, clique sur **Créer l'utilisateur** et envoie le code affiché.
- Ou en ligne de commande : `pnpm user:create <nom> [--db <fichier> | --remote]`.

Envoie à ton ami l'adresse du serveur, le code (valable 15 min) et le lien vers [Utiliser Karto](#utiliser-karto).

### Construire l'extension

```sh
echo "VITE_API_URL=https://karto.exemple.fr" > apps/extension/.env.local   # facultatif
pnpm zip:ext   # → apps/extension/karto-<version>.zip
```

`VITE_API_URL` ne fait que préremplir l'adresse du serveur à l'appairage : l'extension peut toujours se relier à n'importe quel serveur. La version vient de `apps/extension/package.json` : augmente-la avant chaque nouvelle distribution. Pour publier le zip : `gh release create v<version> apps/extension/karto-<version>.zip`. La publication sur le Chrome Web Store suit [docs/chrome-web-store.md](docs/chrome-web-store.md).

### Supprimer les données d'un utilisateur

Il n'existe pas encore de bouton. Retrouve l'`id` avec `SELECT id, name FROM users;`, puis exécute, dans cet ordre :

```sql
DELETE FROM jobs WHERE user_id = '<id>';
DELETE FROM choices WHERE user_id = '<id>';
DELETE FROM baskets WHERE user_id = '<id>';
DELETE FROM pairing_codes WHERE user_id = '<id>';
DELETE FROM devices WHERE user_id = '<id>';
DELETE FROM users WHERE id = '<id>';
```

Sur VPS, utilise `sqlite3 /var/lib/karto/karto.sqlite`. Sur Cloudflare, utilise `pnpm --filter api exec wrangler d1 execute karto --remote --command "…"`.

## Développer

Les commandes, les règles et la structure sont dans [CLAUDE.md](CLAUDE.md), et le plan et l'avancement dans [PLAN.md](PLAN.md). En bref : `pnpm install`, puis `pnpm dev:api` (Worker local) ou `pnpm serve` (serveur Node), `pnpm dev:ext`, et `pnpm verify` avant chaque commit.
