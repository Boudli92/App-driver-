-- PRIVATE DRIVER CLUB — schéma v1 (SQLite, mode WAL)
-- Montants : entiers en centimes. Dates : ISO-8601 UTC.

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  password_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN','DRIVER','CUSTOMER')),
  status TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  referral_code TEXT UNIQUE,
  invited_by TEXT REFERENCES users(id),
  invitation_id TEXT,
  approved_at TEXT,
  approved_by TEXT REFERENCES users(id),
  mfa_secret TEXT,
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  admin_notes TEXT NOT NULL DEFAULT '',
  is_dev_data INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_role_status ON users(role, status);
-- Un seul SUPER_ADMIN possible (SINGLE_OWNER_MODE).
CREATE UNIQUE INDEX IF NOT EXISTS uq_single_owner ON users(role) WHERE role = 'SUPER_ADMIN';

CREATE TABLE IF NOT EXISTS driver_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  share_bps INTEGER CHECK (share_bps IS NULL OR share_bps BETWEEN 0 AND 10000),
  license_number TEXT NOT NULL DEFAULT '',
  license_expiry TEXT,
  permit_expiry TEXT,
  hired_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  csrf TEXT NOT NULL,
  mfa_ok INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('CUSTOMER','DRIVER','PASSWORD_RESET')),
  inviter_user_id TEXT REFERENCES users(id),
  target_user_id TEXT REFERENCES users(id),
  invited_email TEXT,
  source TEXT NOT NULL DEFAULT '',
  campaign TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','USED','REVOKED','EXPIRED')),
  uses INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  last_used_ua TEXT
);
CREATE INDEX IF NOT EXISTS idx_invitations_inviter ON invitations(inviter_user_id);

CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY,
  make TEXT NOT NULL, model TEXT NOT NULL, year INTEGER,
  plate TEXT NOT NULL UNIQUE, color TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'STANDARD',
  seats INTEGER NOT NULL DEFAULT 4 CHECK (seats BETWEEN 1 AND 20),
  vin TEXT NOT NULL DEFAULT '',
  insurance_expiry TEXT, inspection_expiry TEXT,
  mileage_km INTEGER NOT NULL DEFAULT 0, next_service_km INTEGER,
  status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','ASSIGNED','IN_SERVICE','MAINTENANCE','INACTIVE')),
  notes TEXT NOT NULL DEFAULT '',
  is_dev_data INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('DRIVER','VEHICLE')),
  owner_id TEXT NOT NULL,
  label TEXT NOT NULL,
  expires_at TEXT,
  verified_at TEXT, verified_by TEXT REFERENCES users(id),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_type, owner_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL REFERENCES users(id),
  pickup_address TEXT NOT NULL,
  dropoff_address TEXT NOT NULL,
  pickup_at TEXT NOT NULL,
  is_immediate INTEGER NOT NULL DEFAULT 0,
  passengers INTEGER NOT NULL CHECK (passengers BETWEEN 1 AND 8),
  luggage INTEGER NOT NULL DEFAULT 0 CHECK (luggage BETWEEN 0 AND 20),
  notes TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'STANDARD',
  payment_method TEXT NOT NULL CHECK (payment_method IN ('CASH','ONLINE')),
  estimated_distance_m INTEGER CHECK (estimated_distance_m IS NULL OR estimated_distance_m >= 0),
  quote_total INTEGER CHECK (quote_total IS NULL OR quote_total >= 0),
  final_distance_m INTEGER CHECK (final_distance_m IS NULL OR final_distance_m >= 0),
  waiting_minutes INTEGER,
  final_total INTEGER CHECK (final_total IS NULL OR final_total >= 0),
  price_lines TEXT,
  status TEXT NOT NULL,
  assigned_driver_id TEXT REFERENCES users(id),
  vehicle_id TEXT REFERENCES vehicles(id),
  cancel_reason TEXT NOT NULL DEFAULT '',
  is_dev_data INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_id, pickup_at);
CREATE INDEX IF NOT EXISTS idx_bookings_driver ON bookings(assigned_driver_id, pickup_at);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status, pickup_at);

