import { html, raw, type Raw, type Part } from "../lib/html.ts";
import type { Ctx } from "../lib/http.ts";
import { format, minor } from "../domain/money/money.ts";

export const BRAND = "Private Driver Club";

type NavItem = [href: string, label: string];

const NAV: Record<string, NavItem[]> = {
  SUPER_ADMIN: [
    ["/admin", "TABLEAU DE BORD"], ["/admin/bookings", "COURSES"], ["/admin/dispatch", "DISPATCH"], ["/admin/customers", "CLIENTS"],
    ["/admin/drivers", "CHAUFFEURS"], ["/admin/vehicles", "VÉHICULES"], ["/admin/payments", "PAIEMENTS"], ["/admin/invoices", "FACTURES"],
    ["/admin/finance", "FINANCES"], ["/admin/referrals", "PARRAINAGES"], ["/admin/documents", "DOCUMENTS"], ["/admin/support", "SUPPORT"],
    ["/admin/audit", "AUDIT"], ["/admin/settings", "PARAMÈTRES"],
  ],
  DRIVER: [
    ["/driver", "AUJOURD'HUI"], ["/driver/trips", "MES COURSES"], ["/driver/earnings", "MES REVENUS"],
    ["/driver/profile", "MON PROFIL"], ["/driver/support", "SUPPORT"],
  ],
  CUSTOMER: [
    ["/app/book", "RÉSERVER"], ["/app/bookings", "MES COURSES"], ["/app/invoices", "FACTURES"],
    ["/app/referrals", "INVITER"], ["/app/profile", "PROFIL"], ["/app/support", "SUPPORT"],
  ],
};

export function csrf(ctx: Ctx): Raw {
  return html`<input type="hidden" name="_csrf" value="${ctx.session?.csrf ?? ctx.cookies.pdc_pre ?? ""}">`;
}

export function money(v: number | null | undefined): Raw {
  if (v === null || v === undefined) return html`<span class="muted">—</span>`;
  return html`<span class="money">${format(minor(v))}</span>`;
}

const STATUS: Record<string, [string, string]> = {
  REQUESTED: ["Demandée", "warn"], PENDING_PAYMENT: ["Paiement en attente", "warn"], PAYMENT_AUTHORIZED: ["Paiement autorisé", "info"],
  CONFIRMED: ["Confirmée", "info"], ASSIGNED: ["Attribuée", "info"], DRIVER_ACCEPTED: ["Acceptée", "gold"],
  DRIVER_ARRIVING: ["Chauffeur en route", "gold"], DRIVER_ARRIVED: ["Chauffeur arrivé", "gold"], PASSENGER_ONBOARD: ["À bord", "gold"],
  IN_PROGRESS: ["En cours", "gold"], COMPLETED: ["Terminée", "ok"], CANCELLED_BY_CUSTOMER: ["Annulée (client)", "danger"],
  CANCELLED_BY_COMPANY: ["Annulée (entreprise)", "danger"], CANCELLED_BY_DRIVER: ["Annulée (chauffeur)", "danger"], NO_SHOW: ["Absent", "danger"],
  PAYMENT_FAILED: ["Paiement échoué", "danger"], REFUNDED: ["Remboursée", "info"], PARTIALLY_REFUNDED: ["Remb. partiel", "info"],
  INVITED: ["Invité", "info"], REGISTRATION_PENDING: ["Inscription", "warn"], PENDING_APPROVAL: ["À valider", "warn"], APPROVED: ["Membre", "ok"],
  REJECTED: ["Refusé", "danger"], SUSPENDED: ["Suspendu", "danger"], BLOCKED: ["Bloqué", "danger"], PENDING_SETUP: ["À vérifier", "warn"],
  ACTIVE: ["Actif", "ok"], INACTIVE: ["Inactif", "danger"], AVAILABLE: ["Disponible", "ok"], IN_SERVICE: ["En service", "gold"],
  MAINTENANCE: ["Entretien", "warn"], ISSUED: ["À payer", "warn"], PAID: ["Payée", "ok"], PENDING: ["En attente", "warn"], FAILED: ["Échoué", "danger"],
  CANCELLED: ["Annulé", "danger"], AUTHORIZED: ["Autorisé", "info"], COLLECTED: ["Encaissé", "warn"], RECONCILED: ["Rapproché", "ok"],
  DISPUTED: ["Écart", "danger"], CALCULATED: ["Calculée", "info"], OPEN: ["Ouvert", "warn"], ANSWERED: ["Répondu", "ok"], CLOSED: ["Fermé", "info"],
};
export function badge(status: string): Raw {
  const [label, tone] = STATUS[status] ?? [status, "info"];
  return html`<span class="badge badge-${tone}">${label}</span>`;
}

export function empty(title: string, text = ""): Raw {
  return html`<div class="empty"><strong>${title}</strong>${text}</div>`;
}

