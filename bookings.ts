import { type DB, one, all, run, tx, nextCounter } from "../db/db.ts";
import { newId } from "../lib/security.ts";
import { zurichLocalToUtc, TZ } from "../lib/format.ts";
import { type BookingStatus, canTransition, TERMINAL } from "../domain/bookings/booking-state.ts";
import { quote, measureWaitingMinutes, PricingError } from "../domain/pricing/pricing.ts";
import { computeEarningSnapshot } from "../domain/earnings/earnings.ts";
import { minor } from "../domain/money/money.ts";
import { format } from "../domain/money/money.ts";
import { audit, type AuditActor } from "./audit.ts";
import { getSettings, getSetting } from "./settings.ts";
import { DomainError } from "./users.ts";
import type { NotificationService } from "./notify.ts";

export interface BookingRow {
  id: string; number: string; customer_id: string; pickup_address: string; dropoff_address: string;
  pickup_at: string; is_immediate: number; passengers: number; luggage: number; notes: string; contact_phone: string;
  category: string; payment_method: "CASH" | "ONLINE"; estimated_distance_m: number | null; quote_total: number | null;
  final_distance_m: number | null; waiting_minutes: number | null; final_total: number | null; price_lines: string | null;
  status: BookingStatus; assigned_driver_id: string | null; vehicle_id: string | null; cancel_reason: string;
  created_at: string; updated_at: string; completed_at: string | null;
}

type ActorRole = "SUPER_ADMIN" | "DRIVER" | "CUSTOMER" | "SYSTEM";
const now = () => new Date().toISOString();

export function getBooking(db: DB, id: string): BookingRow {
  const b = one<BookingRow>(db, "SELECT * FROM bookings WHERE id = ?", id);
  if (!b) throw new DomainError("Course introuvable.", 404);
  return b;
}

function userOf(db: DB, id: string | null) {
  return id ? one<{ id: string; email: string; first_name: string; last_name: string }>(db, "SELECT id, email, first_name, last_name FROM users WHERE id = ?", id) : undefined;
}

