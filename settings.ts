import { type DB, one, run } from "../db/db.ts";
import { INITIAL_PRICING_RULE } from "../config/initial-pricing.ts";
import { DEFAULTS, DEFAULT_FEATURE_FLAGS, type FeatureFlag } from "../config/defaults.ts";
import type { PricingRule } from "../domain/pricing/pricing.ts";
import { audit, type AuditActor } from "./audit.ts";

export interface CompanyInfo {
  legal_name: string; display_name: string; address: string; postal_code: string; city: string;
  country: string; phone: string; email: string; website: string; uid: string; vat_number: string;
  service_mode: "TAXI" | "VTC" | "PRIVATE_TRANSPORT" | "OTHER"; canton: string; commune: string;
}
export interface TaxConfig { tax_enabled: boolean; tax_rate_bps: number; tax_label: string; tax_number: string; tax_included: boolean }
export interface BookingPolicy {
  conflict_window_minutes: number; free_cancellation_hours: number;
  min_lead_minutes: number; max_advance_days: number;
}
export interface ReferralPolicy { referral_reward: number; max_invitations_per_30_days: number }

export interface Settings {
  pricing: PricingRule;
  driver_share_bps: number;
  company: CompanyInfo;
  tax: TaxConfig;
  booking: BookingPolicy;
  referral: ReferralPolicy;
  features: Record<FeatureFlag, boolean>;
  holidays: string[];
  maintenance: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  pricing: INITIAL_PRICING_RULE,
  driver_share_bps: DEFAULTS.driverShareBps,
  company: {
    legal_name: "", display_name: "Private Driver Club", address: "", postal_code: "", city: "",
    country: "CH", phone: "", email: "", website: "", uid: "", vat_number: "",
    service_mode: "PRIVATE_TRANSPORT", canton: "", commune: "",
  },
  // TVA désactivée par défaut : à configurer selon la situation réelle de l'entreprise.
  tax: { tax_enabled: false, tax_rate_bps: 0, tax_label: "TVA", tax_number: "", tax_included: true },
  booking: { conflict_window_minutes: 90, free_cancellation_hours: 2, min_lead_minutes: 0, max_advance_days: 90 },
  referral: { referral_reward: 0, max_invitations_per_30_days: 10 },
  features: { ...DEFAULT_FEATURE_FLAGS },
  holidays: [],
  maintenance: false,
};

type Key = keyof Settings;

export function getSetting<K extends Key>(db: DB, key: K): Settings[K] {
  const row = one<{ value: string }>(db, "SELECT value FROM settings WHERE key = ?", key);
  if (!row) return structuredClone(DEFAULT_SETTINGS[key]);
  const stored = JSON.parse(row.value) as Settings[K];
  const def = DEFAULT_SETTINGS[key];
  // Fusion avec les valeurs par défaut pour les champs ajoutés ultérieurement.
  if (def && typeof def === "object" && !Array.isArray(def)) return { ...(def as object), ...(stored as object) } as Settings[K];
  return stored;
}

export function getSettings(db: DB): Settings {
  const out = {} as Record<Key, unknown>;
  for (const k of Object.keys(DEFAULT_SETTINGS) as Key[]) out[k] = getSetting(db, k);
  return out as unknown as Settings;
}

/** Toute modification est auditée avec ancienne et nouvelle valeur (§82). */
export function setSetting<K extends Key>(db: DB, actor: AuditActor, key: K, value: Settings[K]): void {
  const before = getSetting(db, key);
  run(db, `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    key, JSON.stringify(value), new Date().toISOString(), actor.id);
  audit(db, actor, "SETTINGS_UPDATED", "settings", key, "SUCCESS", { before, after: value });
}
