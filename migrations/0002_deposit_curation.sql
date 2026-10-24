CREATE TABLE local_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'author' CHECK (role IN ('author', 'curator'))
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE INDEX sessions_user_id ON sessions (user_id);

CREATE TABLE login_attempts (
  email TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  first_attempt_at TEXT NOT NULL
);

ALTER TABLE submissions ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected'));
ALTER TABLE submissions ADD COLUMN reviewed_by TEXT REFERENCES users(id);
ALTER TABLE submissions ADD COLUMN reviewed_at TEXT;
ALTER TABLE submissions ADD COLUMN file_key TEXT;

CREATE INDEX submissions_review_queue ON submissions (review_status, created_at DESC);
CREATE INDEX submissions_author_recent ON submissions (author_id, created_at DESC);