/** Seul point d'entrée pour changer un statut : contrôle du graphe + historique (§9). */
export function moveStatus(db: DB, b: BookingRow, to: BookingStatus, actor: AuditActor, note = ""): void {
  const role = actor.role as ActorRole;
  if (!canTransition(b.status, to, role)) {
    throw new DomainError(`Action impossible : la course est au statut ${b.status}.`, 409);
  }
  const t = now();
  // Mise à jour conditionnelle : protège contre deux actions concurrentes.
  const res = db.prepare("UPDATE bookings SET status = ?, updated_at = ? WHERE id = ? AND status = ?").run(to, t, b.id, b.status);
  if (Number(res.changes) !== 1) throw new DomainError("La course a été modifiée entre-temps. Rechargez la page.", 409);
  run(db, `INSERT INTO booking_status_history (id, booking_id, from_status, to_status, actor_id, actor_role, note, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, newId(), b.id, b.status, to, actor.id, actor.role, note.slice(0, 500), t);
  b.status = to;
}

// --- Création (client approuvé uniquement ; contrôlé en amont par RBAC) -----------
export function createBooking(db: DB, actor: AuditActor, input: {
  pickup: string; dropoff: string; when: "now" | "scheduled"; pickupLocal: string; passengers: number; luggage: number;
  notes: string; contactPhone: string; paymentMethod: string; onlineAvailable: boolean;
}, notifier?: NotificationService): string {
  if (actor.role !== "CUSTOMER" || !actor.id) throw new DomainError("Interdit.", 403);
  const c = one<{ status: string }>(db, "SELECT status FROM users WHERE id = ?", actor.id);
  if (c?.status !== "APPROVED") throw new DomainError("Votre adhésion doit être validée avant de réserver.", 403);

  const pickup = input.pickup.trim(), dropoff = input.dropoff.trim();
  if (pickup.length < 5 || pickup.length > 200) throw new DomainError("Adresse de départ invalide.");
  if (dropoff.length < 5 || dropoff.length > 200) throw new DomainError("Adresse de destination invalide.");
  if (!Number.isInteger(input.passengers) || input.passengers < 1 || input.passengers > 8) throw new DomainError("Nombre de passagers invalide (1 à 8).");
  if (!Number.isInteger(input.luggage) || input.luggage < 0 || input.luggage > 20) throw new DomainError("Nombre de bagages invalide.");
  const policy = getSetting(db, "booking");
  let pickupAt: Date;
  if (input.when === "now") pickupAt = new Date();
  else {
    const d = zurichLocalToUtc(input.pickupLocal);
    if (!d) throw new DomainError("Date et heure invalides.");
    if (d.getTime() < Date.now() + policy.min_lead_minutes * 60_000 - 60_000) throw new DomainError("L'heure de prise en charge est déjà passée ou trop proche.");
    if (d.getTime() > Date.now() + policy.max_advance_days * 86400_000) throw new DomainError(`Réservation possible au maximum ${policy.max_advance_days} jours à l'avance.`);
    pickupAt = d;
  }
  const method = input.paymentMethod === "ONLINE" ? "ONLINE" : "CASH";
  const features = getSetting(db, "features");
  if (method === "ONLINE" && !input.onlineAvailable) throw new DomainError("Le paiement en ligne n'est pas encore disponible.");
  if (method === "CASH" && !features.cash) throw new DomainError("Le paiement en espèces n'est pas disponible.");

  return tx(db, () => {
    const id = newId(), t = now();
    const year = new Date().getUTCFullYear();
    const number = `PDC-${year}-${String(nextCounter(db, `booking-${year}`)).padStart(6, "0")}`;
    run(db, `INSERT INTO bookings (id, number, customer_id, pickup_address, dropoff_address, pickup_at, is_immediate, passengers, luggage,
             notes, contact_phone, payment_method, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REQUESTED', ?, ?)`,
      id, number, actor.id, pickup, dropoff, pickupAt.toISOString(), input.when === "now" ? 1 : 0, input.passengers, input.luggage,
      input.notes.trim().slice(0, 500), input.contactPhone.trim().slice(0, 30), method, t, t);
    run(db, `INSERT INTO booking_status_history (id, booking_id, from_status, to_status, actor_id, actor_role, at) VALUES (?, ?, NULL, 'REQUESTED', ?, ?, ?)`,
      newId(), id, actor.id, actor.role, t);
    audit(db, actor, "BOOKING_CREATED", "booking", id, "SUCCESS", { number });
    const owner = one<{ id: string; email: string }>(db, "SELECT id, email FROM users WHERE role = 'SUPER_ADMIN'");
    if (owner) notifier?.notify(owner, "BOOKING_RECEIVED", `Nouvelle demande ${number}`, `${input.when === "now" ? "IMMÉDIATE — " : ""}${pickup} → ${dropoff}`);
    return id;
  });
}

// --- Confirmation par l'entreprise avec distance estimée ----------------------------
export function confirmBooking(db: DB, actor: AuditActor, bookingId: string, estimatedMeters: number, notifier?: NotificationService): void {
  tx(db, () => {
    const b = getBooking(db, bookingId);
    if (!Number.isInteger(estimatedMeters) || estimatedMeters < 0 || estimatedMeters > 1_000_000) throw new DomainError("Distance invalide.");
    const s = getSettings(db);
    const q = quote(s.pricing, {
      vehicleCategory: s.pricing.vehicleCategory, distanceMeters: estimatedMeters, durationSeconds: 0,
      pickupAt: new Date(b.pickup_at), requestedAt: new Date(Math.min(Date.now(), new Date(b.pickup_at).getTime())),
      timezone: TZ, holidays: s.holidays, isAirport: false, luggageCount: b.luggage, childSeats: 0, meetAndGreet: false, waitingMinutes: 0,
    });
    moveStatus(db, b, "CONFIRMED", actor);
    run(db, "UPDATE bookings SET estimated_distance_m = ?, quote_total = ?, price_lines = ? WHERE id = ?",
      estimatedMeters, q.total, JSON.stringify(q.lines), b.id);
    audit(db, actor, "BOOKING_CONFIRMED", "booking", b.id, "SUCCESS", { quote: q.total, meters: estimatedMeters });
    const c = userOf(db, b.customer_id);
    if (c) notifier?.notify(c, "BOOKING_CONFIRMED", `Course ${b.number} confirmée`, `Prix estimé : ${format(q.total)} (hors attente éventuelle).`);
  });
}

