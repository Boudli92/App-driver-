import type { Router } from "../lib/http.ts";
import { send, redirect, field, HttpError } from "../lib/http.ts";
import { html, raw } from "../lib/html.ts";
import { layout, csrf, fieldInput, fieldSelect, fieldTextarea, money, badge, empty, actionButton, BRAND } from "../ui/layout.ts";
import { need, actorOf, auditActor, type Deps } from "../app.ts";
import { one, all, run } from "../db/db.ts";
import { fmtDateTime, fmtKm, fmtDate } from "../lib/format.ts";
import { newId } from "../lib/security.ts";
import { createBooking, cancelBooking, getBooking } from "../services/bookings.ts";
import { startOnlinePayment } from "../services/payments.ts";
import { createCustomerInvitation, ensureReferralCode, changePassword, exportPersonalData, DomainError } from "../services/users.ts";
import { getSetting } from "../services/settings.ts";
import { audit } from "../services/audit.ts";
import { TERMINAL } from "../domain/bookings/booking-state.ts";

const LINE_LABELS: Record<string, string> = {
  BASE_FARE: "Prise en charge", DISTANCE: "Distance (tarif jour)", DISTANCE_NIGHT: "Distance (tarif nuit)", DURATION: "Durée",
  WAITING: "Attente (tarif jour)", WAITING_NIGHT: "Attente (tarif nuit)", MINIMUM_FARE_ADJUSTMENT: "Complément course minimum (jour)",
  NIGHT_MINIMUM_FARE_ADJUSTMENT: "Complément course minimum (nuit)", ROUNDING: "Arrondi", NIGHT_SURCHARGE: "Majoration nuit",
  WEEKEND_SURCHARGE: "Majoration week-end", HOLIDAY_SURCHARGE: "Majoration jour férié",
};
export const lineLabel = (code: string) => LINE_LABELS[code] ?? code;

export function priceLines(json: string | null) {
  if (!json) return html``;
  const lines = JSON.parse(json) as { code: string; amount: number }[];
  return html`<table><tbody>${lines.map((l) => html`<tr><td>${lineLabel(l.code)}</td><td class="r">${money(l.amount)}</td></tr>`)}</tbody></table>`;
}

