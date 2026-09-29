import { type DB, one, run, tx } from "../db/db.ts";
import { newId } from "../lib/security.ts";
import type { PaymentProvider, VerifiedWebhookEvent } from "../domain/payments/payments.ts";
import { minor, format } from "../domain/money/money.ts";
import { audit, type AuditActor, SYSTEM } from "./audit.ts";
import { DomainError } from "./users.ts";
import { getBooking, moveStatus } from "./bookings.ts";
import type { NotificationService } from "./notify.ts";

const now = () => new Date().toISOString();

interface InvoiceRow { id: string; number: string; booking_id: string; customer_id: string; total: number; status: string; refunded_amount: number }
interface PaymentRow { id: string; booking_id: string; invoice_id: string | null; method: string; provider: string; provider_ref: string | null; provider_charge_ref: string | null; amount: number; refunded_amount: number; status: string }

/** Démarre un paiement en ligne (carte / TWINT) pour une facture du client. */
export async function startOnlinePayment(db: DB, provider: PaymentProvider, actor: AuditActor & { email: string }, invoiceId: string, appUrl: string): Promise<string> {
  const inv = one<InvoiceRow>(db, "SELECT * FROM invoices WHERE id = ?", invoiceId);
  if (!inv || inv.customer_id !== actor.id) throw new DomainError("Facture introuvable.", 404);
  if (inv.status !== "ISSUED") throw new DomainError("Cette facture n'est pas en attente de paiement.", 409);
  const attempt = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM payments WHERE invoice_id = ?", invoiceId)!.n + 1;
  if (attempt > 20) throw new DomainError("Trop de tentatives. Contactez-nous.", 429);
  const paymentId = newId(), key = `online:${invoiceId}:${attempt}`;
  run(db, `INSERT INTO payments (id, booking_id, invoice_id, method, provider, amount, status, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, 'ONLINE', ?, ?, 'PENDING', ?, ?, ?)`, paymentId, inv.booking_id, inv.id, provider.name, inv.total, key, now(), now());
  try {
    const res = await provider.createPayment({
      bookingId: inv.booking_id, amount: minor(inv.total), currency: "CHF", method: "CARD", idempotencyKey: key,
      returnUrl: `${appUrl}/app/invoices/${inv.id}?paid=1`,
      ...({ cancelUrl: `${appUrl}/app/invoices/${inv.id}`, description: `Facture ${inv.number}`, customerEmail: actor.email, reference: inv.id } as object),
    });
    run(db, "UPDATE payments SET provider_ref = ?, checkout_url = ?, updated_at = ? WHERE id = ?", res.providerPaymentId, res.redirectUrl ?? null, now(), paymentId);
    audit(db, actor, "PAYMENT_STARTED", "payment", paymentId, "SUCCESS", { invoice: inv.number, amount: inv.total });
    if (!res.redirectUrl) throw new DomainError("Le prestataire n'a pas fourni de page de paiement.");
    return res.redirectUrl;
  } catch (e) {
    run(db, "UPDATE payments SET status = 'FAILED', updated_at = ? WHERE id = ?", now(), paymentId);
    audit(db, actor, "PAYMENT_START_FAILED", "payment", paymentId, "FAILURE", { error: e instanceof Error ? e.message.slice(0, 200) : "?" });
    if (e instanceof DomainError) throw e;
    throw new DomainError("Nous n'avons pas pu ouvrir la page de paiement. Aucun montant n'a été débité. Réessayez dans un instant.", 502);
  }
}

/**
 * Applique un événement de webhook vérifié. Idempotent : l'unicité
 * (provider, provider_event_id) garantit qu'un événement rejoué n'a aucun effet.
 */
