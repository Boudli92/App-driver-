/**
 * Montants en unités mineures entières (CHF 100.00 = 10000). Jamais de float (§14).
 */
export type Minor = number & { readonly __brand: "Minor" };
export type CurrencyCode = "CHF" | "EUR";

export class MoneyError extends Error {}

export function minor(value: number): Minor {
  if (!Number.isSafeInteger(value)) throw new MoneyError(`Montant non entier: ${value}`);
  return value as Minor;
}

export function nonNegative(value: number): Minor {
  const m = minor(value);
  if (m < 0) throw new MoneyError(`Montant négatif interdit: ${value}`);
  return m;
}

export function add(...values: Minor[]): Minor {
  return minor(values.reduce((a, b) => a + b, 0));
}

/** Multiplie par un taux en points de base (10000 = 100 %), arrondi demi vers le haut. */
export function applyBps(amount: Minor, bps: number): Minor {
  if (!Number.isInteger(bps) || bps < 0) throw new MoneyError(`Taux invalide: ${bps}`);
  const product = amount * bps;
  if (!Number.isSafeInteger(product)) throw new MoneyError("Dépassement de capacité");
  return minor(Math.floor((product + 5000) / 10000));
}

/** Arrondi à un pas (ex. 5 centimes = 5). */
export function roundToStep(amount: Minor, step: number): Minor {
  if (!Number.isInteger(step) || step <= 0) throw new MoneyError(`Pas invalide: ${step}`);
  return minor(Math.round(amount / step) * step);
}

/** Affichage "CHF 1’140.00" selon les conventions suisses. */
export function format(amount: Minor, currency: CurrencyCode = "CHF"): string {
  const neg = amount < 0;
  const abs = Math.abs(amount);
  const units = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "’");
  const cents = (abs % 100).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${currency} ${units}.${cents}`;
}
