import type { Router } from "../lib/http.ts";
import { send, redirect, field, HttpError } from "../lib/http.ts";
import { html, type Raw } from "../lib/html.ts";
import { layout, csrf, fieldInput, money, badge, empty, actionButton } from "../ui/layout.ts";
import { need, actorOf, type Deps } from "../app.ts";
import { one, all } from "../db/db.ts";
import { fmtDateTime, fmtTime, fmtKm, fmtBps, parseScaled, fmtDate } from "../lib/format.ts";
import { NAVIGATION_PROVIDERS } from "../lib/navigation.ts";
import { driverAction, completeBooking, type BookingRow, type DriverAction } from "../services/bookings.ts";
import { driverEarningsSummary } from "../services/finance.ts";
import { changePassword, DomainError } from "../services/users.ts";
import { getSetting } from "../services/settings.ts";
import { TERMINAL } from "../domain/bookings/booking-state.ts";
import { format, minor } from "../domain/money/money.ts";
import { registerSupport } from "./customer.ts";

const ACTIVE_LIST = [...TERMINAL].map((s) => `'${s}'`).join(",");

export function registerDriver(r: Router, d: Deps): void {
  const myTrip = (driverId: string, id: string) => {
    const b = one<BookingRow>(d.db, "SELECT * FROM bookings WHERE id = ? AND assigned_driver_id = ?", id, driverId);
    if (!b) throw new HttpError(404, "Course introuvable."); // anti-IDOR
    return b;
  };

  r.get("/driver", (ctx) => {
    const actor = actorOf(ctx);
    if (actor.role !== "DRIVER") throw new HttpError(403, "Accès refusé.");
    if (actor.driverStatus !== "ACTIVE") {
      return send(ctx, 200, layout(ctx, "Compte chauffeur", html`<div class="card gold"><h1>Compte en attente</h1>
        <p>Votre compte doit être vérifié et activé par l'entreprise avant de recevoir des courses.</p>${badge(actor.driverStatus ?? "")}</div>`));
    }
    const trips = all<BookingRow>(d.db, `SELECT * FROM bookings WHERE assigned_driver_id = ? AND status NOT IN (${ACTIVE_LIST}) ORDER BY pickup_at LIMIT 20`, actor.userId);
    const current = trips.find((t) => ["DRIVER_ARRIVING", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS"].includes(t.status));
    const e = driverEarningsSummary(d.db, actor.userId);
    send(ctx, 200, layout(ctx, "Aujourd'hui", html`<h1>Aujourd'hui</h1>
      <div class="grid grid-2"><div class="stat"><div class="label">Courses du jour</div><div class="value">${e.today.trips}</div></div>
        <div class="stat"><div class="label">Ma part aujourd'hui</div><div class="value">${money(e.today.mine)}</div><div class="sub">CA généré ${money(e.today.gross)}</div></div></div>
      ${current ? html`<div class="card trip-now"><h3>Course actuelle</h3>${tripSummary(current)}<a class="btn btn-primary btn-xl btn-block" href="/driver/trips/${current.id}">Ouvrir la course</a></div>` : ""}
      <div class="card"><h3>Prochaines courses</h3>${trips.length ? html`<div class="stack">${trips.filter((t) => t !== current).map((t) => html`<a class="row between" href="/driver/trips/${t.id}">
        <span><strong class="num">${fmtTime(t.pickup_at)}</strong> · ${t.pickup_address}</span>${badge(t.status)}</a>`)}</div>` : empty("Aucune course", "Les nouvelles courses attribuées apparaîtront ici.")}</div>`));
  });
  r.get("/driver/today", (ctx) => redirect(ctx, "/driver"));

  r.get("/driver/trips", (ctx) => {
    const actor = need(ctx, "driver:read_own_trips");
    const rows = all<BookingRow>(d.db, "SELECT * FROM bookings WHERE assigned_driver_id = ? ORDER BY pickup_at DESC LIMIT 200", actor.userId);
    send(ctx, 200, layout(ctx, "Mes courses", html`<h1>Mes courses</h1>${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Trajet</th><th>Statut</th><th class="r">Montant</th></tr></thead><tbody>
      ${rows.map((b) => html`<tr><td><a href="/driver/trips/${b.id}">${fmtDateTime(b.pickup_at)}</a></td><td>${b.pickup_address}<div class="small muted">→ ${b.dropoff_address}</div></td><td>${badge(b.status)}</td><td class="r">${money(b.final_total ?? b.quote_total)}</td></tr>`)}
      </tbody></table></div>` : empty("Aucune course")}`));
  });
  r.get("/driver/calendar", (ctx) => redirect(ctx, "/driver/trips"));

  r.get("/driver/trips/:id", (ctx) => {
    const actor = need(ctx, "driver:read_own_trips");
    const b = myTrip(actor.userId, ctx.params.id!);
    const c = one<{ first_name: string; last_name: string; phone: string }>(d.db, "SELECT first_name, last_name, phone FROM users WHERE id = ?", b.customer_id)!;
    const v = b.vehicle_id ? one<{ make: string; model: string; plate: string }>(d.db, "SELECT make, model, plate FROM vehicles WHERE id = ?", b.vehicle_id) : undefined;
    const earning = one<{ driver_amount: number; driver_share_bps: number }>(d.db, "SELECT driver_amount, driver_share_bps FROM driver_earnings WHERE booking_id = ?", b.id);
    const p = getSetting(d.db, "pricing");
    const act = (action: DriverAction, label: string, cls = "btn-primary") => actionButton(ctx, `/driver/trips/${b.id}/${action}`, label, { cls: `${cls} btn-xl btn-block` });
    const target = ["DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS"].includes(b.status) ? b.dropoff_address : b.pickup_address;
    const actions = {
      ASSIGNED: html`${act("accept", "Accepter")}${act("decline", "Refuser", "btn-ghost")}`,
      DRIVER_ACCEPTED: act("arriving", "En route"),
      DRIVER_ARRIVING: act("arrived", "Arrivé"),
      DRIVER_ARRIVED: html`${act("onboard", "Démarrer")}<p class="small muted">Attente : ${p.freeWaitingMinutes} minutes offertes, puis décompte automatique.</p>${act("noshow", "Client absent", "btn-danger")}`,
      IN_PROGRESS: html`<form method="post" action="/driver/trips/${b.id}/complete" class="card gold">${csrf(ctx)}
        ${fieldInput("km", "Kilomètres parcourus", { inputmode: "decimal", required: true, placeholder: "ex. 12.4", hint: "Distance réelle de la course." })}
        ${b.payment_method === "CASH" ? fieldInput("cash", "Montant encaissé en espèces (CHF)", { inputmode: "decimal", hint: "Laissez vide si le montant affiché après clôture a été encaissé exactement." }) : html`<p class="small muted">Paiement en ligne : ne rien encaisser.</p>`}
        <button class="btn btn-primary btn-xl btn-block" type="submit">Terminer</button></form>`,
    } as Record<string, Raw>;
    send(ctx, 200, layout(ctx, `Course ${b.number}`, html`<div class="row between"><h1>Course</h1>${badge(b.status)}</div>
      <div class="card">${tripSummary(b)}<dl class="kv"><dt>Client</dt><dd>${c.first_name} ${c.last_name}</dd>
        <dt>Téléphone</dt><dd><a href="tel:${b.contact_phone || c.phone}">${b.contact_phone || c.phone}</a></dd><dt>Passagers</dt><dd>${b.passengers} · bagages ${b.luggage}</dd>
        ${v ? html`<dt>Véhicule</dt><dd>${v.make} ${v.model} — ${v.plate}</dd>` : ""}
        <dt>Paiement</dt><dd>${b.payment_method === "CASH" ? "Espèces (pour le compte de l'entreprise)" : "En ligne"}</dd>
        ${b.notes ? html`<dt>Notes</dt><dd>${b.notes}</dd>` : ""}
        ${earning ? html`<dt>Montant</dt><dd>${money(b.final_total)}</dd><dt>Ma part (${fmtBps(earning.driver_share_bps)})</dt><dd>${money(earning.driver_amount)}</dd>` : html`<dt>Estimation</dt><dd>${money(b.quote_total)}</dd>`}
      </dl></div>
      ${!TERMINAL.has(b.status) ? html`<div class="row">${NAVIGATION_PROVIDERS.map((n) => html`<a class="btn btn-sm" href="${n.directionsUrl(target)}" rel="noopener noreferrer" target="_blank">${n.name}</a>`)}</div><div class="rule"></div>` : ""}
      <div class="big-actions">${actions[b.status] ?? ""}</div>
      ${!TERMINAL.has(b.status) ? html`<p class="small"><a href="/driver/support">Signaler un problème</a></p>` : ""}`));
  });

  const ACTIONS: DriverAction[] = ["accept", "decline", "arriving", "arrived", "onboard", "noshow"];
  r.post("/driver/trips/:id/:action", (ctx) => {
    const actor = need(ctx, "driver:update_trip_progress");
    const id = ctx.params.id!;
    if (ctx.params.action === "complete") {
      const meters = parseScaled(field(ctx, "km", 12), 3, 1_000_000);
      if (meters === null) throw new DomainError("Kilométrage invalide (ex. 12.4).");
      const cashRaw = field(ctx, "cash", 12);
      const cash = cashRaw ? parseScaled(cashRaw, 2, 10_000_00) : null;
      if (cashRaw && cash === null) throw new DomainError("Montant encaissé invalide.");
      const res = completeBooking(d.db, { id: actor.userId, role: "DRIVER" }, id, { distanceMeters: meters, cashDeclared: cash }, d.notifier);
      return redirect(ctx, `/driver/trips/${id}`, `Course terminée : ${format(minor(res.total))}.`);
    }
    const action = ctx.params.action as DriverAction;
    if (!ACTIONS.includes(action)) throw new HttpError(404, "Action inconnue.");
    myTrip(actor.userId, id);
    driverAction(d.db, { id: actor.userId, role: "DRIVER" }, id, action, d.notifier);
    redirect(ctx, action === "decline" ? "/driver" : `/driver/trips/${id}`);
  });

  r.get("/driver/earnings", (ctx) => {
    const actor = need(ctx, "driver:read_own_earnings");
    const e = driverEarningsSummary(d.db, actor.userId);
    const rows = all<{ number: string; created_at: string; gross_amount: number; driver_share_bps: number; driver_amount: number; status: string }>(d.db,
      `SELECT b.number, e.created_at, e.gross_amount, e.driver_share_bps, e.driver_amount, e.status FROM driver_earnings e JOIN bookings b ON b.id = e.booking_id
       WHERE e.driver_id = ? ORDER BY e.created_at DESC LIMIT 100`, actor.userId);
    const adj = all<{ amount: number; reason: string; created_at: string }>(d.db, "SELECT amount, reason, created_at FROM earning_adjustments WHERE driver_id = ? ORDER BY created_at DESC LIMIT 50", actor.userId);
    const stat = (label: string, p: { trips: number; gross: number; mine: number }) => html`<div class="stat"><div class="label">${label}</div>
      <div class="value">${money(p.mine)}</div><div class="sub">${p.trips} courses · CA généré ${money(p.gross)}</div></div>`;
    send(ctx, 200, layout(ctx, "Mes revenus", html`<h1>Mes revenus</h1>
      <div class="grid grid-3">${stat("Aujourd'hui", e.today)}${stat("Cette semaine", e.week)}${stat("Ce mois", e.month)}</div>
      <div class="grid grid-2"><div class="stat"><div class="label">À verser</div><div class="value">${money(e.pending)}</div></div>
        <div class="stat"><div class="label">Espèces à remettre</div><div class="value">${money(e.cashHeld)}</div><div class="sub">Encaissées pour l'entreprise, non encore rapprochées</div></div></div>
      <div class="card"><h3>Détail</h3>${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Course</th><th>Date</th><th class="r">CA</th><th class="r">Taux</th><th class="r">Ma part</th><th>Statut</th></tr></thead><tbody>
        ${rows.map((x) => html`<tr><td class="num">${x.number}</td><td>${fmtDate(x.created_at)}</td><td class="r">${money(x.gross_amount)}</td><td class="r">${fmtBps(x.driver_share_bps)}</td><td class="r">${money(x.driver_amount)}</td><td>${badge(x.status)}</td></tr>`)}
      </tbody></table></div>` : empty("Aucun revenu", "Vos courses terminées apparaîtront ici.")}</div>
      ${adj.length ? html`<div class="card"><h3>Ajustements</h3>${adj.map((a) => html`<div class="row between small"><span>${a.reason} · ${fmtDate(a.created_at)}</span>${money(a.amount)}</div>`)}</div>` : ""}`));
  });

  r.get("/driver/profile", (ctx) => {
    need(ctx, "driver:update_own_profile");
    const u = one<{ email: string; phone: string; first_name: string; last_name: string }>(d.db, "SELECT email, phone, first_name, last_name FROM users WHERE id = ?", ctx.user!.id)!;
    const docs = all<{ label: string; expires_at: string | null; verified_at: string | null }>(d.db, "SELECT label, expires_at, verified_at FROM documents WHERE owner_type = 'DRIVER' AND owner_id = ? AND deleted_at IS NULL", ctx.user!.id);
    send(ctx, 200, layout(ctx, "Mon profil", html`<h1>Mon profil</h1>
      <div class="card"><dl class="kv"><dt>Nom</dt><dd>${u.first_name} ${u.last_name}</dd><dt>E-mail</dt><dd>${u.email}</dd><dt>Téléphone</dt><dd>${u.phone}</dd></dl></div>
      <div class="card" id="documents"><h3>Mes documents</h3>${docs.length ? docs.map((x) => html`<div class="row between"><span>${x.label}</span><span class="small muted">expire le ${fmtDate(x.expires_at)} ${x.verified_at ? "· vérifié" : "· à vérifier"}</span></div>`) : html`<p class="muted">Aucun document enregistré.</p>`}</div>
      <form class="card" method="post" action="/driver/profile/password">${csrf(ctx)}<h3>Mot de passe</h3>
        ${fieldInput("current", "Mot de passe actuel", { type: "password", required: true, autocomplete: "current-password" })}
        ${fieldInput("next", "Nouveau mot de passe", { type: "password", required: true, autocomplete: "new-password" })}
        <button class="btn" type="submit">Modifier</button></form>`));
  });
  r.get("/driver/documents", (ctx) => redirect(ctx, "/driver/profile#documents"));
  r.post("/driver/profile/password", (ctx) => {
    need(ctx, "driver:update_own_profile");
    changePassword(d.db, ctx.user!.id, ctx.form.get("current") ?? "", ctx.form.get("next") ?? "");
    redirect(ctx, "/driver/profile", "Mot de passe modifié.");
  });

  registerSupport(r, d, "/driver/support", "driver:update_own_profile");
}

function tripSummary(b: BookingRow) {
  return html`<p class="num gold">${fmtDateTime(b.pickup_at)}</p><p class="addr">${b.pickup_address}</p><p class="muted">→ ${b.dropoff_address}</p>
    ${b.estimated_distance_m !== null ? html`<p class="small muted">Distance estimée ${fmtKm(b.estimated_distance_m)}</p>` : ""}`;
}
