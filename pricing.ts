import { type Minor, minor, nonNegative, add, applyBps, roundToStep, MoneyError } from "../money/money.ts";

/**
 * Moteur de tarification serveur (§13). L'entrée ne contient AUCUN prix :
 * le client fournit trajet et options, le serveur calcule. Toute valeur
 * provient d'une PricingRule stockée en base et éditable par SUPER_ADMIN.
 */
export interface PricingRule {
  vehicleCategory: string;
  baseFare: Minor;          // prise en charge
  /** true : pas de prise en charge si le trajet est au minimum ou en dessous. */
  waiveBaseFareAtMinimum: boolean;
  perKm: Minor;             // par km, tarif de jour
  nightPerKm: Minor;        // par km, tarif de nuit (remplace perKm la nuit)
  perMinute: Minor;         // par minute de trajet
  minimumFare: Minor;       // minimum de jour
  nightMinimumFare: Minor;  // minimum de nuit
  waitingPerMinute: Minor;       // attente de jour
  nightWaitingPerMinute: Minor;  // attente de nuit
  freeWaitingMinutes: number;  // minutes offertes après l'arrivée du chauffeur
  nightSurchargeBps: number;   // majoration % optionnelle la nuit (0 si tarif/km de nuit suffit)
  nightStartHour: number;      // heure locale, ex. 22
  nightEndHour: number;        // ex. 6
  weekendSurchargeBps: number;
  holidaySurchargeBps: number;
  airportFee: Minor;
  luggagePerItem: Minor;
  freeLuggageItems: number;
  childSeatFee: Minor;
  meetAndGreetFee: Minor;
  urgentFee: Minor;
  urgentThresholdMinutes: number;
  roundingStep: number;        // 5 = arrondi aux 5 centimes
}

export interface PricingInput {
  vehicleCategory: string;
  distanceMeters: number;
  durationSeconds: number;
  pickupAt: Date;
  requestedAt: Date;
  timezone: string;
  holidays: readonly string[]; // "YYYY-MM-DD" en heure locale, configurés par l'entreprise
  isAirport: boolean;
  luggageCount: number;
  childSeats: number;
  meetAndGreet: boolean;
  /** Minutes d'attente mesurées (0 au devis ; valeur réelle à la clôture). */
  waitingMinutes: number;
}

export interface PriceLine { code: string; amount: Minor }
export interface PriceQuote { lines: PriceLine[]; total: Minor; ruleCategory: string }

export class PricingError extends Error {
  readonly status = 422 as const;
}

