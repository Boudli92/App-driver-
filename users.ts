import { type DB, one, all, run, tx } from "../db/db.ts";
import {
  hashPassword, verifyPassword, passwordProblem, token, sha256, newId, humanCode, newTotpSecret, verifyTotp,
} from "../lib/security.ts";
import type { SessionUser } from "../lib/http.ts";
import { audit, type AuditActor, SYSTEM } from "./audit.ts";
import { getSetting } from "./settings.ts";
import type { NotificationService } from "./notify.ts";
import { normalizeEmail } from "../domain/referrals/referral-guard.ts";

export class DomainError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

const now = () => new Date().toISOString();
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/;

export function validateEmail(email: string): string {
  const e = email.trim().toLowerCase();
  if (!EMAIL_RE.test(e)) throw new DomainError("Adresse e-mail invalide.");
  return e;
}
export function validatePhone(phone: string, required = false): string {
  const p = phone.trim();
  if (!p && !required) return "";
  if (!PHONE_RE.test(p)) throw new DomainError("Numéro de téléphone invalide.");
  return p;
}
function validateName(n: string, label: string): string {
  const v = n.trim();
  if (v.length < 1 || v.length > 80) throw new DomainError(`${label} invalide.`);
  return v;
}

export const SESSION_TTL = { SUPER_ADMIN: 2 * 3600, DRIVER: 14 * 86400, CUSTOMER: 30 * 86400 } as const;

// --- Propriétaire (SUPER_ADMIN unique) --------------------------------------------
export function createOwner(db: DB, input: { email: string; password: string; firstName: string; lastName: string }): string {
  if (one(db, "SELECT id FROM users WHERE role = 'SUPER_ADMIN'")) {
    throw new DomainError("Un SUPER_ADMIN existe déjà (SINGLE_OWNER_MODE).", 409);
  }
  const problem = passwordProblem(input.password);
  if (problem) throw new DomainError(problem);
  const id = newId(), t = now();
  run(db, `INSERT INTO users (id, email, password_hash, role, status, first_name, last_name, created_at, updated_at, approved_at)
           VALUES (?, ?, ?, 'SUPER_ADMIN', 'ACTIVE', ?, ?, ?, ?, ?)`,
    id, validateEmail(input.email), hashPassword(input.password), validateName(input.firstName, "Prénom"),
    validateName(input.lastName, "Nom"), t, t, t);
  audit(db, SYSTEM, "OWNER_CREATED", "user", id);
  return id;
}

// --- Connexion et sessions -------------------------------------------------------
interface UserRow extends SessionUser { password_hash: string | null; failed_logins: number; locked_until: string | null; mfa_secret: string | null }

export function login(db: DB, email: string, password: string): UserRow {
  const user = one<UserRow>(db, "SELECT * FROM users WHERE email = ? AND deleted_at IS NULL", email.trim().toLowerCase());
  if (user?.locked_until && user.locked_until > now()) {
    verifyPassword(password, null);
    audit(db, { id: user.id, role: user.role }, "LOGIN_LOCKED", "user", user.id, "DENIED");
    throw new DomainError("Compte temporairement verrouillé après plusieurs échecs. Réessayez plus tard.", 429);
  }
  const ok = verifyPassword(password, user?.password_hash ?? null);
  if (!user || !ok) {
    if (user) {
      const fails = user.failed_logins + 1;
      // Verrouillage progressif : 15 min, 30, 60… plafonné à 24 h, dès 5 échecs.
      const lockMin = fails >= 5 ? Math.min(15 * 2 ** (fails - 5), 1440) : 0;
      run(db, "UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?", fails,
        lockMin ? new Date(Date.now() + lockMin * 60_000).toISOString() : null, user.id);
      audit(db, { id: user.id, role: user.role }, "LOGIN_FAILED", "user", user.id, "DENIED", { fails });
    }
    throw new DomainError("E-mail ou mot de passe incorrect.", 401);
  }
  if (["BLOCKED", "INACTIVE"].includes(user.status)) throw new DomainError("Ce compte n'est pas actif.", 403);
  run(db, "UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?", user.id);
  audit(db, { id: user.id, role: user.role }, "LOGIN_SUCCESS", "user", user.id);
  return user;
}

