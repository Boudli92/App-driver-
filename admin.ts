import type { Router, Ctx } from "../lib/http.ts";
import { send, redirect, field, HttpError } from "../lib/http.ts";
import { html, raw, type Raw } from "../lib/html.ts";
import { layout, csrf, fieldInput, fieldSelect, fieldTextarea, money, badge, empty, actionButton } from "../ui/layout.ts";
import { need, auditActor, type Deps } from "../app.ts";
import { one, all, run } from "../db/db.ts";
import { fmtDateTime, fmtDate, fmtKm, fmtBps, parseScaled, zurichPeriodStart } from "../lib/format.ts";
import { newId } from "../lib/security.ts";
import {
  confirmBooking, assignBooking, unassignBooking, cancelBooking, completeBooking, listBookings, getBooking, type BookingRow,
} from "../services/bookings.ts";
import {
  setCustomerStatus, createDriver, setDriverStatus, setDriverShare, regenerateDriverSetup, createPasswordReset,
  validDateOrNull, validatePhone, DomainError,
} from "../services/users.ts";
import { addEarningAdjustment, markEarningsPaid } from "../services/payments.ts";
import { getSetting } from "../services/settings.ts";
import { audit } from "../services/audit.ts";
import { TERMINAL } from "../domain/bookings/booking-state.ts";
import { priceLines } from "./customer.ts";
import { registerAdminFinance } from "./admin-finance.ts";

export const PAGE = 50;
export function pageOf(ctx: Ctx): number { return Math.max(1, Math.min(10_000, Number(ctx.query.get("page") ?? "1") || 1)); }
export function pager(ctx: Ctx, count: number): Raw {
  const p = pageOf(ctx);
  const q = (n: number) => { const s = new URLSearchParams(ctx.query); s.set("page", String(n)); return `${ctx.path}?${s}`; };
  return html`<div class="pager">${p > 1 ? html`<a class="btn btn-sm" href="${q(p - 1)}">Précédent</a>` : ""}
    <span class="small muted">Page ${p}</span>${count === PAGE ? html`<a class="btn btn-sm" href="${q(p + 1)}">Suivant</a>` : ""}</div>`;
}
const like = (s: string) => `%${s.replace(/[%_]/g, "")}%`;
const terminalList = [...TERMINAL].map((s) => `'${s}'`).join(",");

