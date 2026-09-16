-- Program-scoped registration open/closed control (server-side source of truth; not client-JS only).
-- Default seed row for Paducah GO Soccer League intentionally matches the production-closed state
-- already in effect (REGISTRATION_OPEN = false in flow-gate.js / mls-go.html) so this migration
-- cannot change live behavior on its own.

CREATE TABLE IF NOT EXISTS registration_settings (
  program_id TEXT PRIMARY KEY REFERENCES programs (id),
  registration_status TEXT NOT NULL DEFAULT 'closed' CHECK (registration_status IN ('open', 'closed')),
  -- Only meaningful while registration_status = 'closed':
  allow_draft_resume INTEGER NOT NULL DEFAULT 0,
  allow_private_access INTEGER NOT NULL DEFAULT 0,
  private_access_token_hash TEXT,
  public_message TEXT,
  closed_message TEXT NOT NULL DEFAULT 'Registration is currently closed. Please check back soon.',
  reopens_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO registration_settings (
  program_id, registration_status, allow_draft_resume, allow_private_access,
  closed_message, updated_by
) VALUES (
  'paducah-go-soccer-league',
  'closed',
  0,
  0,
  'MLS GO registration is closed until next season. Please check back for future registration dates.',
  'system (migration seed - matches production default at feature launch)'
)
ON CONFLICT (program_id) DO NOTHING;