export function createSession(db: DB, user: { id: string; role: keyof typeof SESSION_TTL }, userAgent: string): { token: string; maxAge: number } {
  const t = token(), maxAge = SESSION_TTL[user.role];
  run(db, `INSERT INTO sessions (id_hash, user_id, csrf, mfa_ok, created_at, expires_at, user_agent) VALUES (?, ?, ?, 0, ?, ?, ?)`,
    sha256(t), user.id, token(24), now(), new Date(Date.now() + maxAge * 1000).toISOString(), userAgent.slice(0, 200));
  run(db, "DELETE FROM sessions WHERE expires_at < ?", now());
  return { token: t, maxAge };
}

export function loadSession(db: DB, rawToken: string | undefined) {
  if (!rawToken || rawToken.length > 100) return null;
  const idHash = sha256(rawToken);
  const row = one<SessionUser & { csrf: string; mfa_ok: number; expires_at: string }>(db,
    `SELECT u.id, u.email, u.role, u.status, u.first_name, u.last_name, u.mfa_enabled, s.csrf, s.mfa_ok, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND u.deleted_at IS NULL`, idHash);
  if (!row || row.expires_at < now()) return null;
  if (["BLOCKED", "INACTIVE"].includes(row.status)) return null;
  const { csrf, mfa_ok, expires_at: _e, ...user } = row;
  return { user: user as SessionUser, session: { idHash, csrf, mfaOk: mfa_ok === 1 } };
}

export function destroySession(db: DB, idHash: string): void {
  run(db, "DELETE FROM sessions WHERE id_hash = ?", idHash);
}

export function destroyAllSessions(db: DB, userId: string): void {
  run(db, "DELETE FROM sessions WHERE user_id = ?", userId);
}

// --- MFA -----------------------------------------------------------------------
export function beginMfaSetup(db: DB, userId: string): string {
  const u = one<{ mfa_enabled: number }>(db, "SELECT mfa_enabled FROM users WHERE id = ?", userId);
  if (u?.mfa_enabled) throw new DomainError("La MFA est déjà activée.", 409);
  const secret = newTotpSecret();
  run(db, "UPDATE users SET mfa_secret = ? WHERE id = ?", secret, userId);
  return secret;
}

export function confirmMfa(db: DB, userId: string, code: string, sessionHash: string): void {
  const u = one<{ mfa_secret: string | null; role: string }>(db, "SELECT mfa_secret, role FROM users WHERE id = ?", userId);
  if (!u?.mfa_secret || !verifyTotp(u.mfa_secret, code)) throw new DomainError("Code invalide.");
  run(db, "UPDATE users SET mfa_enabled = 1 WHERE id = ?", userId);
  run(db, "UPDATE sessions SET mfa_ok = 1 WHERE id_hash = ?", sessionHash);
  audit(db, { id: userId, role: u.role }, "MFA_ENABLED", "user", userId);
}

export function verifyMfaForSession(db: DB, userId: string, code: string, sessionHash: string): void {
  const u = one<{ mfa_secret: string | null; role: string }>(db, "SELECT mfa_secret, role FROM users WHERE id = ? AND mfa_enabled = 1", userId);
  if (!u?.mfa_secret || !verifyTotp(u.mfa_secret, code)) {
    audit(db, { id: userId, role: u?.role ?? "?" }, "MFA_FAILED", "user", userId, "DENIED");
    throw new DomainError("Code invalide.", 401);
  }
  run(db, "UPDATE sessions SET mfa_ok = 1 WHERE id_hash = ?", sessionHash);
  audit(db, { id: userId, role: u.role }, "MFA_VERIFIED", "user", userId);
}

// --- Invitations clients -----------------------------------------------------------
export function ensureReferralCode(db: DB, userId: string): string {
  const u = one<{ referral_code: string | null }>(db, "SELECT referral_code FROM users WHERE id = ?", userId);
  if (u?.referral_code) return u.referral_code;
  const code = humanCode(8);
  run(db, "UPDATE users SET referral_code = ? WHERE id = ?", code, userId);
  return code;
}

