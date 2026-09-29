# Private Driver Club

Application complète de transport privé pour **une seule entreprise suisse** : site public, adhésion sur invitation avec validation manuelle, réservations, dispatch, application chauffeur, rémunération automatique, espèces, paiement en ligne (cartes + TWINT via Stripe), factures, parrainage, audit.

- **Aucune dépendance** à l'exécution : Node.js 22 + SQLite intégrés. Rien à installer à part Docker sur le serveur.
- **48 tests automatisés** (dont le parcours complet propriétaire → client → chauffeur → paiement).
- **Pas de marketplace** : l'entreprise est l'unique prestataire, les clients paient l'entreprise, les chauffeurs reçoivent leur part calculée.

## Mise en ligne en 8 étapes

Ce qu'il vous faut : un nom de domaine et un petit serveur Linux (VPS, 2 Go de RAM suffisent). Un hébergeur suisse comme Infomaniak simplifie la conformité LPD.

**1. Installer Docker sur le serveur**
```bash
curl -fsSL https://get.docker.com | sh
```

**2. Copier le projet sur le serveur** puis s'y placer : `cd private-driver-club`

**3. Pointer votre domaine** : chez votre registraire, créez un enregistrement DNS `A` vers l'adresse IP du serveur.

**4. Configurer**
```bash
cp .env.example .env
openssl rand -base64 48      # copiez le résultat dans AUTH_SECRET
nano .env                    # DOMAIN, APP_URL, AUTH_SECRET, OWNER_*
```

**5. Démarrer** (HTTPS automatique via Caddy)
```bash
docker compose up -d --build
```

**6. Créer votre compte propriétaire** (une seule fois, seul SUPER_ADMIN possible)
```bash
docker compose run --rm app node src/cli.ts create-owner
```
Retirez ensuite `OWNER_PASSWORD` du fichier `.env`.

**7. Première connexion** sur `https://votre-domaine/login` : l'application vous impose d'activer la double authentification (Google Authenticator, 1Password…).

**8. Configurer l'entreprise** dans *Paramètres* : raison sociale, adresse, IDE, TVA, canton. Ajoutez vos véhicules, puis vos chauffeurs (chacun reçoit un lien pour créer son mot de passe ; vous l'activez ensuite).

À ce stade, **le service fonctionne avec paiement en espèces**. Pour les cartes et TWINT, suivez [PAYMENTS.md](PAYMENTS.md) : il suffit d'ajouter deux clés Stripe dans `.env` et de redémarrer.

## Tarif configuré

| | Jour (6h–21h) | Nuit (21h–6h) |
|---|---|---|
| Prise en charge | CHF 3.00 | CHF 3.00 |
| Kilomètre | CHF 2.50 | CHF 2.75 |
| Course minimum (prise en charge incluse) | CHF 15.00 | CHF 20.00 |
| Attente, après 10 min offertes | CHF 0.60/min | CHF 0.75/min |

Modifiable à tout moment dans *Paramètres* (audité). Part chauffeur par défaut : 40 %, modifiable globalement ou par chauffeur ; chaque course conserve son taux historique.

## Déroulement d'une course

1. Le membre réserve (immédiat ou programmé).
2. Vous confirmez en indiquant la distance estimée → le prix estimé est calculé par le serveur et envoyé au client.
3. Vous attribuez un chauffeur et un véhicule (dispatch, conflits horaires bloqués).
4. Le chauffeur : **Accepter → En route → Arrivé → Démarrer → Terminer** (il saisit les km réels ; l'attente est mesurée automatiquement).
5. À la clôture : prix final, part chauffeur figée, facture numérotée, encaissement espèces ou lien de paiement en ligne, récompense de parrainage, audit.

## Commandes utiles

| Action | Commande |
|---|---|
| Lancer en local (démo, paiements simulés) | `npm run seed:dev && npm run dev` puis http://localhost:3000 |
| Tests | `npm test` |
| Vérification des types | `npm install && npm run typecheck` |
| Sauvegarde | `docker compose exec app node src/cli.ts backup /data/backups/pdc.sqlite` |
| Journaux | `docker compose logs -f app` |
| Mise à jour | `docker compose up -d --build` |
| Mot de passe propriétaire oublié | `docker compose exec app node src/cli.ts owner-reset-link` |
| MFA perdue | voir [SECURITY.md](SECURITY.md#récupération-du-compte-propriétaire) |

Comptes de démonstration (local uniquement, après `seed:dev`) : `owner@dev.local / DevOwner-2026`, `driver1@dev.local / DevDriver-2026`, `client1@dev.local / DevClient-2026`.

## Documentation

[ARCHITECTURE](ARCHITECTURE.md) · [SECURITY](SECURITY.md) · [DEPLOYMENT](DEPLOYMENT.md) · [DATABASE](DATABASE.md) · [PAYMENTS](PAYMENTS.md) · [COMPLIANCE](COMPLIANCE.md) · [TESTING](TESTING.md) · [ENVIRONMENT](ENVIRONMENT.md)
