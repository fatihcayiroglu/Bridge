CREATE TABLE IF NOT EXISTS client_error_events (
  _id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  source TEXT,
  line INTEGER,
  col INTEGER,
  stack TEXT,
  url TEXT,
  user_agent TEXT,
  lang TEXT,
  user_id TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_client_error_events_created_at
  ON client_error_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_client_error_events_type
  ON client_error_events(type);