// --- Dispatch ------------------------------------------------------------------------
export function assignBooking(db: DB, actor: AuditActor, bookingId: string, driverId: string, vehicleId: string, notifier?: NotificationService): void {
  tx(db, () => {
    const b = getBooking(db, bookingId);
    const driver = one<{ id: string; email: string; status: string; role: string }>(db, "SELECT id, email, status, role FROM users WHERE id = ?", driverId);
    if (!driver || driver.role !== "DRIVER" || driver.status !== "ACTIVE") throw new DomainError("Chauffeur non disponible (statut non actif).");
    const v = one<{ id: string; status: string; seats: number; deleted_at: string | null }>(db, "SELECT id, status, seats, deleted_at FROM vehicles WHERE id = ?", vehicleId);
    if (!v || v.deleted_at || ["MAINTENANCE", "INACTIVE"].includes(v.status)) throw new DomainError("Véhicule non disponible.");
    if (v.seats < b.passengers) throw new DomainError("Ce véhicule n'a pas assez de places.");
    const windowMin = getSetting(db, "booking").conflict_window_minutes;
    const t0 = new Date(new Date(b.pickup_at).getTime() - windowMin * 60_000).toISOString();
    const t1 = new Date(new Date(b.pickup_at).getTime() + windowMin * 60_000).toISOString();
    const terminal = [...TERMINAL].map((s) => `'${s}'`).join(",");
    const clash = one<{ number: string }>(db,
      `SELECT number FROM bookings WHERE id != ? AND status NOT IN (${terminal}) AND pickup_at BETWEEN ? AND ?
       AND (assigned_driver_id = ? OR vehicle_id = ?) LIMIT 1`, b.id, t0, t1, driverId, vehicleId);
    if (clash) throw new DomainError(`Conflit horaire avec la course ${clash.number} (chauffeur ou véhicule déjà pris).`, 409);
    moveStatus(db, b, "ASSIGNED", actor);
    run(db, "UPDATE bookings SET assigned_driver_id = ?, vehicle_id = ? WHERE id = ?", driverId, vehicleId, b.id);
    audit(db, actor, "BOOKING_ASSIGNED", "booking", b.id, "SUCCESS", { driverId, vehicleId });
    notifier?.notify(driver, "TRIP_OFFERED", `Nouvelle course ${b.number}`, `${b.pickup_address} → ${b.dropoff_address}`);
  });
}

export function unassignBooking(db: DB, actor: AuditActor, bookingId: string): void {
  tx(db, () => {
    const b = getBooking(db, bookingId);
    moveStatus(db, b, "CONFIRMED", actor, "Désassignation");
    run(db, "UPDATE bookings SET assigned_driver_id = NULL, vehicle_id = NULL WHERE id = ?", b.id);
    audit(db, actor, "BOOKING_UNASSIGNED", "booking", b.id);
  });
}

// --- Actions chauffeur ------------------------------------------------------------------
export type DriverAction = "accept" | "decline" | "arriving" | "arrived" | "onboard" | "noshow";