export function fieldInput(name: string, label: string, opts: { type?: string; value?: string | number | null; required?: boolean; hint?: string; autocomplete?: string; min?: string; max?: string; step?: string; inputmode?: string; placeholder?: string } = {}): Raw {
  const id = `f_${name}`;
  return html`<div class="field"><label for="${id}">${label}</label>
    <input id="${id}" name="${name}" type="${opts.type ?? "text"}" value="${opts.value ?? ""}"${opts.required ? raw(" required") : ""}
      ${opts.autocomplete ? raw(`autocomplete="${opts.autocomplete}"`) : ""}${opts.min ? raw(` min="${opts.min}"`) : ""}${opts.max ? raw(` max="${opts.max}"`) : ""}
      ${opts.step ? raw(` step="${opts.step}"`) : ""}${opts.inputmode ? raw(` inputmode="${opts.inputmode}"`) : ""}
      ${opts.placeholder ? html` placeholder="${opts.placeholder}"` : ""}${opts.hint ? raw(` aria-describedby="${id}_h"`) : ""}>
    ${opts.hint ? html`<div class="hint" id="${id}_h">${opts.hint}</div>` : ""}</div>`;
}

export function fieldSelect(name: string, label: string, options: [string, string][], selected = "", required = false): Raw {
  return html`<div class="field"><label for="f_${name}">${label}</label>
    <select id="f_${name}" name="${name}"${required ? raw(" required") : ""}>
      ${options.map(([v, l]) => html`<option value="${v}"${v === selected ? raw(" selected") : ""}>${l}</option>`)}
    </select></div>`;
}

export function fieldTextarea(name: string, label: string, value = "", hint = ""): Raw {
  return html`<div class="field"><label for="f_${name}">${label}</label><textarea id="f_${name}" name="${name}" maxlength="2000">${value}</textarea>
    ${hint ? html`<div class="hint">${hint}</div>` : ""}</div>`;
}

/** Bouton d'action POST protégé CSRF, avec confirmation explicite pour les actions sensibles. */
export function actionButton(ctx: Ctx, action: string, label: string, opts: { cls?: string; confirm?: string; fields?: Record<string, string> } = {}): Raw {
  return html`<form class="inline" method="post" action="${action}">${csrf(ctx)}
    ${Object.entries(opts.fields ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
    ${opts.confirm ? html`<label class="check small"><input type="checkbox" name="confirm" value="yes" required> ${opts.confirm}</label>` : ""}
    <button class="btn ${opts.cls ?? ""}" type="submit">${label}</button></form>`;
}

export function layout(ctx: Ctx, title: string, body: Part, opts: { public?: boolean; noIndex?: boolean; description?: string } = {}): Raw {
  const user = ctx.user;
  const nav = user && !opts.public ? NAV[user.role] ?? [] : [];
  const isCurrent = (href: string) => ctx.path === href || (href !== "/admin" && href !== "/driver" && ctx.path.startsWith(href + "/"));
  const flash = ctx.flash;
  const flashIsError = flash?.startsWith("!");
  const home = user?.role === "SUPER_ADMIN" ? "/admin" : user?.role === "DRIVER" ? "/driver" : user ? "/app" : "/";
  return html`<!doctype html>
<html lang="fr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title} — ${BRAND}</title>
<meta name="description" content="${opts.description ?? "Service privé de chauffeurs, sur invitation. Suisse."}">
${opts.noIndex !== false && !opts.public ? raw('<meta name="robots" content="noindex, nofollow">') : ""}
<meta property="og:title" content="${title} — ${BRAND}"><meta property="og:type" content="website">
<meta name="theme-color" content="#0b0b0c">
<link rel="stylesheet" href="/static/app.css">
</head><body class="${nav.length ? "has-bottomnav" : ""}">
<a class="skip" href="#main">Aller au contenu</a>
<header class="topbar"><div class="wrap">
  <a class="brand" href="${home}">Private <span>Driver</span> Club</a>
  <nav class="topnav" aria-label="Compte">
    ${user ? html`<span class="muted small hide-m">${user.first_name}</span>
      <form class="inline" method="post" action="/logout">${csrf(ctx)}<button class="btn btn-sm btn-ghost" type="submit">Déconnexion</button></form>`
    : html`<a class="hide-m" href="/#service">Le service</a><a class="hide-m" href="/#tarifs">Tarifs</a><a href="/login">Connexion</a>
      <a class="btn btn-sm btn-primary hide-m" href="/register">Rejoindre le Club</a>`}
  </nav></div></header>
<main id="main"><div class="wrap">
  ${flash ? html`<div class="alert ${flashIsError ? "alert-error" : "alert-ok"}" role="${flashIsError ? "alert" : "status"}">${flashIsError ? flash.slice(1) : flash}</div>` : ""}
  ${nav.length ? html`<div class="shell"><nav class="sidebar" aria-label="Navigation principale">
      ${nav.map(([href, label]) => html`<a href="${href}"${isCurrent(href) ? raw(' aria-current="page"') : ""}>${label}</a>`)}
    </nav><div>${body}</div></div>
    <nav class="bottomnav" aria-label="Navigation mobile">
      ${nav.slice(0, 5).map(([href, label]) => html`<a href="${href}"${isCurrent(href) ? raw(' aria-current="page"') : ""}>${label}</a>`)}
    </nav>` : body}
</div></main>
${opts.public ? html`<footer class="site"><div class="wrap"><span>© ${new Date().getFullYear()} ${BRAND}</span>
  <nav aria-label="Informations légales"><a href="/terms">Conditions</a><a href="/privacy">Confidentialité</a><a href="/cookies">Cookies</a><a href="/legal">Mentions légales</a><a href="/contact">Contact</a></nav>
</div></footer>` : ""}
</body></html>`;
}

export function page(title: string, ...parts: Part[]): Raw {
  return html`<h1>${title}</h1>${parts}`;
}
