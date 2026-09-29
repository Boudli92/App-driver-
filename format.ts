/** Conversion texte → entier mis à l'échelle, sans jamais passer par un float. */
export function parseScaled(input: string, decimals: number, max = 1e12): number | null {
  const s = input.trim().replace(/[’' ]/g, "").replace(",", ".");
  if (!/^\d{1,12}(\.\d+)?$/.test(s)) return null;
  const [int = "0", frac = ""] = s.split(".");
  if (frac.length > decimals) return null;
  const v = Number(int) * 10 ** decimals + Number((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  return Number.isSafeInteger(v) && v <= max ? v : null;
}

export const TZ = "Europe/Zurich";

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("fr-CH", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("fr-CH", { timeZone: TZ, dateStyle: "medium" }).format(new Date(iso));
}
export function fmtTime(iso: string): string {
  return new Intl.DateTimeFormat("fr-CH", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}
export function fmtKm(meters: number | null | undefined): string {
  if (meters === null || meters === undefined) return "—";
  const tenths = Math.round(meters / 100);
  return `${Math.floor(tenths / 10)}.${tenths % 10} km`;
}
/** 4250 bps → "42.5 %" */
export function fmtBps(bps: number): string {
  const int = Math.floor(bps / 100), frac = bps % 100;
  return `${int}${frac ? "." + String(frac).padStart(2, "0").replace(/0$/, "") : ""} %`;
}
/** 275 → "2.75" (pour pré-remplir les formulaires) */
export function centsToInput(v: number): string {
  return `${Math.floor(v / 100)}.${String(v % 100).padStart(2, "0")}`;
}

/** Décalage (minutes) de Europe/Zurich par rapport à UTC à un instant donné. */
function tzOffsetMinutes(date: Date, timeZone = TZ): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** "2026-10-06T14:30" (heure de Zurich) → Date UTC. */
export function zurichLocalToUtc(local: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let utc = guess - tzOffsetMinutes(new Date(guess)) * 60000;
  utc = guess - tzOffsetMinutes(new Date(utc)) * 60000;
  return new Date(utc);
}

/** Début du jour / de la semaine (lundi) / du mois à Zurich, en ISO UTC. */
export function zurichPeriodStart(kind: "day" | "week" | "month", now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(now);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  let y = Number(g("year")), m = Number(g("month")), d = Number(g("day"));
  if (kind === "month") d = 1;
  if (kind === "week") {
    const idx = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(g("weekday"));
    const dt = new Date(Date.UTC(y, m - 1, d - idx));
    y = dt.getUTCFullYear(); m = dt.getUTCMonth() + 1; d = dt.getUTCDate();
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return zurichLocalToUtc(`${y}-${pad(m)}-${pad(d)}T00:00`)!.toISOString();
}

export function zurichDateInputToUtc(date: string, endOfDay = false): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = zurichLocalToUtc(`${date}T00:00`);
  if (!d) return null;
  return endOfDay ? new Date(d.getTime() + 86400_000).toISOString() : d.toISOString();
}
