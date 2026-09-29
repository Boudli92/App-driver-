import { createHmac } from "node:crypto";
import type {
  PaymentProvider, CreatePaymentRequest, CreatePaymentResult, PaymentStatus, VerifiedWebhookEvent,
} from "../domain/payments/payments.ts";
import { minor, type Minor } from "../domain/money/money.ts";
import { safeEqual } from "../lib/security.ts";

/**
 * Adaptateur Stripe (Checkout hébergé) : cartes + TWINT (compte Stripe suisse,
 * TWINT à activer dans le tableau de bord Stripe). Aucune donnée carte ne
 * transite par nos serveurs. Le statut « payé » n'est accepté que via webhook signé.
 * Documentation : https://docs.stripe.com/api/checkout/sessions
 */
export class StripeProvider implements PaymentProvider {
  readonly name = "stripe";
  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly methods: string[];
  private readonly toleranceSec = 300;

  constructor(secretKey: string, webhookSecret: string, methods: string[]) {
    if (!secretKey || !webhookSecret) throw new Error("Stripe : STRIPE_SECRET_KEY et STRIPE_WEBHOOK_SECRET sont requis.");
    this.secretKey = secretKey; this.webhookSecret = webhookSecret; this.methods = methods;
  }

  private async call(method: "GET" | "POST", path: string, params?: URLSearchParams, idempotencyKey?: string): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.secretKey}` };
    if (params) headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(15_000) };
    if (params) init.body = params.toString();
    const res = await fetch(`https://api.stripe.com/v1${path}`, init);
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const err = (json.error ?? {}) as { message?: string; code?: string };
      throw new Error(`Stripe ${res.status}: ${err.code ?? ""} ${err.message ?? "erreur inconnue"}`);
    }
    return json;
  }

  async createPayment(req: CreatePaymentRequest & { description?: string; cancelUrl?: string; customerEmail?: string; reference?: string }): Promise<CreatePaymentResult> {
    const p = new URLSearchParams();
    p.set("mode", "payment");
    p.set("success_url", req.returnUrl);
    p.set("cancel_url", req.cancelUrl ?? req.returnUrl);
    p.set("client_reference_id", req.reference ?? req.bookingId);
    if (req.customerEmail) p.set("customer_email", req.customerEmail);
    p.set("line_items[0][quantity]", "1");
    p.set("line_items[0][price_data][currency]", req.currency.toLowerCase());
    p.set("line_items[0][price_data][unit_amount]", String(req.amount));
    p.set("line_items[0][price_data][product_data][name]", req.description ?? "Course");
    this.methods.forEach((m, i) => p.set(`payment_method_types[${i}]`, m));
    p.set("metadata[booking_id]", req.bookingId);
    p.set("payment_intent_data[metadata][booking_id]", req.bookingId);
    const s = await this.call("POST", "/checkout/sessions", p, req.idempotencyKey);
    return { providerPaymentId: String(s.id), redirectUrl: String(s.url) };
  }

  async authorizePayment(providerPaymentId: string): Promise<PaymentStatus> {
    return this.getPaymentStatus(providerPaymentId); // Checkout capture automatiquement.
  }

  async capturePayment(providerPaymentId: string): Promise<PaymentStatus> {
    return this.getPaymentStatus(providerPaymentId);
  }

  async refundPayment(providerChargeRef: string, amount: Minor, idempotencyKey: string): Promise<{ providerRefundId: string }> {
    const p = new URLSearchParams({ payment_intent: providerChargeRef, amount: String(amount) });
    const r = await this.call("POST", "/refunds", p, idempotencyKey);
    return { providerRefundId: String(r.id) };
  }

  async getPaymentStatus(providerPaymentId: string): Promise<PaymentStatus> {
    const s = await this.call("GET", `/checkout/sessions/${encodeURIComponent(providerPaymentId)}`);
    if (s.payment_status === "paid") return "PAID";
    if (s.status === "expired") return "CANCELLED";
    return "PENDING";
  }

  /** Vérifie l'en-tête Stripe-Signature (HMAC-SHA256 de "t.payload") et la fraîcheur. */
  async handleWebhook(rawBody: string, headers: Record<string, string>): Promise<VerifiedWebhookEvent> {
    const header = headers["stripe-signature"] ?? "";
    const items = header.split(",").map((kv) => kv.split("=") as [string, string]);
    const t = items.find(([k]) => k === "t")?.[1];
    const sigs = items.filter(([k]) => k === "v1").map(([, v]) => v);
    if (!t || sigs.length === 0) throw new WebhookError("Signature absente");
    if (Math.abs(Date.now() / 1000 - Number(t)) > this.toleranceSec) throw new WebhookError("Horodatage hors tolérance (replay ?)");
    const expected = createHmac("sha256", this.webhookSecret).update(`${t}.${rawBody}`).digest("hex");
    if (!sigs.some((s) => safeEqual(s, expected))) throw new WebhookError("Signature invalide");

    const evt = JSON.parse(rawBody) as { id: string; type: string; created: number; data: { object: Record<string, unknown> } };
    const obj = evt.data.object;
    const typeMap: Record<string, VerifiedWebhookEvent["type"] | undefined> = {
      "checkout.session.completed": obj.payment_status === "paid" ? "CAPTURED" : "AUTHORIZED",
      "checkout.session.async_payment_succeeded": "CAPTURED",
      "checkout.session.async_payment_failed": "FAILED",
      "checkout.session.expired": "CANCELLED",
    };
    const type = typeMap[evt.type];
    if (!type) throw new IgnoredEvent(evt.type);
    const ev: VerifiedWebhookEvent = {
      providerEventId: evt.id, providerPaymentId: String(obj.id), type,
      amount: minor(Number(obj.amount_total ?? 0)), occurredAt: new Date(evt.created * 1000),
    };
    if (typeof obj.payment_intent === "string") ev.providerChargeRef = obj.payment_intent;
    return ev;
  }
}

export class WebhookError extends Error {}
export class IgnoredEvent extends Error {}

/** Signature au format Stripe — utilisée par le simulateur DEV et les tests. */
export function signStripePayload(secret: string, payload: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
}
