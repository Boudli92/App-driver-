import { type DB, one, all } from "../db/db.ts";
import { zurichPeriodStart } from "../lib/format.ts";

export interface FinanceSummary {
  gross: number; refunds: number; net: number; driverShare: number; companyShare: number; trips: number;
  cash: number; online: number; unpaidOnline: number; adjustments: number; cancelled: number; rewards: number;
}

/** Tableau financier (§106) sur [from, to[ (ISO UTC), basé sur les courses clôturées. */
export function financeSummary(db: DB, from: string, to: string): FinanceSummary {
  const e = one<{ gross: number | null; d: number | null; c: number | null; n: number }>(db,
    `SELECT SUM(gross_amount) AS gross, SUM(driver_amount) AS d, SUM(company_amount) AS c, COUNT(*) AS n
     FROM driver_earnings WHERE created_at >= ? AND created_at < ?`, from, to)!;
  const byMethod = all<{ payment_method: string; total: number; status: string }>(db,
    `SELECT payment_method, status, SUM(total) AS total FROM invoices WHERE issued_at >= ? AND issued_at < ? GROUP BY payment_method, status`, from, to);
  const refunds = one<{ s: number | null }>(db, "SELECT SUM(amount) AS s FROM refunds WHERE status = 'SUCCEEDED' AND created_at >= ? AND created_at < ?", from, to)!.s ?? 0;
  const adj = one<{ s: number | null }>(db, "SELECT SUM(amount) AS s FROM earning_adjustments WHERE created_at >= ? AND created_at < ?", from, to)!.s ?? 0;
  const cancelled = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM bookings WHERE status LIKE 'CANCELLED%' AND updated_at >= ? AND updated_at < ?", from, to)!.n;
  const rewards = one<{ s: number | null }>(db, "SELECT SUM(amount) AS s FROM reward_ledger WHERE created_at >= ? AND created_at < ?", from, to)!.s ?? 0;
  const sum = (pred: (r: { payment_method: string; status: string }) => boolean) => byMethod.filter(pred).reduce((a, r) => a + r.total, 0);
  const gross = e.gross ?? 0;
  return {
    gross, refunds, net: gross - refunds, driverShare: (e.d ?? 0) + adj, companyShare: (e.c ?? 0) - adj, trips: e.n,
    cash: sum((r) => r.payment_method === "CASH"), online: sum((r) => r.payment_method === "ONLINE" && r.status !== "ISSUED"),
    unpaidOnline: sum((r) => r.payment_method === "ONLINE" && r.status === "ISSUED"), adjustments: adj, cancelled, rewards,
  };
}

export interface DriverReportRow {
  driver_id: string; name: string; trips: number; gross: number; driver_amount: number; adjustments: number; paid: number; remaining: number; share_bps: number | null;
}

export function driverReport(db: DB, from: string, to: string): DriverReportRow[] {
  return all<DriverReportRow>(db, `
    SELECT u.id AS driver_id, u.first_name || ' ' || u.last_name AS name, dp.share_bps,
      COUNT(e.id) AS trips, COALESCE(SUM(e.gross_amount), 0) AS gross, COALESCE(SUM(e.driver_amount), 0) AS driver_amount,
      COALESCE((SELECT SUM(amount) FROM earning_adjustments a WHERE a.driver_id = u.id AND a.created_at >= ? AND a.created_at < ?), 0) AS adjustments,
      COALESCE(SUM(CASE WHEN e.status = 'PAID' THEN e.driver_amount END), 0) AS paid,
      0 AS remaining
    FROM users u LEFT JOIN driver_profiles dp ON dp.user_id = u.id
    LEFT JOIN driver_earnings e ON e.driver_id = u.id AND e.created_at >= ? AND e.created_at < ?
    WHERE u.role = 'DRIVER' AND u.deleted_at IS NULL
    GROUP BY u.id ORDER BY gross DESC`, from, to, from, to)
    .map((r) => ({ ...r, remaining: r.driver_amount + r.adjustments - r.paid }));
}

/** Revenus personnels d'un chauffeur : jamais ceux des autres (§17). */
export function driverEarningsSummary(db: DB, driverId: string) {
  const period = (kind: "day" | "week" | "month") => {
    const from = zurichPeriodStart(kind);
    const r = one<{ n: number; gross: number | null; mine: number | null }>(db,
      `SELECT COUNT(*) AS n, SUM(gross_amount) AS gross, SUM(driver_amount) AS mine FROM driver_earnings WHERE driver_id = ? AND created_at >= ?`, driverId, from)!;
    const adj = one<{ s: number | null }>(db, "SELECT SUM(amount) AS s FROM earning_adjustments WHERE driver_id = ? AND created_at >= ?", driverId, from)!.s ?? 0;
    return { trips: r.n, gross: r.gross ?? 0, mine: (r.mine ?? 0) + adj };
  };
  const pending = one<{ s: number | null }>(db, "SELECT SUM(driver_amount) AS s FROM driver_earnings WHERE driver_id = ? AND status IN ('CALCULATED','PENDING_PAYMENT')", driverId)!.s ?? 0;
  const cashHeld = one<{ s: number | null }>(db, "SELECT SUM(declared_amount) AS s FROM cash_transactions WHERE driver_id = ? AND status IN ('COLLECTED','DISPUTED')", driverId)!.s ?? 0;
  return { today: period("day"), week: period("week"), month: period("month"), pending, cashHeld };
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]!);
  const cell = (v: unknown) => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // anti-injection de formules tableur
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Point-virgule + BOM : ouverture directe dans Excel (paramètres régionaux suisses).
  return "\uFEFF" + [cols.join(";"), ...rows.map((r) => cols.map((c) => cell(r[c])).join(";"))].join("\r\n");
}
