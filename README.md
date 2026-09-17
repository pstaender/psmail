# P.S.Mail

A minimal, fast webmail client: React/shadcn webclient + Bun API server (IMAP/SMTP sync, sqlite storage, CLI).

## Install

```bash
bun install
```

## Run

```bash
bun run dev     # webclient + API, with --hot reload
bun run start   # production
```

Open `http://localhost:3001` (configurable, see [Configuration](#configuration)). On first boot the server creates a default user (`username: default`, empty password) — pick it on the login screen to get in immediately.

## Webclient

- **Login** — pick a profile (or create one) and sign in. Session token is kept in `localStorage`.
- **Sidebar** — accounts and their folders (read live from IMAP), with unread counts from local sync state, a per-account "Sync now" button with live progress, and "Add account".
- **Message list** — per-folder, with unread/flag indicators, attachment marker, and a snippet.
- **Reading pane** — sender/recipient/subject/date header block, attachments with download, and three body views:
  - **Text** — the clearest possible reading version. Uses the plain-text part if there is one (any stray HTML tags stripped); otherwise cleans up the HTML with [Defuddle](https://github.com/kepano/defuddle) (drops layout/boilerplate clutter — marketing email is almost all nested-table layout, which is exactly what its table-content extraction targets) and converts it to Markdown with [Turndown](https://github.com/mixmark-io/turndown). Images are dropped, boilerplate links (unsubscribe, privacy policy, view-in-browser, …) are de-linked to plain text, and invisible Unicode padding characters some templates hide preheader text in are stripped.
  - **Plain text**
  - **Safe HTML** (default for HTML mail) — scripts/embeds always stripped; remote images and CSS backgrounds are blocked until you click "Show images"; all query params are stripped from http(s) link hrefs (a curated tracking-param denylist missed too much in practice, so this is deliberately blunt).
  - **Full HTML** — shows the message as sent, remote content and links untouched. Scripts are still never executed (see below).
  - Both HTML views render inside a sandboxed `<iframe>` (no `allow-scripts`) as a defense-in-depth layer independent of the HTML sanitizer.
- **Compose** — new/reply/forward, plain text body, file attachments, save draft or send.

Two known limitations worth knowing about: moving/deleting/flagging a message only updates the local database — there's no two-way sync pushing those changes back to the IMAP server yet; and sync only runs when you trigger it (no background scheduler, despite `downloadIntervalSeconds` existing in settings).

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
- `GET /api/accounts/:email/folders` — live IMAP folder list, merged with local message counts
- `GET/POST /api/accounts/:email/emails`, `GET/PATCH/DELETE /api/accounts/:email/emails/:id`
- `POST /api/accounts/:email/emails/:id/send`
- `PATCH /api/accounts/:email/emails/:id/move/:folderName`
- `POST/GET/DELETE /api/accounts/:email/emails/:id/attachments[/:attachmentId]`
- `GET/POST /api/accounts/:email/downloads`, `GET /api/accounts/:email/downloads/:id` — the sync job queue; only one active job per account at a time.

An email account's IMAP/SMTP passwords are encrypted at rest with a key derived from the owning user's login password (scrypt + AES-256-GCM). The derived key lives only in server memory for the lifetime of the session — restarting the server means logging in again before account credentials can be decrypted (e.g. to sync or send).

## CLI

The CLI talks to a running API server over HTTP — the same API the webclient uses — so start the server first.

```bash
bun run cli user create <username> [--password <pw>]

bun run cli account add --user <username> \
  --email me@example.com \
  --imap-host imap.example.com --imap-port 993 --imap-username me@example.com \
  --smtp-host smtp.example.com --smtp-port 465 --smtp-username me@example.com

bun run cli sync me@example.com --user <username> [--folder INBOX]
```

## Testing the webclient with real sample mail

Drop `.eml` files into `testmails/<folder>/` (e.g. `testmails/inbox/*.eml` — a folder name of `inbox` maps to `INBOX`, anything else maps to an IMAP folder of that name) and run:

```bash
bun run dev            # in one terminal — the API server must be running
bun run test:mailbox   # in another — add --reset to start from a clean slate on re-runs
```

This starts Greenmail (via `docker compose -f docker/greenmail.yml up -d`, or reuses it if already running), appends each `.eml` as-is (headers, dates, everything — not resent, so nothing gets rewritten) into the matching mailbox, creates/reuses a P.S.Mail account pointed at it (`testmails@example.local` under the `default` user, both overridable with `--account`/`--user`), and triggers a sync. Then just open the webclient and sign in as `default`. `testmails/` is gitignored — real email content shouldn't end up in version control.

Passwords can be passed with `--password`/`--imap-password`/`--smtp-password`, via `PSMAIL_PASSWORD`/`PSMAIL_IMAP_PASSWORD`/`PSMAIL_SMTP_PASSWORD` env vars, or you'll be prompted interactively. `sync` prints live progress (`Downloading email 3/43254`).

## Tests

```bash
bun run test            # backend: unit + integration (in-memory sqlite, no external services)
bun run test:frontend   # headless render smoke test (happy-dom + testing-library, mocked API)
bun run test:all        # both
bun run typecheck
```

`tests/unit/sync.test.ts` mocks imapflow, so backend tests need no network. `tests/frontend/app.test.tsx` mounts the real `<App/>` against a mocked `fetch` and drives it through login → account tree → message list → reading pane → compose/add-account dialogs — there's no browser available in this environment, so this is the substitute for manually clicking through it.

A separate end-to-end test exercises real IMAP/SMTP against [Greenmail](https://github.com/greenmail-mail-test/greenmail) in Docker:

```bash
docker compose -f docker/greenmail.yml up -d
RUN_IMAP_INTEGRATION=1 bun test tests/integration/imap-sync.test.ts
```

It's skipped by default.

## Stack

Bun, React 19, TypeScript, shadcn/Tailwind, `bun:sqlite`, [imapflow](https://github.com/postalsys/imapflow), [nodemailer](https://nodemailer.com/), [mailparser](https://nodemailer.com/extras/mailparser/), [DOMPurify](https://github.com/cure53/DOMPurify). See `CLAUDE.md` for conventions.

## Local testing

Place test email in folder `./testmails/inbox`, then:

* `podman compose -f docker/greenmail.yml up`
* `bun run dev`
* `bun run test:mailbox`