export function applyPaymentEvent(db: DB, provider: string, ev: VerifiedWebhookEvent, rawBody: string, notifier?: NotificationService): "processed" | "duplicate" | "unknown_payment" {
  return tx(db, () => {
    const ins = db.prepare(`INSERT OR IGNORE INTO payment_events (id, provider, provider_event_id, type, payload, received_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(newId(), provider, ev.providerEventId, ev.type, rawBody.slice(0, 20_000), now());
    if (Number(ins.changes) === 0) return "duplicate";
    const p = one<PaymentRow>(db, "SELECT * FROM payments WHERE provider = ? AND provider_ref = ?", provider, ev.providerPaymentId);
    if (!p) { audit(db, SYSTEM, "WEBHOOK_UNKNOWN_PAYMENT", "payment", null, "FAILURE", { ref: ev.providerPaymentId }); return "unknown_payment"; }
    if (["PAID", "REFUNDED", "PARTIALLY_REFUNDED"].includes(p.status) && ev.type !== "REFUNDED") return "processed";

    if (ev.type === "CAPTURED") {
      if (ev.amount !== p.amount) {
        audit(db, SYSTEM, "PAYMENT_AMOUNT_MISMATCH", "payment", p.id, "FAILURE", { expected: p.amount, received: ev.amount });
        run(db, "UPDATE payments SET status = 'FAILED', updated_at = ? WHERE id = ?", now(), p.id);
        return "processed";
      }
      // Une facture ne peut être payée qu'une fois : les autres tentatives restent sans effet.
      const inv = one<InvoiceRow>(db, "SELECT * FROM invoices WHERE id = ?", p.invoice_id ?? "");
      run(db, "UPDATE payments SET status = 'PAID', provider_charge_ref = COALESCE(?, provider_charge_ref), updated_at = ? WHERE id = ?", ev.providerChargeRef ?? null, now(), p.id);
      if (inv && inv.status === "ISSUED") {
        run(db, "UPDATE invoices SET status = 'PAID' WHERE id = ?", inv.id);
        const cust = one<{ id: string; email: string }>(db, "SELECT id, email FROM users WHERE id = ?", inv.customer_id);
        if (cust) notifier?.notify(cust, "PAYMENT_RECEIPT", "Paiement reçu", `Facture ${inv.number} : ${format(minor(inv.total))} — merci.`);
      } else if (inv) {
        audit(db, SYSTEM, "PAYMENT_DOUBLE_ON_INVOICE", "payment", p.id, "FAILURE", { invoice: inv.number });
      }
      audit(db, SYSTEM, "PAYMENT_CAPTURED", "payment", p.id, "SUCCESS", { amount: ev.amount });
    } else if (ev.type === "AUTHORIZED") {
      run(db, "UPDATE payments SET status = 'AUTHORIZED', updated_at = ? WHERE id = ? AND status = 'PENDING'", now(), p.id);
    } else if (ev.type === "FAILED" || ev.type === "CANCELLED") {
      run(db, "UPDATE payments SET status = ?, updated_at = ? WHERE id = ? AND status IN ('PENDING','AUTHORIZED')", ev.type === "FAILED" ? "FAILED" : "CANCELLED", now(), p.id);
      audit(db, SYSTEM, `PAYMENT_${ev.type}`, "payment", p.id, "FAILURE");
    }
    return "processed";
  });
}

/** Remboursement (SUPER_ADMIN, contrôlé en amont) : idempotent, audité, facture mise à jour. */
export async function refundPayment(db: DB, provider: PaymentProvider | null, actor: AuditActor, paymentId: string, amount: number, reason: string): Promise<void> {
  const p = one<PaymentRow>(db, "SELECT * FROM payments WHERE id = ?", paymentId);
  if (!p || p.status !== "PAID" && p.status !== "PARTIALLY_REFUNDED") throw new DomainError("Paiement non remboursable.", 409);
  if (!Number.isInteger(amount) || amount <= 0 || amount > p.amount - p.refunded_amount) throw new DomainError("Montant de remboursement invalide.");
  if (reason.trim().length < 3) throw new DomainError("Motif obligatoire.");
  const key = `refund:${p.id}:${p.refunded_amount}:${amount}`;
  if (one(db, "SELECT id FROM refunds WHERE idempotency_key = ?", key)) throw new DomainError("Ce remboursement a déjà été enregistré.", 409);

  let providerRef: string | null = null;
  if (p.method !== "CASH") {
    if (!provider || !p.provider_charge_ref) throw new DomainError("Remboursement en ligne impossible : prestataire non configuré ou référence manquante.");
    providerRef = (await provider.refundPayment(p.provider_charge_ref, minor(amount), key)).providerRefundId;
  }
  tx(db, () => {
    run(db, `INSERT INTO refunds (id, payment_id, amount, reason, status, provider_ref, idempotency_key, created_by, created_at)
             VALUES (?, ?, ?, ?, 'SUCCEEDED', ?, ?, ?, ?)`, newId(), p.id, amount, reason.trim().slice(0, 300), providerRef, key, actor.id, now());
    const refunded = p.refunded_amount + amount, full = refunded === p.amount;
    run(db, "UPDATE payments SET refunded_amount = ?, status = ?, updated_at = ? WHERE id = ?", refunded, full ? "REFUNDED" : "PARTIALLY_REFUNDED", now(), p.id);
    if (p.invoice_id) run(db, "UPDATE invoices SET refunded_amount = refunded_amount + ?, status = ? WHERE id = ?", amount, full ? "REFUNDED" : "PARTIALLY_REFUNDED", p.invoice_id);
    const b = getBooking(db, p.booking_id);
    const target = full ? "REFUNDED" : "PARTIALLY_REFUNDED";
    if (b.status !== target && (b.status === "COMPLETED" || (b.status === "PARTIALLY_REFUNDED" && full))) moveStatus(db, b, target, actor, reason);
    audit(db, actor, "REFUND_CREATED", "payment", p.id, "SUCCESS", { amount, reason, full });
  });
}

// --- Cash ------------------------------------------------------------------------------
export function reconcileCash(db: DB, actor: AuditActor, cashId: string, outcome: "RECONCILED" | "DISPUTED", note: string): void {
  const c = one<{ status: string; expected_amount: number; declared_amount: number; driver_id: string }>(db, "SELECT * FROM cash_transactions WHERE id = ?", cashId);
  if (!c) throw new DomainError("Encaissement introuvable.", 404);
  if (c.status === "RECONCILED") throw new DomainError("Déjà rapproché.", 409);
  if (outcome === "RECONCILED" && c.expected_amount !== c.declared_amount && note.trim().length < 3) {
    throw new DomainError("Écart de caisse : un motif est obligatoire (il sera enregistré comme ajustement).");
  }
  tx(db, () => {
    run(db, "UPDATE cash_transactions SET status = ?, reconciled_at = ?, reconciled_by = ?, note = CASE WHEN ? = '' THEN note ELSE ? END WHERE id = ?",
      outcome, now(), actor.id, note.trim(), note.trim().slice(0, 300), cashId);
    if (outcome === "RECONCILED" && c.expected_amount !== c.declared_amount) {
      // Aucun argent ne disparaît : l'écart est enregistré comme ajustement chauffeur (§125).
      run(db, `INSERT INTO earning_adjustments (id, driver_id, amount, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        newId(), c.driver_id, c.declared_amount - c.expected_amount, `Écart de caisse : ${note.trim()}`, actor.id ?? "", now());
    }
    audit(db, actor, `CASH_${outcome}`, "cash_transaction", cashId, "SUCCESS", { expected: c.expected_amount, declared: c.declared_amount, note });
  });
}

