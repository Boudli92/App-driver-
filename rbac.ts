/**
 * RBAC serveur (§3, §33, §84–87). Toute route API passe par `authorize()`.
 * Le frontend peut masquer des boutons, mais seule cette couche fait foi.
 */
export type Role = "SUPER_ADMIN" | "DRIVER" | "CUSTOMER";

export type CustomerStatus =
  | "INVITED" | "REGISTRATION_PENDING" | "PENDING_APPROVAL"
  | "APPROVED" | "REJECTED" | "SUSPENDED" | "BLOCKED";

export type DriverStatus =
  | "INVITED" | "PENDING_SETUP" | "ACTIVE" | "SUSPENDED" | "INACTIVE" | "BLOCKED";

export interface Actor {
  userId: string;
  role: Role;
  customerStatus?: CustomerStatus;
  driverStatus?: DriverStatus;
  mfaVerified?: boolean;
}

export type Permission =
  // Administration (SUPER_ADMIN)
  | "driver:create" | "driver:update" | "driver:set_status" | "driver:set_share_rate"
  | "customer:approve" | "customer:reject" | "customer:suspend" | "customer:read_any"
  | "vehicle:manage" | "booking:read_any" | "booking:assign" | "booking:set_price"
  | "pricing:manage" | "payment:manage" | "payment:refund" | "cash:reconcile"
  | "reward:manage" | "invitation:manage" | "finance:read_all" | "report:export"
  | "settings:manage" | "audit:read" | "document:manage" | "user:set_role"
  // Chauffeur
  | "driver:read_own_trips" | "driver:update_trip_progress" | "driver:read_own_earnings"
  | "driver:update_own_profile"
  // Client
  | "booking:create" | "booking:read_own" | "booking:cancel_own"
  | "invoice:read_own" | "reward:read_own" | "referral:invite" | "profile:update_own";

const ADMIN_ONLY: Permission[] = [
  "driver:create", "driver:update", "driver:set_status", "driver:set_share_rate",
  "customer:approve", "customer:reject", "customer:suspend", "customer:read_any",
  "vehicle:manage", "booking:read_any", "booking:assign", "booking:set_price",
  "pricing:manage", "payment:manage", "payment:refund", "cash:reconcile",
  "reward:manage", "invitation:manage", "finance:read_all", "report:export",
  "settings:manage", "audit:read", "document:manage", "user:set_role",
];

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  SUPER_ADMIN: new Set<Permission>(ADMIN_ONLY),
  DRIVER: new Set<Permission>([
    "driver:read_own_trips", "driver:update_trip_progress",
    "driver:read_own_earnings", "driver:update_own_profile",
  ]),
  CUSTOMER: new Set<Permission>([
    "booking:create", "booking:read_own", "booking:cancel_own", "invoice:read_own",
    "reward:read_own", "referral:invite", "profile:update_own",
  ]),
};

/** Permissions exigeant en plus MFA vérifiée (§86, §139). */
const REQUIRES_MFA = new Set<Permission>(ADMIN_ONLY);

export class AuthorizationError extends Error {
  readonly status = 403 as const;
  readonly reason: string;
  constructor(reason: string) {
    super("Forbidden");
    this.reason = reason;
  }
}

export function can(actor: Actor, permission: Permission): { ok: true } | { ok: false; reason: string } {
  if (!MATRIX[actor.role].has(permission)) return { ok: false, reason: "role" };

  if (actor.role === "SUPER_ADMIN" && REQUIRES_MFA.has(permission) && actor.mfaVerified !== true) {
    return { ok: false, reason: "mfa_required" };
  }
  if (actor.role === "CUSTOMER") {
    // Un client non approuvé ne peut rien faire d'opérationnel (§5, test 7).
    if (actor.customerStatus !== "APPROVED") return { ok: false, reason: "customer_not_approved" };
  }
  if (actor.role === "DRIVER") {
    const readOnlyAllowed: Permission[] = ["driver:update_own_profile"];
    if (actor.driverStatus !== "ACTIVE" && !readOnlyAllowed.includes(permission)) {
      return { ok: false, reason: "driver_not_active" };
    }
  }
  return { ok: true };
}

export function authorize(actor: Actor, permission: Permission): void {
  const r = can(actor, permission);
  if (!r.ok) throw new AuthorizationError(r.reason);
}

/** Contrôle d'ownership anti-IDOR (§93). */
export function authorizeBookingRead(
  actor: Actor,
  booking: { customerId: string; assignedDriverId: string | null },
): void {
  if (actor.role === "SUPER_ADMIN") return authorize(actor, "booking:read_any");
  if (actor.role === "CUSTOMER") {
    authorize(actor, "booking:read_own");
    if (booking.customerId !== actor.userId) throw new AuthorizationError("not_owner");
    return;
  }
  authorize(actor, "driver:read_own_trips");
  if (booking.assignedDriverId !== actor.userId) throw new AuthorizationError("not_assigned");
}

/** §87 : personne ne modifie son propre rôle ; SUPER_ADMIN n'est jamais attribuable. */
export function authorizeRoleChange(actor: Actor, targetUserId: string, newRole: Role): void {
  authorize(actor, "user:set_role");
  if (targetUserId === actor.userId) throw new AuthorizationError("self_role_change");
  if (newRole === "SUPER_ADMIN") throw new AuthorizationError("super_admin_not_assignable");
}
