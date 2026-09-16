-- Programs/seasons catalog, registrations, participants, documents, drafts, and Sheets sync tracking.

CREATE TABLE IF NOT EXISTS programs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'hidden')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS seasons (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs (id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'active', 'closed', 'archived')),
  starts_on TEXT,
  ends_on TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (program_id, name)
);
CREATE INDEX IF NOT EXISTS idx_seasons_program ON seasons (program_id);

CREATE TABLE IF NOT EXISTS registrations (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE,
  program_id TEXT NOT NULL REFERENCES programs (id),
  season_id TEXT REFERENCES seasons (id),
  registration_type TEXT NOT NULL CHECK (
    registration_type IN (
      'player', 'volunteer', 'coach',
      'player_volunteer', 'player_coach', 'player_volunteer_coach'
    )
  ),
  status TEXT NOT NULL DEFAULT 'incomplete' CHECK (
    status IN (
      'incomplete', 'submitted', 'scholarship_pending',
      'agreement_pending', 'payment_pending', 'complete', 'withdrawn'
    )
  ),
  parent_first_name TEXT,
  parent_last_name TEXT,
  parent_email TEXT,
  parent_phone TEXT,
  parent_street TEXT,
  parent_apt TEXT,
  parent_city TEXT,
  parent_state TEXT,
  parent_zip TEXT,
  emergency_first_name TEXT,
  emergency_last_name TEXT,
  emergency_relationship TEXT,
  emergency_email TEXT,
  emergency_phone TEXT,
  scholarship_requested INTEGER NOT NULL DEFAULT 0,
  help_choice TEXT,
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  payment_amount_cents INTEGER,
  payment_transaction_id TEXT,
  agreement_status TEXT NOT NULL DEFAULT 'pending',
  raw_payload_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'worker',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_registrations_program ON registrations (program_id, status);
CREATE INDEX IF NOT EXISTS idx_registrations_parent_email ON registrations (parent_email);
CREATE INDEX IF NOT EXISTS idx_registrations_created ON registrations (created_at);

CREATE TABLE IF NOT EXISTS registration_participants (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL REFERENCES registrations (id),
  participant_type TEXT NOT NULL CHECK (participant_type IN ('player', 'volunteer', 'coach')),
  slot_index INTEGER,
  first_name TEXT,
  last_name TEXT,
  date_of_birth TEXT,
  gender_identity TEXT,
  grade_or_age TEXT,
  race_ethnicity TEXT,
  race_ethnicity_other TEXT,
  favorite_club TEXT,
  preferred_uniform_club TEXT,
  assigned_uniform_club TEXT,
  jersey_size TEXT,
  shorts_size TEXT,
  sock_size TEXT,
  how_heard TEXT,
  eligibility_status TEXT NOT NULL DEFAULT 'unknown' CHECK (eligibility_status IN ('eligible', 'ineligible', 'unknown')),
  assigned_kit_id TEXT,
  league_team_id TEXT,
  manual_override INTEGER NOT NULL DEFAULT 0,
  assignment_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_participants_registration ON registration_participants (registration_id);
CREATE INDEX IF NOT EXISTS idx_participants_team ON registration_participants (league_team_id);
CREATE INDEX IF NOT EXISTS idx_participants_favorite_club ON registration_participants (favorite_club);

CREATE TABLE IF NOT EXISTS registration_documents (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL REFERENCES registrations (id),
  participant_id TEXT REFERENCES registration_participants (id),
  document_type TEXT NOT NULL CHECK (
    document_type IN ('player_agreement', 'ppf_liability', 'volunteer_agreement', 'scholarship_guidelines')
  ),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'generated', 'viewed', 'failed')),
  r2_object_key TEXT,
  sha256 TEXT,
  transaction_id TEXT,
  signed_at TEXT,
  signer_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_registration ON registration_documents (registration_id);
CREATE INDEX IF NOT EXISTS idx_documents_transaction ON registration_documents (transaction_id);

-- Draft tokens are never stored raw; only a hash, matching the resume-token security requirement.
CREATE TABLE IF NOT EXISTS registration_drafts (
  id TEXT PRIMARY KEY,
  draft_token_hash TEXT NOT NULL UNIQUE,
  program_id TEXT NOT NULL REFERENCES programs (id),
  submission_id TEXT,
  stage TEXT,
  form_state_json TEXT NOT NULL,
  client_fingerprint TEXT,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_drafts_expires ON registration_drafts (expires_at);
CREATE INDEX IF NOT EXISTS idx_drafts_submission ON registration_drafts (submission_id);

CREATE TABLE IF NOT EXISTS sync_events (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL REFERENCES registrations (id),
  target TEXT NOT NULL DEFAULT 'google_sheets',
  status TEXT NOT NULL CHECK (status IN ('pending', 'synced', 'retrying', 'failed', 'manually_reconciled')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_attempted_at TEXT,
  synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_events_registration ON sync_events (registration_id);
CREATE INDEX IF NOT EXISTS idx_sync_events_status ON sync_events (status);
