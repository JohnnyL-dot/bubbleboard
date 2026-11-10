-- ADR-003 avsnitt 7. Tre tabeller. Inga index på kolumner som ändras vid varje synk.
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  link_hash TEXT NOT NULL,
  owner_hash TEXT NOT NULL,
  board_name TEXT NOT NULL,
  notes_json TEXT NOT NULL,
  notes_version INTEGER NOT NULL DEFAULT 1,
  n_notes INTEGER NOT NULL,
  seed TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',      -- open | finishing | finished
  started INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_activity INTEGER NOT NULL,
  finished_at INTEGER,
  result_json TEXT,
  manual_order TEXT
);
CREATE INDEX IF NOT EXISTS sessions_link ON sessions(link_hash);

CREATE TABLE IF NOT EXISTS participants (
  sid TEXT NOT NULL,
  pid TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0,
  answers TEXT NOT NULL DEFAULT '',
  answered INTEGER NOT NULL DEFAULT 0,      -- skickas aldrig till någon klient (OQ-56)
  done INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (sid, pid),
  UNIQUE (sid, name_key)
);

CREATE TABLE IF NOT EXISTS attempts (
  bucket TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