export function createCustomerInvitation(db: DB, actor: AuditActor, input: { email?: string; source?: string; campaign?: string; maxUses?: number }): string {
  if (!actor.id) throw new DomainError("Invitation impossible.", 403);
  const isAdmin = actor.role === "SUPER_ADMIN";
  if (!isAdmin) {
    const quota = getSetting(db, "referral").max_invitations_per_30_days;
    const since = new Date(Date.now() - 30 * 86400_000).toISOString();
    const count = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM invitations WHERE inviter_user_id = ? AND kind = 'CUSTOMER' AND created_at > ?", actor.id, since)!.n;
    if (count >= quota) throw new DomainError("Limite d'invitations atteinte pour les 30 derniers jours.", 429);
  }
  const code = humanCode(8), id = newId();
  run(db, `INSERT INTO invitations (id, code, kind, inviter_user_id, invited_email, source, campaign, max_uses, created_at, expires_at)
           VALUES (?, ?, 'CUSTOMER', ?, ?, ?, ?, ?, ?, ?)`,
    id, code, actor.id, input.email ? validateEmail(input.email) : null, (input.source ?? "").slice(0, 60),
    (input.campaign ?? "").slice(0, 60), isAdmin ? Math.min(Math.max(input.maxUses ?? 1, 1), 100) : 1, now(),
    new Date(Date.now() + 30 * 86400_000).toISOString());
  audit(db, actor, "INVITATION_CREATED", "invitation", id, "SUCCESS", { code });
  return code;
}

interface InvitationRow { id: string; code: string; kind: string; inviter_user_id: string | null; target_user_id: string | null; invited_email: string | null; status: string; uses: number; max_uses: number; expires_at: string | null }

export function findActiveInvitation(db: DB, code: string, kind: "CUSTOMER" | "DRIVER" | "PASSWORD_RESET"): InvitationRow | undefined {
  const stored = kind === "CUSTOMER" ? code.trim().toUpperCase() : sha256(code);
  const inv = one<InvitationRow>(db, "SELECT * FROM invitations WHERE code = ? AND kind = ?", stored, kind);
  if (!inv || inv.status !== "ACTIVE" || inv.uses >= inv.max_uses) return undefined;
  if (inv.expires_at && inv.expires_at < now()) return undefined;
  return inv;
}

