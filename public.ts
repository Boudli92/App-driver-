import type { Router, Ctx } from "../lib/http.ts";
import { send, redirect, setCookie, field, HttpError } from "../lib/http.ts";
import { html, type Raw } from "../lib/html.ts";
import { token } from "../lib/security.ts";
import { layout, csrf, fieldInput, money, BRAND } from "../ui/layout.ts";
import type { Deps } from "../app.ts";
import { one } from "../db/db.ts";
import {
  login, createSession, destroySession, registerCustomer, findActiveInvitation, completeDriverSetup,
  createPasswordReset, resetPassword, beginMfaSetup, confirmMfa, verifyMfaForSession, DomainError,
} from "../services/users.ts";
import { getSetting } from "../services/settings.ts";

/** Jeton CSRF avant connexion (double-submit, cookie HttpOnly SameSite=Lax). */
function ensurePre(ctx: Ctx, secure: boolean): void {
  if (ctx.session || ctx.cookies.pdc_pre) return;
  const t = token(24);
  ctx.cookies.pdc_pre = t;
  setCookie(ctx, "pdc_pre", t, { maxAge: 7200, secure });
}

function homeFor(role: string): string {
  return role === "SUPER_ADMIN" ? "/admin" : role === "DRIVER" ? "/driver" : "/app";
}

const LEGAL_NOTICE = html`<div class="alert alert-warn"><strong>Modèle à faire valider.</strong> Ce texte est un gabarit de travail :
  il n'a pas été validé juridiquement et doit être relu et complété par un professionnel du droit avant publication.</div>`;

