import { test } from "node:test";
import assert from "node:assert/strict";
import { minor, format } from "../src/domain/money/money.ts";
import { computeEarningSnapshot, resolveDriverShareBps } from "../src/domain/earnings/earnings.ts";
import { authorize, authorizeBookingRead, authorizeRoleChange, AuthorizationError, type Actor } from "../src/domain/auth/rbac.ts";
import { transition, InvalidTransitionError } from "../src/domain/bookings/booking-state.ts";
import { quote, measureWaitingMinutes, PricingError, type PricingInput } from "../src/domain/pricing/pricing.ts";
import { INITIAL_PRICING_RULE } from "../src/config/initial-pricing.ts";
import { processWebhook, type PaymentProvider, type PaymentEventStore, type PaymentStatus } from "../src/domain/payments/payments.ts";
import { checkReferral, normalizeEmail } from "../src/domain/referrals/referral-guard.ts";
import { DEFAULTS, MARKETPLACE_MODE } from "../src/config/defaults.ts";

const admin: Actor = { userId: "owner", role: "SUPER_ADMIN", mfaVerified: true };
const driver: Actor = { userId: "d1", role: "DRIVER", driverStatus: "ACTIVE" };
const approved: Actor = { userId: "c1", role: "CUSTOMER", customerStatus: "APPROVED" };
const pending: Actor = { userId: "c2", role: "CUSTOMER", customerStatus: "PENDING_APPROVAL" };
const forbidden = (fn: () => void) => assert.throws(fn, (e: unknown) => e instanceof AuthorizationError && e.status === 403);

test("TEST 1 — un CUSTOMER ne peut pas créer de chauffeur (403)", () => forbidden(() => authorize(approved, "driver:create")));
test("TEST 2 — un DRIVER ne peut pas approuver un client (403)", () => forbidden(() => authorize(driver, "customer:approve")));
test("TEST 3 — un CUSTOMER ne peut pas fixer le prix (403)", () => forbidden(() => authorize(approved, "booking:set_price")));

test("TEST 4 — webhook reçu deux fois = une seule transaction", async () => {
  const seen = new Set<string>(); const applied: PaymentStatus[] = [];
  const store: PaymentEventStore = {
    async insertEventIfAbsent(p, ev) { const k = `${p}:${ev.providerEventId}`; if (seen.has(k)) return false; seen.add(k); return true; },
    async applyStatus(_id, s) { applied.push(s); },
  };
  const provider = { name: "dev-mock", async handleWebhook() {
    return { providerEventId: "evt_1", providerPaymentId: "pay_1", type: "CAPTURED" as const, amount: minor(10000), occurredAt: new Date() };
  } } as unknown as PaymentProvider;
  assert.equal(await processWebhook(provider, store, "{}", {}), "processed");
  assert.equal(await processWebhook(provider, store, "{}", {}), "duplicate");
  assert.deepEqual(applied, ["PAID"]);
});

test("TEST 5 — course CHF 100 : entreprise 100, chauffeur 40, part entreprise 60", () => {
  const s = computeEarningSnapshot(minor(10000), DEFAULTS.driverShareBps);
  assert.deepEqual({ ...s }, { grossAmount: 10000, driverShareBps: 4000, driverAmount: 4000, companyAmount: 6000 });
});

test("TEST 6 — passage 40 % → 45 % : l'historique garde son taux", () => {
  const history = computeEarningSnapshot(minor(10000), resolveDriverShareBps({ defaultBps: 4000 }, "d1"));
  const later = computeEarningSnapshot(minor(10000), resolveDriverShareBps({ defaultBps: 4500 }, "d1"));
  assert.equal(history.driverAmount, 4000);
  assert.equal(history.driverShareBps, 4000);
  assert.equal(later.driverAmount, 4500);
  assert.ok(Object.isFrozen(history));
});

test("TEST 7 — invité non approuvé ne peut pas réserver", () => forbidden(() => authorize(pending, "booking:create")));
test("TEST 8 — après approbation, le client peut réserver", () => {
  assert.doesNotThrow(() => authorize({ ...pending, customerStatus: "APPROVED" }, "booking:create"));
});

test("Arrondi : chauffeur + entreprise = brut, au centime", () => {
  for (const g of [1, 3, 99, 1645, 12345, 999999]) for (const bps of [4000, 4200, 4250, 4500]) {
    const s = computeEarningSnapshot(minor(g), bps);
    assert.equal(s.driverAmount + s.companyAmount, g);
  }
});

