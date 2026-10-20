# Spike Carrefour (étape 0)

- **Date :** 2026-10-18
- **Contexte :** console DevTools d'un onglet `www.carrefour.fr` (MAIN world), session connectée, magasin Drive `0046-150-112` (`storeRef` 112), type `drive_clcv`.
- **Source brute :** `~/Downloads/Carrefour Spike (1).json`, à ne pas committer.
- **Fixtures nettoyées :** `packages/provider-carrefour/fixtures/`.

## Résultats

| Question | Résultat |
|---|---|
| `/autocomplete` : JSON ? prix, format, marque et dispo présents ? | ✅ 200, JSON. Les produits sont dans `data.products[]`. Tout y est (détail plus bas). Environ 6 Ko par produit. |
| `/s` : JSON ? champs en plus ? | ✅ 200, JSON. Même forme de produit dans `data[]`, 30 par page. En plus : `meta.total`, `links` pour la pagination, et des facettes dans `meta.facets` (Bio, Sans lactose, Produits Carrefour, Marque, Contenance, Prix…). Environ 185 Ko pour une page. |
| Prix du magasin en anonyme, ou session requise ? | ✅ Après déconnexion, `/autocomplete` répond toujours 200 et `/api/cart` garde le magasin `0046-150-112` : le magasin est porté par un cookie, pas par le compte. **La recherche n'a donc pas besoin d'être connecté.** Seul le push en a besoin. |
| `PATCH /api/cart` avec `counter=1`, puis `2`, puis `0` | ✅ `counter=1` donne 1. ✅ `counter=2` donne 2 : **la quantité est absolue**. ❌ **`counter=0` ne retire pas l'article** : il le ramène à 1, deux fois de suite, aussi après 3 s. C'est cohérent avec `ordering.min = 1`. |
| Retrait d'un article | ✅ **`PATCH /api/cart/items {trackingRequest, basketServiceId, ean, subBasketType}`**, un corps à plat sans quantité. C'est l'appel que fait le « − » du site quand la quantité passe de 1 à 0 (capturé avec un espion sur `fetch`). Il **retire la ligne entière**, même depuis une quantité de 3. Sur un article absent, il renvoie 200 sans rien ajouter : il est **idempotent**. (`DELETE /api/cart/product/{ean}` renvoie 404.) |
| `POST /products {gtins, facilityServiceId}` | ✅ 200. Même forme de produit dans `data[]`, avec les offres du magasin. |
| Sans `x-requested-with` : du HTML au lieu du JSON ? | ✅ Oui : `/autocomplete` répond **404 `text/html`**. L'en-tête est **obligatoire**. |
| Expiration (déconnexion dans un autre onglet) | ⚠️ **Ni 401 ni 403.** `/api/me` répond 200 avec `userId` et `email` vides. `/api/cart` répond 200 avec un **panier anonyme** qui garde le même magasin. `/autocomplete` répond 200. Un `PATCH` irait donc remplir le panier anonyme sans aucune erreur. **La connexion se détecte uniquement par `/api/me`.** |
| Le refresh silencieux (URL `authorize`) renouvelle la session ? | ✅ **Connecté :** la navigation vers l'URL `authorize` ramène à la homepage www sans aucune interaction. **Déconnecté :** elle arrive sur la page de login. On sait donc si la session est vivante grâce à l'URL d'arrivée (`isOnSite`), et c'est ce qui décide entre le nouvel essai et la pause `login_required`. |
| 20 recherches à 1 req/s : un 429 ou un 403 ? | ✅ 20/20 en 200, aucun `cf-mitigated`. Au total, environ 55 requêtes en quelques minutes sans aucun blocage. |
| Bio et MDD : quels champs ou indices ? | ✅ **Bio :** `attributes.flags` contient `flag.common.organic` (+ `clubs: flag.club.bio`). **MDD :** uniquement par la marque (voir plus bas). |
| Fruits et légumes : vente à la pièce ou au kg ? | ✅ trois cas observés (détail plus bas). ⏳ Reste à savoir ce que représente `counter` pour un article à poids variable : un kilo ou une pièce. |
| Erreurs | Format JSON:API : `{errors:[{status, code:"request.validation", errors:[{code:"gtin_validation_exception", path:"items[0].ean"}]}]}`. Un EAN invalide renvoie un 400. |

## Forme d'un produit

La forme est identique dans `/autocomplete`, `/s`, `/products` et dans les lignes du panier.

```
product = { type: "product", id: "product-<ean>", attributes: {
  ean, title, shortTitle, brand,                 // brand peut être "" (boulangerie, vrac)
  format,                                        // "50cl", "1L", "6x1l", "2x250g", "4x100g", "1,5Kg", "la pièce"
  packaging,                                     // "la bouteille 50cL", "le pack de 6 briques d'1L", "le pain de 500g"
  flags: ["flag.common.organic", "flag.common.igp", "flag.common.addedsugarfree", ...],
  clubs: ["flag.club.bio", "flag.club.market"],
  categories: [{label, level, ...}], topCategoryName, images, nutriscore, isAlreadyPurchased,
  offers: { [ean]: { [facilityServiceId]: { attributes: {
    price: { price: 0.91, perUnit: 1.82, unitOfMeasure: "L" | "KG", perUnitLabel: "1.82 € / L" },
    availability: { purchasable, stopped, suspended, hasLowQuantity },
    ordering: { min: 1, step: 1, max: 10 | 50 },  // max 10 pour les packs
    variableWeight: false,
    promotion: { label: "-10% Club", isLoyalty, messageArgs: { discountedPrice, initialPrice } } | null
  } } } }
} }
```

