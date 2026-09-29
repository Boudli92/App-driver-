import type { Router, Ctx } from "../lib/http.ts";
import { send, redirect, field, HttpError } from "../lib/http.ts";
import { html, type Raw } from "../lib/html.ts";
import { layout, csrf, fieldInput, fieldSelect, fieldTextarea, money, badge, empty } from "../ui/layout.ts";
import { need, auditActor, type Deps } from "../app.ts";
import { one, all, run } from "../db/db.ts";
import { fmtDateTime, fmtDate, fmtBps, parseScaled, centsToInput, zurichPeriodStart, zurichDateInputToUtc } from "../lib/format.ts";
import { newId } from "../lib/security.ts";
import { refundPayment, reconcileCash } from "../services/payments.ts";
import { financeSummary, driverReport, toCsv } from "../services/finance.ts";
import { createCustomerInvitation, DomainError } from "../services/users.ts";
import { getSettings, setSetting, type Settings } from "../services/settings.ts";
import { audit } from "../services/audit.ts";
import { DEFAULT_FEATURE_FLAGS, type FeatureFlag } from "../config/defaults.ts";
import { renderInvoice, type InvoiceView } from "./customer.ts";
import { PAGE, pageOf, pager } from "./admin.ts";

function period(ctx: Ctx): { from: string; to: string; fromDate: string; toDate: string } {
  const today = new Date().toISOString().slice(0, 10);
  const defFrom = zurichPeriodStart("month");
  const fromDate = ctx.query.get("from") ?? "", toDate = ctx.query.get("to") ?? "";
  const from = zurichDateInputToUtc(fromDate) ?? defFrom;
  const to = zurichDateInputToUtc(toDate, true) ?? new Date(Date.now() + 86400_000).toISOString();
  return { from, to, fromDate: fromDate || from.slice(0, 10), toDate: toDate || today };
}
function periodForm(p: { fromDate: string; toDate: string }): Raw {
  return html`<form class="filters" method="get">${fieldInput("from", "Du", { type: "date", value: p.fromDate })}${fieldInput("to", "Au", { type: "date", value: p.toDate })}<button class="btn" type="submit">Appliquer</button></form>`;
}
function money2cents(raw: string, allowNeg = false): number | null {
  const neg = allowNeg && raw.startsWith("-");
  const v = parseScaled(neg ? raw.slice(1) : raw, 2, 1_000_000_00);
  return v === null ? null : neg ? -v : v;
}