export function registerCustomer(db: DB, input: {
  code: string; email: string; phone: string; firstName: string; lastName: string; password: string; userAgent: string; acceptTerms: boolean;
}, notifier?: NotificationService): string {
  if (!input.acceptTerms) throw new DomainError("Vous devez accepter les conditions et la politique de confidentialité.");
  const email = validateEmail(input.email);
  const phone = validatePhone(input.phone, true);
  const problem = passwordProblem(input.password);
  if (problem) throw new DomainError(problem);

  return tx(db, () => {
    let inv: InvitationRow | undefined;
    if (input.code) {
      inv = findActiveInvitation(db, input.code, "CUSTOMER");
      if (!inv) throw new DomainError("Ce lien d'invitation n'est plus valide.");
      if (inv.invited_email && inv.invited_email !== email) throw new DomainError("Cette invitation est réservée à une autre adresse e-mail.");
    }
    if (one(db, "SELECT id FROM users WHERE email = ?", email)) {
      throw new DomainError("Une demande existe déjà pour cette adresse. Connectez-vous ou contactez-nous.", 409);
    }
    const inviter = inv?.inviter_user_id
      ? one<{ id: string; email: string; phone: string | null; role: string }>(db, "SELECT id, email, phone, role FROM users WHERE id = ?", inv.inviter_user_id)
      : undefined;
    const flags: string[] = [];
    if (inviter && inviter.role === "CUSTOMER") {
      if (normalizeEmail(inviter.email) === normalizeEmail(email) || (inviter.phone && inviter.phone === phone)) {
        audit(db, SYSTEM, "SELF_REFERRAL_BLOCKED", "invitation", inv!.id, "DENIED");
        throw new DomainError("Ce lien d'invitation ne peut pas être utilisé pour ce compte.");
      }
    }
    if (one(db, "SELECT id FROM users WHERE phone = ?", phone)) flags.push("PHONE_ALREADY_USED");
    const id = newId(), t = now();
    run(db, `INSERT INTO users (id, email, phone, password_hash, role, status, first_name, last_name, invited_by, invitation_id, admin_notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'CUSTOMER', 'PENDING_APPROVAL', ?, ?, ?, ?, ?, ?, ?)`,
      id, email, phone, hashPassword(input.password), validateName(input.firstName, "Prénom"), validateName(input.lastName, "Nom"),
      inviter?.id ?? null, inv?.id ?? null, flags.length ? `[Alerte automatique] ${flags.join(", ")}` : "", t, t);
    if (inv) {
      run(db, `UPDATE invitations SET uses = uses + 1, last_used_at = ?, last_used_ua = ?,
               status = CASE WHEN uses + 1 >= max_uses THEN 'USED' ELSE status END WHERE id = ?`,
        t, input.userAgent.slice(0, 200), inv.id);
    }
    audit(db, { id, role: "CUSTOMER" }, "CUSTOMER_REGISTERED", "user", id, "SUCCESS", { invitation: inv?.code ?? null, inviter: inviter?.id ?? null, flags });
    const owner = one<{ id: string; email: string }>(db, "SELECT id, email FROM users WHERE role = 'SUPER_ADMIN'");
    if (owner && notifier) notifier.notify(owner, "WELCOME", "Nouvelle demande d'adhésion", `${input.firstName} ${input.lastName} attend votre validation.`);
    return id;
  });
}

export function setCustomerStatus(db: DB, actor: AuditActor, customerId: string, status: "APPROVED" | "REJECTED" | "SUSPENDED" | "BLOCKED", notifier?: NotificationService): void {
  const c = one<{ id: string; email: string; status: string; role: string }>(db, "SELECT id, email, status, role FROM users WHERE id = ?", customerId);
  if (!c || c.role !== "CUSTOMER") throw new DomainError("Client introuvable.", 404);
  const t = now();
  if (status === "APPROVED") {
    run(db, "UPDATE users SET status = 'APPROVED', approved_at = COALESCE(approved_at, ?), approved_by = COALESCE(approved_by, ?), updated_at = ? WHERE id = ?", t, actor.id, t, customerId);
    ensureReferralCode(db, customerId);
    notifier?.notify(c, "APPROVAL", "Bienvenue au Club", "Votre adhésion a été validée. Vous pouvez désormais réserver.");
  } else {
    run(db, "UPDATE users SET status = ?, updated_at = ? WHERE id = ?", status, t, customerId);
    if (status !== "REJECTED") destroyAllSessions(db, customerId);
    if (status === "REJECTED") notifier?.notify(c, "REJECTION", "Votre demande d'adhésion", "Nous ne sommes pas en mesure de donner suite à votre demande.");
  }
  audit(db, actor, `CUSTOMER_${status}`, "user", customerId, "SUCCESS", { before: c.status, after: status });
}

// --- Chauffeurs (création réservée au SUPER_ADMIN) --------------------------------
export function createDriver(db: DB, actor: AuditActor, input: {
  email: string; phone: string; firstName: string; lastName: string; licenseNumber: string; licenseExpiry: string; hiredAt: string;
}): { driverId: string; setupToken: string } {
  if (actor.role !== "SUPER_ADMIN") throw new DomainError("Interdit.", 403);
  const email = validateEmail(input.email);
  return tx(db, () => {
    if (one(db, "SELECT id FROM users WHERE email = ?", email)) throw new DomainError("Cette adresse est déjà utilisée.", 409);
    const id = newId(), t = now();
    run(db, `INSERT INTO users (id, email, phone, role, status, first_name, last_name, created_at, updated_at)
             VALUES (?, ?, ?, 'DRIVER', 'INVITED', ?, ?, ?, ?)`,
      id, email, validatePhone(input.phone), validateName(input.firstName, "Prénom"), validateName(input.lastName, "Nom"), t, t);
    run(db, `INSERT INTO driver_profiles (user_id, license_number, license_expiry, hired_at) VALUES (?, ?, ?, ?)`,
      id, input.licenseNumber.slice(0, 40), validDateOrNull(input.licenseExpiry), validDateOrNull(input.hiredAt));
    const setupToken = token(24);
    run(db, `INSERT INTO invitations (id, code, kind, inviter_user_id, target_user_id, invited_email, created_at, expires_at)
             VALUES (?, ?, 'DRIVER', ?, ?, ?, ?, ?)`,
      newId(), sha256(setupToken), actor.id, id, email, t, new Date(Date.now() + 7 * 86400_000).toISOString());
    audit(db, actor, "DRIVER_CREATED", "user", id, "SUCCESS", { email });
    return { driverId: id, setupToken };
  });
}

