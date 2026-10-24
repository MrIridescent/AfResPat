PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  did TEXT UNIQUE,
  orcid_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('research', 'dataset', 'traditional_knowledge')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  consent_status TEXT NOT NULL DEFAULT 'pending' CHECK (consent_status IN ('pending', 'recorded')),
  primary_language TEXT NOT NULL CHECK (length(primary_language) BETWEEN 2 AND 35),
  source_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (kind <> 'traditional_knowledge' OR visibility = 'private')
);

CREATE TABLE submission_metadata (
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  language TEXT NOT NULL CHECK (length(language) BETWEEN 2 AND 35),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  abstract TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (submission_id, language)
);

CREATE INDEX submissions_public_recent ON submissions (created_at DESC, id DESC) WHERE visibility = 'public';
