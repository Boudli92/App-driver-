# Architecture

```
CLIENT ──réserve──▶ ENTREPRISE ──attribue──▶ CHAUFFEUR DE L'ENTREPRISE
   │                    ▲
   └──paie (cash/carte/TWINT)──┘   puis ENTREPRISE ──part calculée──▶ CHAUFFEUR
```
`MARKETPLACE_MODE = false`, `MULTI_COMPANY_MODE = false`, `SINGLE_OWNER_MODE = true` sont des constantes, non configurables.

## Stack
- **Node.js 22** (TypeScript exécuté nativement, sans étape de compilation), serveur HTTP natif.
- **SQLite** (`node:sqlite`, WAL, clés étrangères, contraintes CHECK, triggers d'intégrité).
- Pages rendues côté serveur (HTML + CSS, **zéro JavaScript** côté navigateur) : rapide sur mobile, surface d'attaque minimale.
- **Aucune dépendance npm à l'exécution** : pas de chaîne d'approvisionnement à surveiller. TypeScript et `@types/node` servent uniquement à la vérification.

Écart assumé par rapport à la suggestion initiale (Next.js + PostgreSQL + Prisma) : cette stack ne pouvait pas être installée ni testée dans l'environnement de construction, alors que celle-ci est **entièrement exécutée et testée**. Pour une seule entreprise, elle est plus simple à héberger et à maintenir.

## Organisation
```
src/
  config/        constantes, tarif initial, environnement
  domain/        règles pures, testées : money, pricing, earnings, rbac, booking-state, payments, referrals
  db/            schéma SQL, transactions
  lib/           http, html (échappement), sécurité (scrypt, TOTP, limiteur), formats, navigation
  services/      logique métier : users, bookings, payments, finance, settings, notify, audit
  payments/      adaptateurs PSP : stripe.ts, dev-mock.ts
  routes/        public, customer (/app), driver (/driver), admin (/admin), webhooks
  ui/            layout et composants
  app.ts         middleware : session, CSRF, RBAC, maintenance, erreurs
  server.ts      point d'entrée
  cli.ts         create-owner, seed-dev, backup, reset-owner-mfa
public/app.css   design system (tokens de couleur centralisés)
tests/           domaine + parcours complet HTTP
```

## Abstractions remplaçables
- `PaymentProvider` : Stripe fourni ; tout PSP suisse peut être ajouté.
- `NotificationService` + `ChannelAdapter` : in-app actif ; e-mail/SMS/push à brancher.
- `NavigationProvider` : Google Maps, Plans (Apple), Waze (liens publics, sans clé).

## Clôture d'une course (§103), dans une seule transaction
contrôle du statut → montant final (km réels + attente mesurée serveur) → snapshot `driver_earnings` (unique par course, immuable) → facture numérotée → paiement cash / facture à payer → récompense de parrainage (référence unique) → audit → reçu. Rejouer la clôture renvoie le résultat existant.

## Traçabilité financière (§110)
Course → `booking_status_history` → `driver_earnings` → `invoices` → `payments` / `payment_events` / `refunds` / `cash_transactions` → `reward_ledger` → `audit_log`.
