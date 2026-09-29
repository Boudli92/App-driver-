/**
 * Outils d'exploitation (accès serveur requis — aucune porte dérobée web).
 *   node src/cli.ts create-owner          crée le SUPER_ADMIN unique (OWNER_EMAIL, OWNER_PASSWORD, OWNER_FIRST_NAME, OWNER_LAST_NAME)
 *   node src/cli.ts seed-dev              données de démonstration marquées DEV (refusé en production)
 *   node src/cli.ts backup <fichier>      sauvegarde cohérente à chaud de la base
 *   node src/cli.ts owner-reset-link      récupération : lien de réinitialisation du mot de passe propriétaire (audité)
 *   node src/cli.ts reset-owner-mfa       récupération : réinitialise la MFA du propriétaire (audité)
 */
import { loadEnv } from "./config/env.ts";
import { openDb, run, one } from "./db/db.ts";
import { createOwner, createDriver, registerCustomer, setCustomerStatus, completeDriverSetup, setDriverStatus, destroyAllSessions, createPasswordReset } from "./services/users.ts";
import { audit, SYSTEM } from "./services/audit.ts";
import { newId } from "./lib/security.ts";

const env = loadEnv();
const db = openDb(env.databasePath);
const [cmd, arg] = process.argv.slice(2);

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) { console.error(`Variable ${name} manquante.`); process.exit(1); }
  return v;
}

switch (cmd) {
  case "create-owner": {
    const id = createOwner(db, { email: need("OWNER_EMAIL"), password: need("OWNER_PASSWORD"), firstName: need("OWNER_FIRST_NAME"), lastName: need("OWNER_LAST_NAME") });
    console.info(`Propriétaire créé (${id}). À la première connexion, la double authentification sera configurée. Supprimez OWNER_PASSWORD de l'environnement.`);
    break;
  }
  case "seed-dev": {
    if (env.isProd) { console.error("Refusé : jamais de données de démonstration en production."); process.exit(1); }
    if (!one(db, "SELECT id FROM users WHERE role = 'SUPER_ADMIN'")) {
      createOwner(db, { email: process.env.DEV_SUPER_ADMIN_EMAIL || "owner@dev.local", password: process.env.DEV_SUPER_ADMIN_PASSWORD || "DevOwner-2026", firstName: "Owner", lastName: "DEV" });
    }
    const owner = one<{ id: string }>(db, "SELECT id FROM users WHERE role = 'SUPER_ADMIN'")!;
    const actor = { id: owner.id, role: "SUPER_ADMIN" };
    for (const [i, name] of ["Marc", "Sofia"].entries()) {
      const email = `driver${i + 1}@dev.local`;
      if (one(db, "SELECT id FROM users WHERE email = ?", email)) continue;
      const { driverId, setupToken } = createDriver(db, actor, { email, phone: `+41 79 000 00 0${i + 1}`, firstName: name, lastName: "DEV", licenseNumber: `DEV-${i + 1}`, licenseExpiry: "2030-01-01", hiredAt: "2026-01-01" });
      completeDriverSetup(db, setupToken, "DevDriver-2026");
      setDriverStatus(db, actor, driverId, "ACTIVE");
      run(db, "UPDATE users SET is_dev_data = 1 WHERE id = ?", driverId);
    }
    for (const [i, plate] of ["VD 100 001", "VD 100 002"].entries()) {
      if (one(db, "SELECT id FROM vehicles WHERE plate = ?", plate)) continue;
      const t = new Date().toISOString();
      run(db, `INSERT INTO vehicles (id, make, model, year, plate, color, seats, status, is_dev_data, created_at, updated_at) VALUES (?, 'Mercedes-Benz', ?, 2024, ?, 'Noir', ?, 'AVAILABLE', 1, ?, ?)`,
        newId(), i ? "Classe V" : "Classe E", plate, i ? 7 : 4, t, t);
    }
    for (const [i, name] of ["Claire", "Julien"].entries()) {
      const email = `client${i + 1}@dev.local`;
      if (one(db, "SELECT id FROM users WHERE email = ?", email)) continue;
      const id = registerCustomer(db, { code: "", email, phone: `+41 78 000 00 0${i + 1}`, firstName: name, lastName: "DEV", password: "DevClient-2026", userAgent: "seed", acceptTerms: true });
      if (i === 0) setCustomerStatus(db, actor, id, "APPROVED");
      run(db, "UPDATE users SET is_dev_data = 1 WHERE id = ?", id);
    }
    console.info("Données DEV créées. Comptes : owner@dev.local / DevOwner-2026 · driver1@dev.local / DevDriver-2026 · client1@dev.local / DevClient-2026 (approuvé) · client2@dev.local (en attente)");
    break;
  }
  case "backup": {
    const target = arg ?? `./backups/pdc-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`;
    const { mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(target), { recursive: true });
    db.prepare("VACUUM INTO ?").run(target);
    console.info(`Sauvegarde écrite : ${target} (à chiffrer et copier hors du serveur, voir DEPLOYMENT.md).`);
    break;
  }
  case "owner-reset-link": {
    const owner = one<{ email: string }>(db, "SELECT email FROM users WHERE role = 'SUPER_ADMIN'");
    if (!owner) { console.error("Aucun propriétaire."); process.exit(1); }
    const res = createPasswordReset(db, owner.email, { id: null, role: "CLI" });
    if (!res) { console.error("Impossible de créer le lien."); process.exit(1); }
    console.info(`Lien valable 1 heure (action auditée) : ${env.appUrl}/reset/${res.token}`);
    break;
  }
  case "reset-owner-mfa": {
    if (process.env.CONFIRM_RESET_OWNER_MFA !== "yes") { console.error("Définissez CONFIRM_RESET_OWNER_MFA=yes pour confirmer."); process.exit(1); }
    const owner = one<{ id: string }>(db, "SELECT id FROM users WHERE role = 'SUPER_ADMIN'");
    if (!owner) { console.error("Aucun propriétaire."); process.exit(1); }
    run(db, "UPDATE users SET mfa_enabled = 0, mfa_secret = NULL WHERE id = ?", owner.id);
    destroyAllSessions(db, owner.id);
    audit(db, SYSTEM, "OWNER_MFA_RESET_VIA_CLI", "user", owner.id);
    console.info("MFA réinitialisée. Elle devra être reconfigurée à la prochaine connexion. Action enregistrée dans l'audit.");
    break;
  }
  default:
    console.info("Commandes : create-owner | seed-dev | backup [fichier] | owner-reset-link | reset-owner-mfa");
}
db.close();
