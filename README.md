# P.S.Mail
### A minimal, markdown-first webmail client

Uses react/shadcn UI + Bun API server (IMAP/SMTP sync, sqlite storage, CLI).

<img width="2700" height="2058" alt="desktop-frame-export" src="https://github.com/user-attachments/assets/4d790bd2-04dd-4808-85f6-0ff9994fe261" />


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

The app opens on the combined Inbox (all accounts' Inboxes) with every account collapsed in the sidebar (nothing is selected yet, and a collapsed account's folders aren't even fetched); expand an account and pick a folder to see its mail. A sync that was already running when the page loads (started in an earlier visit, another tab, or another browser's automatic sync) is picked up from the account's job history: its spinner and progress show, and the app refreshes when it ends.

- **Login** — pick a profile (or create one) and sign in. Clicking a profile tries an empty password first — if the account has none set, that's it, no password prompt ever appears; only a profile that actually needs one falls through to asking for it. Session token is kept in `localStorage`. The header's username (top right) is hidden when it's `default`, since practically everyone's running under that out-of-the-box profile.
- **Settings** — the button next to Sign out (shows your username, or "Settings" for the default profile) opens a dialog with three tabs. **Credentials** changes your login password (current, new, confirm; leaving the new password empty is allowed and makes the profile passwordless, like the built-in default one): the saved IMAP/SMTP passwords of your accounts are encrypted with a key derived from that password, so the server re-encrypts all of them under the new password's key (with a fresh salt) in the same transaction as the new hash — everything changes or nothing does, and nothing has to be re-entered — and your other browsers/sessions are signed out because their in-memory keys no longer fit (this one keeps working). The **Inboxes** and **Notifications** tabs hold the per-user settings, stored on the server: **Sync interval (minutes)** — while the web client is open it syncs every account's **Inbox** this often (empty = never, the default; an account still busy with the previous run is skipped). Only the Inbox, to keep the periodic IMAP traffic small — all folders are synced only when you click "Sync now"; and **Show mail from folders in the combined Inbox** (off by default) — the combined Inbox and its unread badge then also cover each account's other folders, except Sent, Drafts, Trash, Junk and Archive (recognized by the server's special-use flags, learned from the live folder list, or by common names like `Papierkorb`/`Spam`).
- **New mail notifications** (Settings → *New mail notifications*, both opt-in, both stored on the server): after a sync (manual or interval) the client asks `GET /api/unified/inbox/new?afterId=…` what arrived since the last check. *Browser notification* — a desktop notification with only the sender and subject (no content, since these can show on a locked screen), or a count such as "20 new mails" with the senders when several arrive; clicking it focuses the tab and opens that message, or the combined Inbox. Enabling it asks the browser for permission (if refused, the option isn't saved). *Toast in the app* — a toast with the sender, subject, the first ~200 characters of the text, date, To and Cc (the text in monospace); clicking the toast opens the message, or the combined Inbox for "20 new mails", and it plays a sound: *Toast sound* offers `crystal_clear` (the default), `cute_bell`, `marimba` or none, with a play button to try them (files in `src/sounds/`, bundled with the app). If both are on, both fire. Only mail that is unread, not a draft, in the combined Inbox's folders (see the folder option) and less than a day old counts as new — so reading it elsewhere, or the backlog of a first sync, doesn't notify. The starting point is read when the app loads, so mail that arrived while it was closed isn't announced.
- **Sidebar** — starts with a combined **Inbox** (with the unread count across all accounts' Inboxes as a badge, from `GET /api/unified/inbox/unread`) and **Sent** (every account's, newest first, paged as you scroll; the list shows the account and folder of each message, and Sent shows the recipient), then the accounts in the order set under Account settings → **Misc** → position, and their folders (read live from IMAP), with unread counts from local sync state, a per-account "Sync now" button that turns into a spinner while syncing, with the progress ("Syncing 12/340…") as its tooltip (the tree keeps showing its folders while a sync's result is picked up; nothing blanks or reloads), and "Add account". Collapsible (the panel-icon button next to "Accounts", or the button that replaces it once collapsed) and resizable by dragging its right edge; both are remembered (`localStorage`). Each account's `⋮` menu has "Remove account" and, below it, "Account settings" — a tabbed dialog: **Server** (host/port/username/TLS for both IMAP and SMTP, display name), **Safety** (the read-only flag and "always delete permanently" — see below), **Signature** (sender name and a markdown signature, see "Compose" below), and **Misc** (the account's position in the sidebar list). Passwords are optional on edit (blank = keep the current one, since the API never returns them) and required on creation.
- **Message list** — per-folder, with unread/flag indicators, a filled star on starred messages (also in search results and the combined lists, where it can be clicked to toggle just like in folder lists, and next to the subject in the reading pane), a paperclip on messages that have real (non-inline) attachments — also in search results and the combined lists — and a snippet. Resizable by dragging its right edge (remembered too). Cmd/Ctrl+click to toggle individual messages, or Shift+click to select the whole range from the last plain/Ctrl-clicked message, for bulk Mark as read/unread, Move, or Delete (with confirmation) — in a folder list and in the combined Inbox/Sent and search results alike (there the selection may span accounts: it's sent as one bulk request per account, and Move is only offered when everything selected is from one account, since folders differ per account); a plain click reads a message as usual and clears the multi-selection. Double-clicking a draft opens it for editing (see "Compose"); double-clicking anything else does nothing extra. The list loads 100 messages at a time and fetches the next page automatically when you scroll near the bottom. Bulk actions send the whole selection in one request, which shares a single IMAP connection server-side instead of opening one per message.
- **Reading pane** — a toolbar with Reply, Forward, Mark read/unread, Move and Delete; "Reply all" (to the sender and everyone else on To/Cc, minus your own address) appears next to Reply only once the pointer or keyboard focus reaches Reply, so it can't be clicked by accident. Then the sender/recipient/subject/date header block, attachments with download, and three body views (the tab you explicitly pick is remembered in your user settings, so it survives reloads and other browsers; when a message doesn't have that tab — say MD on a plain-text-only mail — it shows another one and the remembered choice stays as it was):
  - **Text** — the clearest possible reading version. Uses the plain-text part if there is one (any stray HTML tags stripped); otherwise cleans up the HTML with [Defuddle](https://github.com/kepano/defuddle) (drops layout/boilerplate clutter — marketing email is almost all nested-table layout, which is exactly what its table-content extraction targets) and converts it to Markdown with [Turndown](https://github.com/mixmark-io/turndown). Images are dropped, boilerplate links (unsubscribe, privacy policy, view-in-browser, …) are de-linked to plain text, and invisible Unicode padding characters some templates hide preheader text in are stripped.
  - **MD** — available whenever the message has an HTML part (regardless of whether it also has a plain-text part), and always shows that HTML run through the same Defuddle + Turndown conversion as Text — unlike Text, it never falls back to the raw plain-text part instead.
  - Text and MD are both rendered via `RenderPureMarkdown` (`src/components/mail/RenderPureMarkdown.tsx`), a non-editable component built on [markdown-it](https://github.com/markdown-it/markdown-it) with custom renderer rules — real HTML, not a disabled editor (links show their `[text](url)` syntax like the editor does — except a link that is just a URL, which shows only the URL), styled to look the same as the [TinyMDE](https://github.com/jefago/tiny-markdown-editor) compose editor below (shared CSS in `tinyMarkdownEditor.css`): inline-formatted (bold, headers, lists, de-emphasized `*`/`#`/`[]` markup) rather than a raw monospace dump.
  - **Plain** — the literal MIME plain-text part, verbatim and unformatted (unlike Text/MD, this one is never treated as markdown).
  - **Safe HTML** (default for HTML mail) — scripts/embeds always stripped; remote images and CSS backgrounds are blocked until you click "Show images"; known tracking query params (`utm_*`, `fbclid`, `gclid`, …) are stripped from http(s) link hrefs.
  - **HTML** — shows the message as sent, remote content and links untouched. Scripts are still never executed (see below).
  - Both HTML views render inside a sandboxed `<iframe>` (no `allow-scripts`) as a defense-in-depth layer independent of the HTML sanitizer.
- **Compose** — new/reply/forward, file attachments, save draft or send. The body field is [TinyMDE](https://github.com/jefago/tiny-markdown-editor) (no command bar — just inline markdown formatting as you type), still saved/sent as plain text markdown, restyled to look like plain markdown rather than a color-coded/WYSIWYG editor (`src/components/mail/tinyMarkdownEditor.css`, adapted from [bucketnotes](https://github.com/pstaender/bucketnotes/blob/main/src/tinyMarkdownEditor.css)). New messages get the account's `signature` (Account settings → Signature) appended to the body automatically, replies and forwards get it above the quoted original; continuing to edit an existing draft doesn't re-append it. The From header uses the account's `senderName` as the display name when set, instead of the bare address. A draft opened in the reading pane shows an "Edit draft" button (top right of the toolbar); double-clicking a draft in the message list does the same. Either way, saving updates that same draft in place instead of creating a duplicate, and its existing attachments are shown with a remove button. To, Cc and Bcc (behind the "Cc/Bcc" link) autocomplete as you type — see "Recipient autocomplete" below. Each attached file (new or already on the draft) shows its size in MB next to the filename. Sending shows an "E-Mail sent" toast, distinct from "Saved" for a plain draft save.
- **Keyboard shortcuts** (all off while a dialog is open): `↑`/`↓` show the previous/next message in the active list (folder list, search results or combined lists) and `Shift`+`↑`/`↓` extends the bulk selection — only with a mouse-type pointer (`pointer: fine`) and outside text fields and open menus; `Esc` closes the search (like its x); `Cmd`/`Ctrl`+`K` focuses the search box; `Cmd`/`Ctrl`+`A` selects every loaded message in the list on screen for bulk actions (outside text fields, where it keeps its normal meaning); `Cmd`/`Ctrl`+`R` replies to the open message instead of reloading the page (with no message open the browser's reload is untouched); `Backspace`/`Delete` deletes the open message or the bulk selection.
- **Search** — the box in the header searches subjects across *every* account you own at once (not just the selected one). Selecting a result switches the sidebar/reading pane to that message's account and folder without losing your place in the results. `Cmd`/`Ctrl`+`K` focuses the search box from anywhere on the page. See [Search syntax](#search-syntax).

Sync is now two-way. Marking a message read/unread, moving it, or deleting it pushes that change to the account's IMAP server (flag add/remove, MOVE, and either a soft-delete-to-Trash or a real EXPUNGE — see below), unless the account is marked read-only or the message has no IMAP UID yet (a draft that was never synced), in which case it stays local-only exactly as before. The push happens before the local database is updated, so a failed push (bad connection, server rejects the write) leaves local state untouched and surfaces an error in the UI, which rolls back its optimistic update. The other direction runs on every sync ("Sync now" or the API's `/downloads`): for messages already synced into that folder, flag changes made by another IMAP client are pulled down, and a message no longer present in the folder on the server (deleted, expunged, or moved away by another client) is removed locally too.

**Delete** defaults to a soft delete — moving the message to the account's Trash folder — instead of a permanent expunge, but only once the account's server is confirmed to support the UIDPLUS extension (check via "Account settings" → "Check server capabilities"; without UIDPLUS, the underlying move's fallback path can end up expunging *other* unrelated deleted messages too, so it's not offered until that's ruled out). An account's `skipSoftDelete` setting opts back into always deleting permanently, even when soft-delete is available. Deleting something already in Trash is always permanent.

**Sending** now also APPENDs a copy of the sent message into the account's IMAP Sent folder (unless the account is read-only), using the exact same raw MIME bytes that were sent over SMTP. This is best-effort: SMTP delivery has already irrevocably happened by that point, so a failed APPEND (bad connection, ...) doesn't fail the send — it just means that message won't show up in Sent from other IMAP clients/webmail for this account.

Drafts, Sent, and Trash are resolved by IMAP special-use flag (`\Drafts`/`\Sent`/`\Trash`), not by an assumed English folder name — plenty of servers name them differently (e.g. `Entwürfe` for Drafts on a German-locale mailbox), and imapflow generally still recognizes those via SPECIAL-USE/XLIST or a name-based guess even when the server doesn't advertise the extension. If the account genuinely has no server-side folder for one of these at all (e.g. a fresh minimal IMAP account with no Drafts folder), the app falls back to a local-only bucket named "Drafts"/"Sent"/"Trash" — still saved and still shown in the sidebar (synthesized alongside the real IMAP folders), just never pushed to the server under that name.

A couple of things still worth knowing about: sync (pulling new messages, and reconciling existing ones) only runs when you trigger it (there is no server-side scheduler: the web client can trigger syncs itself on an interval — see the **Settings** dialog below — and the old, never-used `downloadIntervalSeconds` key in `settings.json` is gone; if your file still has it, it's ignored); and each folder is reconciled as part of syncing it. "Sync now" (and a `/downloads` POST without a `folder`) syncs **every folder** of the account — Inbox first, then the rest, each incrementally by UID. Unselectable containers (`\Noselect`) and Gmail-style virtual `\All`/`\Flagged` views are skipped, since they'd only duplicate mail. A folder that fails doesn't stop the others; the job then ends `failed`, naming the folders and errors. `progressCurrent`/`progressTotal` are cumulative across all folders. Passing a `folder` (or the CLI's `--folder`) syncs just that one.

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
  "sessionTtlSeconds": 43200
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
- `GET/POST /api/accounts/:email/downloads`, `GET /api/accounts/:email/downloads/:id` — the sync job queue; only one active job per account at a time; the optional `folder` body field limits it to a single folder, otherwise every folder is synced. Jobs run in-process, so on server startup any job still pending/running (orphaned by a killed server) is marked `failed` ("Interrupted by server restart"), freeing the account to sync again. While a sync downloads, the job's `progressCurrent` counts messages downloaded so far (`progressTotal` is an estimate: folder size minus what's already stored); once storing begins, both are reset to the exact count and `progressCurrent` counts messages stored. Sync errors are also shown as toasts in the UI. The server console narrates each sync (`[sync …]` lines: connection target, reconcile/fetch stages, message counts, timing) and on failure logs the stage it died in plus IMAP details (error code, server response text) — the same text is stored as the job's `error`.
- `POST /api/auth/change-password` `{ currentPassword, newPassword }` — changes the signed-in user's password: verifies the current one, re-encrypts every account's saved IMAP/SMTP password with the key for the new password and a fresh salt (atomically with the new hash; if some account's secrets can't be decrypted it refuses and changes nothing), gives the current session the new key and ends the user's other sessions (`{ ok, otherSessionsSignedOut }`). `PATCH /api/users/:id` `{ password, currentPassword }` does the same; it used to swap the hash alone, which would have left the saved account passwords undecryptable.
- `GET /api/settings`, `PATCH /api/settings` — per-user preferences stored server-side (`users.settings`, JSON; a key set to `null` is removed): `bodyView` (`text`/`md`/`plain`/`safe`/`full`, the reading-pane tab last picked), `syncIntervalMinutes` (whole minutes 1–1440; unset = never) and `combinedInboxIncludesFolders` (boolean, default off). Edited in the web client's Settings dialog.
- `GET /api/unified/inbox/new?afterId=` — unread mail that arrived in the combined Inbox after an email id (`{ latestId, total, messages: [...newest few, with sender/recipients/subject/date/snippet] }`); without `afterId` it only returns the current `latestId` to start from. Also new user settings `notifyBrowser`, `notifyToast` (booleans) and `notificationSound` (`crystal_clear`, `cute_bell`, `marimba`, `none`).
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

bun run cli sync me@example.com --user <username> [--folder <name>]   # default: every folder
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

**Forgiving matching.** Names are compared word by word with punctuation and case ignored (letters and digits of any script), so a contact stored as `'First Lastname' <flastname@example.com>` is found by `First`, `'First`, `last first` or `first-last`; every word typed has to be the *start* of some word of the name, or the address has to start with what was typed. Quotes some mail programs wrap around display names are stripped when contacts are stored (and existing contacts are tidied once at startup).

**Other accounts.** `GET /api/accounts/:email/contacts?q=…&scope=all` appends matches from the user's *other* accounts after this account's own (up to 5, ranked the same way, an address known to several accounts appears once with its counts added up, never an address this account already has); those items carry `other: true`, and the recipient fields (which always ask for `scope=all`) list them under a "From your other accounts" heading, so this account's people always come first and you never have to switch or click anything to reach the rest. Without `scope=all` only this account is searched.

## Deleting in read-only accounts

A read-only account never tells the IMAP server about a delete (or move), so the server keeps the message. To stop the next sync from downloading it again, the message's UID is remembered in the `deleted_uids` table (account, folder, UID) while the message row itself — body, headers, attachments — is really deleted. The sync skips tombstoned UIDs and counts them in its "newer than" watermark (deleting the newest message would otherwise make it look new again), and drops a tombstone once the server itself no longer has that UID. A local-only move works the same for the old folder's UID, and the moved row becomes a local-only message (no server UID, since the old one belonged to the old folder).