- **Prix :** `offers[ean][facilityServiceId].attributes.price.price`. Le `facilityServiceId` est celui de la session, et vaut aussi `attributes.offerServiceId`.
- **Contenance :** on parse `format` (`<n>x<qty><unit>`, avec ces unités : `g`, `kg`, `cl`, `l`, en ignorant la casse et en acceptant la virgule décimale). En repli, on lit `packaging`. Avec `la pièce`, on cherche le poids dans `packaging`.
- **MDD :** marques observées : `CARREFOUR`, `CARREFOUR BIO`, `CARREFOUR CLASSIC'`, `CARREFOUR EXTRA`, `SIMPL`, `FILIERE QUALITE CARREFOUR`. Règle proposée : `brand` commence par `CARREFOUR`, ou vaut `SIMPL` ou `FILIERE QUALITE CARREFOUR`. La facette « Produits Carrefour » de `/s` permettra de compléter la liste.
- **Pertinence :** la requête « lait » remonte aussi « Biscuits bio Chocolat lait BJORG ». « tomate » remonte d'abord de la pulpe, du concentré et de la passata, et les tomates fraîches n'arrivent qu'en 2e position. Il faut donc trois choses :
  - des requêtes précises produites par le parse (« tomates grappe », « bananes ») ;
  - des termes exclus ;
  - le champ `categories` / `topCategoryName` exposé dans `ProductOffer`, pour filtrer le frais du transformé.
- **Unités de prix :** `unitOfMeasure` prend les valeurs `KG`, `L` ou **`U`** (prix à l'unité, ex. « Bananes SIMPL x5 »). Le prix par unité peut être en `KG` même pour un liquide (passata en 70cL). On ne déduit donc pas la contenance de l'unité de prix.
- **Fruits et légumes, trois cas observés :**
  1. **Lot fixe** : `format: "5 pièces"` ou `"x5"`, `packaging: "les 5 fruits"`, `variableWeight: false`, prix pour le lot.
  2. **Vrac au kilo** : `format: "1kg"`, `packaging: "le kilo"`, `variableWeight: true`, `unitOfMeasure: KG`, prix au kilo.
  3. **À la pièce, poids estimé** : `format: "270g - env. 1 pièce"`, `variableWeight: true`, prix estimé à la pièce.
- **`ordering.max`** prend les valeurs 10, 20 ou 50 selon le produit.

## Panier

- `GET /api/cart` renvoie `{cart, endPoints, marketplace, meta, additionalOrders, preorder, nonFoodDeliveryCart}`.
  - Dans `cart` : `facilityServiceId`, `type`, `storeRef` (le dernier segment du `facilityServiceId`), `items[] = {category, products: [{counter, available, totalItemPrice, product}]}`, `totalAmount`, `nbProducts`.
  - Une réponse fait environ 14 Ko pour 2 produits.
- La réponse du `PATCH 200` a la même forme que `GET /api/cart`. On peut donc s'en servir pour vérifier sans relire le panier.
- **Ce que fait le site :**
  - « + » et « − » tant que la quantité reste ≥ 1 : `PATCH /api/cart?refresh=true`, corps `{trackingRequest:{pageType:"basket",pageId:"basket"}, items:[{basketServiceId, counter, ean, subBasketType}]}` ;
  - passage à 0 : `PATCH /api/cart/items`, avec le corps à plat décrit plus haut.

  Karto fait la même chose, avec `pageType` et `pageId` à `"basket"`.
- `cart.endPoints` liste aussi `slot`, `attachSlot`, `timeslots` et `payline` (paiement). **Exclus**, conformément à `ALLOWED_ENDPOINTS`.
- Champs à nettoyer dans les fixtures : `cartID`, `slot.ref`, `slotRef`, `cardholder` et `eligibilityAddress`. L'échantillon ne contient ni nom, ni email, ni adresse.

## Conséquences pour le plan

1. La recherche passe par **`/autocomplete?q=&productCard=true&maxResults=10`** : réponse plus légère, et même forme de produit. `/s` est réservé à la recherche manuelle paginée.
2. `setQuantity(ref, n)` envoie `PATCH /api/cart?refresh=true` avec `counter: n` quand n ≥ 1, et `PATCH /api/cart/items` quand n = 0. Les deux appels sont idempotents.
3. `packsNeeded` doit borner le résultat à `ordering.max` : au-delà, Carrefour plafonne probablement aussi.
4. `isOrganic` vient de `flags`, ce qui est fiable. `isPrivateLabel` vient de la marque, ce qui est heuristique.
5. Le débit d'1 req/s passe sans problème. On garde le jitter de 0,7 à 1,5 s.
6. Le transport envoie **toujours** `x-requested-with: XMLHttpRequest`. Un 404 `text/html` doit déclencher une erreur `schema_mismatch` explicite, pas une erreur « introuvable ».
7. `ProductOffer` gagne un champ `category?: string` (`topCategoryName`) et un champ `variableWeight?: boolean`. Ils servent aux règles (frais ou transformé) et à l'affichage « ≈ » de l'UI.
8. **Détecter la connexion par `GET /api/me`, pas par le statut HTTP.** `getContext()` lit `/api/me` et lève `auth_required` si la session est anonyme. L'exécutant l'appelle au début de chaque `cart_sync` et de nouveau à la vérification finale. Si la session est devenue anonyme en cours de route, il met le job en pause, demande la reconnexion, puis relance le diff, ce qui est sans risque puisque les quantités sont absolues. Le provider ne remonte qu'un booléen : le reste de `/api/me` (nom, email, adresse) ne sort jamais du parser.
9. Un job de recherche n'exige pas d'être connecté. Proposer un panier ne demande donc pas de reconnexion ; seul le push en demande une.
10. Reste non testé : l'expiration par inactivité (60 min). C'est probablement le même symptôme, une session anonyme, et la détection par `/api/me` le couvre.
