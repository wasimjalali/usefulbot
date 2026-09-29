-- Feedback sent from the macOS app. D1 is the source of truth; email is a notification.
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,          -- ISO 8601 UTC
  kind TEXT NOT NULL CHECK (kind IN ('idea', 'problem', 'other')),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 4000),
  reply_email TEXT,
  app_version TEXT,
  build TEXT,
  macos_version TEXT,
  chip TEXT,
  install_id TEXT NOT NULL,          -- random id the app creates once
  ip_hash TEXT NOT NULL              -- HMAC-SHA256 of the IP with IP_SALT, never the raw IP
);

CREATE INDEX feedback_install_created ON feedback (install_id, created_at);
CREATE INDEX feedback_ip_created ON feedback (ip_hash, created_at);
CREATE INDEX feedback_created ON feedback (created_at);