export function driverAction(db: DB, actor: AuditActor, bookingId: string, action: DriverAction, notifier?: NotificationService): void {
  tx(db, () => {
    const b = getBooking(db, bookingId);
    // Anti-IDOR : le chauffeur n'agit que sur ses propres courses.
    if (actor.role !== "DRIVER" || b.assigned_driver_id !== actor.id) throw new DomainError("Course introuvable.", 404);
    const c = userOf(db, b.customer_id);
    switch (action) {
      case "accept":
        moveStatus(db, b, "DRIVER_ACCEPTED", actor);
        if (c) notifier?.notify(c, "DRIVER_ASSIGNED", `Chauffeur attribué — ${b.number}`, "Votre chauffeur a confirmé la course.");
        break;
      case "decline":
        moveStatus(db, b, "CONFIRMED", actor, "Refusée par le chauffeur");
        run(db, "UPDATE bookings SET assigned_driver_id = NULL, vehicle_id = NULL WHERE id = ?", b.id);
        { const o = one<{ id: string; email: string }>(db, "SELECT id, email FROM users WHERE role = 'SUPER_ADMIN'");
          if (o) notifier?.notify(o, "TRIP_OFFERED", `Course ${b.number} refusée`, "À réattribuer."); }
        break;
      case "arriving":
        moveStatus(db, b, "DRIVER_ARRIVING", actor);
        if (c) notifier?.notify(c, "DRIVER_ARRIVING", "Votre chauffeur est en route", b.pickup_address);
        break;
      case "arrived":
        moveStatus(db, b, "DRIVER_ARRIVED", actor);
        if (c) notifier?.notify(c, "DRIVER_ARRIVED", "Votre chauffeur est arrivé", "Les 10 premières minutes d'attente sont offertes.");
        break;
      case "onboard":
        moveStatus(db, b, "PASSENGER_ONBOARD", actor);
        moveStatus(db, b, "IN_PROGRESS", actor);
        break;
      case "noshow":
        moveStatus(db, b, "NO_SHOW", actor);
        break;
    }
    audit(db, actor, `DRIVER_${action.toUpperCase()}`, "booking", b.id);
  });
}

export function cancelBooking(db: DB, actor: AuditActor, bookingId: string, reason: string, notifier?: NotificationService): void {
  tx(db, () => {
    const b = getBooking(db, bookingId);
    let to: BookingStatus;
    if (actor.role === "CUSTOMER") {
      if (b.customer_id !== actor.id) throw new DomainError("Course introuvable.", 404);
      to = "CANCELLED_BY_CUSTOMER";
    } else if (actor.role === "SUPER_ADMIN") to = "CANCELLED_BY_COMPANY";
    else if (actor.role === "DRIVER") {
      if (b.assigned_driver_id !== actor.id) throw new DomainError("Course introuvable.", 404);
      to = "CANCELLED_BY_DRIVER";
    } else throw new DomainError("Interdit.", 403);
    moveStatus(db, b, to, actor, reason);
    run(db, "UPDATE bookings SET cancel_reason = ? WHERE id = ?", reason.slice(0, 300), b.id);
    audit(db, actor, "BOOKING_CANCELLED", "booking", b.id, "SUCCESS", { to, reason });
    const c = userOf(db, b.customer_id), o = one<{ id: string; email: string }>(db, "SELECT id, email FROM users WHERE role = 'SUPER_ADMIN'");
    if (c && actor.role !== "CUSTOMER") notifier?.notify(c, "BOOKING_CANCELLED", `Course ${b.number} annulée`, reason || "Contactez-nous pour toute question.");
    if (o && actor.role !== "SUPER_ADMIN") notifier?.notify(o, "BOOKING_CANCELLED", `Course ${b.number} annulée`, `${actor.role} : ${reason}`);
  });
}

// --- Clôture (§103) : sûre et idempotente -------------------------------------------------
export interface CompletionResult { total: number; driverAmount: number; companyAmount: number; invoiceNumber: string; alreadyCompleted: boolean }

