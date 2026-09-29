import { createServer } from "node:http";
import { loadEnv } from "./config/env.ts";
import { openDb } from "./db/db.ts";
import { createApp } from "./app.ts";
import { NotificationService } from "./services/notify.ts";
import { RateLimiter } from "./lib/security.ts";
import { StripeProvider } from "./payments/stripe.ts";
import { DevMockProvider } from "./payments/dev-mock.ts";
import type { PaymentProvider } from "./domain/payments/payments.ts";

const env = loadEnv();
const db = openDb(env.databasePath);

let payments: PaymentProvider | null = null;
if (env.stripeSecretKey) payments = new StripeProvider(env.stripeSecretKey, env.stripeWebhookSecret, env.stripeMethods);
else if (!env.isProd && process.env.DEV_MOCK_PAYMENTS === "true") payments = new DevMockProvider(env.appUrl);

const app = createApp({
  db, env, payments, notifier: new NotificationService(db),
  limiter: { login: new RateLimiter(10, 15 * 60_000), forms: new RateLimiter(60, 60_000), api: new RateLimiter(600, 60_000) },
});

const server = createServer((req, res) => { void app(req, res); });
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(env.port, () => {
  console.info(`Private Driver Club — ${env.nodeEnv} — ${env.appUrl} (port ${env.port})`);
  console.info(`Paiement en ligne : ${payments ? payments.constructor.name : "non connecté (espèces uniquement)"}`);
});

const shutdown = () => { server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(1), 10_000).unref(); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
