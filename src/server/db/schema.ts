export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  auth_method TEXT NOT NULL DEFAULT 'password',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT,
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL,
  imap_secure INTEGER NOT NULL DEFAULT 1,
  imap_username TEXT NOT NULL,
  imap_password_encrypted TEXT NOT NULL,
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL,
  smtp_secure INTEGER NOT NULL DEFAULT 1,
  smtp_username TEXT NOT NULL,
  smtp_password_encrypted TEXT NOT NULL,
  read_only INTEGER NOT NULL DEFAULT 0,
  skip_soft_delete INTEGER NOT NULL DEFAULT 0,
  imap_uidplus INTEGER,
  sender_name TEXT,
  signature TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  sent_folder TEXT,
  special_folders TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(user_id, email)
);

CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);

CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder TEXT NOT NULL DEFAULT 'Drafts',
  uid INTEGER,
  is_draft INTEGER NOT NULL DEFAULT 0,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_flagged INTEGER NOT NULL DEFAULT 0,
  message_id TEXT,
  in_reply_to TEXT,
  from_addr TEXT,
  to_addr TEXT,
  cc_addr TEXT,
  bcc_addr TEXT,
  reply_to_addr TEXT,
  subject TEXT,
  date TEXT,
  return_path TEXT,
  received TEXT,
  mime_version TEXT,
  content_type TEXT,
  authentication_results TEXT,
  dkim TEXT,
  spf TEXT,
  plain_text TEXT,
  html_text TEXT,
  headers_raw TEXT,
  size INTEGER,
  -- AI results, kept once computed (see routes/ai.ts): 2-6 short labels as a JSON array, a summary, and a translation.
  taxonomy_list TEXT,
  ai_summary TEXT,
  translated_text TEXT,
  translated_language TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(account_id, folder, uid)
);

CREATE INDEX IF NOT EXISTS idx_emails_account_id ON emails(account_id);
CREATE INDEX IF NOT EXISTS idx_emails_account_folder ON emails(account_id, folder);
CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
-- Serves the folder listing (WHERE account_id AND folder ORDER BY date DESC, id DESC LIMIT n) straight
-- off the index: no sort of the whole folder, so paging through 5k+ messages stays cheap.
-- Keeps unread counts (per-folder badges, the combined Inbox's) cheap: only unread rows are indexed.
CREATE INDEX IF NOT EXISTS idx_emails_unread ON emails(account_id, folder) WHERE is_read = 0;
CREATE INDEX IF NOT EXISTS idx_emails_folder_date ON emails(account_id, folder, date DESC, id DESC);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT,
  content_id TEXT,
  is_inline INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_attachments_email_id ON attachments(email_id);

-- Recipient autocomplete: one row per (account, address), maintained as mail is stored (see models/contacts.ts).
CREATE TABLE IF NOT EXISTS contacts (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  name_lc TEXT NOT NULL DEFAULT '',
  from_count INTEGER NOT NULL DEFAULT 0,
  cc_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  last_used TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (account_id, address)
) WITHOUT ROWID;

-- Tombstones for messages deleted (or moved away) locally only — a read-only account never tells the
-- server, so without these the next sync would just download them again. Only the UID is kept; the
-- message row itself (bodies, attachments) is really deleted. See models/tombstones.ts.
CREATE TABLE IF NOT EXISTS deleted_uids (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder TEXT NOT NULL,
  uid INTEGER NOT NULL,
  PRIMARY KEY (account_id, folder, uid)
) WITHOUT ROWID;

-- AI providers a user has set up. The key is encrypted with the user's key, like the account passwords.
CREATE TABLE IF NOT EXISTS ai_apis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  vendor TEXT NOT NULL,
  model TEXT NOT NULL,
  base_url TEXT,
  api_key_encrypted TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_apis_user_id ON ai_apis(user_id);

-- What to ask an AI for (summarize, categorize, translate, ...): one prompt, run through one of the user's ai_apis.
CREATE TABLE IF NOT EXISTS ai_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ai_api_id INTEGER NOT NULL REFERENCES ai_apis(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_skills_user_id ON ai_skills(user_id, category);

CREATE TABLE IF NOT EXISTS downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_downloads_account_id ON downloads(account_id);
`;
