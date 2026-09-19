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

- **Login** — pick a profile (or create one) and sign in. Clicking a profile tries an empty password first — if the account has none set, that's it, no password prompt ever appears; only a profile that actually needs one falls through to asking for it. Session token is kept in `localStorage`. The header's username (top right) is hidden when it's `default`, since practically everyone's running under that out-of-the-box profile.
- **Sidebar** — starts with a combined **Inbox** and **Sent** (every account's, newest first, paged as you scroll; the list shows the account and folder of each message, and Sent shows the recipient), then the accounts in the order set under Account settings → **Misc** → position, and their folders (read live from IMAP), with unread counts from local sync state, a per-account "Sync now" button with live progress, and "Add account". Collapsible (the panel-icon button next to "Accounts", or the button that replaces it once collapsed) and resizable by dragging its right edge; both are remembered (`localStorage`). Each account's `⋮` menu has "Remove account" and, below it, "Account settings" — a tabbed dialog: **Server** (host/port/username/TLS for both IMAP and SMTP, display name), **Safety** (the read-only flag and "always delete permanently" — see below), **Signature** (sender name and a markdown signature, see "Compose" below), and **Misc** (the account's position in the sidebar list). Passwords are optional on edit (blank = keep the current one, since the API never returns them) and required on creation.
- **Message list** — per-folder, with unread/flag indicators, attachment marker, and a snippet. Resizable by dragging its right edge (remembered too). Cmd/Ctrl+click to toggle individual messages, or Shift+click to select the whole range from the last plain/Ctrl-clicked message, for bulk Mark as read/unread, Move, or Delete (with confirmation); a plain click reads a message as usual and clears the multi-selection. Double-clicking a draft opens it for editing (see "Compose"); double-clicking anything else does nothing extra. The list loads 100 messages at a time and fetches the next page automatically when you scroll near the bottom. Bulk actions send the whole selection in one request, which shares a single IMAP connection server-side instead of opening one per message.
- **Reading pane** — sender/recipient/subject/date header block, attachments with download, and three body views (the tab you pick is remembered in your user settings, so it survives reloads and other browsers):
  - **Text** — the clearest possible reading version. Uses the plain-text part if there is one (any stray HTML tags stripped); otherwise cleans up the HTML with [Defuddle](https://github.com/kepano/defuddle) (drops layout/boilerplate clutter — marketing email is almost all nested-table layout, which is exactly what its table-content extraction targets) and converts it to Markdown with [Turndown](https://github.com/mixmark-io/turndown). Images are dropped, boilerplate links (unsubscribe, privacy policy, view-in-browser, …) are de-linked to plain text, and invisible Unicode padding characters some templates hide preheader text in are stripped.
  - **MD** — available whenever the message has an HTML part (regardless of whether it also has a plain-text part), and always shows that HTML run through the same Defuddle + Turndown conversion as Text — unlike Text, it never falls back to the raw plain-text part instead.
  - Text and MD are both rendered via `RenderPureMarkdown` (`src/components/mail/RenderPureMarkdown.tsx`), a non-editable component built on [markdown-it](https://github.com/markdown-it/markdown-it) with custom renderer rules — real HTML, not a disabled editor, styled to look the same as the [TinyMDE](https://github.com/jefago/tiny-markdown-editor) compose editor below (shared CSS in `tinyMarkdownEditor.css`): inline-formatted (bold, headers, lists, de-emphasized `*`/`#`/`[]` markup) rather than a raw monospace dump.
  - **Plain text** — the literal MIME plain-text part, verbatim and unformatted (unlike Text/MD, this one is never treated as markdown).
  - **Safe HTML** (default for HTML mail) — scripts/embeds always stripped; remote images and CSS backgrounds are blocked until you click "Show images"; known tracking query params (`utm_*`, `fbclid`, `gclid`, …) are stripped from http(s) link hrefs.
  - **Full HTML** — shows the message as sent, remote content and links untouched. Scripts are still never executed (see below).
  - Both HTML views render inside a sandboxed `<iframe>` (no `allow-scripts`) as a defense-in-depth layer independent of the HTML sanitizer.
- **Compose** — new/reply/forward, file attachments, save draft or send. The body field is [TinyMDE](https://github.com/jefago/tiny-markdown-editor) (no command bar — just inline markdown formatting as you type), still saved/sent as plain text markdown, restyled to look like plain markdown rather than a color-coded/WYSIWYG editor (`src/components/mail/tinyMarkdownEditor.css`, adapted from [bucketnotes](https://github.com/pstaender/bucketnotes/blob/main/src/tinyMarkdownEditor.css)). New/reply/forward compositions get the account's `signature` (Account settings → Signature) appended to the body automatically; continuing to edit an existing draft doesn't re-append it. The From header uses the account's `senderName` as the display name when set, instead of the bare address. A draft opened in the reading pane shows an "Edit draft" button (top right of the toolbar); double-clicking a draft in the message list does the same. Either way, saving updates that same draft in place instead of creating a duplicate, and its existing attachments are shown with a remove button. To, Cc and Bcc (behind the "Cc/Bcc" link) autocomplete as you type — see "Recipient autocomplete" below. Each attached file (new or already on the draft) shows its size in MB next to the filename. Sending shows an "E-Mail sent" toast, distinct from "Saved" for a plain draft save.
- **Search** — the box in the header searches subjects across *every* account you own at once (not just the selected one). Selecting a result switches the sidebar/reading pane to that message's account and folder without losing your place in the results. `Cmd`/`Ctrl`+`K` focuses the search box from anywhere on the page. See [Search syntax](#search-syntax).

Sync is now two-way. Marking a message read/unread, moving it, or deleting it pushes that change to the account's IMAP server (flag add/remove, MOVE, and either a soft-delete-to-Trash or a real EXPUNGE — see below), unless the account is marked read-only or the message has no IMAP UID yet (a draft that was never synced), in which case it stays local-only exactly as before. The push happens before the local database is updated, so a failed push (bad connection, server rejects the write) leaves local state untouched and surfaces an error in the UI, which rolls back its optimistic update. The other direction runs on every sync ("Sync now" or the API's `/downloads`): for messages already synced into that folder, flag changes made by another IMAP client are pulled down, and a message no longer present in the folder on the server (deleted, expunged, or moved away by another client) is removed locally too.

**Delete** defaults to a soft delete — moving the message to the account's Trash folder — instead of a permanent expunge, but only once the account's server is confirmed to support the UIDPLUS extension (check via "Account settings" → "Check server capabilities"; without UIDPLUS, the underlying move's fallback path can end up expunging *other* unrelated deleted messages too, so it's not offered until that's ruled out). An account's `skipSoftDelete` setting opts back into always deleting permanently, even when soft-delete is available. Deleting something already in Trash is always permanent.

**Sending** now also APPENDs a copy of the sent message into the account's IMAP Sent folder (unless the account is read-only), using the exact same raw MIME bytes that were sent over SMTP. This is best-effort: SMTP delivery has already irrevocably happened by that point, so a failed APPEND (bad connection, ...) doesn't fail the send — it just means that message won't show up in Sent from other IMAP clients/webmail for this account.

Drafts, Sent, and Trash are resolved by IMAP special-use flag (`\Drafts`/`\Sent`/`\Trash`), not by an assumed English folder name — plenty of servers name them differently (e.g. `Entwürfe` for Drafts on a German-locale mailbox), and imapflow generally still recognizes those via SPECIAL-USE/XLIST or a name-based guess even when the server doesn't advertise the extension. If the account genuinely has no server-side folder for one of these at all (e.g. a fresh minimal IMAP account with no Drafts folder), the app falls back to a local-only bucket named "Drafts"/"Sent"/"Trash" — still saved and still shown in the sidebar (synthesized alongside the real IMAP folders), just never pushed to the server under that name.

A couple of things still worth knowing about: sync (pulling new messages, and reconciling existing ones) only runs when you trigger it (no background scheduler, despite `downloadIntervalSeconds` existing in settings); and two-way reconciliation is scoped to whichever single folder you sync (currently always INBOX from the sidebar's "Sync now" button) — it doesn't sweep every folder on each sync.

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
- `POST /api/accounts/:email/imap-capabilities` — connects and re-checks/caches whether the server supports UIDPLUS (gates soft-delete)
- `GET /api/accounts/:email/folders` — live IMAP folder list, merged with local message counts
- `GET/POST /api/accounts/:email/emails`, `GET/PATCH/DELETE /api/accounts/:email/emails/:id`
- `PATCH/DELETE /api/accounts/:email/emails/bulk`, `PATCH /api/accounts/:email/emails/bulk/move/:folderName` — same as the single-message versions, but for `{ ids: number[] }` in one request/connection
- `POST /api/accounts/:email/emails/:id/send`
- `PATCH /api/accounts/:email/emails/:id/move/:folderName`
- `POST/GET/DELETE /api/accounts/:email/emails/:id/attachments[/:attachmentId]`
- `GET /api/accounts/:email/contacts?q=<prefix>&limit=8` — recipient autocomplete (see below).
- `GET /api/accounts/:email/emails?folder=&limit=&offset=` — message list. Rows are lean: no HTML body or raw headers, and `plainText` is only the first 200 characters (a snippet); fetch `GET .../emails/:id` for the full message. Served straight from the `(account_id, folder, date, id)` index, so paging through thousands of messages stays in the low milliseconds.
- `GET/POST /api/accounts/:email/downloads`, `GET /api/accounts/:email/downloads/:id` — the sync job queue; only one active job per account at a time. Jobs run in-process, so on server startup any job still pending/running (orphaned by a killed server) is marked `failed` ("Interrupted by server restart"), freeing the account to sync again. While a sync downloads, the job's `progressCurrent` counts messages downloaded so far (`progressTotal` is an estimate: folder size minus what's already stored); once storing begins, both are reset to the exact count and `progressCurrent` counts messages stored. Sync errors are also shown as toasts in the UI. The server console narrates each sync (`[sync …]` lines: connection target, reconcile/fetch stages, message counts, timing) and on failure logs the stage it died in plus IMAP details (error code, server response text) — the same text is stored as the job's `error`.
- `GET /api/settings`, `PATCH /api/settings` — per-user preferences stored server-side (`users.settings`, JSON; a key set to `null` is removed). Currently `bodyView` (`text`/`md`/`plain`/`safe`/`full`), the reading-pane tab last picked.
- `GET /api/unified/inbox`, `GET /api/unified/sent` (`?limit=&offset=`) — newest-first messages across all of the caller's accounts' Inboxes / Sent folders, as the same rows search returns (Sent rows also carry `to`). Each account is read straight off the folder index and the results merged, so it stays fast on large mailboxes. An account's Sent folder is whatever the server reported as `\Sent` (learned whenever its folder list is fetched or a message is sent, kept in `accounts.sent_folder`), falling back to common names (`Sent`, `Sent Items`, `Gesendet`, …).
- `PATCH /api/accounts/:email` also takes `position` (1-based place in the account list; the others shift, positions stay gap-free 1..n).
- `GET /api/search?q=...` — searches across every account the caller owns; see [Search syntax](#search-syntax).

An email account's IMAP/SMTP passwords are encrypted at rest with a key derived from the owning user's login password (scrypt + AES-256-GCM). The derived key lives only in server memory for the lifetime of the session — restarting the server means logging in again before account credentials can be decrypted (e.g. to sync or send).

Accounts also have a `readOnly` flag (editable via "Account settings" in the sidebar, or `readOnly: true/false` in the account create/update body). When set, mark-as-read/unread, move, delete, and the sent-copy APPEND all stay local-only — nothing described above is ever pushed to the account's IMAP server.

A `skipSoftDelete` flag (same place, or `skipSoftDelete: true/false`) opts an account out of the default soft-delete-to-Trash behavior, always expunging permanently instead — see "Delete" above. A `supportsUidPlus` field (`true`/`false`/`null` for "never checked") reports the account's cached UIDPLUS capability, refreshed via "Check server capabilities" or `POST .../imap-capabilities`; it's automatically invalidated (reset to `null`) whenever the account's IMAP host/port/TLS/username/password changes, since a cached answer only applies to the server it was checked against.

`senderName` and `signature` (editable via "Account settings" → "Signature", or the same-named fields in the account create/update body) control the From display name and an optional markdown signature appended to new/reply/forward compositions — see "Compose" above. Both default to `null`/unset.

## Search syntax

Always case-insensitive; searches every account you own. A bare word matches if it's found in the subject **or** the sender (address or display name) — so `amazon gutscheine fahrrad` behaves like "sender has amazon, subject has gutscheine, subject has fahrrad" whenever that's how the words actually show up, even though the rule is really just "each word matches subject-or-sender", ANDed together.

- `amazon gutschein` — matches (subject-or-sender has "amazon") **and** (subject-or-sender has "gutschein"), independently, in any order.
- `amazon*gutschein` — `*` is a wildcard. Unlike the bare-word AND above, this requires "amazon" to appear *before* "gutschein" in the *same* field (anything, or nothing, in between) — e.g. matches a subject "Amazon Gutschein für dich", not just something starting with amazon and ending with gutschein.
- `"Mountain Bike"` — quote a phrase to require it verbatim (as one contiguous phrase) instead of splitting it into independent AND'd words.
- `from:someone@example.com` — a dedicated, sender-only filter (never checks the subject), combinable with other terms, e.g. `from:someone@example.com amazon*gutschein`. Multiple `from:` terms are OR'd together.
- `favs` — as the **first word only**, restricts the search to flagged (starred) messages; the rest of the query filters as usual, so `favs amazon` = favorites matching "amazon" and a lone `favs` lists all favorites. Anywhere else, or quoted (`"favs"`), it's an ordinary search word.

Implemented in `src/server/models/search.ts`; matching runs in JS (not SQL `LIKE`) so Unicode case-folding (e.g. `ä`/`Ä`) works correctly — stock SQLite's `LIKE`/`LOWER()` are ASCII-only without the ICU extension.

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

## Recipient autocomplete

Each account keeps a `contacts` table (address, latest display name, and how often that address appeared as a sender, as a Cc, and as a recipient of your own mail), updated whenever a message is stored (sync, or a draft being sent). Databases that predate it are backfilled once at startup. `GET /api/accounts/:email/contacts?q=…` returns addresses that start with `q`, or whose display name has a word starting with it, ranked: people who have written to you first, then people Cc'd on your mail, then everyone else (e.g. people you've only sent to) — within each group by frequency, then recency. Your own address is never suggested and drafts don't count until sent. The lookup is a primary-key range scan (a few ms at 20k contacts); the UI debounces it, cancels superseded requests, and caches results per prefix.