export function registerCustomer(r: Router, d: Deps): void {
  const onlineAvailable = () => d.payments !== null;

  r.get("/app", (ctx) => {
    const actor = actorOf(ctx);
    if (actor.role !== "CUSTOMER") throw new HttpError(403, "Accès refusé.");
    if (actor.customerStatus !== "APPROVED") {
      return send(ctx, 200, layout(ctx, "Adhésion en cours", html`<div class="card gold"><h1>Merci, ${ctx.user!.first_name}.</h1>
        <p>Votre demande d'adhésion est ${actor.customerStatus === "PENDING_APPROVAL" ? "en cours d'examen" : "actuellement inactive"}. Chaque membre est validé personnellement par l'entreprise.</p>
        <p class="muted">Vous pourrez réserver dès la validation de votre adhésion.</p>${badge(actor.customerStatus ?? "")}</div>`));
    }
    const upcoming = all<{ id: string; number: string; pickup_at: string; pickup_address: string; dropoff_address: string; status: string }>(d.db,
      `SELECT id, number, pickup_at, pickup_address, dropoff_address, status FROM bookings WHERE customer_id = ? AND status NOT IN (${[...TERMINAL].map((s) => `'${s}'`).join(",")}) ORDER BY pickup_at LIMIT 5`, ctx.user!.id);
    const notes = all<{ title: string; body: string; created_at: string }>(d.db, "SELECT title, body, created_at FROM notifications WHERE user_id = ? AND channel = 'IN_APP' ORDER BY created_at DESC LIMIT 5", ctx.user!.id);
    const unpaid = one<{ n: number }>(d.db, "SELECT COUNT(*) AS n FROM invoices WHERE customer_id = ? AND status = 'ISSUED'", ctx.user!.id)!.n;
    send(ctx, 200, layout(ctx, "Espace membre", html`<div class="row between"><h1>Bonjour, ${ctx.user!.first_name}</h1><a class="btn btn-primary" href="/app/book">Réserver une course</a></div>
      ${unpaid ? html`<div class="alert alert-warn">Vous avez ${unpaid} facture(s) à régler. <a href="/app/invoices">Voir</a></div>` : ""}
      <div class="card"><h3>Prochaines courses</h3>${upcoming.length ? html`<div class="stack">${upcoming.map((b) => html`<div class="row between">
        <div><a href="/app/bookings/${b.id}">${fmtDateTime(b.pickup_at)}</a><div class="small muted">${b.pickup_address} → ${b.dropoff_address}</div></div>${badge(b.status)}</div>`)}</div>`
        : empty("Aucune réservation", "Votre prochaine course apparaîtra ici.")}</div>
      <div class="card"><h3>Notifications</h3>${notes.length ? html`<div class="stack">${notes.map((n) => html`<div><strong>${n.title}</strong><div class="small muted">${n.body} · ${fmtDateTime(n.created_at)}</div></div>`)}</div>` : html`<p class="muted">Aucune notification.</p>`}</div>`));
  });

  // --- Réserver --------------------------------------------------------------------------
  r.get("/app/book", (ctx) => {
    need(ctx, "booking:create");
    const p = getSetting(d.db, "pricing");
    const methods: [string, string][] = [];
    if (getSetting(d.db, "features").cash) methods.push(["CASH", "Espèces au chauffeur"]);
    if (onlineAvailable()) methods.push(["ONLINE", "Carte ou TWINT (en ligne, après la course)"]);
    send(ctx, 200, layout(ctx, "Réserver", html`<h1>Réserver une course</h1>
      <form class="card gold" method="post" action="/app/book">${csrf(ctx)}
        <fieldset><legend>Quand</legend>
          <label class="check"><input type="radio" name="when" value="now" checked> Maintenant</label>
          <label class="check"><input type="radio" name="when" value="scheduled"> Programmer</label>
          ${fieldInput("pickup_local", "Date et heure (si programmée)", { type: "datetime-local", hint: "Heure de Suisse." })}</fieldset>
        ${fieldInput("pickup", "Lieu de prise en charge", { required: true, autocomplete: "street-address", placeholder: "Adresse complète" })}
        ${fieldInput("dropoff", "Destination", { required: true, placeholder: "Adresse complète" })}
        <div class="grid grid-2">${fieldInput("passengers", "Passagers", { type: "number", value: 1, min: "1", max: "8", required: true })}
          ${fieldInput("luggage", "Bagages", { type: "number", value: 0, min: "0", max: "20" })}</div>
        ${fieldInput("contact_phone", "Téléphone de contact", { type: "tel", autocomplete: "tel" })}
        ${fieldTextarea("notes", "Commentaire pour le chauffeur")}
        ${methods.length ? fieldSelect("payment_method", "Paiement", methods, methods[0]![0]) : html`<div class="alert alert-warn">Aucun moyen de paiement n'est disponible actuellement.</div>`}
        <p class="small muted">Tarif : ${money(p.perKm)}/km le jour, ${money(p.nightPerKm)}/km la nuit, minimum ${money(p.minimumFare)} / ${money(p.nightMinimumFare)}.
          Le prix estimé vous est communiqué à la confirmation ; le montant final tient compte de la distance réelle et de l'attente au-delà de ${p.freeWaitingMinutes} minutes.</p>
        <button class="btn btn-primary btn-block" type="submit"${methods.length ? "" : raw(" disabled")}>Envoyer la demande</button></form>`));
  });

  r.post("/app/book", (ctx) => {
    const actor = need(ctx, "booking:create");
    const id = createBooking(d.db, { id: actor.userId, role: "CUSTOMER" }, {
      pickup: field(ctx, "pickup", 200), dropoff: field(ctx, "dropoff", 200), when: field(ctx, "when") === "scheduled" ? "scheduled" : "now",
      pickupLocal: field(ctx, "pickup_local", 20), passengers: Number(field(ctx, "passengers", 3)), luggage: Number(field(ctx, "luggage", 3) || "0"),
      notes: field(ctx, "notes", 500), contactPhone: field(ctx, "contact_phone", 30), paymentMethod: field(ctx, "payment_method", 10), onlineAvailable: onlineAvailable(),
    }, d.notifier);
    redirect(ctx, `/app/bookings/${id}`, "Demande envoyée. Vous serez notifié dès sa confirmation.");
  });

  // --- Mes courses ------------------------------------------------------------------------
  r.get("/app/bookings", (ctx) => {
    need(ctx, "booking:read_own");
    const rows = all<{ id: string; number: string; pickup_at: string; pickup_address: string; dropoff_address: string; status: string; quote_total: number | null; final_total: number | null }>(d.db,
      "SELECT id, number, pickup_at, pickup_address, dropoff_address, status, quote_total, final_total FROM bookings WHERE customer_id = ? ORDER BY pickup_at DESC LIMIT 200", ctx.user!.id);
    send(ctx, 200, layout(ctx, "Mes courses", html`<h1>Mes courses</h1>${rows.length ? html`<div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Trajet</th><th>Statut</th><th class="r">Montant</th></tr></thead><tbody>
      ${rows.map((b) => html`<tr><td><a href="/app/bookings/${b.id}">${fmtDateTime(b.pickup_at)}</a><div class="small muted">${b.number}</div></td>
        <td>${b.pickup_address}<div class="small muted">→ ${b.dropoff_address}</div></td><td>${badge(b.status)}</td><td class="r">${money(b.final_total ?? b.quote_total)}</td></tr>`)}
      </tbody></table></div>` : empty("Aucune course", "Réservez votre première course en quelques secondes.")}`));
  });

  r.get("/app/bookings/:id", (ctx) => {
    need(ctx, "booking:read_own");
    const b = one<ReturnType<typeof getBooking>>(d.db, "SELECT * FROM bookings WHERE id = ? AND customer_id = ?", ctx.params.id!, ctx.user!.id);
    if (!b) throw new HttpError(404, "Course introuvable.");
    const driver = b.assigned_driver_id ? one<{ first_name: string }>(d.db, "SELECT first_name FROM users WHERE id = ?", b.assigned_driver_id) : undefined;
    const vehicle = b.vehicle_id ? one<{ make: string; model: string; color: string; plate: string }>(d.db, "SELECT make, model, color, plate FROM vehicles WHERE id = ?", b.vehicle_id) : undefined;
    const invoice = one<{ id: string; number: string; status: string }>(d.db, "SELECT id, number, status FROM invoices WHERE booking_id = ?", b.id);
    const cancellable = ["REQUESTED", "CONFIRMED", "ASSIGNED", "DRIVER_ACCEPTED"].includes(b.status);
    send(ctx, 200, layout(ctx, `Course ${b.number}`, html`<div class="row between"><h1>Course</h1>${badge(b.status)}</div>
      <div class="card"><dl class="kv"><dt>Référence</dt><dd class="num">${b.number}</dd><dt>Prise en charge</dt><dd>${fmtDateTime(b.pickup_at)}${b.is_immediate ? " (immédiate)" : ""}</dd>
        <dt>Départ</dt><dd>${b.pickup_address}</dd><dt>Destination</dt><dd>${b.dropoff_address}</dd><dt>Passagers</dt><dd>${b.passengers}</dd>
        <dt>Paiement</dt><dd>${b.payment_method === "CASH" ? "Espèces" : "Carte / TWINT en ligne"}</dd>
        ${driver ? html`<dt>Chauffeur</dt><dd>${driver.first_name}</dd>` : ""}${vehicle ? html`<dt>Véhicule</dt><dd>${vehicle.make} ${vehicle.model}, ${vehicle.color} — ${vehicle.plate}</dd>` : ""}
        <dt>${b.final_total !== null ? "Montant" : "Prix estimé"}</dt><dd>${money(b.final_total ?? b.quote_total)}${b.final_total === null && b.quote_total === null ? html` <span class="small muted">communiqué à la confirmation</span>` : ""}</dd>
        ${b.final_distance_m !== null ? html`<dt>Distance</dt><dd>${fmtKm(b.final_distance_m)}</dd><dt>Attente</dt><dd>${b.waiting_minutes ?? 0} min</dd>` : ""}
      </dl></div>
      ${b.final_total !== null ? html`<div class="card"><h3>Détail du prix</h3>${priceLines(b.price_lines)}</div>` : ""}
      <div class="row">${invoice ? html`<a class="btn" href="/app/invoices/${invoice.id}">Facture ${invoice.number}</a>` : ""}
        ${cancellable ? actionButton(ctx, `/app/bookings/${b.id}/cancel`, "Annuler la course", { cls: "btn-danger", confirm: "Je confirme l'annulation" }) : ""}</div>`));
  });

  r.post("/app/bookings/:id/cancel", (ctx) => {
    const actor = need(ctx, "booking:cancel_own");
    if (ctx.form.get("confirm") !== "yes") throw new DomainError("Veuillez confirmer l'annulation.");
    cancelBooking(d.db, { id: actor.userId, role: "CUSTOMER" }, ctx.params.id!, "Annulée par le client", d.notifier);
    redirect(ctx, `/app/bookings/${ctx.params.id!}`, "Course annulée.");
  });

  // --- Factures -----------------------------------------------------------------------------
  r.get("/app/invoices", (ctx) => {
    need(ctx, "invoice:read_own");
    const rows = all<{ id: string; number: string; issued_at: string; total: number; status: string }>(d.db,
      "SELECT id, number, issued_at, total, status FROM invoices WHERE customer_id = ? ORDER BY issued_at DESC LIMIT 200", ctx.user!.id);
    send(ctx, 200, layout(ctx, "Mes factures", html`<h1>Mes factures</h1>${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>N°</th><th>Date</th><th>Statut</th><th class="r">Total</th></tr></thead><tbody>
      ${rows.map((i) => html`<tr><td><a href="/app/invoices/${i.id}">${i.number}</a></td><td>${fmtDate(i.issued_at)}</td><td>${badge(i.status)}</td><td class="r">${money(i.total)}</td></tr>`)}
      </tbody></table></div>` : empty("Aucune facture")}`));
  });

  r.get("/app/invoices/:id", (ctx) => {
    need(ctx, "invoice:read_own");
    const inv = one<InvoiceView>(d.db, "SELECT * FROM invoices WHERE id = ? AND customer_id = ?", ctx.params.id!, ctx.user!.id);
    if (!inv) throw new HttpError(404, "Facture introuvable.");
    send(ctx, 200, layout(ctx, `Facture ${inv.number}`, html`
      ${ctx.query.get("paid") ? html`<div class="alert alert-info">Merci. La confirmation du paiement est en cours : la facture sera marquée payée dès réception de la confirmation du prestataire.</div>` : ""}
      ${renderInvoice(d, inv)}
      <div class="row no-print">${inv.status === "ISSUED" && d.payments ? actionButton(ctx, `/app/invoices/${inv.id}/pay`, "Payer par carte ou TWINT", { cls: "btn-primary" }) : ""}
        <span class="muted small">Pour un PDF : utilisez « Imprimer » puis « Enregistrer au format PDF ».</span></div>`));
  });

  r.post("/app/invoices/:id/pay", async (ctx) => {
    const actor = need(ctx, "invoice:read_own");
    if (!d.payments) throw new DomainError("Le paiement en ligne n'est pas disponible.");
    const url = await startOnlinePayment(d.db, d.payments, { id: actor.userId, role: "CUSTOMER", email: ctx.user!.email }, ctx.params.id!, d.env.appUrl);
    ctx.res.statusCode = 303; ctx.res.setHeader("Location", url); ctx.res.end();
  });

  // --- Parrainage & fidélité ------------------------------------------------------------------
  r.get("/app/referrals", (ctx) => {
    need(ctx, "referral:invite");
    const code = ensureReferralCode(d.db, ctx.user!.id);
    const invites = all<{ code: string; created_at: string; uses: number; status: string }>(d.db,
      "SELECT code, created_at, uses, status FROM invitations WHERE inviter_user_id = ? AND kind = 'CUSTOMER' ORDER BY created_at DESC LIMIT 50", ctx.user!.id);
    const rewards = all<{ amount: number; note: string; created_at: string }>(d.db, "SELECT amount, note, created_at FROM reward_ledger WHERE user_id = ? ORDER BY created_at DESC", ctx.user!.id);
    const balance = rewards.reduce((a, x) => a + x.amount, 0);
    const ref = getSetting(d.db, "referral");
    send(ctx, 200, layout(ctx, "Inviter", html`<h1>Inviter un proche</h1>
      <div class="card gold"><p>Chaque invitation génère un lien personnel à usage unique. La personne invitée devra être validée par l'entreprise.</p>
        <form method="post" action="/app/referrals">${csrf(ctx)}${fieldInput("email", "E-mail de la personne (facultatif)", { type: "email" })}
        <button class="btn btn-primary" type="submit">Créer un lien d'invitation</button></form>
        <p class="small muted">Votre code membre : <span class="num gold">${code}</span> · Limite : ${ref.max_invitations_per_30_days} invitations par 30 jours.</p></div>
      <div class="card"><h3>Mes invitations</h3>${invites.length ? html`<div class="table-wrap"><table><thead><tr><th>Lien</th><th>Créé</th><th>Statut</th></tr></thead><tbody>
        ${invites.map((i) => html`<tr><td class="num small">${d.env.appUrl}/invite/${i.code}</td><td>${fmtDate(i.created_at)}</td><td>${badge(i.status === "USED" ? "COMPLETED" : "ACTIVE")}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">Aucune invitation.</p>`}</div>
      <div class="card"><h3>Fidélité</h3><p>Solde de récompenses : ${money(balance)}</p>
        ${rewards.length ? html`<div class="stack">${rewards.map((x) => html`<div class="row between small"><span>${x.note} · ${fmtDate(x.created_at)}</span>${money(x.amount)}</div>`)}</div>` : html`<p class="muted">Aucune récompense pour le moment.</p>`}
        <p class="small muted">Les récompenses sont déduites sur demande lors du règlement, selon les conditions de l'entreprise.</p></div>`));
  });
  r.get("/app/rewards", (ctx) => redirect(ctx, "/app/referrals"));

  r.post("/app/referrals", (ctx) => {
    const actor = need(ctx, "referral:invite");
    const email = field(ctx, "email", 254);
    const code = createCustomerInvitation(d.db, { id: actor.userId, role: "CUSTOMER" }, email ? { email, source: "member" } : { source: "member" });
    redirect(ctx, "/app/referrals", `Lien créé : ${d.env.appUrl}/invite/${code}`);
  });

  // --- Profil ---------------------------------------------------------------------------------
  r.get("/app/profile", (ctx) => {
    need(ctx, "profile:update_own");
    const u = one<{ email: string; phone: string; first_name: string; last_name: string; created_at: string }>(d.db, "SELECT email, phone, first_name, last_name, created_at FROM users WHERE id = ?", ctx.user!.id)!;
    send(ctx, 200, layout(ctx, "Profil", html`<h1>Profil</h1>
      <div class="card"><dl class="kv"><dt>Nom</dt><dd>${u.first_name} ${u.last_name}</dd><dt>E-mail</dt><dd>${u.email}</dd><dt>Téléphone</dt><dd>${u.phone}</dd><dt>Membre depuis</dt><dd>${fmtDate(u.created_at)}</dd></dl>
        <p class="small muted">Pour modifier vos coordonnées, contactez-nous via le support.</p></div>
      <form class="card" method="post" action="/app/profile/password">${csrf(ctx)}<h3>Mot de passe</h3>
        ${fieldInput("current", "Mot de passe actuel", { type: "password", required: true, autocomplete: "current-password" })}
        ${fieldInput("next", "Nouveau mot de passe", { type: "password", required: true, autocomplete: "new-password" })}
        <button class="btn" type="submit">Modifier</button></form>
      <div class="card"><h3>Mes données</h3><p class="small muted">Téléchargez l'ensemble de vos données personnelles (droit d'accès).</p><a class="btn" href="/app/profile/export">Exporter mes données</a></div>`));
  });
  r.post("/app/profile/password", (ctx) => {
    need(ctx, "profile:update_own");
    changePassword(d.db, ctx.user!.id, ctx.form.get("current") ?? "", ctx.form.get("next") ?? "");
    redirect(ctx, "/app/profile", "Mot de passe modifié.");
  });
  r.get("/app/profile/export", (ctx) => {
    need(ctx, "profile:update_own");
    audit(d.db, auditActor(ctx), "PERSONAL_DATA_EXPORTED", "user", ctx.user!.id);
    ctx.res.setHeader("Content-Disposition", `attachment; filename="mes-donnees.json"`);
    send(ctx, 200, JSON.stringify(exportPersonalData(d.db, ctx.user!.id), null, 2), "application/json; charset=utf-8");
  });

  registerSupport(r, d, "/app/support", "profile:update_own");
}

// --- Support (partagé client / chauffeur) --------------------------------------------------------
export function registerSupport(r: Router, d: Deps, base: string, perm: "profile:update_own" | "driver:update_own_profile"): void {
  r.get(base, (ctx) => {
    need(ctx, perm);
    const tickets = all<{ id: string; subject: string; status: string; updated_at: string }>(d.db, "SELECT id, subject, status, updated_at FROM support_tickets WHERE user_id = ? ORDER BY updated_at DESC", ctx.user!.id);
    send(ctx, 200, layout(ctx, "Support", html`<h1>Support</h1>
      <form class="card" method="post" action="${base}">${csrf(ctx)}
        ${fieldSelect("category", "Catégorie", [["BOOKING", "Course"], ["PAYMENT", "Paiement / facture"], ["ACCOUNT", "Compte"], ["INCIDENT", "Incident"], ["OTHER", "Autre"]])}
        ${fieldInput("subject", "Sujet", { required: true })}${fieldTextarea("message", "Message")}
        <button class="btn btn-primary" type="submit">Envoyer</button></form>
      ${tickets.length ? html`<div class="card"><h3>Mes demandes</h3><div class="stack">${tickets.map((t) => html`<div class="row between"><a href="${base}/${t.id}">${t.subject}</a>${badge(t.status)}</div>`)}</div></div>` : ""}`));
  });
  r.post(base, (ctx) => {
    need(ctx, perm);
    const subject = field(ctx, "subject", 120), message = field(ctx, "message", 2000);
    if (subject.length < 3 || message.length < 3) throw new DomainError("Sujet et message sont requis.");
    const id = newId(), t = new Date().toISOString();
    run(d.db, "INSERT INTO support_tickets (id, user_id, category, subject, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'OPEN', ?, ?)", id, ctx.user!.id, field(ctx, "category", 20), subject, t, t);
    run(d.db, "INSERT INTO support_messages (id, ticket_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)", newId(), id, ctx.user!.id, message, t);
    const o = one<{ id: string; email: string }>(d.db, "SELECT id, email FROM users WHERE role = 'SUPER_ADMIN'");
    if (o) d.notifier.notify(o, "SUPPORT_REPLY", `Support : ${subject}`, `${ctx.user!.first_name} ${ctx.user!.last_name}`);
    redirect(ctx, `${base}/${id}`, "Demande envoyée.");
  });
  r.get(`${base}/:id`, (ctx) => {
    need(ctx, perm);
    const t = one<{ id: string; subject: string; status: string }>(d.db, "SELECT id, subject, status FROM support_tickets WHERE id = ? AND user_id = ?", ctx.params.id!, ctx.user!.id);
    if (!t) throw new HttpError(404, "Demande introuvable.");
    const msgs = all<{ body: string; created_at: string; author: string }>(d.db, "SELECT m.body, m.created_at, u.first_name AS author FROM support_messages m JOIN users u ON u.id = m.author_id WHERE ticket_id = ? ORDER BY m.created_at", t.id);
    send(ctx, 200, layout(ctx, t.subject, html`<div class="row between"><h1>${t.subject}</h1>${badge(t.status)}</div>
      ${msgs.map((m) => html`<div class="card"><div class="small muted">${m.author} · ${fmtDateTime(m.created_at)}</div><p>${m.body}</p></div>`)}
      ${t.status !== "CLOSED" ? html`<form class="card" method="post" action="${base}/${t.id}">${csrf(ctx)}${fieldTextarea("message", "Répondre")}<button class="btn" type="submit">Envoyer</button></form>` : ""}`));
  });
  r.post(`${base}/:id`, (ctx) => {
    need(ctx, perm);
    const t = one<{ id: string }>(d.db, "SELECT id FROM support_tickets WHERE id = ? AND user_id = ? AND status != 'CLOSED'", ctx.params.id!, ctx.user!.id);
    if (!t) throw new HttpError(404, "Demande introuvable.");
    const message = field(ctx, "message", 2000);
    if (message.length < 1) throw new DomainError("Message vide.");
    const now = new Date().toISOString();
    run(d.db, "INSERT INTO support_messages (id, ticket_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)", newId(), t.id, ctx.user!.id, message, now);
    run(d.db, "UPDATE support_tickets SET status = 'OPEN', updated_at = ? WHERE id = ?", now, t.id);
    redirect(ctx, `${base}/${t.id}`);
  });
}

export interface InvoiceView {
  id: string; number: string; booking_id: string; customer_id: string; issued_at: string; total: number; tax_enabled: number; tax_rate_bps: number;
  tax_amount: number; tax_included: number; tax_label: string; tax_number: string; lines: string; company_snapshot: string; payment_method: string; status: string; refunded_amount: number;
}

export function renderInvoice(d: Deps, inv: InvoiceView) {
  const company = JSON.parse(inv.company_snapshot) as Record<string, string>;
  const data = JSON.parse(inv.lines) as { lines: { code: string; amount: number }[]; waitingMinutes: number; distanceMeters: number };
  const b = one<{ number: string; pickup_address: string; dropoff_address: string; pickup_at: string }>(d.db, "SELECT number, pickup_address, dropoff_address, pickup_at FROM bookings WHERE id = ?", inv.booking_id)!;
  const c = one<{ first_name: string; last_name: string; email: string }>(d.db, "SELECT first_name, last_name, email FROM users WHERE id = ?", inv.customer_id)!;
  const subtotal = data.lines.reduce((a, l) => a + l.amount, 0);
  return html`<article class="invoice"><div class="row between"><div><h2>${company.display_name || BRAND}</h2>
      <div class="small muted">${company.legal_name}<br>${company.address} ${company.postal_code} ${company.city}<br>${company.uid ? `IDE ${company.uid}` : ""}</div></div>
      <div><h3>Facture</h3><div class="num">${inv.number}</div><div class="small muted">${fmtDate(inv.issued_at)}</div>${badge(inv.status)}</div></div>
    <div class="rule"></div>
    <p><strong>${c.first_name} ${c.last_name}</strong><br><span class="small muted">${c.email}</span></p>
    <p class="small">Course ${b.number} — ${fmtDateTime(b.pickup_at)}<br>${b.pickup_address} → ${b.dropoff_address}<br>${fmtKm(data.distanceMeters)} · attente ${data.waitingMinutes} min</p>
    <table><tbody>${data.lines.map((l) => html`<tr><td>${lineLabel(l.code)}</td><td class="r">${money(l.amount)}</td></tr>`)}
      ${inv.tax_enabled && !inv.tax_included ? html`<tr><td>Sous-total</td><td class="r">${money(subtotal)}</td></tr><tr><td>${inv.tax_label} ${inv.tax_rate_bps / 100} %</td><td class="r">${money(inv.tax_amount)}</td></tr>` : ""}
      <tr><th>Total CHF</th><th class="r">${money(inv.total)}</th></tr>
      ${inv.tax_enabled && inv.tax_included ? html`<tr><td class="small muted">dont ${inv.tax_label} ${inv.tax_rate_bps / 100} %</td><td class="r small">${money(inv.tax_amount)}</td></tr>` : ""}
      ${inv.refunded_amount ? html`<tr><td>Remboursé</td><td class="r">${money(-inv.refunded_amount)}</td></tr>` : ""}
    </tbody></table>
    <p class="small muted">Moyen de paiement : ${inv.payment_method === "CASH" ? "espèces" : "carte / TWINT en ligne"}${inv.tax_number ? ` · N° ${inv.tax_label} ${inv.tax_number}` : ""}</p></article>`;
}
