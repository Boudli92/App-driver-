import type { Router } from "../lib/http.ts";
import { send, HttpError } from "../lib/http.ts";
import { html } from "../lib/html.ts";
import { layout, money } from "../ui/layout.ts";
import type { Deps } from "../app.ts";
import { one } from "../db/db.ts";
import { applyPaymentEvent } from "../services/payments.ts";
import { audit, SYSTEM } from "../services/audit.ts";
import { WebhookError, IgnoredEvent, signStripePayload } from "../payments/stripe.ts";
import { DEV_WEBHOOK_SECRET } from "../payments/dev-mock.ts";
import { newId } from "../lib/security.ts";

export function registerWebhooks(r: Router, d: Deps): void {
  /** Webhook PSP : seule preuve de paiement acceptée (§20, §133). */
  r.post("/webhooks/stripe", async (ctx) => {
    if (!d.payments) throw new HttpError(404, "Paiement en ligne non configuré");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(ctx.req.headers)) if (typeof v === "string") headers[k.toLowerCase()] = v;
    try {
      const ev = await d.payments.handleWebhook(ctx.rawBody, headers);
      const result = applyPaymentEvent(d.db, d.payments.name, ev, ctx.rawBody, d.notifier);
      send(ctx, 200, JSON.stringify({ received: true, result }), "application/json");
    } catch (e) {
      if (e instanceof IgnoredEvent) { send(ctx, 200, JSON.stringify({ received: true, ignored: e.message }), "application/json"); return; }
      if (e instanceof WebhookError) {
        audit(d.db, SYSTEM, "WEBHOOK_REJECTED", "payment", null, "DENIED", { reason: e.message });
        send(ctx, 400, JSON.stringify({ error: "invalid signature" }), "application/json"); return;
      }
      throw e;
    }
  });

  // Simulateur de paiement : DÉVELOPPEMENT uniquement, jamais monté en production.
  if (d.env.isProd) return;
  r.get("/dev/mock-checkout/:ref", (ctx) => {
    const p = one<{ amount: number; invoice_id: string }>(d.db, "SELECT amount, invoice_id FROM payments WHERE provider_ref = ?", ctx.params.ref!);
    if (!p) throw new HttpError(404, "Paiement inconnu");
    send(ctx, 200, layout(ctx, "Simulateur de paiement", html`<div class="card gold"><p class="eyebrow">Environnement de développement</p><h1>Simulateur de paiement</h1>
      <p>Montant : ${money(p.amount)}. Aucun paiement réel.</p>
      <form method="post" action="/dev/mock-checkout/${ctx.params.ref!}"><input type="hidden" name="_csrf" value="${ctx.session?.csrf ?? ""}">
      <div class="row"><button class="btn btn-primary" name="result" value="paid" type="submit">Simuler un paiement réussi</button>
      <button class="btn btn-danger" name="result" value="failed" type="submit">Simuler un échec</button></div></form></div>`));
  });
  r.post("/dev/mock-checkout/:ref", async (ctx) => {
    const p = one<{ amount: number; invoice_id: string }>(d.db, "SELECT amount, invoice_id FROM payments WHERE provider_ref = ?", ctx.params.ref!);
    if (!p) throw new HttpError(404, "Paiement inconnu");
    const paid = ctx.form.get("result") === "paid";
    const body = JSON.stringify({ id: `evt_dev_${newId()}`, type: paid ? "checkout.session.completed" : "checkout.session.async_payment_failed", created: Math.floor(Date.now() / 1000),
      data: { object: { id: ctx.params.ref!, payment_status: paid ? "paid" : "unpaid", amount_total: p.amount, payment_intent: `pi_dev_${newId()}` } } });
    // Passe par le vrai endpoint webhook, avec une vraie signature au format Stripe.
    const res = await fetch(`http://127.0.0.1:${d.env.port}/webhooks/stripe`, { method: "POST", headers: { "stripe-signature": signStripePayload(DEV_WEBHOOK_SECRET, body), "content-type": "application/json" }, body });
    if (!res.ok) throw new HttpError(502, "Webhook de simulation refusé");
    ctx.res.statusCode = 303; ctx.res.setHeader("Location", `/app/invoices/${p.invoice_id}?paid=1`); ctx.res.end();
  });
}
