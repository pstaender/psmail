import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../../src/App";
import { MessageHeader } from "../../src/components/mail/MessageHeader";
import type { Account } from "../../src/server/types";

/**
 * Headless render smoke test: mounts the real <App/> tree against a mocked
 * fetch (no real backend), exercising login -> account tree -> message list
 * -> reading pane end to end. This is a substitute for manual browser
 * clicking in an environment with no browser available â€” it won't catch
 * visual/CSS issues, but it does catch render-time crashes and broken
 * data wiring across the whole component tree.
 */

const NOW = "2024-01-01T10:00:00.000Z";

const USER = { id: 1, username: "default", authMethod: "password", createdAt: NOW, updatedAt: NOW };
const ACCOUNT: Account = {
  id: 1,
  userId: 1,
  email: "me@example.com",
  displayName: null,
  imapHost: "imap.example.com",
  imapPort: 993,
  imapSecure: true,
  imapUsername: "me@example.com",
  smtpHost: "smtp.example.com",
  smtpPort: 465,
  smtpSecure: true,
  smtpUsername: "me@example.com",
  readOnly: false,
  skipSoftDelete: false,
  supportsUidPlus: null,
  senderName: null,
  signature: null,
  position: 1,
  createdAt: NOW,
  updatedAt: NOW,
};
const FOLDERS = [
  { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", flags: [], total: 1, unread: 1 },
  // Named "Entwürfe" (German), not "Drafts" — this account's Drafts folder isn't literally
  // named "Drafts" on the server, exercising the specialUse-based lookup in ComposeDialog.
  { path: "Entwürfe", name: "Entwürfe", delimiter: "/", specialUse: "\\Drafts", flags: [], total: 0, unread: 0 },
];
const EMAIL = {
  id: 10,
  accountId: 1,
  folder: "INBOX",
  uid: 1,
  isDraft: false,
  isRead: false,
  isFlagged: false,
  messageId: "<1@example.com>",
  inReplyTo: null,
  from: [{ name: "Alice", address: "alice@example.com" }],
  to: [{ address: "me@example.com" }],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: "Hello there",
  date: NOW,
  returnPath: null,
  received: [],
  mimeVersion: "1.0",
  contentType: "text/plain",
  authenticationResults: null,
  dkim: null,
  spf: null,
  plainText: "Hi from Alice",
  htmlText: "<p>Hi <b>from</b> Alice</p>",
  headersRaw: "",
  size: 100,
  createdAt: NOW,
  updatedAt: NOW,
  attachments: [],
};

const SECOND_EMAIL = {
  ...EMAIL,
  id: 11,
  uid: 2,
  subject: "Second message",
  from: [{ name: "Bob", address: "bob@example.com" }],
  plainText: "Hi from Bob",
  htmlText: "<p>Hi <b>from</b> Bob</p>",
  attachmentCount: 1,
};

const THIRD_EMAIL = {
  ...EMAIL,
  id: 12,
  uid: 3,
  subject: "Third message",
  from: [{ name: "Carol", address: "carol@example.com" }],
  plainText: "Hi from Carol",
  htmlText: "<p>Hi <b>from</b> Carol</p>",
};

const DRAFT_EMAIL = {
  ...EMAIL,
  id: 13,
  uid: null,
  isDraft: true,
  isRead: true, // avoid tripping the mark-as-read-on-open effect in tests unrelated to that
  folder: "Drafts",
  subject: "Unfinished draft",
  to: [{ address: "someone@example.com" }],
  plainText: "Getting there...",
  htmlText: null,
};

const SYNC_JOB = (status: string) => ({
  id: 1, accountId: 1, folder: null, status, progressCurrent: 0, progressTotal: 0, error: null, startedAt: NOW, finishedAt: null, createdAt: NOW,
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const originalFetch = global.fetch;

// Captures the body of the most recent POST .../emails (create draft) call, for tests that
// need to inspect what folder a saved draft was actually sent under — reset per installMockFetch
// call (mirrors currentAccount's per-test freshness, just below).
let capturedCreateDraftBody: Record<string, unknown> | null = null;
// Same, for PATCH .../emails/13 (DRAFT_EMAIL) — asserts that editing an existing draft updates
// it in place instead of creating a new one.
let capturedUpdateDraftBody: Record<string, unknown> | null = null;
// Every limit/offset the paged-emails mock (pagedEmailCount) was asked for, in order.
const pagedRequests: { limit: number; offset: number }[] = [];
// Bodies of every PATCH /api/settings and of the last PATCH /api/accounts/:email.
const capturedSettingsPatches: Record<string, unknown>[] = [];
let capturedAccountPatch: Record<string, unknown> | null = null;
// Bodies of POST .../downloads (sync) calls, and how often the folder list / unread count were fetched.
const downloadPosts: Record<string, unknown>[] = [];
let folderRequests = 0;
let unreadRequests = 0;
// Artificial latency for GET .../folders — lets a test look at the tree *while* a refresh is in flight.
let folderDelayMs = 0;

function installMockFetch(
  opts: {
    failEmailPatch?: number;
    uidPlusSupported?: boolean;
    accountOverrides?: Partial<Account>;
    extraUsers?: { id: number; username: string }[];
    /** When set, GET .../emails serves this many generated INBOX messages, honoring limit/offset like the real API. */
    pagedEmailCount?: number;
    /** The server-side user settings GET /api/settings starts out with. */
    settings?: { bodyView?: string; syncIntervalMinutes?: number; combinedInboxIncludesFolders?: boolean };
    /** What GET /api/unified/inbox/unread reports (the combined Inbox's badge). */
    inboxUnread?: number;
  } = {}
) {
  // A fresh mutable copy per test (installMockFetch runs in beforeEach), so a PATCH in one
  // test can't leak into another, and so GET /api/accounts reflects a prior PATCH within a test.
  let currentAccount = { ...ACCOUNT, ...opts.accountOverrides };
  capturedCreateDraftBody = null;
  capturedUpdateDraftBody = null;
  pagedRequests.length = 0;
  capturedSettingsPatches.length = 0;
  capturedAccountPatch = null;
  downloadPosts.length = 0;
  folderRequests = 0;
  unreadRequests = 0;
  folderDelayMs = 0;
  let currentSettings: Record<string, unknown> = { ...opts.settings };

  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const path = url.split("?")[0]!;

    // Simulates a failed IMAP push (e.g. the real backend's write to the mail server
    // failing) for one specific email id, to test the frontend's rollback-on-failure path.
    if (
      opts.failEmailPatch !== undefined &&
      method === "PATCH" &&
      path === `/api/accounts/me%40example.com/emails/${opts.failEmailPatch}`
    ) {
      return jsonResponse({ error: "simulated IMAP failure" }, 502);
    }

    if (method === "GET" && path === "/api/users") return jsonResponse(opts.extraUsers ? [USER, ...opts.extraUsers] : [USER]);
    if (method === "POST" && path === "/api/auth/login") {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      // "secure" needs a real password; everyone else (in particular "default") logs in with
      // an empty one — for testing LoginView's "try an empty password first" behavior.
      if (body.username === "secure" && body.password !== "secret123") {
        return jsonResponse({ error: "Invalid credentials" }, 401);
      }
      return jsonResponse({ token: "test-token", expiresAt: NOW, user: { id: 1, username: body.username } });
    }
    if (method === "GET" && path === "/api/accounts") return jsonResponse([currentAccount]);
    if (method === "PATCH" && path === "/api/accounts/me%40example.com") {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      capturedAccountPatch = body;
      currentAccount = { ...currentAccount, ...body };
      return jsonResponse(currentAccount);
    }
    if (method === "POST" && path === "/api/accounts/me%40example.com/imap-capabilities") {
      currentAccount = { ...currentAccount, supportsUidPlus: opts.uidPlusSupported ?? true };
      return jsonResponse(currentAccount);
    }
    if (method === "GET" && path === "/api/accounts/me%40example.com/folders") {
      folderRequests += 1;
      if (folderDelayMs > 0) await new Promise(resolve => setTimeout(resolve, folderDelayMs));
      return jsonResponse(FOLDERS);
    }
    if (method === "POST" && path === "/api/accounts/me%40example.com/downloads") {
      downloadPosts.push(init?.body ? JSON.parse(init.body as string) : {});
      return jsonResponse(SYNC_JOB("running"), 202);
    }
    if (method === "GET" && path === "/api/accounts/me%40example.com/downloads/1") return jsonResponse(SYNC_JOB("completed"));
    if (method === "GET" && path === "/api/unified/inbox/unread") {
      unreadRequests += 1;
      return jsonResponse({ count: opts.inboxUnread ?? 0 });
    }
    if (method === "GET" && path === "/api/accounts/me%40example.com/emails") {
      if (opts.pagedEmailCount !== undefined) {
        const params = new URL(url, "http://localhost").searchParams;
        const limit = Number(params.get("limit") ?? 50);
        const offset = Number(params.get("offset") ?? 0);
        const all = Array.from({ length: opts.pagedEmailCount }, (_, i) => ({
          ...EMAIL,
          id: 1000 + i,
          uid: 1000 + i,
          isRead: true,
          subject: `Generated ${i}`,
        }));
        pagedRequests.push({ limit, offset });
        return jsonResponse(all.slice(offset, offset + limit));
      }
      return jsonResponse([EMAIL, SECOND_EMAIL, THIRD_EMAIL, DRAFT_EMAIL]);
    }
    if (method === "GET" && path === "/api/settings") return jsonResponse(currentSettings);
    if (method === "PATCH" && path === "/api/settings") {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      capturedSettingsPatches.push(body);
      currentSettings = { ...currentSettings, ...body };
      return jsonResponse(currentSettings);
    }
    if (method === "GET" && path === "/api/unified/inbox") {
      return jsonResponse([
        {
          id: 10, accountEmail: "me@example.com", folder: "INBOX", uid: 1, isRead: true, isFlagged: true,
          subject: "Unified hello", from: [{ name: "Alice", address: "alice@example.com" }], date: NOW,
        },
      ]);
    }
    if (method === "GET" && path === "/api/unified/sent") {
      return jsonResponse([
        {
          id: 20, accountEmail: "me@example.com", folder: "Sent", uid: 5, isRead: true, isFlagged: false,
          subject: "Unified outgoing", from: [{ address: "me@example.com" }], to: [{ name: "Zed Zebra", address: "zed@example.com" }], date: NOW,
        },
      ]);
    }
    if (method === "GET" && path === "/api/accounts/me%40example.com/contacts") {
      const q = (new URL(url, "http://localhost").searchParams.get("q") ?? "").toLowerCase();
      return jsonResponse(
        [
          { address: "alice@example.com", name: "Alice Anderson", fromCount: 3, ccCount: 0, sentCount: 1, lastUsed: NOW },
          { address: "albert@example.com", name: "", fromCount: 0, ccCount: 1, sentCount: 0, lastUsed: NOW },
        ].filter(c => c.address.startsWith(q))
      );
    }
    if (method === "POST" && path === "/api/accounts/me%40example.com/emails") {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      capturedCreateDraftBody = body;
      return jsonResponse({ ...EMAIL, id: 999, isDraft: true, uid: null, ...body }, 201);
    }
    if (method === "POST" && /^\/api\/accounts\/me%40example\.com\/emails\/\d+\/send$/.test(path)) {
      return jsonResponse({ ...EMAIL, id: 999, isDraft: false, folder: "Sent" });
    }
    if (method === "GET" && path === "/api/accounts/me%40example.com/emails/10") return jsonResponse(EMAIL);
    if (method === "GET" && path === "/api/accounts/me%40example.com/emails/11") return jsonResponse(SECOND_EMAIL);
    if (method === "GET" && path === "/api/accounts/me%40example.com/emails/12") return jsonResponse(THIRD_EMAIL);
    if (method === "GET" && path === "/api/accounts/me%40example.com/emails/13") return jsonResponse(DRAFT_EMAIL);
    if (method === "PATCH" && path === "/api/accounts/me%40example.com/emails/10") return jsonResponse({ ...EMAIL, isRead: true });
    if (method === "PATCH" && path === "/api/accounts/me%40example.com/emails/11") return jsonResponse({ ...SECOND_EMAIL, isRead: true });
    if (method === "PATCH" && path === "/api/accounts/me%40example.com/emails/12") return jsonResponse({ ...THIRD_EMAIL, isRead: true });
    if (method === "PATCH" && path === "/api/accounts/me%40example.com/emails/13") {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      capturedUpdateDraftBody = body;
      return jsonResponse({ ...DRAFT_EMAIL, ...body });
    }
    if (method === "DELETE" && path === "/api/accounts/me%40example.com/emails/10") return jsonResponse({ softDeleted: false });
    if (method === "DELETE" && path === "/api/accounts/me%40example.com/emails/11") return jsonResponse({ softDeleted: false });
    if (method === "DELETE" && path === "/api/accounts/me%40example.com/emails/12") return jsonResponse({ softDeleted: false });

    // Bulk actions (mark-as-read/unread, delete, move) share one request for the whole
    // selection — see runBulkAction in both AppShell.tsx and server/routes/emails.ts.
    if (method === "PATCH" && path === "/api/accounts/me%40example.com/emails/bulk") {
      const body = init?.body ? JSON.parse(init.body as string) : { ids: [] };
      return jsonResponse((body.ids as number[]).map(id => ({ id, ok: true })));
    }
    if (method === "DELETE" && path === "/api/accounts/me%40example.com/emails/bulk") {
      const body = init?.body ? JSON.parse(init.body as string) : { ids: [] };
      return jsonResponse((body.ids as number[]).map(id => ({ id, ok: true, softDeleted: false })));
    }
    if (method === "PATCH" && path.startsWith("/api/accounts/me%40example.com/emails/bulk/move/")) {
      const body = init?.body ? JSON.parse(init.body as string) : { ids: [] };
      return jsonResponse((body.ids as number[]).map(id => ({ id, ok: true })));
    }
    if (method === "GET" && path === "/api/search") {
      // The mock doesn't replicate real matching (that's covered by backend tests) —
      // it just returns a canned hit so the UI wiring (fetch -> render -> select) is exercised.
      return jsonResponse([
        {
          id: SECOND_EMAIL.id,
          accountEmail: ACCOUNT.email,
          folder: SECOND_EMAIL.folder,
          uid: SECOND_EMAIL.uid,
          isRead: SECOND_EMAIL.isRead,
          isFlagged: SECOND_EMAIL.isFlagged,
          subject: SECOND_EMAIL.subject,
          from: SECOND_EMAIL.from,
          date: SECOND_EMAIL.date,
        },
      ]);
    }

    return jsonResponse({ error: `Unhandled mock route: ${method} ${path}` }, 404);
  }) as typeof fetch;
}

describe("frontend smoke test (headless render, mocked backend)", () => {
  beforeEach(() => {
    localStorage.clear();
    installMockFetch();
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
  });

  test("renders login, signs in, and opens a message end to end", async () => {
    render(<App />);

    // Login screen — clicking the profile logs straight in (an empty password works, so
    // LoginView skips the password prompt entirely), no separate "Sign in" click needed.
    await waitFor(() => expect(screen.getByText("P.S.Mail")).toBeTruthy());
    const userButton = await screen.findByText("default");
    await userEvent.click(userButton);

    // Main app shell + account tree
    await waitFor(() => expect(screen.getByText("me@example.com")).toBeTruthy(), { timeout: 3000 });
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0));

    // Message list
    const messageRow = await screen.findByText("Hello there");
    await userEvent.click(messageRow);

    // Reading pane: header, toolbar, and body tabs all rendered
    await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(0));
    expect(screen.getAllByText(/Alice/).length).toBeGreaterThan(0);
    expect(screen.getByRole("tab", { name: "Plain text" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Safe HTML" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Full HTML" })).toBeTruthy();
    expect(screen.getByText("Reply")).toBeTruthy();
    expect(screen.getByText("Delete")).toBeTruthy();

    // MD tab sits between Text and Plain text, and shows the HTML converted to Markdown.
    const tabs = screen.getAllByRole("tab").map(t => t.textContent);
    expect(tabs.indexOf("Text")).toBeLessThan(tabs.indexOf("MD"));
    expect(tabs.indexOf("MD")).toBeLessThan(tabs.indexOf("Plain text"));
    await userEvent.click(screen.getByRole("tab", { name: "MD" }));
    // Rendered via the read-only MarkdownEditor now, so "**" and "from" are separate inline
    // elements (mark + bold text) rather than one plain-text node — check the panel's overall
    // text instead of matching a single element.
    await waitFor(() => expect(screen.getByRole("tabpanel").textContent).toContain("**from**"));

    // Reply opens the compose dialog with the MarkdownEditor pre-filled with the quoted original.
    // Scoped to the dialog specifically — the reading pane behind it also has a (read-only)
    // MarkdownEditor rendering the MD tab, and that one isn't what's being checked here.
    await userEvent.click(screen.getByText("Reply"));
    const composeDialog = (await screen.findByText("New message")).closest('[role="dialog"]') as HTMLElement;
    const replyBody = composeDialog.querySelector(".psmail-markdown-editor .TinyMDE");
    expect(replyBody).toBeTruthy();
    expect(replyBody!.textContent).toContain("Hi from Alice");
    await userEvent.keyboard("{Escape}");

    // Compose dialog opens without crashing
    await userEvent.click(screen.getByRole("button", { name: /new/i }));
    expect(await screen.findByText("New message")).toBeTruthy();
    expect(screen.getByLabelText("To")).toBeTruthy();
    expect(screen.getByRole("button", { name: /send/i })).toBeTruthy();
    await userEvent.keyboard("{Escape}");

    // Add account dialog opens without crashing
    await userEvent.click(screen.getByText("Add account"));
    expect(await screen.findByText("Add email account")).toBeTruthy();
    expect(screen.getByLabelText("Email address")).toBeTruthy();
  });

  test("clicking a profile with no password set logs in directly, skipping the password prompt", async () => {
    render(<App />);

    await userEvent.click(await screen.findByText("default"));

    // No password prompt ever appeared — went straight to the app shell.
    expect(screen.queryByPlaceholderText("Password")).toBeNull();
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });
  });

  test("clicking a profile that needs a real password falls through to the password prompt", async () => {
    installMockFetch({ extraUsers: [{ id: 2, username: "secure" }] });
    render(<App />);

    await userEvent.click(await screen.findByText("secure"));

    // The silent empty-password attempt failed, so the form is shown instead of logging in.
    const passwordField = await screen.findByPlaceholderText("Password");
    expect(screen.queryByRole("button", { name: /sign in/i })).toBeTruthy();

    await userEvent.type(passwordField, "secret123");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });
  });

  test("the header hides the username when it's \"default\"", async () => {
    render(<App />);

    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    // The login screen (the only other place "default" appeared) is gone now, so if this text
    // is still absent, the header itself isn't showing the username either.
    expect(screen.queryByText("default")).toBeNull();
  });

  test("the header shows a non-default username", async () => {
    installMockFetch({ extraUsers: [{ id: 2, username: "secure" }] });
    render(<App />);

    await userEvent.click(await screen.findByText("secure"));
    await userEvent.type(await screen.findByPlaceholderText("Password"), "secret123");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    expect(screen.getByText("secure")).toBeTruthy();
  });

  test("the Text/MD reading-pane tabs render via the non-editable RenderPureMarkdown component", async () => {
    render(<App />);

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    await userEvent.click(await screen.findByText("Hello there"));
    await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(0));
    await userEvent.click(screen.getByRole("tab", { name: "Text" }));

    await waitFor(() => {
      const panel = screen.getByRole("tabpanel");
      const rendered = panel.querySelector(".psmail-markdown-render");
      expect(rendered).toBeTruthy();
      // Real static HTML from markdown-it, not TinyMDE's (disabled) editing surface.
      expect(panel.querySelector(".TinyMDE")).toBeNull();
      expect(rendered!.querySelector('[contenteditable="true"]')).toBeNull();
    });
  });

  test("saving a draft uses the account's real Drafts folder path, not a hardcoded English name", async () => {
    render(<App />);

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    await userEvent.click(screen.getByRole("button", { name: /new/i }));
    expect(await screen.findByText("New message")).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Subject"), "Draft folder check");
    await userEvent.click(screen.getByRole("button", { name: /save draft/i }));

    await waitFor(() => expect(screen.queryByText("New message")).toBeNull());
    expect(capturedCreateDraftBody?.folder).toBe("Entwürfe");
  });

  test("composing a new message appends the account's signature to the body", async () => {
    installMockFetch({ accountOverrides: { signature: "Cheers,\nAlice" } });
    render(<App />);

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    await userEvent.click(screen.getByRole("button", { name: /new/i }));
    const composeDialog = (await screen.findByText("New message")).closest('[role="dialog"]') as HTMLElement;
    const body = composeDialog.querySelector(".psmail-markdown-editor .TinyMDE");
    expect(body!.textContent).toContain("Cheers,");
  });

  test("sending uses the account's sender name as the From display name", async () => {
    installMockFetch({ accountOverrides: { senderName: "Alice Example" } });
    render(<App />);

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    await userEvent.click(screen.getByRole("button", { name: /new/i }));
    expect(await screen.findByText("New message")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /save draft/i }));

    await waitFor(() =>
      expect(capturedCreateDraftBody?.from).toEqual([{ address: "me@example.com", name: "Alice Example" }])
    );
  });

  test("sending a message shows an \"E-Mail sent\" toast, distinct from just saving a draft", async () => {
    render(<App />);

    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    await userEvent.click(screen.getByRole("button", { name: /new/i }));
    expect(await screen.findByText("New message")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(screen.getByText("E-Mail sent")).toBeTruthy());
  });

  test("adding an attachment in compose shows its filename and size in MB", async () => {
    render(<App />);

    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    await userEvent.click(screen.getByRole("button", { name: /new/i }));
    expect(await screen.findByText("New message")).toBeTruthy();

    const file = new File([new Uint8Array(2 * 1024 * 1024)], "photo.png", { type: "image/png" }); // exactly 2 MB
    await userEvent.upload(screen.getByLabelText("Attach files"), file);

    expect(await screen.findByText("photo.png")).toBeTruthy();
    expect(screen.getByText("2.00 MB")).toBeTruthy();
  });

  test("opening a draft shows an Edit draft button after Delete, and editing it updates the same draft", async () => {
    render(<App />);

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    await userEvent.click(await screen.findByText("Unfinished draft"));
    await waitFor(() => expect(screen.getAllByText("Unfinished draft").length).toBeGreaterThan(0));

    const editButton = await screen.findByRole("button", { name: /edit draft/i });
    expect(editButton.className).toContain("ml-auto");

    // Comes after Delete in the toolbar, consistent with "right-aligned, after Delete".
    const deleteButton = screen.getByRole("button", { name: /delete/i });
    expect(deleteButton.compareDocumentPosition(editButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await userEvent.click(editButton);
    expect(await screen.findByText("Edit draft", { selector: "[data-slot=dialog-title]" })).toBeTruthy();
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("Unfinished draft");

    await userEvent.click(screen.getByRole("button", { name: /save draft/i }));
    await waitFor(() => expect(screen.queryByText("Edit draft", { selector: "[data-slot=dialog-title]" })).toBeNull());

    // Updated the SAME draft (PATCH /emails/13) — not a new one (no create call happened).
    expect(capturedUpdateDraftBody?.subject).toBe("Unfinished draft");
    expect(capturedCreateDraftBody).toBeNull();
  });

  test("double-clicking a draft in the list opens it for editing directly", async () => {
    render(<App />);

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    const draftRow = await screen.findByText("Unfinished draft");
    await userEvent.dblClick(draftRow);

    expect(await screen.findByText("Edit draft", { selector: "[data-slot=dialog-title]" })).toBeTruthy();
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("Unfinished draft");
  });

  test("double-clicking a non-draft message doesn't open the compose dialog", async () => {
    render(<App />);

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    const row = await screen.findByText("Hello there");
    await userEvent.dblClick(row);

    expect(screen.queryByText("New message")).toBeNull();
    expect(screen.queryByText("Edit draft", { selector: "[data-slot=dialog-title]" })).toBeNull();
  });

  test("remembers the last body view across messages, downgrading Full HTML to Safe HTML", async () => {
    render(<App />);

    function isTabSelected(name: string): boolean {
      return screen.getByRole("tab", { name }).getAttribute("aria-selected") === "true";
    }

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    // Open the first message and switch it to Full HTML.
    await userEvent.click(await screen.findByText("Hello there"));
    await userEvent.click(await screen.findByRole("tab", { name: "Full HTML" }));
    await waitFor(() => expect(isTabSelected("Full HTML")).toBe(true));

    // Switching to the second message must not carry Full HTML over — it should land on Safe HTML.
    await userEvent.click(await screen.findByText("Second message"));
    await waitFor(() => expect(screen.getAllByText("Second message").length).toBeGreaterThan(0));
    await waitFor(() => expect(isTabSelected("Safe HTML")).toBe(true));
    expect(isTabSelected("Full HTML")).toBe(false);

    // Explicitly picking Plain text on the second message...
    await userEvent.click(screen.getByRole("tab", { name: "Plain text" }));
    await waitFor(() => expect(isTabSelected("Plain text")).toBe(true));

    // ...should be remembered when going back to the first message.
    await userEvent.click(await screen.findByText("Hello there"));
    await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(0));
    await waitFor(() => expect(isTabSelected("Plain text")).toBe(true));
  });

  test("Cmd/Ctrl+K focuses the search input from anywhere on the page", async () => {
    render(<App />);

    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    const searchBox = screen.getByPlaceholderText(/search all mail/i);
    // Focus something else first, so the shortcut moving focus is actually observable.
    (document.body as HTMLElement).focus();
    expect(document.activeElement).not.toBe(searchBox);

    await userEvent.keyboard("{Control>}k{/Control}");
    expect(document.activeElement).toBe(searchBox);
  });

  test("searching switches the message list to results and opening one reads it", async () => {
    render(<App />);

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    const searchBox = screen.getByPlaceholderText(/search all mail/i);
    await userEvent.type(searchBox, "second");

    // Debounced, so this only resolves once the (mocked) search actually ran.
    await waitFor(() => expect(screen.getByText(/Search: "second"/)).toBeTruthy(), { timeout: 2000 });
    await waitFor(() => expect(screen.getAllByText("Second message").length).toBeGreaterThan(0), { timeout: 2000 });

    const resultRow = screen.getByText("Second message").closest("li")!;
    expect(resultRow.querySelector(".bg-primary")).toBeTruthy(); // unread dot

    // Opening the result reads it, same as opening any other message — and (the bug this
    // guards against) must update the result row in the still-visible search list too, not
    // just the folder-scoped list that isn't even being shown right now.
    await userEvent.click(within(resultRow).getByText("Second message"));
    await waitFor(() => expect(screen.getAllByText(/Bob/).length).toBeGreaterThan(0));
    await waitFor(() => {
      // "Second message" now also appears as the reading pane's heading, so scope back down
      // to the search-result row (the <li>) specifically.
      const row = screen.getAllByText("Second message").map(el => el.closest("li")).find(Boolean)!;
      expect(row.querySelector(".bg-primary")).toBeNull();
    });

    // Clearing the search returns to the normal folder view without losing the reading pane.
    await userEvent.click(screen.getByTitle("Clear search"));
    await waitFor(() => expect(screen.queryByText(/Search:/)).toBeNull());
    expect(screen.getAllByText("Second message").length).toBeGreaterThan(0);
  });

  test("Ctrl/Cmd+click multi-selects messages for bulk mark-as-read and delete", async () => {
    render(<App />);

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    const firstRow = await screen.findByText("Hello there");
    const secondRow = await screen.findByText("Second message");

    // Ctrl+click toggles selection without opening either message in the reading pane.
    fireEvent.click(firstRow, { ctrlKey: true });
    await waitFor(() => expect(screen.getByText("1 selected")).toBeTruthy());
    expect(screen.getByText("Select a message")).toBeTruthy();

    fireEvent.click(secondRow, { ctrlKey: true });
    await waitFor(() => expect(screen.getByText("2 selected")).toBeTruthy());

    // Ctrl+click again deselects it.
    fireEvent.click(secondRow, { ctrlKey: true });
    await waitFor(() => expect(screen.getByText("1 selected")).toBeTruthy());
    fireEvent.click(secondRow, { ctrlKey: true });
    await waitFor(() => expect(screen.getByText("2 selected")).toBeTruthy());

    // Bulk mark-as-read clears the selection once done.
    await userEvent.click(screen.getByTitle("Mark as read"));
    await waitFor(() => expect(screen.queryByText(/selected/)).toBeNull());

    // Re-select both and bulk-delete them, with confirmation.
    fireEvent.click(await screen.findByText("Hello there"), { ctrlKey: true });
    fireEvent.click(screen.getByText("Second message"), { ctrlKey: true });
    await waitFor(() => expect(screen.getByText("2 selected")).toBeTruthy());

    await userEvent.click(screen.getByTitle("Delete"));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByText("Hello there")).toBeNull());
    expect(screen.queryByText("Second message")).toBeNull();
  });

  test("bulk-deleting skips the confirmation dialog when every selected message would only be soft-deleted", async () => {
    // supportsUidPlus: true (and the fixture emails are all non-draft, non-readonly, outside
    // Trash) means Delete would just move them to Trash — safely undoable, so no need to ask.
    installMockFetch({ accountOverrides: { supportsUidPlus: true } });
    render(<App />);

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    fireEvent.click(await screen.findByText("Third message"), { ctrlKey: true });
    await waitFor(() => expect(screen.getByText("1 selected")).toBeTruthy());

    await userEvent.click(screen.getByTitle("Delete"));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(screen.queryByText("Third message")).toBeNull());
  });

  test("bulk-deleting asks for confirmation when it would be permanent, regardless of selection size", async () => {
    // The default fixture has supportsUidPlus: null (never checked), so Delete always expunges
    // permanently — that's irreversible, so it's always confirmed first, even for just one.
    render(<App />);

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    fireEvent.click(await screen.findByText("Third message"), { ctrlKey: true });
    await waitFor(() => expect(screen.getByText("1 selected")).toBeTruthy());

    await userEvent.click(screen.getByTitle("Delete"));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/delete/i, { selector: "[data-slot=alert-dialog-title]" })).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByText("Third message")).toBeNull());
  });

  test("pressing Delete on an open message deletes it directly when soft-delete is active", async () => {
    installMockFetch({ accountOverrides: { supportsUidPlus: true } });
    render(<App />);

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    await userEvent.click(await screen.findByText("Third message"));
    await waitFor(() => expect(screen.getAllByText("Third message").length).toBeGreaterThan(0));

    await userEvent.keyboard("{Delete}");

    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(screen.queryByText("Third message")).toBeNull());
  });

  test("pressing Backspace while typing in the search box never deletes the open message", async () => {
    installMockFetch({ accountOverrides: { supportsUidPlus: true } });
    render(<App />);

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    await userEvent.click(await screen.findByText("Third message"));
    await waitFor(() => expect(screen.getAllByText("Third message").length).toBeGreaterThan(0));

    const searchBox = screen.getByPlaceholderText(/search all mail/i);
    await userEvent.click(searchBox);
    await userEvent.keyboard("{Backspace}");

    // Give an incorrect delete a moment to happen, then confirm it didn't.
    await waitFor(() => expect(screen.getAllByText("Third message").length).toBeGreaterThan(0));
  });

  test("a failed IMAP push rolls back the optimistic flag toggle and shows an error", async () => {
    // Overrides the default beforeEach mock so this one email's PATCH simulates a failed
    // IMAP write (e.g. the account isn't read-only but the mail server rejected/dropped it).
    installMockFetch({ failEmailPatch: SECOND_EMAIL.id });
    render(<App />);

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    // Toggle the star directly from the message list, without opening the message — opening
    // it would fire its own (non-rolling-back) mark-as-read PATCH first and muddy the test.
    const secondRow = (await screen.findByText("Second message")).closest("li")!;
    const starToggle = secondRow.querySelector('[role="button"]') as HTMLElement;
    expect(starToggle).toBeTruthy();

    fireEvent.click(starToggle);

    // Optimistic update applies immediately...
    await waitFor(() => expect(secondRow.querySelector("svg.fill-yellow-400")).toBeTruthy());

    // ...then rolls back once the (mocked) IMAP push fails, with the failure surfaced. The
    // toast shows the server's own error message (from the mocked 502 body), not a fallback.
    await waitFor(() => expect(screen.getByText("simulated IMAP failure")).toBeTruthy());
    await waitFor(() => expect(secondRow.querySelector("svg.fill-yellow-400")).toBeNull());
  });

  test("Shift+click selects a range of messages, anchored at the last plain/Ctrl click", async () => {
    render(<App />);

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    const firstRow = await screen.findByText("Hello there");
    const secondRow = await screen.findByText("Second message");
    const thirdRow = await screen.findByText("Third message");

    // Plain click sets the anchor (and opens the message) without entering multi-select.
    await userEvent.click(firstRow);
    await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(0));
    expect(screen.queryByText(/selected/)).toBeNull();

    // Shift+click the third message selects the whole range: first, second, and third.
    fireEvent.click(thirdRow, { shiftKey: true });
    await waitFor(() => expect(screen.getByText("3 selected")).toBeTruthy());

    // Shift+click the second message shrinks the range back to the same fixed anchor (first).
    fireEvent.click(secondRow, { shiftKey: true });
    await waitFor(() => expect(screen.getByText("2 selected")).toBeTruthy());

    // The reading pane never changed — Shift+click only affects the bulk-action selection.
    expect(screen.getAllByText("Hello there").length).toBeGreaterThan(0);
  });

  test("collapsing the account sidebar persists across a reload", async () => {
    const { unmount } = render(<App />);

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    expect(screen.getByText("Accounts")).toBeTruthy();

    await userEvent.click(screen.getByTitle("Collapse accounts"));
    await waitFor(() => expect(screen.queryByText("Accounts")).toBeNull());
    expect(screen.getByTitle("Show accounts")).toBeTruthy();
    expect(localStorage.getItem("psmail.sidebarCollapsed")).toBe("true");

    await userEvent.click(screen.getByTitle("Show accounts"));
    await waitFor(() => expect(screen.getByText("Accounts")).toBeTruthy());
    expect(localStorage.getItem("psmail.sidebarCollapsed")).toBe("false");

    // Collapse again, then simulate a reload: unmount and mount a fresh <App/> without touching localStorage.
    await userEvent.click(screen.getByTitle("Collapse accounts"));
    await waitFor(() => expect(screen.queryByText("Accounts")).toBeNull());
    unmount();

    // The session token was persisted too, so the fresh mount logs back in on its own — no login step here.
    render(<App />);
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });
    expect(screen.queryByText("Accounts")).toBeNull();
    expect(screen.getByTitle("Show accounts")).toBeTruthy();
  });

  test("resizing the message list column persists across a reload", async () => {
    const { unmount } = render(<App />);

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    const handles = document.querySelectorAll('[role="separator"][aria-orientation="vertical"]');
    expect(handles.length).toBe(2); // sidebar|list and list|reading-pane

    const messageListHandle = handles[1]!;
    fireEvent.pointerDown(messageListHandle, { clientX: 500 });
    fireEvent.pointerMove(document, { clientX: 560 }); // +60px from the default 320px width
    fireEvent.pointerUp(document);

    await waitFor(() => expect(localStorage.getItem("psmail.messageListWidth")).toBe("380"));

    unmount();

    // The session token was persisted too, so the fresh mount logs back in on its own — no login step here.
    render(<App />);
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });
    expect(localStorage.getItem("psmail.messageListWidth")).toBe("380");
  });

  test("editing account settings prefills the form and can toggle read-only", async () => {
    render(<App />);

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    // No lock icon before the change.
    expect(screen.queryByTitle("Read-only")).toBeNull();

    await userEvent.click(screen.getByTitle("More actions"));
    const menuItemLabels = (await screen.findAllByRole("menuitem")).map(i => i.textContent ?? "");
    // "below the Remove account action", per the request.
    expect(menuItemLabels.findIndex(t => t.includes("Remove account"))).toBeLessThan(
      menuItemLabels.findIndex(t => t.includes("Account settings"))
    );
    await userEvent.click(screen.getByText("Account settings"));

    expect(await screen.findByText("Account settings", { selector: "[data-slot=dialog-title]" })).toBeTruthy();
    // Server tab (the default) has the connection fields.
    const hostField = screen.getByLabelText("Host", { selector: "#edit-imap-host" }) as HTMLInputElement;
    expect(hostField.value).toBe("imap.example.com");
    // Password fields are never prefilled (the API never returns them).
    expect((screen.getByLabelText("Password", { selector: "#edit-imap-pass" }) as HTMLInputElement).value).toBe("");

    // Read-only lives on the Safety tab.
    await userEvent.click(screen.getByRole("tab", { name: "Safety" }));
    await userEvent.click(screen.getByLabelText("Read-only"));
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(screen.queryByText("Account settings", { selector: "[data-slot=dialog-title]" })).toBeNull());
    await waitFor(() => expect(screen.getByTitle("Read-only")).toBeTruthy());
  });

  test("account settings are organized into Server/Safety/Signature tabs", async () => {
    render(<App />);

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    await userEvent.click(screen.getByTitle("More actions"));
    await userEvent.click(screen.getByText("Account settings"));
    expect(await screen.findByText("Account settings", { selector: "[data-slot=dialog-title]" })).toBeTruthy();

    // Server (the default tab): connection fields, none of Safety's or Signature's.
    expect(screen.getByLabelText("Host", { selector: "#edit-imap-host" })).toBeTruthy();
    expect(screen.queryByLabelText("Read-only")).toBeNull();
    expect(screen.queryByLabelText("Sender name")).toBeNull();

    await userEvent.click(screen.getByRole("tab", { name: "Safety" }));
    expect(screen.getByLabelText("Read-only")).toBeTruthy();
    expect(screen.getByLabelText("Always delete permanently")).toBeTruthy();
    expect(screen.queryByLabelText("Host", { selector: "#edit-imap-host" })).toBeNull();

    await userEvent.click(screen.getByRole("tab", { name: "Signature" }));
    expect(screen.getByLabelText("Sender name")).toBeTruthy();
    // aria-label on the MarkdownEditor's contenteditable surface, set in an effect after TinyMDE
    // mounts — give that a moment rather than assuming it's synchronous with the tab switch.
    // (Not screen.getByLabelText: the Signature *tabpanel* itself is also labelled "Signature",
    // via aria-labelledby pointing at its tab trigger, so that query would match two elements.)
    await waitFor(() => expect(document.querySelector('.TinyMDE[aria-label="Signature"]')).toBeTruthy());
    expect(screen.queryByLabelText("Read-only")).toBeNull();
  });

  test("the Signature tab pre-fills sender name/signature, and sender name can be edited and reloaded", async () => {
    installMockFetch({ accountOverrides: { senderName: "Alice", signature: "Cheers,\nAlice" } });
    render(<App />);

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    await userEvent.click(screen.getByTitle("More actions"));
    await userEvent.click(screen.getByText("Account settings"));
    await userEvent.click(await screen.findByRole("tab", { name: "Signature" }));

    expect((screen.getByLabelText("Sender name") as HTMLInputElement).value).toBe("Alice");
    // Not screen.getByLabelText: the Signature tabpanel itself is also labelled "Signature" via
    // aria-labelledby (pointing at its tab trigger), so that query would match two elements.
    const signatureEditor = await waitFor(() => {
      const el = document.querySelector('.TinyMDE[aria-label="Signature"]');
      if (!el) throw new Error("signature editor not mounted yet");
      return el as HTMLElement;
    });
    expect(signatureEditor.textContent).toContain("Cheers");
    // Writable here, unlike the reading pane's Text/MD tabs.
    expect(signatureEditor.getAttribute("contenteditable")).not.toBe("false");

    await userEvent.clear(screen.getByLabelText("Sender name"));
    await userEvent.type(screen.getByLabelText("Sender name"), "Alice Example");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(screen.queryByText("Account settings", { selector: "[data-slot=dialog-title]" })).toBeNull());

    // Reopen — round-tripped through the (mocked) PATCH + account refetch.
    await userEvent.click(screen.getByTitle("More actions"));
    await userEvent.click(screen.getByText("Account settings"));
    await userEvent.click(await screen.findByRole("tab", { name: "Signature" }));
    expect((screen.getByLabelText("Sender name") as HTMLInputElement).value).toBe("Alice Example");
  });

  test("checking IMAP capabilities updates the soft-delete availability hint", async () => {
    installMockFetch({ uidPlusSupported: true });
    render(<App />);

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    await userEvent.click(screen.getByTitle("More actions"));
    await userEvent.click(screen.getByText("Account settings"));
    expect(await screen.findByText("Account settings", { selector: "[data-slot=dialog-title]" })).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: "Safety" }));

    // Never checked yet (the fixture starts with supportsUidPlus: null).
    expect(screen.getByText(/Server capability not checked yet/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /check server capabilities/i }));
    await waitFor(() => expect(screen.getByText(/This server supports UIDPLUS/)).toBeTruthy());
  });

  test("marking a message read/unread updates the sidebar's unread badge immediately, without a reload", async () => {
    render(<App />);

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    // FOLDERS starts with unread: 1, rendered as a badge next to the INBOX row in the sidebar.
    await waitFor(() => expect(document.querySelector('[data-slot="badge"]')?.textContent).toBe("1"));

    // Opening the unread message auto-marks it read — the badge should drop right away, not
    // just after the next sync/reload of the folder list.
    await userEvent.click(await screen.findByText("Hello there"));
    await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(0));
    await waitFor(() => expect(document.querySelector('[data-slot="badge"]')).toBeNull());

    // Explicitly marking it unread again bumps the badge back up, same way.
    await userEvent.click(screen.getByRole("button", { name: /mark unread/i }));
    await waitFor(() => expect(document.querySelector('[data-slot="badge"]')?.textContent).toBe("1"));
  });

  test("recipient fields suggest contacts while typing, and accepting one fills in the address", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    await userEvent.click(screen.getByRole("button", { name: /new/i }));
    const to = (await screen.findByLabelText("To")) as HTMLInputElement;
    await userEvent.type(to, "al");

    const options = await screen.findAllByRole("option");
    expect(options.map(o => o.textContent)).toEqual(["Alice Anderson alice@example.com", "albert@example.com"]);

    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(to.value).toBe("albert@example.com, ");
    expect(screen.queryByRole("option")).toBeNull();

    // A second recipient: only the token after the last comma is completed, and the first isn't offered again.
    await userEvent.type(to, "al");
    const again = await screen.findAllByRole("option");
    expect(again.map(o => o.textContent)).toEqual(["Alice Anderson alice@example.com"]);
    await userEvent.click(again[0]!);
    expect(to.value).toBe("albert@example.com, Alice Anderson <alice@example.com>, ");
  });

  test("reaching the bottom of the message list loads the next page", async () => {
    installMockFetch({ pagedEmailCount: 250 });
    const observers: { callback: IntersectionObserverCallback }[] = [];
    const originalIO = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      constructor(callback: IntersectionObserverCallback) {
        observers.push({ callback });
      }
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    } as unknown as typeof IntersectionObserver;

    try {
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await waitFor(() => expect(screen.getAllByText("Generated 0").length).toBeGreaterThan(0), { timeout: 3000 });
      expect(screen.queryByText("Generated 100")).toBeNull();
      expect(pagedRequests[0]).toEqual({ limit: 100, offset: 0 });

      // The end-of-list marker scrolls into view.
      const fire = () =>
        act(() => {
          const latest = observers.at(-1)!;
          latest.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
        });
      fire();
      await waitFor(() => expect(screen.getAllByText("Generated 100").length).toBeGreaterThan(0));
      expect(pagedRequests.at(-1)).toEqual({ limit: 100, offset: 100 });

      fire();
      await waitFor(() => expect(screen.getAllByText("Generated 249").length).toBeGreaterThan(0));
      expect(pagedRequests.at(-1)).toEqual({ limit: 100, offset: 200 });

      // 250 < 300: that was the last page, so the marker (and its observer) is gone — no further request.
      const requestCount = pagedRequests.length;
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(pagedRequests.length).toBe(requestCount);
    } finally {
      globalThis.IntersectionObserver = originalIO;
    }
  });

  test("the reading-pane tab is stored in the user settings when picked, and restored from them", async () => {
    installMockFetch({ settings: { bodyView: "md" } });
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    // The stored preference wins over the built-in default (Safe HTML)…
    await userEvent.click(await screen.findByText("Hello there"));
    await waitFor(() => expect(screen.getByRole("tab", { name: "MD" }).getAttribute("data-state")).toBe("active"));
    // …and merely opening a message doesn't rewrite the stored value.
    expect(capturedSettingsPatches).toEqual([]);

    await userEvent.click(screen.getByRole("tab", { name: "Plain text" }));
    await waitFor(() => expect(capturedSettingsPatches).toEqual([{ bodyView: "plain" }]));
  });

  test("account settings have a Misc tab that saves the account's position", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    await userEvent.click(screen.getByTitle("More actions"));
    await userEvent.click(screen.getByText("Account settings"));
    await userEvent.click(await screen.findByRole("tab", { name: "Misc" }));

    const position = screen.getByLabelText("Position in the account list") as HTMLInputElement;
    expect(position.value).toBe("1");
    await userEvent.clear(position);
    await userEvent.type(position, "3");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(capturedAccountPatch?.position).toBe(3));
  });

  test("an unchanged position isn't sent when saving other account settings", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    await userEvent.click(screen.getByTitle("More actions"));
    await userEvent.click(screen.getByText("Account settings"));
    await userEvent.click(await screen.findByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(capturedAccountPatch).not.toBeNull());
    expect("position" in capturedAccountPatch!).toBe(false);
  });

  test("the sidebar starts with a combined Inbox and Sent that list all accounts' mail", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    await userEvent.click(screen.getByTitle("Inbox of all accounts"));
    expect(await screen.findByText("Unified hello")).toBeTruthy();
    expect(screen.getByText("Inbox · all accounts")).toBeTruthy();
    expect(screen.getByText("me@example.com · INBOX")).toBeTruthy();

    // Opening a result shows the message in the reading pane, like a search hit does.
    await userEvent.click(screen.getByText("Unified hello"));
    await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(0));

    // Sent lists who each message went to, not who it was from.
    await userEvent.click(screen.getByTitle("Sent of all accounts"));
    expect(await screen.findByText("Unified outgoing")).toBeTruthy();
    expect(screen.getByText("Zed Zebra")).toBeTruthy();
    expect(screen.getByText("Sent · all accounts")).toBeTruthy();

    // Picking a real folder goes back to that account's own list.
    await userEvent.click(screen.getAllByText("Inbox")[1]!); // [0] is the combined Inbox row above the accounts
    await waitFor(() => expect(screen.queryByText("Sent · all accounts")).toBeNull());
    expect(await screen.findByText("Hello there")).toBeTruthy();
  });

  test("message rows with attachments show a paperclip, in folder lists and in the combined Inbox", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    // Only SECOND_EMAIL has attachmentCount: 1.
    await screen.findByText("Second message");
    const marks = screen.getAllByLabelText("Has attachments");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.closest("li")!.textContent).toContain("Second message");
  });

  test("the combined Inbox shows the unread count across all accounts, and drops it as messages are read", async () => {
    installMockFetch({ inboxUnread: 3 });
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    const combined = () => screen.getByTitle("Inbox of all accounts");
    await waitFor(() => expect(combined().textContent).toContain("3"));

    // Opening the unread INBOX message marks it read: the badge follows without another request.
    const requestsBefore = unreadRequests;
    await userEvent.click(await screen.findByText("Hello there"));
    await waitFor(() => expect(combined().textContent).toContain("2"));
    expect(unreadRequests).toBe(requestsBefore);
  });

  test("no badge on the combined Inbox when nothing is unread", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });
    await waitFor(() => expect(unreadRequests).toBeGreaterThan(0));
    expect(screen.getByTitle("Inbox of all accounts").textContent).toBe("Inbox");
  });

  test("Sync now syncs the whole account (no folder), and the tree refreshes in place instead of reloading", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });
    await screen.findByText("Hello there");
    const foldersBefore = folderRequests;
    const unreadBefore = unreadRequests;

    // Make the post-sync folder refresh slow, so we can look at the tree while it's in flight.
    folderDelayMs = 400;
    await userEvent.click(screen.getByTitle("Sync now"));
    await waitFor(() => expect(downloadPosts).toEqual([{}])); // no `folder` = every folder

    await waitFor(() => expect(folderRequests).toBeGreaterThan(foldersBefore)); // refresh started…
    // …and while it's running the folder rows are still there, with no "Loading folders…" spinner.
    expect(screen.queryByText("Loading folders…")).toBeNull();
    expect(screen.getAllByText("Inbox").length).toBeGreaterThan(1);
    expect(screen.getByText("Entwürfe")).toBeTruthy();

    // The combined Inbox's count is re-read too, and the open list keeps showing its messages.
    await waitFor(() => expect(unreadRequests).toBeGreaterThan(unreadBefore));
    expect(screen.getByText("Hello there")).toBeTruthy();
  });

  test("starred messages show a star in result lists, and the reading pane shows a star instead of a 'Flagged' badge", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    // The combined Inbox's mock row is starred.
    await userEvent.click(screen.getByTitle("Inbox of all accounts"));
    const row = (await screen.findByText("Unified hello")).closest("li")!;
    expect(row.querySelector('[aria-label="Starred"]')).toBeTruthy();

    // The reading pane's header: a star, not a text "Flagged" badge (and nothing when not starred).
    cleanup();
    const flagged = render(<MessageHeader email={{ ...EMAIL, isFlagged: true } as never} />);
    expect(flagged.container.querySelector('[aria-label="Starred"]')).toBeTruthy();
    expect(screen.queryByText("Flagged")).toBeNull();
    flagged.unmount();
    const plain = render(<MessageHeader email={{ ...EMAIL, isFlagged: false } as never} />);
    expect(plain.container.querySelector('[aria-label="Starred"]')).toBeNull();
  });

  test("the header's settings button opens a dialog whose values are stored in the user settings", async () => {
    installMockFetch({ settings: { syncIntervalMinutes: 15 } });
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    await userEvent.click(screen.getByTitle("Settings"));
    const interval = (await screen.findByLabelText("Sync interval (minutes)")) as HTMLInputElement;
    await waitFor(() => expect(interval.value).toBe("15")); // seeded from the stored settings
    const includeFolders = screen.getByLabelText("Show mail from folders in the combined Inbox");
    expect(includeFolders.getAttribute("aria-checked")).toBe("false");

    await userEvent.clear(interval);
    await userEvent.type(interval, "5");
    await userEvent.click(includeFolders);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(capturedSettingsPatches).toEqual([{ syncIntervalMinutes: 5, combinedInboxIncludesFolders: true }])
    );
    await waitFor(() => expect(screen.queryByLabelText("Sync interval (minutes)")).toBeNull()); // closed

    // Leaving the interval empty stores "never" (null).
    await userEvent.click(screen.getByTitle("Settings"));
    const again = (await screen.findByLabelText("Sync interval (minutes)")) as HTMLInputElement;
    await waitFor(() => expect(again.value).toBe("5"));
    await userEvent.clear(again);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(capturedSettingsPatches.at(-1)).toEqual({ syncIntervalMinutes: null, combinedInboxIncludesFolders: true }));
  });

  test("an invalid sync interval is rejected in the dialog without saving", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    await userEvent.click(screen.getByTitle("Settings"));
    const interval = await screen.findByLabelText("Sync interval (minutes)");
    await userEvent.type(interval, "2.5");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/whole number of minutes/)).toBeTruthy();
    expect(capturedSettingsPatches).toEqual([]);
  });

  test("toggling the combined-Inbox folders option re-reads the combined Inbox's unread count", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });
    await waitFor(() => expect(unreadRequests).toBeGreaterThan(0));
    const before = unreadRequests;

    await userEvent.click(screen.getByTitle("Settings"));
    await userEvent.click(await screen.findByLabelText("Show mail from folders in the combined Inbox"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(unreadRequests).toBeGreaterThan(before));
  });

  test("with a sync interval set, the client syncs every account's Inbox (only) on each tick; without one, nothing is scheduled", async () => {
    const realSetInterval = globalThis.setInterval;
    const minuteTimers: (() => void)[] = [];
    globalThis.setInterval = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms !== undefined && ms >= 60_000) {
        minuteTimers.push(fn);
        return 0 as unknown as ReturnType<typeof setInterval>;
      }
      return realSetInterval(fn, ms, ...rest);
    }) as typeof setInterval;

    try {
      installMockFetch({ settings: { syncIntervalMinutes: 3 } });
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });
      await waitFor(() => expect(minuteTimers).toHaveLength(1));
      expect(downloadPosts).toEqual([]); // nothing until the first tick

      await act(async () => minuteTimers[0]!());
      await waitFor(() => expect(downloadPosts).toEqual([{ folder: "INBOX" }])); // one account here; the Inbox only, not every folder

      // Without the setting (the default), no periodic timer is registered at all.
      cleanup();
      installMockFetch();
      render(<App />); // still signed in from above
      await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });
      expect(minuteTimers).toHaveLength(1); // still just the first render's
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });
});