// --- Rémunération chauffeurs -----------------------------------------------------------------
export function addEarningAdjustment(db: DB, actor: AuditActor, driverId: string, amount: number, reason: string): void {
  if (!Number.isSafeInteger(amount) || amount === 0) throw new DomainError("Montant invalide.");
  if (reason.trim().length < 3) throw new DomainError("Motif obligatoire.");
  const d = one(db, "SELECT id FROM users WHERE id = ? AND role = 'DRIVER'", driverId);
  if (!d) throw new DomainError("Chauffeur introuvable.", 404);
  run(db, `INSERT INTO earning_adjustments (id, driver_id, amount, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    newId(), driverId, amount, reason.trim().slice(0, 300), actor.id ?? "", now());
  audit(db, actor, "EARNING_ADJUSTMENT", "driver", driverId, "SUCCESS", { amount, reason });
}

export function markEarningsPaid(db: DB, actor: AuditActor, driverId: string, untilIso: string): number {
  return tx(db, () => {
    const r = db.prepare(`UPDATE driver_earnings SET status = 'PAID', paid_at = ?, paid_by = ?
                          WHERE driver_id = ? AND status IN ('CALCULATED','PENDING_PAYMENT') AND created_at < ?`)
      .run(now(), actor.id, driverId, untilIso);
    const n = Number(r.changes);
    audit(db, actor, "EARNINGS_MARKED_PAID", "driver", driverId, "SUCCESS", { count: n, until: untilIso });
    return n;
  });
}