export function registerAdmin(r: Router, d: Deps): void {
  const A = (ctx: Ctx) => auditActor(ctx);

  // --- Tableau de bord (§46) ---------------------------------------------------------------
  r.get("/admin", (ctx) => {
    need(ctx, "finance:read_all");
    const day = zurichPeriodStart("day"), month = zurichPeriodStart("month");
    const sum = (from: string) => one<{ s: number | null; n: number }>(d.db, "SELECT SUM(gross_amount) AS s, COUNT(*) AS n FROM driver_earnings WHERE created_at >= ?", from)!;
    const today = sum(day), mtd = sum(month);
    const count = (sql: string, ...p: string[]) => one<{ n: number }>(d.db, sql, ...p)!.n;
    const inProgress = count("SELECT COUNT(*) AS n FROM bookings WHERE status IN ('DRIVER_ARRIVING','DRIVER_ARRIVED','PASSENGER_ONBOARD','IN_PROGRESS')");
    const toConfirm = count("SELECT COUNT(*) AS n FROM bookings WHERE status = 'REQUESTED'");
    const unassigned = count("SELECT COUNT(*) AS n FROM bookings WHERE status = 'CONFIRMED'");
    const upcoming = count(`SELECT COUNT(*) AS n FROM bookings WHERE status NOT IN (${terminalList}) AND pickup_at >= ?`, new Date().toISOString());
    const pending = count("SELECT COUNT(*) AS n FROM users WHERE role = 'CUSTOMER' AND status = 'PENDING_APPROVAL'");
    const drivers = count("SELECT COUNT(*) AS n FROM users WHERE role = 'DRIVER' AND status = 'ACTIVE'");
    const cash = one<{ s: number | null }>(d.db, "SELECT SUM(declared_amount) AS s FROM cash_transactions WHERE status IN ('COLLECTED','DISPUTED')")!.s ?? 0;
    const unpaid = one<{ s: number | null }>(d.db, "SELECT SUM(total) AS s FROM invoices WHERE status = 'ISSUED'")!.s ?? 0;
    const alerts = documentAlerts(d);
    const stat = (label: string, value: Raw | number | string, sub: Raw | string = "", href = "") => html`<div class="stat"><div class="label">${label}</div>
      <div class="value">${href ? html`<a href="${href}">${value}</a>` : value}</div>${sub ? html`<div class="sub">${sub}</div>` : ""}</div>`;
    send(ctx, 200, layout(ctx, "Tableau de bord", html`<div class="row between"><h1>Tableau de bord</h1>
      <form method="get" action="/admin/search" class="row"><label class="sr-only" for="q">Recherche</label><input id="q" name="q" placeholder="Rechercher…"><button class="btn btn-sm" type="submit">OK</button></form></div>
      ${d.payments ? "" : html`<div class="alert alert-warn">Paiement en ligne non connecté : seuls les paiements en espèces sont proposés. Voir PAYMENTS.md.</div>`}
      <div class="grid grid-4">
        ${stat("CA du jour", money(today.s ?? 0), `${today.n} courses terminées`)}${stat("CA du mois", money(mtd.s ?? 0), `${mtd.n} courses`)}
        ${stat("En cours", inProgress, "", "/admin/dispatch")}${stat("À venir", upcoming, "", "/admin/bookings")}
        ${stat("À confirmer", toConfirm, "demandes à chiffrer", "/admin/bookings?status=REQUESTED")}${stat("À attribuer", unassigned, "", "/admin/dispatch")}
        ${stat("Cash à rapprocher", money(cash), "", "/admin/payments")}${stat("Factures impayées", money(unpaid), "", "/admin/invoices?status=ISSUED")}
        ${stat("Adhésions à valider", pending, "", "/admin/customers?status=PENDING_APPROVAL")}${stat("Chauffeurs actifs", drivers, "", "/admin/drivers")}
        ${stat("Alertes documents", alerts.length, "", "/admin/documents")}
      </div>`));
  });

  r.get("/admin/dashboard", (ctx) => redirect(ctx, "/admin"));

  // --- Recherche globale (§130) -----------------------------------------------------------------
  r.get("/admin/search", (ctx) => {
    need(ctx, "customer:read_any");
    const q = (ctx.query.get("q") ?? "").trim().slice(0, 80);
    const L = like(q);
    const users = q ? all<{ id: string; role: string; first_name: string; last_name: string; email: string; status: string }>(d.db,
      "SELECT id, role, first_name, last_name, email, status FROM users WHERE (email LIKE ? OR first_name || ' ' || last_name LIKE ? OR phone LIKE ?) AND deleted_at IS NULL LIMIT 20", L, L, L) : [];
    const bookings = q ? all<{ id: string; number: string; pickup_address: string; status: string }>(d.db,
      "SELECT id, number, pickup_address, status FROM bookings WHERE number LIKE ? OR pickup_address LIKE ? OR dropoff_address LIKE ? LIMIT 20", L, L, L) : [];
    const invoices = q ? all<{ id: string; number: string; total: number }>(d.db, "SELECT id, number, total FROM invoices WHERE number LIKE ? LIMIT 20", L) : [];
    const vehicles = q ? all<{ id: string; plate: string; make: string; model: string }>(d.db, "SELECT id, plate, make, model FROM vehicles WHERE plate LIKE ? OR model LIKE ? LIMIT 20", L, L) : [];
    const invites = q ? all<{ code: string; inviter_user_id: string | null }>(d.db, "SELECT code, inviter_user_id FROM invitations WHERE kind = 'CUSTOMER' AND code LIKE ? LIMIT 20", L) : [];
    const payments = q ? all<{ id: string; booking_id: string; provider_ref: string }>(d.db, "SELECT id, booking_id, provider_ref FROM payments WHERE provider_ref LIKE ? LIMIT 20", L) : [];
    const link = (u: { id: string; role: string }) => u.role === "DRIVER" ? `/admin/drivers/${u.id}` : `/admin/customers/${u.id}`;
    send(ctx, 200, layout(ctx, "Recherche", html`<h1>Recherche</h1>
      <form method="get" class="filters">${fieldInput("q", "Client, chauffeur, course, facture, paiement, véhicule, invitation", { value: q })}<button class="btn" type="submit">Rechercher</button></form>
      ${q && !users.length && !bookings.length && !invoices.length && !vehicles.length && !invites.length && !payments.length ? empty("Aucun résultat") : ""}
      ${users.length ? html`<div class="card"><h3>Personnes</h3>${users.map((u) => html`<div class="row between"><a href="${link(u)}">${u.first_name} ${u.last_name} — ${u.email}</a>${badge(u.status)}</div>`)}</div>` : ""}
      ${bookings.length ? html`<div class="card"><h3>Courses</h3>${bookings.map((b) => html`<div class="row between"><a href="/admin/bookings/${b.id}">${b.number} — ${b.pickup_address}</a>${badge(b.status)}</div>`)}</div>` : ""}
      ${invoices.length ? html`<div class="card"><h3>Factures</h3>${invoices.map((i) => html`<div class="row between"><a href="/admin/invoices/${i.id}">${i.number}</a>${money(i.total)}</div>`)}</div>` : ""}
      ${vehicles.length ? html`<div class="card"><h3>Véhicules</h3>${vehicles.map((v) => html`<div><a href="/admin/vehicles/${v.id}">${v.plate} — ${v.make} ${v.model}</a></div>`)}</div>` : ""}
      ${invites.length ? html`<div class="card"><h3>Invitations</h3>${invites.map((i) => html`<div><a href="/admin/referrals?q=${i.code}">${i.code}</a></div>`)}</div>` : ""}
      ${payments.length ? html`<div class="card"><h3>Paiements</h3>${payments.map((p) => html`<div><a href="/admin/bookings/${p.booking_id}">${p.provider_ref}</a></div>`)}</div>` : ""}`));
  });

  // --- Courses ----------------------------------------------------------------------------------
  r.get("/admin/bookings", (ctx) => {
    need(ctx, "booking:read_any");
    const status = ctx.query.get("status") ?? "", q = (ctx.query.get("q") ?? "").trim().slice(0, 80), date = ctx.query.get("date") ?? "";
    const where: string[] = [], params: (string | number)[] = [];
    if (status) { where.push("b.status = ?"); params.push(status); }
    if (q) { where.push("(b.number LIKE ? OR b.pickup_address LIKE ? OR b.dropoff_address LIKE ? OR cu.last_name LIKE ?)"); params.push(like(q), like(q), like(q), like(q)); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) { where.push("substr(b.pickup_at, 1, 10) BETWEEN ? AND ?"); params.push(date, date); }
    const rows = listBookings(d.db, `${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY b.pickup_at DESC LIMIT ${PAGE} OFFSET ${(pageOf(ctx) - 1) * PAGE}`, ...params);
    const statuses: [string, string][] = [["", "Tous les statuts"], ...["REQUESTED", "CONFIRMED", "ASSIGNED", "DRIVER_ACCEPTED", "IN_PROGRESS", "COMPLETED", "CANCELLED_BY_CUSTOMER", "CANCELLED_BY_COMPANY", "NO_SHOW", "REFUNDED"].map((s) => [s, s] as [string, string])];
    send(ctx, 200, layout(ctx, "Courses", html`<div class="row between"><h1>Courses</h1><a class="btn btn-sm" href="/admin/export/bookings">Export CSV</a></div>
      <form class="filters" method="get">${fieldInput("q", "Recherche", { value: q })}${fieldSelect("status", "Statut", statuses, status)}${fieldInput("date", "Date (UTC)", { type: "date", value: date })}<button class="btn" type="submit">Filtrer</button></form>
      ${rows.length ? bookingTable(rows) : empty("Aucune course")}${pager(ctx, rows.length)}`));
  });

  r.get("/admin/bookings/:id", (ctx) => {
    need(ctx, "booking:read_any");
    const b = listBookings(d.db, "WHERE b.id = ?", ctx.params.id!)[0];
    if (!b) throw new HttpError(404, "Course introuvable.");
    const hist = all<{ from_status: string | null; to_status: string; actor_role: string; note: string; at: string }>(d.db, "SELECT * FROM booking_status_history WHERE booking_id = ? ORDER BY at", b.id);
    const earning = one<{ gross_amount: number; driver_share_bps: number; driver_amount: number; company_amount: number; status: string }>(d.db, "SELECT * FROM driver_earnings WHERE booking_id = ?", b.id);
    const invoice = one<{ id: string; number: string; status: string }>(d.db, "SELECT id, number, status FROM invoices WHERE booking_id = ?", b.id);
    const payments = all<{ id: string; method: string; amount: number; refunded_amount: number; status: string; provider_ref: string | null }>(d.db, "SELECT * FROM payments WHERE booking_id = ? ORDER BY created_at", b.id);
    const drivers = all<{ id: string; first_name: string; last_name: string }>(d.db, "SELECT id, first_name, last_name FROM users WHERE role = 'DRIVER' AND status = 'ACTIVE' ORDER BY first_name");
    const vehicles = all<{ id: string; plate: string; make: string; model: string; seats: number }>(d.db, "SELECT id, plate, make, model, seats FROM vehicles WHERE deleted_at IS NULL AND status NOT IN ('MAINTENANCE','INACTIVE') ORDER BY plate");
    const cust = one<{ phone: string; email: string }>(d.db, "SELECT phone, email FROM users WHERE id = ?", b.customer_id)!;
    send(ctx, 200, layout(ctx, `Course ${b.number}`, html`<div class="row between"><h1>${b.number}</h1>${badge(b.status)}</div>
      <div class="grid grid-2"><div class="card"><dl class="kv">
        <dt>Client</dt><dd><a href="/admin/customers/${b.customer_id}">${b.customer_name}</a><div class="small muted">${b.contact_phone || cust.phone} · ${cust.email}</div></dd>
        <dt>Prise en charge</dt><dd>${fmtDateTime(b.pickup_at)}${b.is_immediate ? " — IMMÉDIATE" : ""}</dd>
        <dt>Départ</dt><dd>${b.pickup_address}</dd><dt>Destination</dt><dd>${b.dropoff_address}</dd>
        <dt>Passagers</dt><dd>${b.passengers} · bagages ${b.luggage}</dd><dt>Paiement</dt><dd>${b.payment_method === "CASH" ? "Espèces" : "En ligne"}</dd>
        <dt>Chauffeur</dt><dd>${b.driver_name ?? "—"}</dd><dt>Véhicule</dt><dd>${b.plate ?? "—"}</dd>
        <dt>Estimation</dt><dd>${money(b.quote_total)} ${b.estimated_distance_m !== null ? html`<span class="small muted">(${fmtKm(b.estimated_distance_m)})</span>` : ""}</dd>
        <dt>Montant final</dt><dd>${money(b.final_total)} ${b.final_distance_m !== null ? html`<span class="small muted">(${fmtKm(b.final_distance_m)}, attente ${b.waiting_minutes} min)</span>` : ""}</dd>
        ${b.notes ? html`<dt>Notes</dt><dd>${b.notes}</dd>` : ""}${b.cancel_reason ? html`<dt>Annulation</dt><dd>${b.cancel_reason}</dd>` : ""}
      </dl></div>
      <div>
        ${b.status === "REQUESTED" ? html`<form class="card gold" method="post" action="/admin/bookings/${b.id}/confirm">${csrf(ctx)}<h3>Confirmer et chiffrer</h3>
          ${fieldInput("km", "Distance estimée (km)", { inputmode: "decimal", required: true, placeholder: "ex. 12.5" })}
          <button class="btn btn-primary" type="submit">Confirmer la course</button></form>` : ""}
        ${b.status === "CONFIRMED" ? html`<form class="card gold" method="post" action="/admin/bookings/${b.id}/assign">${csrf(ctx)}<h3>Attribuer</h3>
          ${drivers.length ? fieldSelect("driver_id", "Chauffeur", drivers.map((x) => [x.id, `${x.first_name} ${x.last_name}`])) : html`<p class="muted">Aucun chauffeur actif.</p>`}
          ${vehicles.length ? fieldSelect("vehicle_id", "Véhicule", vehicles.map((v) => [v.id, `${v.plate} — ${v.make} ${v.model} (${v.seats} pl.)`])) : html`<p class="muted">Aucun véhicule disponible.</p>`}
          <button class="btn btn-primary" type="submit"${drivers.length && vehicles.length ? "" : raw(" disabled")}>Attribuer</button></form>` : ""}
        ${["ASSIGNED", "DRIVER_ACCEPTED"].includes(b.status) ? html`<div class="card">${actionButton(ctx, `/admin/bookings/${b.id}/unassign`, "Retirer le chauffeur")}</div>` : ""}
        ${b.status === "IN_PROGRESS" ? html`<form class="card" method="post" action="/admin/bookings/${b.id}/complete">${csrf(ctx)}<h3>Clôturer pour le chauffeur</h3>
          ${fieldInput("km", "Kilomètres parcourus", { inputmode: "decimal", required: true })}<button class="btn" type="submit">Clôturer</button></form>` : ""}
        ${!TERMINAL.has(b.status) && !["IN_PROGRESS", "PASSENGER_ONBOARD"].includes(b.status) ? html`<form class="card" method="post" action="/admin/bookings/${b.id}/cancel">${csrf(ctx)}<h3>Annuler</h3>
          ${fieldInput("reason", "Motif (communiqué au client)", { required: true })}<label class="check small"><input type="checkbox" name="confirm" value="yes" required> Êtes-vous sûr de vouloir annuler cette course ?</label>
          <button class="btn btn-danger" type="submit">Annuler la course</button></form>` : ""}
        ${earning ? html`<div class="card"><h3>Snapshot financier</h3><dl class="kv"><dt>CA</dt><dd>${money(earning.gross_amount)}</dd><dt>Taux chauffeur</dt><dd>${fmtBps(earning.driver_share_bps)}</dd>
          <dt>Part chauffeur</dt><dd>${money(earning.driver_amount)} ${badge(earning.status)}</dd><dt>Part entreprise</dt><dd>${money(earning.company_amount)}</dd></dl></div>` : ""}
        ${invoice ? html`<div class="card"><h3>Facture</h3><a href="/admin/invoices/${invoice.id}">${invoice.number}</a> ${badge(invoice.status)}</div>` : ""}
        ${payments.length ? html`<div class="card"><h3>Paiements</h3>${payments.map((p) => html`<div class="row between"><span>${p.method} ${money(p.amount)}${p.refunded_amount ? html` (remb. ${money(p.refunded_amount)})` : ""}</span>${badge(p.status)}
          ${["PAID", "PARTIALLY_REFUNDED"].includes(p.status) ? html`<a class="btn btn-sm" href="/admin/payments/${p.id}/refund">Rembourser</a>` : ""}</div>`)}</div>` : ""}
      </div></div>
      ${b.price_lines ? html`<div class="card"><h3>Détail du prix</h3>${priceLines(b.price_lines)}</div>` : ""}
      <div class="card"><h3>Historique</h3><div class="table-wrap"><table><tbody>${hist.map((h) => html`<tr><td>${fmtDateTime(h.at)}</td><td>${h.from_status ?? "—"} → ${h.to_status}</td><td>${h.actor_role}</td><td class="small muted">${h.note}</td></tr>`)}</tbody></table></div></div>`));
  });

  r.post("/admin/bookings/:id/confirm", (ctx) => {
    need(ctx, "booking:set_price");
    const meters = parseScaled(field(ctx, "km", 12), 3, 1_000_000);
    if (meters === null) throw new DomainError("Distance invalide (ex. 12.5).");
    confirmBooking(d.db, A(ctx), ctx.params.id!, meters, d.notifier);
    redirect(ctx, `/admin/bookings/${ctx.params.id!}`, "Course confirmée, client notifié.");
  });
  r.post("/admin/bookings/:id/assign", (ctx) => {
    need(ctx, "booking:assign");
    assignBooking(d.db, A(ctx), ctx.params.id!, field(ctx, "driver_id", 40), field(ctx, "vehicle_id", 40), d.notifier);
    redirect(ctx, field(ctx, "back", 40) === "dispatch" ? "/admin/dispatch" : `/admin/bookings/${ctx.params.id!}`, "Course attribuée, chauffeur notifié.");
  });
  r.post("/admin/bookings/:id/unassign", (ctx) => {
    need(ctx, "booking:assign");
    unassignBooking(d.db, A(ctx), ctx.params.id!);
    redirect(ctx, `/admin/bookings/${ctx.params.id!}`, "Chauffeur retiré.");
  });
  r.post("/admin/bookings/:id/cancel", (ctx) => {
    need(ctx, "booking:assign");
    if (ctx.form.get("confirm") !== "yes") throw new DomainError("Veuillez confirmer.");
    cancelBooking(d.db, A(ctx), ctx.params.id!, field(ctx, "reason", 300), d.notifier);
    redirect(ctx, `/admin/bookings/${ctx.params.id!}`, "Course annulée.");
  });
  r.post("/admin/bookings/:id/complete", (ctx) => {
    need(ctx, "booking:assign");
    const meters = parseScaled(field(ctx, "km", 12), 3, 1_000_000);
    if (meters === null) throw new DomainError("Kilométrage invalide.");
    completeBooking(d.db, A(ctx), ctx.params.id!, { distanceMeters: meters, cashDeclared: null }, d.notifier);
    redirect(ctx, `/admin/bookings/${ctx.params.id!}`, "Course clôturée.");
  });

  // --- Dispatch (§10, §47) ---------------------------------------------------------------------------
  r.get("/admin/dispatch", (ctx) => {
    need(ctx, "booking:assign");
    const since = new Date(Date.now() - 12 * 3600_000).toISOString();
    const rows = listBookings(d.db, "WHERE (b.status NOT IN (" + terminalList + ") OR b.updated_at >= ?) ORDER BY b.pickup_at LIMIT 300", since);
    const cols: [string, string[]][] = [
      ["À CONFIRMER", ["REQUESTED"]], ["NON ASSIGNÉES", ["CONFIRMED"]], ["ASSIGNÉES", ["ASSIGNED", "DRIVER_ACCEPTED"]],
      ["EN COURS", ["DRIVER_ARRIVING", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS"]], ["TERMINÉES", ["COMPLETED"]],
    ];
    const drivers = all<{ id: string; name: string; busy: number }>(d.db, `SELECT u.id, u.first_name || ' ' || u.last_name AS name,
      (SELECT COUNT(*) FROM bookings b WHERE b.assigned_driver_id = u.id AND b.status IN ('DRIVER_ARRIVING','DRIVER_ARRIVED','PASSENGER_ONBOARD','IN_PROGRESS')) AS busy
      FROM users u WHERE u.role = 'DRIVER' AND u.status = 'ACTIVE' ORDER BY name`);
    const vehicles = all<{ id: string; plate: string }>(d.db, "SELECT id, plate FROM vehicles WHERE deleted_at IS NULL AND status NOT IN ('MAINTENANCE','INACTIVE') ORDER BY plate");
    send(ctx, 200, layout(ctx, "Dispatch", html`<h1>Dispatch</h1>
      <div class="card"><h3>Chauffeurs</h3><div class="row">${drivers.length ? drivers.map((x) => html`<span class="badge ${x.busy ? "badge-warn" : "badge-ok"}">${x.name} · ${x.busy ? "occupé" : "disponible"}</span>`) : html`<span class="muted">Aucun chauffeur actif.</span>`}</div></div>
      <div class="board">${cols.map(([title, sts]) => {
        const items = rows.filter((b) => sts.includes(b.status));
        return html`<section class="col" aria-label="${title}"><h3><span>${title}</span><span>${items.length}</span></h3>
          ${items.length ? items.map((b) => html`<div class="tile"><a class="t" href="/admin/bookings/${b.id}">${fmtDateTime(b.pickup_at)}</a>${b.is_immediate ? html` <span class="badge badge-danger">immédiate</span>` : ""}
            <div>${b.pickup_address}</div><div class="muted">→ ${b.dropoff_address}</div><div class="small muted">${b.customer_name}${b.driver_name ? ` · ${b.driver_name}` : ""}</div>
            <div class="row between">${badge(b.status)}${money(b.final_total ?? b.quote_total)}</div>
            ${b.status === "CONFIRMED" && drivers.length && vehicles.length ? html`<form method="post" action="/admin/bookings/${b.id}/assign">${csrf(ctx)}<input type="hidden" name="back" value="dispatch">
              <label class="sr-only" for="d_${b.id}">Chauffeur</label><select id="d_${b.id}" name="driver_id">${drivers.map((x) => html`<option value="${x.id}">${x.name}</option>`)}</select>
              <label class="sr-only" for="v_${b.id}">Véhicule</label><select id="v_${b.id}" name="vehicle_id">${vehicles.map((v) => html`<option value="${v.id}">${v.plate}</option>`)}</select>
              <button class="btn btn-sm btn-primary" type="submit">Attribuer</button></form>` : ""}</div>`) : html`<p class="small muted">—</p>`}</section>`;
      })}</div>`));
  });

  // --- Clients (§31) --------------------------------------------------------------------------------
  r.get("/admin/customers/pending", (ctx) => redirect(ctx, "/admin/customers?status=PENDING_APPROVAL"));
  r.get("/admin/customers", (ctx) => {
    need(ctx, "customer:read_any");
    const status = ctx.query.get("status") ?? "", q = (ctx.query.get("q") ?? "").trim().slice(0, 80);
    const where = ["u.role = 'CUSTOMER'", "u.deleted_at IS NULL"], params: string[] = [];
    if (status) { where.push("u.status = ?"); params.push(status); }
    if (q) { where.push("(u.email LIKE ? OR u.first_name || ' ' || u.last_name LIKE ? OR u.phone LIKE ?)"); params.push(like(q), like(q), like(q)); }
    const rows = all<{ id: string; first_name: string; last_name: string; email: string; status: string; created_at: string; inviter: string | null; trips: number; admin_notes: string }>(d.db,
      `SELECT u.id, u.first_name, u.last_name, u.email, u.status, u.created_at, u.admin_notes, (i.first_name || ' ' || i.last_name) AS inviter,
       (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = u.id AND b.status = 'COMPLETED') AS trips
       FROM users u LEFT JOIN users i ON i.id = u.invited_by WHERE ${where.join(" AND ")} ORDER BY u.created_at DESC LIMIT ${PAGE} OFFSET ${(pageOf(ctx) - 1) * PAGE}`, ...params);
    send(ctx, 200, layout(ctx, "Clients", html`<div class="row between"><h1>Clients</h1><a class="btn btn-sm" href="/admin/export/customers">Export CSV</a></div>
      <form class="filters" method="get">${fieldInput("q", "Recherche", { value: q })}
        ${fieldSelect("status", "Statut", [["", "Tous"], ["PENDING_APPROVAL", "À valider"], ["APPROVED", "Membres"], ["SUSPENDED", "Suspendus"], ["REJECTED", "Refusés"], ["BLOCKED", "Bloqués"]], status)}
        <button class="btn" type="submit">Filtrer</button></form>
      ${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Client</th><th>Invité par</th><th>Demande</th><th class="r">Courses</th><th>Statut</th><th></th></tr></thead><tbody>
        ${rows.map((c) => html`<tr><td><a href="/admin/customers/${c.id}">${c.first_name} ${c.last_name}</a><div class="small muted">${c.email}</div>${c.admin_notes.startsWith("[Alerte") ? html`<span class="badge badge-danger">alerte</span>` : ""}</td>
          <td>${c.inviter ?? html`<span class="muted">—</span>`}</td><td>${fmtDate(c.created_at)}</td><td class="r num">${c.trips}</td><td>${badge(c.status)}</td>
          <td>${c.status === "PENDING_APPROVAL" ? html`${actionButton(ctx, `/admin/customers/${c.id}/status`, "Accepter", { cls: "btn-sm btn-primary", fields: { status: "APPROVED" } })}` : ""}</td></tr>`)}
      </tbody></table></div>` : empty("Aucun client")}${pager(ctx, rows.length)}`));
  });

  r.get("/admin/customers/:id", (ctx) => {
    need(ctx, "customer:read_any");
    const c = one<{ id: string; first_name: string; last_name: string; email: string; phone: string; status: string; created_at: string; approved_at: string | null;
      approved_by: string | null; invited_by: string | null; invitation_id: string | null; admin_notes: string; referral_code: string | null }>(d.db,
      "SELECT * FROM users WHERE id = ? AND role = 'CUSTOMER'", ctx.params.id!);
    if (!c) throw new HttpError(404, "Client introuvable.");
    const inviter = c.invited_by ? one<{ id: string; first_name: string; last_name: string; role: string }>(d.db, "SELECT id, first_name, last_name, role FROM users WHERE id = ?", c.invited_by) : undefined;
    const inv = c.invitation_id ? one<{ code: string; created_at: string; last_used_at: string | null; source: string; campaign: string; last_used_ua: string | null }>(d.db, "SELECT * FROM invitations WHERE id = ?", c.invitation_id) : undefined;
    const approver = c.approved_by ? one<{ first_name: string }>(d.db, "SELECT first_name FROM users WHERE id = ?", c.approved_by) : undefined;
    const bookings = listBookings(d.db, "WHERE b.customer_id = ? ORDER BY b.pickup_at DESC LIMIT 20", c.id);
    const invoices = all<{ id: string; number: string; total: number; status: string; issued_at: string }>(d.db, "SELECT id, number, total, status, issued_at FROM invoices WHERE customer_id = ? ORDER BY issued_at DESC LIMIT 20", c.id);
    const rewards = all<{ amount: number; note: string; created_at: string }>(d.db, "SELECT amount, note, created_at FROM reward_ledger WHERE user_id = ? ORDER BY created_at DESC", c.id);
    const invited = all<{ id: string; first_name: string; last_name: string; status: string }>(d.db, "SELECT id, first_name, last_name, status FROM users WHERE invited_by = ?", c.id);
    const st = (s: string, label: string, cls = "", confirm = "") => actionButton(ctx, `/admin/customers/${c.id}/status`, label, { cls, fields: { status: s }, ...(confirm ? { confirm } : {}) });
    send(ctx, 200, layout(ctx, `${c.first_name} ${c.last_name}`, html`<div class="row between"><h1>${c.first_name} ${c.last_name}</h1>${badge(c.status)}</div>
      <div class="row">${c.status !== "APPROVED" ? st("APPROVED", c.status === "PENDING_APPROVAL" ? "Accepter" : "Réactiver", "btn-primary") : ""}
        ${c.status === "PENDING_APPROVAL" ? st("REJECTED", "Refuser", "btn-danger", "Confirmer le refus") : ""}
        ${c.status === "APPROVED" ? st("SUSPENDED", "Suspendre", "btn-danger", "Êtes-vous sûr de vouloir suspendre ce client ?") : ""}
        ${c.status !== "BLOCKED" ? st("BLOCKED", "Bloquer", "btn-danger", "Êtes-vous sûr de vouloir bloquer ce client ?") : ""}
        ${actionButton(ctx, `/admin/users/${c.id}/reset-link`, "Lien de réinitialisation")}</div>
      <div class="grid grid-2"><div class="card"><h3>Profil</h3><dl class="kv"><dt>E-mail</dt><dd>${c.email}</dd><dt>Téléphone</dt><dd>${c.phone}</dd>
        <dt>Demande</dt><dd>${fmtDateTime(c.created_at)}</dd><dt>Approuvé</dt><dd>${c.approved_at ? html`${fmtDateTime(c.approved_at)} par ${approver?.first_name ?? "—"}` : "—"}</dd>
        <dt>Code membre</dt><dd class="num">${c.referral_code ?? "—"}</dd></dl></div>
      <div class="card"><h3>Origine (§6)</h3><dl class="kv"><dt>Invité par</dt><dd>${inviter ? html`<a href="${inviter.role === "CUSTOMER" ? `/admin/customers/${inviter.id}` : "/admin"}">${inviter.first_name} ${inviter.last_name}</a>` : "Demande directe"}</dd>
        <dt>Code utilisé</dt><dd class="num">${inv?.code ?? "—"}</dd><dt>Lien</dt><dd class="small">${inv ? `${d.env.appUrl}/invite/${inv.code}` : "—"}</dd>
        <dt>Invitation créée</dt><dd>${fmtDateTime(inv?.created_at)}</dd><dt>Utilisée</dt><dd>${fmtDateTime(inv?.last_used_at)}</dd>
        <dt>Source</dt><dd>${inv ? `${inv.source} ${inv.campaign}` : "—"}</dd><dt>Navigateur</dt><dd class="small muted">${inv?.last_used_ua ?? "—"}</dd></dl></div></div>
      <form class="card" method="post" action="/admin/customers/${c.id}/notes">${csrf(ctx)}${fieldTextarea("notes", "Notes internes (jamais visibles du client)", c.admin_notes)}<button class="btn btn-sm" type="submit">Enregistrer</button></form>
      <div class="card"><h3>Courses</h3>${bookings.length ? bookingTable(bookings) : html`<p class="muted">Aucune.</p>`}</div>
      <div class="grid grid-2"><div class="card"><h3>Factures</h3>${invoices.length ? invoices.map((i) => html`<div class="row between"><a href="/admin/invoices/${i.id}">${i.number}</a><span>${money(i.total)} ${badge(i.status)}</span></div>`) : html`<p class="muted">Aucune.</p>`}</div>
        <div class="card"><h3>Récompenses</h3>${rewards.map((x) => html`<div class="row between small"><span>${x.note}</span>${money(x.amount)}</div>`)}
          <form method="post" action="/admin/customers/${c.id}/reward">${csrf(ctx)}<div class="grid grid-2">${fieldInput("amount", "Montant CHF (négatif = débit)", { inputmode: "decimal", required: true })}${fieldInput("note", "Motif", { required: true })}</div>
          <button class="btn btn-sm" type="submit">Enregistrer</button></form>
          <h3>Personnes invitées</h3>${invited.length ? invited.map((x) => html`<div class="row between"><a href="/admin/customers/${x.id}">${x.first_name} ${x.last_name}</a>${badge(x.status)}</div>`) : html`<p class="muted small">Aucune.</p>`}</div></div>`));
  });

  r.post("/admin/customers/:id/status", (ctx) => {
    const status = field(ctx, "status", 20);
    const perm = status === "APPROVED" ? "customer:approve" : status === "REJECTED" ? "customer:reject" : "customer:suspend";
    need(ctx, perm);
    if (!["APPROVED", "REJECTED", "SUSPENDED", "BLOCKED"].includes(status)) throw new DomainError("Statut invalide.");
    if (status !== "APPROVED" && ctx.form.get("confirm") !== "yes") throw new DomainError("Veuillez confirmer l'action.");
    setCustomerStatus(d.db, A(ctx), ctx.params.id!, status as "APPROVED", d.notifier);
    redirect(ctx, String(ctx.req.headers.referer ?? "").includes("/admin/customers?") ? "/admin/customers?status=PENDING_APPROVAL" : `/admin/customers/${ctx.params.id!}`, "Statut mis à jour.");
  });
  r.post("/admin/customers/:id/notes", (ctx) => {
    need(ctx, "customer:suspend");
    run(d.db, "UPDATE users SET admin_notes = ? WHERE id = ? AND role = 'CUSTOMER'", field(ctx, "notes", 2000), ctx.params.id!);
    audit(d.db, A(ctx), "CUSTOMER_NOTES_UPDATED", "user", ctx.params.id!);
    redirect(ctx, `/admin/customers/${ctx.params.id!}`, "Notes enregistrées.");
  });
  r.post("/admin/customers/:id/reward", (ctx) => {
    need(ctx, "reward:manage");
    const raw = field(ctx, "amount", 14), neg = raw.startsWith("-");
    const v = parseScaled(neg ? raw.slice(1) : raw, 2, 100_000_00);
    const note = field(ctx, "note", 200);
    if (v === null || v === 0) throw new DomainError("Montant invalide.");
    if (note.length < 3) throw new DomainError("Motif obligatoire.");
    const amount = neg ? -v : v;
    run(d.db, "INSERT INTO reward_ledger (id, user_id, amount, kind, reference, note, created_by, created_at) VALUES (?, ?, ?, 'MANUAL', ?, ?, ?, ?)",
      newId(), ctx.params.id!, amount, `manual:${newId()}`, note, ctx.user!.id, new Date().toISOString());
    audit(d.db, A(ctx), "REWARD_MANUAL", "user", ctx.params.id!, "SUCCESS", { amount, note });
    redirect(ctx, `/admin/customers/${ctx.params.id!}`, "Récompense enregistrée.");
  });
  r.post("/admin/users/:id/reset-link", (ctx) => {
    need(ctx, "customer:suspend");
    const u = one<{ email: string; role: string }>(d.db, "SELECT email, role FROM users WHERE id = ?", ctx.params.id!);
    if (!u || u.role === "SUPER_ADMIN") throw new HttpError(404, "Utilisateur introuvable.");
    const res = createPasswordReset(d.db, u.email, A(ctx));
    if (!res) throw new DomainError("Ce compte n'a pas encore de mot de passe (utilisez le lien de configuration).");
    redirect(ctx, String(ctx.req.headers.referer ?? "").includes("/admin/drivers/") ? `/admin/drivers/${ctx.params.id!}` : `/admin/customers/${ctx.params.id!}`,
      `Lien valable 1 heure, à transmettre à la personne : ${d.env.appUrl}/reset/${res.token}`);
  });

  // --- Chauffeurs (§4, §28) ---------------------------------------------------------------------------
  r.get("/admin/drivers", (ctx) => {
    need(ctx, "driver:update");
    const rows = all<{ id: string; first_name: string; last_name: string; email: string; status: string; share_bps: number | null; license_expiry: string | null }>(d.db,
      "SELECT u.id, u.first_name, u.last_name, u.email, u.status, dp.share_bps, dp.license_expiry FROM users u JOIN driver_profiles dp ON dp.user_id = u.id WHERE u.role = 'DRIVER' AND u.deleted_at IS NULL ORDER BY u.first_name");
    const def = getSetting(d.db, "driver_share_bps");
    send(ctx, 200, layout(ctx, "Chauffeurs", html`<div class="row between"><h1>Chauffeurs</h1><a class="btn btn-primary" href="/admin/drivers/new">Ajouter un chauffeur</a></div>
      ${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Chauffeur</th><th>Taux</th><th>Permis</th><th>Statut</th></tr></thead><tbody>
        ${rows.map((x) => html`<tr><td><a href="/admin/drivers/${x.id}">${x.first_name} ${x.last_name}</a><div class="small muted">${x.email}</div></td>
          <td class="num">${fmtBps(x.share_bps ?? def)}${x.share_bps === null ? html` <span class="small muted">(défaut)</span>` : ""}</td><td>${fmtDate(x.license_expiry)}</td><td>${badge(x.status)}</td></tr>`)}
      </tbody></table></div>` : empty("Aucun chauffeur", "Ajoutez votre premier chauffeur : il recevra un lien pour configurer son compte.")}`));
  });

  r.get("/admin/drivers/new", (ctx) => {
    need(ctx, "driver:create");
    send(ctx, 200, layout(ctx, "Nouveau chauffeur", html`<h1>Nouveau chauffeur</h1>
      <form class="card gold" method="post" action="/admin/drivers/new">${csrf(ctx)}
        <div class="grid grid-2">${fieldInput("first_name", "Prénom", { required: true })}${fieldInput("last_name", "Nom", { required: true })}</div>
        <div class="grid grid-2">${fieldInput("email", "E-mail", { type: "email", required: true })}${fieldInput("phone", "Téléphone", { type: "tel" })}</div>
        <div class="grid grid-3">${fieldInput("license_number", "N° de permis")}${fieldInput("license_expiry", "Expiration du permis", { type: "date" })}${fieldInput("hired_at", "Date d'entrée", { type: "date" })}</div>
        <button class="btn btn-primary" type="submit">Créer et générer le lien d'invitation</button></form>`));
  });
  r.post("/admin/drivers/new", (ctx) => {
    need(ctx, "driver:create");
    const { driverId, setupToken } = createDriver(d.db, A(ctx), {
      email: field(ctx, "email", 254), phone: field(ctx, "phone", 30), firstName: field(ctx, "first_name", 80), lastName: field(ctx, "last_name", 80),
      licenseNumber: field(ctx, "license_number", 40), licenseExpiry: field(ctx, "license_expiry", 10), hiredAt: field(ctx, "hired_at", 10),
    });
    const u = one<{ id: string; email: string }>(d.db, "SELECT id, email FROM users WHERE id = ?", driverId)!;
    d.notifier.notify(u, "INVITATION", "Votre compte chauffeur", `${d.env.appUrl}/setup/${setupToken}`);
    redirect(ctx, `/admin/drivers/${driverId}`, `Chauffeur créé. Lien de configuration (7 jours) : ${d.env.appUrl}/setup/${setupToken}`);
  });

  r.get("/admin/drivers/:id", (ctx) => {
    need(ctx, "driver:update");
    const x = one<{ id: string; first_name: string; last_name: string; email: string; phone: string; status: string; share_bps: number | null; license_number: string; license_expiry: string | null; permit_expiry: string | null; hired_at: string | null; admin_notes: string; password_hash: string | null }>(d.db,
      "SELECT u.*, dp.share_bps, dp.license_number, dp.license_expiry, dp.permit_expiry, dp.hired_at FROM users u JOIN driver_profiles dp ON dp.user_id = u.id WHERE u.id = ?", ctx.params.id!);
    if (!x) throw new HttpError(404, "Chauffeur introuvable.");
    const def = getSetting(d.db, "driver_share_bps");
    const month = zurichPeriodStart("month");
    const e = one<{ n: number; g: number | null; m: number | null; unpaid: number | null }>(d.db,
      `SELECT COUNT(*) AS n, SUM(gross_amount) AS g, SUM(driver_amount) AS m,
       (SELECT SUM(driver_amount) FROM driver_earnings WHERE driver_id = ? AND status IN ('CALCULATED','PENDING_PAYMENT')) AS unpaid
       FROM driver_earnings WHERE driver_id = ? AND created_at >= ?`, x.id, x.id, month)!;
    const adj = all<{ amount: number; reason: string; created_at: string }>(d.db, "SELECT amount, reason, created_at FROM earning_adjustments WHERE driver_id = ? ORDER BY created_at DESC LIMIT 20", x.id);
    const docs = all<{ id: string; label: string; expires_at: string | null; verified_at: string | null }>(d.db, "SELECT id, label, expires_at, verified_at FROM documents WHERE owner_type = 'DRIVER' AND owner_id = ? AND deleted_at IS NULL", x.id);
    const st = (s: string, label: string, cls = "", confirm = "") => actionButton(ctx, `/admin/drivers/${x.id}/status`, label, { cls, fields: { status: s }, ...(confirm ? { confirm } : {}) });
    send(ctx, 200, layout(ctx, `${x.first_name} ${x.last_name}`, html`<div class="row between"><h1>${x.first_name} ${x.last_name}</h1>${badge(x.status)}</div>
      <div class="row">${x.status !== "ACTIVE" && x.password_hash ? st("ACTIVE", "Vérifier et activer", "btn-primary") : ""}
        ${x.status === "ACTIVE" ? st("SUSPENDED", "Suspendre", "btn-danger", "Êtes-vous sûr de vouloir suspendre ce chauffeur ?") : ""}
        ${x.status !== "INACTIVE" ? st("INACTIVE", "Désactiver", "btn-danger", "Confirmer la désactivation") : ""}
        ${!x.password_hash ? actionButton(ctx, `/admin/drivers/${x.id}/setup-link`, "Nouveau lien de configuration") : actionButton(ctx, `/admin/users/${x.id}/reset-link`, "Lien de réinitialisation")}</div>
      <div class="grid grid-2"><div class="card"><dl class="kv"><dt>E-mail</dt><dd>${x.email}</dd><dt>Téléphone</dt><dd>${x.phone}</dd>
        <dt>Permis</dt><dd>${x.license_number} — expire ${fmtDate(x.license_expiry)}</dd><dt>Autorisation</dt><dd>${fmtDate(x.permit_expiry)}</dd><dt>Entrée</dt><dd>${fmtDate(x.hired_at)}</dd></dl>
        <form method="post" action="/admin/drivers/${x.id}/profile">${csrf(ctx)}<div class="grid grid-2">
          ${fieldInput("phone", "Téléphone", { value: x.phone })}${fieldInput("license_number", "N° permis", { value: x.license_number })}
          ${fieldInput("license_expiry", "Expiration permis", { type: "date", value: x.license_expiry })}${fieldInput("permit_expiry", "Expiration autorisation", { type: "date", value: x.permit_expiry })}</div>
          ${fieldTextarea("notes", "Notes administratives", x.admin_notes)}<button class="btn btn-sm" type="submit">Enregistrer</button></form></div>
      <div class="card gold"><h3>Rémunération</h3><p>Taux appliqué : <strong class="num">${fmtBps(x.share_bps ?? def)}</strong> ${x.share_bps === null ? html`<span class="muted small">(taux par défaut)</span>` : ""}</p>
        <form method="post" action="/admin/drivers/${x.id}/share">${csrf(ctx)}${fieldInput("share", "Taux spécifique en % (vide = défaut)", { value: x.share_bps === null ? "" : String(x.share_bps / 100), inputmode: "decimal" })}
          <label class="check small"><input type="checkbox" name="confirm" value="yes" required> Je confirme la modification ; les courses déjà clôturées gardent leur taux.</label>
          <button class="btn btn-sm" type="submit">Enregistrer le taux</button></form>
        <div class="rule"></div><dl class="kv"><dt>Ce mois</dt><dd>${e.n} courses · CA ${money(e.g ?? 0)} · part ${money(e.m ?? 0)}</dd><dt>À verser</dt><dd>${money(e.unpaid ?? 0)}</dd></dl>
        ${actionButton(ctx, `/admin/drivers/${x.id}/paid`, "Marquer les rémunérations comme versées", { confirm: "Je confirme le versement" })}
        <form method="post" action="/admin/drivers/${x.id}/adjust">${csrf(ctx)}<div class="grid grid-2">${fieldInput("amount", "Ajustement CHF (négatif = retenue)", { inputmode: "decimal", required: true })}${fieldInput("reason", "Motif", { required: true })}</div>
          <button class="btn btn-sm" type="submit">Ajouter l'ajustement</button></form>
        ${adj.map((a) => html`<div class="row between small"><span>${a.reason} · ${fmtDate(a.created_at)}</span>${money(a.amount)}</div>`)}</div></div>
      <div class="card"><h3>Documents</h3>${docs.map((doc) => html`<div class="row between"><span>${doc.label} — expire ${fmtDate(doc.expires_at)}</span>${doc.verified_at ? badge("RECONCILED") : actionButton(ctx, `/admin/documents/${doc.id}/verify`, "Marquer vérifié", { cls: "btn-sm" })}</div>`)}
        ${docForm(ctx, "DRIVER", x.id)}</div>`));
  });

  r.post("/admin/drivers/:id/status", (ctx) => {
    need(ctx, "driver:set_status");
    const status = field(ctx, "status", 20);
    if (status !== "ACTIVE" && ctx.form.get("confirm") !== "yes") throw new DomainError("Veuillez confirmer l'action.");
    setDriverStatus(d.db, A(ctx), ctx.params.id!, status);
    redirect(ctx, `/admin/drivers/${ctx.params.id!}`, "Statut mis à jour.");
  });
  r.post("/admin/drivers/:id/setup-link", (ctx) => {
    need(ctx, "driver:create");
    const t = regenerateDriverSetup(d.db, A(ctx), ctx.params.id!);
    redirect(ctx, `/admin/drivers/${ctx.params.id!}`, `Nouveau lien (7 jours) : ${d.env.appUrl}/setup/${t}`);
  });
  r.post("/admin/drivers/:id/profile", (ctx) => {
    need(ctx, "driver:update");
    run(d.db, "UPDATE users SET phone = ?, admin_notes = ?, updated_at = ? WHERE id = ? AND role = 'DRIVER'", validatePhone(field(ctx, "phone", 30)), field(ctx, "notes", 2000), new Date().toISOString(), ctx.params.id!);
    run(d.db, "UPDATE driver_profiles SET license_number = ?, license_expiry = ?, permit_expiry = ? WHERE user_id = ?",
      field(ctx, "license_number", 40), validDateOrNull(field(ctx, "license_expiry", 10)), validDateOrNull(field(ctx, "permit_expiry", 10)), ctx.params.id!);
    audit(d.db, A(ctx), "DRIVER_UPDATED", "user", ctx.params.id!);
    redirect(ctx, `/admin/drivers/${ctx.params.id!}`, "Enregistré.");
  });
  r.post("/admin/drivers/:id/share", (ctx) => {
    need(ctx, "driver:set_share_rate");
    if (ctx.form.get("confirm") !== "yes") throw new DomainError("Veuillez confirmer la modification.");
    const v = field(ctx, "share", 8);
    const bps = v === "" ? null : parseScaled(v, 2, 10000);
    if (v !== "" && bps === null) throw new DomainError("Taux invalide (ex. 42.5).");
    setDriverShare(d.db, A(ctx), ctx.params.id!, bps);
    redirect(ctx, `/admin/drivers/${ctx.params.id!}`, "Taux enregistré. Il s'applique aux prochaines courses clôturées.");
  });
  r.post("/admin/drivers/:id/adjust", (ctx) => {
    need(ctx, "payment:manage");
    const raw = field(ctx, "amount", 14), neg = raw.startsWith("-");
    const v = parseScaled(neg ? raw.slice(1) : raw, 2, 100_000_00);
    if (v === null) throw new DomainError("Montant invalide.");
    addEarningAdjustment(d.db, A(ctx), ctx.params.id!, neg ? -v : v, field(ctx, "reason", 300));
    redirect(ctx, `/admin/drivers/${ctx.params.id!}`, "Ajustement enregistré.");
  });
  r.post("/admin/drivers/:id/paid", (ctx) => {
    need(ctx, "payment:manage");
    if (ctx.form.get("confirm") !== "yes") throw new DomainError("Veuillez confirmer.");
    const n = markEarningsPaid(d.db, A(ctx), ctx.params.id!, new Date().toISOString());
    redirect(ctx, `/admin/drivers/${ctx.params.id!}`, `${n} rémunération(s) marquée(s) comme versée(s).`);
  });

  // --- Véhicules (§29–30) ---------------------------------------------------------------------------
  r.get("/admin/vehicles", (ctx) => {
    need(ctx, "vehicle:manage");
    const rows = all<{ id: string; make: string; model: string; plate: string; seats: number; status: string; insurance_expiry: string | null; inspection_expiry: string | null; mileage_km: number; next_service_km: number | null }>(d.db,
      "SELECT * FROM vehicles WHERE deleted_at IS NULL ORDER BY plate");
    send(ctx, 200, layout(ctx, "Véhicules", html`<h1>Véhicules</h1>
      ${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Véhicule</th><th>Places</th><th>Assurance</th><th>Expertise</th><th>Km / entretien</th><th>Statut</th></tr></thead><tbody>
        ${rows.map((v) => html`<tr><td><a href="/admin/vehicles/${v.id}">${v.plate}</a><div class="small muted">${v.make} ${v.model}</div></td><td class="num">${v.seats}</td>
          <td>${fmtDate(v.insurance_expiry)}</td><td>${fmtDate(v.inspection_expiry)}</td><td class="num">${v.mileage_km} / ${v.next_service_km ?? "—"}${v.next_service_km !== null && v.mileage_km >= v.next_service_km ? html` <span class="badge badge-danger">entretien</span>` : ""}</td><td>${badge(v.status)}</td></tr>`)}
      </tbody></table></div>` : empty("Aucun véhicule")}
      <form class="card gold" method="post" action="/admin/vehicles">${csrf(ctx)}<h3>Ajouter un véhicule</h3>${vehicleFields()}<button class="btn btn-primary" type="submit">Ajouter</button></form>`));
  });
  r.post("/admin/vehicles", (ctx) => {
    need(ctx, "vehicle:manage");
    const v = readVehicle(ctx), id = newId(), t = new Date().toISOString();
    if (one(d.db, "SELECT id FROM vehicles WHERE plate = ?", v.plate)) throw new DomainError("Cette immatriculation existe déjà.", 409);
    run(d.db, `INSERT INTO vehicles (id, make, model, year, plate, color, category, seats, vin, insurance_expiry, inspection_expiry, mileage_km, next_service_km, status, notes, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'STANDARD', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, v.make, v.model, v.year, v.plate, v.color, v.seats, v.vin, v.insurance, v.inspection, v.mileage, v.nextService, v.status, v.notes, t, t);
    audit(d.db, A(ctx), "VEHICLE_CREATED", "vehicle", id, "SUCCESS", { plate: v.plate });
    redirect(ctx, "/admin/vehicles", "Véhicule ajouté.");
  });
  r.get("/admin/vehicles/:id", (ctx) => {
    need(ctx, "vehicle:manage");
    const v = one<Record<string, string | number | null>>(d.db, "SELECT * FROM vehicles WHERE id = ? AND deleted_at IS NULL", ctx.params.id!);
    if (!v) throw new HttpError(404, "Véhicule introuvable.");
    const docs = all<{ id: string; label: string; expires_at: string | null; verified_at: string | null }>(d.db, "SELECT id, label, expires_at, verified_at FROM documents WHERE owner_type = 'VEHICLE' AND owner_id = ? AND deleted_at IS NULL", String(v.id));
    send(ctx, 200, layout(ctx, String(v.plate), html`<div class="row between"><h1>${v.plate}</h1>${badge(String(v.status))}</div>
      <form class="card" method="post" action="/admin/vehicles/${String(v.id)}">${csrf(ctx)}${vehicleFields(v)}<button class="btn btn-primary" type="submit">Enregistrer</button></form>
      <div class="card"><h3>Documents</h3>${docs.map((doc) => html`<div class="row between"><span>${doc.label} — expire ${fmtDate(doc.expires_at)}</span>${doc.verified_at ? badge("RECONCILED") : actionButton(ctx, `/admin/documents/${doc.id}/verify`, "Marquer vérifié", { cls: "btn-sm" })}</div>`)}
        ${docForm(ctx, "VEHICLE", String(v.id))}</div>
      <div class="card">${actionButton(ctx, `/admin/vehicles/${String(v.id)}/archive`, "Archiver le véhicule", { cls: "btn-danger", confirm: "Êtes-vous sûr de vouloir archiver ce véhicule ?" })}</div>`));
  });
  r.post("/admin/vehicles/:id", (ctx) => {
    need(ctx, "vehicle:manage");
    const v = readVehicle(ctx);
    run(d.db, `UPDATE vehicles SET make = ?, model = ?, year = ?, plate = ?, color = ?, seats = ?, vin = ?, insurance_expiry = ?, inspection_expiry = ?, mileage_km = ?, next_service_km = ?, status = ?, notes = ?, updated_at = ? WHERE id = ?`,
      v.make, v.model, v.year, v.plate, v.color, v.seats, v.vin, v.insurance, v.inspection, v.mileage, v.nextService, v.status, v.notes, new Date().toISOString(), ctx.params.id!);
    audit(d.db, A(ctx), "VEHICLE_UPDATED", "vehicle", ctx.params.id!);
    redirect(ctx, `/admin/vehicles/${ctx.params.id!}`, "Véhicule mis à jour.");
  });
  r.post("/admin/vehicles/:id/archive", (ctx) => {
    need(ctx, "vehicle:manage");
    if (ctx.form.get("confirm") !== "yes") throw new DomainError("Veuillez confirmer.");
    run(d.db, "UPDATE vehicles SET deleted_at = ?, status = 'INACTIVE' WHERE id = ?", new Date().toISOString(), ctx.params.id!);
    audit(d.db, A(ctx), "VEHICLE_ARCHIVED", "vehicle", ctx.params.id!);
    redirect(ctx, "/admin/vehicles", "Véhicule archivé.");
  });

  // --- Documents & alertes (§28, §30) ------------------------------------------------------------------
  r.get("/admin/documents", (ctx) => {
    need(ctx, "document:manage");
    const alerts = documentAlerts(d);
    send(ctx, 200, layout(ctx, "Documents", html`<h1>Documents et échéances</h1>
      <p class="muted small">Les alertes signalent des échéances ; elles ne constituent pas une validation légale. La conformité des documents reste à vérifier par l'entreprise et l'autorité compétente.</p>
      ${alerts.length ? html`<div class="table-wrap"><table><thead><tr><th>Concerne</th><th>Élément</th><th>Échéance</th><th>État</th></tr></thead><tbody>
        ${alerts.map((a) => html`<tr><td><a href="${a.href}">${a.owner}</a></td><td>${a.label}</td><td>${fmtDate(a.date)}</td><td>${a.expired ? html`<span class="badge badge-danger">expiré</span>` : html`<span class="badge badge-warn">bientôt</span>`}</td></tr>`)}
      </tbody></table></div>` : empty("Aucune alerte", "Aucun document n'expire dans les 30 prochains jours.")}`));
  });
  r.post("/admin/documents", (ctx) => {
    need(ctx, "document:manage");
    const ownerType = field(ctx, "owner_type", 10), ownerId = field(ctx, "owner_id", 40), label = field(ctx, "label", 120);
    if (!["DRIVER", "VEHICLE"].includes(ownerType) || label.length < 2) throw new DomainError("Document invalide.");
    run(d.db, "INSERT INTO documents (id, owner_type, owner_id, label, expires_at, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      newId(), ownerType, ownerId, label, validDateOrNull(field(ctx, "expires_at", 10)), field(ctx, "notes", 300), new Date().toISOString());
    audit(d.db, A(ctx), "DOCUMENT_ADDED", "document", ownerId, "SUCCESS", { label });
    redirect(ctx, ownerType === "DRIVER" ? `/admin/drivers/${ownerId}` : `/admin/vehicles/${ownerId}`, "Document enregistré.");
  });
  r.post("/admin/documents/:id/verify", (ctx) => {
    need(ctx, "document:manage");
    const doc = one<{ owner_type: string; owner_id: string }>(d.db, "SELECT owner_type, owner_id FROM documents WHERE id = ?", ctx.params.id!);
    if (!doc) throw new HttpError(404, "Document introuvable.");
    run(d.db, "UPDATE documents SET verified_at = ?, verified_by = ? WHERE id = ?", new Date().toISOString(), ctx.user!.id, ctx.params.id!);
    audit(d.db, A(ctx), "DOCUMENT_VERIFIED", "document", ctx.params.id!);
    redirect(ctx, doc.owner_type === "DRIVER" ? `/admin/drivers/${doc.owner_id}` : `/admin/vehicles/${doc.owner_id}`, "Document marqué comme vérifié.");
  });

  registerAdminFinance(r, d);
}

export function bookingTable(rows: (BookingRow & { customer_name: string; driver_name: string | null })[]): Raw {
  return html`<div class="table-wrap"><table><thead><tr><th>Prise en charge</th><th>Trajet</th><th>Client</th><th>Chauffeur</th><th>Statut</th><th class="r">Montant</th></tr></thead><tbody>
    ${rows.map((b) => html`<tr><td><a href="/admin/bookings/${b.id}">${fmtDateTime(b.pickup_at)}</a><div class="small muted num">${b.number}</div></td>
      <td>${b.pickup_address}<div class="small muted">→ ${b.dropoff_address}</div></td><td>${b.customer_name}</td><td>${b.driver_name ?? "—"}</td><td>${badge(b.status)}</td>
      <td class="r">${money(b.final_total ?? b.quote_total)}</td></tr>`)}</tbody></table></div>`;
}

function docForm(ctx: Ctx, ownerType: string, ownerId: string): Raw {
  return html`<form method="post" action="/admin/documents">${csrf(ctx)}<input type="hidden" name="owner_type" value="${ownerType}"><input type="hidden" name="owner_id" value="${ownerId}">
    <div class="grid grid-3">${fieldInput("label", "Document", { required: true, placeholder: ownerType === "DRIVER" ? "Permis, autorisation…" : "Permis de circulation, assurance…" })}
    ${fieldInput("expires_at", "Expiration", { type: "date" })}${fieldInput("notes", "Notes")}</div><button class="btn btn-sm" type="submit">Ajouter le document</button>
    <p class="hint">Les fichiers eux-mêmes sont à conserver dans votre stockage privé ; seul le suivi des échéances est géré ici.</p></form>`;
}

function vehicleFields(v: Record<string, string | number | null> = {}): Raw {
  const s = (k: string) => (v[k] === null || v[k] === undefined ? "" : String(v[k]));
  return html`<div class="grid grid-3">${fieldInput("make", "Marque", { required: true, value: s("make") })}${fieldInput("model", "Modèle", { required: true, value: s("model") })}${fieldInput("year", "Année", { type: "number", value: s("year") })}
    ${fieldInput("plate", "Immatriculation", { required: true, value: s("plate") })}${fieldInput("color", "Couleur", { value: s("color") })}${fieldInput("seats", "Places passagers", { type: "number", value: s("seats") || "4", min: "1", max: "20" })}
    ${fieldInput("insurance_expiry", "Assurance jusqu'au", { type: "date", value: s("insurance_expiry") })}${fieldInput("inspection_expiry", "Prochaine expertise", { type: "date", value: s("inspection_expiry") })}${fieldInput("vin", "VIN", { value: s("vin") })}
    ${fieldInput("mileage_km", "Kilométrage", { type: "number", value: s("mileage_km") || "0", min: "0" })}${fieldInput("next_service_km", "Prochain entretien (km)", { type: "number", value: s("next_service_km"), min: "0" })}
    ${fieldSelect("status", "Statut", [["AVAILABLE", "Disponible"], ["MAINTENANCE", "Entretien"], ["INACTIVE", "Inactif"]], s("status") || "AVAILABLE")}</div>
    ${fieldTextarea("notes", "Historique / notes d'entretien", s("notes"))}`;
}

function readVehicle(ctx: Ctx) {
  const int = (k: string, min: number, max: number, def: number | null) => {
    const raw = field(ctx, k, 10);
    if (!raw) return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new DomainError(`Valeur invalide : ${k}.`);
    return n;
  };
  const make = field(ctx, "make", 40), model = field(ctx, "model", 40), plate = field(ctx, "plate", 15).toUpperCase();
  if (!make || !model || plate.length < 2) throw new DomainError("Marque, modèle et immatriculation sont requis.");
  const status = field(ctx, "status", 15);
  if (!["AVAILABLE", "MAINTENANCE", "INACTIVE"].includes(status)) throw new DomainError("Statut invalide.");
  return {
    make, model, plate, year: int("year", 1990, 2100, null), color: field(ctx, "color", 30), seats: int("seats", 1, 20, 4)!, vin: field(ctx, "vin", 20),
    insurance: validDateOrNull(field(ctx, "insurance_expiry", 10)), inspection: validDateOrNull(field(ctx, "inspection_expiry", 10)),
    mileage: int("mileage_km", 0, 3_000_000, 0)!, nextService: int("next_service_km", 0, 3_000_000, null), status, notes: field(ctx, "notes", 2000),
  };
}

export function documentAlerts(d: Deps): { owner: string; href: string; label: string; date: string; expired: boolean }[] {
  const limit = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10), today = new Date().toISOString().slice(0, 10);
  const out: { owner: string; href: string; label: string; date: string; expired: boolean }[] = [];
  for (const x of all<{ id: string; name: string; license_expiry: string | null; permit_expiry: string | null }>(d.db,
    "SELECT u.id, u.first_name || ' ' || u.last_name AS name, dp.license_expiry, dp.permit_expiry FROM users u JOIN driver_profiles dp ON dp.user_id = u.id WHERE u.status NOT IN ('INACTIVE','BLOCKED')")) {
    if (x.license_expiry && x.license_expiry <= limit) out.push({ owner: x.name, href: `/admin/drivers/${x.id}`, label: "Permis de conduire", date: x.license_expiry, expired: x.license_expiry < today });
    if (x.permit_expiry && x.permit_expiry <= limit) out.push({ owner: x.name, href: `/admin/drivers/${x.id}`, label: "Autorisation", date: x.permit_expiry, expired: x.permit_expiry < today });
  }
  for (const v of all<{ id: string; plate: string; insurance_expiry: string | null; inspection_expiry: string | null; mileage_km: number; next_service_km: number | null }>(d.db,
    "SELECT id, plate, insurance_expiry, inspection_expiry, mileage_km, next_service_km FROM vehicles WHERE deleted_at IS NULL AND status != 'INACTIVE'")) {
    if (v.insurance_expiry && v.insurance_expiry <= limit) out.push({ owner: v.plate, href: `/admin/vehicles/${v.id}`, label: "Assurance", date: v.insurance_expiry, expired: v.insurance_expiry < today });
    if (v.inspection_expiry && v.inspection_expiry <= limit) out.push({ owner: v.plate, href: `/admin/vehicles/${v.id}`, label: "Expertise", date: v.inspection_expiry, expired: v.inspection_expiry < today });
    if (v.next_service_km !== null && v.mileage_km >= v.next_service_km) out.push({ owner: v.plate, href: `/admin/vehicles/${v.id}`, label: "Entretien kilométrique", date: today, expired: true });
  }
  for (const doc of all<{ owner_type: string; owner_id: string; label: string; expires_at: string }>(d.db,
    "SELECT owner_type, owner_id, label, expires_at FROM documents WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?", limit)) {
    out.push({ owner: doc.owner_type === "DRIVER" ? "Chauffeur" : "Véhicule", href: doc.owner_type === "DRIVER" ? `/admin/drivers/${doc.owner_id}` : `/admin/vehicles/${doc.owner_id}`, label: doc.label, date: doc.expires_at, expired: doc.expires_at < today });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export { getBooking };
