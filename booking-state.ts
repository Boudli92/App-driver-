import type { Role } from "../auth/rbac.ts";

/** Workflow de course (§9). Toute transition passe par `transition()` et est historisée. */
export type BookingStatus =
  | "REQUESTED" | "PENDING_PAYMENT" | "PAYMENT_AUTHORIZED" | "CONFIRMED" | "ASSIGNED"
  | "DRIVER_ACCEPTED" | "DRIVER_ARRIVING" | "DRIVER_ARRIVED" | "PASSENGER_ONBOARD"
  | "IN_PROGRESS" | "COMPLETED"
  | "CANCELLED_BY_CUSTOMER" | "CANCELLED_BY_COMPANY" | "CANCELLED_BY_DRIVER"
  | "NO_SHOW" | "PAYMENT_FAILED" | "REFUNDED" | "PARTIALLY_REFUNDED";

type Actor = Role | "SYSTEM";

interface Edge { to: BookingStatus; by: readonly Actor[] }

const A = "SUPER_ADMIN", D = "DRIVER", C = "CUSTOMER", S = "SYSTEM";
const CANCEL: Edge[] = [
  { to: "CANCELLED_BY_CUSTOMER", by: [C] },
  { to: "CANCELLED_BY_COMPANY", by: [A] },
];

const GRAPH: Partial<Record<BookingStatus, Edge[]>> = {
  REQUESTED: [{ to: "PENDING_PAYMENT", by: [S] }, { to: "CONFIRMED", by: [A, S] }, ...CANCEL],
  PENDING_PAYMENT: [
    { to: "PAYMENT_AUTHORIZED", by: [S] }, { to: "PAYMENT_FAILED", by: [S] }, ...CANCEL,
  ],
  PAYMENT_AUTHORIZED: [{ to: "CONFIRMED", by: [A, S] }, ...CANCEL],
  PAYMENT_FAILED: [{ to: "PENDING_PAYMENT", by: [S, C] }, { to: "CANCELLED_BY_COMPANY", by: [A, S] }],
  CONFIRMED: [{ to: "ASSIGNED", by: [A] }, ...CANCEL],
  ASSIGNED: [
    { to: "DRIVER_ACCEPTED", by: [D] },
    { to: "CONFIRMED", by: [A, D] }, // désassignation (admin) ou refus (chauffeur)
    ...CANCEL,
  ],
  DRIVER_ACCEPTED: [
    { to: "DRIVER_ARRIVING", by: [D] }, { to: "CONFIRMED", by: [A] },
    { to: "CANCELLED_BY_DRIVER", by: [D] }, ...CANCEL,
  ],
  DRIVER_ARRIVING: [{ to: "DRIVER_ARRIVED", by: [D] }, { to: "CANCELLED_BY_COMPANY", by: [A] }],
  DRIVER_ARRIVED: [
    { to: "PASSENGER_ONBOARD", by: [D] }, { to: "NO_SHOW", by: [D, A] },
    { to: "CANCELLED_BY_COMPANY", by: [A] },
  ],
  PASSENGER_ONBOARD: [{ to: "IN_PROGRESS", by: [D] }],
  IN_PROGRESS: [{ to: "COMPLETED", by: [D, A] }],
  COMPLETED: [{ to: "REFUNDED", by: [A] }, { to: "PARTIALLY_REFUNDED", by: [A] }],
  PARTIALLY_REFUNDED: [{ to: "REFUNDED", by: [A] }],
};

export class InvalidTransitionError extends Error {
  readonly status = 409 as const;
}

export function canTransition(from: BookingStatus, to: BookingStatus, by: Actor): boolean {
  return (GRAPH[from] ?? []).some((e) => e.to === to && e.by.includes(by));
}

export function transition(from: BookingStatus, to: BookingStatus, by: Actor): BookingStatus {
  if (!canTransition(from, to, by)) {
    throw new InvalidTransitionError(`Transition ${from} → ${to} refusée pour ${by}`);
  }
  return to;
}

/** Une course terminée n'est plus modifiable par le client (§84). */
export const TERMINAL: ReadonlySet<BookingStatus> = new Set([
  "COMPLETED", "CANCELLED_BY_CUSTOMER", "CANCELLED_BY_COMPANY", "CANCELLED_BY_DRIVER",
  "NO_SHOW", "REFUNDED", "PARTIALLY_REFUNDED",
]);
