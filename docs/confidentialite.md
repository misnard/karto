# Politique de confidentialité de Karto

Dernière mise à jour : 20 octobre 2026.

Karto est un logiciel libre ([github.com/misnard/karto](https://github.com/misnard/karto)) : une extension Chrome et un serveur. Il n'existe pas de serveur Karto central. L'extension ne parle qu'au serveur dont tu saisis l'adresse à l'appairage. Ce serveur est exploité par la personne qui t'a donné ton code d'appairage (« l'hébergeur ») : c'est elle qui détient tes données Karto.

Karto n'affiche pas de publicité, ne vend aucune donnée, n'utilise aucun outil de mesure d'audience et ne suit pas ta navigation.

## Dans ton navigateur

L'extension garde dans le stockage local de Chrome :
- le jeton de ton appareil et l'adresse de ton serveur ;
- l'identifiant du magasin Drive vu au dernier passage ;
- le panier ouvert et le nombre de personnes saisi ;
- un journal technique des 20 dernières réponses inattendues du site, qui ne quitte jamais ton navigateur.

L'extension n'agit sur carrefour.fr que pendant une tâche que tu as lancée : chercher des produits, lire ton panier, modifier les quantités des produits gérés par Karto. Elle le fait dans un onglet carrefour.fr, avec la session que tu as ouverte. Elle ne lit pas ton mot de passe. Elle n'envoie à personne tes cookies ni les en-têtes du site. Elle ne passe jamais commande, ne choisit pas de créneau et ne paie pas.

## Sur le serveur de ton hébergeur

Le serveur stocke :
- ton nom de compte (choisi par l'hébergeur) ;
- tes appareils : leur nom, leurs dates d'appairage et de dernière connexion, et une empreinte (hash) de leur jeton ;
- tes préférences : régime, allergies, bio, marques, format, budget et notes ;
- tes paniers : le texte saisi, les liens de recette, les lignes, les produits proposés (nom, marque, prix, code EAN), l'identifiant du magasin Drive et le résultat de l'envoi ;
- ta mémoire de choix : pour chaque ingrédient, le dernier produit envoyé ;
- les tâches techniques : requêtes de recherche, produits trouvés, quantités envoyées, et textes échangés avec le LLM, avec leur consommation.

Le serveur ne reçoit et ne stocke jamais tes identifiants, ton mot de passe, tes cookies, les en-têtes ou les réponses brutes de carrefour.fr, ton adresse, ta carte de fidélité ni tes moyens de paiement.

Quand tu donnes un lien de recette, c'est le serveur qui télécharge la page : le site de recettes voit l'adresse IP du serveur.

## Le LLM

Pour lire ta liste et choisir les produits, le serveur envoie à Claude (Anthropic) :
- le texte de ta liste et le contenu des recettes ;
- un résumé de tes préférences, y compris allergies et notes ;
- les produits candidats.

Ton nom et tes appareils ne sont pas envoyés. Selon le choix de l'hébergeur, l'envoi passe par l'API Anthropic ou par Claude Code. La [politique de confidentialité d'Anthropic](https://www.anthropic.com/legal/privacy) s'applique à ces échanges.

## Durée de conservation et suppression

Tes données restent sur le serveur tant que ton compte existe : il n'y a pas de purge automatique.
- **Un appareil :** dans le panneau, **Appareils** puis **Révoquer**. Le jeton cesse de fonctionner immédiatement.
- **Les données locales :** désinstalle l'extension, et Chrome efface son stockage.
- **Ton compte et toutes ses données :** demande-le à ton hébergeur. La procédure est dans le [README](../README.md#supprimer-les-données-dun-utilisateur).

## Contact

Pour une question sur tes données, adresse-toi d'abord à ton hébergeur. Pour une question sur le logiciel ou sur cette politique, ouvre une issue sur [github.com/misnard/karto/issues](https://github.com/misnard/karto/issues), sans y mettre de données personnelles.
