# Sécurité

## Mesures en place
| Domaine | Mesure |
|---|---|
| Mots de passe | scrypt (N=32768, r=8, p=1, sel 16 o), comparaison à temps constant, 10 caractères min. |
| Sessions | Jeton aléatoire 256 bits, seul son SHA-256 est stocké ; cookie `HttpOnly`, `Secure` (prod), `SameSite=Lax`. Durée : 2 h propriétaire, 14 j chauffeur, 30 j client. Sessions révoquées à la suspension et au changement de mot de passe. |
| MFA | TOTP (RFC 6238, vérifié contre les vecteurs officiels) **obligatoire** pour le SUPER_ADMIN ; toutes les permissions admin l'exigent côté serveur. |
| Brute force | Limitation par IP+e-mail, verrouillage progressif (15 min → 24 h), limiteur global par IP. |
| Autorisation | RBAC serveur sur chaque route (rôle + permission + statut + propriété). Anti-IDOR testé : un client reçoit 404 sur la course d'un autre. |
| Escalade | Un seul SUPER_ADMIN (index unique en base), personne ne modifie son propre rôle, aucune inscription chauffeur publique. |
| CSRF | Jeton par session (et double-submit avant connexion) sur tout POST, vérification d'origine en production. |
| XSS | Échappement automatique de tout contenu dynamique ; CSP stricte sans aucun script (`script-src 'none'`). |
| Injection SQL | Requêtes paramétrées uniquement. |
| Open redirect | Redirections internes uniquement. |
| En-têtes | CSP, HSTS (prod), X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy. |
| Requêtes | Corps limité à 64 Ko, délais d'expiration serveur. |
| Webhooks | Signature HMAC, fenêtre anti-rejeu, idempotence, journalisation des rejets. |
| Audit | Journal en ajout seul (triggers SQL : ni UPDATE ni DELETE possibles). |
| Finances | Montants en centimes entiers, transactions SQL, contraintes CHECK, snapshot de rémunération immuable, écritures financières non supprimables. |
| Exports | CSV protégés par permission, neutralisation des formules tableur. |
| Secrets | Uniquement dans `.env` (ignoré par Git). Jamais journalisés. |

## Récupération du compte propriétaire
Pas de porte dérobée web. Avec un accès au serveur :
- **Mot de passe oublié** : `docker compose exec app node src/cli.ts owner-reset-link` affiche un lien valable 1 heure (action auditée). La MFA reste exigée après la réinitialisation.
- **Téléphone MFA perdu** : `docker compose exec -e CONFIRM_RESET_OWNER_MFA=yes app node src/cli.ts reset-owner-mfa` — action auditée ; la MFA est à reconfigurer à la connexion suivante.

## Points à connaître
- Pas de notification automatique de « connexion inhabituelle » tant qu'aucun fournisseur e-mail n'est branché (les connexions sont auditées).
- Pas de CAPTCHA : l'inscription étant soumise à validation manuelle, le risque de spam est limité ; ajoutable si nécessaire.
- Les fichiers de documents (permis, assurances) ne sont pas téléversés dans l'application : seul le suivi des échéances l'est. Conservez les fichiers dans un stockage privé chiffré.
