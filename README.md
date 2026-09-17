# P.S.Mail

A minimal, fast webmail client. This repository currently contains the **backend API server** (IMAP/SMTP sync, sqlite storage, CLI) — no frontend yet.

## Install

```bash
bun install
```

## Run the API server

```bash
bun run server        # dev, with --hot reload
bun run server:start   # production
```

The server listens on `http://localhost:3001` by default (configurable, see [Configuration](#configuration)). On first boot it creates a default user (`username: default`, empty password).

## Configuration

Settings, the sqlite database, and downloaded attachments live in a per-OS config directory:

- macOS: `~/Library/Application Support/psmail`
- Windows: `%APPDATA%\psmail`
- Linux: `$XDG_CONFIG_HOME/psmail` or `~/.config/psmail`

Override with `PSMAIL_CONFIG_DIR` (used by the test suite to avoid touching your real config).

`settings.json` (created on first run) controls:

```json
{
  "port": 3001,
  "sessionTtlSeconds": 43200,
  "downloadIntervalSeconds": 300
}
```

## API overview

All routes except `/api/auth/login`, `/api/users` (list/create) and `/api/health` require `Authorization: Bearer <token>` from `/api/auth/login`.

Accounts are addressed in the URL **by email address** (URL-encoded), e.g. `/api/accounts/me%40example.com`.

- `POST /api/auth/login`, `POST /api/auth/logout`
- `GET/POST /api/users`, `GET/PATCH/DELETE /api/users/:id`
- `GET/POST /api/accounts`, `GET/PATCH/DELETE /api/accounts/:email`
- `GET/POST /api/accounts/:email/emails`, `GET/PATCH/DELETE /api/accounts/:email/emails/:id`
- `POST /api/accounts/:email/emails/:id/send`
- `PATCH /api/accounts/:email/emails/:id/move/:folderName`
- `POST/GET/DELETE /api/accounts/:email/emails/:id/attachments[/:attachmentId]`
- `GET/POST /api/accounts/:email/downloads`, `GET /api/accounts/:email/downloads/:id` — the sync job queue; only one active job per account at a time.

An email account's IMAP/SMTP passwords are encrypted at rest with a key derived from the owning user's login password (scrypt + AES-256-GCM). The derived key lives only in server memory for the lifetime of the session — restarting the server means logging in again before account credentials can be decrypted (e.g. to sync or send).

## CLI

The CLI talks to a running API server over HTTP — the same API the future webclient will use — so start the server first.

```bash
bun run cli user create <username> [--password <pw>]

bun run cli account add --user <username> \
  --email me@example.com \
  --imap-host imap.example.com --imap-port 993 --imap-username me@example.com \
  --smtp-host smtp.example.com --smtp-port 465 --smtp-username me@example.com

bun run cli sync me@example.com --user <username> [--folder INBOX]
```

Passwords can be passed with `--password`/`--imap-password`/`--smtp-password`, via `PSMAIL_PASSWORD`/`PSMAIL_IMAP_PASSWORD`/`PSMAIL_SMTP_PASSWORD` env vars, or you'll be prompted interactively. `sync` prints live progress (`Downloading email 3/43254`).

## Tests

```bash
bun test
```

Unit and integration tests run against an in-memory sqlite db and don't need any external service — imapflow itself is mocked in `tests/unit/sync.test.ts`.

A separate end-to-end test exercises real IMAP/SMTP against [Greenmail](https://github.com/greenmail-mail-test/greenmail) in Docker:

```bash
docker compose -f docker/greenmail.yml up -d
RUN_IMAP_INTEGRATION=1 bun test tests/integration/imap-sync.test.ts
```

It's skipped by default (and by a plain `bun test` run).

## Stack

Built with [Bun](https://bun.com), TypeScript, `bun:sqlite`, [imapflow](https://github.com/postalsys/imapflow), [nodemailer](https://nodemailer.com/), and [mailparser](https://nodemailer.com/extras/mailparser/). See `CLAUDE.md` for conventions.
