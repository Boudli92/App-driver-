/** Lecture centralisée de l'environnement. Aucun secret n'a de valeur par défaut. */
function str(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export type Env = ReturnType<typeof loadEnv>;

export function loadEnv() {
  const nodeEnv = str("NODE_ENV", "development");
  const env = {
    nodeEnv,
    isProd: nodeEnv === "production",
    isTest: nodeEnv === "test",
    port: Number(str("PORT", "3000")),
    appUrl: str("APP_URL", "http://localhost:3000").replace(/\/$/, ""),
    databasePath: str("DATABASE_PATH", "./data/pdc.sqlite"),
    authSecret: str("AUTH_SECRET"),
    stripeSecretKey: str("STRIPE_SECRET_KEY"),
    stripeWebhookSecret: str("STRIPE_WEBHOOK_SECRET"),
    stripeMethods: str("STRIPE_PAYMENT_METHODS", "card,twint").split(",").map((s) => s.trim()).filter(Boolean),
    trustProxy: str("TRUST_PROXY", "false") === "true",
  };
  if (env.isProd) {
    if (env.authSecret.length < 32) throw new Error("AUTH_SECRET manquant ou trop court (32 caractères minimum).");
    if (!env.appUrl.startsWith("https://")) throw new Error("APP_URL doit être en https:// en production.");
  }
  if (!env.authSecret) env.authSecret = "dev-only-secret-not-for-production-use-000";
  return env;
}
