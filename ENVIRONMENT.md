# Variables d'environnement

| Variable | Obligatoire | Description |
|---|---|---|
| `NODE_ENV` | oui | `production`, `development` ou `test` |
| `DOMAIN` | prod | Domaine pour le certificat HTTPS (Caddy) |
| `APP_URL` | oui | URL publique, `https://` obligatoire en production |
| `AUTH_SECRET` | prod | ≥ 32 caractères aléatoires (`openssl rand -base64 48`) |
| `DATABASE_PATH` | non | Défaut `/data/pdc.sqlite` en Docker |
| `PORT` | non | Défaut 3000 |
| `TRUST_PROXY` | non | `true` derrière Caddy (IP réelle pour la limitation de débit) |
| `OWNER_EMAIL`, `OWNER_PASSWORD`, `OWNER_FIRST_NAME`, `OWNER_LAST_NAME` | une fois | Création du propriétaire, puis retirer le mot de passe |
| `STRIPE_SECRET_KEY` | pour le paiement en ligne | Clé secrète Stripe (`sk_test_…` puis `sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | avec la précédente | Secret de signature du webhook (`whsec_…`) |
| `STRIPE_PAYMENT_METHODS` | non | Défaut `card,twint` |
| `DEV_MOCK_PAYMENTS` | dev | `true` : simulateur de paiement (refusé en production) |
| `EMAIL_PROVIDER_KEY`, `SMS_PROVIDER_KEY` | plus tard | Réservées aux adaptateurs à brancher |

## Services restant à connecter
| Service | État | Comment |
|---|---|---|
| Cartes + TWINT | Adaptateur Stripe prêt | 2 clés, voir PAYMENTS.md |
| E-mail | Notifications enregistrées et visibles dans l'application ; envoi e-mail journalisé seulement | Implémenter `ChannelAdapter` (`src/services/notify.ts`) pour votre fournisseur (Infomaniak, Postmark, Brevo…) et le passer à `NotificationService` dans `src/server.ts` |
| SMS / Push | Non branchés | Même principe que l'e-mail |
| Cartes / distances | Liens de navigation Google/Apple/Waze actifs sans clé ; distance saisie par vous (estimation) et par le chauffeur (réel) | Calcul automatique d'itinéraire possible plus tard via une API de routage |
| Hébergement, domaine | À souscrire | README, étapes 1–5 |
