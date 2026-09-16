-- D1-backed website submissions inbox.
-- This intentionally stores the submission body so the admin inbox does not depend on
-- Google Apps Script or an inbound mailbox.

CREATE TABLE IF NOT EXISTS site_submissions (
  id TEXT PRIMARY KEY,
  form_type TEXT NOT NULL DEFAULT 'contact',
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  page_url TEXT,
  source TEXT NOT NULL DEFAULT 'website',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'read', 'archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT,
  archived_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_site_submissions_status_created
  ON site_submissions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_site_submissions_type_created
  ON site_submissions (form_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_site_submissions_email
  ON site_submissions (email);
