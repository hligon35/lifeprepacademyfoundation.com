-- Phase One Paducah GO administration foundation.
-- Additive only: preserves existing registration, payment, agreement, roster, and sync tables.

INSERT INTO roles (id, name, description) VALUES
  ('volunteer', 'Volunteer', 'Scoped team or event support with limited participant access.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO permissions (id, description, sensitive) VALUES
  ('season.view', 'View season configuration and operating status.', 0),
  ('season.manage', 'Create and update season configuration.', 0),
  ('announcements.view', 'View program announcements and hero messages.', 0),
  ('announcements.manage', 'Create, publish, schedule, and archive announcements.', 0),
  ('staff.view', 'View staff assignments within an authorized program.', 0),
  ('staff.assign', 'Assign scoped coaches, volunteers, and administrators.', 1),
  ('activity.view', 'View the program activity log.', 1)
ON CONFLICT (id) DO NOTHING;

-- Season-level operating configuration. Registration pages continue to use the existing
-- program-scoped registration_settings row for backward compatibility.
CREATE TABLE IF NOT EXISTS season_settings (
  season_id TEXT PRIMARY KEY REFERENCES seasons (id),
  program_id TEXT NOT NULL REFERENCES programs (id),
  registration_mode TEXT NOT NULL DEFAULT 'inherit'
    CHECK (registration_mode IN ('inherit', 'open', 'closed', 'waitlist')),
  registration_capacity INTEGER,
  target_team_size INTEGER NOT NULL DEFAULT 10,
  target_games_per_team INTEGER NOT NULL DEFAULT 8,
  generation_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (generation_status IN ('not_started', 'draft', 'published', 'locked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_season_settings_program ON season_settings (program_id);

-- Scoped staff assignments layer on top of the existing program-level admin RBAC.
-- A role may be scoped to an entire program, a season, or a specific team.
CREATE TABLE IF NOT EXISTS admin_assignments (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL REFERENCES admin_users (id),
  program_id TEXT NOT NULL REFERENCES programs (id),
  season_id TEXT REFERENCES seasons (id),
  team_id TEXT,
  role_id TEXT NOT NULL REFERENCES roles (id),
  scope_type TEXT NOT NULL DEFAULT 'program'
    CHECK (scope_type IN ('program', 'season', 'team')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  expires_at TEXT,
  created_by TEXT REFERENCES admin_users (id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_assignments_user
  ON admin_assignments (admin_user_id, status);
CREATE INDEX IF NOT EXISTS idx_admin_assignments_program
  ON admin_assignments (program_id, status);
CREATE INDEX IF NOT EXISTS idx_admin_assignments_season
  ON admin_assignments (season_id, status);

-- Broadcast messages used by the program dashboard hero and future mobile notifications.
CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs (id),
  season_id TEXT REFERENCES seasons (id),
  audience_type TEXT NOT NULL DEFAULT 'program'
    CHECK (audience_type IN ('program', 'season', 'division', 'team', 'staff')),
  audience_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
  show_in_hero INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'scheduled', 'published', 'expired', 'archived')),
  starts_at TEXT,
  expires_at TEXT,
  created_by TEXT REFERENCES admin_users (id),
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_announcements_program
  ON announcements (program_id, status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_announcements_season
  ON announcements (season_id, status);

-- Seed the current Paducah GO season foundation without changing the existing
-- program-level registration gate.
INSERT INTO seasons (id, program_id, name, status, starts_on, ends_on)
VALUES (
  'paducah-go-2026-inaugural',
  'paducah-go-soccer-league',
  '2026 Inaugural Season',
  'upcoming',
  '2026-09-01',
  '2026-11-30'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO season_settings (
  season_id, program_id, registration_mode, target_team_size, target_games_per_team
)
VALUES (
  'paducah-go-2026-inaugural',
  'paducah-go-soccer-league',
  'inherit',
  10,
  8
)
ON CONFLICT (season_id) DO NOTHING;
