/**
 * Configuration initiale (§135–138). Les valeurs commerciales sont ensuite
 * stockées en base (CompanySettings) et modifiables par SUPER_ADMIN uniquement.
 * Les trois drapeaux structurels ci-dessous sont des constantes : ils ne sont
 * PAS exposés en configuration, pour empêcher toute activation accidentelle.
 */
export const MARKETPLACE_MODE = false as const;
export const MULTI_COMPANY_MODE = false as const;
export const SINGLE_OWNER_MODE = true as const;

export const DEFAULTS = {
  currency: "CHF",
  timezone: "Europe/Zurich",
  language: "fr",
  /** 40 % exprimé en points de base (1 % = 100 bps) pour autoriser 42,5 % etc. */
  driverShareBps: 4000,
  membershipClosed: true,
  manualApproval: true,
  driverSelfRegistration: false,
  customerSelfApproval: false,
} as const;

export type FeatureFlag =
  | "crypto" | "loyalty" | "referral" | "cash" | "sms" | "push"
  | "multiVehicle" | "multiCanton" | "multiCurrency";

export const DEFAULT_FEATURE_FLAGS: Record<FeatureFlag, boolean> = {
  crypto: false, loyalty: true, referral: true, cash: true, sms: false,
  push: false, multiVehicle: true, multiCanton: false, multiCurrency: false,
};
