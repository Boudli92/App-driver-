/**
 * Garde-fous parrainage (§7, §56). Les signaux (hash d'email normalisé,
 * téléphone, empreinte d'appareil) sont stockés hachés, jamais en clair.
 */
export interface ReferralCheckInput {
  inviterUserId: string;
  inviterEmailHash: string;
  inviterPhoneHash: string | null;
  inviteeEmailHash: string;
  inviteePhoneHash: string | null;
  inviterInvitationsLast30Days: number;
  maxInvitationsPer30Days: number;
  /** Comptes existants partageant téléphone/appareil avec l'invité. */
  existingAccountsWithSameSignals: number;
}

export type ReferralVerdict =
  | { ok: true }
  | { ok: false; reason: "self_referral" | "invitation_quota" | "multi_account_suspected" };

/** Normalise un email avant hachage : minuscules, suppression des alias "+tag". */
export function normalizeEmail(email: string): string {
  const [local = "", domain = ""] = email.trim().toLowerCase().split("@");
  return `${local.split("+")[0]}@${domain}`;
}

export function checkReferral(i: ReferralCheckInput): ReferralVerdict {
  if (i.inviterEmailHash === i.inviteeEmailHash) return { ok: false, reason: "self_referral" };
  if (i.inviterPhoneHash && i.inviterPhoneHash === i.inviteePhoneHash) return { ok: false, reason: "self_referral" };
  if (i.inviterInvitationsLast30Days >= i.maxInvitationsPer30Days) return { ok: false, reason: "invitation_quota" };
  if (i.existingAccountsWithSameSignals > 0) return { ok: false, reason: "multi_account_suspected" };
  return { ok: true };
}
