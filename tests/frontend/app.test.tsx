import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
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
  to: [{ address: "me@example.com" }, { name: "Dora", address: "dora@example.com" }],
  cc: [{ name: "Carl", address: "carl@example.com" }],
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

// What the Settings dialog saves when only the fields a test touches were changed.
const DEFAULT_PATCH = { syncIntervalMinutes: null, combinedInboxIncludesFolders: false, notifyBrowser: false, notifyToast: false, notificationSound: "crystal_clear" };

const SYNC_JOB = (status: string) => ({
  id: 1, accountId: 1, folder: null, status, progressCurrent: 0, progressTotal: 0, error: null, startedAt: NOW, finishedAt: null, createdAt: NOW,
});

// The app opens on the combined Inbox with every account collapsed; most tests exercise one account's own
// folder list, so expand the account and go there first (the sidebar then has two "Inbox" rows: the
// combined one on top, then the account's folder).
async function openAccountInbox() {
  await waitFor(() => expect(screen.getAllByText("me@example.com").length).toBeGreaterThan(0), { timeout: 3000 });
  if (screen.getAllByText("Inbox").length < 2) await userEvent.click(screen.getAllByText("me@example.com")[0]!);
  await waitFor(() => expect(screen.getAllByText("Inbox").length).toBeGreaterThan(1), { timeout: 3000 });
  await userEvent.click(screen.getAllByText("Inbox")[1]!);
  await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });
}

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
// Bodies of PATCH .../emails/20 (the combined Sent list's message).
const capturedResultPatches: Record<string, unknown>[] = [];
// Bodies of POST /api/auth/change-password.
const passwordChanges: Record<string, unknown>[] = [];
// Every bulk PATCH/DELETE/move request, with the account it went to.
// The `scope` param of every GET .../contacts call.
const contactRequests: (string | null)[] = [];
// Requests to the AI endpoints: [method, path, body].
const aiRequests: [string, string, any][] = [];
const bulkRequests: { account: string; method: string; move: string | null; body: Record<string, unknown> }[] = [];
let folderRequests = 0;
let unreadRequests = 0;
// The afterId (or null) of every GET /api/unified/inbox/new call.
const newMailRequests: (string | null)[] = [];
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
    settings?: {
      bodyView?: string;
      syncIntervalMinutes?: number;
      combinedInboxIncludesFolders?: boolean;
      notifyBrowser?: boolean;
      notifyToast?: boolean;
      notificationSound?: string;
      aiTargetLanguage?: string;
    };
    /** What GET /api/unified/inbox/unread reports (the combined Inbox's badge). */
    inboxUnread?: number;
    /** The sync job never finishes (GET job stays running at 12/340) — to look at the in-progress UI. */
    syncStaysRunning?: boolean;
    /** Categories the user has AI skills for (all on one provider); they show up in GET /api/ai/skills. */
    aiSkillCategories?: string[];
    /** Provider records GET /api/ai/apis starts with. */
    aiApis?: { id: number; name: string; vendor: string; model: string; baseUrl: string | null; hasKey: boolean }[];
    /** What GET .../downloads (the account's job history) lists: a sync already underway when the page loads. */
    earlierSyncJob?: "running" | "completed";
    /** Adds a contact from another account to the recipient suggestions. */
    otherAccountContacts?: boolean;
    /** Replaces the combined Inbox's rows (default: one starred message). */
    unifiedInboxRows?: Record<string, unknown>[];
    /** Makes POST /api/auth/change-password answer with this error (status 401) instead of succeeding. */
    changePasswordError?: string;
    /** What GET /api/unified/inbox/new answers when asked with an afterId (without one it just reports latestId: 100). */
    newMail?: { total: number; messages: Record<string, unknown>[] };
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
  capturedResultPatches.length = 0;
  passwordChanges.length = 0;
  bulkRequests.length = 0;
  aiRequests.length = 0;
  let currentAiApis = [...(opts.aiApis ?? [])];
  // "summarize" or "summarize:Short" (a skill with a name of its own; unnamed ones are named after their category, like the server does).
  let currentAiSkills = (opts.aiSkillCategories ?? []).map((spec, i) => {
    const [category, name = category] = spec.split(":");
    return { id: i + 1, aiApiId: 1, category, name, prompt: `prompt for ${category}`, createdAt: NOW, updatedAt: NOW };
  });
  // A provider's label is its name, or Vendor.model when it has none (the server computes it).
  const withLabel = <T extends { name: string; vendor: string; model: string }>(record: T) => ({
    ...record,
    label: record.name || `${({ anthropic: "Anthropic", openai: "OpenAI", google: "Google", ollama: "Ollama" } as Record<string, string>)[record.vendor]}.${record.model}`,
  });
  contactRequests.length = 0;
  folderRequests = 0;
  unreadRequests = 0;
  newMailRequests.length = 0;
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
    if (method === "GET" && path === "/api/accounts/me%40example.com/downloads") {
      if (!opts.earlierSyncJob) return jsonResponse([]);
      return jsonResponse([{ ...SYNC_JOB(opts.earlierSyncJob), progressCurrent: 5, progressTotal: 10 }]);
    }
    if (method === "GET" && path === "/api/accounts/me%40example.com/downloads/1") {
      return jsonResponse(opts.syncStaysRunning ? { ...SYNC_JOB("running"), progressCurrent: 12, progressTotal: 340 } : SYNC_JOB("completed"));
    }
    if (method === "GET" && path === "/api/unified/inbox/new") {
      const afterId = new URL(url, "http://localhost").searchParams.get("afterId");
      newMailRequests.push(afterId);
      const result = afterId === null ? { total: 0, messages: [] } : opts.newMail ?? { total: 0, messages: [] };
      return jsonResponse({ latestId: afterId === null ? 100 : 101, ...result });
    }
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
    if (method === "POST" && path === "/api/auth/change-password") {
      passwordChanges.push(init?.body ? JSON.parse(init.body as string) : {});
      if (opts.changePasswordError) return jsonResponse({ error: opts.changePasswordError }, 401);
      return jsonResponse({ ok: true, otherSessionsSignedOut: 2 });
    }
    if (path.startsWith("/api/ai/") || /\/ai\/(summarize|translate|categorize)$/.test(path)) {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      aiRequests.push([method, path, body]);
      if (path === "/api/ai/apis" && method === "GET") return jsonResponse(currentAiApis.map(withLabel));
      if (path === "/api/ai/apis" && method === "POST") {
        const { apiKey, ...rest } = body;
        const record = { id: currentAiApis.length + 1, baseUrl: null, ...rest, hasKey: !!apiKey };
        currentAiApis = [...currentAiApis, record];
        return jsonResponse(withLabel(record), 201);
      }
      const apiById = /^\/api\/ai\/apis\/(\d+)$/.exec(path);
      if (apiById && method === "DELETE") {
        currentAiApis = currentAiApis.filter(a => a.id !== Number(apiById[1]));
        currentAiSkills = currentAiSkills.filter(s => s.aiApiId !== Number(apiById[1]));
        return new Response(null, { status: 204 });
      }
      if (/^\/api\/ai\/apis\/\d+\/test$/.test(path)) return jsonResponse({ ok: true, answer: "OK" });
      if (path === "/api/ai/skills" && method === "GET") return jsonResponse(currentAiSkills);
      if (path === "/api/ai/skills" && method === "POST") {
        const record = { id: currentAiSkills.length + 10, createdAt: NOW, updatedAt: NOW, ...body };
        currentAiSkills = [...currentAiSkills, record];
        return jsonResponse(record, 201);
      }
      const skillById = /^\/api\/ai\/skills\/(\d+)$/.exec(path);
      if (skillById && method === "DELETE") {
        currentAiSkills = currentAiSkills.filter(s => s.id !== Number(skillById[1]));
        return new Response(null, { status: 204 });
      }
      if (path === "/api/ai/run") return jsonResponse({ text: "Corrected text" });
      if (path.endsWith("/ai/summarize")) {
        return jsonResponse({ email: { ...EMAIL, aiSummary: "- Alice says hello\n- No action needed", taxonomyList: ["greeting", "personal"] } });
      }
      if (path.endsWith("/ai/translate")) {
        return jsonResponse({ email: { ...EMAIL, translatedText: "Hallo, Welt", translatedLanguage: body?.language ?? "English" } });
      }
    }
    if (method === "GET" && path === "/api/settings") return jsonResponse(currentSettings);
    if (method === "PATCH" && path === "/api/settings") {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      capturedSettingsPatches.push(body);
      currentSettings = { ...currentSettings, ...body };
      return jsonResponse(currentSettings);
    }
    if (method === "GET" && path === "/api/unified/inbox") {
      if (opts.unifiedInboxRows) return jsonResponse(opts.unifiedInboxRows);
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
      const params = new URL(url, "http://localhost").searchParams;
      const q = (params.get("q") ?? "").toLowerCase();
      contactRequests.push(params.get("scope"));
      return jsonResponse(
        [
          { address: "alice@example.com", name: "Alice Anderson", fromCount: 3, ccCount: 0, sentCount: 1, lastUsed: NOW },
          { address: "albert@example.com", name: "", fromCount: 0, ccCount: 1, sentCount: 0, lastUsed: NOW },
          // Only served with scope=all, like the real API; the option controls whether the other account has matches.
          ...(params.get("scope") === "all" && opts.otherAccountContacts
            ? [{ address: "alva@other.com", name: "Alva Other", fromCount: 2, ccCount: 0, sentCount: 0, lastUsed: NOW, other: true }]
            : []),
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
    if (method === "PATCH" && path === "/api/accounts/me%40example.com/emails/20") {
      capturedResultPatches.push(init?.body ? JSON.parse(init.body as string) : {});
      return jsonResponse({ ...EMAIL, id: 20, ...(init?.body ? JSON.parse(init.body as string) : {}) });
    }
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
    const bulk = /^\/api\/accounts\/([^/]+)\/emails\/bulk(\/move\/.*)?$/.exec(path);
    if (bulk && (method === "PATCH" || method === "DELETE")) {
      const body = init?.body ? JSON.parse(init.body as string) : { ids: [] };
      bulkRequests.push({ account: decodeURIComponent(bulk[1]!), method, move: bulk[2] ? decodeURIComponent(bulk[2].slice(6)) : null, body });
      return jsonResponse((body.ids as number[]).map(id => ({ id, ok: true, ...(method === "DELETE" ? { softDeleted: false } : {}) })));
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
    await openAccountInbox();

    // Message list
    const messageRow = await screen.findByText("Hello there");
    await userEvent.click(messageRow);

    // Reading pane: header, toolbar, and body tabs all rendered
    await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(0));
    expect(screen.getAllByText(/Alice/).length).toBeGreaterThan(0);
    expect(screen.getByRole("tab", { name: "Plain" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Safe HTML" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "HTML" })).toBeTruthy();
    expect(screen.getByText("Reply")).toBeTruthy();
    expect(screen.getByText("Delete")).toBeTruthy();

    // MD tab sits between Text and Plain, and shows the HTML converted to Markdown.
    const tabs = screen.getAllByRole("tab").map(t => t.textContent);
    expect(tabs.indexOf("Text")).toBeLessThan(tabs.indexOf("MD"));
    expect(tabs.indexOf("MD")).toBeLessThan(tabs.indexOf("Plain"));
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
    await openAccountInbox();
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

    await openAccountInbox();
  });

  test("the header hides the username when it's \"default\"", async () => {
    render(<App />);

    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();

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
    await openAccountInbox();

    expect(screen.getByText("secure")).toBeTruthy();
  });

  test("the Text/MD reading-pane tabs render via the non-editable RenderPureMarkdown component", async () => {
    render(<App />);

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();

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
    await openAccountInbox();

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
    await openAccountInbox();

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
    await openAccountInbox();

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
    await openAccountInbox();

    await userEvent.click(screen.getByRole("button", { name: /new/i }));
    expect(await screen.findByText("New message")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(screen.getByText("E-Mail sent")).toBeTruthy());
  });

  test("adding an attachment in compose shows its filename and size in MB", async () => {
    render(<App />);

    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();

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
    await openAccountInbox();

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
    await openAccountInbox();

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
    await openAccountInbox();

    const row = await screen.findByText("Hello there");
    await userEvent.dblClick(row);

    expect(screen.queryByText("New message")).toBeNull();
    expect(screen.queryByText("Edit draft", { selector: "[data-slot=dialog-title]" })).toBeNull();
  });

  test("remembers the last body view across messages, downgrading HTML to Safe HTML", async () => {
    render(<App />);

    function isTabSelected(name: string): boolean {
      return screen.getByRole("tab", { name }).getAttribute("aria-selected") === "true";
    }

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();

    // Open the first message and switch it to HTML.
    await userEvent.click(await screen.findByText("Hello there"));
    await userEvent.click(await screen.findByRole("tab", { name: "HTML" }));
    await waitFor(() => expect(isTabSelected("HTML")).toBe(true));

    // Switching to the second message must not carry HTML over — it should land on Safe HTML.
    await userEvent.click(await screen.findByText("Second message"));
    await waitFor(() => expect(screen.getAllByText("Second message").length).toBeGreaterThan(0));
    await waitFor(() => expect(isTabSelected("Safe HTML")).toBe(true));
    expect(isTabSelected("HTML")).toBe(false);

    // Explicitly picking Plain on the second message...
    await userEvent.click(screen.getByRole("tab", { name: "Plain" }));
    await waitFor(() => expect(isTabSelected("Plain")).toBe(true));

    // ...should be remembered when going back to the first message.
    await userEvent.click(await screen.findByText("Hello there"));
    await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(0));
    await waitFor(() => expect(isTabSelected("Plain")).toBe(true));
  });

  test("Cmd/Ctrl+K focuses the search input from anywhere on the page", async () => {
    render(<App />);

    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();

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
    await openAccountInbox();

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
    await openAccountInbox();

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
    await openAccountInbox();

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
    await openAccountInbox();

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
    await openAccountInbox();

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
    await openAccountInbox();

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
    await openAccountInbox();

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
    await openAccountInbox();

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
    await openAccountInbox();

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
    expect(await screen.findByTitle("Show accounts")).toBeTruthy();
    expect(screen.queryByText("Accounts")).toBeNull();
  });

  test("resizing the message list column persists across a reload", async () => {
    const { unmount } = render(<App />);

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();

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
    await openAccountInbox();
    expect(localStorage.getItem("psmail.messageListWidth")).toBe("380");
  });

  test("editing account settings prefills the form and can toggle read-only", async () => {
    render(<App />);

    // Clicking the profile logs straight in now (an empty password works, so LoginView skips
    // the password prompt entirely) — no separate "Sign in" click needed.
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();

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
    await openAccountInbox();

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
    await openAccountInbox();

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
    await openAccountInbox();

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
    await openAccountInbox();

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
    await openAccountInbox();

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
      await openAccountInbox();
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
    await openAccountInbox();

    // The stored preference wins over the built-in default (Safe HTML)…
    await userEvent.click(await screen.findByText("Hello there"));
    await waitFor(() => expect(screen.getByRole("tab", { name: "MD" }).getAttribute("data-state")).toBe("active"));
    // …and merely opening a message doesn't rewrite the stored value.
    expect(capturedSettingsPatches).toEqual([]);

    await userEvent.click(screen.getByRole("tab", { name: "Plain" }));
    await waitFor(() => expect(capturedSettingsPatches).toEqual([{ bodyView: "plain" }]));
  });

  test("account settings have a Misc tab that saves the account's position", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();

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
    await openAccountInbox();

    await userEvent.click(screen.getByTitle("More actions"));
    await userEvent.click(screen.getByText("Account settings"));
    await userEvent.click(await screen.findByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(capturedAccountPatch).not.toBeNull());
    expect("position" in capturedAccountPatch!).toBe(false);
  });

  test("the sidebar starts with a combined Inbox and Sent that list all accounts' mail", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();

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
    await openAccountInbox();

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
    await openAccountInbox();

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
    await openAccountInbox();
    await waitFor(() => expect(unreadRequests).toBeGreaterThan(0));
    expect(screen.getByTitle("Inbox of all accounts").textContent).toBe("Inbox");
  });

  test("Sync now syncs the whole account (no folder), and the tree refreshes in place instead of reloading", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();
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
    await openAccountInbox();

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
    await openAccountInbox();

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
      expect(capturedSettingsPatches).toEqual([{ ...DEFAULT_PATCH, syncIntervalMinutes: 5, combinedInboxIncludesFolders: true }])
    );
    await waitFor(() => expect(screen.queryByLabelText("Sync interval (minutes)")).toBeNull()); // closed

    // Leaving the interval empty stores "never" (null).
    await userEvent.click(screen.getByTitle("Settings"));
    const again = (await screen.findByLabelText("Sync interval (minutes)")) as HTMLInputElement;
    await waitFor(() => expect(again.value).toBe("5"));
    await userEvent.clear(again);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(capturedSettingsPatches.at(-1)).toEqual({ ...DEFAULT_PATCH, syncIntervalMinutes: null, combinedInboxIncludesFolders: true }));
  });

  test("an invalid sync interval is rejected in the dialog without saving", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();

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
    await openAccountInbox();
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
      await openAccountInbox();
      await waitFor(() => expect(minuteTimers).toHaveLength(1));
      expect(downloadPosts).toEqual([]); // nothing until the first tick

      await act(async () => minuteTimers[0]!());
      await waitFor(() => expect(downloadPosts).toEqual([{ folder: "INBOX" }])); // one account here; the Inbox only, not every folder

      // Without the setting (the default), no periodic timer is registered at all.
      cleanup();
      installMockFetch();
      render(<App />); // still signed in from above
      await openAccountInbox();
      expect(minuteTimers).toHaveLength(1); // still just the first render's
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });

  test("Esc closes the search, like its x button", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();

    const searchBox = screen.getByPlaceholderText(/search all mail/i) as HTMLInputElement;
    await userEvent.type(searchBox, "second");
    await waitFor(() => expect(screen.getByText(/Search: "second"/)).toBeTruthy());

    await userEvent.keyboard("{Escape}");
    expect(searchBox.value).toBe("");
    expect(document.activeElement).not.toBe(searchBox);
    await waitFor(() => expect(screen.queryByText(/Search: "second"/)).toBeNull());
    expect(await screen.findByText("Hello there")).toBeTruthy(); // back to the folder list

    // With no search open, Esc is left alone.
    const notHandled = fireEvent.keyDown(window, { key: "Escape" });
    expect(notHandled).toBe(true);
  });

  test("Cmd/Ctrl+A selects every message in the list, except while typing in a text field", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();
    await screen.findByText("Second message");

    // In the search box, select-all keeps its normal meaning (select the text).
    const searchBox = screen.getByPlaceholderText(/search all mail/i);
    await userEvent.click(searchBox);
    await userEvent.keyboard("{Control>}a{/Control}");
    expect(screen.queryByText(/\d+ selected/)).toBeNull();

    (document.body as HTMLElement).focus();
    const handled = !fireEvent.keyDown(document.body, { key: "a", ctrlKey: true });
    expect(handled).toBe(true); // preventDefault'd, so the browser doesn't select the page text
    await waitFor(() => expect(screen.getByText("4 selected")).toBeTruthy());

    // Cmd works the same as Ctrl.
    await userEvent.click(screen.getByTitle("Clear selection"));
    await waitFor(() => expect(screen.queryByText(/\d+ selected/)).toBeNull());
    expect(fireEvent.keyDown(document.body, { key: "a", metaKey: true })).toBe(false);
    await waitFor(() => expect(screen.getByText("4 selected")).toBeTruthy());
  });

  test("Cmd/Ctrl+R replies to the open message; without one it doesn't interfere with the browser", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();

    // Nothing open: the key isn't handled (the browser would reload).
    (document.body as HTMLElement).focus();
    expect(fireEvent.keyDown(document.body, { key: "r", ctrlKey: true })).toBe(true);
    expect(screen.queryByText("New message")).toBeNull();

    await userEvent.click(await screen.findByText("Hello there"));
    await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(1));
    (document.body as HTMLElement).focus();
    expect(fireEvent.keyDown(document.body, { key: "r", metaKey: true })).toBe(false); // preventDefault'd: no page reload

    const composeDialog = (await screen.findByText("New message")).closest('[role="dialog"]') as HTMLElement;
    expect((within(composeDialog).getByLabelText("Subject") as HTMLInputElement).value).toBe("Re: Hello there");
  });

  test("the compose dialog focuses the message editor when To is already filled in (reply), else the To field", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();

    await userEvent.click(await screen.findByText("Hello there"));
    await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(1));
    await userEvent.click(screen.getByRole("button", { name: /reply/i }));

    const dialog = (await screen.findByText("New message")).closest('[role="dialog"]') as HTMLElement;
    await waitFor(() => {
      const editor = dialog.querySelector(".psmail-markdown-editor .TinyMDE");
      expect(editor).toBeTruthy();
      expect(document.activeElement).toBe(editor);
    });
    expect((within(dialog).getByLabelText("To") as HTMLInputElement).value).toContain("alice@example.com");

    // A brand-new message has no recipient yet, so the cursor starts in To.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("New message")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: /new/i }));
    const fresh = await screen.findByLabelText("To");
    await waitFor(() => expect(document.activeElement).toBe(fresh));
  });

  test("the star in search/combined lists can be toggled, and is rolled back when the server refuses", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();

    await userEvent.click(screen.getByTitle("Sent of all accounts"));
    const sentRow = (await screen.findByText("Unified outgoing")).closest("li")!;
    expect(sentRow.querySelector('[aria-label="Starred"]')).toBeNull();

    await userEvent.click(within(sentRow).getByTitle("Add star"));
    await waitFor(() => expect(capturedResultPatches).toEqual([{ isFlagged: true }]));
    expect(sentRow.querySelector('[aria-label="Starred"]')).toBeTruthy();
    // Clicking the star doesn't also open the message.
    expect(screen.getByText("Select a message")).toBeTruthy();

    await userEvent.click(within(sentRow).getByTitle("Remove star"));
    await waitFor(() => expect(capturedResultPatches.at(-1)).toEqual({ isFlagged: false }));
    expect(sentRow.querySelector('[aria-label="Starred"]')).toBeNull();
  });

  test("a refused star toggle in the combined Inbox reverts the star", async () => {
    installMockFetch({ failEmailPatch: 10 });
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();

    await userEvent.click(screen.getByTitle("Inbox of all accounts"));
    const row = (await screen.findByText("Unified hello")).closest("li")!; // starred in the mock
    expect(row.querySelector('[aria-label="Starred"]')).toBeTruthy();

    await userEvent.click(within(row).getByTitle("Remove star"));
    expect((await screen.findAllByText("simulated IMAP failure")).length).toBeGreaterThan(0); // the error toast
    await waitFor(() => expect(row.querySelector('[aria-label="Starred"]')).toBeTruthy());
  });

  describe("new mail notifications", () => {
    const PREVIEW = {
      id: 10,
      accountEmail: "me@example.com",
      folder: "INBOX",
      from: [{ name: "Alice Anderson", address: "alice@example.com" }],
      to: [{ address: "me@example.com" }],
      cc: [{ name: "Bob", address: "bob@example.com" }],
      subject: "Lunch on Friday?",
      date: "2026-01-02T10:00:00.000Z",
      snippet: "Hi! Are you free on Friday for lunch? I know a great place",
    };

    class FakeNotification {
      static permission = "granted";
      static created: FakeNotification[] = [];
      static requestPermission = async () => FakeNotification.permission;
      onclick: (() => void) | null = null;
      closed = false;
      constructor(public title: string, public options: { body?: string; tag?: string }) {
        FakeNotification.created.push(this);
      }
      close() {
        this.closed = true;
      }
    }
    const played: string[] = [];
    const originalNotification = (globalThis as { Notification?: unknown }).Notification;
    const originalAudio = globalThis.Audio;

    beforeEach(() => {
      FakeNotification.permission = "granted";
      FakeNotification.created = [];
      played.length = 0;
      (globalThis as { Notification?: unknown }).Notification = FakeNotification;
      globalThis.Audio = class {
        constructor(src: string) {
          played.push(src);
        }
        play() {
          return Promise.resolve();
        }
      } as unknown as typeof Audio;
    });
    afterEach(() => {
      toast.dismiss(); // sonner's toast store is global: don't let one test's toasts show up in the next
      (globalThis as { Notification?: unknown }).Notification = originalNotification;
      globalThis.Audio = originalAudio;
    });

    async function loginAndSync(alreadySignedIn = false) {
      render(<App />);
      if (!alreadySignedIn) await userEvent.click(await screen.findByText("default"));
      await openAccountInbox();
      await waitFor(() => expect(newMailRequests).toEqual([null])); // the starting point is read on load
      await userEvent.click(screen.getByTitle("Sync now"));
      await waitFor(() => expect(newMailRequests.length).toBeGreaterThan(1));
    }

    test("a toast shows sender, subject, the start of the text, date and recipients, and plays the default sound", async () => {
      installMockFetch({ settings: { notifyToast: true }, newMail: { total: 1, messages: [PREVIEW] } });
      await loginAndSync();

      expect(await screen.findByText("Alice Anderson")).toBeTruthy();
      expect(screen.getByText("Lunch on Friday?")).toBeTruthy();
      const snippet = screen.getByText(/Are you free on Friday for lunch/);
      expect(snippet.className).toContain("font-mono"); // the message text is monospace, like the message views
      expect(screen.queryByRole("button", { name: "Open" })).toBeNull(); // no separate button
      expect(screen.getByText(/To: me@example.com/).textContent).toContain("Cc: Bob");
      expect(newMailRequests.at(-1)).toBe("100"); // asked for everything after the starting point
      expect(played).toHaveLength(1);
      expect(played[0]).toContain("crystal_clear");
      expect(FakeNotification.created).toEqual([]); // browser notification wasn't opted into

      // Clicking the toast itself shows that message, and the toast goes away.
      await userEvent.click(snippet);
      await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(1));
      // …and the toast is dismissed (sonner flags it as removed, then drops it after its exit animation).
      await waitFor(() => expect(snippet.closest("li")?.getAttribute("data-removed")).toBe("true"));
    });

    test("the chosen sound is played, and 'none' plays nothing", async () => {
      installMockFetch({ settings: { notifyToast: true, notificationSound: "marimba" }, newMail: { total: 1, messages: [PREVIEW] } });
      await loginAndSync();
      await screen.findByText("Alice Anderson");
      expect(played).toHaveLength(1);
      expect(played[0]).toContain("marimba");

      cleanup();
      played.length = 0;
      installMockFetch({ settings: { notifyToast: true, notificationSound: "none" }, newMail: { total: 1, messages: [PREVIEW] } });
      await loginAndSync(true); // still signed in from above
      await waitFor(() => expect(screen.getAllByText("Lunch on Friday?").length).toBeGreaterThan(0));
      expect(played).toEqual([]);
    });

    test("a browser notification carries only sender and subject, and clicking it opens the message", async () => {
      installMockFetch({ settings: { notifyBrowser: true }, newMail: { total: 1, messages: [PREVIEW] } });
      await loginAndSync();

      await waitFor(() => expect(FakeNotification.created).toHaveLength(1));
      const notification = FakeNotification.created[0]!;
      expect(notification.title).toBe("Alice Anderson");
      expect(notification.options.body).toBe("Lunch on Friday?"); // no content, no snippet
      expect(played).toEqual([]); // the sound belongs to the toast
      expect(screen.queryByText(/Are you free on Friday/)).toBeNull(); // and no toast was opted into

      act(() => notification.onclick!());
      expect(notification.closed).toBe(true);
      await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(1));
    });

    test("several new mails become '20 new mails', and clicking opens the combined Inbox", async () => {
      installMockFetch({
        settings: { notifyBrowser: true, notifyToast: true },
        newMail: { total: 20, messages: [PREVIEW, { ...PREVIEW, id: 11, from: [{ address: "carl@example.com" }] }] },
      });
      await loginAndSync();

      await waitFor(() => expect(FakeNotification.created).toHaveLength(1));
      const notification = FakeNotification.created[0]!;
      expect(notification.title).toBe("20 new mails");
      expect(notification.options.body).toContain("Alice Anderson");
      expect(notification.options.body).not.toContain("Lunch on Friday"); // no subjects for a bundle

      expect((await screen.findAllByText("20 new mails")).length).toBeGreaterThan(0); // the toast, too
      act(() => notification.onclick!());
      expect(await screen.findByText("Inbox · all accounts")).toBeTruthy();
    });

    test("nothing is announced when neither is enabled — but the starting point still moves forward", async () => {
      installMockFetch({ newMail: { total: 1, messages: [PREVIEW] } });
      await loginAndSync();
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(FakeNotification.created).toEqual([]);
      expect(played).toEqual([]);
      expect(screen.queryByText("Lunch on Friday?")).toBeNull();

      await userEvent.click(screen.getByTitle("Sync now"));
      await waitFor(() => expect(newMailRequests.length).toBeGreaterThan(2));
      expect(newMailRequests.at(-1)).toBe("101"); // continues from the last answer's latestId
    });

    test("the Settings dialog saves the notification options, asking the browser for permission first", async () => {
      FakeNotification.permission = "default";
      let asked = 0;
      FakeNotification.requestPermission = async () => {
        asked += 1;
        FakeNotification.permission = "granted";
        return "granted";
      };
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await openAccountInbox();

      await userEvent.click(screen.getByTitle("Settings"));
      await userEvent.click(await screen.findByRole("tab", { name: "Notifications" }));
      expect((await screen.findByLabelText("Toast sound") as HTMLSelectElement).value).toBe("crystal_clear"); // the default
      await userEvent.click(screen.getByLabelText("Browser notification"));
      await userEvent.click(screen.getByLabelText("Toast in the app"));
      await userEvent.selectOptions(screen.getByLabelText("Toast sound"), "cute_bell");
      await userEvent.click(screen.getByTitle("Play sound"));
      expect(played.at(-1)).toContain("cute_bell");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(capturedSettingsPatches).toEqual([{ ...DEFAULT_PATCH, notifyBrowser: true, notifyToast: true, notificationSound: "cute_bell" }])
      );
      expect(asked).toBe(1);
      FakeNotification.requestPermission = async () => FakeNotification.permission;
    });

    test("blocked browser permission keeps the option from being saved and explains why", async () => {
      FakeNotification.permission = "denied";
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await openAccountInbox();

      await userEvent.click(screen.getByTitle("Settings"));
      await userEvent.click(await screen.findByRole("tab", { name: "Notifications" }));
      await userEvent.click(await screen.findByLabelText("Browser notification"));
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(await screen.findByText(/blocked notifications for this site/)).toBeTruthy();
      expect(capturedSettingsPatches).toEqual([]);
    });
  });

  test("a fallback tab (preferred one missing on this mail) is neither stored nor remembered — only an explicit pick is", async () => {
    installMockFetch({ settings: { bodyView: "md" } });
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();
    const isTabSelected = (name: string) => screen.getByRole("tab", { name }).getAttribute("aria-selected") === "true";

    await userEvent.click(await screen.findByText("Hello there"));
    await waitFor(() => expect(isTabSelected("MD")).toBe(true));

    // The draft has no HTML part, so no MD tab: it falls back to Plain…
    await userEvent.click(await screen.findByText("Unfinished draft"));
    await waitFor(() => expect(screen.queryByRole("tab", { name: "MD" })).toBeNull());
    await waitFor(() => expect(isTabSelected("Plain")).toBe(true));
    expect(capturedSettingsPatches).toEqual([]); // …without storing that

    // …and the next mail that has MD opens on it again (the in-session preference didn't drift to Plain either).
    await userEvent.click(await screen.findByText("Second message"));
    await waitFor(() => expect(isTabSelected("MD")).toBe(true));
    expect(capturedSettingsPatches).toEqual([]);

    // Explicitly picking a tab is what stores it.
    await userEvent.click(screen.getByRole("tab", { name: "Plain" }));
    await waitFor(() => expect(capturedSettingsPatches).toEqual([{ bodyView: "plain" }]));
  });

  test("the login window shows the P.S.Mail logo instead of the round mail icon", async () => {
    render(<App />);
    const logo = (await screen.findByAltText("P.S.Mail logo")) as HTMLImageElement;
    expect(logo.getAttribute("src")).toContain("psmail_logo.svg");
    expect(document.querySelector(".bg-primary\\/10")).toBeNull();
    // Centered above the title, in the card header.
    expect(logo.closest('[data-slot="card-header"]')!.textContent).toContain("P.S.Mail");
  });

  test("sync progress is a tooltip on the spinner, not a block under the account", async () => {
    installMockFetch({ syncStaysRunning: true });
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();

    await userEvent.click(screen.getByTitle("Sync now"));
    const spinner = await screen.findByTitle("Syncing 12/340…");
    expect(spinner.querySelector(".animate-spin")).toBeTruthy();
    expect(screen.queryByTitle("Sync now")).toBeNull(); // it's the progress tooltip now, not the button hint
    expect(screen.queryByText(/^Syncing/)).toBeNull(); // no extra text block
  });

  test("Reply all appears only after the pointer or focus reaches Reply, and replies to everyone", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();

    await userEvent.click(await screen.findByText("Second message"));
    await waitFor(() => expect(screen.getAllByText("Second message").length).toBeGreaterThan(1));
    expect(screen.queryByRole("button", { name: /reply all/i })).toBeNull(); // not shown up front

    await userEvent.hover(screen.getByRole("button", { name: /^reply$/i }));
    const replyAll = await screen.findByRole("button", { name: /reply all/i });
    await userEvent.click(replyAll);

    const dialog = (await screen.findByText("New message")).closest('[role="dialog"]') as HTMLElement;
    expect((within(dialog).getByLabelText("To") as HTMLInputElement).value).toBe("Bob <bob@example.com>, Dora <dora@example.com>");
    expect((within(dialog).getByLabelText("Cc") as HTMLInputElement).value).toBe("Carl <carl@example.com>");
    expect((within(dialog).getByLabelText("Subject") as HTMLInputElement).value).toBe("Re: Second message");
  });

  test("keyboard focus on Reply reveals Reply all too, and it hides again for the next message", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();

    await userEvent.click(await screen.findByText("Second message"));
    await waitFor(() => expect(screen.getAllByText("Second message").length).toBeGreaterThan(1));
    act(() => screen.getByRole("button", { name: /^reply$/i }).focus());
    expect(await screen.findByRole("button", { name: /reply all/i })).toBeTruthy();

    await userEvent.click(screen.getByText("Third message"));
    await waitFor(() => expect(screen.getAllByText("Third message").length).toBeGreaterThan(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: /reply all/i })).toBeNull());
  });

  test("the app opens on the combined Inbox", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));

    expect(await screen.findByText("Inbox · all accounts")).toBeTruthy();
    expect(await screen.findByText("Unified hello")).toBeTruthy(); // the combined list, no click needed
  });

  describe("arrow keys in the message list", () => {
    const originalMatchMedia = window.matchMedia;
    function setPointer(fine: boolean) {
      window.matchMedia = ((query: string) => ({ matches: fine && query.includes("fine"), media: query, addEventListener() {}, removeEventListener() {} })) as never;
    }
    afterEach(() => {
      window.matchMedia = originalMatchMedia;
    });

    async function openList() {
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await openAccountInbox();
      await screen.findByText("Second message");
      (document.body as HTMLElement).focus();
    }
    const isOpen = (subject: string) => screen.getAllByText(subject).length > 1; // in the list and in the reading pane

    test("Down/Up show the next/previous message", async () => {
      setPointer(true);
      await openList();

      await userEvent.keyboard("{ArrowDown}");
      await waitFor(() => expect(isOpen("Hello there")).toBe(true)); // nothing was open: the first one
      await userEvent.keyboard("{ArrowDown}");
      await waitFor(() => expect(isOpen("Second message")).toBe(true));
      await userEvent.keyboard("{ArrowDown}");
      await waitFor(() => expect(isOpen("Third message")).toBe(true));
      await userEvent.keyboard("{ArrowUp}");
      await waitFor(() => expect(isOpen("Second message")).toBe(true));
      expect(isOpen("Third message")).toBe(false);
    });

    test("Shift+arrows select a range for the bulk actions, and a plain arrow collapses it again", async () => {
      setPointer(true);
      await openList();
      await userEvent.click(screen.getByText("Hello there"));
      await waitFor(() => expect(isOpen("Hello there")).toBe(true));

      await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
      await waitFor(() => expect(screen.getByText("2 selected")).toBeTruthy());
      await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
      await waitFor(() => expect(screen.getByText("3 selected")).toBeTruthy());
      await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");
      await waitFor(() => expect(screen.getByText("2 selected")).toBeTruthy());

      await userEvent.keyboard("{ArrowDown}");
      await waitFor(() => expect(screen.queryByText(/\d+ selected/)).toBeNull());
      await waitFor(() => expect(isOpen("Third message")).toBe(true)); // from the cursor (2nd) one further
    });

    test("in search/combined results the arrows move through the results", async () => {
      setPointer(true);
      await openList();
      await userEvent.click(screen.getByTitle("Sent of all accounts"));
      await screen.findByText("Unified outgoing");
      await userEvent.click(screen.getByTitle("Inbox of all accounts"));
      await screen.findByText("Unified hello");

      await userEvent.keyboard("{ArrowDown}");
      await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(0)); // message 10 opened
      expect(screen.getByText("Inbox · all accounts")).toBeTruthy(); // still in the combined list
    });

    test("nothing happens while typing, in a dialog, or without a mouse-type pointer", async () => {
      setPointer(true);
      await openList();

      await userEvent.click(screen.getByPlaceholderText(/search all mail/i));
      await userEvent.keyboard("{ArrowDown}");
      expect(isOpen("Hello there")).toBe(false);

      (document.body as HTMLElement).focus();
      setPointer(false);
      await userEvent.keyboard("{ArrowDown}");
      expect(isOpen("Hello there")).toBe(false);

      setPointer(true);
      await userEvent.click(screen.getByRole("button", { name: /new/i }));
      await screen.findByText("New message");
      (document.body as HTMLElement).focus();
      await userEvent.keyboard("{ArrowDown}");
      expect(isOpen("Hello there")).toBe(false);
    });
  });

  describe("settings tabs and password change", () => {
    async function openSettings() {
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await openAccountInbox();
      await userEvent.click(screen.getByTitle("Settings"));
      await screen.findByRole("tab", { name: "Inboxes" });
    }

    test("the settings are split into Inboxes, Notifications and Credentials tabs", async () => {
      await openSettings();
      const isSelected = (name: string) => screen.getByRole("tab", { name }).getAttribute("aria-selected") === "true";

      expect(isSelected("Inboxes")).toBe(true); // the first tab
      expect(screen.getByLabelText("Sync interval (minutes)")).toBeTruthy();
      expect(screen.getByLabelText("Show mail from folders in the combined Inbox")).toBeTruthy();
      expect(screen.queryByLabelText("Browser notification")).toBeNull();

      await userEvent.click(screen.getByRole("tab", { name: "Notifications" }));
      expect(screen.getByLabelText("Browser notification")).toBeTruthy();
      expect(screen.getByLabelText("Toast in the app")).toBeTruthy();
      expect(screen.getByLabelText("Toast sound")).toBeTruthy();
      expect(screen.queryByLabelText("Sync interval (minutes)")).toBeNull();

      await userEvent.click(screen.getByRole("tab", { name: "Credentials" }));
      expect(screen.getByLabelText("Current password")).toBeTruthy();
      expect(screen.getByLabelText("New password")).toBeTruthy();
      expect(screen.getByLabelText("Confirm new password")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull(); // this tab has its own button
      expect(screen.getByRole("button", { name: "Change password" })).toBeTruthy();
    });

    test("edits made on different tabs are saved together, and tabs keep their values while you switch", async () => {
      await openSettings();
      await userEvent.type(screen.getByLabelText("Sync interval (minutes)"), "7");
      await userEvent.click(screen.getByRole("tab", { name: "Notifications" }));
      await userEvent.click(screen.getByLabelText("Toast in the app"));
      await userEvent.click(screen.getByRole("tab", { name: "Inboxes" }));
      expect((screen.getByLabelText("Sync interval (minutes)") as HTMLInputElement).value).toBe("7");

      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(capturedSettingsPatches).toEqual([{ ...DEFAULT_PATCH, syncIntervalMinutes: 7, notifyToast: true }]));
    });

    test("changing the password sends the current and new one, then clears the form", async () => {
      await openSettings();
      await userEvent.click(screen.getByRole("tab", { name: "Credentials" }));

      await userEvent.type(screen.getByLabelText("Current password"), "old-pw");
      await userEvent.type(screen.getByLabelText("New password"), "new-pw");
      await userEvent.type(screen.getByLabelText("Confirm new password"), "new-pw");
      await userEvent.click(screen.getByRole("button", { name: "Change password" }));

      await waitFor(() => expect(passwordChanges).toEqual([{ currentPassword: "old-pw", newPassword: "new-pw" }]));
      expect((await screen.findAllByText(/Password changed\. 2 other sessions were signed out/)).length).toBeGreaterThan(0);
      expect((screen.getByLabelText("New password") as HTMLInputElement).value).toBe("");
      expect((screen.getByLabelText("Current password") as HTMLInputElement).value).toBe("");
    });

    test("a mismatched confirmation is caught before anything is sent", async () => {
      await openSettings();
      await userEvent.click(screen.getByRole("tab", { name: "Credentials" }));

      await userEvent.type(screen.getByLabelText("New password"), "one");
      await userEvent.type(screen.getByLabelText("Confirm new password"), "two");
      await userEvent.click(screen.getByRole("button", { name: "Change password" }));
      expect(await screen.findByText(/don't match/)).toBeTruthy();
      expect(passwordChanges).toEqual([]);
    });

    test("an empty new password is allowed and removes the password", async () => {
      await openSettings();
      await userEvent.click(screen.getByRole("tab", { name: "Credentials" }));

      await userEvent.type(screen.getByLabelText("Current password"), "old-pw");
      await userEvent.click(screen.getByRole("button", { name: "Change password" })); // both new fields left empty

      await waitFor(() => expect(passwordChanges).toEqual([{ currentPassword: "old-pw", newPassword: "" }]));
      expect((await screen.findAllByText(/Password removed\./)).length).toBeGreaterThan(0);
    });

    test("the server's refusal (wrong current password) is shown and the fields are kept", async () => {
      installMockFetch({ changePasswordError: "Current password is incorrect" });
      await openSettings();
      await userEvent.click(screen.getByRole("tab", { name: "Credentials" }));

      await userEvent.type(screen.getByLabelText("Current password"), "nope");
      await userEvent.type(screen.getByLabelText("New password"), "new-pw");
      await userEvent.type(screen.getByLabelText("Confirm new password"), "new-pw");
      await userEvent.click(screen.getByRole("button", { name: "Change password" }));

      expect(await screen.findByText("Current password is incorrect")).toBeTruthy();
      expect((screen.getByLabelText("New password") as HTMLInputElement).value).toBe("new-pw");
    });
  });

  describe("bulk selection in the combined lists", () => {
    const row = (id: number, subject: string, accountEmail: string, extra: Record<string, unknown> = {}) => ({
      id, accountEmail, folder: "INBOX", uid: id, isRead: false, isFlagged: false, subject,
      from: [{ name: "Alice", address: "alice@example.com" }], date: NOW, ...extra,
    });
    const ROWS = [
      row(10, "Mine one", "me@example.com"),
      row(11, "Mine two", "me@example.com"),
      row(12, "Theirs three", "you@example.com"),
    ];
    const rowOf = (subject: string) => screen.getByText(subject).closest("li")!;
    const selectedRows = () => ROWS.filter(r => rowOf(r.subject as string).firstElementChild!.className.includes("ring-primary"));

    async function openCombined() {
      installMockFetch({ unifiedInboxRows: ROWS });
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await screen.findByText("Mine one"); // the app opens on the combined Inbox
    }

    test("Cmd/Ctrl+click and Shift+click select rows, across accounts", async () => {
      await openCombined();

      fireEvent.click(screen.getByText("Mine one"), { ctrlKey: true });
      await waitFor(() => expect(screen.getByText("1 selected")).toBeTruthy());
      expect(screen.getByText("Select a message")).toBeTruthy(); // the reading pane wasn't touched

      fireEvent.click(screen.getByText("Theirs three"), { shiftKey: true }); // range from the anchor, over both accounts
      await waitFor(() => expect(screen.getByText("3 selected")).toBeTruthy());
      expect(selectedRows().map(r => r.id)).toEqual([10, 11, 12]);

      fireEvent.click(screen.getByText("Mine two"), { ctrlKey: true }); // toggles one out
      await waitFor(() => expect(screen.getByText("2 selected")).toBeTruthy());

      await userEvent.click(screen.getByText("Mine one")); // a plain click reads it and drops the selection
      await waitFor(() => expect(screen.queryByText(/\d+ selected/)).toBeNull());
    });

    test("Cmd/Ctrl+A and Shift+arrows work in the combined list too", async () => {
      await openCombined();
      (document.body as HTMLElement).focus();

      await userEvent.keyboard("{Control>}a{/Control}");
      await waitFor(() => expect(screen.getByText("3 selected")).toBeTruthy());

      await userEvent.click(screen.getByTitle("Clear selection"));
      await waitFor(() => expect(screen.queryByText(/\d+ selected/)).toBeNull());

      await userEvent.click(screen.getByText("Mine one"));
      (document.body as HTMLElement).focus();
      await userEvent.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
      await waitFor(() => expect(screen.getByText("3 selected")).toBeTruthy());
    });

    test("marking read sends one bulk request per account and updates the rows", async () => {
      await openCombined();
      await userEvent.click(screen.getByText("Mine one"));
      (document.body as HTMLElement).focus();
      await userEvent.keyboard("{Control>}a{/Control}");
      await waitFor(() => expect(screen.getByText("3 selected")).toBeTruthy());

      await userEvent.click(screen.getByTitle("Mark as read"));
      await waitFor(() =>
        expect(bulkRequests).toEqual([
          { account: "me@example.com", method: "PATCH", move: null, body: expect.objectContaining({ ids: [10, 11], isRead: true }) },
          { account: "you@example.com", method: "PATCH", move: null, body: expect.objectContaining({ ids: [12], isRead: true }) },
        ])
      );
      await waitFor(() => expect(screen.queryByText(/\d+ selected/)).toBeNull());
      for (const r of ROWS) expect(rowOf(r.subject as string).querySelector(".bg-primary.rounded-full")).toBeNull(); // no unread dots left
    });

    test("Move is offered only when the selection is from a single account", async () => {
      await openCombined();
      fireEvent.click(screen.getByText("Mine one"), { ctrlKey: true });
      fireEvent.click(screen.getByText("Mine two"), { ctrlKey: true });
      await waitFor(() => expect(screen.getByText("2 selected")).toBeTruthy());
      await waitFor(() => expect(screen.getByTitle("Move")).toBeTruthy());

      fireEvent.click(screen.getByText("Theirs three"), { ctrlKey: true });
      await waitFor(() => expect(screen.getByText("3 selected")).toBeTruthy());
      expect(screen.queryByTitle("Move")).toBeNull();
    });

    test("moving a single account's selection sends one bulk move and the rows leave the combined Inbox", async () => {
      await openCombined();
      fireEvent.click(screen.getByText("Mine one"), { ctrlKey: true });
      fireEvent.click(screen.getByText("Mine two"), { ctrlKey: true });
      await waitFor(() => expect(screen.getByText("2 selected")).toBeTruthy());

      await userEvent.click(await screen.findByTitle("Move"));
      await userEvent.click(await screen.findByRole("menuitem", { name: "Entwürfe" })); // the account's folders, minus INBOX where they all are

      await waitFor(() => expect(bulkRequests).toEqual([{ account: "me@example.com", method: "PATCH", move: "Entwürfe", body: expect.objectContaining({ ids: [10, 11] }) }]));
      await waitFor(() => expect(screen.queryByText("Mine one")).toBeNull());
      expect(screen.getByText("Theirs three")).toBeTruthy(); // the other account's message stays
    });

    test("deleting across accounts confirms (the permanent ones), then deletes per account and removes the rows", async () => {
      await openCombined();
      (document.body as HTMLElement).focus();
      await userEvent.keyboard("{Control>}a{/Control}");
      await waitFor(() => expect(screen.getByText("3 selected")).toBeTruthy());

      await userEvent.click(screen.getByTitle("Delete"));
      const confirm = await screen.findByRole("alertdialog");
      expect(bulkRequests).toEqual([]); // not before the confirmation
      await userEvent.click(within(confirm).getByRole("button", { name: /delete/i }));

      await waitFor(() => expect(bulkRequests.map(r => [r.account, r.method, r.body.ids])).toEqual([
        ["me@example.com", "DELETE", [10, 11]],
        ["you@example.com", "DELETE", [12]],
      ]));
      await waitFor(() => expect(screen.queryByText("Mine one")).toBeNull());
      expect(screen.queryByText("Theirs three")).toBeNull();
    });

    test("a new search or another mailbox starts with a clean selection", async () => {
      await openCombined();
      fireEvent.click(screen.getByText("Mine one"), { ctrlKey: true });
      await waitFor(() => expect(screen.getByText("1 selected")).toBeTruthy());

      await userEvent.click(screen.getByTitle("Sent of all accounts"));
      await waitFor(() => expect(screen.queryByText(/\d+ selected/)).toBeNull());
    });
  });

  describe("recipient suggestions from other accounts", () => {
    async function openTo() {
      installMockFetch({ otherAccountContacts: true });
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await openAccountInbox();
      await userEvent.click(screen.getByRole("button", { name: /new/i }));
      return (await screen.findByLabelText("To")) as HTMLInputElement;
    }

    test("other accounts' matches follow this account's, under their own heading", async () => {
      const to = await openTo();
      await userEvent.type(to, "al");

      const options = await screen.findAllByRole("option");
      expect(options.map(o => o.textContent)).toEqual(["Alice Anderson alice@example.com", "albert@example.com", "Alva Other alva@other.com"]);
      expect(contactRequests.every(scope => scope === "all")).toBe(true);

      // The heading sits between the two groups, right before the first other-account contact.
      const heading = screen.getByText("From your other accounts");
      expect(heading.getAttribute("role")).toBe("presentation");
      expect(heading.nextElementSibling).toBe(options[2]!);
      expect(options[1]!.nextElementSibling).toBe(heading);
    });

    test("arrow keys walk through both groups, and accepting one from another account fills it in", async () => {
      const to = await openTo();
      await userEvent.type(to, "al");
      await screen.findAllByRole("option");

      await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}"); // 1st -> 2nd -> 3rd (the other account's)
      expect(to.value).toBe("Alva Other <alva@other.com>, ");
    });

    test("without matches elsewhere there is no heading", async () => {
      installMockFetch();
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await openAccountInbox();
      await userEvent.click(screen.getByRole("button", { name: /new/i }));
      await userEvent.type(await screen.findByLabelText("To"), "al");
      await screen.findAllByRole("option");
      expect(screen.queryByText("From your other accounts")).toBeNull();
    });
  });

  describe("initial load", () => {
    test("accounts start collapsed (nothing is selected yet) and expand when clicked", async () => {
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await waitFor(() => expect(screen.getAllByText("me@example.com").length).toBeGreaterThan(0), { timeout: 3000 });
      await screen.findByText("Unified hello"); // the combined Inbox is showing: no account is selected

      expect(screen.queryByText("Entwürfe")).toBeNull(); // none of the account's folders are shown
      expect(screen.getAllByText("Inbox")).toHaveLength(1); // only the combined Inbox row

      await userEvent.click(screen.getAllByText("me@example.com")[0]!);
      expect(await screen.findByText("Entwürfe")).toBeTruthy();

      // And collapse again.
      await userEvent.click(screen.getAllByText("me@example.com")[0]!);
      await waitFor(() => expect(screen.queryByText("Entwürfe")).toBeNull());
    });

    test("a sync that was already running when the page loaded shows its spinner and progress, and is followed to the end", async () => {
      installMockFetch({ earlierSyncJob: "running", syncStaysRunning: true });
      render(<App />);
      await userEvent.click(await screen.findByText("default"));

      // No click on "Sync now": the running job is found in the account's job history.
      const spinner = await screen.findByTitle("Syncing 12/340…"); // 5/10 at first, then the poll's 12/340
      expect(spinner.querySelector(".animate-spin")).toBeTruthy();
    });

    test("when that sync then finishes, the app refreshes like after any sync", async () => {
      installMockFetch({ earlierSyncJob: "running" }); // GET job answers "completed"
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await waitFor(() => expect(newMailRequests.length).toBeGreaterThan(1), { timeout: 3000 }); // announceNewMail ran: the sync ended
      await waitFor(() => expect(screen.queryByTitle(/^Syncing/)).toBeNull());
      expect(screen.getByTitle("Sync now")).toBeTruthy(); // usable again
    });

    test("a finished earlier job (or none) shows no spinner", async () => {
      installMockFetch({ earlierSyncJob: "completed" });
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await screen.findByTitle("Sync now");
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(screen.queryByTitle(/^Syncing/)).toBeNull();
    });
  });

  describe("message header details", () => {
    const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ name: `${prefix} Person ${i}`, address: `${prefix.toLowerCase()}${i}@example.com` }));
    const email = { ...EMAIL, to: many("To", 40), cc: many("Cc", 40), bcc: many("Bcc", 5), messageId: "<abc123@mail.example.com>" } as never;

    async function openDetails() {
      render(<MessageHeader email={email} />);
      await userEvent.click(screen.getByRole("button", { name: /^to /i })); // the summary line opens the details box
    }
    const line = (label: string) => screen.getByText(label).nextElementSibling as HTMLElement;

    test("the 'to' summary line under the sender is left-aligned (buttons center their text by default)", () => {
      render(<MessageHeader email={email} />);
      const summary = screen.getByRole("button", { name: /^to /i });
      expect(summary.className).toContain("text-left");
      expect(summary.className).toContain("justify-start");
    });

    test("the Message-ID is hidden by default", async () => {
      await openDetails();
      expect(screen.queryByText("Message-ID")).toBeNull();
      expect(screen.queryByText("<abc123@mail.example.com>")).toBeNull();
    });

    test("To, Cc and Bcc are clamped to a few lines with an ellipsis by default", async () => {
      await openDetails();
      for (const label of ["To", "Cc", "Bcc"]) {
        const value = line(label);
        expect(value.className).toContain("line-clamp-3"); // ellipsis after three lines
        expect(value.className).toContain("max-h-16"); // ≈ 4rem
        expect(value.className).toContain("overflow-hidden");
      }
    });

    test("'Expand all details' shows everything, including the Message-ID, and collapses again", async () => {
      await openDetails();
      await userEvent.click(screen.getByRole("button", { name: "Expand all details" }));

      expect(screen.getByText("Message-ID")).toBeTruthy();
      expect(screen.getByText("<abc123@mail.example.com>")).toBeTruthy();
      for (const label of ["To", "Cc", "Bcc"]) expect(line(label).className).not.toContain("line-clamp");
      expect(line("Cc").textContent).toContain("Cc Person 39"); // the whole list is in there

      await userEvent.click(screen.getByRole("button", { name: "Collapse details" }));
      expect(screen.queryByText("<abc123@mail.example.com>")).toBeNull();
      expect(line("Cc").className).toContain("line-clamp-3");
    });

    test("the expanded state doesn't carry over to the next message", async () => {
      const { rerender } = render(<MessageHeader email={email} />);
      await userEvent.click(screen.getByRole("button", { name: /^to /i }));
      await userEvent.click(screen.getByRole("button", { name: "Expand all details" }));
      expect(screen.getByText("<abc123@mail.example.com>")).toBeTruthy();

      rerender(<MessageHeader email={{ ...(email as object), id: 999 } as never} />);
      await waitFor(() => expect(screen.queryByText("<abc123@mail.example.com>")).toBeNull());
    });
  });

  describe("AI", () => {
    const originalConfirm = window.confirm;
    beforeEach(() => {
      window.confirm = () => true;
    });
    afterEach(() => {
      window.confirm = originalConfirm;
    });

    async function login() {
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await openAccountInbox();
    }
    async function openAiTab() {
      await userEvent.click(screen.getByTitle("Settings"));
      await userEvent.click(await screen.findByRole("tab", { name: "AI" }));
    }
    const calls = (method: string, path: string) => aiRequests.filter(([m, p]) => m === method && p === path).map(([, , body]) => body);

    test("Settings has an AI tab between Notifications and Credentials", async () => {
      await login();
      await userEvent.click(screen.getByTitle("Settings"));
      const tabs = (await screen.findAllByRole("tab")).map(t => t.textContent);
      expect(tabs).toEqual(["Inboxes", "Notifications", "AI", "Credentials"]);
    });

    test("adding an AI provider sends vendor, model and key, and the list never shows the key", async () => {
      installMockFetch();
      await login();
      await openAiTab();
      expect(await screen.findByText(/No provider yet/)).toBeTruthy();

      await userEvent.click(screen.getByRole("button", { name: /add provider/i }));
      await userEvent.selectOptions(screen.getByLabelText("Vendor"), "anthropic");
      await userEvent.type(screen.getByLabelText("Model"), "claude-opus-5");
      await userEvent.type(screen.getByLabelText(/API key/), "sk-ant-secret");
      await userEvent.click(screen.getByRole("button", { name: "Save provider" }));

      await waitFor(() => expect(calls("POST", "/api/ai/apis")).toEqual([{ name: "", vendor: "anthropic", model: "claude-opus-5", baseUrl: null, apiKey: "sk-ant-secret" }]));
      expect(await screen.findByText("Anthropic.claude-opus-5")).toBeTruthy(); // unnamed: shown as Vendor.model
      expect(screen.getByText(/Anthropic · claude-opus-5 · key saved/)).toBeTruthy();
      expect(document.body.textContent).not.toContain("sk-ant-secret");
    });

    test("a provider's name is optional: the form says what it will be called, and it is shown as Vendor.model when empty", async () => {
      installMockFetch();
      await login();
      await openAiTab();
      await userEvent.click(await screen.findByRole("button", { name: /add provider/i }));
      const name = () => screen.getByLabelText("Name (optional)") as HTMLInputElement;

      await userEvent.selectOptions(screen.getByLabelText("Vendor"), "openai");
      await userEvent.type(screen.getByLabelText("Model"), "gpt-5");
      expect(name().value).toBe(""); // nothing is filled in
      expect(name().placeholder).toBe("OpenAI.gpt-5");
      expect(screen.getByText("Empty: OpenAI.gpt-5.")).toBeTruthy();

      await userEvent.type(screen.getByLabelText(/API key/), "sk-x");
      await userEvent.click(screen.getByRole("button", { name: "Save provider" }));
      await waitFor(() => expect(calls("POST", "/api/ai/apis")).toEqual([expect.objectContaining({ name: "", vendor: "openai", model: "gpt-5" })]));
      expect(await screen.findByText("OpenAI.gpt-5")).toBeTruthy();

      // With a name of its own, that is what's shown — also when picking the provider for a skill.
      await userEvent.click(screen.getByRole("button", { name: /add provider/i }));
      await userEvent.type(screen.getByLabelText("Model"), "claude-opus-5");
      await userEvent.type(screen.getByLabelText(/API key/), "sk-y");
      await userEvent.type(screen.getByLabelText("Name (optional)"), "Work Claude");
      await userEvent.click(screen.getByRole("button", { name: "Save provider" }));
      expect(await screen.findByText("Work Claude")).toBeTruthy();

      await userEvent.click(screen.getByRole("button", { name: /add skill/i }));
      const providers = Array.from((screen.getByLabelText("AI provider") as HTMLSelectElement).options).map(o => o.textContent);
      expect(providers).toEqual(["OpenAI.gpt-5", "Work Claude"]);
    });

    test("editing a provider keeps its key unless a new one is typed; Test reports the result", async () => {
      installMockFetch({ aiApis: [{ id: 1, name: "Work", vendor: "openai", model: "gpt-5", baseUrl: null, hasKey: true }] });
      await login();
      await openAiTab();

      await userEvent.click(await screen.findByTitle("Test Work"));
      expect((await screen.findAllByText(/Work works — it answered "OK"/)).length).toBeGreaterThan(0);
      expect(calls("POST", "/api/ai/apis/1/test")).toHaveLength(1);
    });

    test("a new skill suggests the prompt of its category, follows category changes until you edit it, and saves against a provider", async () => {
      installMockFetch({ aiApis: [{ id: 1, name: "Work Claude", vendor: "anthropic", model: "claude-opus-5", baseUrl: null, hasKey: true }] });
      await login();
      await openAiTab();

      await userEvent.click(await screen.findByRole("button", { name: /add skill/i }));
      const prompt = () => (screen.getByLabelText("Instruction (prompt)") as HTMLTextAreaElement).value;
      expect(prompt()).toContain("summarizes e-mail messages"); // first category, suggested

      await userEvent.selectOptions(screen.getByLabelText("Category"), "translate");
      expect(prompt()).toContain("helpful translator");
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Translate"); // named after the category, as suggested

      // Once edited by hand, changing the category leaves the prompt alone…
      await userEvent.type(screen.getByLabelText("Instruction (prompt)"), " Be brief.");
      await userEvent.selectOptions(screen.getByLabelText("Category"), "grammar");
      expect(prompt()).toContain("helpful translator");
      // …until the suggestion is asked for explicitly.
      await userEvent.click(screen.getByRole("button", { name: "Use suggested prompt" }));
      expect(prompt()).toContain("careful proofreader");

      await userEvent.click(screen.getByRole("button", { name: "Save skill" }));
      await waitFor(() => expect(calls("POST", "/api/ai/skills")).toHaveLength(1));
      expect(calls("POST", "/api/ai/skills")[0]).toMatchObject({ category: "grammar", aiApiId: 1, name: "Spelling + Grammar", prompt: expect.stringContaining("careful proofreader") });
      expect(await screen.findByText(/Spelling \+ Grammar · Work Claude/)).toBeTruthy(); // category · provider
    });

    test("skills need a provider first, and deleting a provider takes its skills along", async () => {
      installMockFetch({ aiApis: [{ id: 1, name: "Work", vendor: "openai", model: "gpt-5", baseUrl: null, hasKey: true }], aiSkillCategories: ["summarize"] });
      await login();
      await openAiTab();
      expect(await screen.findByText(/Summarize · Work/)).toBeTruthy();

      await userEvent.click(screen.getByTitle("Delete Work"));
      await waitFor(() => expect(calls("DELETE", "/api/ai/apis/1")).toHaveLength(1));
      await waitFor(() => expect(screen.queryByText(/Summarize · Work/)).toBeNull());
      expect(screen.getByRole("button", { name: /add skill/i }).hasAttribute("disabled")).toBe(true);
    });

    test("the translation language is saved to the user settings", async () => {
      installMockFetch();
      await login();
      await openAiTab();
      const input = await screen.findByLabelText("Translation language");
      await userEvent.type(input, "German");
      await userEvent.tab(); // leaves the field: saved
      await waitFor(() => expect(capturedSettingsPatches).toEqual([{ aiTargetLanguage: "German" }]));
    });

    test("without AI skills there are no AI buttons at all: no Summarize, Translate, Summary tab or Refine", async () => {
      installMockFetch();
      await login();
      await userEvent.click(await screen.findByText("Hello there"));
      await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(1));
      expect(screen.queryByRole("button", { name: /summarize/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /^translate/i })).toBeNull();
      expect(screen.queryByRole("tab", { name: "Summary" })).toBeNull();

      await userEvent.click(screen.getByRole("button", { name: /new/i }));
      const dialog = (await screen.findByText("New message")).closest('[role="dialog"]') as HTMLElement;
      expect(within(dialog).queryByRole("button", { name: /refine/i })).toBeNull();
    });

    test("each button appears only for the skill that exists", async () => {
      installMockFetch({ aiSkillCategories: ["translate"] });
      await login();
      await userEvent.click(await screen.findByText("Hello there"));
      await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(1));
      expect(await screen.findByRole("button", { name: /^translate/i })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /summarize/i })).toBeNull();
      expect(screen.queryByRole("tab", { name: "Summary" })).toBeNull();
    });

    test("Summary is an extra tab after HTML, with the AI icon; it is offered only with a Summarize skill (or an existing summary)", async () => {
      installMockFetch();
      await login();
      await userEvent.click(await screen.findByText("Hello there"));
      await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(1));
      expect(screen.queryByRole("tab", { name: "Summary" })).toBeNull(); // no skill, no summary yet

      cleanup();
      installMockFetch({ aiSkillCategories: ["summarize"] });
      render(<App />); // still signed in
      await openAccountInbox();
      await userEvent.click(await screen.findByText("Hello there"));
      const tab = await screen.findByRole("tab", { name: "Summary" });

      const names = screen.getAllByRole("tab").map(t => t.textContent!.trim());
      expect(names.at(-1)).toBe("Summary"); // the last one
      expect(names.indexOf("HTML")).toBeLessThan(names.indexOf("Summary"));
      expect(tab.querySelector("svg")).toBeTruthy(); // the sparkles icon marks it as AI
    });

    test("the Summary tab offers to summarize; the result (with the categories) shows in the tab, which opens by itself", async () => {
      installMockFetch({ aiSkillCategories: ["summarize", "categorize"] });
      await login();
      await userEvent.click(await screen.findByText("Hello there"));
      await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(1));
      const tab = await screen.findByRole("tab", { name: "Summary" });
      expect(screen.queryByLabelText("Categories")).toBeNull();

      await userEvent.click(tab);
      expect(await screen.findByText(/No summary yet/)).toBeTruthy();
      expect(capturedSettingsPatches).toEqual([]); // a transient tab: not stored as the preferred view

      await userEvent.click(screen.getByRole("button", { name: "Summarize with AI" }));
      expect(await screen.findByText(/Alice says hello/)).toBeTruthy();
      const chips = within(screen.getByLabelText("Categories")).getAllByRole("listitem").map(li => li.textContent);
      expect(chips).toEqual(["greeting", "personal"]);
      expect(screen.getByRole("button", { name: "Summarize again" })).toBeTruthy();
      expect(aiRequests.some(([m, p]) => m === "POST" && p === "/api/accounts/me%40example.com/emails/10/ai/summarize")).toBe(true);
    });

    test("summarizing happens in the Summary tab (the toolbar has no Summarize button) and the result stays there", async () => {
      installMockFetch({ aiSkillCategories: ["summarize"] });
      await login();
      await userEvent.click(await screen.findByText("Hello there"));
      await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(1));
      expect(screen.queryByRole("button", { name: /^summarize$/i })).toBeNull();

      await userEvent.click(await screen.findByRole("tab", { name: "Summary" }));
      await userEvent.click(screen.getByRole("button", { name: "Summarize with AI" }));

      expect(await screen.findByText(/Alice says hello/)).toBeTruthy();
      await waitFor(() => expect(screen.getByRole("tab", { name: "Summary" }).getAttribute("aria-selected")).toBe("true"));
    });

    test("Translate adds a Translation tab and shows it", async () => {
      installMockFetch({ aiSkillCategories: ["translate"] });
      await login();
      await userEvent.click(await screen.findByText("Hello there"));
      await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(1));
      expect(screen.queryByRole("tab", { name: "Translation" })).toBeNull();

      await userEvent.click(screen.getByRole("button", { name: /^translate/i }));
      const tab = await screen.findByRole("tab", { name: "Translation" });
      await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
      expect(await screen.findByText(/Hallo, Welt/)).toBeTruthy();
      expect(screen.getByText(/Translated into English by AI/)).toBeTruthy();
      expect(capturedSettingsPatches).toEqual([]); // switching to it isn't stored as the preferred view
    });

    async function openDraftInCompose() {
      await userEvent.click(await screen.findByText("Unfinished draft"));
      await waitFor(() => expect(screen.getAllByText("Unfinished draft").length).toBeGreaterThan(1));
      await userEvent.click(screen.getByRole("button", { name: /edit draft/i }));
      const dialog = (await screen.findByText("Edit draft", { selector: "[data-slot=dialog-title]" })).closest('[role="dialog"]') as HTMLElement;
      await waitFor(() => expect(dialog.querySelector(".psmail-markdown-editor .TinyMDE")!.textContent).toContain("Getting there"));
      return dialog;
    }
    const editorText = (dialog: HTMLElement) => dialog.querySelector(".psmail-markdown-editor .TinyMDE")!.textContent!;

    test("Refine offers Phrase, Spelling + Grammar and Translate, runs the skill on the draft and can be undone", async () => {
      installMockFetch({ aiSkillCategories: ["grammar", "improve", "translate"] });
      await login();
      const dialog = await openDraftInCompose();

      await userEvent.click(within(dialog).getByRole("button", { name: /refine/i }));
      const items = (await screen.findAllByRole("menuitem")).map(i => i.textContent);
      expect(items).toEqual(["Phrase", "Spelling + Grammar", "Translate…"]);

      await userEvent.click(screen.getByRole("menuitem", { name: "Spelling + Grammar" }));
      await waitFor(() => expect(editorText(dialog)).toContain("Corrected text"));
      expect(calls("POST", "/api/ai/run")).toEqual([{ category: "grammar", text: "Getting there...", skillId: 1 }]);

      await userEvent.click(within(dialog).getByRole("button", { name: /undo/i }));
      await waitFor(() => expect(editorText(dialog)).toContain("Getting there"));
      expect(editorText(dialog)).not.toContain("Corrected");
    });

    test("Translate in Refine asks for the language (default: the user's setting) and passes it on", async () => {
      installMockFetch({ aiSkillCategories: ["translate"], settings: { aiTargetLanguage: "French" } });
      await login();
      const dialog = await openDraftInCompose();

      await userEvent.click(within(dialog).getByRole("button", { name: /refine/i }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "Translate…" }));
      const language = within(dialog).getByLabelText("Translate into") as HTMLInputElement;
      expect(language.value).toBe("French");
      await userEvent.clear(language);
      await userEvent.type(language, "Spanish");
      await userEvent.click(within(dialog).getByRole("button", { name: "Translate" }));

      await waitFor(() => expect(calls("POST", "/api/ai/run")).toEqual([{ category: "translate", text: "Getting there...", language: "Spanish", skillId: 1 }]));
      await waitFor(() => expect(editorText(dialog)).toContain("Corrected text"));
    });

    test("Refine only lists the skills that exist", async () => {
      installMockFetch({ aiSkillCategories: ["grammar"] });
      await login();
      const dialog = await openDraftInCompose();

      await userEvent.click(within(dialog).getByRole("button", { name: /refine/i }));
      expect((await screen.findAllByRole("menuitem")).map(i => i.textContent)).toEqual(["Spelling + Grammar"]);
    });

    describe("running an AI skill again", () => {
      const summarizePosts = () => aiRequests.filter(([m, p]) => m === "POST" && p.endsWith("/ai/summarize")).length;
      const translatePosts = () => aiRequests.filter(([m, p]) => m === "POST" && p.endsWith("/ai/translate")).length;
      async function openMessage() {
        await userEvent.click(await screen.findByText("Hello there"));
        await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(1));
      }
      const openSummaryTab = async () => {
        await userEvent.click(await screen.findByRole("tab", { name: "Summary" }));
      };

      test("summarizing an already summarized message asks first; Cancel leaves it, confirming runs it again", async () => {
        installMockFetch({ aiSkillCategories: ["summarize"] });
        await login();
        await openMessage();
        await openSummaryTab();

        await userEvent.click(screen.getByRole("button", { name: "Summarize with AI" })); // the first time: no question
        expect(await screen.findByText(/Alice says hello/)).toBeTruthy();
        expect(summarizePosts()).toBe(1);
        expect(screen.queryByRole("alertdialog")).toBeNull();

        // Again asks before spending another AI call.
        await userEvent.click(screen.getByRole("button", { name: "Summarize again" }));
        const dialog = await screen.findByRole("alertdialog");
        expect(within(dialog).getByText("Summarize again?")).toBeTruthy();
        expect(summarizePosts()).toBe(1);

        await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        expect(summarizePosts()).toBe(1);

        await userEvent.click(screen.getByRole("button", { name: "Summarize again" }));
        await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Summarize again" }));
        await waitFor(() => expect(summarizePosts()).toBe(2));
      });

      test("the same for translating", async () => {
        installMockFetch({ aiSkillCategories: ["translate"] });
        await login();
        await openMessage();

        await userEvent.click(screen.getByRole("button", { name: /^translate/i }));
        expect(await screen.findByText(/Hallo, Welt/)).toBeTruthy();
        expect(translatePosts()).toBe(1);

        await userEvent.click(screen.getByRole("button", { name: /^translate/i }));
        const dialog = await screen.findByRole("alertdialog");
        expect(within(dialog).getByText("Translate again?")).toBeTruthy();
        expect(translatePosts()).toBe(1);

        await userEvent.click(within(dialog).getByRole("button", { name: "Translate again" }));
        await waitFor(() => expect(translatePosts()).toBe(2));
      });

      test("with several skills the question comes after choosing one, and the choice is kept", async () => {
        installMockFetch({ aiSkillCategories: ["summarize:Short", "summarize:Detailed"] });
        await login();
        await openMessage();
        await openSummaryTab();

        await userEvent.click(screen.getByRole("button", { name: /^summarize with ai/i }));
        await userEvent.click(await screen.findByRole("menuitem", { name: "Short" }));
        await waitFor(() => expect(summarizePosts()).toBe(1));

        await userEvent.click(await screen.findByRole("button", { name: /^summarize again/i }));
        await userEvent.click(await screen.findByRole("menuitem", { name: "Detailed" }));
        await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Summarize again" }));
        await waitFor(() => expect(summarizePosts()).toBe(2));
        expect(aiRequests.filter(([, p]) => p.endsWith("/ai/summarize")).map(([, , body]) => body)).toEqual([{ skillId: 1 }, { skillId: 2 }]);
      });
    });

    describe("several skills of one category", () => {
      async function openMessage() {
        await userEvent.click(await screen.findByText("Hello there"));
        await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(1));
      }
      /** Summarizing lives in the Summary tab: open it (the tab is there whenever a Summarize skill exists). */
      async function openSummaryTab() {
        await userEvent.click(await screen.findByRole("tab", { name: "Summary" }));
      }
      const posts = (suffix: string) => aiRequests.filter(([m, p]) => m === "POST" && p.endsWith(suffix)).map(([, , body]) => body);

      test("one skill: the button runs it right away, and unnamed skills aren't offered as a choice", async () => {
        installMockFetch({ aiSkillCategories: ["summarize"] });
        await login();
        await openMessage();
        await openSummaryTab();
        await userEvent.click(screen.getByRole("button", { name: "Summarize with AI" }));
        await waitFor(() => expect(posts("/ai/summarize")).toEqual([{ skillId: 1 }]));
        expect(screen.queryByRole("menuitem")).toBeNull();
      });

      test("several summarizers: the Summary tab's button shows one entry per skill, labelled with its name", async () => {
        installMockFetch({ aiSkillCategories: ["summarize:Short", "summarize", "summarize:Detailed"] });
        await login();
        await openMessage();
        await openSummaryTab();

        await userEvent.click(screen.getByRole("button", { name: /^summarize with ai/i }));
        expect((await screen.findAllByRole("menuitem")).map(i => i.textContent)).toEqual(["Short", "summarize", "Detailed"]);
        expect(posts("/ai/summarize")).toEqual([]); // the click only opened the menu

        await userEvent.click(screen.getByRole("menuitem", { name: "Detailed" }));
        await waitFor(() => expect(posts("/ai/summarize")).toEqual([{ skillId: 3 }]));
        // Once there is a summary, its button is the same kind of menu.
        await userEvent.click(await screen.findByRole("button", { name: "Summarize again" }));
        expect((await screen.findAllByRole("menuitem")).map(i => i.textContent)).toEqual(["Short", "summarize", "Detailed"]);
      });

      test("several translators work the same way, and the chosen one is used", async () => {
        installMockFetch({ aiSkillCategories: ["translate:Formal", "translate:Casual"] });
        await login();
        await openMessage();

        await userEvent.click(screen.getByRole("button", { name: /^translate/i }));
        await userEvent.click(await screen.findByRole("menuitem", { name: "Casual" }));
        await waitFor(() => expect(posts("/ai/translate")).toEqual([{ skillId: 2 }]));
      });

      test("Refine lists each skill of Phrase / Spelling + Grammar / Translate by name and runs the chosen one", async () => {
        installMockFetch({ aiSkillCategories: ["improve:Formal", "improve:Casual", "grammar", "translate:DeepL-ish", "translate:Local"] });
        await login();
        await userEvent.click(await screen.findByText("Unfinished draft"));
        await waitFor(() => expect(screen.getAllByText("Unfinished draft").length).toBeGreaterThan(1));
        await userEvent.click(screen.getByRole("button", { name: /edit draft/i }));
        const dialog = (await screen.findByText("Edit draft", { selector: "[data-slot=dialog-title]" })).closest('[role="dialog"]') as HTMLElement;
        await waitFor(() => expect(dialog.querySelector(".psmail-markdown-editor .TinyMDE")!.textContent).toContain("Getting there"));

        await userEvent.click(within(dialog).getByRole("button", { name: /refine/i }));
        expect((await screen.findAllByRole("menuitem")).map(i => i.textContent)).toEqual([
          "Phrase · Formal",
          "Phrase · Casual",
          "Spelling + Grammar", // a single skill keeps the plain title
          "Translate… · DeepL-ish",
          "Translate… · Local",
        ]);

        await userEvent.click(screen.getByRole("menuitem", { name: "Phrase · Casual" }));
        await waitFor(() => expect(calls("POST", "/api/ai/run")).toEqual([{ category: "improve", text: "Getting there...", skillId: 2 }]));
      });
    });
  });
});