export function regenerateDriverSetup(db: DB, actor: AuditActor, driverId: string): string {
  const d = one<{ status: string; email: string }>(db, "SELECT status, email FROM users WHERE id = ? AND role = 'DRIVER'", driverId);
  if (!d) throw new DomainError("Chauffeur introuvable.", 404);
  run(db, "UPDATE invitations SET status = 'REVOKED' WHERE target_user_id = ? AND kind = 'DRIVER' AND status = 'ACTIVE'", driverId);
  const setupToken = token(24);
  run(db, `INSERT INTO invitations (id, code, kind, inviter_user_id, target_user_id, invited_email, created_at, expires_at)
           VALUES (?, ?, 'DRIVER', ?, ?, ?, ?, ?)`,
    newId(), sha256(setupToken), actor.id, driverId, d.email, now(), new Date(Date.now() + 7 * 86400_000).toISOString());
  audit(db, actor, "DRIVER_SETUP_LINK_REGENERATED", "user", driverId);
  return setupToken;
}

export function completeDriverSetup(db: DB, setupToken: string, password: string): string {
  const problem = passwordProblem(password);
  if (problem) throw new DomainError(problem);
  return tx(db, () => {
    const inv = findActiveInvitation(db, setupToken, "DRIVER");
    if (!inv?.target_user_id) throw new DomainError("Lien invalide ou expiré. Demandez un nouveau lien à l'entreprise.");
    run(db, "UPDATE users SET password_hash = ?, status = 'PENDING_SETUP', updated_at = ? WHERE id = ? AND status IN ('INVITED','PENDING_SETUP')",
      hashPassword(password), now(), inv.target_user_id);
    run(db, "UPDATE invitations SET status = 'USED', uses = uses + 1, last_used_at = ? WHERE id = ?", now(), inv.id);
    audit(db, { id: inv.target_user_id, role: "DRIVER" }, "DRIVER_SETUP_COMPLETED", "user", inv.target_user_id);
    return inv.target_user_id;
  });
}

const DRIVER_STATUSES = ["ACTIVE", "SUSPENDED", "INACTIVE", "BLOCKED"] as const;
export function setDriverStatus(db: DB, actor: AuditActor, driverId: string, status: string): void {
  if (!(DRIVER_STATUSES as readonly string[]).includes(status)) throw new DomainError("Statut invalide.");
  const d = one<{ status: string; password_hash: string | null }>(db, "SELECT status, password_hash FROM users WHERE id = ? AND role = 'DRIVER'", driverId);
  if (!d) throw new DomainError("Chauffeur introuvable.", 404);
  if (status === "ACTIVE" && !d.password_hash) throw new DomainError("Le chauffeur n'a pas encore configuré son compte.");
  run(db, "UPDATE users SET status = ?, updated_at = ? WHERE id = ?", status, now(), driverId);
  if (status !== "ACTIVE") destroyAllSessions(db, driverId);
  audit(db, actor, "DRIVER_STATUS_CHANGED", "user", driverId, "SUCCESS", { before: d.status, after: status });
}