test("IDOR — un client ne lit pas la course d'un autre", () => {
  forbidden(() => authorizeBookingRead(approved, { customerId: "c9", assignedDriverId: null }));
  forbidden(() => authorizeBookingRead(driver, { customerId: "c1", assignedDriverId: "d2" }));
});

test("Escalade — pas de changement de son propre rôle, SUPER_ADMIN non attribuable", () => {
  forbidden(() => authorizeRoleChange(admin, "owner", "DRIVER"));
  forbidden(() => authorizeRoleChange(admin, "u2", "SUPER_ADMIN"));
  forbidden(() => authorizeRoleChange(approved, "c1", "SUPER_ADMIN"));
});

test("SUPER_ADMIN sans MFA vérifiée est refusé", () => forbidden(() => authorize({ ...admin, mfaVerified: false }, "driver:create")));
test("MARKETPLACE_MODE est désactivé", () => assert.equal(MARKETPLACE_MODE, false));

test("Workflow : un chauffeur ne peut pas sauter d'étape ni terminer une course non démarrée", () => {
  assert.equal(transition("ASSIGNED", "DRIVER_ACCEPTED", "DRIVER"), "DRIVER_ACCEPTED");
  assert.throws(() => transition("DRIVER_ARRIVED", "COMPLETED", "DRIVER"), InvalidTransitionError);
  assert.throws(() => transition("CONFIRMED", "ASSIGNED", "DRIVER"), InvalidTransitionError);
  assert.throws(() => transition("COMPLETED", "IN_PROGRESS", "CUSTOMER"), InvalidTransitionError);
});

// --- Tarif du propriétaire : CHF 2.50/km jour, CHF 2.75/km nuit (21h–6h) -------------
const ride = (pickupIsoUtc: string, meters: number): PricingInput => {
  const pickupAt = new Date(pickupIsoUtc);
  return {
    vehicleCategory: "STANDARD", distanceMeters: meters, durationSeconds: 900,
    pickupAt, requestedAt: new Date(pickupAt.getTime() - 86_400_000),
    timezone: "Europe/Zurich", holidays: [], isAirport: false, luggageCount: 0,
    childSeats: 0, meetAndGreet: false, waitingMinutes: 0,
  };
};

test("Tarif jour : 10 km à 14h00 (Zurich) = 25.00 + 3.00 = CHF 28.00", () => {
  const q = quote(INITIAL_PRICING_RULE, ride("2026-10-06T12:00:00Z", 10_000));
  assert.equal(q.total, 2800);
  assert.equal(format(q.total), "CHF 28.00");
});

test("Tarif nuit : 10 km à 23h00 (Zurich) = 27.50 + 3.00 = CHF 30.50", () => {
  const q = quote(INITIAL_PRICING_RULE, ride("2026-10-06T21:00:00Z", 10_000));
  assert.equal(q.total, 3050);
  assert.ok(q.lines.some((l) => l.code === "DISTANCE_NIGHT"));
});

test("Bascule jour/nuit : 20h59 jour, 21h00 nuit, 05h59 nuit, 06h00 jour", () => {
  const km = (iso: string) => quote(INITIAL_PRICING_RULE, ride(iso, 1000)).lines[0]?.code;
  assert.equal(km("2026-10-06T18:59:00Z"), "DISTANCE");
  assert.equal(km("2026-10-06T19:00:00Z"), "DISTANCE_NIGHT");
  assert.equal(km("2026-10-07T03:59:00Z"), "DISTANCE_NIGHT");
  assert.equal(km("2026-10-07T04:00:00Z"), "DISTANCE");
});

test("Heure d'hiver prise en compte : 23h00 le 6 janvier = 22:00Z", () => {
  assert.equal(quote(INITIAL_PRICING_RULE, ride("2027-01-06T22:00:00Z", 10_000)).total, 3050);
  // 20h30 en hiver = 19:30Z → encore jour
  assert.equal(quote(INITIAL_PRICING_RULE, ride("2027-01-06T19:30:00Z", 10_000)).total, 2800);
});

test("Arrondi aux 5 centimes : 7,33 km de jour = 18.33 + 3.00 → CHF 21.35", () => {
  const q = quote(INITIAL_PRICING_RULE, ride("2026-10-06T12:00:00Z", 7_330));
  assert.equal(q.total, 2135); // 18.325 → 18.33 + 3.00 = 21.33 → 21.35
});