export function registerAdminFinance(r: Router, d: Deps): void {
  const A = (ctx: Ctx) => auditActor(ctx);

  // --- Paiements & cash (§18–21) ------------------------------------------------------------------
  r.get("/admin/payments", (ctx) => {
    need(ctx, "payment:manage");
    const cash = all<{ id: string; number: string; booking_id: string; driver: string; expected_amount: number; declared_amount: number; status: string; collected_at: string; note: string }>(d.db,
      `SELECT c.id, b.number, b.id AS booking_id, u.first_name || ' ' || u.last_name AS driver, c.expected_amount, c.declared_amount, c.status, c.collected_at, c.note
       FROM cash_transactions c JOIN bookings b ON b.id = c.booking_id JOIN users u ON u.id = c.driver_id WHERE c.status IN ('COLLECTED','DISPUTED') ORDER BY c.collected_at`);
    const rows = all<{ id: string; booking_id: string; number: string; method: string; provider: string; amount: number; refunded_amount: number; status: string; created_at: string }>(d.db,
      `SELECT p.*, b.number FROM payments p JOIN bookings b ON b.id = p.booking_id ORDER BY p.created_at DESC LIMIT ${PAGE} OFFSET ${(pageOf(ctx) - 1) * PAGE}`);
    send(ctx, 200, layout(ctx, "Paiements", html`<div class="row between"><h1>Paiements</h1><a class="btn btn-sm" href="/admin/export/payments">Export CSV</a></div>
      <div class="card gold"><h3>Espèces à rapprocher</h3>${cash.length ? html`<div class="table-wrap"><table><thead><tr><th>Course</th><th>Chauffeur</th><th class="r">Attendu</th><th class="r">Déclaré</th><th>État</th><th>Rapprochement</th></tr></thead><tbody>
        ${cash.map((c) => html`<tr><td><a href="/admin/bookings/${c.booking_id}">${c.number}</a><div class="small muted">${fmtDateTime(c.collected_at)}</div></td><td>${c.driver}</td>
          <td class="r">${money(c.expected_amount)}</td><td class="r">${money(c.declared_amount)}</td><td>${badge(c.status)}<div class="small muted">${c.note}</div></td>
          <td><form method="post" action="/admin/cash/${c.id}">${csrf(ctx)}<label class="sr-only" for="n_${c.id}">Note</label><input id="n_${c.id}" name="note" placeholder="Note / motif d'écart">
            <div class="row"><button class="btn btn-sm btn-primary" name="outcome" value="RECONCILED" type="submit">Montant reçu</button><button class="btn btn-sm btn-danger" name="outcome" value="DISPUTED" type="submit">Litige</button></div></form></td></tr>`)}
      </tbody></table></div>` : html`<p class="muted">Aucun encaissement en attente.</p>`}</div>
      <div class="card"><h3>Tous les paiements</h3>${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Course</th><th>Moyen</th><th class="r">Montant</th><th>Statut</th><th></th></tr></thead><tbody>
        ${rows.map((p) => html`<tr><td>${fmtDateTime(p.created_at)}</td><td><a href="/admin/bookings/${p.booking_id}">${p.number}</a></td><td>${p.method} <span class="small muted">${p.provider}</span></td>
          <td class="r">${money(p.amount)}${p.refunded_amount ? html`<div class="small muted">remb. ${money(p.refunded_amount)}</div>` : ""}</td><td>${badge(p.status)}</td>
          <td>${["PAID", "PARTIALLY_REFUNDED"].includes(p.status) ? html`<a class="btn btn-sm" href="/admin/payments/${p.id}/refund">Rembourser</a>` : ""}</td></tr>`)}
      </tbody></table></div>` : empty("Aucun paiement")}${pager(ctx, rows.length)}</div>`));
  });

  r.post("/admin/cash/:id", (ctx) => {
    need(ctx, "cash:reconcile");
    const outcome = field(ctx, "outcome", 12) === "DISPUTED" ? "DISPUTED" : "RECONCILED";
    reconcileCash(d.db, A(ctx), ctx.params.id!, outcome, field(ctx, "note", 300));
    redirect(ctx, "/admin/payments", outcome === "RECONCILED" ? "Encaissement rapproché." : "Encaissement marqué en litige.");
  });

  r.get("/admin/payments/:id/refund", (ctx) => {
    need(ctx, "payment:refund");
    const p = one<{ id: string; method: string; amount: number; refunded_amount: number; status: string; booking_id: string }>(d.db, "SELECT * FROM payments WHERE id = ?", ctx.params.id!);
    if (!p) throw new HttpError(404, "Paiement introuvable.");
    const max = p.amount - p.refunded_amount;
    send(ctx, 200, layout(ctx, "Remboursement", html`<h1>Remboursement</h1>
      <form class="card gold" method="post" action="/admin/payments/${p.id}/refund">${csrf(ctx)}
        <p>Paiement ${p.method} de ${money(p.amount)} · déjà remboursé ${money(p.refunded_amount)} · remboursable ${money(max)}</p>
        ${p.method === "CASH" ? html`<div class="alert alert-info">Paiement en espèces : le remboursement est enregistré ici, la remise d'argent au client se fait hors système.</div>` : ""}
        ${fieldInput("amount", "Montant CHF", { inputmode: "decimal", value: centsToInput(max), required: true })}${fieldInput("reason", "Motif", { required: true })}
        <label class="check small"><input type="checkbox" name="confirm" value="yes" required> Je confirme ce remboursement.</label>
        <p class="small muted">La rémunération chauffeur n'est pas modifiée automatiquement ; ajoutez un ajustement si votre politique le prévoit.</p>
        <button class="btn btn-danger" type="submit">Rembourser</button></form>`));
  });
  r.post("/admin/payments/:id/refund", async (ctx) => {
    need(ctx, "payment:refund");
    if (ctx.form.get("confirm") !== "yes") throw new DomainError("Veuillez confirmer.");
    const amount = money2cents(field(ctx, "amount", 14));
    if (amount === null) throw new DomainError("Montant invalide.");
    const p = one<{ booking_id: string }>(d.db, "SELECT booking_id FROM payments WHERE id = ?", ctx.params.id!);
    await refundPayment(d.db, d.payments, A(ctx), ctx.params.id!, amount, field(ctx, "reason", 300));
    redirect(ctx, p ? `/admin/bookings/${p.booking_id}` : "/admin/payments", "Remboursement enregistré.");
  });

  // --- Factures -------------------------------------------------------------------------------------
  r.get("/admin/invoices", (ctx) => {
    need(ctx, "finance:read_all");
    const status = ctx.query.get("status") ?? "";
    const rows = all<{ id: string; number: string; issued_at: string; total: number; status: string; payment_method: string; customer: string }>(d.db,
      `SELECT i.*, u.first_name || ' ' || u.last_name AS customer FROM invoices i JOIN users u ON u.id = i.customer_id ${status ? "WHERE i.status = ?" : ""} ORDER BY i.issued_at DESC LIMIT ${PAGE} OFFSET ${(pageOf(ctx) - 1) * PAGE}`, ...(status ? [status] : []));
    send(ctx, 200, layout(ctx, "Factures", html`<div class="row between"><h1>Factures</h1><a class="btn btn-sm" href="/admin/export/invoices">Export CSV</a></div>
      <form class="filters" method="get">${fieldSelect("status", "Statut", [["", "Toutes"], ["ISSUED", "À payer"], ["PAID", "Payées"], ["PARTIALLY_REFUNDED", "Remb. partiel"], ["REFUNDED", "Remboursées"]], status)}<button class="btn" type="submit">Filtrer</button></form>
      ${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>N°</th><th>Date</th><th>Client</th><th>Moyen</th><th>Statut</th><th class="r">Total</th></tr></thead><tbody>
        ${rows.map((i) => html`<tr><td><a href="/admin/invoices/${i.id}">${i.number}</a></td><td>${fmtDate(i.issued_at)}</td><td>${i.customer}</td><td>${i.payment_method}</td><td>${badge(i.status)}</td><td class="r">${money(i.total)}</td></tr>`)}
      </tbody></table></div>` : empty("Aucune facture")}${pager(ctx, rows.length)}`));
  });
  r.get("/admin/invoices/:id", (ctx) => {
    need(ctx, "finance:read_all");
    const inv = one<InvoiceView>(d.db, "SELECT * FROM invoices WHERE id = ?", ctx.params.id!);
    if (!inv) throw new HttpError(404, "Facture introuvable.");
    send(ctx, 200, layout(ctx, `Facture ${inv.number}`, html`${renderInvoice(d, inv)}<p class="no-print"><a class="btn" href="/admin/bookings/${inv.booking_id}">Voir la course</a></p>`));
  });

  // --- Finances & rapports (§106–108) --------------------------------------------------------------------
  const financePage = (ctx: Ctx) => {
    need(ctx, "finance:read_all");
    const p = period(ctx), s = financeSummary(d.db, p.from, p.to), rows = driverReport(d.db, p.from, p.to);
    const stat = (label: string, v: Raw | string | number) => html`<div class="stat"><div class="label">${label}</div><div class="value">${v}</div></div>`;
    const qs = `?from=${p.fromDate}&to=${p.toDate}`;
    send(ctx, 200, layout(ctx, "Finances", html`<div class="row between"><h1>Finances</h1>
      <div class="row"><a class="btn btn-sm" href="/admin/export/finance${qs}">Export CSV</a><a class="btn btn-sm" href="/admin/export/drivers${qs}">Rapport chauffeurs CSV</a><a class="btn btn-sm" href="/admin/finance/print${qs}">Version imprimable (PDF)</a></div></div>
      ${periodForm(p)}
      <div class="grid grid-4">${stat("CA brut", money(s.gross))}${stat("Remboursements", money(s.refunds))}${stat("CA net", money(s.net))}${stat("Courses", s.trips)}
        ${stat("Part chauffeurs", money(s.driverShare))}${stat("Part entreprise", money(s.companyShare))}${stat("Espèces", money(s.cash))}${stat("Carte / TWINT encaissés", money(s.online))}
        ${stat("En ligne impayé", money(s.unpaidOnline))}${stat("Ajustements", money(s.adjustments))}${stat("Annulations", s.cancelled)}${stat("Récompenses", money(s.rewards))}
        ${stat("Panier moyen", money(s.trips ? Math.round(s.gross / s.trips) : 0))}</div>
      <div class="card"><h3>Rapport chauffeurs</h3>${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Chauffeur</th><th class="r">Courses</th><th class="r">CA généré</th><th class="r">Taux</th>
        <th class="r">Rémunération</th><th class="r">Ajustements</th><th class="r">Versé</th><th class="r">Restant</th></tr></thead><tbody>
        ${rows.map((x) => html`<tr><td><a href="/admin/drivers/${x.driver_id}">${x.name}</a></td><td class="r num">${x.trips}</td><td class="r">${money(x.gross)}</td>
          <td class="r num">${fmtBps(x.share_bps ?? getSettings(d.db).driver_share_bps)}</td><td class="r">${money(x.driver_amount)}</td><td class="r">${money(x.adjustments)}</td><td class="r">${money(x.paid)}</td><td class="r">${money(x.remaining)}</td></tr>`)}
      </tbody></table></div>` : empty("Aucun chauffeur")}</div>`));
  };
  r.get("/admin/finance", financePage);
  r.get("/admin/reports", financePage);
  r.get("/admin/finance/print", (ctx) => {
    need(ctx, "report:export");
    const p = period(ctx), s = financeSummary(d.db, p.from, p.to), rows = driverReport(d.db, p.from, p.to), company = getSettings(d.db).company;
    audit(d.db, A(ctx), "REPORT_PRINTED", "finance", null, "SUCCESS", { from: p.from, to: p.to });
    send(ctx, 200, layout(ctx, "Rapport financier", html`<article class="invoice"><h2>${company.legal_name || company.display_name} — Rapport financier</h2>
      <p class="muted">Période du ${fmtDate(p.from)} au ${fmtDate(new Date(new Date(p.to).getTime() - 1).toISOString())}</p>
      <table><tbody>${([["CA brut", s.gross], ["Remboursements", s.refunds], ["CA net", s.net], ["Part chauffeurs", s.driverShare], ["Part entreprise", s.companyShare], ["Espèces", s.cash], ["Carte / TWINT", s.online], ["Impayés en ligne", s.unpaidOnline]] as [string, number][])
        .map(([k, v]) => html`<tr><td>${k}</td><td class="r">${money(v)}</td></tr>`)}<tr><td>Courses</td><td class="r">${s.trips}</td></tr></tbody></table>
      <h3>Chauffeurs</h3><table><thead><tr><th>Chauffeur</th><th class="r">Courses</th><th class="r">CA</th><th class="r">Rémunération</th><th class="r">Restant</th></tr></thead><tbody>
      ${rows.map((x) => html`<tr><td>${x.name}</td><td class="r">${x.trips}</td><td class="r">${money(x.gross)}</td><td class="r">${money(x.driver_amount + x.adjustments)}</td><td class="r">${money(x.remaining)}</td></tr>`)}</tbody></table>
      <p class="small muted no-print">Utilisez « Imprimer » → « Enregistrer au format PDF ».</p></article>`));
  });

  // --- Exports CSV protégés (§109) -------------------------------------------------------------------------
  r.get("/admin/export/:kind", (ctx) => {
    need(ctx, "report:export");
    const p = period(ctx), kind = ctx.params.kind!;
    const queries: Record<string, () => Record<string, unknown>[]> = {
      bookings: () => all(d.db, `SELECT b.number, b.status, b.pickup_at, b.pickup_address, b.dropoff_address, b.payment_method, b.final_distance_m, b.waiting_minutes,
        printf('%.2f', b.final_total / 100.0) AS total_chf, cu.email AS customer, d.email AS driver FROM bookings b JOIN users cu ON cu.id = b.customer_id
        LEFT JOIN users d ON d.id = b.assigned_driver_id WHERE b.pickup_at >= ? AND b.pickup_at < ? ORDER BY b.pickup_at`, p.from, p.to),
      invoices: () => all(d.db, `SELECT i.number, i.issued_at, i.status, i.payment_method, printf('%.2f', i.total / 100.0) AS total_chf, printf('%.2f', i.tax_amount / 100.0) AS tax_chf,
        printf('%.2f', i.refunded_amount / 100.0) AS refunded_chf, u.email AS customer FROM invoices i JOIN users u ON u.id = i.customer_id WHERE i.issued_at >= ? AND i.issued_at < ? ORDER BY i.number`, p.from, p.to),
      payments: () => all(d.db, `SELECT p.created_at, b.number, p.method, p.provider, p.provider_ref, p.status, printf('%.2f', p.amount / 100.0) AS amount_chf,
        printf('%.2f', p.refunded_amount / 100.0) AS refunded_chf FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE p.created_at >= ? AND p.created_at < ? ORDER BY p.created_at`, p.from, p.to),
      finance: () => all(d.db, `SELECT e.created_at, b.number, u.email AS driver, printf('%.2f', e.gross_amount / 100.0) AS gross_chf, e.driver_share_bps,
        printf('%.2f', e.driver_amount / 100.0) AS driver_chf, printf('%.2f', e.company_amount / 100.0) AS company_chf, e.status
        FROM driver_earnings e JOIN bookings b ON b.id = e.booking_id JOIN users u ON u.id = e.driver_id WHERE e.created_at >= ? AND e.created_at < ? ORDER BY e.created_at`, p.from, p.to),
      drivers: () => driverReport(d.db, p.from, p.to).map((x) => ({ chauffeur: x.name, courses: x.trips, ca_chf: (x.gross / 100).toFixed(2), remuneration_chf: (x.driver_amount / 100).toFixed(2),
        ajustements_chf: (x.adjustments / 100).toFixed(2), verse_chf: (x.paid / 100).toFixed(2), restant_chf: (x.remaining / 100).toFixed(2) })),
      customers: () => all(d.db, "SELECT u.first_name, u.last_name, u.email, u.phone, u.status, u.created_at, u.approved_at, i.email AS invited_by FROM users u LEFT JOIN users i ON i.id = u.invited_by WHERE u.role = 'CUSTOMER' ORDER BY u.created_at"),
    };
    const q = queries[kind];
    if (!q) throw new HttpError(404, "Export inconnu.");
    audit(d.db, A(ctx), "EXPORT", kind, null, "SUCCESS", { from: p.from, to: p.to });
    ctx.res.setHeader("Content-Disposition", `attachment; filename="${kind}-${p.fromDate}_${p.toDate}.csv"`);
    send(ctx, 200, toCsv(q()), "text/csv; charset=utf-8");
  });

  // --- Parrainages & fidélité (§6–7) ---------------------------------------------------------------------------
  r.get("/admin/referrals", (ctx) => {
    need(ctx, "invitation:manage");
    const q = (ctx.query.get("q") ?? "").trim().toUpperCase().slice(0, 20);
    const rows = all<{ code: string; created_at: string; status: string; uses: number; max_uses: number; source: string; campaign: string; invited_email: string | null; inviter: string | null; inviter_id: string | null }>(d.db,
      `SELECT i.code, i.created_at, i.status, i.uses, i.max_uses, i.source, i.campaign, i.invited_email, u.first_name || ' ' || u.last_name AS inviter, u.id AS inviter_id
       FROM invitations i LEFT JOIN users u ON u.id = i.inviter_user_id WHERE i.kind = 'CUSTOMER' ${q ? "AND i.code LIKE ?" : ""} ORDER BY i.created_at DESC LIMIT ${PAGE} OFFSET ${(pageOf(ctx) - 1) * PAGE}`, ...(q ? [`%${q}%`] : []));
    const joined = all<{ id: string; name: string; status: string; created_at: string; approved_at: string | null; code: string | null; inviter: string | null }>(d.db,
      `SELECT u.id, u.first_name || ' ' || u.last_name AS name, u.status, u.created_at, u.approved_at, i.code, p.first_name || ' ' || p.last_name AS inviter
       FROM users u LEFT JOIN invitations i ON i.id = u.invitation_id LEFT JOIN users p ON p.id = u.invited_by WHERE u.role = 'CUSTOMER' ORDER BY u.created_at DESC LIMIT 50`);
    const ledger = all<{ name: string; amount: number; kind: string; note: string; created_at: string }>(d.db,
      "SELECT u.first_name || ' ' || u.last_name AS name, r.amount, r.kind, r.note, r.created_at FROM reward_ledger r JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC LIMIT 50");
    send(ctx, 200, layout(ctx, "Parrainages", html`<h1>Parrainages et invitations</h1>
      <form class="card gold" method="post" action="/admin/referrals">${csrf(ctx)}<h3>Créer une invitation</h3><div class="grid grid-3">
        ${fieldInput("email", "E-mail (facultatif)", { type: "email" })}${fieldInput("campaign", "Campagne / source")}${fieldInput("max_uses", "Utilisations max.", { type: "number", value: 1, min: "1", max: "100" })}</div>
        <button class="btn btn-primary" type="submit">Créer le lien</button></form>
      <div class="card"><h3>Qui a invité qui</h3><div class="table-wrap"><table><thead><tr><th>Membre</th><th>Invité par</th><th>Code</th><th>Demande</th><th>Approuvé</th><th>Statut</th></tr></thead><tbody>
        ${joined.map((j) => html`<tr><td><a href="/admin/customers/${j.id}">${j.name}</a></td><td>${j.inviter ?? "—"}</td><td class="num">${j.code ?? "—"}</td><td>${fmtDateTime(j.created_at)}</td><td>${fmtDateTime(j.approved_at)}</td><td>${badge(j.status)}</td></tr>`)}
      </tbody></table></div></div>
      <div class="card"><h3>Liens d'invitation</h3><form class="filters" method="get">${fieldInput("q", "Code", { value: q })}<button class="btn" type="submit">Chercher</button></form>
        ${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Code</th><th>Créé par</th><th>Pour</th><th>Créé</th><th>Utilisations</th><th>Source</th></tr></thead><tbody>
        ${rows.map((i) => html`<tr><td class="num">${i.code}</td><td>${i.inviter_id ? html`<a href="/admin/customers/${i.inviter_id}">${i.inviter}</a>` : "—"}</td><td>${i.invited_email ?? "—"}</td>
          <td>${fmtDate(i.created_at)}</td><td class="num">${i.uses}/${i.max_uses}</td><td class="small">${i.source} ${i.campaign}</td></tr>`)}</tbody></table></div>` : empty("Aucune invitation")}${pager(ctx, rows.length)}</div>
      <div class="card" id="rewards"><h3>Journal des récompenses</h3>${ledger.length ? ledger.map((x) => html`<div class="row between small"><span>${x.name} · ${x.kind} · ${x.note} · ${fmtDate(x.created_at)}</span>${money(x.amount)}</div>`) : html`<p class="muted">Aucun mouvement.</p>`}</div>`));
  });
  r.get("/admin/rewards", (ctx) => redirect(ctx, "/admin/referrals#rewards"));
  r.post("/admin/referrals", (ctx) => {
    need(ctx, "invitation:manage");
    const email = field(ctx, "email", 254);
    const code = createCustomerInvitation(d.db, A(ctx), { ...(email ? { email } : {}), source: "admin", campaign: field(ctx, "campaign", 60), maxUses: Number(field(ctx, "max_uses", 3) || "1") });
    redirect(ctx, "/admin/referrals", `Lien créé : ${d.env.appUrl}/invite/${code}`);
  });

  // --- Support (§50) -------------------------------------------------------------------------------------------
  r.get("/admin/support", (ctx) => {
    need(ctx, "customer:read_any");
    const rows = all<{ id: string; subject: string; category: string; status: string; updated_at: string; name: string; role: string }>(d.db,
      "SELECT t.*, u.first_name || ' ' || u.last_name AS name, u.role FROM support_tickets t JOIN users u ON u.id = t.user_id ORDER BY t.status = 'CLOSED', t.updated_at DESC LIMIT 100");
    send(ctx, 200, layout(ctx, "Support", html`<h1>Support</h1>${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Sujet</th><th>De</th><th>Catégorie</th><th>Mis à jour</th><th>Statut</th></tr></thead><tbody>
      ${rows.map((t) => html`<tr><td><a href="/admin/support/${t.id}">${t.subject}</a></td><td>${t.name} <span class="small muted">${t.role}</span></td><td>${t.category}</td><td>${fmtDateTime(t.updated_at)}</td><td>${badge(t.status)}</td></tr>`)}
      </tbody></table></div>` : empty("Aucune demande")}`));
  });
  r.get("/admin/support/:id", (ctx) => {
    need(ctx, "customer:read_any");
    const t = one<{ id: string; subject: string; status: string; user_id: string }>(d.db, "SELECT * FROM support_tickets WHERE id = ?", ctx.params.id!);
    if (!t) throw new HttpError(404, "Demande introuvable.");
    const msgs = all<{ body: string; created_at: string; author: string }>(d.db, "SELECT m.body, m.created_at, u.first_name AS author FROM support_messages m JOIN users u ON u.id = m.author_id WHERE ticket_id = ? ORDER BY m.created_at", t.id);
    send(ctx, 200, layout(ctx, t.subject, html`<div class="row between"><h1>${t.subject}</h1>${badge(t.status)}</div>
      ${msgs.map((m) => html`<div class="card"><div class="small muted">${m.author} · ${fmtDateTime(m.created_at)}</div><p>${m.body}</p></div>`)}
      <form class="card" method="post" action="/admin/support/${t.id}">${csrf(ctx)}${fieldTextarea("message", "Réponse")}
        <div class="row"><button class="btn btn-primary" name="op" value="reply" type="submit">Répondre</button><button class="btn" name="op" value="close" type="submit">Fermer la demande</button></div></form>`));
  });
  r.post("/admin/support/:id", (ctx) => {
    need(ctx, "customer:suspend");
    const t = one<{ id: string; user_id: string; subject: string }>(d.db, "SELECT id, user_id, subject FROM support_tickets WHERE id = ?", ctx.params.id!);
    if (!t) throw new HttpError(404, "Demande introuvable.");
    const now = new Date().toISOString(), message = field(ctx, "message", 2000);
    if (field(ctx, "op", 10) === "close") run(d.db, "UPDATE support_tickets SET status = 'CLOSED', updated_at = ? WHERE id = ?", now, t.id);
    else {
      if (!message) throw new DomainError("Message vide.");
      run(d.db, "INSERT INTO support_messages (id, ticket_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)", newId(), t.id, ctx.user!.id, message, now);
      run(d.db, "UPDATE support_tickets SET status = 'ANSWERED', updated_at = ? WHERE id = ?", now, t.id);
      const u = one<{ id: string; email: string }>(d.db, "SELECT id, email FROM users WHERE id = ?", t.user_id);
      if (u) d.notifier.notify(u, "SUPPORT_REPLY", `Réponse : ${t.subject}`, message.slice(0, 200));
    }
    redirect(ctx, `/admin/support/${t.id}`, "Enregistré.");
  });

  // --- Audit (§34) ---------------------------------------------------------------------------------------------
  r.get("/admin/audit", (ctx) => {
    need(ctx, "audit:read");
    const q = (ctx.query.get("q") ?? "").trim().slice(0, 60);
    const rows = all<{ at: string; role: string; action: string; resource: string; resource_id: string | null; result: string; metadata: string; name: string | null }>(d.db,
      `SELECT a.*, u.first_name || ' ' || u.last_name AS name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
       ${q ? "WHERE a.action LIKE ? OR a.resource_id = ?" : ""} ORDER BY a.at DESC LIMIT ${PAGE} OFFSET ${(pageOf(ctx) - 1) * PAGE}`, ...(q ? [`%${q.toUpperCase()}%`, q] : []));
    send(ctx, 200, layout(ctx, "Audit", html`<h1>Journal d'audit</h1><p class="small muted">Journal en ajout seul : il ne peut être ni modifié ni supprimé.</p>
      <form class="filters" method="get">${fieldInput("q", "Action ou identifiant", { value: q })}<button class="btn" type="submit">Filtrer</button></form>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th>Utilisateur</th><th>Action</th><th>Ressource</th><th>Résultat</th><th>Détails</th></tr></thead><tbody>
      ${rows.map((a) => html`<tr><td class="small">${fmtDateTime(a.at)}</td><td>${a.name ?? a.role}</td><td class="num small">${a.action}</td><td class="small">${a.resource} ${a.resource_id ?? ""}</td>
        <td>${badge(a.result === "SUCCESS" ? "PAID" : "FAILED")}</td><td class="small muted">${a.metadata.length > 2 ? a.metadata.slice(0, 240) : ""}</td></tr>`)}
      </tbody></table></div>${pager(ctx, rows.length)}`));
  });

  // --- Paramètres (§81, §134) ----------------------------------------------------------------------------------
  r.get("/admin/settings", (ctx) => {
    need(ctx, "settings:manage");
    const s = getSettings(d.db), p = s.pricing, c = s.company, t = s.tax, b = s.booking;
    const chf = (name: string, label: string, v: number) => fieldInput(name, label, { value: centsToInput(v), inputmode: "decimal", required: true });
    const confirm = html`<label class="check small"><input type="checkbox" name="confirm" value="yes" required> Je confirme cette modification (enregistrée dans l'audit).</label>`;
    const flags = Object.keys(DEFAULT_FEATURE_FLAGS) as FeatureFlag[];
    const flagLabels: Record<FeatureFlag, string> = { crypto: "Crypto (prestataire externe)", loyalty: "Fidélité", referral: "Parrainage", cash: "Paiement en espèces", sms: "SMS", push: "Notifications push", multiVehicle: "Multi-véhicules", multiCanton: "Multi-canton", multiCurrency: "Multi-devise" };
    send(ctx, 200, layout(ctx, "Paramètres", html`<h1>Paramètres</h1>
      <form class="card gold" method="post" action="/admin/settings/pricing">${csrf(ctx)}<h3>Tarifs</h3>
        <div class="grid grid-2">${chf("perKm", "Prix/km jour", p.perKm)}${chf("nightPerKm", "Prix/km nuit", p.nightPerKm)}
          ${chf("minimumFare", "Minimum jour", p.minimumFare)}${chf("nightMinimumFare", "Minimum nuit", p.nightMinimumFare)}
          ${chf("waitingPerMinute", "Attente/min jour", p.waitingPerMinute)}${chf("nightWaitingPerMinute", "Attente/min nuit", p.nightWaitingPerMinute)}
          ${chf("baseFare", "Prise en charge", p.baseFare)}${fieldInput("freeWaitingMinutes", "Minutes d'attente offertes", { type: "number", value: p.freeWaitingMinutes, min: "0", max: "120" })}
          ${fieldInput("nightStartHour", "Début de nuit (heure)", { type: "number", value: p.nightStartHour, min: "0", max: "23" })}${fieldInput("nightEndHour", "Fin de nuit (heure)", { type: "number", value: p.nightEndHour, min: "0", max: "23" })}</div>
        <label class="check"><input type="checkbox" name="waive" value="yes"${p.waiveBaseFareAtMinimum ? " checked" : ""}> Ne pas facturer la prise en charge lorsque la course est au minimum</label>
        ${fieldTextarea("holidays", "Jours fériés (AAAA-MM-JJ, un par ligne)", s.holidays.join("\n"), "Sans majoration tant qu'aucune majoration « jour férié » n'est définie.")}
        ${confirm}<button class="btn btn-primary" type="submit">Enregistrer les tarifs</button></form>
      <form class="card gold" method="post" action="/admin/settings/share">${csrf(ctx)}<h3>Rémunération chauffeur par défaut</h3>
        ${fieldInput("share", "Part chauffeur (%)", { value: String(s.driver_share_bps / 100), inputmode: "decimal", required: true, hint: "Les courses déjà clôturées conservent leur taux historique." })}
        ${confirm}<button class="btn btn-primary" type="submit">Enregistrer</button></form>
      <form class="card" method="post" action="/admin/settings/company">${csrf(ctx)}<h3>Entreprise</h3><div class="grid grid-2">
        ${fieldInput("legal_name", "Raison sociale", { value: c.legal_name })}${fieldInput("display_name", "Nom affiché", { value: c.display_name })}
        ${fieldInput("address", "Adresse", { value: c.address })}${fieldInput("postal_code", "NPA", { value: c.postal_code })}${fieldInput("city", "Localité", { value: c.city })}
        ${fieldInput("canton", "Canton", { value: c.canton })}${fieldInput("commune", "Commune", { value: c.commune })}${fieldInput("phone", "Téléphone", { value: c.phone })}
        ${fieldInput("email", "E-mail", { value: c.email })}${fieldInput("website", "Site", { value: c.website })}${fieldInput("uid", "IDE / UID", { value: c.uid })}${fieldInput("vat_number", "N° TVA", { value: c.vat_number })}
        ${fieldSelect("service_mode", "Mode de service", [["PRIVATE_TRANSPORT", "Transport privé"], ["TAXI", "Taxi"], ["VTC", "VTC"], ["OTHER", "Autre"]], c.service_mode)}</div>
        <p class="hint">Le mode de service et le canton déterminent les exigences légales applicables : à valider auprès des autorités compétentes.</p>
        <button class="btn" type="submit">Enregistrer</button></form>
      <form class="card" method="post" action="/admin/settings/tax">${csrf(ctx)}<h3>TVA</h3>
        <label class="check"><input type="checkbox" name="tax_enabled" value="yes"${t.tax_enabled ? " checked" : ""}> TVA activée</label>
        <div class="grid grid-2">${fieldInput("tax_rate", "Taux (%)", { value: String(t.tax_rate_bps / 100), inputmode: "decimal" })}${fieldInput("tax_label", "Libellé", { value: t.tax_label })}${fieldInput("tax_number", "N° d'immatriculation TVA", { value: t.tax_number })}</div>
        <label class="check"><input type="checkbox" name="tax_included" value="yes"${t.tax_included ? " checked" : ""}> Prix affichés TTC (TVA incluse)</label>
        <p class="hint">Aucun taux n'est imposé par le logiciel : renseignez la situation réelle de l'entreprise, validée par votre fiduciaire.</p>${confirm}<button class="btn" type="submit">Enregistrer</button></form>
      <form class="card" method="post" action="/admin/settings/booking">${csrf(ctx)}<h3>Réservations & invitations</h3><div class="grid grid-2">
        ${fieldInput("conflict_window_minutes", "Fenêtre anti-conflit (min)", { type: "number", value: b.conflict_window_minutes, min: "15", max: "600" })}
        ${fieldInput("min_lead_minutes", "Délai minimum de réservation (min)", { type: "number", value: b.min_lead_minutes, min: "0", max: "1440" })}
        ${fieldInput("max_advance_days", "Réservation max. à l'avance (jours)", { type: "number", value: b.max_advance_days, min: "1", max: "365" })}
        ${fieldInput("free_cancellation_hours", "Annulation gratuite (heures avant)", { type: "number", value: b.free_cancellation_hours, min: "0", max: "72" })}
        ${fieldInput("referral_reward", "Récompense de parrainage (CHF, 0 = aucune)", { value: centsToInput(s.referral.referral_reward), inputmode: "decimal" })}
        ${fieldInput("max_invitations", "Invitations max. par membre / 30 jours", { type: "number", value: s.referral.max_invitations_per_30_days, min: "0", max: "100" })}</div>
        <button class="btn" type="submit">Enregistrer</button></form>
      <form class="card" method="post" action="/admin/settings/features">${csrf(ctx)}<h3>Fonctionnalités</h3>
        ${flags.map((f) => html`<label class="check"><input type="checkbox" name="f_${f}" value="yes"${s.features[f] ? " checked" : ""}> ${flagLabels[f]}</label>`)}
        <div class="rule"></div><label class="check"><input type="checkbox" name="maintenance" value="yes"${s.maintenance ? " checked" : ""}> Mode maintenance (seul le propriétaire garde l'accès)</label>
        <p class="hint">Marketplace et multi-entreprise sont désactivés par construction et ne sont pas configurables.</p>
        <button class="btn" type="submit">Enregistrer</button></form>`));
  });

  const requireConfirm = (ctx: Ctx) => { if (ctx.form.get("confirm") !== "yes") throw new DomainError("Veuillez cocher la confirmation."); };
  const chfField = (ctx: Ctx, name: string): number => {
    const v = money2cents(field(ctx, name, 12));
    if (v === null) throw new DomainError(`Montant invalide : ${name}.`);
    return v;
  };
  const intField = (ctx: Ctx, name: string, min: number, max: number): number => {
    const n = Number(field(ctx, name, 6));
    if (!Number.isInteger(n) || n < min || n > max) throw new DomainError(`Valeur invalide : ${name}.`);
    return n;
  };

  r.post("/admin/settings/pricing", (ctx) => {
    need(ctx, "pricing:manage"); requireConfirm(ctx);
    const s = getSettings(d.db);
    const holidays = field(ctx, "holidays", 4000).split(/\s+/).filter(Boolean);
    if (holidays.some((h) => !/^\d{4}-\d{2}-\d{2}$/.test(h))) throw new DomainError("Jours fériés : format AAAA-MM-JJ.");
    const pricing: Settings["pricing"] = {
      ...s.pricing, perKm: chfField(ctx, "perKm") as never, nightPerKm: chfField(ctx, "nightPerKm") as never, minimumFare: chfField(ctx, "minimumFare") as never,
      nightMinimumFare: chfField(ctx, "nightMinimumFare") as never, waitingPerMinute: chfField(ctx, "waitingPerMinute") as never,
      nightWaitingPerMinute: chfField(ctx, "nightWaitingPerMinute") as never, baseFare: chfField(ctx, "baseFare") as never,
      freeWaitingMinutes: intField(ctx, "freeWaitingMinutes", 0, 120), nightStartHour: intField(ctx, "nightStartHour", 0, 23), nightEndHour: intField(ctx, "nightEndHour", 0, 23),
      waiveBaseFareAtMinimum: ctx.form.get("waive") === "yes",
    };
    setSetting(d.db, A(ctx), "pricing", pricing);
    setSetting(d.db, A(ctx), "holidays", holidays);
    redirect(ctx, "/admin/settings", "Tarifs enregistrés. Ils s'appliquent aux prochains calculs.");
  });
  r.post("/admin/settings/share", (ctx) => {
    need(ctx, "driver:set_share_rate"); requireConfirm(ctx);
    const bps = parseScaled(field(ctx, "share", 8), 2, 10000);
    if (bps === null) throw new DomainError("Taux invalide.");
    setSetting(d.db, A(ctx), "driver_share_bps", bps);
    redirect(ctx, "/admin/settings", `Part chauffeur par défaut : ${fmtBps(bps)}. Les courses passées gardent leur taux.`);
  });
  r.post("/admin/settings/company", (ctx) => {
    need(ctx, "settings:manage");
    const mode = field(ctx, "service_mode", 20);
    if (!["TAXI", "VTC", "PRIVATE_TRANSPORT", "OTHER"].includes(mode)) throw new DomainError("Mode invalide.");
    const c = getSettings(d.db).company;
    setSetting(d.db, A(ctx), "company", {
      ...c, legal_name: field(ctx, "legal_name", 120), display_name: field(ctx, "display_name", 80) || c.display_name, address: field(ctx, "address", 120),
      postal_code: field(ctx, "postal_code", 10), city: field(ctx, "city", 60), canton: field(ctx, "canton", 30), commune: field(ctx, "commune", 60),
      phone: field(ctx, "phone", 30), email: field(ctx, "email", 120), website: field(ctx, "website", 120), uid: field(ctx, "uid", 30), vat_number: field(ctx, "vat_number", 30),
      service_mode: mode as "TAXI",
    });
    redirect(ctx, "/admin/settings", "Informations de l'entreprise enregistrées.");
  });
  r.post("/admin/settings/tax", (ctx) => {
    need(ctx, "settings:manage"); requireConfirm(ctx);
    const enabled = ctx.form.get("tax_enabled") === "yes";
    const bps = parseScaled(field(ctx, "tax_rate", 8) || "0", 2, 5000);
    if (bps === null) throw new DomainError("Taux de TVA invalide.");
    if (enabled && bps === 0) throw new DomainError("Indiquez un taux de TVA ou désactivez-la.");
    setSetting(d.db, A(ctx), "tax", { tax_enabled: enabled, tax_rate_bps: bps, tax_label: field(ctx, "tax_label", 20) || "TVA", tax_number: field(ctx, "tax_number", 30), tax_included: ctx.form.get("tax_included") === "yes" });
    redirect(ctx, "/admin/settings", "Configuration TVA enregistrée (factures futures uniquement).");
  });
  r.post("/admin/settings/booking", (ctx) => {
    need(ctx, "settings:manage");
    setSetting(d.db, A(ctx), "booking", {
      conflict_window_minutes: intField(ctx, "conflict_window_minutes", 15, 600), min_lead_minutes: intField(ctx, "min_lead_minutes", 0, 1440),
      max_advance_days: intField(ctx, "max_advance_days", 1, 365), free_cancellation_hours: intField(ctx, "free_cancellation_hours", 0, 72),
    });
    setSetting(d.db, A(ctx), "referral", { referral_reward: chfField(ctx, "referral_reward"), max_invitations_per_30_days: intField(ctx, "max_invitations", 0, 100) });
    redirect(ctx, "/admin/settings", "Enregistré.");
  });
  r.post("/admin/settings/features", (ctx) => {
    need(ctx, "settings:manage");
    const features = { ...DEFAULT_FEATURE_FLAGS };
    for (const f of Object.keys(features) as FeatureFlag[]) features[f] = ctx.form.get(`f_${f}`) === "yes";
    setSetting(d.db, A(ctx), "features", features);
    setSetting(d.db, A(ctx), "maintenance", ctx.form.get("maintenance") === "yes");
    redirect(ctx, "/admin/settings", "Fonctionnalités enregistrées.");
  });

}
