import { type DB, run } from "../db/db.ts";
import { newId } from "../lib/security.ts";

/**
 * NotificationService (§48). IN_APP est pleinement fonctionnel. EMAIL / SMS / PUSH
 * passent par des adaptateurs : tant qu'aucun fournisseur n'est branché, le
 * message est journalisé (sans données sensibles) et reste consultable in-app.
 */
export type Template =
  | "WELCOME" | "INVITATION" | "APPROVAL" | "REJECTION" | "BOOKING_RECEIVED" | "BOOKING_CONFIRMED"
  | "DRIVER_ASSIGNED" | "TRIP_OFFERED" | "DRIVER_ARRIVING" | "DRIVER_ARRIVED" | "TRIP_COMPLETED"
  | "PAYMENT_RECEIPT" | "PASSWORD_RESET" | "DOCUMENT_EXPIRING" | "BOOKING_CANCELLED" | "SUPPORT_REPLY";

export interface ChannelAdapter { send(to: string, title: string, body: string): Promise<void> }

export class ConsoleAdapter implements ChannelAdapter {
  readonly label: string;
  constructor(label: string) { this.label = label; }
  async send(to: string, title: string): Promise<void> {
    const masked = to.replace(/^(.).*(@.*)$/, "$1***$2");
    console.info(`[notify:${this.label}] (fournisseur non connecté) → ${masked} : ${title}`);
  }
}

export class NotificationService {
  private readonly db: DB;
  private readonly email: ChannelAdapter;
  constructor(db: DB, email: ChannelAdapter = new ConsoleAdapter("email")) { this.db = db; this.email = email; }

  notify(user: { id: string; email: string }, template: Template, title: string, body: string): void {
    const now = new Date().toISOString();
    run(this.db, `INSERT INTO notifications (id, user_id, channel, template, title, body, status, created_at)
                  VALUES (?, ?, 'IN_APP', ?, ?, ?, 'SENT', ?)`, newId(), user.id, template, title, body, now);
    const id = newId();
    run(this.db, `INSERT INTO notifications (id, user_id, channel, template, title, body, status, created_at)
                  VALUES (?, ?, 'EMAIL', ?, ?, ?, 'QUEUED', ?)`, id, user.id, template, title, body, now);
    this.email.send(user.email, title, body)
      .then(() => this.mark(id, "SENT"), () => this.mark(id, "FAILED"));
  }

  private mark(id: string, status: "SENT" | "FAILED"): void {
    try { run(this.db, "UPDATE notifications SET status = ? WHERE id = ?", status, id); } catch { /* base fermée */ }
  }
}
