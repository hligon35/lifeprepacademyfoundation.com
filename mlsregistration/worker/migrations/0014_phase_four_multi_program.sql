-- Phase Four multi-program foundation.
-- Additive only: preserves existing program, season, registration, roster, schedule,
-- commerce, and authentication data.

ALTER TABLE programs ADD COLUMN slug TEXT;
ALTER TABLE programs ADD COLUMN host TEXT;
ALTER TABLE programs ADD COLUMN description TEXT;
ALTER TABLE programs ADD COLUMN logo_url TEXT;
ALTER TABLE programs ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE programs ADD COLUMN is_configured INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_programs_slug ON programs (slug) WHERE slug IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_programs_host ON programs (host) WHERE host IS NOT NULL;

UPDATE programs
SET slug = 'paducah-go',
    host = 'paducahgo.lifeprepacademyfoundation.com',
    description = 'Paducah GO Soccer League operations, registration, teams, schedules, and merchandise.',
    logo_url = '/PGSlogo.png',
    display_order = 1,
    is_configured = 1
WHERE id = 'paducah-go-soccer-league';

UPDATE programs
SET slug = 'pnffl',
    host = 'pnffl.lifeprepacademyfoundation.com',
    description = 'Paducah NFL Flag Football League foundation.',
    logo_url = '/NFLFlagBlue.png',
    display_order = 2,
    is_configured = 1
WHERE id = 'paducah-nfl-flag-football';

UPDATE programs
SET slug = 'pnffc',
    host = 'pnffc.lifeprepacademyfoundation.com',
    description = 'Paducah NFL Flag Football Clinic foundation.',
    logo_url = '/pffLogo.png',
    display_order = 3,
    is_configured = 1
WHERE id = 'paducah-nfl-flag-football-clinic';

CREATE TABLE IF NOT EXISTS program_settings (
  program_id TEXT PRIMARY KEY REFERENCES programs (id),
  public_enabled INTEGER NOT NULL DEFAULT 0 CHECK (public_enabled IN (0, 1)),
  registration_enabled INTEGER NOT NULL DEFAULT 0 CHECK (registration_enabled IN (0, 1)),
  contact_email TEXT,
  support_phone TEXT,
  features_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT REFERENCES admin_users (id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO program_settings (program_id, public_enabled, registration_enabled, features_json)
SELECT id,
       CASE WHEN id = 'paducah-go-soccer-league' THEN 1 ELSE 0 END,
       0,
       CASE WHEN id = 'paducah-go-soccer-league'
            THEN '{"family_portal":true,"commerce":true,"schedules":true,"announcements":true}'
            ELSE '{"family_portal":true,"commerce":false,"schedules":true,"announcements":true}'
       END
FROM programs
WHERE slug IS NOT NULL
ON CONFLICT (program_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS season_templates (
  id TEXT PRIMARY KEY,
  program_id TEXT REFERENCES programs (id),
  name TEXT NOT NULL,
  description TEXT,
  sport TEXT,
  league_format TEXT NOT NULL DEFAULT '7v7',
  target_team_size INTEGER NOT NULL DEFAULT 10,
  target_games_per_team INTEGER NOT NULL DEFAULT 8,
  registration_mode TEXT NOT NULL DEFAULT 'inherit'
    CHECK (registration_mode IN ('inherit', 'open', 'closed', 'waitlist')),
  registration_capacity INTEGER,
  settings_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_by TEXT REFERENCES admin_users (id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (program_id, name)
);
CREATE INDEX IF NOT EXISTS idx_season_templates_program
  ON season_templates (program_id, status, name);

INSERT INTO season_templates (
  id, program_id, name, description, sport, league_format,
  target_team_size, target_games_per_team, registration_mode, settings_json
)
VALUES (
  'paducah-go-standard-7v7',
  'paducah-go-soccer-league',
  'Paducah GO Standard 7v7',
  'Reusable starting configuration for a standard Paducah GO season.',
  'soccer', '7v7', 10, 8, 'inherit',
  '{"days":["Saturday"],"default_field":"Paducah community fields"}'
)
ON CONFLICT (id) DO NOTHING;
