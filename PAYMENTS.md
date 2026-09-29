# Paiements

Règle absolue : **le client paie l'entreprise**. Aucun chauffeur n'a de compte marchand ; la part chauffeur est calculée ensuite (40 % par défaut).

## Espèces (actif dès l'installation)
Le chauffeur encaisse **pour le compte de l'entreprise**. À la clôture, la course est enregistrée comme recette entreprise (paiement `CASH` payé) et un encaissement `COLLECTED` est créé. S'il déclare un montant différent, l'encaissement passe en `DISPUTED`. Dans *Paiements*, vous rapprochez chaque encaissement ; tout écart accepté devient un ajustement chauffeur avec motif obligatoire (aucun franc ne « disparaît »).

## Cartes + TWINT via Stripe (2 clés à ajouter)
L'adaptateur Stripe est **déjà écrit** (Checkout hébergé : aucune donnée de carte ne passe par votre serveur).

1. Créez un compte sur stripe.com avec votre entreprise suisse, complétez la vérification.
2. *Paramètres → Moyens de paiement* : activez **TWINT** (et les cartes).
3. *Développeurs → Clés API* : copiez la clé secrète dans `STRIPE_SECRET_KEY`.
4. *Développeurs → Webhooks → Ajouter un endpoint* :
   - URL : `https://VOTRE-DOMAINE/webhooks/stripe`
   - Événements : `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`
   - Copiez le secret de signature (`whsec_…`) dans `STRIPE_WEBHOOK_SECRET`.
5. `docker compose up -d` pour redémarrer.

**Testez d'abord avec les clés de test Stripe** (`sk_test_…`) et la carte 4242 4242 4242 4242 : faites une course complète en paiement en ligne, vérifiez que la facture passe à « Payée ». Puis remplacez par les clés live. Cet adaptateur n'a pas pu être testé contre les serveurs Stripe réels pendant le développement : ce test en mode test est indispensable.

### Fonctionnement
- Le membre choisit « Carte ou TWINT » à la réservation ; après la course, il reçoit la facture et clique « Payer ».
- La facture n'est marquée payée **que** sur réception d'un webhook signé et vérifié (signature HMAC + horodatage anti-rejeu, tolérance 5 min). Le retour navigateur ne vaut jamais preuve.
- Idempotence : `(provider, provider_event_id)` est unique ; un webhook reçu deux fois n'a aucun effet (testé). Contrôle du montant reçu contre le montant attendu.
- Remboursements : depuis la course ou *Paiements*, motif obligatoire, audité, facture mise à jour, clé d'idempotence transmise à Stripe.

### Choix du modèle « payer après la course »
Le prix final dépend des km réels et de l'attente : le paiement intervient donc après la course. Pour un club sur invitation c'est courant ; si vous voulez une pré-autorisation de carte à la réservation, c'est une évolution possible (l'interface `PaymentProvider` prévoit `authorizePayment`/`capturePayment`).

## Autre prestataire (Datatrans, Payrexx, Wallee…)
Implémentez l'interface `PaymentProvider` (`src/domain/payments/payments.ts`) dans `src/payments/<psp>.ts` en vous basant sur `stripe.ts`, puis branchez-la dans `src/server.ts`. Ne créez jamais d'API TWINT « maison ».

## Crypto
Désactivée (feature flag). À n'activer qu'avec un prestataire spécialisé, via le même type d'adaptateur.
