ALTER TABLE submissions ADD COLUMN source_identifier TEXT;
ALTER TABLE submissions ADD COLUMN source_feed TEXT;
ALTER TABLE submissions ADD COLUMN source_license TEXT;
ALTER TABLE submissions ADD COLUMN file_sha256 TEXT;

CREATE UNIQUE INDEX submissions_external_identity ON submissions (source_feed, source_identifier) WHERE source_feed IS NOT NULL;

CREATE TABLE submission_versions (
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  metadata_sha256 TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (submission_id, version)
);

CREATE TRIGGER metadata_insert_pending BEFORE INSERT ON submission_metadata
WHEN (SELECT review_status FROM submissions WHERE id = NEW.submission_id) <> 'pending'
BEGIN SELECT RAISE(ABORT, 'approved metadata is immutable'); END;

CREATE TRIGGER metadata_delete_pending BEFORE DELETE ON submission_metadata
WHEN (SELECT review_status FROM submissions WHERE id = OLD.submission_id) <> 'pending'
BEGIN SELECT RAISE(ABORT, 'approved metadata is immutable'); END;

CREATE TRIGGER metadata_update_pending BEFORE UPDATE ON submission_metadata
WHEN (SELECT review_status FROM submissions WHERE id = OLD.submission_id) <> 'pending'
BEGIN SELECT RAISE(ABORT, 'approved metadata is immutable'); END;