function localParts(date: Date, timeZone: string): { ymd: string; hour: number; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { ymd: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")), weekday: get("weekday") };
}

function intInRange(name: string, v: number, max: number): void {
  if (!Number.isInteger(v) || v < 0 || v > max) throw new PricingError(`${name} invalide`);
}

export function quote(rule: PricingRule, input: PricingInput): PriceQuote {
  if (rule.vehicleCategory !== input.vehicleCategory) throw new PricingError("Catégorie incohérente");
  intInRange("distance", input.distanceMeters, 1_000_000);
  intInRange("durée", input.durationSeconds, 86_400);
  intInRange("bagages", input.luggageCount, 20);
  intInRange("sièges enfant", input.childSeats, 4);
  intInRange("attente", input.waitingMinutes, 600);
  if (input.pickupAt.getTime() < input.requestedAt.getTime() - 60_000) {
    throw new PricingError("Heure de prise en charge dans le passé");
  }

  const lines: PriceLine[] = [];
  const push = (code: string, amount: number) => { if (amount !== 0) lines.push({ code, amount: nonNegative(amount) }); };

  const local = localParts(input.pickupAt, input.timezone);
  const isNight = rule.nightStartHour > rule.nightEndHour
    ? local.hour >= rule.nightStartHour || local.hour < rule.nightEndHour
    : local.hour >= rule.nightStartHour && local.hour < rule.nightEndHour;

  const kmRate = isNight ? rule.nightPerKm : rule.perKm;
  push(isNight ? "DISTANCE_NIGHT" : "DISTANCE", Math.round((kmRate * input.distanceMeters) / 1000));
  push("DURATION", Math.round((rule.perMinute * input.durationSeconds) / 60));
  const travel = add(...lines.map((l) => l.amount));

  // Le minimum porte sur le trajet ; attente et suppléments s'ajoutent au-dessus.
  const minimum = isNight ? rule.nightMinimumFare : rule.minimumFare;
  const minimumCode = isNight ? "NIGHT_MINIMUM_FARE_ADJUSTMENT" : "MINIMUM_FARE_ADJUSTMENT";
  let ride: Minor;
  if (rule.waiveBaseFareAtMinimum) {
    // Prise en charge due uniquement si le trajet dépasse le minimum.
    if (travel <= minimum) {
      push(minimumCode, minimum - travel);
      ride = minimum;
    } else {
      push("BASE_FARE", rule.baseFare);
      ride = add(travel, rule.baseFare);
    }
  } else {
    push("BASE_FARE", rule.baseFare);
    ride = add(travel, rule.baseFare);
    if (ride < minimum) {
      push(minimumCode, minimum - ride);
      ride = minimum;
    }
  }

  // Attente : facturée en plus du minimum, après les minutes offertes.
  const billableWaiting = Math.max(0, input.waitingMinutes - rule.freeWaitingMinutes);
  const waitRate = isNight ? rule.nightWaitingPerMinute : rule.waitingPerMinute;
  push(isNight ? "WAITING_NIGHT" : "WAITING", waitRate * billableWaiting);

  // Majorations horaires : on applique la plus élevée, non cumulatives.
  const candidates: [string, number][] = [];
  if (isNight && rule.nightSurchargeBps > 0) candidates.push(["NIGHT_SURCHARGE", rule.nightSurchargeBps]);
  if (local.weekday === "Sat" || local.weekday === "Sun") candidates.push(["WEEKEND_SURCHARGE", rule.weekendSurchargeBps]);
  if (input.holidays.includes(local.ymd)) candidates.push(["HOLIDAY_SURCHARGE", rule.holidaySurchargeBps]);
  const best = candidates.sort((a, b) => b[1] - a[1])[0];
  if (best) push(best[0], applyBps(ride, best[1]));

  if (input.isAirport) push("AIRPORT_FEE", rule.airportFee);
  push("LUGGAGE", rule.luggagePerItem * Math.max(0, input.luggageCount - rule.freeLuggageItems));
  push("CHILD_SEAT", rule.childSeatFee * input.childSeats);
  if (input.meetAndGreet) push("MEET_AND_GREET", rule.meetAndGreetFee);
  const leadMinutes = (input.pickupAt.getTime() - input.requestedAt.getTime()) / 60_000;
  if (leadMinutes < rule.urgentThresholdMinutes) push("URGENT_FEE", rule.urgentFee);

  const raw = add(...lines.map((l) => l.amount));
  const total = roundToStep(raw, rule.roundingStep);
  if (total !== raw) lines.push({ code: "ROUNDING", amount: minor(total - raw) });
  if (total < 0) throw new MoneyError("Prix négatif");

  return { lines, total, ruleCategory: rule.vehicleCategory };
}

/**
 * Minutes d'attente entre l'arrivée du chauffeur (DRIVER_ARRIVED) et la prise
 * en charge (PASSENGER_ONBOARD), lues dans BookingStatusHistory côté serveur.
 * Seules les minutes entières écoulées comptent (12 min 59 s = 12 min).
 */
export function measureWaitingMinutes(arrivedAt: Date, onboardAt: Date): number {
  const ms = onboardAt.getTime() - arrivedAt.getTime();
  if (!Number.isFinite(ms) || ms < 0) throw new PricingError("Horodatage d'attente incohérent");
  return Math.floor(ms / 60_000);
}
