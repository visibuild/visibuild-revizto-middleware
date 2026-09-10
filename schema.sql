-- D1 schema for the Visibuild -> Revizto sync state.
-- Apply with: npm run db:migrate   (or db:migrate:local for wrangler dev)
--
-- Everything here is idempotent, so re-running it after a pull is safe.

-- A Visibuild project mirrored into a Revizto project. The Revizto side needs
-- both identifiers: the integer projectId for issue/add and comment/add, and
-- the projectUuid for workflows, team and issue queries.
CREATE TABLE IF NOT EXISTS project_pairs (
  id                    TEXT PRIMARY KEY,
  visibuild_project_id  TEXT    NOT NULL,
  visibuild_project_name TEXT   NOT NULL DEFAULT '',
  revizto_region        TEXT    NOT NULL,
  revizto_license_uuid  TEXT    NOT NULL,
  revizto_project_uuid  TEXT    NOT NULL,
  revizto_project_id    INTEGER NOT NULL,
  revizto_project_name  TEXT    NOT NULL DEFAULT '',
  enabled               INTEGER NOT NULL DEFAULT 1,
  -- Highest visi updatedAt successfully processed. Null means "never synced".
  visi_cursor           TEXT,
  -- The `synchronized` value returned by the last Revizto issue sweep.
  revizto_cursor        TEXT,
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS project_pairs_unique
  ON project_pairs (visibuild_project_id, revizto_project_uuid);

-- One row per visi we have pushed into a Revizto project.
CREATE TABLE IF NOT EXISTS issue_links (
  pair_id               TEXT NOT NULL,
  visi_id               TEXT NOT NULL,
  issue_uuid            TEXT NOT NULL,
  -- The visi updatedAt at the time of the last successful push.
  visi_updated_at       TEXT,
  -- JSON snapshot of the Revizto field values we last wrote, used as the `old`
  -- side of a diff when Revizto has not been touched since.
  shadow                TEXT NOT NULL DEFAULT '{}',
  -- JSON array of Visibuild ProjectAttachment ids already uploaded.
  synced_attachment_ids TEXT NOT NULL DEFAULT '[]',
  -- Timestamp of the last visi-status-change mirrored as a comment.
  status_history_cursor TEXT,
  -- JSON array of VisiRequirement ids already rendered into a comment.
  synced_requirement_ids TEXT NOT NULL DEFAULT '[]',
  state                 TEXT NOT NULL DEFAULT 'ok',   -- ok | error | pending
  last_error            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (pair_id, visi_id)
);

CREATE INDEX IF NOT EXISTS issue_links_by_issue ON issue_links (issue_uuid);
CREATE INDEX IF NOT EXISTS issue_links_by_state ON issue_links (pair_id, state);

-- One row per sync invocation (cron or manual).
CREATE TABLE IF NOT EXISTS sync_runs (
  id          TEXT PRIMARY KEY,
  trigger     TEXT NOT NULL,            -- cron | manual
  status      TEXT NOT NULL,            -- running | ok | partial | failed
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  created     INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  conflicts   INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  message     TEXT
);

CREATE INDEX IF NOT EXISTS sync_runs_recent ON sync_runs (started_at DESC);

-- One row per visi touched (or deliberately skipped) during a run.
CREATE TABLE IF NOT EXISTS sync_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL,
  pair_id    TEXT,
  visi_id    TEXT,
  visi_alias TEXT,
  action     TEXT NOT NULL,             -- create | update | skip | conflict | error
  detail     TEXT,                      -- JSON: fields written, values overwritten, reasons
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sync_events_by_run ON sync_events (run_id, id);
