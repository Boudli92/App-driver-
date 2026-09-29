import type { IncomingMessage, ServerResponse } from "node:http";
import type { Raw } from "./html.ts";

export const MAX_BODY_BYTES = 64 * 1024;

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface SessionUser {
  id: string;
  email: string;
  role: "SUPER_ADMIN" | "DRIVER" | "CUSTOMER";
  status: string;
  first_name: string;
  last_name: string;
  mfa_enabled: number;
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  form: URLSearchParams;
  rawBody: string;
  cookies: Record<string, string>;
  ip: string;
  user: SessionUser | null;
  session: { idHash: string; csrf: string; mfaOk: boolean } | null;
  flash: string | null;
}

export type Handler = (ctx: Ctx) => Promise<void> | void;

interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }

export class Router {
  private routes: Route[] = [];
  on(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const pattern = new RegExp("^" + path.replace(/:(\w+)/g, (_m, k: string) => { keys.push(k); return "([A-Za-z0-9_-]{1,64})"; }) + "/?$");
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }
  get(path: string, h: Handler): this { return this.on("GET", path, h); }
  post(path: string, h: Handler): this { return this.on("POST", path, h); }
  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | "method" | null {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.pattern.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => { params[k] = m[i + 1] ?? ""; });
      return { handler: r.handler, params };
    }
    return pathMatched ? "method" : null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* cookie ignoré */ }
  }
  return out;
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new HttpError(413, "Requête trop volumineuse")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function setCookie(ctx: Ctx, name: string, value: string, opts: { maxAge?: number; secure: boolean }): void {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (opts.secure) parts.push("Secure");
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  const prev = ctx.res.getHeader("Set-Cookie");
  const list = Array.isArray(prev) ? prev : prev ? [String(prev)] : [];
  ctx.res.setHeader("Set-Cookie", [...list, parts.join("; ")]);
}

export function send(ctx: Ctx, status: number, body: Raw | string, type = "text/html; charset=utf-8"): void {
  if (ctx.res.headersSent) return;
  ctx.res.statusCode = status;
  ctx.res.setHeader("Content-Type", type);
  ctx.res.setHeader("Cache-Control", "no-store");
  ctx.res.end(typeof body === "string" ? body : body.value);
}

/** Redirection interne uniquement (anti open-redirect). */
export function redirect(ctx: Ctx, location: string, flash?: string): void {
  const safe = location.startsWith("/") && !location.startsWith("//") ? location : "/";
  if (flash) setCookie(ctx, "pdc_flash", flash.slice(0, 300), { maxAge: 30, secure: false });
  ctx.res.statusCode = 303;
  ctx.res.setHeader("Location", safe);
  ctx.res.end();
}

export function field(ctx: Ctx, name: string, max = 500): string {
  return (ctx.form.get(name) ?? "").trim().slice(0, max);
}
