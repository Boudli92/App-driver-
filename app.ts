import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DB } from "./db/db.ts";
import type { Env } from "./config/env.ts";
import { Router, HttpError, type Ctx, parseCookies, readBody, send, redirect, setCookie } from "./lib/http.ts";
import { html } from "./lib/html.ts";
import { safeEqual, sha256, RateLimiter } from "./lib/security.ts";
import { layout } from "./ui/layout.ts";
import { loadSession, DomainError } from "./services/users.ts";
import { getSetting } from "./services/settings.ts";
import { NotificationService } from "./services/notify.ts";
import { audit } from "./services/audit.ts";
import { authorize, AuthorizationError, type Actor, type Permission, type CustomerStatus, type DriverStatus } from "./domain/auth/rbac.ts";
import type { PaymentProvider } from "./domain/payments/payments.ts";
import { registerPublic } from "./routes/public.ts";
import { registerCustomer } from "./routes/customer.ts";
import { registerDriver } from "./routes/driver.ts";
import { registerAdmin } from "./routes/admin.ts";
import { registerWebhooks } from "./routes/webhooks.ts";

export interface Deps {
  db: DB;
  env: Env;
  notifier: NotificationService;
  payments: PaymentProvider | null;
  limiter: { login: RateLimiter; forms: RateLimiter; api: RateLimiter };
}

const here = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(here, "..", "public", "app.css"), "utf8");
const CSS_ETAG = `"${sha256(CSS).slice(0, 16)}"`;

export function actorOf(ctx: Ctx): Actor {
  if (!ctx.user) throw new HttpError(401, "Non authentifié");
  const a: Actor = { userId: ctx.user.id, role: ctx.user.role, mfaVerified: ctx.session?.mfaOk === true };
  if (ctx.user.role === "CUSTOMER") a.customerStatus = ctx.user.status as CustomerStatus;
  if (ctx.user.role === "DRIVER") a.driverStatus = ctx.user.status as DriverStatus;
  return a;
}

/** Garde serveur : authentification + rôle + permission + statut (§33). */
export function need(ctx: Ctx, permission: Permission): Actor {
  const actor = actorOf(ctx);
  authorize(actor, permission);
  return actor;
}

export const auditActor = (ctx: Ctx) => ({ id: ctx.user?.id ?? null, role: ctx.user?.role ?? "ANONYMOUS" });

