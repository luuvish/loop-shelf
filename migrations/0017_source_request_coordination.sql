-- Operational coordination only: no URL, query, account or response contents.
CREATE TABLE source_request_state (
  source_id TEXT PRIMARY KEY CHECK (source_id IN ('khinsider','zophar')),
  ready_at INTEGER NOT NULL DEFAULT 0 CHECK (ready_at BETWEEN 0 AND 9007199254740991),
  cooldown_until INTEGER NOT NULL DEFAULT 0 CHECK (cooldown_until BETWEEN 0 AND 9007199254740991),
  observed_at INTEGER NOT NULL DEFAULT 0 CHECK (observed_at BETWEEN 0 AND 9007199254740991)
) STRICT;
INSERT INTO source_request_state(source_id) VALUES ('khinsider'),('zophar');
CREATE TABLE source_request_ticket (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL REFERENCES source_request_state(source_id),
  owner_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at BETWEEN 0 AND 9007199254740991),
  phase TEXT NOT NULL CHECK (phase IN ('waiting','reserved','running'))
) STRICT;
CREATE UNIQUE INDEX source_request_holder_idx ON source_request_ticket(source_id) WHERE phase IN ('reserved','running');
CREATE INDEX source_request_queue_idx ON source_request_ticket(source_id,sequence);
CREATE INDEX source_request_expiry_idx ON source_request_ticket(source_id,expires_at) WHERE phase <> 'running';
