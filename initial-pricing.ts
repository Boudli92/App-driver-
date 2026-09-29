import { minor } from "../domain/money/money.ts";
import type { PricingRule } from "../domain/pricing/pricing.ts";

/**
 * Tarif initial communiqué par le propriétaire. Sert UNIQUEMENT à créer la
 * première PricingRule en base ; ensuite, toute modification passe par
 * /admin/settings (SUPER_ADMIN + audit), jamais par le code.
 *
 * Confirmé :   CHF 2.50 / km de jour, CHF 2.75 / km de nuit (21h00–06h00,
 *              heure de Zurich, selon l'heure de prise en charge).
 *              Minimum : CHF 15.00 jour, CHF 20.00 nuit (quelle que soit la distance).
 *              Prise en charge : CHF 3.00 comptée sur chaque course ; le
 *              minimum s'applique au total (km + 3.00), donc les 3.00 sont
 *              inclus dans les 15.00 / 20.00. Pas de saut de prix au seuil.
 *              Attente : CHF 0.60/min jour, CHF 0.75/min nuit, 10 premières
 *              minutes offertes dès
 *              l'arrivée du chauffeur, facturée en plus du minimum.
 *              Aucun supplément (aéroport, siège enfant, bagages) : tous à 0,
 *              options masquées dans le formulaire de réservation.
 */
export const INITIAL_PRICING_RULE: PricingRule = {
  vehicleCategory: "STANDARD",
  baseFare: minor(300),
  waiveBaseFareAtMinimum: false,
  perKm: minor(250),
  nightPerKm: minor(275),
  perMinute: minor(0),
  minimumFare: minor(1500),
  nightMinimumFare: minor(2000),
  waitingPerMinute: minor(60),
  nightWaitingPerMinute: minor(75),
  freeWaitingMinutes: 10,
  nightSurchargeBps: 0,
  nightStartHour: 21,
  nightEndHour: 6,
  weekendSurchargeBps: 0,
  holidaySurchargeBps: 0,
  airportFee: minor(0),
  luggagePerItem: minor(0),
  freeLuggageItems: 0,
  childSeatFee: minor(0),
  meetAndGreetFee: minor(0),
  urgentFee: minor(0),
  urgentThresholdMinutes: 0,
  roundingStep: 5,
};