export function completeBooking(db: DB, actor: AuditActor, bookingId: string, input: { distanceMeters: number; cashDeclared: number | null }, notifier?: NotificationService): CompletionResult {
  return tx(db, () => {
    const b = getBooking(db, bookingId);
    if (actor.role === "DRIVER" && b.assigned_driver_id !== actor.id) throw new DomainError("Course introuvable.", 404);

    // 1. Idempotence : une course déjà clôturée renvoie le résultat existant.
    if (b.status === "COMPLETED") {
      const e = one<{ driver_amount: number; company_amount: number; gross_amount: number }>(db, "SELECT * FROM driver_earnings WHERE booking_id = ?", b.id)!;
      const inv = one<{ number: string }>(db, "SELECT number FROM invoices WHERE booking_id = ?", b.id)!;
      return { total: e.gross_amount, driverAmount: e.driver_amount, companyAmount: e.company_amount, invoiceNumber: inv.number, alreadyCompleted: true };
    }
    if (!b.assigned_driver_id) throw new DomainError("Aucun chauffeur attribué.");
    if (!Number.isInteger(input.distanceMeters) || input.distanceMeters < 0 || input.distanceMeters > 1_000_000) throw new DomainError("Kilométrage invalide.");

    // 2. Montant final : distance réelle + attente mesurée côté serveur.
    const hist = all<{ to_status: string; at: string }>(db, "SELECT to_status, at FROM booking_status_history WHERE booking_id = ? ORDER BY at", b.id);
    const arrived = hist.filter((h) => h.to_status === "DRIVER_ARRIVED").at(-1);
    const onboard = hist.filter((h) => h.to_status === "PASSENGER_ONBOARD").at(-1);
    const waitingMinutes = arrived && onboard ? measureWaitingMinutes(new Date(arrived.at), new Date(onboard.at)) : 0;
    const s = getSettings(db);
    let q;
    try {
      q = quote(s.pricing, {
        vehicleCategory: s.pricing.vehicleCategory, distanceMeters: input.distanceMeters, durationSeconds: 0,
        pickupAt: new Date(b.pickup_at), requestedAt: new Date(Math.min(new Date(b.created_at).getTime(), new Date(b.pickup_at).getTime())),
        timezone: TZ, holidays: s.holidays, isAirport: false, luggageCount: b.luggage, childSeats: 0, meetAndGreet: false,
        waitingMinutes: Math.min(waitingMinutes, 600),
      });
    } catch (e) {
      if (e instanceof PricingError) throw new DomainError(e.message);
      throw e;
    }

    moveStatus(db, b, "COMPLETED", actor);
    const t = now();
    run(db, "UPDATE bookings SET final_distance_m = ?, waiting_minutes = ?, final_total = ?, price_lines = ?, completed_at = ? WHERE id = ?",
      input.distanceMeters, waitingMinutes, q.total, JSON.stringify(q.lines), t, b.id);

    // 3–6. Snapshot financier figé + rémunération chauffeur (UNIQUE booking_id).
    const profile = one<{ share_bps: number | null }>(db, "SELECT share_bps FROM driver_profiles WHERE user_id = ?", b.assigned_driver_id);
    const shareBps = profile?.share_bps ?? s.driver_share_bps;
    const snap = computeEarningSnapshot(minor(q.total), shareBps);
    const earningId = newId();
    run(db, `INSERT INTO driver_earnings (id, booking_id, driver_id, gross_amount, driver_share_bps, driver_amount, company_amount, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'CALCULATED', ?)`,
      earningId, b.id, b.assigned_driver_id, snap.grossAmount, snap.driverShareBps, snap.driverAmount, snap.companyAmount, t);

    // 7. Facture (numérotation serveur, séquentielle par année).
    const year = new Date().getUTCFullYear();
    const invoiceNumber = `F-${year}-${String(nextCounter(db, `invoice-${year}`)).padStart(6, "0")}`;
    const tax = s.tax;
    let total: number = q.total, taxAmount = 0;
    if (tax.tax_enabled && tax.tax_rate_bps > 0) {
      if (tax.tax_included) taxAmount = Math.round((q.total * tax.tax_rate_bps) / (10000 + tax.tax_rate_bps));
      else { taxAmount = Math.round((q.total * tax.tax_rate_bps) / 10000); total = q.total + taxAmount; }
    }
    const invoiceId = newId();
    const isCash = b.payment_method === "CASH";
    run(db, `INSERT INTO invoices (id, number, booking_id, customer_id, issued_at, total, tax_enabled, tax_rate_bps, tax_amount, tax_included,
             tax_label, tax_number, lines, company_snapshot, payment_method, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      invoiceId, invoiceNumber, b.id, b.customer_id, t, total, tax.tax_enabled ? 1 : 0, tax.tax_rate_bps, taxAmount, tax.tax_included ? 1 : 0,
      tax.tax_label, tax.tax_number, JSON.stringify({ lines: q.lines, waitingMinutes, distanceMeters: input.distanceMeters }),
      JSON.stringify(s.company), isCash ? "CASH" : "ONLINE", isCash ? "PAID" : "ISSUED");

    // Paiement : le cash est une recette de l'entreprise, encaissée par le chauffeur pour son compte.
    if (isCash) {
      const declared = input.cashDeclared ?? total;
      if (!Number.isInteger(declared) || declared < 0) throw new DomainError("Montant encaissé invalide.");
      run(db, `INSERT INTO payments (id, booking_id, invoice_id, method, provider, provider_ref, amount, status, idempotency_key, created_at, updated_at)
               VALUES (?, ?, ?, 'CASH', 'cash', ?, ?, 'PAID', ?, ?, ?)`,
        newId(), b.id, invoiceId, `cash-${b.id}`, total, `cash:${b.id}`, t, t);
      run(db, `INSERT INTO cash_transactions (id, booking_id, driver_id, expected_amount, declared_amount, status, collected_at, note)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(), b.id, b.assigned_driver_id, total, declared, declared === total ? "COLLECTED" : "DISPUTED", t,
        declared === total ? "" : `Écart déclaré à la clôture : ${format(minor(declared - total))}`);
    }

    // 8. Récompense de parrainage à la première course terminée du filleul.
    const cust = one<{ invited_by: string | null }>(db, "SELECT invited_by FROM users WHERE id = ?", b.customer_id);
    const reward = s.referral.referral_reward;
    if (s.features.referral && reward > 0 && cust?.invited_by) {
      const inviter = one<{ role: string; status: string }>(db, "SELECT role, status FROM users WHERE id = ?", cust.invited_by);
      if (inviter?.role === "CUSTOMER" && inviter.status === "APPROVED") {
        run(db, `INSERT OR IGNORE INTO reward_ledger (id, user_id, amount, kind, reference, note, created_at) VALUES (?, ?, ?, 'REFERRAL', ?, ?, ?)`,
          newId(), cust.invited_by, reward, `referral:${b.customer_id}`, `Parrainage — première course ${b.number}`, t);
      }
    }

    // 10. Audit.
    audit(db, actor, "BOOKING_COMPLETED", "booking", b.id, "SUCCESS", {
      total, gross: snap.grossAmount, shareBps: snap.driverShareBps, driver: snap.driverAmount, company: snap.companyAmount, invoiceNumber, waitingMinutes,
    });
    // 9. Reçu.
    const c = userOf(db, b.customer_id);
    if (c) notifier?.notify(c, "TRIP_COMPLETED", `Merci — course ${b.number}`, `Montant : ${format(minor(total))}. Facture ${invoiceNumber} disponible dans votre espace.`);
    return { total, driverAmount: snap.driverAmount, companyAmount: snap.companyAmount, invoiceNumber, alreadyCompleted: false };
  });
}

export function listBookings(db: DB, where: string, ...params: (string | number)[]): (BookingRow & { customer_name: string; driver_name: string | null; plate: string | null })[] {
  return all(db, `SELECT b.*, (cu.first_name || ' ' || cu.last_name) AS customer_name,
                  (d.first_name || ' ' || d.last_name) AS driver_name, v.plate AS plate
                  FROM bookings b JOIN users cu ON cu.id = b.customer_id
                  LEFT JOIN users d ON d.id = b.assigned_driver_id LEFT JOIN vehicles v ON v.id = b.vehicle_id
                  ${where}`, ...params);
}
