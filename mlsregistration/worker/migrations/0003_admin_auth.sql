-- Program-scoped admin identity, invitations, RBAC (roles/permissions), and audit log.

CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'suspended', 'removed')),
  password_hash TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admin_invitations (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  invited_by TEXT REFERENCES admin_users (id),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_invitations_email ON admin_invitations (email);

-- Suggested roles (super_admin, program_administrator, registration_manager, roster_manager,
-- coach, finance_manager, read_only_reviewer) are seeded in 0006_seed_data.sql.
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT
);

-- Permission ids follow "area.action" (e.g. roster.view, payments.view, participant.limited_view).
-- sensitive=1 marks fields/actions gated behind an additional explicit grant (Phase 10 sensitive-field list).
CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  description TEXT,
  sensitive INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS admin_user_programs (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL REFERENCES admin_users (id),
  program_id TEXT NOT NULL REFERENCES programs (id),
  role_id TEXT NOT NULL REFERENCES roles (id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (admin_user_id, program_id, role_id)
);
CREATE INDEX IF NOT EXISTS idx_admin_user_programs_user ON admin_user_programs (admin_user_id);
CREATE INDEX IF NOT EXISTS idx_admin_user_programs_program ON admin_user_programs (program_id);

-- Explicit per-user overrides layered on top of role defaults; program_id NULL = applies to all programs.
CREATE TABLE IF NOT EXISTS admin_user_permissions (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL REFERENCES admin_users (id),
  program_id TEXT REFERENCES programs (id),
  permission_id TEXT NOT NULL REFERENCES permissions (id),
  effect TEXT NOT NULL CHECK (effect IN ('grant', 'revoke')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (admin_user_id, program_id, permission_id)
);
CREATE INDEX IF NOT EXISTS idx_admin_user_permissions_user ON admin_user_permissions (admin_user_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_admin_user_id TEXT REFERENCES admin_users (id),
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  program_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at);
