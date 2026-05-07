DO $$ BEGIN
  CREATE TYPE node_status AS ENUM ('online', 'suspect', 'outage');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE place_type AS ENUM ('critical', 'important', 'standard');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS nodes (
  node_id           TEXT PRIMARY KEY,
  place_name        TEXT,
  latitude          NUMERIC(9,6),
  longitude         NUMERIC(9,6),
  place_type        place_type NOT NULL DEFAULT 'standard',
  voltage           NUMERIC,
  status            node_status NOT NULL DEFAULT 'online',
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nodes_status_lhb ON nodes(status, last_heartbeat_at);

CREATE TABLE IF NOT EXISTS outage_events (
  id                  BIGSERIAL PRIMARY KEY,
  node_id             TEXT NOT NULL REFERENCES nodes(node_id),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at            TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'open',     -- open | resolved
  incident_id         TEXT,                             -- returned by Incident Service
  priority_level      INT NOT NULL DEFAULT 0,           -- calculated from place_type + duration
  dispatch_status     TEXT NOT NULL DEFAULT 'pending',  -- pending | dispatched | rejected
  rejection_reason    TEXT,                             -- reason code when rejected
  priority_request_id TEXT,                             -- returned by PriorityCase Service
  priority_trace_id   TEXT,                             -- returned by PriorityCase Service
  version             INT NOT NULL DEFAULT 1            
);
CREATE INDEX IF NOT EXISTS idx_outage_open ON outage_events(node_id, ended_at);
CREATE INDEX IF NOT EXISTS idx_outage_priority_request_id ON outage_events(priority_request_id);
CREATE INDEX IF NOT EXISTS idx_outage_priority_trace_id ON outage_events(priority_trace_id);

CREATE TABLE IF NOT EXISTS dispatch_log (
  id              BIGSERIAL PRIMARY KEY,
  outage_event_id BIGINT REFERENCES outage_events(id),
  target          TEXT NOT NULL,
  url             TEXT NOT NULL,
  request_body    JSONB,
  http_status     INT,
  response_body   TEXT,
  error           TEXT,
  attempt_no      INT NOT NULL DEFAULT 1,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dispatch_log_outage ON dispatch_log(outage_event_id);


