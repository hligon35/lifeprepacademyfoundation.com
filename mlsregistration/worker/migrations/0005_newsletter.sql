-- Newsletter builder: messages, image assets (protected source + approved delivery copy), recipients.

CREATE TABLE IF NOT EXISTS newsletters (
  id TEXT PRIMARY KEY,
  program_id TEXT REFERENCES programs (id),
  subject TEXT NOT NULL,
  preview_text TEXT,
  sender_name TEXT,
  sender_email TEXT,
  content_json TEXT NOT NULL,
  html_rendered TEXT,
  plain_text_fallback TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'scheduled', 'sending', 'sent', 'partially_failed', 'failed', 'cancelled')
  ),
  is_template INTEGER NOT NULL DEFAULT 0,
  scheduled_at TEXT,
  sent_at TEXT,
  created_by TEXT REFERENCES admin_users (id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_newsletters_status ON newsletters (status);
CREATE INDEX IF NOT EXISTS idx_newsletters_program ON newsletters (program_id);

-- r2_object_key is the private site-admin source upload; delivery_object_key is the separate,
-- approved asset actually referenced by the sent email (never a private admin URL).
CREATE TABLE IF NOT EXISTS newsletter_assets (
  id TEXT PRIMARY KEY,
  newsletter_id TEXT REFERENCES newsletters (id),
  r2_object_key TEXT NOT NULL,
  delivery_object_key TEXT,
  alt_text TEXT,
  width INTEGER,
  height INTEGER,
  content_type TEXT,
  size_bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_newsletter_assets_newsletter ON newsletter_assets (newsletter_id);

CREATE TABLE IF NOT EXISTS newsletter_recipients (
  id TEXT PRIMARY KEY,
  newsletter_id TEXT NOT NULL REFERENCES newsletters (id),
  audience_ref TEXT,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'sent', 'failed', 'bounced', 'unsubscribed')
  ),
  sent_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_newsletter_recipients_newsletter ON newsletter_recipients (newsletter_id, status);