export function setDriverShare(db: DB, actor: AuditActor, driverId: string, bps: number | null): void {
  if (bps !== null && (!Number.isInteger(bps) || bps < 0 || bps > 10000)) throw new DomainError("Taux invalide.");
  const before = one<{ share_bps: number | null }>(db, "SELECT share_bps FROM driver_profiles WHERE user_id = ?", driverId);
  if (!before) throw new DomainError("Chauffeur introuvable.", 404);
  run(db, "UPDATE driver_profiles SET share_bps = ? WHERE user_id = ?", bps, driverId);
  audit(db, actor, "DRIVER_SHARE_CHANGED", "driver_profile", driverId, "SUCCESS", { before: before.share_bps, after: bps });
}

// --- Réinitialisation de mot de passe ---------------------------------------------
export function createPasswordReset(db: DB, email: string, actor: AuditActor = SYSTEM): { userId: string; token: string } | null {
  const u = one<{ id: string; role: string }>(db, "SELECT id, role FROM users WHERE email = ? AND deleted_at IS NULL AND password_hash IS NOT NULL", email.trim().toLowerCase());
  if (!u) return null;
  run(db, "UPDATE invitations SET status = 'REVOKED' WHERE target_user_id = ? AND kind = 'PASSWORD_RESET' AND status = 'ACTIVE'", u.id);
  const t = token(24);
  run(db, `INSERT INTO invitations (id, code, kind, target_user_id, created_at, expires_at) VALUES (?, ?, 'PASSWORD_RESET', ?, ?, ?)`,
    newId(), sha256(t), u.id, now(), new Date(Date.now() + 3600_000).toISOString());
  audit(db, actor, "PASSWORD_RESET_REQUESTED", "user", u.id);
  return { userId: u.id, token: t };
}

export function resetPassword(db: DB, resetToken: string, password: string): void {
  const problem = passwordProblem(password);
  if (problem) throw new DomainError(problem);
  tx(db, () => {
    const inv = findActiveInvitation(db, resetToken, "PASSWORD_RESET");
    if (!inv?.target_user_id) throw new DomainError("Lien invalide ou expiré.");
    run(db, "UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?", hashPassword(password), now(), inv.target_user_id);
    run(db, "UPDATE invitations SET status = 'USED', uses = uses + 1, last_used_at = ? WHERE id = ?", now(), inv.id);
    destroyAllSessions(db, inv.target_user_id);
    audit(db, { id: inv.target_user_id, role: "?" }, "PASSWORD_RESET_DONE", "user", inv.target_user_id);
  });
}

export function changePassword(db: DB, userId: string, current: string, next: string): void {
  const u = one<{ password_hash: string | null; role: string }>(db, "SELECT password_hash, role FROM users WHERE id = ?", userId);
  if (!u || !verifyPassword(current, u.password_hash)) throw new DomainError("Mot de passe actuel incorrect.");
  const problem = passwordProblem(next);
  if (problem) throw new DomainError(problem);
  run(db, "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", hashPassword(next), now(), userId);
  audit(db, { id: userId, role: u.role }, "PASSWORD_CHANGED", "user", userId);
}

export function validDateOrNull(s: string): string | null {
  const v = s.trim();
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new DomainError("Date invalide (AAAA-MM-JJ).");
  return v;
}

/** Export des données personnelles (droit d'accès LPD/RGPD). */
export function exportPersonalData(db: DB, userId: string): Record<string, unknown> {
  const user = one(db, `SELECT id, email, phone, role, status, first_name, last_name, referral_code, created_at, approved_at FROM users WHERE id = ?`, userId);
  return {
    exported_at: now(), user,
    bookings: all(db, "SELECT number, pickup_address, dropoff_address, pickup_at, status, final_total, created_at FROM bookings WHERE customer_id = ?", userId),
    invoices: all(db, "SELECT number, issued_at, total, status, payment_method FROM invoices WHERE customer_id = ?", userId),
    rewards: all(db, "SELECT amount, kind, note, created_at FROM reward_ledger WHERE user_id = ?", userId),
    invitations_sent: all(db, "SELECT code, created_at, uses FROM invitations WHERE inviter_user_id = ? AND kind = 'CUSTOMER'", userId),
  };
}
