# Déploiement

## Production (recommandé)
Serveur Linux + Docker. Voir les 8 étapes du [README](README.md). Composants :
- `app` : l'application (image `node:22-alpine`, utilisateur non-root, healthcheck `/readyz`).
- `caddy` : HTTPS automatique (Let's Encrypt), compression, reverse proxy.
- Volume `pdc-data` : la base SQLite. **C'est la seule donnée à sauvegarder.**

Contrôles : `/healthz` (vivant), `/readyz` (base accessible).

## Environnements
| | Base | Paiements | Données démo |
|---|---|---|---|
| development | `./data/pdc.sqlite` | simulateur (`DEV_MOCK_PAYMENTS=true`) | `npm run seed:dev` |
| test | fichier temporaire par exécution | simulateur | créées par les tests |
| staging | volume séparé | clés Stripe **test** | aucune |
| production | volume séparé | clés Stripe **live** | **interdites** (`seed-dev` refuse de s'exécuter) |

Ne réutilisez jamais la base d'un environnement dans un autre.

## Sauvegardes
Sauvegarde cohérente à chaud :
```bash
docker compose exec app node src/cli.ts backup /data/backups/pdc-$(date +%F).sqlite
docker compose cp app:/data/backups ./backups
```
Recommandé : tâche `cron` quotidienne, puis copie **chiffrée** hors du serveur (ex. `restic` ou `age` vers un stockage suisse), rétention 30 jours + 12 mensuelles. Les obligations comptables suisses imposent de conserver les pièces 10 ans.

Restauration (à tester une fois par trimestre) :
```bash
docker compose stop app
docker compose cp ./backups/pdc-AAAA-MM-JJ.sqlite app:/data/pdc.sqlite
docker compose start app
```

## Mise à jour
```bash
docker compose exec app node src/cli.ts backup /data/backups/avant-maj.sqlite
git pull   # ou copie des nouveaux fichiers
docker compose up -d --build
```
Le schéma est appliqué automatiquement au démarrage (`CREATE … IF NOT EXISTS`, version suivie dans `schema_version`).

## Monitoring
- Journaux : `docker compose logs -f app` (erreurs préfixées `[error]`, jamais de secrets).
- Disponibilité : branchez un service de surveillance (UptimeRobot, Better Stack…) sur `https://DOMAINE/healthz`.
- Audit sécurité : écran *Audit* (connexions, refus d'accès, actions sensibles, webhooks rejetés).

## Montée en charge
SQLite en mode WAL supporte confortablement une entreprise de transport (des milliers de courses par jour). Au-delà, ou pour plusieurs serveurs, une migration vers PostgreSQL est à prévoir (SQL standard, accès concentré dans `src/db` et `src/services`).
