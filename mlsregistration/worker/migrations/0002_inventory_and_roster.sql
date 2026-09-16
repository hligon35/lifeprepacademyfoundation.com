-- Uniform inventory (club/category/size stock) and roster generation (teams + assignment history).

CREATE TABLE IF NOT EXISTS uniform_inventory (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs (id),
  club_name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('kit', 'jersey', 'shorts', 'socks')),
  size TEXT NOT NULL,
  quantity_available INTEGER NOT NULL DEFAULT 0,
  quantity_reserved INTEGER NOT NULL DEFAULT 0,
  quantity_assigned INTEGER NOT NULL DEFAULT 0,
  quantity_damaged INTEGER NOT NULL DEFAULT 0,
  quantity_unavailable INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (program_id, club_name, category, size)
);
CREATE INDEX IF NOT EXISTS idx_inventory_lookup ON uniform_inventory (program_id, club_name, category);

CREATE TABLE IF NOT EXISTS uniform_inventory_imports (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs (id),
  filename TEXT,
  imported_by TEXT REFERENCES admin_users (id),
  status TEXT NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'committed', 'rolled_back')),
  summary_json TEXT NOT NULL,
  previous_snapshot_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inventory_imports_program ON uniform_inventory_imports (program_id, created_at);

CREATE TABLE IF NOT EXISTS roster_teams (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs (id),
  season_id TEXT REFERENCES seasons (id),
  league_format TEXT NOT NULL CHECK (league_format IN ('5v5', '6v6', '7v7', '8v8', '9v9', '10v10', '11v11')),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'locked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_roster_teams_program ON roster_teams (program_id, season_id);

-- One row per participant per generation run; is_current=1 marks the active assignment.
-- Prior rows are kept for "view assignment history" and audit of changes after publication.
CREATE TABLE IF NOT EXISTS roster_assignments (
  id TEXT PRIMARY KEY,
  roster_generation_id TEXT NOT NULL,
  participant_id TEXT NOT NULL REFERENCES registration_participants (id),
  team_id TEXT REFERENCES roster_teams (id),
  assigned_uniform_club TEXT,
  assigned_kit_id TEXT REFERENCES uniform_inventory (id),
  manual_override INTEGER NOT NULL DEFAULT 0,
  assignment_reason TEXT,
  warnings_json TEXT,
  is_current INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_roster_assignments_participant ON roster_assignments (participant_id, is_current);
CREATE INDEX IF NOT EXISTS idx_roster_assignments_generation ON roster_assignments (roster_generation_id);
CREATE INDEX IF NOT EXISTS idx_roster_assignments_team ON roster_assignments (team_id);
