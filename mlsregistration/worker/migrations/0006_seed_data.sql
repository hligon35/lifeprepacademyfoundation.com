-- Seed initial programs and the RBAC catalog (roles/permissions). Role -> permission defaults are
-- enforced in application code (Phase 10), not hardcoded as rows here, so they stay easy to tune.

INSERT INTO programs (id, name, status) VALUES
  ('paducah-go-soccer-league', 'Paducah GO Soccer League', 'active'),
  ('paducah-nfl-flag-football', 'Paducah NFL Flag Football', 'hidden'),
  ('paducah-nfl-flag-football-clinic', 'Paducah NFL Flag Football Clinic', 'hidden')
ON CONFLICT (id) DO NOTHING;

INSERT INTO roles (id, name, description) VALUES
  ('super_admin', 'Super Admin', 'Full access across all programs and settings.'),
  ('program_administrator', 'Program Administrator', 'Full access within assigned program(s).'),
  ('registration_manager', 'Registration Manager', 'Manage registrations, agreements, payments, sync retries.'),
  ('roster_manager', 'Roster Manager', 'Manage uniform inventory and the roster generator.'),
  ('coach', 'Coach', 'Limited roster and participant visibility only.'),
  ('finance_manager', 'Finance Manager', 'Payment and scholarship visibility.'),
  ('read_only_reviewer', 'Read-Only Reviewer', 'View-only access, no exports or edits.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO permissions (id, description, sensitive) VALUES
  ('registration.view', 'View full registration details', 0),
  ('registration.view_limited', 'View non-sensitive registration summary', 0),
  ('registration.edit', 'Edit registration records', 0),
  ('registration.export', 'Export registration data', 1),
  ('participant.view', 'View participant details', 0),
  ('participant.limited_view', 'View participant name/team/size only', 0),
  ('parent_contact.view', 'View parent email/phone/address', 1),
  ('participant.dob.view', 'View participant date of birth', 1),
  ('participant.race_ethnicity.view', 'View participant race/ethnicity', 1),
  ('scholarship.view', 'View scholarship applications and data', 1),
  ('payments.view', 'View payment status and amounts', 1),
  ('agreements.view', 'View/download signed agreement documents', 1),
  ('notes.internal.view', 'View internal admin notes', 1),
  ('notes.internal.edit', 'Add/edit internal admin notes', 0),
  ('sync.retry', 'Retry failed Google Sheets synchronization', 0),
  ('inventory.view', 'View uniform inventory', 0),
  ('inventory.import', 'Import/rollback uniform inventory CSVs', 0),
  ('roster.view', 'View roster assignments', 0),
  ('roster.manage', 'Generate, recalculate, publish, lock rosters', 0),
  ('analytics.view', 'View site analytics dashboard', 0),
  ('newsletter.view', 'View newsletters', 0),
  ('newsletter.manage', 'Create, edit, schedule, send newsletters', 0),
  ('settings.permissions.manage', 'Manage admin users, roles, and permissions', 1)
ON CONFLICT (id) DO NOTHING;
