import { type Minor, nonNegative, MoneyError } from "../money/money.ts";

/**
 * Snapshot financier figé à la clôture d'une course (§15–16, §83).
 * Invariant : driverAmount + companyAmount === grossAmount, au centime près.
 * Une fois persisté (DriverEarning), il n'est JAMAIS recalculé : un changement
 * de taux ultérieur ne s'applique qu'aux courses clôturées après ce changement.
 */
export interface EarningSnapshot {
  readonly grossAmount: Minor;
  readonly driverShareBps: number;
  readonly driverAmount: Minor;
  readonly companyAmount: Minor;
}

export interface ShareConfig {
  defaultBps: number;
  /** Taux spécifiques par chauffeur (§83), décidés par SUPER_ADMIN. */
  perDriverBps?: Readonly<Record<string, number>>;
}

function assertBps(bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
    throw new MoneyError(`Taux chauffeur invalide: ${bps}`);
  }
}

export function resolveDriverShareBps(config: ShareConfig, driverId: string): number {
  const bps = config.perDriverBps?.[driverId] ?? config.defaultBps;
  assertBps(bps);
  return bps;
}

export function computeEarningSnapshot(gross: Minor, driverShareBps: number): EarningSnapshot {
  const grossAmount = nonNegative(gross);
  assertBps(driverShareBps);
  const driverAmount = nonNegative(Math.floor((grossAmount * driverShareBps + 5000) / 10000));
  const companyAmount = nonNegative(grossAmount - driverAmount);
  return Object.freeze({ grossAmount, driverShareBps, driverAmount, companyAmount });
}