test("Minimum de course : CHF 15.00 le jour, quelle que soit la distance", () => {
  const day = (m: number) => quote(INITIAL_PRICING_RULE, ride("2026-10-06T12:00:00Z", m)).total;
  assert.equal(day(2_000), 1500);  // 2 km = 5.00 + 3.00 = 8.00 → minimum 15.00
  assert.equal(day(6_000), 1800);  // 6 km = 15.00 + 3.00
  assert.equal(day(7_000), 2050);  // 7 km = 17.50 + prise en charge 3.00
});

test("Minimum de course : CHF 20.00 la nuit, quelle que soit la distance", () => {
  const night = (m: number) => quote(INITIAL_PRICING_RULE, ride("2026-10-06T21:00:00Z", m)).total;
  assert.equal(night(2_000), 2000); // 2 km = 5.50 + 3.00 → minimum 20.00
  assert.equal(night(8_000), 2500); // 8 km = 22.00 + prise en charge 3.00
});

test("Aucun supplément : aéroport, siège enfant, bagages ne changent pas le prix", () => {
  const base = ride("2026-10-06T12:00:00Z", 10_000);
  const withOptions = { ...base, isAirport: true, childSeats: 2, luggageCount: 4, meetAndGreet: true };
  assert.equal(quote(INITIAL_PRICING_RULE, withOptions).total, quote(INITIAL_PRICING_RULE, base).total);
});

test("Attente : 10 premières minutes offertes, puis CHF 0.60/min", () => {
  const wait = (min: number) => quote(INITIAL_PRICING_RULE, { ...ride("2026-10-06T12:00:00Z", 10_000), waitingMinutes: min }).total;
  assert.equal(wait(0), 2800);
  assert.equal(wait(10), 2800);  // offertes
  assert.equal(wait(11), 2860);  // 1 min × 0.60
  assert.equal(wait(25), 3700);  // 15 min × 0.60 = 9.00
});

test("Attente facturée en plus du minimum (2 km jour + 25 min = 15.00 + 9.00)", () => {
  const q = quote(INITIAL_PRICING_RULE, { ...ride("2026-10-06T12:00:00Z", 2_000), waitingMinutes: 25 });
  assert.equal(q.total, 2400);
  const qn = quote(INITIAL_PRICING_RULE, { ...ride("2026-10-06T21:00:00Z", 2_000), waitingMinutes: 25 });
  assert.equal(qn.total, 3125); // nuit : 20.00 + 15 min × 0.75 = 11.25
});

test("Mesure de l'attente : minutes entières depuis l'arrivée du chauffeur", () => {
  const arrived = new Date("2026-10-06T12:00:00Z");
  assert.equal(measureWaitingMinutes(arrived, new Date("2026-10-06T12:12:59Z")), 12);
  assert.throws(() => measureWaitingMinutes(arrived, new Date("2026-10-06T11:59:00Z")), PricingError);
});

test("Prise en charge CHF 3.00 incluse dans le minimum, sans saut au seuil", () => {
  const day = (m: number) => quote(INITIAL_PRICING_RULE, ride("2026-10-06T12:00:00Z", m)).total;
  const night = (m: number) => quote(INITIAL_PRICING_RULE, ride("2026-10-06T21:00:00Z", m)).total;
  assert.equal(day(2_000), 1500);   // 5.00 + 3.00 → minimum 15.00
  assert.equal(day(4_800), 1500);   // 12.00 + 3.00 = 15.00 pile
  assert.equal(day(4_840), 1510);   // 12.10 + 3.00 = 15.10 : +10 ct, pas de saut
  assert.equal(night(6_180), 2000); // 17.00 + 3.00 = 20.00 pile
  assert.equal(night(6_200), 2005); // 17.05 + 3.00 = 20.05
});

test("Attente de nuit : 10 min offertes puis CHF 0.75/min", () => {
  const wait = (min: number) => quote(INITIAL_PRICING_RULE, { ...ride("2026-10-06T21:00:00Z", 10_000), waitingMinutes: min }).total;
  assert.equal(wait(10), 3050);  // offertes
  assert.equal(wait(11), 3125);  // + 0.75
  assert.equal(wait(30), 4550);  // 20 min × 0.75 = 15.00
});

test("Parrainage : auto-parrainage bloqué, alias +tag normalisés", () => {
  assert.equal(normalizeEmail(" Jean+promo@Mail.CH "), "jean@mail.ch");
  const r = checkReferral({ inviterUserId: "c1", inviterEmailHash: "h", inviterPhoneHash: null, inviteeEmailHash: "h",
    inviteePhoneHash: null, inviterInvitationsLast30Days: 0, maxInvitationsPer30Days: 10, existingAccountsWithSameSignals: 0 });
  assert.deepEqual(r, { ok: false, reason: "self_referral" });
});
