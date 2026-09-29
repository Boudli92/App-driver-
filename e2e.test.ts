/**
 * Parcours complet via HTTP réel : propriétaire, client, chauffeur, paiements.
 * Couvre les tests critiques du §65 au niveau de l'application (et pas seulement du domaine).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, one, all, type DB } from "../src/db/db.ts";
import { createApp } from "../src/app.ts";
import { NotificationService } from "../src/services/notify.ts";
import { RateLimiter, totp } from "../src/lib/security.ts";
import { createOwner } from "../src/services/users.ts";
import { DevMockProvider, DEV_WEBHOOK_SECRET } from "../src/payments/dev-mock.ts";
import { signStripePayload } from "../src/payments/stripe.ts";
import { zurichLocalToUtc } from "../src/lib/format.ts";
import type { Env } from "../src/config/env.ts";

let server: Server, db: DB, base = "", dir = "";

class Client {
  jar = new Map<string, string>();
  last = "";
  async req(method: string, path: string, form?: Record<string, string>) {
    const headers: Record<string, string> = { cookie: [...this.jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ") };
    let body: string | undefined;
    if (form) { headers["content-type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams({ _csrf: this.csrf(), ...form }).toString(); }
    const init: RequestInit = { method, headers, redirect: "manual" };
    if (body !== undefined) init.body = body;
    const res = await fetch(base + path, init);
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";"); const i = kv!.indexOf("=");
      const k = kv!.slice(0, i), v = decodeURIComponent(kv!.slice(i + 1));
      if (/Max-Age=0/.test(c)) this.jar.delete(k); else this.jar.set(k, v);
    }
    const text = await res.text();
    if (method === "GET") this.last = text;
    return { status: res.status, location: res.headers.get("location") ?? "", text, flash: this.jar.get("pdc_flash") ?? "" };
  }
  csrf(): string { return /name="_csrf" value="([^"]*)"/.exec(this.last)?.[1] ?? ""; }
  get(p: string) { return this.req("GET", p); }
  async post(p: string, form: Record<string, string>, from?: string) { if (from) await this.get(from); return this.req("POST", p, form); }
  async login(email: string, password: string) { await this.get("/login"); return this.req("POST", "/login", { email, password }); }
}

const env = (port: number): Env => ({
  nodeEnv: "test", isProd: false, isTest: true, port, appUrl: `http://127.0.0.1:${port}`, databasePath: ":memory:", authSecret: "x".repeat(40),
  stripeSecretKey: "", stripeWebhookSecret: "", stripeMethods: ["card", "twint"], trustProxy: false,
});

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "pdc-"));
  db = openDb(join(dir, "test.sqlite"));
  server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  const app = createApp({
    db, env: env(port), notifier: new NotificationService(db), payments: new DevMockProvider(base),
    limiter: { login: new RateLimiter(1000, 60_000), forms: new RateLimiter(10_000, 60_000), api: new RateLimiter(100_000, 60_000) },
  });
  server.on("request", (req, res) => { void app(req, res); });
  createOwner(db, { email: "owner@test.ch", password: "OwnerPass-2026", firstName: "Owner", lastName: "Test" });
});
after(() => { server.closeAllConnections(); server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

const owner = new Client(), alice = new Client(), bob = new Client(), driver = new Client(), anon = new Client();
let aliceId = "", driverId = "", vehicleId = "", bookingId = "";

test("Propriétaire : connexion + MFA obligatoire avant l'admin", async () => {
  const r = await owner.login("owner@test.ch", "OwnerPass-2026");
  assert.equal(r.location, "/login/mfa");
  const denied = await owner.get("/admin/drivers");
  assert.equal(denied.status, 303, "sans MFA, l'admin est inaccessible");
  await owner.get("/login/mfa");
  const secret = one<{ mfa_secret: string }>(db, "SELECT mfa_secret FROM users WHERE role = 'SUPER_ADMIN'")!.mfa_secret;
  const ok = await owner.req("POST", "/login/mfa/setup", { code: totp(secret) });
  assert.equal(ok.location, "/admin");
  assert.equal((await owner.get("/admin")).status, 200);
});

test("Invitation → demande d'adhésion → statut en attente, traçabilité du parrain", async () => {
  await owner.post("/admin/referrals", { email: "", campaign: "lancement", max_uses: "1" }, "/admin/referrals");
  const code = one<{ code: string }>(db, "SELECT code FROM invitations WHERE kind = 'CUSTOMER' ORDER BY created_at DESC")!.code;
  const page = await alice.get(`/invite/${code}`);
  assert.equal(page.status, 200);
  const r = await alice.req("POST", "/register", { code, first_name: "Alice", last_name: "Membre", email: "alice@test.ch", phone: "+41 79 111 11 11", password: "AlicePass-2026", accept: "yes" });
  assert.equal(r.status, 303);
  const u = one<{ id: string; status: string; invited_by: string; invitation_id: string }>(db, "SELECT id, status, invited_by, invitation_id FROM users WHERE email = 'alice@test.ch'")!;
  aliceId = u.id;
  assert.equal(u.status, "PENDING_APPROVAL");
  assert.ok(u.invited_by && u.invitation_id, "qui a invité, avec quel code : enregistré");
});

test("TEST 7 — client non approuvé : ne peut pas réserver", async () => {
  await alice.login("alice@test.ch", "AlicePass-2026");
  assert.equal((await alice.get("/app/book")).status, 403);
  const r = await alice.req("POST", "/app/book", { pickup: "Gare de Lausanne", dropoff: "Aéroport de Genève", when: "now", passengers: "1" });
  assert.equal(r.status, 403);
  assert.equal(one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM bookings")!.n, 0);
});

test("TEST 1 — un client ne peut pas créer de chauffeur", async () => {
  const r = await alice.req("POST", "/admin/drivers/new", { email: "x@test.ch", first_name: "X", last_name: "Y" });
  assert.equal(r.status, 403);
  assert.equal(one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM users WHERE role = 'DRIVER'")!.n, 0);
});

test("TEST 8 — le propriétaire approuve, le client peut réserver", async () => {
  await owner.post(`/admin/customers/${aliceId}/status`, { status: "APPROVED" }, `/admin/customers/${aliceId}`);
  assert.equal(one<{ status: string }>(db, "SELECT status FROM users WHERE id = ?", aliceId)!.status, "APPROVED");
  await alice.get("/app");
  const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  const r = await alice.post("/app/book", { pickup: "Gare de Lausanne", dropoff: "Rue du Lac 1, Vevey", when: "scheduled", pickup_local: `${tomorrow}T14:00`, passengers: "2", luggage: "1", payment_method: "CASH" }, "/app/book");
  assert.equal(r.status, 303);
  bookingId = one<{ id: string }>(db, "SELECT id FROM bookings WHERE customer_id = ?", aliceId)!.id;
  assert.equal(one<{ pickup_at: string }>(db, "SELECT pickup_at FROM bookings WHERE id = ?", bookingId)!.pickup_at, zurichLocalToUtc(`${tomorrow}T14:00`)!.toISOString());
});

test("Seul le propriétaire crée un chauffeur ; le chauffeur configure son compte ; activation", async () => {
  const r = await owner.post("/admin/drivers/new", { first_name: "Marc", last_name: "Chauffeur", email: "marc@test.ch", phone: "+41 79 222 22 22", license_number: "L1", license_expiry: "2030-01-01", hired_at: "2026-01-01" }, "/admin/drivers/new");
  const token = /\/setup\/([A-Za-z0-9_-]+)/.exec(r.flash)?.[1];
  assert.ok(token, "lien de configuration fourni au propriétaire");
  driverId = one<{ id: string }>(db, "SELECT id FROM users WHERE email = 'marc@test.ch'")!.id;
  await driver.post(`/setup/${token}`, { password: "MarcPass-2026" }, `/setup/${token}`);
  assert.equal(one<{ status: string }>(db, "SELECT status FROM users WHERE id = ?", driverId)!.status, "PENDING_SETUP");
  await owner.post(`/admin/drivers/${driverId}/status`, { status: "ACTIVE" }, `/admin/drivers/${driverId}`);
  assert.equal(one<{ status: string }>(db, "SELECT status FROM users WHERE id = ?", driverId)!.status, "ACTIVE");
  await driver.login("marc@test.ch", "MarcPass-2026");
});

test("TEST 2 — un chauffeur ne peut pas approuver un client", async () => {
  await driver.get("/driver");
  const r = await driver.req("POST", `/admin/customers/${aliceId}/status`, { status: "APPROVED" });
  assert.equal(r.status, 403);
});

test("TEST 3 — un client ne peut pas fixer le prix", async () => {
  await alice.get("/app");
  const r = await alice.req("POST", `/admin/bookings/${bookingId}/confirm`, { km: "0.1" });
  assert.equal(r.status, 403);
  assert.equal(one<{ quote_total: number | null }>(db, "SELECT quote_total FROM bookings WHERE id = ?", bookingId)!.quote_total, null);
});

test("Dispatch : véhicule, confirmation chiffrée, attribution", async () => {
  await owner.post("/admin/vehicles", { make: "Mercedes-Benz", model: "Classe E", plate: "VD 1", seats: "4", status: "AVAILABLE", mileage_km: "1000" }, "/admin/vehicles");
  vehicleId = one<{ id: string }>(db, "SELECT id FROM vehicles WHERE plate = 'VD 1'")!.id;
  await owner.post(`/admin/bookings/${bookingId}/confirm`, { km: "10" }, `/admin/bookings/${bookingId}`);
  assert.equal(one<{ quote_total: number }>(db, "SELECT quote_total FROM bookings WHERE id = ?", bookingId)!.quote_total, 2800); // 25.00 + 3.00
  await owner.post(`/admin/bookings/${bookingId}/assign`, { driver_id: driverId, vehicle_id: vehicleId }, `/admin/bookings/${bookingId}`);
  assert.equal(one<{ status: string }>(db, "SELECT status FROM bookings WHERE id = ?", bookingId)!.status, "ASSIGNED");
});

test("TEST 5 — course terminée en espèces : CA entreprise, part chauffeur 40 %, facture, cash", async () => {
  for (const a of ["accept", "arriving", "arrived"]) await driver.post(`/driver/trips/${bookingId}/${a}`, {}, `/driver/trips/${bookingId}`);
  // 25 minutes d'attente réelles : 10 offertes + 15 × 0.60 = 9.00
  db.prepare("UPDATE booking_status_history SET at = ? WHERE booking_id = ? AND to_status = 'DRIVER_ARRIVED'").run(new Date(Date.now() - 25 * 60_000 - 5000).toISOString(), bookingId);
  await driver.post(`/driver/trips/${bookingId}/onboard`, {}, `/driver/trips/${bookingId}`);
  const r = await driver.post(`/driver/trips/${bookingId}/complete`, { km: "10", cash: "" }, `/driver/trips/${bookingId}`);
  assert.equal(r.status, 303);
  const b = one<{ status: string; final_total: number; waiting_minutes: number }>(db, "SELECT status, final_total, waiting_minutes FROM bookings WHERE id = ?", bookingId)!;
  assert.equal(b.status, "COMPLETED");
  assert.equal(b.waiting_minutes, 25);
  assert.equal(b.final_total, 3700); // 25.00 + 3.00 + 9.00
  const e = one<{ gross_amount: number; driver_share_bps: number; driver_amount: number; company_amount: number }>(db, "SELECT * FROM driver_earnings WHERE booking_id = ?", bookingId)!;
  assert.deepEqual([e.gross_amount, e.driver_share_bps, e.driver_amount, e.company_amount], [3700, 4000, 1480, 2220]);
  assert.equal(one<{ status: string }>(db, "SELECT status FROM invoices WHERE booking_id = ?", bookingId)!.status, "PAID");
  const pay = one<{ method: string; amount: number; status: string }>(db, "SELECT method, amount, status FROM payments WHERE booking_id = ?", bookingId)!;
  assert.deepEqual([pay.method, pay.amount, pay.status], ["CASH", 3700, "PAID"]); // recette de l'entreprise
  assert.equal(one<{ status: string }>(db, "SELECT status FROM cash_transactions WHERE booking_id = ?", bookingId)!.status, "COLLECTED");
});

test("Clôture idempotente : un second envoi ne crée ni rémunération ni facture", async () => {
  await driver.req("POST", `/driver/trips/${bookingId}/complete`, { km: "10" });
  assert.equal(one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM driver_earnings WHERE booking_id = ?", bookingId)!.n, 1);
  assert.equal(one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM invoices WHERE booking_id = ?", bookingId)!.n, 1);
});

test("IDOR — un autre membre ne voit pas la course ni la facture d'Alice", async () => {
  await owner.post("/admin/referrals", { email: "", campaign: "", max_uses: "1" }, "/admin/referrals");
  const code = one<{ code: string }>(db, "SELECT code FROM invitations WHERE kind = 'CUSTOMER' AND uses = 0 ORDER BY created_at DESC")!.code;
  await bob.get(`/invite/${code}`);
  await bob.req("POST", "/register", { code, first_name: "Bob", last_name: "M", email: "bob@test.ch", phone: "+41 79 333 33 33", password: "BobPass-20266", accept: "yes" });
  const bobId = one<{ id: string }>(db, "SELECT id FROM users WHERE email = 'bob@test.ch'")!.id;
  await owner.post(`/admin/customers/${bobId}/status`, { status: "APPROVED" }, `/admin/customers/${bobId}`);
  await bob.login("bob@test.ch", "BobPass-20266");
  assert.equal((await bob.get(`/app/bookings/${bookingId}`)).status, 404);
  const inv = one<{ id: string }>(db, "SELECT id FROM invoices WHERE booking_id = ?", bookingId)!.id;
  assert.equal((await bob.get(`/app/invoices/${inv}`)).status, 404);
  assert.equal((await alice.get(`/app/invoices/${inv}`)).status, 200);
});

test("Le chauffeur ne voit que ses revenus ; pas les finances globales", async () => {
  const page = await driver.get("/driver/earnings");
  assert.equal(page.status, 200);
  assert.match(page.text, /CHF 14\.80/);
  assert.equal((await driver.get("/admin/finance")).status, 403);
});

test("TEST 4 — paiement en ligne : webhook reçu deux fois = une seule transaction", async () => {
  const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  await alice.post("/app/book", { pickup: "Place de la Gare, Lausanne", dropoff: "Ouchy, Lausanne", when: "scheduled", pickup_local: `${tomorrow}T10:00`, passengers: "1", payment_method: "ONLINE" }, "/app/book");
  const id = one<{ id: string }>(db, "SELECT id FROM bookings WHERE customer_id = ? AND payment_method = 'ONLINE'", aliceId)!.id;
  await owner.post(`/admin/bookings/${id}/confirm`, { km: "3" }, `/admin/bookings/${id}`);
  await owner.post(`/admin/bookings/${id}/assign`, { driver_id: driverId, vehicle_id: vehicleId }, `/admin/bookings/${id}`);
  for (const a of ["accept", "arriving", "arrived", "onboard"]) await driver.post(`/driver/trips/${id}/${a}`, {}, `/driver/trips/${id}`);
  await driver.post(`/driver/trips/${id}/complete`, { km: "3" }, `/driver/trips/${id}`);
  const inv = one<{ id: string; total: number; status: string }>(db, "SELECT id, total, status FROM invoices WHERE booking_id = ?", id)!;
  assert.equal(inv.total, 1500); // 7.50 + 3.00 → minimum 15.00
  assert.equal(inv.status, "ISSUED");

  const pay = await alice.post(`/app/invoices/${inv.id}/pay`, {}, `/app/invoices/${inv.id}`);
  assert.match(pay.location, /\/dev\/mock-checkout\/cs_dev_/);
  // Le retour navigateur seul ne vaut pas preuve de paiement.
  await alice.get(`/app/invoices/${inv.id}?paid=1`);
  assert.equal(one<{ status: string }>(db, "SELECT status FROM invoices WHERE id = ?", inv.id)!.status, "ISSUED");

  const ref = pay.location.split("/").at(-1)!;
  const body = JSON.stringify({ id: "evt_same", type: "checkout.session.completed", created: Math.floor(Date.now() / 1000), data: { object: { id: ref, payment_status: "paid", amount_total: 1500, payment_intent: "pi_1" } } });
  const send = () => fetch(`${base}/webhooks/stripe`, { method: "POST", headers: { "stripe-signature": signStripePayload(DEV_WEBHOOK_SECRET, body) }, body }).then((r) => r.json() as Promise<{ result: string }>);
  assert.equal((await send()).result, "processed");
  assert.equal((await send()).result, "duplicate");
  assert.equal(one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM payment_events WHERE provider_event_id = 'evt_same'")!.n, 1);
  assert.equal(one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM payments WHERE invoice_id = ? AND status = 'PAID'", inv.id)!.n, 1);
  assert.equal(one<{ status: string }>(db, "SELECT status FROM invoices WHERE id = ?", inv.id)!.status, "PAID");

  const forged = await fetch(`${base}/webhooks/stripe`, { method: "POST", headers: { "stripe-signature": signStripePayload("whsec_wrong", body) }, body });
  assert.equal(forged.status, 400, "signature invalide refusée");
});

test("TEST 6 — taux 40 % → 45 % : l'historique conserve son taux", async () => {
  await owner.post("/admin/settings/share", { share: "45", confirm: "yes" }, "/admin/settings");
  const rates = all<{ driver_share_bps: number }>(db, "SELECT driver_share_bps FROM driver_earnings");
  assert.ok(rates.length === 2 && rates.every((x) => x.driver_share_bps === 4000));
  assert.throws(() => db.prepare("UPDATE driver_earnings SET driver_share_bps = 4500").run(), /immutable/);
  const log = one<{ metadata: string }>(db, "SELECT metadata FROM audit_log WHERE action = 'SETTINGS_UPDATED' AND resource_id = 'driver_share_bps'")!;
  assert.deepEqual(JSON.parse(log.metadata), { before: 4000, after: 4500 });
});

test("Remboursement partiel : idempotent, audité, facture mise à jour", async () => {
  const p = one<{ id: string }>(db, "SELECT id FROM payments WHERE booking_id = ? AND method = 'CASH'", bookingId)!;
  await owner.post(`/admin/payments/${p.id}/refund`, { amount: "5.00", reason: "Geste commercial", confirm: "yes" }, `/admin/payments/${p.id}/refund`);
  const pay = one<{ refunded_amount: number; status: string }>(db, "SELECT refunded_amount, status FROM payments WHERE id = ?", p.id)!;
  assert.deepEqual([pay.refunded_amount, pay.status], [500, "PARTIALLY_REFUNDED"]);
  assert.equal(one<{ status: string }>(db, "SELECT status FROM invoices WHERE booking_id = ?", bookingId)!.status, "PARTIALLY_REFUNDED");
  assert.ok(one(db, "SELECT id FROM audit_log WHERE action = 'REFUND_CREATED'"));
});

test("Cash : rapprochement par le propriétaire", async () => {
  const c = one<{ id: string }>(db, "SELECT id FROM cash_transactions WHERE booking_id = ?", bookingId)!;
  await owner.post(`/admin/cash/${c.id}`, { outcome: "RECONCILED", note: "" }, "/admin/payments");
  assert.equal(one<{ status: string }>(db, "SELECT status FROM cash_transactions WHERE id = ?", c.id)!.status, "RECONCILED");
});

test("Audit en ajout seul ; CSRF obligatoire ; pages privées non indexées", async () => {
  assert.throws(() => db.prepare("DELETE FROM audit_log").run(), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM invoices").run(), /cannot be deleted/);
  const noCsrf = await fetch(`${base}/admin/settings/share`, { method: "POST", headers: { cookie: `pdc_session=${owner.jar.get("pdc_session")}`, "content-type": "application/x-www-form-urlencoded" }, body: "share=90&confirm=yes", redirect: "manual" });
  assert.equal(noCsrf.status, 403);
  assert.match((await owner.get("/admin")).text, /noindex/);
  const robots = await (await fetch(`${base}/robots.txt`)).text();
  assert.match(robots, /Disallow: \/admin/);
});

test("Pages principales : rendu sans erreur pour chaque rôle", async () => {
  for (const p of ["/admin", "/admin/bookings", "/admin/dispatch", "/admin/customers", "/admin/drivers", "/admin/vehicles", "/admin/payments", "/admin/invoices",
    "/admin/finance", "/admin/referrals", "/admin/documents", "/admin/support", "/admin/audit", "/admin/settings", "/admin/search?q=Alice", `/admin/bookings/${bookingId}`,
    `/admin/drivers/${driverId}`, `/admin/customers/${aliceId}`, "/admin/export/finance", "/admin/finance/print"]) {
    assert.equal((await owner.get(p)).status, 200, p);
  }
  for (const p of ["/app", "/app/bookings", "/app/invoices", "/app/referrals", "/app/profile", "/app/support", "/app/profile/export"]) assert.equal((await alice.get(p)).status, 200, p);
  for (const p of ["/driver", "/driver/trips", "/driver/earnings", "/driver/profile", "/driver/support"]) assert.equal((await driver.get(p)).status, 200, p);
  for (const p of ["/", "/membership", "/terms", "/privacy", "/cookies", "/legal", "/contact", "/sitemap.xml"]) assert.equal((await anon.get(p)).status, 200, p);
});

test("Anti-escalade : aucun second SUPER_ADMIN possible", () => {
  assert.throws(() => createOwner(db, { email: "evil@test.ch", password: "EvilPass-2026", firstName: "E", lastName: "V" }), /existe déjà/);
  assert.throws(() => db.prepare("UPDATE users SET role = 'SUPER_ADMIN' WHERE email = 'alice@test.ch'").run(), /UNIQUE/);
});
