-- Shared multi-program platform foundation: family/app auth, cross-subdomain handoff,
-- teams/rosters, events/schedules, messaging, notifications, and commerce.
-- Additive only. Does not modify or drop any existing table/data.

-- Reserve the two new program slugs (kept inactive/hidden until each program is ready to launch).
INSERT INTO programs (id, name, status)
VALUES
  ('paducah-nfl-flag-football', 'Paducah NFL Flag Football League', 'hidden'),
  ('paducah-nfl-flag-football-clinic', 'Paducah NFL Flag Football Clinic', 'hidden')
ON CONFLICT (id) DO NOTHING;

-- Layer B: shared family/staff app-session accounts (distinct from Cloudflare Access staff auth).
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS program_memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  program_id TEXT NOT NULL REFERENCES programs (id),
  role TEXT NOT NULL CHECK (role IN ('guardian', 'player', 'coach', 'volunteer', 'staff')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, program_id, role)
);
CREATE INDEX IF NOT EXISTS idx_program_memberships_user ON program_memberships (user_id);
CREATE INDEX IF NOT EXISTS idx_program_memberships_program ON program_memberships (program_id);

-- Session tokens issued after magic-link verification (opaque, hashed at rest).
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  token_hash TEXT NOT NULL UNIQUE,
  issued_host TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions (user_id);

-- One-time, short-lived codes for secure cross-subdomain session handoff (app. <-> program subdomains).
CREATE TABLE IF NOT EXISTS auth_handoff_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users (id),
  source_host TEXT NOT NULL,
  target_host TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_auth_handoff_user ON auth_handoff_codes (user_id);

CREATE TABLE IF NOT EXISTS guardians (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users (id),
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  guardian_id TEXT REFERENCES guardians (id),
  program_id TEXT NOT NULL REFERENCES programs (id),
  first_name TEXT,
  last_name TEXT,
  birthdate TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_players_program ON players (program_id);
CREATE INDEX IF NOT EXISTS idx_players_guardian ON players (guardian_id);

CREATE TABLE IF NOT EXISTS coaches (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users (id),
  program_id TEXT NOT NULL REFERENCES programs (id),
  first_name TEXT,
  last_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS volunteers (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users (id),
  program_id TEXT NOT NULL REFERENCES programs (id),
  first_name TEXT,
  last_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs (id),
  season_id TEXT REFERENCES seasons (id),
  name TEXT NOT NULL,
  coach_id TEXT REFERENCES coaches (id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_teams_program ON teams (program_id);

CREATE TABLE IF NOT EXISTS team_members (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams (id),
  player_id TEXT NOT NULL REFERENCES players (id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (team_id, player_id)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs (id),
  season_id TEXT REFERENCES seasons (id),
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  location TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_program ON events (program_id);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events (id),
  team_id TEXT REFERENCES teams (id),
  opponent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs (id),
  sender_user_id TEXT REFERENCES users (id),
  team_id TEXT REFERENCES teams (id),
  subject TEXT,
  body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  program_id TEXT REFERENCES programs (id),
  type TEXT NOT NULL,
  payload_json TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id);

-- Stripe-only commerce (merchandise), separate from the existing Quest player-registration payment flow.
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs (id),
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  stripe_product_id TEXT,
  stripe_price_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs (id),
  user_id TEXT REFERENCES users (id),
  stripe_checkout_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  total_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders (id),
  stripe_payment_intent_id TEXT UNIQUE,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
