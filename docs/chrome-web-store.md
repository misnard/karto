# Publier Karto sur le Chrome Web Store

Le but est une fiche **non répertoriée** : on l'installe avec le lien, mais elle n'apparaît pas dans la recherche. Tant qu'elle n'est pas en ligne, les amis installent le zip à la main (README).

## Une fois

- [ ] Créer le compte développeur sur [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole) : 5 $ une seule fois, validation en 2 étapes du compte Google, e-mail de contact vérifié.
- [ ] Ajouter les icônes, absentes du manifest : PNG 16, 48 et 128 px dans `apps/extension/public/`, déclarées sous `icons` dans `manifest.json`, plus une icône 128 px pour la fiche.

## À chaque version

- [ ] Augmenter `version` dans `apps/extension/package.json`. C'est la seule source : le build l'écrit dans le manifest, et l'exécutant l'envoie comme version d'agent.
- [ ] Lancer `pnpm verify`, puis `pnpm zip:ext`, qui produit `apps/extension/karto-<version>.zip`.
- [ ] Vérifier que le zip est un build de production : `unzip -p apps/extension/karto-<version>.zip 'assets/*.js' | grep -c "Vérifier le contrat"` doit afficher 0 (le bouton de dev est retiré).
- [ ] Faire un test réel avec le zip décompressé : appairage, panier, envoi.
- [ ] Téléverser le zip dans la console, puis soumettre à la revue.
- [ ] Joindre le même zip à une release GitHub (`gh release create v<version> …`).

## Fiche

- [ ] Visibilité : **Non répertoriée**.
- [ ] Nom : Karto. Catégorie : Shopping. Langue : français.
- [ ] Résumé (132 caractères au plus) : « Transforme une liste de courses ou une recette en panier Drive, selon tes préférences. Tu paies toi-même sur le site. »
- [ ] Description : ce que fait Karto, le serveur à saisir et le code d'appairage, ce que Karto ne fait jamais (paiement, créneau, commande), et le lien vers le README.
- [ ] Captures d'écran, 1 à 5, en 1280×800 ou 640×400, prises avec un compte de test et sans données personnelles visibles :
  1. « Relie ce navigateur » ;
  2. « Ta liste de courses » remplie ;
  3. un panier « Prêt », avec les chips de source et les raisons ;
  4. l'envoi en cours, à côté de l'onglet du magasin ;
  5. les Préférences.
- [ ] Site web : `https://github.com/misnard/karto`.

## Onglet Confidentialité

- [ ] **Objectif unique :** « Préparer un panier Drive à partir d'une liste de courses saisie par l'utilisateur et l'ajouter à son panier sur le site du magasin. »
- [ ] **Justification de chaque permission :**

  | Permission | Justification |
  |---|---|
  | `storage` | Garder le jeton de l'appareil, l'adresse du serveur choisi, l'état de l'exécutant et un journal technique local. |
  | `scripting` | Exécuter, dans l'onglet www.carrefour.fr et avec la session de l'utilisateur, les recherches et les mises à jour de panier qu'il a demandées. La fonction injectée est incluse dans l'extension, et elle refuse tout endpoint hors d'une liste fermée qui exclut paiement, commande et créneau. |
  | `sidePanel` | Afficher l'interface à côté de l'onglet du magasin. |
  | `alarms` | Relancer chaque minute la vérification des tâches en attente tant qu'une tâche est active. Le service worker MV3 s'arrête entre deux événements. |
  | `https://www.carrefour.fr/*` | Chercher les produits, lire le panier, modifier les quantités, et trouver ou ouvrir l'onglet du magasin. |
  | `https://moncompte.carrefour.fr/*` | Suivre la page de connexion pendant le renouvellement de session, puis reprendre la tâche quand l'utilisateur s'est reconnecté. |

  Le serveur Karto ne figure pas dans les host permissions : son adresse est saisie à l'appairage, et il répond en CORS. Il n'y a pas de permission `tabs`.
- [ ] **Code distant :** « Non ». Tout le code est dans le paquet. Le serveur n'envoie que des données : des tâches typées (recherche, synchronisation du panier), jamais du code ni une URL à appeler.
- [ ] **Données collectées**, à cocher :
  - informations d'authentification (le jeton d'appareil) ;
  - informations de santé (le régime et les allergies, si l'utilisateur les renseigne) ;
  - contenu de sites web (les produits et le panier du site du magasin).
- [ ] Cocher les 3 certifications : aucune vente de données, aucun usage sans rapport avec la fonction, aucun usage pour évaluer la solvabilité.
- [ ] **URL de la politique de confidentialité :** `https://github.com/misnard/karto/blob/main/docs/confidentialite.md`. La branche `main` doit contenir la page avant la soumission.

## Notes pour la revue

- [ ] Expliquer que l'extension a besoin d'un serveur Karto privé et d'un compte carrefour.fr, et qu'elle ne paie jamais.
- [ ] Le code d'appairage expire en 15 minutes : un relecteur ne pourra pas s'en servir plus tard. Joindre une courte vidéo du parcours complet. Si la revue exige un accès, il faudra un compte de test avec un code à plus longue durée, ce qui n'est pas prévu aujourd'hui.
- [ ] Risque connu : l'extension automatise un site tiers (PLAN, section 7). En cas de refus, l'installation par zip reste possible.

## Ce qui reste à la main

Pour toi, le mainteneur :
- payer et créer le compte développeur ;
- remplir la fiche et l'onglet Confidentialité ;
- prendre les captures ;
- soumettre chaque version ;
- répondre à la revue.

Ensuite, remplacer dans le README la partie « Installer l'extension » par le lien non répertorié.

Pour l'utilisateur, même après l'installation depuis le Web Store :
- obtenir l'adresse du serveur et un code d'appairage auprès de l'hébergeur ;
- se connecter sur carrefour.fr et choisir son magasin Drive ;
- relire le panier ;
- choisir le créneau et payer lui-même sur carrefour.fr.