export function registerPublic(r: Router, d: Deps): void {
  const secure = d.env.isProd;

  r.get("/", (ctx) => {
    if (ctx.user) return redirect(ctx, homeFor(ctx.user.role));
    const p = getSetting(d.db, "pricing");
    const company = getSetting(d.db, "company");
    send(ctx, 200, layout(ctx, "Chauffeur privé sur invitation", html`
      <section class="hero"><p class="eyebrow">Service privé · Suisse</p>
        <h1>Votre trajet.<br>Notre exigence.</h1>
        <p class="lead">Un service de chauffeurs privés réservé à ses membres. Des chauffeurs de l'entreprise, des véhicules entretenus, une discrétion absolue.</p>
        <div class="row"><a class="btn btn-primary" href="/login">Réserver une course</a><a class="btn" href="/register">Rejoindre le Club</a></div>
      </section>
      <section class="section" id="service"><div class="grid grid-3">
        <div class="feature"><h3>Service premium</h3><p>Chaque course est assurée par un chauffeur employé par l'entreprise, formé à nos standards.</p></div>
        <div class="feature"><h3>Véhicules</h3><p>Des véhicules récents, propres et contrôlés, suivis dans notre programme d'entretien.</p></div>
        <div class="feature"><h3>Expérience</h3><p>Ponctualité, accueil soigné et suivi de votre course en temps réel dans votre espace membre.</p></div>
      </div></section>
      <section class="section"><h2>Comment ça fonctionne</h2><div class="grid grid-4">
        <div class="stat"><div class="label">01</div><p>Vous recevez une invitation d'un membre ou de l'entreprise.</p></div>
        <div class="stat"><div class="label">02</div><p>Vous créez votre demande d'adhésion.</p></div>
        <div class="stat"><div class="label">03</div><p>Le Club valide personnellement chaque nouveau membre.</p></div>
        <div class="stat"><div class="label">04</div><p>Vous réservez, immédiatement ou à l'avance.</p></div>
      </div></section>
      <section class="section" id="tarifs"><h2>Tarifs</h2>
        <div class="table-wrap"><table class="price-table"><thead><tr><th></th><th class="r">Jour (${p.nightEndHour}h–${p.nightStartHour}h)</th><th class="r">Nuit (${p.nightStartHour}h–${p.nightEndHour}h)</th></tr></thead><tbody>
          <tr><td>Prise en charge</td><td class="r">${money(p.baseFare)}</td><td class="r">${money(p.baseFare)}</td></tr>
          <tr><td>Kilomètre</td><td class="r">${money(p.perKm)}</td><td class="r">${money(p.nightPerKm)}</td></tr>
          <tr><td>Course minimum (prise en charge incluse)</td><td class="r">${money(p.minimumFare)}</td><td class="r">${money(p.nightMinimumFare)}</td></tr>
          <tr><td>Attente, après ${p.freeWaitingMinutes} minutes offertes</td><td class="r">${money(p.waitingPerMinute)} / min</td><td class="r">${money(p.nightWaitingPerMinute)} / min</td></tr>
        </tbody></table></div>
        <p class="muted small">Prix en CHF, calculés par nos serveurs. Le tarif appliqué dépend de l'heure de prise en charge.</p></section>
      <section class="section"><div class="grid grid-3">
        <div class="feature"><h3>Avantages membres</h3><p>Historique, factures et reçus centralisés. Invitez vos proches grâce à votre lien personnel.</p></div>
        <div class="feature"><h3>Sécurité</h3><p>Accès sur validation, données protégées, paiements traités par un prestataire certifié : nous ne stockons jamais vos données de carte.</p></div>
        <div class="feature"><h3>Contact</h3><p>${company.phone || "Téléphone communiqué aux membres"}<br>${company.email || ""}</p></div>
      </div></section>`, { public: true, description: "Chauffeurs privés en Suisse, service réservé aux membres. Réservation immédiate ou programmée." }));
  });

  r.get("/membership", (ctx) => {
    send(ctx, 200, layout(ctx, "Le Club", html`<div class="card"><h1>Le Club</h1>
      <p>Le « Private Driver Club » est le nom d'un service privé proposé par l'entreprise à ses membres. Il ne s'agit pas d'une catégorie juridique particulière :
      l'entreprise est l'unique prestataire des courses, effectuées par ses propres chauffeurs.</p>
      <p>L'adhésion se fait sur invitation et après validation manuelle par l'entreprise.</p>
      <a class="btn btn-primary" href="/register">Faire une demande</a></div>`, { public: true }));
  });

  // --- Connexion ---------------------------------------------------------------------
  const loginPage = (ctx: Ctx, next = "") => layout(ctx, "Connexion", html`<div class="card gold"><h1>Connexion</h1>
    <form method="post" action="/login">${csrf(ctx)}<input type="hidden" name="next" value="${next}">
      ${fieldInput("email", "E-mail", { type: "email", required: true, autocomplete: "username" })}
      ${fieldInput("password", "Mot de passe", { type: "password", required: true, autocomplete: "current-password" })}
      <button class="btn btn-primary btn-block" type="submit">Se connecter</button></form>
    <p class="small muted"><a href="/forgot-password">Mot de passe oublié ?</a> · <a href="/register">Demander une adhésion</a></p></div>`, { public: true });

  r.get("/login", (ctx) => {
    if (ctx.user) return redirect(ctx, homeFor(ctx.user.role));
    ensurePre(ctx, secure);
    send(ctx, 200, loginPage(ctx, ctx.query.get("next") ?? ""));
  });

  r.post("/login", (ctx) => {
    const email = field(ctx, "email", 254).toLowerCase();
    if (!d.limiter.login.take(`${ctx.ip}|${email}`)) throw new DomainError("Trop de tentatives. Réessayez dans 15 minutes.", 429);
    const user = login(d.db, email, ctx.form.get("password") ?? "");
    const { token: t, maxAge } = createSession(d.db, user, String(ctx.req.headers["user-agent"] ?? ""));
    setCookie(ctx, "pdc_session", t, { maxAge, secure });
    setCookie(ctx, "pdc_pre", "", { maxAge: 0, secure });
    if (user.role === "SUPER_ADMIN") return redirect(ctx, "/login/mfa");
    const next = field(ctx, "next", 200);
    redirect(ctx, next.startsWith(homeFor(user.role)) ? next : homeFor(user.role));
  });

  r.post("/logout", (ctx) => {
    if (ctx.session) destroySession(d.db, ctx.session.idHash);
    setCookie(ctx, "pdc_session", "", { maxAge: 0, secure });
    redirect(ctx, "/");
  });

  // --- MFA du propriétaire (obligatoire) ------------------------------------------------
  r.get("/login/mfa", (ctx) => {
    if (!ctx.user || ctx.user.role !== "SUPER_ADMIN") return redirect(ctx, "/login");
    if (ctx.session?.mfaOk) return redirect(ctx, "/admin");
    if (!ctx.user.mfa_enabled) {
      const row = one<{ mfa_secret: string | null }>(d.db, "SELECT mfa_secret FROM users WHERE id = ?", ctx.user.id);
      const secret = row?.mfa_secret ?? beginMfaSetup(d.db, ctx.user.id);
      const uri = `otpauth://totp/${encodeURIComponent(BRAND)}:${encodeURIComponent(ctx.user.email)}?secret=${secret}&issuer=${encodeURIComponent(BRAND)}&digits=6&period=30`;
      return send(ctx, 200, layout(ctx, "Activer la double authentification", html`<div class="card gold"><h1>Double authentification</h1>
        <p>Obligatoire pour le compte propriétaire. Ajoutez ce compte dans votre application d'authentification (Google Authenticator, 1Password, Authy…) avec la clé :</p>
        <p class="money-xl num">${secret.replace(/(.{4})/g, "$1 ").trim()}</p>
        <p class="small muted">Ou lien de configuration : <code>${uri}</code></p>
        <form method="post" action="/login/mfa/setup">${csrf(ctx)}${fieldInput("code", "Code à 6 chiffres", { inputmode: "numeric", required: true, autocomplete: "one-time-code" })}
        <button class="btn btn-primary" type="submit">Activer</button></form></div>`, { public: true }));
    }
    send(ctx, 200, layout(ctx, "Vérification", html`<div class="card gold"><h1>Vérification</h1>
      <form method="post" action="/login/mfa">${csrf(ctx)}${fieldInput("code", "Code de votre application d'authentification", { inputmode: "numeric", required: true, autocomplete: "one-time-code" })}
      <button class="btn btn-primary" type="submit">Valider</button></form></div>`, { public: true }));
  });

  r.post("/login/mfa/setup", (ctx) => {
    if (!ctx.user || ctx.user.role !== "SUPER_ADMIN" || !ctx.session) throw new HttpError(401, "");
    confirmMfa(d.db, ctx.user.id, field(ctx, "code", 12), ctx.session.idHash);
    redirect(ctx, "/admin", "Double authentification activée.");
  });

  r.post("/login/mfa", (ctx) => {
    if (!ctx.user || ctx.user.role !== "SUPER_ADMIN" || !ctx.session) throw new HttpError(401, "");
    if (!d.limiter.login.take(`mfa|${ctx.user.id}`)) throw new DomainError("Trop de tentatives. Patientez.", 429);
    verifyMfaForSession(d.db, ctx.user.id, field(ctx, "code", 12), ctx.session.idHash);
    redirect(ctx, "/admin");
  });

  // --- Adhésion ----------------------------------------------------------------------------
  const registerPage = (ctx: Ctx, code: string, inviter?: string): Raw => layout(ctx, "Demande d'adhésion", html`<div class="card gold"><h1>Demande d'adhésion</h1>
    ${inviter ? html`<p class="gold">Vous êtes invité par ${inviter}.</p>` : html`<p class="muted">L'adhésion est soumise à validation. Un code d'invitation accélère le traitement de votre demande.</p>`}
    <form method="post" action="/register">${csrf(ctx)}
      ${fieldInput("code", "Code d'invitation", { value: code, hint: "Facultatif" })}
      <div class="grid grid-2">${fieldInput("first_name", "Prénom", { required: true, autocomplete: "given-name" })}${fieldInput("last_name", "Nom", { required: true, autocomplete: "family-name" })}</div>
      ${fieldInput("email", "E-mail", { type: "email", required: true, autocomplete: "email" })}
      ${fieldInput("phone", "Téléphone", { type: "tel", required: true, autocomplete: "tel", placeholder: "+41 79 000 00 00" })}
      ${fieldInput("password", "Mot de passe", { type: "password", required: true, autocomplete: "new-password", hint: "10 caractères minimum, lettres et chiffres." })}
      <div class="field"><label class="check"><input type="checkbox" name="accept" value="yes" required> J'accepte les <a href="/terms">conditions</a> et la <a href="/privacy">politique de confidentialité</a>.</label></div>
      <button class="btn btn-primary btn-block" type="submit">Envoyer ma demande</button></form></div>`, { public: true });

  r.get("/register", (ctx) => { ensurePre(ctx, secure); send(ctx, 200, registerPage(ctx, ctx.query.get("code") ?? "")); });

  r.get("/invite/:code", (ctx) => {
    ensurePre(ctx, secure);
    const inv = findActiveInvitation(d.db, ctx.params.code!, "CUSTOMER");
    if (!inv) return send(ctx, 410, layout(ctx, "Invitation", html`<div class="card"><h1>Invitation expirée</h1><p>Ce lien n'est plus valide. Demandez un nouveau lien à la personne qui vous a invité.</p></div>`, { public: true }));
    const inviter = inv.inviter_user_id ? one<{ first_name: string }>(d.db, "SELECT first_name FROM users WHERE id = ?", inv.inviter_user_id) : undefined;
    send(ctx, 200, registerPage(ctx, inv.code, inviter?.first_name));
  });

  r.post("/register", (ctx) => {
    registerCustomer(d.db, {
      code: field(ctx, "code", 20), email: field(ctx, "email", 254), phone: field(ctx, "phone", 30), firstName: field(ctx, "first_name", 80),
      lastName: field(ctx, "last_name", 80), password: ctx.form.get("password") ?? "", userAgent: String(ctx.req.headers["user-agent"] ?? ""),
      acceptTerms: ctx.form.get("accept") === "yes",
    }, d.notifier);
    redirect(ctx, "/login", "Demande envoyée. Vous pouvez vous connecter pour suivre sa validation.");
  });

  // --- Configuration du compte chauffeur (lien envoyé par le propriétaire) -----------------
  r.get("/setup/:token", (ctx) => {
    ensurePre(ctx, secure);
    send(ctx, 200, layout(ctx, "Configuration du compte", html`<div class="card gold"><h1>Votre compte chauffeur</h1>
      <p class="muted">Choisissez votre mot de passe. Votre compte sera ensuite vérifié et activé par l'entreprise.</p>
      <form method="post" action="/setup/${ctx.params.token!}">${csrf(ctx)}
      ${fieldInput("password", "Mot de passe", { type: "password", required: true, autocomplete: "new-password", hint: "10 caractères minimum, lettres et chiffres." })}
      <button class="btn btn-primary" type="submit">Enregistrer</button></form></div>`, { public: true }));
  });
  r.post("/setup/:token", (ctx) => {
    completeDriverSetup(d.db, ctx.params.token!, ctx.form.get("password") ?? "");
    redirect(ctx, "/login", "Compte configuré. Il sera actif dès validation par l'entreprise.");
  });

  // --- Mot de passe oublié -----------------------------------------------------------------
  r.get("/forgot-password", (ctx) => {
    ensurePre(ctx, secure);
    send(ctx, 200, layout(ctx, "Mot de passe oublié", html`<div class="card"><h1>Mot de passe oublié</h1>
      <form method="post" action="/forgot-password">${csrf(ctx)}${fieldInput("email", "E-mail", { type: "email", required: true })}
      <button class="btn btn-primary" type="submit">Recevoir un lien</button></form></div>`, { public: true }));
  });
  r.post("/forgot-password", (ctx) => {
    const email = field(ctx, "email", 254);
    if (d.limiter.login.take(`reset|${ctx.ip}`)) {
      const res = createPasswordReset(d.db, email);
      if (res) {
        const u = one<{ id: string; email: string }>(d.db, "SELECT id, email FROM users WHERE id = ?", res.userId)!;
        d.notifier.notify(u, "PASSWORD_RESET", "Réinitialisation du mot de passe", `${d.env.appUrl}/reset/${res.token} (valable 1 heure)`);
        if (!d.env.isProd) console.info(`[dev] lien de réinitialisation : ${d.env.appUrl}/reset/${res.token}`);
      }
    }
    // Réponse identique dans tous les cas : pas d'énumération de comptes.
    redirect(ctx, "/login", "Si un compte existe pour cette adresse, un lien de réinitialisation a été envoyé.");
  });
  r.get("/reset/:token", (ctx) => {
    ensurePre(ctx, secure);
    send(ctx, 200, layout(ctx, "Nouveau mot de passe", html`<div class="card"><h1>Nouveau mot de passe</h1>
      <form method="post" action="/reset/${ctx.params.token!}">${csrf(ctx)}${fieldInput("password", "Nouveau mot de passe", { type: "password", required: true, autocomplete: "new-password" })}
      <button class="btn btn-primary" type="submit">Enregistrer</button></form></div>`, { public: true }));
  });
  r.post("/reset/:token", (ctx) => {
    resetPassword(d.db, ctx.params.token!, ctx.form.get("password") ?? "");
    redirect(ctx, "/login", "Mot de passe mis à jour. Vous pouvez vous connecter.");
  });

  // --- Pages légales (gabarits à valider) --------------------------------------------------
  const company = () => getSetting(d.db, "company");
  const legal = (title: string, body: Raw) => (ctx: Ctx) => send(ctx, 200, layout(ctx, title, html`<div class="card"><h1>${title}</h1>${LEGAL_NOTICE}${body}</div>`, { public: true }));
  r.get("/terms", (ctx) => legal("Conditions générales", html`
    <h3>1. Prestataire</h3><p>Les courses sont exécutées par ${company().legal_name || "[raison sociale à compléter]"}, seul prestataire du service, au moyen de ses propres chauffeurs.</p>
    <h3>2. Adhésion</h3><p>L'accès au service est réservé aux membres validés par l'entreprise. L'entreprise peut refuser ou suspendre une adhésion.</p>
    <h3>3. Réservation et prix</h3><p>Les prix sont calculés selon le tarif en vigueur publié sur le site. Le montant final tient compte de la distance parcourue et du temps d'attente au-delà des minutes offertes.</p>
    <h3>4. Annulation</h3><p>[Politique d'annulation, délais et éventuels frais à définir.]</p>
    <h3>5. Paiement</h3><p>Le paiement est dû à l'entreprise. Les paiements en ligne sont traités par un prestataire de paiement tiers.</p>
    <h3>6. Droit applicable et for</h3><p>[À compléter.]</p>`)(ctx));
  r.get("/privacy", (ctx) => legal("Politique de confidentialité", html`
    <p>Responsable du traitement : ${company().legal_name || "[à compléter]"}, ${company().address} ${company().postal_code} ${company().city}.</p>
    <h3>Données traitées</h3><p>Identité, coordonnées, historique des courses, factures et paiements (sans données de carte, traitées exclusivement par le prestataire de paiement), journaux de sécurité.</p>
    <h3>Finalités</h3><p>Exécution des courses, facturation, sécurité du service, obligations légales de conservation.</p>
    <h3>Vos droits</h3><p>Accès, rectification, effacement lorsque la loi le permet, et export de vos données depuis votre profil. [Contact à compléter.]</p>
    <h3>Cadre légal</h3><p>Loi fédérale sur la protection des données (LPD). [Préciser si le RGPD s'applique à certaines situations.]</p>`)(ctx));
  r.get("/cookies", (ctx) => legal("Politique cookies", html`<p>Ce site n'utilise que des cookies strictement nécessaires : session de connexion, protection contre la falsification de requêtes et messages de confirmation. Aucun cookie publicitaire ni de mesure d'audience.</p>`)(ctx));
  r.get("/legal", (ctx) => { const c = company(); legal("Mentions légales", html`<dl class="kv">
    <dt>Raison sociale</dt><dd>${c.legal_name || "[à compléter]"}</dd><dt>Adresse</dt><dd>${c.address} ${c.postal_code} ${c.city}</dd>
    <dt>IDE / UID</dt><dd>${c.uid || "[à compléter]"}</dd><dt>N° TVA</dt><dd>${c.vat_number || "—"}</dd>
    <dt>Contact</dt><dd>${c.email} ${c.phone}</dd></dl>`)(ctx); });
  r.get("/contact", (ctx) => { const c = company(); send(ctx, 200, layout(ctx, "Contact", html`<div class="card"><h1>Contact</h1>
    <dl class="kv"><dt>Téléphone</dt><dd>${c.phone || "—"}</dd><dt>E-mail</dt><dd>${c.email || "—"}</dd><dt>Adresse</dt><dd>${c.address} ${c.postal_code} ${c.city}</dd></dl></div>`, { public: true })); });

  r.get("/robots.txt", (ctx) => send(ctx, 200, `User-agent: *\nAllow: /$\nAllow: /membership\nAllow: /terms\nAllow: /privacy\nAllow: /contact\nDisallow: /app\nDisallow: /driver\nDisallow: /admin\nDisallow: /invite\nDisallow: /setup\nDisallow: /reset\nSitemap: ${d.env.appUrl}/sitemap.xml\n`, "text/plain; charset=utf-8"));
  r.get("/sitemap.xml", (ctx) => send(ctx, 200, `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${["/", "/membership", "/terms", "/privacy", "/contact", "/legal"].map((p) => `<url><loc>${d.env.appUrl}${p}</loc></url>`).join("")}</urlset>`, "application/xml"));
}
