# Conformité — points à faire valider par l'entreprise

Le logiciel fournit les outils ; **il ne rend pas à lui seul l'entreprise conforme**. Aucune règle cantonale ou communale n'a été codée en dur.

## À faire valider avant l'ouverture
1. **Statut de l'activité** (taxi, VTC, transport privé) et autorisations requises dans le canton (ex. Vaud : loi sur l'exercice des activités économiques et règlements communaux/intercommunaux, p. ex. service des taxis de l'agglomération lausannoise) — auprès de l'autorité compétente.
2. **Chauffeurs** : permis requis (catégorie, éventuel permis professionnel), autorisations, casier, OTR 2 (temps de travail et de repos des chauffeurs professionnels), tachygraphe le cas échéant.
3. **Contrats de travail** : la rémunération à 40 % du chiffre d'affaires doit respecter le droit du travail (salaire minimum cantonal éventuel, assurances sociales AVS/AI/APG/AC/LAA/LPP, vacances, frais). À valider avec une fiduciaire.
4. **Véhicules** : immatriculation et assurance adaptées au transport professionnel de personnes, expertises.
5. **TVA** : assujettissement (seuil de chiffre d'affaires), taux applicable au transport de personnes — à configurer dans *Paramètres → TVA* sur avis de votre fiduciaire. La TVA est désactivée par défaut.
6. **Factures** : mentions obligatoires (raison sociale, IDE, n° TVA si assujetti). Renseignez *Paramètres → Entreprise*.
7. **Documents légaux** : conditions générales, confidentialité, cookies, mentions légales, politique d'annulation — les pages fournies sont des **gabarits marqués « à faire valider »**.
8. **Protection des données (LPD)** : désigner le responsable, compléter la politique de confidentialité, registre des traitements si requis, contrat de sous-traitance avec l'hébergeur et Stripe, lieu d'hébergement. Déterminer si le RGPD s'applique (clients dans l'UE).
9. **Conservation** : pièces comptables 10 ans (CO art. 958f) — plan de sauvegarde en conséquence.
10. **Espèces** : procédure interne de remise et de rapprochement de caisse.

## Outils fournis
Minimisation (aucune donnée de carte, pas de géolocalisation, cookies strictement nécessaires), accès par rôle, export des données personnelles par le client (profil → « Exporter mes données »), journalisation, suppression logique, paramètres canton/commune/mode de service, suivi des échéances de documents.

## Non implémenté (à décider)
- Anonymisation automatique après délai de conservation : à définir selon votre politique (procédure manuelle possible).
- Traductions allemand/italien/anglais : l'interface est en français ; ne pas traduire les textes légaux sans validation.
