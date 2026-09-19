-- Phase Two league operations.
-- Additive only: preserves published rosters, existing uniform inventory, registrations,
-- payment/agreement workflows, and Phase One admin data.

INSERT INTO permissions (id, description, sensitive) VALUES
  ('roster.generate', 'Generate a reviewable roster recommendation.', 0),
  ('roster.publish', 'Publish and lock approved roster assignments.', 0),
  ('schedule.generate', 'Generate a draft schedule version.', 0),
  ('schedule.publish', 'Publish an approved schedule version.', 0),
  ('attendance.view', 'View attendance for authorized teams or duties.', 0),
  ('attendance.manage', 'Record attendance for authorized teams or duties.', 0),
  ('game_results.manage', 'Record results for authorized games.', 0)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS roster_generations (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs (id),
  season_id TEXT NOT NULL REFERENCES seasons (id),
  league_format TEXT NOT NULL DEFAULT '7v7'
    CHECK (league_format IN ('5v5', '6v6', '7v7', '8v8', '9v9', '10v10', '11v11')),
  team_count INTEGER NOT NULL,
  target_team_size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'locked', 'archived')),
  constraints_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT REFERENCES admin_users (id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT,
  locked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_roster_generations_season
  ON roster_generations (program_id, season_id, created_at);

CREATE TABLE IF NOT EXISTS roster_generation_teams (
  generation_id TEXT NOT NULL REFERENCES roster_generations (id),
  team_id TEXT NOT NULL REFERENCES roster_teams (id),
  PRIMARY KEY (generation_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_roster_generation_teams_team
  ON roster_generation_teams (team_id);

CREATE TABLE IF NOT EXISTS schedule_versions (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs (id),
  season_id TEXT NOT NULL REFERENCES seasons (id),
  games_per_team INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'archived')),
  constraints_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT REFERENCES admin_users (id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_schedule_versions_season
  ON schedule_versions (program_id, season_id, created_at);

CREATE TABLE IF NOT EXISTS schedule_games (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES schedule_versions (id),
  program_id TEXT NOT NULL REFERENCES programs (id),
  season_id TEXT NOT NULL REFERENCES seasons (id),
  round_number INTEGER NOT NULL,
  home_team_id TEXT NOT NULL REFERENCES roster_teams (id),
  away_team_id TEXT NOT NULL REFERENCES roster_teams (id),
  starts_at TEXT,
  field_name TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'postponed', 'cancelled', 'played')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_schedule_games_version
  ON schedule_games (version_id, round_number);
CREATE INDEX IF NOT EXISTS idx_schedule_games_team
  ON schedule_games (home_team_id, away_team_id, starts_at);

CREATE TABLE IF NOT EXISTS game_results (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL UNIQUE REFERENCES schedule_games (id),
  home_score INTEGER NOT NULL DEFAULT 0,
  away_score INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  entered_by TEXT REFERENCES admin_users (id),
  entered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attendance_records (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs (id),
  season_id TEXT NOT NULL REFERENCES seasons (id),
  team_id TEXT NOT NULL REFERENCES roster_teams (id),
  participant_id TEXT NOT NULL REFERENCES registration_participants (id),
  event_id TEXT REFERENCES events (id),
  game_id TEXT REFERENCES schedule_games (id),
  attendance_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('present', 'absent', 'excused', 'late')),
  note TEXT,
  recorded_by TEXT REFERENCES admin_users (id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (team_id, participant_id, attendance_date, event_id, game_id)
);
CREATE INDEX IF NOT EXISTS idx_attendance_team_date
  ON attendance_records (team_id, attendance_date);

CREATE TABLE IF NOT EXISTS volunteer_duties (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL REFERENCES admin_users (id),
  program_id TEXT NOT NULL REFERENCES programs (id),
  season_id TEXT REFERENCES seasons (id),
  team_id TEXT REFERENCES roster_teams (id),
  event_id TEXT REFERENCES events (id),
  duty_type TEXT NOT NULL
    CHECK (duty_type IN ('assistant_coach', 'team_manager', 'game_day', 'field_coordinator', 'check_in', 'other')),
  starts_at TEXT,
  ends_at TEXT,
  status TEXT NOT NULL DEFAULT 'assigned'
    CHECK (status IN ('assigned', 'confirmed', 'completed', 'cancelled')),
  notes TEXT,
  created_by TEXT REFERENCES admin_users (id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_volunteer_duties_user
  ON volunteer_duties (admin_user_id, status);
CREATE INDEX IF NOT EXISTS idx_volunteer_duties_program
  ON volunteer_duties (program_id, season_id, status);
