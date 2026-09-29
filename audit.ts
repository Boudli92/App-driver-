import { type DB, run } from "../db/db.ts";
import { newId } from "../lib/security.ts";

export interface AuditActor { id: string | null; role: string }
export const SYSTEM: AuditActor = { id: null, role: "SYSTEM" };

/** Journal d'audit en ajout seul (protégé par triggers SQL). Jamais de secrets dans metadata. */
export function audit(
  db: DB, actor: AuditActor, action: string, resource: string, resourceId: string | null,
  result: "SUCCESS" | "DENIED" | "FAILURE" = "SUCCESS", metadata: Record<string, unknown> = {},
): void {
  run(db, `INSERT INTO audit_log (id, user_id, role, action, resource, resource_id, result, metadata, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId(), actor.id, actor.role, action, resource, resourceId, result, JSON.stringify(metadata), new Date().toISOString());
}
