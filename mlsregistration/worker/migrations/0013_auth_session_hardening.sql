-- Authentication UX and session hardening.
-- Additive only: preserves existing users, registrations, payments, and sessions.

ALTER TABLE auth_sessions ADD COLUMN last_seen_at TEXT;
ALTER TABLE auth_sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'magic_link';
ALTER TABLE auth_sessions ADD COLUMN return_to TEXT NOT NULL DEFAULT '/dashboard';

CREATE INDEX IF NOT EXISTS idx_auth_sessions_active
  ON auth_sessions (user_id, revoked_at, expires_at);
