# Tests

```bash
npm test            # 48 tests, aucune dépendance requise
npm install && npm run typecheck   # TypeScript strict
```

## `tests/core.test.ts` — règles métier (28 tests)
Tarif jour/nuit, bascule à 21h00/06h00, heure d'été/hiver, minimum 15/20 CHF avec prise en charge incluse, attente 10 min offertes puis 0.60/0.75, arrondi 5 centimes, part 40 % exacte au centime, snapshot historique, RBAC, IDOR, escalade, états de course, idempotence webhook, anti-auto-parrainage.

## `tests/e2e.test.ts` — parcours complet via HTTP réel (20 tests)
Serveur démarré sur un port aléatoire avec une base temporaire. Couvre les 8 tests critiques du cahier des charges :

| Test | Vérifié |
|---|---|
| 1 | Un client qui tente de créer un chauffeur reçoit 403 |
| 2 | Un chauffeur qui tente d'approuver un client reçoit 403 |
| 3 | Un client qui tente de chiffrer une course reçoit 403 |
| 4 | Webhook signé envoyé deux fois → une seule transaction ; signature falsifiée → 400 ; le retour navigateur ne marque pas la facture payée |
| 5 | Course 10 km de jour + 25 min d'attente = CHF 37.00 → chauffeur 14.80 (40 %), entreprise 22.20, facture payée, cash encaissé |
| 6 | Taux 40 → 45 % : anciennes courses à 40 %, snapshot immuable en base, audit avant/après |
| 7 | Client non approuvé : aucune réservation possible |
| 8 | Après approbation : réservation acceptée |

Ainsi que : MFA obligatoire, clôture idempotente, IDOR sur courses et factures, chauffeur limité à ses revenus, remboursement partiel, rapprochement cash, audit non modifiable, CSRF, `noindex`, rendu de toutes les pages de chaque rôle, unicité du propriétaire.

## Recette manuelle recommandée avant l'ouverture
1. Paiement Stripe en **mode test** de bout en bout (carte 4242…, puis TWINT test).
2. Parcours réel sur téléphone : réservation client, course chauffeur d'une seule main.
3. Restauration d'une sauvegarde.