CREATE TABLE IF NOT EXISTS booking_status_history (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  from_status TEXT, to_status TEXT NOT NULL,
  actor_id TEXT, actor_role TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bsh_booking ON booking_status_history(booking_id, at);

CREATE TABLE IF NOT EXISTS driver_earnings (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id),
  driver_id TEXT NOT NULL REFERENCES users(id),
  gross_amount INTEGER NOT NULL CHECK (gross_amount >= 0),
  driver_share_bps INTEGER NOT NULL CHECK (driver_share_bps BETWEEN 0 AND 10000),
  driver_amount INTEGER NOT NULL CHECK (driver_amount >= 0),
  company_amount INTEGER NOT NULL CHECK (company_amount >= 0),
  status TEXT NOT NULL DEFAULT 'CALCULATED' CHECK (status IN ('CALCULATED','PENDING_PAYMENT','PAID','ADJUSTED','CANCELLED')),
  paid_at TEXT, paid_by TEXT,
  created_at TEXT NOT NULL,
  CHECK (driver_amount + company_amount = gross_amount)
);
CREATE INDEX IF NOT EXISTS idx_earnings_driver ON driver_earnings(driver_id, created_at);

CREATE TABLE IF NOT EXISTS earning_adjustments (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL REFERENCES users(id),
  earning_id TEXT REFERENCES driver_earnings(id),
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) >= 3),
  created_by TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id),
  customer_id TEXT NOT NULL REFERENCES users(id),
  issued_at TEXT NOT NULL,
  total INTEGER NOT NULL CHECK (total >= 0),
  tax_enabled INTEGER NOT NULL, tax_rate_bps INTEGER NOT NULL DEFAULT 0,
  tax_amount INTEGER NOT NULL DEFAULT 0, tax_included INTEGER NOT NULL DEFAULT 1,
  tax_label TEXT NOT NULL DEFAULT '', tax_number TEXT NOT NULL DEFAULT '',
  lines TEXT NOT NULL, company_snapshot TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ISSUED','PAID','PARTIALLY_REFUNDED','REFUNDED','CANCELLED')),
  refunded_amount INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id, issued_at);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  invoice_id TEXT REFERENCES invoices(id),
  method TEXT NOT NULL CHECK (method IN ('CASH','CARD','TWINT','ONLINE','CRYPTO')),
  provider TEXT NOT NULL,
  provider_ref TEXT,
  provider_charge_ref TEXT,
  checkout_url TEXT,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  refunded_amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('PENDING','AUTHORIZED','PAID','FAILED','REFUNDED','PARTIALLY_REFUNDED','CANCELLED')),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (provider, provider_ref)
);
CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id);

CREATE TABLE IF NOT EXISTS payment_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL CHECK (length(reason) >= 3),
  status TEXT NOT NULL CHECK (status IN ('PENDING','SUCCEEDED','FAILED')),
  provider_ref TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cash_transactions (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id),
  driver_id TEXT NOT NULL REFERENCES users(id),
  expected_amount INTEGER NOT NULL CHECK (expected_amount >= 0),
  declared_amount INTEGER NOT NULL CHECK (declared_amount >= 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING_COLLECTION','COLLECTED','RECONCILED','DISPUTED')),
  collected_at TEXT, reconciled_at TEXT, reconciled_by TEXT,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_cash_driver ON cash_transactions(driver_id, status);

CREATE TABLE IF NOT EXISTS reward_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  kind TEXT NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rewards_user ON reward_ledger(user_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT, role TEXT,
  action TEXT NOT NULL,
  resource TEXT NOT NULL, resource_id TEXT,
  result TEXT NOT NULL CHECK (result IN ('SUCCESS','DENIED','FAILURE')),
  metadata TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log(resource, resource_id);
-- Journal d'audit en ajout seul : aucune modification ni suppression possible.
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
-- Pas de suppression physique des écritures financières.
CREATE TRIGGER IF NOT EXISTS earnings_no_delete BEFORE DELETE ON driver_earnings
BEGIN SELECT RAISE(ABORT, 'financial records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS invoices_no_delete BEFORE DELETE ON invoices
BEGIN SELECT RAISE(ABORT, 'financial records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS payments_no_delete BEFORE DELETE ON payments
BEGIN SELECT RAISE(ABORT, 'financial records cannot be deleted'); END;
-- Le snapshot de rémunération est figé.
CREATE TRIGGER IF NOT EXISTS earnings_snapshot_frozen BEFORE UPDATE OF gross_amount, driver_share_bps, driver_amount, company_amount ON driver_earnings
BEGIN SELECT RAISE(ABORT, 'earning snapshot is immutable; use earning_adjustments'); END;

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  channel TEXT NOT NULL CHECK (channel IN ('IN_APP','EMAIL','SMS','PUSH')),
  template TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENT','FAILED','READ')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);

CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  booking_id TEXT REFERENCES bookings(id),
  category TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ANSWERED','CLOSED')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS support_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES support_tickets(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
