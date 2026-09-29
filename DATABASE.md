# Base de données

SQLite (fichier unique, mode WAL). Schéma : `src/db/schema.sql`, appliqué au démarrage. Montants en **centimes entiers** ; dates en ISO-8601 UTC, affichées en Europe/Zurich.

| Table | Rôle |
|---|---|
| `users` | Tous les comptes ; `role` ∈ SUPER_ADMIN / DRIVER / CUSTOMER ; index unique : un seul SUPER_ADMIN. `invited_by`, `invitation_id`, `approved_at`, `approved_by` répondent à « qui, quel code, quand, validé quand ». |
| `driver_profiles` | Permis, autorisations, échéances, taux spécifique (`share_bps`, NULL = défaut). |
| `sessions` | Sessions (hash du jeton), jeton CSRF, état MFA. |
| `invitations` | Invitations clients (codes), liens de configuration chauffeur et de réinitialisation (hachés). |
| `vehicles`, `documents` | Flotte, entretien, échéances (suppression logique). |
| `settings` | Tarifs, taux, entreprise, TVA, politiques, fonctionnalités (JSON, chaque changement audité avant/après). |
| `bookings`, `booking_status_history` | Courses et historique complet des statuts. |
| `driver_earnings` | Snapshot figé par course : brut, taux, part chauffeur, part entreprise (`UNIQUE(booking_id)`, `CHECK` somme = brut, trigger d'immuabilité). |
| `earning_adjustments` | Corrections avec motif obligatoire. |
| `invoices` | Factures numérotées côté serveur (`F-AAAA-000001`), une par course, snapshot entreprise et TVA. |
| `payments`, `payment_events`, `refunds` | Paiements, événements PSP (`UNIQUE(provider, provider_event_id)`), remboursements idempotents. |
| `cash_transactions` | Encaissements espèces et rapprochement. |
| `reward_ledger` | Grand livre des récompenses (`reference` unique : pas de double attribution). |
| `audit_log` | Journal en ajout seul (triggers). |
| `notifications`, `support_tickets`, `support_messages` | Notifications et support. |
| `counters` | Séquences de numérotation. |

Suppression : logique (`deleted_at`) pour les entités à historique ; les écritures financières (`driver_earnings`, `invoices`, `payments`) ne peuvent pas être supprimées.

Consultation directe : `docker compose exec app node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/pdc.sqlite');console.table(d.prepare('SELECT number,status,final_total FROM bookings ORDER BY created_at DESC LIMIT 10').all())"`