export function createApp(deps: Deps) {
  const router = new Router();
  registerWebhooks(router, deps);
  registerPublic(router, deps);
  registerCustomer(router, deps);
  registerDriver(router, deps);
  registerAdmin(router, deps);

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://local");
    const ip = (deps.env.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "") || req.socket.remoteAddress || "?";
    const ctx: Ctx = {
      req, res, method: req.method ?? "GET", path: decodeURIComponent(url.pathname).replace(/\/+$/, "") || "/",
      query: url.searchParams, params: {}, form: new URLSearchParams(), rawBody: "", cookies: parseCookies(req.headers.cookie),
      ip, user: null, session: null, flash: null,
    };
    // En-têtes de sécurité (§92–93).
    res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'none'; form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (deps.env.isProd) res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");

    try {
      if (ctx.path === "/static/app.css") {
        res.setHeader("ETag", CSS_ETAG);
        if (req.headers["if-none-match"] === CSS_ETAG) { res.statusCode = 304; res.end(); return; }
        res.setHeader("Cache-Control", "public, max-age=86400");
        res.setHeader("Content-Type", "text/css; charset=utf-8");
        res.end(CSS); return;
      }
      if (ctx.path === "/healthz") { send(ctx, 200, "ok", "text/plain"); return; }
      if (ctx.path === "/readyz") {
        deps.db.prepare("SELECT 1").get();
        send(ctx, 200, "ready", "text/plain"); return;
      }
      if (!deps.limiter.api.take(`ip:${ip}`)) throw new HttpError(429, "Trop de requêtes. Patientez un instant.");

      if (ctx.cookies.pdc_flash) { ctx.flash = ctx.cookies.pdc_flash; setCookie(ctx, "pdc_flash", "", { maxAge: 0, secure: false }); }
      const s = loadSession(deps.db, ctx.cookies.pdc_session);
      if (s) { ctx.user = s.user; ctx.session = s.session; }

      if (ctx.method === "POST") {
        ctx.rawBody = await readBody(req);
        const isWebhook = ctx.path.startsWith("/webhooks/");
        if (!isWebhook) {
          ctx.form = new URLSearchParams(ctx.rawBody);
          // CSRF : jeton de session obligatoire + vérification d'origine.
          const origin = req.headers.origin;
          if (origin && origin !== deps.env.appUrl && deps.env.isProd) throw new HttpError(403, "Origine refusée");
          const sent = ctx.form.get("_csrf") ?? "";
          const expected = ctx.session?.csrf ?? ctx.cookies.pdc_pre ?? "";
          if (!expected || !safeEqual(sent, expected)) throw new HttpError(403, "Session expirée. Rechargez la page et réessayez.");
          if (!deps.limiter.forms.take(`form:${ip}`)) throw new HttpError(429, "Trop d'envois. Patientez un instant.");
        }
      }

      // Mode maintenance (§69) : seul le propriétaire garde l'accès.
      if (getSetting(deps.db, "maintenance") && ctx.user?.role !== "SUPER_ADMIN" && !["/login", "/logout", "/login/mfa"].includes(ctx.path) && !ctx.path.startsWith("/webhooks/")) {
        send(ctx, 503, layout(ctx, "Maintenance", html`<div class="card"><h2>Maintenance en cours</h2><p class="muted">Le service revient très prochainement. Merci de votre patience.</p></div>`, { public: true }));
        return;
      }

      const m = router.match(ctx.method, ctx.path);
      if (m === "method") throw new HttpError(405, "Méthode non autorisée");
      if (!m) throw new HttpError(404, "Page introuvable");
      ctx.params = m.params;
      await m.handler(ctx);
    } catch (e) {
      handleError(ctx, e, deps);
    }
  };
}

function handleError(ctx: Ctx, e: unknown, deps: Deps): void {
  if (ctx.res.headersSent) { ctx.res.end(); return; }
  let status = 500, message = "Une erreur inattendue est survenue. L'équipe a été informée ; aucune opération financière n'a été validée.";
  if (e instanceof AuthorizationError) {
    status = 403; message = e.reason === "customer_not_approved"
      ? "Votre adhésion est en cours de validation. Vous pourrez réserver dès son approbation."
      : e.reason === "mfa_required" ? "Vérification en deux étapes requise." : "Accès refusé.";
    try { audit(deps.db, { id: ctx.user?.id ?? null, role: ctx.user?.role ?? "ANONYMOUS" }, "ACCESS_DENIED", "route", ctx.path, "DENIED", { reason: e.reason, method: ctx.method }); } catch { /* */ }
    if (e.reason === "mfa_required") { redirect(ctx, "/login/mfa"); return; }
  } else if (e instanceof HttpError) {
    status = e.status; message = e.message;
    if (status === 401) { redirect(ctx, `/login?next=${encodeURIComponent(ctx.path)}`); return; }
  } else if (e instanceof DomainError) {
    status = e.status; message = e.message;
    if (ctx.method === "POST" && status < 500) {
      const back = String(ctx.req.headers.referer ?? "");
      let path = ctx.path;
      try { const u = new URL(back); if (u.origin === deps.env.appUrl || !deps.env.isProd) path = u.pathname + u.search; } catch { /* */ }
      redirect(ctx, path, "!" + message);
      return;
    }
  } else {
    console.error("[error]", ctx.method, ctx.path, e instanceof Error ? e.stack : e);
  }
  const titles: Record<number, string> = { 403: "Accès refusé", 404: "Introuvable", 405: "Non autorisé", 409: "Conflit", 413: "Trop volumineux", 429: "Trop de requêtes" };
  send(ctx, status, layout(ctx, titles[status] ?? "Erreur", html`<div class="card"><h2>${titles[status] ?? "Un problème est survenu"}</h2><p>${message}</p>
    <a class="btn" href="/">Retour</a></div>`, { public: !ctx.user }));
}
