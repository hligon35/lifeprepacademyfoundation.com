-- Privacy-conscious analytics: pseudonymous event log + pre-aggregated daily rollups.
-- No raw IPs, full user-agent strings, payment data, agreement signatures, or form contents.

CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  program_id TEXT REFERENCES programs (id),
  event_name TEXT NOT NULL CHECK (
    event_name IN (
      'page_view', 'registration_started', 'registration_stage_completed',
      'registration_draft_saved', 'registration_resumed', 'registration_abandoned',
      'registration_submitted', 'registration_failed'
    )
  ),
  anon_id TEXT,
  page_path TEXT,
  referrer_domain TEXT,
  device_type TEXT,
  browser_family TEXT,
  country TEXT,
  metadata_json TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_analytics_events_name_time ON analytics_events (event_name, occurred_at);
CREATE INDEX IF NOT EXISTS idx_analytics_events_program_time ON analytics_events (program_id, occurred_at);

CREATE TABLE IF NOT EXISTS analytics_daily_metrics (
  id TEXT PRIMARY KEY,
  program_id TEXT REFERENCES programs (id),
  metric_date TEXT NOT NULL,
  page_views INTEGER NOT NULL DEFAULT 0,
  unique_visitors_est INTEGER NOT NULL DEFAULT 0,
  registrations_started INTEGER NOT NULL DEFAULT 0,
  registrations_submitted INTEGER NOT NULL DEFAULT 0,
  registrations_abandoned INTEGER NOT NULL DEFAULT 0,
  UNIQUE (program_id, metric_date)
);
CREATE INDEX IF NOT EXISTS idx_analytics_daily_date ON analytics_daily_metrics (metric_date);
