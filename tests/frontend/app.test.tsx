import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PLAIN_UI, UiSettingsContext } from "../../src/contexts/UiSettingsContext";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { App } from "../../src/App";
import { MessageHeader } from "../../src/components/mail/MessageHeader";
import { EventsButton } from "../../src/components/mail/EventsButton";
import { MessageList } from "../../src/components/mail/MessageList";
import { ConversationBar } from "../../src/components/mail/ConversationBar";
import { MessageToolbar } from "../../src/components/mail/MessageToolbar";
import { installFakeAuthenticator, type FakeAuthenticator } from "../helpers/fakeAuthenticator";
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
  disabled: false,
  skipSoftDelete: false,
  excludeFromAutoSync: false,
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
const ics = (...lines: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", ...lines, "END:VEVENT", "END:VCALENDAR"].join("\r\n") + "\r\n";
const TEST_ICS_DEADLINE = ics("UID:a@psmail", "DTSTART;VALUE=DATE:20260930", "DTEND;VALUE=DATE:20261001", "SUMMARY:Submit documents");
const TEST_ICS_CALL = ics("UID:b@psmail", "DTSTART:20261002T140000", "SUMMARY:Call with Alice\\, Bob", "LOCATION:Phone\\; Berlin");
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
const DEFAULT_PATCH = {
  syncIntervalMinutes: null,
  combinedInboxIncludesFolders: false,
  imboxEnabled: false,
  notifyBrowser: false,
  notifyToast: false,
  notificationSound: "crystal_clear",
  showConversations: true,
  showCategories: true,
  showUnreadBadges: true,
  textViewOnly: false,
  showAbsoluteDates: false,
  showLetterAvatar: false,
};

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
/** Bodies of POST .../folders (new folders), and how the mock server answers them. */
/** POST .../emails/download requests (account + ids) of the mock server. */
let messageDownloads: { account: string; ids: number[] }[] = [];
/** Query strings of the GET requests for a folder's messages / the combined lists, in order. */
let listRequests: { list: "folder" | "inbox" | "imbox" | "sent" | "search"; params: URLSearchParams }[] = [];
let createFolderPosts: { name: string; parent?: string }[] = [];
let createFolderError: string | null = null;
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
const downloadAccounts: string[] = []; // the account of each of those POSTs
// The folder the most recent POST .../downloads asked for (undefined = every folder) — echoed back by the GET status mocks below.
let lastSyncFolder: string | undefined;
// Bodies of PATCH .../emails/20 (the combined Sent list's message).
const capturedResultPatches: Record<string, unknown>[] = [];
// Bodies of POST /api/auth/change-password.
const passwordChanges: Record<string, unknown>[] = [];
// Bodies of PUT .../emails/:id/imbox (the marks by hand), and how many times the imbox unread count was asked for.
let imboxMarks: { id: number; imbox: boolean | null }[] = [];
let imboxUnreadRequests = 0;
// Bodies of POST /api/auth/change-username.
const usernameChanges: { username: string }[] = [];
// Every bulk PATCH/DELETE/move request, with the account it went to.
// The `scope` param of every GET .../contacts call.
const contactRequests: (string | null)[] = [];
// Requests to the AI endpoints: [method, path, body].
const aiRequests: [string, string, any][] = [];
// Paths of every PATCH .../emails/:id (flags, read state, ...).
const emailPatches: string[] = [];
// [path, body] of the same.
const emailPatchBodies: [string, any][] = [];
// Bodies of POST /api/auth/login.
const loginPosts: { username: string; password: string }[] = [];
const bulkRequests: { account: string; method: string; move: string | null; body: Record<string, unknown> }[] = [];
let folderRequests = 0;
let liveFolderRequests = 0;
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
      showConversations?: boolean;
      showCategories?: boolean;
      showUnreadBadges?: boolean;
      textViewOnly?: boolean;
      showAbsoluteDates?: boolean;
      showLetterAvatar?: boolean;
      bodyView?: string;
      syncIntervalMinutes?: number;
      combinedInboxIncludesFolders?: boolean;
      imboxEnabled?: boolean;
      notifyBrowser?: boolean;
      notifyToast?: boolean;
      notificationSound?: string;
      aiTargetLanguage?: string;
    };
    /** What GET /api/unified/inbox/unread reports (the combined Inbox's badge). */
    inboxUnread?: number;
    /** The sync job never finishes (GET job stays running at 12/340) — to look at the in-progress UI. */
    syncStaysRunning?: boolean;
    /** Replaces what GET /api/ai/skills answers (to check that an odd answer doesn't break the app). */
    aiSkillsResponse?: unknown;
    /** More accounts next to me@example.com (for tests that sync several at once): e.g. { email: "you@example.com" }. */
    extraAccounts?: Partial<Account>[];
    /** What GET .../folders?live=1 (the slow IMAP read) answers: a folder list, or "fail" for a 502. Default: the same as the cached list. */
    liveFolders?: Record<string, unknown>[] | "fail";
    /** GET .../folders answers with the stored folders and this reason in x-folders-warning (the mail server can't be reached). */
    folderWarning?: string;
    /** POST .../ai/summarize answers only after this many ms (to see the "generating" state). */
    aiSummarizeDelayMs?: number;
    /** Folders next to the default ones (e.g. nested ones like Work/2024) in the account's folder list. */
    extraFolders?: Record<string, unknown>[];
    /** Categories the user has AI skills for (all on one provider); they show up in GET /api/ai/skills. */
    aiSkillCategories?: string[];
    /** Provider records GET /api/ai/apis starts with. */
    aiApis?: { id: number; name: string; vendor: string; model: string; baseUrl: string | null; hasKey: boolean; calls?: number; inputTokens?: number; outputTokens?: number }[];
    /** What GET .../downloads (the account's job history) lists: a sync already underway when the page loads. */
    earlierSyncJob?: "running" | "completed";
    /** Adds a contact from another account to the recipient suggestions. */
    otherAccountContacts?: boolean;
    /** Replaces the combined Inbox's rows (default: one starred message). */
    unifiedInboxRows?: Record<string, unknown>[];
    /** What GET .../emails/10/conversation answers (default: 404, i.e. no conversation). */
    conversation?: { messages: Record<string, unknown>[]; repliedBy: number | null };
    /** What GET /api/unified/imbox/unread reports (the Imbox entry's badge). */
    imboxUnread?: number;
    /** The imbox verdict the opened message (id 10) has: true / false / null (not classified). */
    emailImbox?: boolean | null;
    /** Overrides the opened message's (id 10) date — for testing how the list/header formats it. */
    emailDate?: string;
    /** Makes POST /api/auth/change-username answer with this error (status 409) instead of succeeding. */
    changeUsernameError?: string;
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
  createFolderPosts = [];
  messageDownloads = [];
  listRequests = [];
  createFolderError = null;
  const createdFolders: Record<string, unknown>[] = [...(opts.extraFolders ?? [])];
  capturedUpdateDraftBody = null;
  pagedRequests.length = 0;
  capturedSettingsPatches.length = 0;
  capturedAccountPatch = null;
  downloadPosts.length = 0;
  downloadAccounts.length = 0;
  lastSyncFolder = undefined;
  capturedResultPatches.length = 0;
  passwordChanges.length = 0;
  imboxMarks = [];
  imboxUnreadRequests = 0;
  usernameChanges.length = 0;
  bulkRequests.length = 0;
  loginPosts.length = 0;
  emailPatches.length = 0;
  emailPatchBodies.length = 0;
  aiRequests.length = 0;
  let currentAiApis = [...(opts.aiApis ?? [])];
  // "summarize" or "summarize:Short" (a skill with a name of its own; unnamed ones are named after their category, like the server does).
  let currentAiSkills = (opts.aiSkillCategories ?? []).map((spec, i) => {
    const [category, name = category] = spec.split(":");
    return { id: i + 1, aiApiId: 1, category, name, prompt: `prompt for ${category}`, createdAt: NOW, updatedAt: NOW };
  });
  // A provider's label is its name, or Vendor.model when it has none (the server computes it).
  const withLabel = <T extends { name: string; vendor: string; model: string }>(record: T) => ({
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    ...record,
    label: record.name || `${({ anthropic: "Anthropic", openai: "OpenAI", "openai-compatible": "OpenAI-compatible", google: "Google", ollama: "Ollama" } as Record<string, string>)[record.vendor]}.${record.model}`,
  });
  contactRequests.length = 0;
  folderRequests = 0;
  liveFolderRequests = 0;
  unreadRequests = 0;
  newMailRequests.length = 0;
  folderDelayMs = 0;
  // The interface options are opt-in; most tests are about what they switch on, so the mock user has them on (a test says `false` for the plain client).
  let currentSettings: Record<string, unknown> = { showConversations: true, showCategories: true, showUnreadBadges: true, ...opts.settings };

  const warned = (response: Response) => {
    if (opts.folderWarning) response.headers.set("x-folders-warning", encodeURIComponent(opts.folderWarning));
    return response;
  };

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
      loginPosts.push(body);
      // "secure" needs a real password; everyone else (in particular "default") logs in with
      // an empty one — for testing LoginView's "try an empty password first" behavior.
      if (body.username === "secure" && body.password !== "secret123") {
        return jsonResponse({ error: "Invalid credentials" }, 401);
      }
      return jsonResponse({ token: "test-token", expiresAt: NOW, user: { id: 1, username: body.username } });
    }
    if (method === "GET" && path === "/api/accounts") {
      return jsonResponse([currentAccount, ...(opts.extraAccounts ?? []).map((extra, i) => ({ ...ACCOUNT, id: 10 + i, position: 2 + i, ...extra }))]);
    }
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
    const downloadMessages = /^\/api\/accounts\/([^/]+)\/emails\/download$/.exec(path);
    if (method === "POST" && downloadMessages) {
      const { ids } = JSON.parse(init!.body as string) as { ids: number[] };
      messageDownloads.push({ account: decodeURIComponent(downloadMessages[1]!), ids });
      return ids.length === 1
        ? new Response("From: a\r\n\r\nhi", { headers: { "content-type": "message/rfc822", "content-disposition": "attachment; filename=\"2024-05-01 Gr__e.eml\"; filename*=UTF-8''2024-05-01%20Gr%C3%BC%C3%9Fe.eml" } })
        : new Response("zip", { headers: { "content-type": "application/zip", "content-disposition": "attachment; filename=\"me@example.com messages.zip\"" } });
    }
    if (method === "POST" && path === "/api/accounts/me%40example.com/folders") {
      const body = JSON.parse(init!.body as string) as { name: string; parent?: string };
      createFolderPosts.push(body);
      if (createFolderError) return jsonResponse({ error: createFolderError }, 409);
      const folderPath = body.parent ? `${body.parent}/${body.name}` : body.name;
      createdFolders.push({ path: folderPath, name: body.name, delimiter: "/", specialUse: null, flags: [], total: 0, unread: 0 });
      return jsonResponse({ path: folderPath, folders: [...FOLDERS, ...createdFolders] }, 201);
    }
    if (method === "GET" && path === "/api/accounts/me%40example.com/folders" && url.includes("live=1")) {
      liveFolderRequests += 1;
      if (opts.liveFolders === "fail") return jsonResponse({ error: "Couldn't read the folders of me@example.com from imap.example.com: slow" }, 502);
      if (opts.liveFolders) {
        await new Promise(resolve => setTimeout(resolve, 150)); // IMAP takes its time
        return jsonResponse(opts.liveFolders);
      }
      return warned(jsonResponse([...FOLDERS, ...createdFolders]));
    }
    if (method === "GET" && path === "/api/accounts/me%40example.com/folders") {
      folderRequests += 1;
      if (folderDelayMs > 0) await new Promise(resolve => setTimeout(resolve, folderDelayMs));
      return warned(jsonResponse([...FOLDERS, ...createdFolders]));
    }
    const downloadPost = /^\/api\/accounts\/([^/]+)\/downloads$/.exec(path);
    if (method === "POST" && downloadPost) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      downloadPosts.push(body);
      downloadAccounts.push(decodeURIComponent(downloadPost[1]!));
      lastSyncFolder = body.folder;
      return jsonResponse({ ...SYNC_JOB("running"), folder: lastSyncFolder ?? null }, 202);
    }
    if (method === "GET" && /^\/api\/accounts\/[^/]+\/downloads$/.test(path)) {
      if (!opts.earlierSyncJob) return jsonResponse([]);
      return jsonResponse([{ ...SYNC_JOB(opts.earlierSyncJob), progressCurrent: 5, progressTotal: 10 }]);
    }
    if (method === "GET" && /^\/api\/accounts\/[^/]+\/downloads\/1$/.test(path)) {
      return jsonResponse(opts.syncStaysRunning ? { ...SYNC_JOB("running"), folder: lastSyncFolder ?? null, progressCurrent: 12, progressTotal: 340 } : { ...SYNC_JOB("completed"), folder: lastSyncFolder ?? null });
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
      const listParams = new URL(url, "http://localhost").searchParams;
      listRequests.push({ list: "folder", params: listParams });
      if (listParams.has("after") || listParams.has("before") || listParams.has("category")) return jsonResponse([]); // the mock has nothing in any date window or category
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
      return jsonResponse([opts.emailDate ? { ...EMAIL, date: opts.emailDate } : EMAIL, SECOND_EMAIL, THIRD_EMAIL, DRAFT_EMAIL]);
    }
    if (method === "POST" && path === "/api/auth/change-username") {
      const body = JSON.parse(init!.body as string) as { username: string };
      usernameChanges.push(body);
      if (opts.changeUsernameError) return jsonResponse({ error: opts.changeUsernameError }, 409);
      return jsonResponse({ id: 1, username: body.username.trim() });
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
      if (path === "/api/ai/models" && method === "POST") return jsonResponse({ models: ["qwen/qwen3-8b", "llama-3"] });
      const apiById = /^\/api\/ai\/apis\/(\d+)$/.exec(path);
      if (apiById && method === "DELETE") {
        currentAiApis = currentAiApis.filter(a => a.id !== Number(apiById[1]));
        currentAiSkills = currentAiSkills.filter(s => s.aiApiId !== Number(apiById[1]));
        return new Response(null, { status: 204 });
      }
      if (/^\/api\/ai\/apis\/\d+\/test$/.test(path)) return jsonResponse({ ok: true, answer: "OK" });
      if (path === "/api/ai/skills" && method === "GET") return jsonResponse(opts.aiSkillsResponse !== undefined ? opts.aiSkillsResponse : currentAiSkills);
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
        if (opts.aiSummarizeDelayMs) await new Promise(resolve => setTimeout(resolve, opts.aiSummarizeDelayMs));
        const withEvents = currentAiSkills.some(skill => skill.category === "events");
        return jsonResponse({
          email: {
            ...EMAIL,
            aiSummary: "- Alice says hello\n- No action needed",
            taxonomyList: ["greeting", "personal"],
            ...(withEvents ? { calendarEvents: [TEST_ICS_DEADLINE, TEST_ICS_CALL] } : {}),
          },
        });
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
    if (method === "GET" && path === "/api/unified/imbox") {
      listRequests.push({ list: "imbox", params: new URL(url, "http://localhost").searchParams });
      return jsonResponse([
        { id: 10, accountEmail: "me@example.com", folder: "INBOX", uid: 1, isRead: false, isFlagged: false, subject: "Imbox hello", from: [{ name: "Alice", address: "alice@example.com" }], date: NOW },
      ]);
    }
    if (method === "GET" && (path === "/api/unified/inbox" || path === "/api/unified/sent")) {
      const listParams = new URL(url, "http://localhost").searchParams;
      listRequests.push({ list: path.endsWith("inbox") ? "inbox" : "sent", params: listParams });
      if (listParams.has("after") || listParams.has("before") || listParams.has("category")) return jsonResponse([]);
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
    if (method === "PUT" && /^\/api\/accounts\/me%40example.com\/emails\/\d+\/imbox$/.test(path)) {
      const body = JSON.parse(init!.body as string) as { imbox: boolean | null };
      imboxMarks.push({ id: 10, imbox: body.imbox });
      return jsonResponse({ ...EMAIL, imbox: body.imbox });
    }
    if (method === "GET" && /^\/api\/accounts\/me%40example.com\/emails\/\d+\/conversation$/.test(path)) {
      return opts.conversation ? jsonResponse(opts.conversation) : jsonResponse({ error: "no conversation in this mock" }, 404);
    }
    if (method === "GET" && path === "/api/unified/imbox/unread") {
      imboxUnreadRequests += 1;
      return jsonResponse({ count: opts.imboxUnread ?? 0 });
    }
    if (method === "GET" && path === "/api/accounts/me%40example.com/emails/10") return jsonResponse({ ...EMAIL, imbox: opts.emailImbox ?? null, date: opts.emailDate ?? EMAIL.date });
    if (method === "GET" && path === "/api/accounts/me%40example.com/emails/11") return jsonResponse(SECOND_EMAIL);
    if (method === "GET" && path === "/api/accounts/me%40example.com/emails/12") return jsonResponse(THIRD_EMAIL);
    if (method === "GET" && path === "/api/accounts/me%40example.com/emails/13") return jsonResponse(DRAFT_EMAIL);
    if (method === "PATCH" && path === "/api/accounts/me%40example.com/emails/20") {
      capturedResultPatches.push(init?.body ? JSON.parse(init.body as string) : {});
      return jsonResponse({ ...EMAIL, id: 20, ...(init?.body ? JSON.parse(init.body as string) : {}) });
    }
    if (method === "PATCH" && path.startsWith("/api/accounts/me%40example.com/emails/")) {
      emailPatches.push(path);
      emailPatchBodies.push([path, init?.body ? JSON.parse(init.body as string) : {}]);
    }
    if (method === "PATCH" && path === "/api/accounts/me%40example.com/emails/10") return jsonResponse({ ...EMAIL, isRead: true, ...(init?.body ? JSON.parse(init.body as string) : {}) });
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
    if (method === "GET" && path === "/api/categories") {
      return jsonResponse([{ label: "finance", count: 5 }, { label: "travel", count: 2 }, { label: "invoice", count: 1 }]);
    }
    if (method === "GET" && path === "/api/search") {
      // The mock doesn't replicate real matching (that's covered by backend tests) —
      // it just returns a canned hit so the UI wiring (fetch -> render -> select) is exercised.
      const searchParams = new URL(url, "http://localhost").searchParams;
      listRequests.push({ list: "search", params: searchParams });
      const inBody = searchParams.get("q") === "only-in-the-text";
      return jsonResponse([
        {
          ...(inBody ? { matchedInBody: true } : {}),
          id: SECOND_EMAIL.id,
          accountEmail: ACCOUNT.email,
          folder: searchParams.get("q") === "in-archive" ? "Archive" : SECOND_EMAIL.folder, // "in-archive" finds a hit outside the folder being browsed
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
    window.history.replaceState(null, "", "/");
    installMockFetch();
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
  });

  describe("creating folders", () => {
    async function openNewFolderDialog() {
      await userEvent.click(await screen.findByText("default"));
      await openAccountInbox();
      await userEvent.click(screen.getByTitle("More actions"));
      await userEvent.click(await screen.findByText("New folder…"));
      return within((await screen.findByText("New folder", { selector: "[data-slot=dialog-title]" })).closest('[role="dialog"]') as HTMLElement);
    }

    test("the account menu creates a folder on the server, and it shows up in the tree", async () => {
      render(<App />);
      const dialog = await openNewFolderDialog();
      await userEvent.type(dialog.getByLabelText("Name"), "Receipts");
      await userEvent.click(dialog.getByRole("button", { name: "Create folder" }));

      expect(await screen.findByText("Receipts")).toBeTruthy();
      expect(createFolderPosts).toEqual([{ name: "Receipts" }]);
      expect((await screen.findAllByText(/Folder "Receipts" was created/)).length).toBeGreaterThan(0);
      expect(screen.queryByText("New folder", { selector: "[data-slot=dialog-title]" })).toBeNull();
    });

    test("a folder can be created inside another one", async () => {
      render(<App />);
      const dialog = await openNewFolderDialog();
      await userEvent.type(dialog.getByLabelText("Name"), "2024");
      await userEvent.selectOptions(dialog.getByLabelText("Inside"), "Entwürfe");
      await userEvent.click(dialog.getByRole("button", { name: "Create folder" }));

      await waitFor(() => expect(createFolderPosts).toEqual([{ name: "2024", parent: "Entwürfe" }]));
      expect(await screen.findByText("2024")).toBeTruthy();
    });

    test("the server's refusal is shown in the dialog, which stays open", async () => {
      createFolderError = 'A folder "Receipts" already exists.';
      render(<App />);
      const dialog = await openNewFolderDialog();
      await userEvent.type(dialog.getByLabelText("Name"), "Receipts");
      await userEvent.click(dialog.getByRole("button", { name: "Create folder" }));

      expect(await screen.findByText(/already exists/)).toBeTruthy();
      expect(screen.getByText("New folder", { selector: "[data-slot=dialog-title]" })).toBeTruthy();
    });

    test("nothing to create without a name", async () => {
      render(<App />);
      const dialog = await openNewFolderDialog();
      expect(dialog.getByRole("button", { name: "Create folder" }).hasAttribute("disabled")).toBe(true);
    });
  });

  describe("subfolders", () => {
    const folder = (path: string, unread = 0) => ({ path, name: path.split("/").pop(), delimiter: "/", specialUse: null, flags: [], total: unread, unread });
    const nested = [folder("Work"), folder("Work/2024", 2), folder("Work/2024/Q1"), folder("Private")];

    async function openTree() {
      await userEvent.click(await screen.findByText("default"));
      await openAccountInbox();
    }

    test("folders with subfolders start collapsed, with an arrow; the arrow opens and closes them", async () => {
      installMockFetch({ extraFolders: nested });
      render(<App />);
      await openTree();

      await screen.findByText("Work");
      expect(screen.getByText("Private")).toBeTruthy();
      expect(screen.queryByText("2024")).toBeNull();
      expect(screen.queryByLabelText("Expand Private")).toBeNull(); // no subfolders, no arrow (a hidden placeholder keeps the alignment)

      await userEvent.click(screen.getByLabelText("Expand Work"));
      expect(await screen.findByText("2024")).toBeTruthy();
      expect(screen.queryByText("Q1")).toBeNull(); // each level opens on its own

      await userEvent.click(screen.getByLabelText("Expand 2024"));
      expect(await screen.findByText("Q1")).toBeTruthy();

      await userEvent.click(screen.getByLabelText("Collapse Work"));
      expect(screen.queryByText("2024")).toBeNull();
      expect(screen.queryByText("Q1")).toBeNull();
    });

    test("clicking a folder with subfolders selects it and opens it", async () => {
      installMockFetch({ extraFolders: nested });
      render(<App />);
      await openTree();

      await userEvent.click(await screen.findByText("Work"));
      expect(await screen.findByText("2024")).toBeTruthy();
      await waitFor(() => expect(window.location.pathname).toBe("/a/me@example.com/Work/"));
    });

    test("a collapsed folder shows the unread count of what is inside it", async () => {
      installMockFetch({ extraFolders: nested });
      render(<App />);
      await openTree();

      const workRow = (await screen.findByText("Work")).closest("div")!;
      expect(workRow.textContent).toContain("2");
      await userEvent.click(screen.getByLabelText("Expand Work"));
      expect((await screen.findByText("Work")).closest("div")!.textContent).not.toContain("2"); // now the subfolder shows it
    });

    test("the selected folder is never hidden in a collapsed parent (a link to it opens its parents)", async () => {
      window.history.replaceState(null, "", "/a/me@example.com/Work%2F2024/");
      installMockFetch({ extraFolders: nested });
      render(<App />);
      await userEvent.click(await screen.findByText("default"));

      expect(await screen.findByText("2024")).toBeTruthy();
      expect(screen.queryByText("Q1")).toBeNull();
    });

    test("a folder created inside another one is shown where it was put", async () => {
      installMockFetch({ extraFolders: [folder("Work")] });
      render(<App />);
      await openTree();
      await userEvent.click(screen.getByTitle("More actions"));
      await userEvent.click(await screen.findByText("New folder…"));
      const dialog = within((await screen.findByText("New folder", { selector: "[data-slot=dialog-title]" })).closest('[role="dialog"]') as HTMLElement);
      await userEvent.type(dialog.getByLabelText("Name"), "Receipts");
      await userEvent.selectOptions(dialog.getByLabelText("Inside"), "Work");
      await userEvent.click(dialog.getByRole("button", { name: "Create folder" }));

      expect(await screen.findByText("Receipts")).toBeTruthy();
    });
  });

  describe("creating folders: accounts that can't", () => {
    test.each([
      ["read-only", { readOnly: true }],
      ["disabled", { disabled: true }],
    ])("a %s account has no New folder action", async (_label, accountOverrides) => {
      installMockFetch({ accountOverrides });
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await waitFor(() => expect(screen.getAllByText("me@example.com").length).toBeGreaterThan(0), { timeout: 3000 });
      await userEvent.click(screen.getByTitle("More actions"));
      await screen.findByText("Account settings");
      expect(screen.queryByText("New folder…")).toBeNull();
    });
  });

  describe("deep links (URL paths)", () => {
    async function signIn() {
      await userEvent.click(await screen.findByText("default"));
    }

    test("the app starts on the combined Inbox at /, and picking a folder and a message moves the URL", async () => {
      render(<App />);
      await signIn();
      await openAccountInbox();
      expect(window.location.pathname).toBe("/a/me@example.com/inbox/");

      await userEvent.click(await screen.findByText("Hello there"));
      expect(window.location.pathname).toBe("/a/me@example.com/inbox/10");
    });

    test("opening a message's URL shows that message in its folder", async () => {
      window.history.replaceState(null, "", "/a/me@example.com/inbox/11");
      render(<App />);
      await signIn();

      expect((await screen.findAllByText("Second message")).length).toBeGreaterThan(1); // list row + reading pane
      expect(window.location.pathname).toBe("/a/me@example.com/inbox/11");
      expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0);
    });

    test("Back returns to the previous view", async () => {
      render(<App />);
      await signIn();
      await openAccountInbox();
      await userEvent.click(await screen.findByText("Hello there"));
      expect(window.location.pathname).toBe("/a/me@example.com/inbox/10");

      // happy-dom's history.back() would try to navigate the test window, so do what the browser does: the URL changes, popstate fires.
      window.history.replaceState(null, "", "/a/me@example.com/inbox/");
      act(() => {
        window.dispatchEvent(new Event("popstate"));
      });
      await waitFor(() => expect(window.location.pathname).toBe("/a/me@example.com/inbox/"));
      await waitFor(() => expect(screen.queryByText("Reply")).toBeNull());
    });

    test("a link to an account that doesn't exist falls back to the combined Inbox", async () => {
      window.history.replaceState(null, "", "/a/nobody@example.com/inbox/");
      render(<App />);
      await signIn();

      expect((await screen.findAllByText(/nobody@example.com" was not found/)).length).toBeGreaterThan(0);
      await waitFor(() => expect(window.location.pathname).toBe("/"));
    });

    test("an unrecognized path is normalized to /", async () => {
      window.history.replaceState(null, "", "/whatever");
      render(<App />);
      await signIn();
      await waitFor(() => expect(window.location.pathname).toBe("/"));
    });
  });

  test("renders login, signs in, and opens a message end to end", async () => {
    render(<App />);

    // Login screen — clicking the profile logs straight in (an empty password works, so
    // LoginView skips the password prompt entirely), no separate "Sign in" click needed.
    await waitFor(() => expect(screen.getByAltText("P.S.Mail logo")).toBeTruthy()); // the logo (with the name in it) heads the card
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

  test("the header's Settings button is an icon (with a Settings tooltip), also for a non-default username", async () => {
    installMockFetch({ extraUsers: [{ id: 2, username: "secure" }] });
    render(<App />);

    await userEvent.click(await screen.findByText("secure"));
    await userEvent.type(await screen.findByPlaceholderText("Password"), "secret123");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await openAccountInbox();

    expect(screen.getByTitle("Settings")).toBeTruthy();
    expect(screen.queryByText("secure")).toBeNull(); // the name isn't printed in the header any more
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

  describe("closing a compose window with unsaved changes", () => {
    afterEach(() => {
      toast.dismiss(); // sonner's toast store is global: the "E-Mail sent" toast must not show up in the next test
    });
    async function openNew() {
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await openAccountInbox();
      await userEvent.click(screen.getByRole("button", { name: /^new$/i }));
      expect(await screen.findByText("New message")).toBeTruthy();
    }
    const question = () => screen.findByRole("alertdialog");

    test("an untouched window closes without asking", async () => {
      await openNew();
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByText("New message")).toBeNull());
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    test("with changes, closing asks; Discard is the default, so Enter throws the changes away", async () => {
      await openNew();
      await userEvent.type(screen.getByLabelText("Subject"), "Half written");
      await userEvent.keyboard("{Escape}"); // focus is in the subject field; Esc closes the window…

      const ask = within(await question());
      expect(ask.getByText("Save this message as a draft?")).toBeTruthy(); // …but not before asking
      expect(screen.getByText("New message")).toBeTruthy(); // the window is still there behind the question
      expect(document.activeElement).toBe(ask.getByRole("button", { name: "Discard changes" })); // the default

      await userEvent.keyboard("{Enter}");
      await waitFor(() => expect(screen.queryByText("New message")).toBeNull());
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(capturedCreateDraftBody).toBeNull(); // nothing was saved
    });

    test("Save draft in the question saves what was typed, and closes", async () => {
      await openNew();
      await userEvent.type(screen.getByLabelText("Subject"), "Keep me");
      await userEvent.keyboard("{Escape}");

      await userEvent.click(within(await question()).getByRole("button", { name: "Save draft" }));
      await waitFor(() => expect(screen.queryByText("New message")).toBeNull());
      expect(capturedCreateDraftBody?.subject).toBe("Keep me");
      expect(capturedCreateDraftBody?.folder).toBe("Entwürfe");
    });

    test("Keep editing goes back to the window with everything still in it", async () => {
      await openNew();
      await userEvent.type(screen.getByLabelText("Subject"), "Not done");
      await userEvent.keyboard("{Escape}");

      await userEvent.click(within(await question()).getByRole("button", { name: "Keep editing" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("Not done");
      expect(capturedCreateDraftBody).toBeNull();
    });

    test("the x and a click outside ask too", async () => {
      await openNew();
      await userEvent.type(screen.getByLabelText("Subject"), "Via the x");
      const dialog = screen.getByText("New message").closest('[role="dialog"]') as HTMLElement;
      await userEvent.click(within(dialog).getByRole("button", { name: /close/i }));
      expect(await question()).toBeTruthy();
    });

    test("typing in To, adding a file, or changing the body counts as a change; sending doesn't ask", async () => {
      await openNew();
      await userEvent.type(screen.getByLabelText("To"), "bob@example.com");
      await userEvent.keyboard("{Escape}");
      await userEvent.click(within(await question()).getByRole("button", { name: "Discard changes" }));
      await waitFor(() => expect(screen.queryByText("New message")).toBeNull());

      await userEvent.click(screen.getByRole("button", { name: /^new$/i }));
      await screen.findByText("New message");
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await userEvent.upload(input, new File(["hello"], "note.txt", { type: "text/plain" }));
      await userEvent.keyboard("{Escape}");
      await userEvent.click(within(await question()).getByRole("button", { name: "Discard changes" }));
      await waitFor(() => expect(screen.queryByText("New message")).toBeNull());

      await userEvent.click(screen.getByRole("button", { name: /^new$/i }));
      await screen.findByText("New message");
      await userEvent.type(screen.getByLabelText("To"), "bob@example.com");
      await userEvent.type(screen.getByLabelText("Subject"), "Sent it");
      await userEvent.click(screen.getByRole("button", { name: /^send$/i }));
      await waitFor(() => expect(screen.queryByText("New message")).toBeNull());
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    test("a reply that wasn't touched closes quietly; editing an existing draft asks about the changes to it and saves them in place", async () => {
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await openAccountInbox();

      await userEvent.click(await screen.findByText("Hello there"));
      await userEvent.click(await screen.findByRole("button", { name: /^reply$/i }));
      await screen.findByText("New message");
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByText("New message")).toBeNull());
      expect(screen.queryByRole("alertdialog")).toBeNull();

      await userEvent.click(await screen.findByText("Unfinished draft"));
      await userEvent.click(await screen.findByRole("button", { name: /edit draft/i }));
      await screen.findByText("Edit draft", { selector: "[data-slot=dialog-title]" });
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByText("Edit draft", { selector: "[data-slot=dialog-title]" })).toBeNull()); // unchanged: no question

      await userEvent.click(screen.getByRole("button", { name: /edit draft/i }));
      await screen.findByText("Edit draft", { selector: "[data-slot=dialog-title]" });
      await userEvent.type(screen.getByLabelText("Subject"), " v2");
      await userEvent.keyboard("{Escape}");
      const ask = within(await question());
      expect(ask.getByText("Save the changes to this draft?")).toBeTruthy();
      await userEvent.click(ask.getByRole("button", { name: "Save draft" }));
      await waitFor(() => expect(capturedUpdateDraftBody?.subject).toBe("Unfinished draft v2")); // the same draft, updated
    });
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

  describe("conversations", () => {
    const message = (id: number, over: Record<string, unknown> = {}) => ({
      id, accountEmail: "me@example.com", folder: "INBOX", subject: "Projekt", from: { name: "Anna", address: "anna@x.example" },
      date: "2026-06-01T10:00:00.000Z", isRead: true, own: false, snippet: `text of ${id}`, current: false, ...over,
    });
    const THREE = {
      messages: [message(9, { snippet: "Wie weit seid ihr?" }), message(10, { current: true, snippet: "Fast fertig." }), message(11, { own: true, folder: "Sent", from: { address: "me@example.com" }, snippet: "Danke, super." })],
      repliedBy: 11,
    };
    const listProps = { loading: false, hasMore: false, loadingMore: false, onLoadMore: () => {}, selectedId: null, selectedIds: new Set<number>(), folder: "INBOX", onSelect: () => {}, onToggleFlag: () => {}, onEditDraft: () => {} };

    test("list rows: quiet icons for a message in a conversation and one you replied to; nothing for a message on its own", () => {
      const { container } = render(
        <UiSettingsContext.Provider value={{ ...PLAIN_UI, showConversations: true }}>
        <MessageList
          {...listProps}
          emails={[
            { ...EMAIL, id: 1, subject: "Beantwortet", conversation: { replied: true, related: 2 } } as never,
            { ...EMAIL, id: 2, subject: "Nur Teil", conversation: { replied: false, related: 1 } } as never,
            { ...EMAIL, id: 3, subject: "Allein" } as never,
          ]}
        />
        </UiSettingsContext.Provider>
      );
      const row = (subject: string) => within(screen.getByText(subject).closest("li")!);
      expect(row("Beantwortet").getByLabelText("Part of a conversation")).toBeTruthy();
      expect(row("Beantwortet").getByLabelText("You replied")).toBeTruthy();
      expect(row("Nur Teil").getByLabelText("Part of a conversation")).toBeTruthy();
      expect(row("Nur Teil").queryByLabelText("You replied")).toBeNull();
      expect(row("Allein").queryByLabelText("Part of a conversation")).toBeNull();
      expect(row("Allein").queryByLabelText("You replied")).toBeNull();
      expect(container.querySelector('[title="Part of a conversation — 2 related messages"]')).toBeTruthy(); // says how many, on hover
      expect(container.querySelector('[title="Part of a conversation — 1 related message"]')).toBeTruthy();
    });

    test("the bar is one quiet line with the count; it opens into the messages, newest first, and the current one can't be clicked", async () => {
      const opened: number[] = [];
      render(<ConversationBar conversation={THREE as never} onOpen={m => opened.push(m.id)} />);
      expect(screen.getByText(/Conversation · 3 messages/)).toBeTruthy();
      expect(screen.getByText("(this is 2 of 3)")).toBeTruthy();
      expect(screen.queryByLabelText("Messages in this conversation")).toBeNull(); // folded

      await userEvent.click(screen.getByText(/Conversation · 3 messages/));
      const list = await screen.findByLabelText("Messages in this conversation");
      const rows = within(list).getAllByRole("button");
      expect(rows.map(r => r.textContent)).toEqual([expect.stringContaining("Danke, super."), expect.stringContaining("Fast fertig."), expect.stringContaining("Wie weit seid ihr?")]);
      expect(rows[1]!.getAttribute("aria-current")).toBe("true");
      expect(rows[1]!.hasAttribute("disabled")).toBe(true);
      expect(within(list).getByText("You")).toBeTruthy(); // my own message says so

      await userEvent.click(rows[2]!);
      expect(opened).toEqual([9]);
    });

    test("a forwarded message is marked with an arrow in the list, in the conversation bar and in the message header", async () => {
      const { container } = render(
        <UiSettingsContext.Provider value={{ ...PLAIN_UI, showConversations: true }}>
          <MessageList {...listProps} emails={[{ ...EMAIL, id: 1, subject: "Weitergeleitet", conversation: { replied: false, forwarded: true, related: 0 } } as never, { ...EMAIL, id: 2, subject: "Nicht" } as never]} />
        </UiSettingsContext.Provider>
      );
      const row = (subject: string) => within(screen.getByText(subject).closest("li")!);
      expect(row("Weitergeleitet").getByLabelText("Forwarded")).toBeTruthy();
      expect(row("Weitergeleitet").queryByLabelText("Part of a conversation")).toBeNull();
      expect(row("Nicht").queryByLabelText("Forwarded")).toBeNull();
      expect(container.querySelector('[title="Forwarded"]')).toBeTruthy();
      cleanup();

      const withForward = { ...THREE, messages: THREE.messages.map(m => (m.id === 9 ? { ...m, forwarded: true } : m)) };
      render(<ConversationBar conversation={withForward as never} onOpen={() => {}} />);
      await userEvent.click(screen.getByText(/Conversation · 3 messages/));
      const list = await screen.findByLabelText("Messages in this conversation");
      const rows = within(list).getAllByRole("button");
      expect(within(rows[2]!).getByLabelText("Forwarded")).toBeTruthy(); // 9, the oldest, is last
      expect(within(rows[0]!).queryByLabelText("Forwarded")).toBeNull();
      cleanup();

      render(
        <UiSettingsContext.Provider value={{ ...PLAIN_UI, showConversations: true }}>
          <MessageHeader email={{ ...EMAIL, isForwarded: true } as never} />
        </UiSettingsContext.Provider>
      );
      expect(screen.getByLabelText("Forwarded")).toBeTruthy();
      cleanup();
      render(<MessageHeader email={{ ...EMAIL, isForwarded: true } as never} />); // the plain client shows none
      expect(screen.queryByLabelText("Forwarded")).toBeNull();
    });

    test("sending a forward marks the forwarded message — the header shows the arrow, and the list is asked again", async () => {
      installMockFetch();
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await openAccountInbox();
      await userEvent.click(await screen.findByText("Hello there"));
      await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(1));
      expect(screen.queryByLabelText("Forwarded")).toBeNull();

      await userEvent.click(screen.getByRole("button", { name: /^forward$/i }));
      expect(await screen.findByText("New message")).toBeTruthy();
      await userEvent.click(screen.getByRole("button", { name: /send/i }));

      await waitFor(() => expect(emailPatchBodies.filter(([, body]) => body?.isForwarded === true).map(([path]) => path)).toEqual(["/api/accounts/me%40example.com/emails/10"]));
      expect(await screen.findByLabelText("Forwarded")).toBeTruthy();
    });

    test("a reply or a new message does not mark anything as forwarded", async () => {
      installMockFetch();
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await openAccountInbox();
      await userEvent.click(await screen.findByText("Hello there"));
      await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(1));
      await userEvent.click(screen.getByRole("button", { name: /^reply$/i }));
      expect(await screen.findByText("New message")).toBeTruthy();
      await userEvent.click(screen.getByRole("button", { name: /send/i }));
      expect((await screen.findAllByText("E-Mail sent")).length).toBeGreaterThan(0);
      expect(emailPatchBodies.filter(([, body]) => body?.isForwarded)).toEqual([]);
    });

    test("'See your reply' opens the answer; without one there is no such button; a message alone shows no bar at all", async () => {
      const opened: number[] = [];
      const { rerender } = render(<ConversationBar conversation={THREE as never} onOpen={m => opened.push(m.id)} />);
      await userEvent.click(screen.getByRole("button", { name: /see your reply/i }));
      expect(opened).toEqual([11]);

      rerender(<ConversationBar conversation={{ ...THREE, repliedBy: null } as never} onOpen={() => {}} />);
      expect(screen.queryByRole("button", { name: /see your reply/i })).toBeNull();
      rerender(<ConversationBar conversation={{ messages: [message(10, { current: true })], repliedBy: null } as never} onOpen={() => {}} />);
      expect(screen.queryByText(/Conversation/)).toBeNull();
      rerender(<ConversationBar conversation={null} onOpen={() => {}} />);
      expect(screen.queryByText(/Conversation/)).toBeNull();
    });

    async function openHello(opts: Parameters<typeof installMockFetch>[0]) {
      installMockFetch(opts);
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await openAccountInbox();
      await userEvent.click(await screen.findByText("Hello there"));
      await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(1));
    }

    test("opening a message that is part of a conversation shows the bar, and the header's reply icon opens the answer without moving the list", async () => {
      await openHello({ conversation: THREE });
      expect(await screen.findByText(/Conversation · 3 messages/)).toBeTruthy();

      await userEvent.click(screen.getByRole("button", { name: "You replied — see your reply" }));
      // message 11 is the mock's "Second message": it is the open message now…
      await waitFor(() => expect(screen.getAllByText("Second message").length).toBeGreaterThan(1));
      // …while the list you were browsing is the same one, and the address is the message's own place (the Sent folder in real life)
      expect(screen.getByText("Hello there")).toBeTruthy();
    });

    test("an earlier message of the conversation opens with one click in the list of the conversation", async () => {
      await openHello({ conversation: THREE });
      await userEvent.click(await screen.findByText(/Conversation · 3 messages/));
      const list = await screen.findByLabelText("Messages in this conversation");
      await userEvent.click(within(list).getByText("Danke, super."));
      await waitFor(() => expect(screen.getAllByText("Second message").length).toBeGreaterThan(1));
    });

    test("no conversation, no bar and no reply icon", async () => {
      await openHello({});
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(screen.queryByText(/Conversation ·/)).toBeNull();
      expect(screen.queryByRole("button", { name: /you replied/i })).toBeNull();
    });
  });

  describe("the imbox", () => {
    async function openApp() {
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await screen.findByText("Unified hello");
    }
    const entries = () =>
      Array.from(document.querySelectorAll("[title]")).map(el => el.getAttribute("title")!).filter(title => /^(Inbox|Imbox|Sent) of all accounts$/.test(title));
    const last = (list: "imbox") => listRequests.filter(r => r.list === list).at(-1)!.params;

    describe("the unread count and the mark by hand", () => {
      const imboxRow = () => screen.getByTitle("Imbox of all accounts");

      test("the Imbox entry shows the number of unread important messages, and no badge at zero", async () => {
        installMockFetch({ settings: { imboxEnabled: true }, imboxUnread: 4 });
        await openApp();
        await waitFor(() => expect(imboxRow().textContent).toContain("4"));
        expect(screen.getByTitle("Inbox of all accounts").textContent).not.toContain("4"); // the Inbox has its own count
      });

      test("no badge at zero", async () => {
        installMockFetch({ settings: { imboxEnabled: true }, imboxUnread: 0 });
        await openApp();
        await waitFor(() => expect(imboxUnreadRequests).toBeGreaterThan(0));
        expect(imboxRow().querySelector('[data-slot="badge"]')).toBeNull();
      });

      test("without the imbox the count is never asked for", async () => {
        await openApp();
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(imboxUnreadRequests).toBe(0);
      });

      async function openMessage(opts: Parameters<typeof installMockFetch>[0]) {
        installMockFetch(opts);
        render(<App />);
        await userEvent.click(await screen.findByText("default"));
        await openAccountInbox();
        await userEvent.click(await screen.findByText("Hello there"));
        await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(1));
      }

      test("the message header has a quiet mark while the imbox is on; it says where the message is and flips it", async () => {
        await openMessage({ settings: { imboxEnabled: true }, emailImbox: false });
        const mark = await screen.findByRole("button", { name: /Not in the Imbox — mark as important/ });
        expect(mark.getAttribute("aria-pressed")).toBe("false");
        expect(mark.className).toContain("text-muted-foreground/40"); // quiet while it isn't

        await userEvent.click(mark);
        await waitFor(() => expect(imboxMarks).toEqual([{ id: 10, imbox: true }]));
        const lit = await screen.findByRole("button", { name: /In the Imbox — mark as not important/ });
        expect(lit.getAttribute("aria-pressed")).toBe("true");
        expect(lit.className).toContain("text-primary");
        expect((await screen.findAllByText(/Marked as important — it is in the Imbox, and so is mail from alice@example.com from now on/)).length).toBeGreaterThan(0);

        await userEvent.click(lit); // and back
        await waitFor(() => expect(imboxMarks.at(-1)).toEqual({ id: 10, imbox: false }));
        expect((await screen.findAllByText(/Marked as not important — it leaves the Imbox/)).length).toBeGreaterThan(0);
      });

      test("a message that is in the imbox shows the mark lit from the start", async () => {
        await openMessage({ settings: { imboxEnabled: true }, emailImbox: true });
        expect((await screen.findByRole("button", { name: /In the Imbox/ })).getAttribute("aria-pressed")).toBe("true");
      });

      test("an unclassified message counts as not in the imbox", async () => {
        await openMessage({ settings: { imboxEnabled: true }, emailImbox: null });
        expect((await screen.findByRole("button", { name: /Not in the Imbox/ })).getAttribute("aria-pressed")).toBe("false");
      });

      test("no mark without the imbox", async () => {
        await openMessage({});
        expect(screen.queryByRole("button", { name: /Imbox/ })).toBeNull();
      });

      test("on a disabled account's mail the mark can't be clicked (the account is frozen)", async () => {
        await openMessage({ settings: { imboxEnabled: true }, accountOverrides: { disabled: true } });
        expect((await screen.findByRole("button", { name: /Not in the Imbox/ })).hasAttribute("disabled")).toBe(true);
      });

      test("reading an important message lowers the badge at once; marking asks for the count again", async () => {
        await openMessage({ settings: { imboxEnabled: true }, imboxUnread: 3, emailImbox: true });
        await waitFor(() => expect(imboxRow().textContent).toContain("2")); // it was unread and is in the imbox: 3 → 2
        const before = imboxUnreadRequests;
        await userEvent.click(await screen.findByRole("button", { name: /In the Imbox/ }));
        await waitFor(() => expect(imboxUnreadRequests).toBeGreaterThan(before));
      });
    });

    test("off by default: the sidebar has just Inbox and Sent", async () => {
      await openApp();
      expect(entries()).toEqual(["Inbox of all accounts", "Sent of all accounts"]);
    });

    test("Enable imbox in Settings saves the setting and adds Imbox between Inbox and Sent", async () => {
      await openApp();
      await userEvent.click(screen.getByTitle("Settings"));
      const toggle = await screen.findByLabelText("Enable imbox");
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(screen.getByText(/bun run cli imbox classify/)).toBeTruthy(); // says how to classify the mail that is already there
      await userEvent.click(toggle);
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(capturedSettingsPatches).toEqual([{ ...DEFAULT_PATCH, imboxEnabled: true }]));
      await waitFor(() => expect(entries()).toEqual(["Inbox of all accounts", "Imbox of all accounts", "Sent of all accounts"]));
    });

    test("with it on, Imbox lists the important mail (its own list request), and its address is /u/imbox", async () => {
      installMockFetch({ settings: { imboxEnabled: true } });
      await openApp();
      await waitFor(() => expect(entries()).toContain("Imbox of all accounts"));

      await userEvent.click(screen.getByTitle("Imbox of all accounts"));
      expect(await screen.findByText("Imbox hello")).toBeTruthy();
      expect(screen.getByText("Imbox · all accounts")).toBeTruthy();
      expect(listRequests.some(r => r.list === "imbox")).toBe(true);
      await waitFor(() => expect(window.location.pathname).toBe("/u/imbox"));

      await userEvent.click(screen.getByTitle("Sent of all accounts")); // and back out
      await screen.findByText("Unified outgoing");
      await waitFor(() => expect(window.location.pathname).toBe("/u/sent"));
    });

    test("the date and category filters work in the imbox too", async () => {
      installMockFetch({ settings: { imboxEnabled: true } });
      await openApp();
      await userEvent.click(await screen.findByTitle("Imbox of all accounts"));
      await screen.findByText("Imbox hello");
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: /filter by category/i }));
      const dialog = within((await screen.findByText("Filter by category", { selector: "[data-slot=dialog-title]" })).closest('[role="dialog"]') as HTMLElement);
      await userEvent.click(dialog.getByRole("combobox", { name: "Add a category" }));
      await userEvent.click(await screen.findByRole("option", { name: /^finance/ }));
      await userEvent.click(dialog.getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(last("imbox").getAll("category")).toEqual(["finance"]));
    });

    test("a link to /u/imbox without the setting lands on the Inbox", async () => {
      window.history.replaceState(null, "", "/u/imbox");
      await openApp();
      await waitFor(() => expect(window.location.pathname).toBe("/"));
      expect(screen.getByText("Inbox · all accounts")).toBeTruthy();
    });
  });

  describe("filtering the list by date", () => {
    const localDay = (y: number, m: number, d: number) => new Date(y, m - 1, d);
    const last = (list: "folder" | "inbox" | "imbox" | "sent" | "search") => listRequests.filter(r => r.list === list).at(-1)!.params;

    async function openFolder() {
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await openAccountInbox();
      await screen.findByText("Hello there");
    }
    async function openDialog() {
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: /filter by date/i }));
      return within((await screen.findByText("Filter by date", { selector: "[data-slot=dialog-title]" })).closest('[role="dialog"]') as HTMLElement);
    }
    const setDay = (dialog: ReturnType<typeof within>, label: string, value: string) => fireEvent.change(dialog.getByLabelText(label), { target: { value } });

    test("a More button next to New opens the filter dialog; a specific day asks for that day (in the user's time zone) and shows a chip", async () => {
      await openFolder();
      expect(last("folder").has("after")).toBe(false); // no filter, no window
      const dialog = await openDialog();

      setDay(dialog, "Day", "2026-03-02");
      await userEvent.click(dialog.getByRole("button", { name: "Apply" }));

      await waitFor(() => expect(last("folder").get("after")).toBe(localDay(2026, 3, 2).toISOString()));
      expect(last("folder").get("before")).toBe(localDay(2026, 3, 3).toISOString()); // to the start of the next day
      expect(await screen.findByText("Nothing matches the filter.")).toBeTruthy();
      expect(screen.getByTitle("Change the date filter").textContent).toContain("2026");

      await userEvent.click(screen.getByLabelText("Clear the date filter"));
      await waitFor(() => expect(last("folder").has("after")).toBe(false));
      expect(await screen.findByText("Hello there")).toBeTruthy();
      expect(screen.queryByTitle("Change the date filter")).toBeNull();
    });

    test("a range includes both days; 'since' and 'before' set one side only", async () => {
      await openFolder();

      let dialog = await openDialog();
      await userEvent.click(dialog.getByRole("radio", { name: "Date range" }));
      setDay(dialog, "From", "2026-03-02");
      setDay(dialog, "To", "2026-03-04");
      await userEvent.click(dialog.getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(last("folder").get("before")).toBe(localDay(2026, 3, 5).toISOString())); // the last day is part of it
      expect(last("folder").get("after")).toBe(localDay(2026, 3, 2).toISOString());

      dialog = await openDialog();
      await userEvent.click(dialog.getByRole("radio", { name: "Since a date" }));
      setDay(dialog, "Since", "2026-03-02");
      await userEvent.click(dialog.getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(last("folder").has("before")).toBe(false));
      expect(last("folder").get("after")).toBe(localDay(2026, 3, 2).toISOString()); // that day is included

      dialog = await openDialog();
      await userEvent.click(dialog.getByRole("radio", { name: "Before a date" }));
      setDay(dialog, "Before", "2026-03-02");
      await userEvent.click(dialog.getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(last("folder").has("after")).toBe(false));
      expect(last("folder").get("before")).toBe(localDay(2026, 3, 2).toISOString()); // that day is not
    });

    test("a range that ends before it starts, or no date, can't be applied", async () => {
      await openFolder();
      const dialog = await openDialog();
      await userEvent.click(dialog.getByRole("radio", { name: "Date range" }));
      setDay(dialog, "From", "2026-03-05");
      setDay(dialog, "To", "2026-03-02");
      expect(dialog.getByText("The range ends before it starts.")).toBeTruthy();
      expect(dialog.getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(true);

      setDay(dialog, "To", "");
      expect(dialog.getByText("Pick a date.")).toBeTruthy();
    });

    test("the dialog shows the filter in effect and can clear it", async () => {
      await openFolder();
      let dialog = await openDialog();
      setDay(dialog, "Day", "2026-03-02");
      await userEvent.click(dialog.getByRole("button", { name: "Apply" }));
      await screen.findByTitle("Change the date filter");

      dialog = await openDialog();
      expect((dialog.getByLabelText("Day") as HTMLInputElement).value).toBe("2026-03-02");
      await userEvent.click(dialog.getByRole("button", { name: "Clear filter" }));
      await waitFor(() => expect(screen.queryByTitle("Change the date filter")).toBeNull());
    });

    test("it works in the combined Inbox too, and each list starts without a filter", async () => {
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await screen.findByText("Unified hello"); // the combined Inbox
      const dialog = await openDialog();
      setDay(dialog, "Day", "2026-03-02");
      await userEvent.click(dialog.getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(last("inbox").get("after")).toBe(localDay(2026, 3, 2).toISOString()));
      await screen.findByTitle("Change the date filter");

      await userEvent.click(screen.getByTitle("Sent of all accounts")); // another list: no filter
      await screen.findByText("Unified outgoing");
      expect(screen.queryByTitle("Change the date filter")).toBeNull();
      expect(last("sent").has("after")).toBe(false);
    });

    test("opening a search result from another folder leaves the browsed folder, the filter and the sidebar alone", async () => {
      await openFolder();
      const dialog = await openDialog();
      setDay(dialog, "Day", "2026-03-02");
      await userEvent.click(dialog.getByRole("button", { name: "Apply" }));
      await screen.findByTitle("Change the date filter");
      await userEvent.type(screen.getByPlaceholderText(/search all mail/i), "in-archive");
      const hit = await screen.findByText("Second message");
      const folderRequests = listRequests.filter(r => r.list === "folder").length;
      const inboxRow = () => screen.getAllByText("Inbox")[1]!.closest("button")!;
      expect(inboxRow().className).toContain("bg-accent"); // the browsed folder is highlighted

      await userEvent.click(hit);
      await waitFor(() => expect(screen.getAllByText("Second message").length).toBeGreaterThan(1)); // the message opens

      expect(screen.getByTitle("Change the date filter")).toBeTruthy(); // the filter is still there…
      expect(inboxRow().className).toContain("bg-accent"); // …the sidebar still shows the folder being browsed…
      expect(listRequests.filter(r => r.list === "folder")).toHaveLength(folderRequests); // …and that list wasn't re-read for another folder
      expect(window.location.pathname).toBe("/a/me@example.com/Archive/11"); // the address is the message's own place

      await userEvent.clear(screen.getByPlaceholderText(/search all mail/i)); // back to the list that was browsed, still filtered
      await waitFor(() => expect(last("folder").get("after")).toBe(localDay(2026, 3, 2).toISOString()));
      expect(screen.getByTitle("Change the date filter")).toBeTruthy();
    });

    test("picking a folder in the sidebar afterwards makes that the scope again (and a new list starts unfiltered)", async () => {
      await openFolder();
      await userEvent.type(screen.getByPlaceholderText(/search all mail/i), "in-archive");
      await userEvent.click(await screen.findByText("Second message"));
      await waitFor(() => expect(window.location.pathname).toBe("/a/me@example.com/Archive/11"));

      await userEvent.click(screen.getAllByText("Inbox")[1]!);
      await waitFor(() => expect(window.location.pathname).toBe("/a/me@example.com/inbox/"));
    });

    describe("by category", () => {
      const categoriesOf = (list: "folder" | "inbox" | "sent" | "search") => last(list).getAll("category");
      async function openCategoryDialog() {
        await userEvent.click(screen.getByRole("button", { name: "More" }));
        await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: /filter by category/i }));
        return within((await screen.findByText("Filter by category", { selector: "[data-slot=dialog-title]" })).closest('[role="dialog"]') as HTMLElement);
      }
      async function choose(dialog: ReturnType<typeof within>, label: string) {
        await userEvent.click(dialog.getByRole("combobox", { name: "Add a category" }));
        await userEvent.click(await screen.findByRole("option", { name: new RegExp(`^${label}`) }));
      }

      test("the More menu has it beside Filter by date", async () => {
        await openFolder();
        await userEvent.click(screen.getByRole("button", { name: "More" }));
        await screen.findByRole("menuitemcheckbox", { name: /filter by date/i });
        const category = screen.getByRole("menuitemcheckbox", { name: /filter by category/i });
        expect(category.getAttribute("aria-checked")).toBe("false"); // a checkmark once categories are chosen
      });

      test("the category entry shows a checkmark while categories are chosen", async () => {
        await openFolder();
        const dialog = await openCategoryDialog();
        await choose(dialog, "travel");
        await userEvent.click(dialog.getByRole("button", { name: "Apply" }));
        await waitFor(() => expect(categoriesOf("folder")).toEqual(["travel"]));
        await userEvent.click(screen.getByRole("button", { name: "More" }));
        expect((await screen.findByRole("menuitemcheckbox", { name: /filter by category/i })).getAttribute("aria-checked")).toBe("true");
      });

      test("the combobox lists the available categories with their counts, searchable; chosen ones become labels that can be removed", async () => {
        await openFolder();
        const dialog = await openCategoryDialog();
        expect(dialog.getByText("No category chosen: every message is shown.")).toBeTruthy();

        await userEvent.click(dialog.getByRole("combobox", { name: "Add a category" }));
        expect((await screen.findAllByRole("option")).map(o => o.textContent)).toEqual(["finance5", "travel2", "invoice1"]);
        await userEvent.type(screen.getByPlaceholderText("Find a category…"), "inv");
        await waitFor(() => expect(screen.getAllByRole("option").map(o => o.textContent)).toEqual(["invoice1"]));
        await userEvent.click(screen.getByRole("option", { name: /^invoice/ }));

        const chosen = dialog.getByRole("list", { name: "Chosen categories" });
        expect(within(chosen).getByText("invoice")).toBeTruthy();
        await choose(dialog, "finance");
        expect(Array.from(chosen.querySelectorAll("li")).map(li => li.textContent)).toEqual(["invoice", "finance"]);

        await userEvent.click(dialog.getByRole("combobox", { name: "Add a category" })); // a chosen one isn't offered again
        expect((await screen.findAllByRole("option")).map(o => o.textContent)).toEqual(["travel2"]);
        await userEvent.keyboard("{Escape}");

        await userEvent.click(dialog.getByRole("button", { name: "Remove invoice" }));
        expect(Array.from(chosen.querySelectorAll("li")).map(li => li.textContent)).toEqual(["finance"]);
      });

      test("Apply filters the list by every chosen category, and shows them; Cancel changes nothing", async () => {
        await openFolder();
        let dialog = await openCategoryDialog();
        await choose(dialog, "finance");
        await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByText("Filter by category", { selector: "[data-slot=dialog-title]" })).toBeNull());
        expect(last("folder").has("category")).toBe(false);

        dialog = await openCategoryDialog();
        await choose(dialog, "finance");
        await choose(dialog, "travel");
        await userEvent.click(dialog.getByRole("button", { name: "Apply" }));

        await waitFor(() => expect(categoriesOf("folder")).toEqual(["finance", "travel"]));
        expect(await screen.findByText("Nothing matches the filter.")).toBeTruthy();
        const bar = screen.getByLabelText("Category filter");
        expect(Array.from(bar.querySelectorAll("li")).map(li => li.textContent)).toEqual(["finance", "travel"]);

        await userEvent.click(screen.getByRole("button", { name: "Remove finance from the filter" })); // × on a label in the list header
        await waitFor(() => expect(categoriesOf("folder")).toEqual(["travel"]));
        await userEvent.click(screen.getByRole("button", { name: "Remove travel from the filter" }));
        await waitFor(() => expect(last("folder").has("category")).toBe(false));
        expect(await screen.findByText("Hello there")).toBeTruthy();
        expect(screen.queryByLabelText("Category filter")).toBeNull();
      });

      test("the dialog shows what is in effect and can clear it", async () => {
        await openFolder();
        let dialog = await openCategoryDialog();
        await choose(dialog, "finance");
        await userEvent.click(dialog.getByRole("button", { name: "Apply" }));
        await screen.findByLabelText("Category filter");

        dialog = await openCategoryDialog();
        expect(within(dialog.getByRole("list", { name: "Chosen categories" })).getByText("finance")).toBeTruthy();
        await userEvent.click(dialog.getByRole("button", { name: "Clear filter" }));
        await waitFor(() => expect(screen.queryByLabelText("Category filter")).toBeNull());
      });

      test("it combines with the date filter and with a search, and each list starts without", async () => {
        await openFolder();
        let dialog = await openCategoryDialog();
        await choose(dialog, "finance");
        await userEvent.click(dialog.getByRole("button", { name: "Apply" }));
        const dateDialog = await openDialog();
        setDay(dateDialog, "Day", "2026-03-02");
        await userEvent.click(dateDialog.getByRole("button", { name: "Apply" }));
        await waitFor(() => expect(last("folder").get("after")).toBe(localDay(2026, 3, 2).toISOString()));
        expect(categoriesOf("folder")).toEqual(["finance"]); // both apply

        await userEvent.type(screen.getByPlaceholderText(/search all mail/i), "second");
        await waitFor(() => expect(listRequests.some(r => r.list === "search")).toBe(true));
        expect(last("search").get("q")).toBe("second");
        expect(categoriesOf("search")).toEqual(["finance"]); // the same query, within the categories (and dates)
        expect(last("search").get("after")).toBe(localDay(2026, 3, 2).toISOString());

        await userEvent.clear(screen.getByPlaceholderText(/search all mail/i));
        await userEvent.click(screen.getByTitle("Sent of all accounts")); // another list: no filters
        await screen.findByText("Unified outgoing");
        expect(screen.queryByLabelText("Category filter")).toBeNull();
        expect(last("sent").has("category")).toBe(false);
        dialog = within(document.body);
      });

      test("it works in the combined Inbox", async () => {
        render(<App />);
        await userEvent.click(await screen.findByText("default"));
        await screen.findByText("Unified hello");
        const dialog = await openCategoryDialog();
        await choose(dialog, "travel");
        await userEvent.click(dialog.getByRole("button", { name: "Apply" }));
        await waitFor(() => expect(categoriesOf("inbox")).toEqual(["travel"]));
      });
    });

    describe("favorites and read / unread", () => {
      const toggle = async (name: RegExp | string) => {
        await userEvent.click(screen.getByRole("button", { name: "More" }));
        await userEvent.click(await screen.findByRole("menuitemcheckbox", { name }));
      };

      test("the More menu has Filter by date, Favorites, Read and Unread all as check items, unchecked", async () => {
        await openFolder();
        await userEvent.click(screen.getByRole("button", { name: "More" }));
        const items = screen.getAllByRole("menuitemcheckbox");
        expect(items.map(i => [i.textContent!.trim(), i.getAttribute("aria-checked")])).toEqual([
          ["Filter by date…", "false"],
          ["Filter by category…", "false"],
          ["Favorites", "false"],
          ["Read", "false"],
          ["Unread", "false"],
        ]);
        expect(screen.queryByText(/only/i)).toBeNull(); // no "Favorites only" / "Unread only", no "Read and unread"
        expect(screen.queryByRole("menuitem")).toBeNull(); // every item here is a check item now, none plain
        expect(screen.queryByRole("menuitemradio")).toBeNull();
      });

      test("a selected one shows a checkmark; Favorites asks the server for flagged messages, shows a chip and clears again", async () => {
        await openFolder();
        expect(last("folder").has("flagged")).toBe(false);
        await toggle("Favorites");
        await waitFor(() => expect(last("folder").get("flagged")).toBe("true"));
        expect(within(screen.getByRole("list", { name: "Active filters" })).getByText("Favorites")).toBeTruthy();
        await userEvent.click(screen.getByRole("button", { name: "More" }));
        expect((await screen.findByRole("menuitemcheckbox", { name: "Favorites" })).getAttribute("aria-checked")).toBe("true");
        await userEvent.keyboard("{Escape}");

        await userEvent.click(screen.getByLabelText("Remove the favorites filter"));
        await waitFor(() => expect(last("folder").has("flagged")).toBe(false));
        expect(screen.queryByRole("list", { name: "Active filters" })).toBeNull();
      });

      test("Read alone sends read=true, Unread alone read=false; both on or both off filter nothing", async () => {
        await openFolder();
        expect(last("folder").has("read")).toBe(false);

        await toggle("Unread");
        await waitFor(() => expect(last("folder").get("read")).toBe("false"));
        expect(within(screen.getByRole("list", { name: "Active filters" })).getByText("Unread")).toBeTruthy();

        await toggle("Read"); // both selected: no filtering by them
        await waitFor(() => expect(last("folder").has("read")).toBe(false));
        expect(screen.queryByRole("list", { name: "Active filters" })).toBeNull();

        await toggle("Unread"); // only Read remains
        await waitFor(() => expect(last("folder").get("read")).toBe("true"));
        expect(within(screen.getByRole("list", { name: "Active filters" })).getByText("Read")).toBeTruthy();

        await toggle("Read"); // none selected
        await waitFor(() => expect(last("folder").has("read")).toBe(false));
      });

      test("they combine with each other and the date filter; a chip's × removes it", async () => {
        await openFolder();
        await toggle("Read");
        await toggle("Favorites");
        const dialog = await openDialog();
        setDay(dialog, "Day", "2026-03-02");
        await userEvent.click(dialog.getByRole("button", { name: "Apply" }));
        await waitFor(() => expect(last("folder").get("after")).toBe(localDay(2026, 3, 2).toISOString()));
        expect(last("folder").get("flagged")).toBe("true");
        expect(last("folder").get("read")).toBe("true");

        await userEvent.click(screen.getByLabelText("Remove the read / unread filter"));
        await waitFor(() => expect(last("folder").has("read")).toBe(false));
        expect(last("folder").get("flagged")).toBe("true");
      });

      test("they narrow a search and the combined lists too, and each list starts without them", async () => {
        await openFolder();
        await toggle("Unread");
        await userEvent.type(screen.getByPlaceholderText(/search all mail/i), "second");
        await waitFor(() => expect(listRequests.some(r => r.list === "search")).toBe(true));
        expect(last("search").get("q")).toBe("second");
        expect(last("search").get("read")).toBe("false");

        await userEvent.click(screen.getByTitle("Inbox of all accounts")); // another list: no filters
        await screen.findByText("Unified hello");
        expect(screen.queryByRole("list", { name: "Active filters" })).toBeNull();
        expect(last("inbox").has("read")).toBe(false);
        await toggle("Favorites");
        await waitFor(() => expect(last("inbox").get("flagged")).toBe("true"));
        await userEvent.click(screen.getByRole("button", { name: "More" }));
        expect((await screen.findByRole("menuitemcheckbox", { name: "Unread" })).getAttribute("aria-checked")).toBe("false");
      });

      test("`favs` is no search command any more: it is searched for like any word", async () => {
        await openFolder();
        await userEvent.type(screen.getByPlaceholderText(/search all mail/i), "favs second");
        await waitFor(() => expect(listRequests.some(r => r.list === "search")).toBe(true));
        expect(last("search").get("q")).toBe("favs second");
        expect(last("search").has("flagged")).toBe(false);
      });
    });

    test("More sits to the left of New", async () => {
      await openFolder();
      const more = screen.getByRole("button", { name: "More" });
      const create = screen.getByRole("button", { name: /^new$/i });
      expect(more.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    test("a search is combined with the date filter: the same query, within the dates", async () => {
      await openFolder();
      const dialog = await openDialog();
      await userEvent.click(dialog.getByRole("radio", { name: "Before a date" }));
      setDay(dialog, "Before", "2011-09-20");
      await userEvent.click(dialog.getByRole("button", { name: "Apply" }));
      await screen.findByTitle("Change the date filter");

      await userEvent.type(screen.getByPlaceholderText(/search all mail/i), "second");
      await waitFor(() => expect(screen.getByText(/Search: "second"/)).toBeTruthy());
      await waitFor(() => expect(listRequests.some(r => r.list === "search")).toBe(true));
      expect(last("search").get("q")).toBe("second");
      expect(last("search").get("before")).toBe(localDay(2011, 9, 20).toISOString());
      expect(last("search").has("after")).toBe(false);
      expect(screen.getByTitle("Change the date filter")).toBeTruthy(); // the chip stays while searching
      expect(screen.getByRole("button", { name: "More" })).toBeTruthy();
    });

    test("changing or clearing the filter re-runs the search; without a filter the search has no window", async () => {
      await openFolder();
      await userEvent.type(screen.getByPlaceholderText(/search all mail/i), "second");
      await waitFor(() => expect(listRequests.some(r => r.list === "search")).toBe(true));
      expect(last("search").has("before")).toBe(false);

      const dialog = await openDialog();
      setDay(dialog, "Day", "2026-03-02");
      await userEvent.click(dialog.getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(last("search").get("after")).toBe(localDay(2026, 3, 2).toISOString()));
      expect(last("search").get("q")).toBe("second");

      await userEvent.click(screen.getByLabelText("Clear the date filter"));
      await waitFor(() => expect(last("search").has("after")).toBe(false));
    });

    test("the filter survives typing and closing a search", async () => {
      await openFolder();
      const dialog = await openDialog();
      setDay(dialog, "Day", "2026-03-02");
      await userEvent.click(dialog.getByRole("button", { name: "Apply" }));
      await screen.findByTitle("Change the date filter");

      const box = screen.getByPlaceholderText(/search all mail/i);
      await userEvent.type(box, "second");
      await userEvent.clear(box);
      await waitFor(() => expect(screen.queryByText(/Search:/)).toBeNull());
      expect(screen.getByTitle("Change the date filter")).toBeTruthy();
      await waitFor(() => expect(last("folder").get("after")).toBe(localDay(2026, 3, 2).toISOString()));
    });
  });

  test("double-clicking a message reads it with the list collapsed; the strip brings the list back", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();

    await userEvent.dblClick(await screen.findByText("Hello there"));
    await screen.findByTitle("Show the message list");
    expect(screen.queryByText("Second message")).toBeNull(); // the list is gone…
    await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(0)); // …the message stays open
    expect(screen.getByRole("button", { name: /^reply$/i })).toBeTruthy();

    await userEvent.click(screen.getByTitle("Show the message list"));
    expect(await screen.findByText("Second message")).toBeTruthy();
    expect(screen.queryByTitle("Show the message list")).toBeNull();
  });

  test("reading mode also collapses the accounts/folders bar — without touching the remembered choice — and either strip brings both back", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();
    expect(screen.getByText("Accounts")).toBeTruthy(); // the bar is open

    await userEvent.dblClick(await screen.findByText("Hello there"));
    await screen.findByTitle("Show the message list");
    expect(screen.queryByText("Accounts")).toBeNull(); // the bar is out of the way too
    expect(screen.queryByText("me@example.com")).toBeNull();
    expect(localStorage.getItem("psmail.sidebarCollapsed")).not.toBe("true"); // just for now, not the user's setting

    await userEvent.click(screen.getByTitle("Show accounts and the message list"));
    expect(await screen.findByText("Accounts")).toBeTruthy();
    expect(await screen.findByText("Second message")).toBeTruthy();

    await userEvent.dblClick((await screen.findAllByText("Hello there"))[0]!);
    await screen.findByTitle("Show the message list");
    await userEvent.click(screen.getByTitle("Show the message list")); // the list's own strip does the same
    expect(await screen.findByText("Accounts")).toBeTruthy();
  });

  test("a bar the user collapsed themselves stays collapsed after reading mode", async () => {
    localStorage.setItem("psmail.sidebarCollapsed", "true");
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await userEvent.dblClick(await screen.findByText("Unified hello")); // the combined Inbox needs no sidebar
    await screen.findByTitle("Show the message list");

    await userEvent.click(screen.getByTitle("Show the message list"));
    expect(await screen.findByText("Unified hello")).toBeTruthy(); // the list is back…
    expect(screen.getByTitle("Show accounts")).toBeTruthy(); // …and the bar is still the way the user left it: collapsed
    expect(screen.queryByText("Accounts")).toBeNull();
  });

  test("a draft still opens for editing on double-click, and the list stays", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();

    await userEvent.dblClick(await screen.findByText("Unfinished draft"));
    await screen.findByText("Edit draft", { selector: "[data-slot=dialog-title]" });
    expect(screen.queryByTitle("Show the message list")).toBeNull();
  });

  test("the collapsed list comes back when there is nothing to read, or a search is typed", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();

    await userEvent.dblClick(await screen.findByText("Hello there"));
    await screen.findByTitle("Show the message list");
    await userEvent.type(screen.getByPlaceholderText(/search all mail/i), "x"); // typing a search shows its list
    await waitFor(() => expect(screen.queryByTitle("Show the message list")).toBeNull());
    expect(await screen.findByText("Accounts")).toBeTruthy(); // and the accounts bar too
    await userEvent.clear(screen.getByPlaceholderText(/search all mail/i));

    await userEvent.dblClick((await screen.findAllByText("Hello there"))[0]!);
    await screen.findByTitle("Show the message list");
    await userEvent.type(screen.getByPlaceholderText(/search all mail/i), "second"); // a search shows its results list
    await waitFor(() => expect(screen.queryByTitle("Show the message list")).toBeNull());
  });

  test("double-clicking a search result collapses the list too", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();
    await userEvent.type(screen.getByPlaceholderText(/search all mail/i), "second");
    await waitFor(() => expect(screen.getByText(/Search: "second"/)).toBeTruthy());

    await userEvent.dblClick(await screen.findByText("Second message"));
    await screen.findByTitle("Show the message list");
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

  test("Account settings → Misc has 'Exclude from automatic sync', and saving sends it", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();
    await userEvent.click(screen.getByTitle("More actions"));
    await userEvent.click(screen.getByText("Account settings"));
    await screen.findByText("Account settings", { selector: "[data-slot=dialog-title]" });

    await userEvent.click(screen.getByRole("tab", { name: "Misc" }));
    const toggle = screen.getByLabelText("Exclude from automatic sync");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(capturedAccountPatch).toMatchObject({ excludeFromAutoSync: true }));
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

  test("Sync now refreshes the currently open list, without needing to click the folder again", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();
    await screen.findByText("Hello there");
    const listRequestsBefore = listRequests.filter(r => r.list === "folder").length;

    await userEvent.click(screen.getByTitle("Sync now"));
    await waitFor(() => expect(downloadPosts).toEqual([{}]));
    await waitFor(() => expect(listRequests.filter(r => r.list === "folder").length).toBeGreaterThan(listRequestsBefore));
  });

  test("Sync now also refreshes the combined Inbox when that's the open view, not just a folder list", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await screen.findByText("Unified hello"); // the app opens on the combined Inbox
    const inboxRequestsBefore = listRequests.filter(r => r.list === "inbox").length;

    await userEvent.click(screen.getByTitle("Sync now"));
    await waitFor(() => expect(downloadPosts).toEqual([{}]));
    await waitFor(() => expect(listRequests.filter(r => r.list === "inbox").length).toBeGreaterThan(inboxRequestsBefore));
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

  test("an account excluded from automatic sync is skipped by the interval sync", async () => {
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
      installMockFetch({ settings: { syncIntervalMinutes: 3 }, extraAccounts: [{ email: "gmail@example.com", excludeFromAutoSync: true }] });
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await waitFor(() => expect(minuteTimers).toHaveLength(1));

      await act(async () => minuteTimers[0]!());
      await waitFor(() => expect(downloadAccounts).toEqual(["me@example.com"]));
      expect(downloadAccounts).not.toContain("gmail@example.com");
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });

  describe("search options: full text search", () => {
    const lastSearch = () => listRequests.filter(r => r.list === "search").at(-1)!.params;
    async function openApp() {
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await openAccountInbox();
      await screen.findByText("Hello there");
    }

    test("the options button shows while the search box is in use, next to the close button, and not otherwise", async () => {
      await openApp();
      expect(screen.queryByRole("button", { name: "Search options" })).toBeNull();

      const box = screen.getByPlaceholderText(/search all mail/i);
      await userEvent.click(box);
      expect(await screen.findByRole("button", { name: "Search options" })).toBeTruthy();

      await userEvent.type(box, "second");
      const options = screen.getByRole("button", { name: "Search options" });
      const clear = screen.getByTitle("Clear search");
      expect(options.compareDocumentPosition(clear) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // options left of the x

      await userEvent.click(document.body);
      await waitFor(() => expect(screen.queryByRole("button", { name: "Search options" })).toBeNull());
    });

    test("the Full text search toggle re-runs the search with fulltext=1, and the choice is remembered", async () => {
      await openApp();
      const box = screen.getByPlaceholderText(/search all mail/i);
      await userEvent.type(box, "second");
      await waitFor(() => expect(listRequests.some(r => r.list === "search")).toBe(true));
      expect(lastSearch().has("fulltext")).toBe(false);
      expect(localStorage.getItem("psmail.fullTextSearch")).toBeNull();

      await userEvent.click(screen.getByRole("button", { name: "Search options" }));
      const toggle = await screen.findByRole("menuitemcheckbox", { name: "Full text search" });
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      await userEvent.click(toggle);

      await waitFor(() => expect(lastSearch().get("fulltext")).toBe("1"));
      expect(lastSearch().get("q")).toBe("second");
      expect(localStorage.getItem("psmail.fullTextSearch")).toBe("true");
      expect(screen.getByRole("menuitemcheckbox", { name: "Full text search" }).getAttribute("aria-checked")).toBe("true"); // the menu stays open
      expect(await screen.findByText('Search: "second" · full text')).toBeTruthy();

      await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Full text search" })); // and off again
      await waitFor(() => expect(lastSearch().has("fulltext")).toBe(false));
      expect(localStorage.getItem("psmail.fullTextSearch")).toBe("false");
    });

    test("a stored 'on' is used from the start", async () => {
      localStorage.setItem("psmail.fullTextSearch", "true");
      await openApp();
      await userEvent.type(screen.getByPlaceholderText(/search all mail/i), "second");
      await waitFor(() => expect(listRequests.some(r => r.list === "search")).toBe(true));
      expect(lastSearch().get("fulltext")).toBe("1");
    });
  });

  test("hits found only in the message text are said to be, in the results header", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();

    const searchBox = screen.getByPlaceholderText(/search all mail/i);
    await userEvent.type(searchBox, "second");
    await waitFor(() => expect(screen.getByText(/Search: "second"/)).toBeTruthy());
    expect(screen.getByText(/Search: "second"/).textContent).not.toContain("message text");

    await userEvent.clear(searchBox);
    await userEvent.type(searchBox, "only-in-the-text");
    expect(await screen.findByText('Search: "only-in-the-text" · in message text')).toBeTruthy();
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

  test("the header shows the P.S.Mail logo instead of the mail icon and the name", async () => {
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();

    const logo = screen.getByAltText("P.S.Mail") as HTMLImageElement;
    expect(logo.getAttribute("src")).toContain("psmail_logo.svg");
    expect(logo.closest("header")).toBeTruthy();
    expect(screen.getByRole("banner").querySelector("svg.lucide-mail")).toBeNull(); // no round mail icon…
    expect(within(screen.getByRole("banner")).queryByText("P.S.Mail")).toBeNull(); // …and no text next to it
  });

  test("the login window shows the P.S.Mail logo instead of the round mail icon", async () => {
    render(<App />);
    const logo = (await screen.findByAltText("P.S.Mail logo")) as HTMLImageElement;
    expect(document.querySelector(".bg-primary\\/10")).toBeNull();
    // Centered in the card header, which has no separate title: the logo carries the name.
    expect(logo.closest('[data-slot="card-header"]')).toBeTruthy();
    expect(logo.getAttribute("src")).toContain("psmail_logo_text.svg");

    // Room above and below the card, and the screen scrolls when the card is taller than the window.
    const card = logo.closest('[data-slot="card"]')!;
    const centered = card.parentElement!;
    expect(centered.className).toMatch(/\bpy-10\b/);
    expect(centered.parentElement!.className).toContain("overflow-y-auto");
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

  test("each folder row has its own sync button; clicking it syncs just that folder and refreshes the open list", async () => {
    installMockFetch();
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();
    await screen.findByText("Hello there");
    const listRequestsBefore = listRequests.filter(r => r.list === "folder").length;

    await userEvent.click(screen.getByTitle("Sync Entwürfe"));
    await waitFor(() => expect(downloadPosts.at(-1)).toEqual({ folder: "Entwürfe" })); // just this one folder, not every folder
    // The currently open list (INBOX, unrelated to the synced folder) still refreshes — sync completing
    // always re-reads whatever's on screen, not only the folder that was actually synced.
    await waitFor(() => expect(listRequests.filter(r => r.list === "folder").length).toBeGreaterThan(listRequestsBefore));
  });

  test("the folder sync button sits left of the unread count, like the combined Inbox's own sync button", async () => {
    installMockFetch();
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();

    // INBOX has 1 unread in the mock — its row shows the sync button, then the badge, in that order.
    const inboxRow = screen.getAllByText("Inbox", { selector: "span" }).at(-1)!.closest("div")!;
    const syncButton = within(inboxRow).getByTitle("Sync Inbox");
    const badge = within(inboxRow).getByText("1");
    expect(syncButton.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // sync button, then the badge
  });

  test("while a folder sync is running, only that folder's button shows a spinner — other folders show no sync button at all", async () => {
    installMockFetch({ syncStaysRunning: true });
    render(<App />);
    await userEvent.click(await screen.findByText("default"));
    await openAccountInbox();

    await userEvent.click(screen.getByTitle("Sync Entwürfe"));
    await waitFor(() => expect(screen.queryByTitle("Sync Entwürfe")).toBeNull()); // it's the progress tooltip now
    const entwuerfeRow = screen.getByText("Entwürfe").closest("div")!;
    const entwuerfeSpinner = within(entwuerfeRow).getByTitle("Syncing 12/340…");
    expect(entwuerfeSpinner.querySelector(".animate-spin")).toBeTruthy();

    // INBOX's own sync button isn't just disabled — it's gone entirely (not even a hover reveal) while
    // Entwürfe is the one actually syncing, the same way "Sync now" already disappears during a sync.
    const inboxRow = screen.getAllByText("Inbox", { selector: "span" }).at(-1)!.closest("div")!; // the account's own Inbox folder row, not the combined one
    expect(within(inboxRow).queryByTitle("Sync Inbox")).toBeNull();
    expect(within(inboxRow).queryByTitle(/^Syncing/)).toBeNull();
    expect(within(inboxRow).getAllByRole("button")).toHaveLength(1); // just the folder-name button
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

    describe("the username", () => {
      async function openCredentials() {
        await openSettings();
        await userEvent.click(screen.getByRole("tab", { name: "Credentials" }));
        return (await screen.findByLabelText("Username")) as HTMLInputElement;
      }
      const rename = () => screen.getByRole("button", { name: "Rename" });

      test("Credentials starts with the username, filled in; Rename is off until it is changed", async () => {
        const field = await openCredentials();
        expect(field.value).toBe("default");
        expect(rename().hasAttribute("disabled")).toBe(true);

        await userEvent.clear(field);
        expect(rename().hasAttribute("disabled")).toBe(true); // empty
        await userEvent.type(field, "  default  ");
        expect(rename().hasAttribute("disabled")).toBe(true); // only spaces around it
        await userEvent.clear(field);
        await userEvent.type(field, "philipp");
        expect(rename().hasAttribute("disabled")).toBe(false);
      });

      test("renaming sends the new name and updates this browser's session and the dialog", async () => {
        const field = await openCredentials();
        await userEvent.clear(field);
        await userEvent.type(field, "  philipp ");
        await userEvent.click(rename());

        await waitFor(() => expect(usernameChanges).toEqual([{ username: "philipp" }]));
        expect((await screen.findAllByText('Your username is now "philipp".')).length).toBeGreaterThan(0);
        expect(field.value).toBe("philipp");
        expect(JSON.parse(localStorage.getItem("psmail.session")!).username).toBe("philipp");
        expect(screen.getByText("For philipp")).toBeTruthy(); // the dialog's subtitle names the new user
        expect(rename().hasAttribute("disabled")).toBe(true);
      });

      test("a name that is taken is refused and shown, and nothing changes", async () => {
        installMockFetch({ changeUsernameError: 'Username "secure" already exists' });
        const field = await openCredentials();
        await userEvent.clear(field);
        await userEvent.type(field, "secure");
        await userEvent.click(rename());

        expect(await screen.findByText('Username "secure" already exists')).toBeTruthy();
        expect(JSON.parse(localStorage.getItem("psmail.session")!).username).toBe("default");
        expect(field.value).toBe("secure"); // left for the user to change
      });

      test("the passkey unlock of the old name is removed (it is bound to the name), with a note", async () => {
        localStorage.setItem("psmail.passkeyVault.default", JSON.stringify({ v: 2, entries: [{ credentialId: "abc", salt: "s", iv: "i", ciphertext: "c", addedAt: "2026-01-01" }] }));
        const field = await openCredentials();
        await userEvent.clear(field);
        await userEvent.type(field, "philipp");
        await userEvent.click(rename());

        expect((await screen.findAllByText(/passkey unlock for the old name was removed/)).length).toBeGreaterThan(0);
        expect(localStorage.getItem("psmail.passkeyVault.default")).toBeNull();
      });
    });

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

    describe("download", () => {
      const saved: string[] = [];
      const realClick = HTMLAnchorElement.prototype.click;
      beforeEach(() => {
        saved.length = 0;
        URL.createObjectURL = () => "blob:test";
        URL.revokeObjectURL = () => {};
        HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
          saved.push(this.download);
        };
      });
      afterEach(() => {
        HTMLAnchorElement.prototype.click = realClick;
      });

      test("one message is saved as its .eml, under the name the server gives (non-ASCII intact)", async () => {
        await openCombined();
        fireEvent.click(screen.getByText("Mine one"), { ctrlKey: true });
        await userEvent.click(await screen.findByTitle("Download as .eml"));

        await waitFor(() => expect(saved).toEqual(["2024-05-01 Grüße.eml"]));
        expect(messageDownloads).toEqual([{ account: "me@example.com", ids: [10] }]);
        expect((await screen.findAllByText("Downloaded 2024-05-01 Grüße.eml")).length).toBeGreaterThan(0);
        expect(screen.getByText("1 selected")).toBeTruthy(); // the selection stays
      });

      test("several messages are one zip, and a selection across accounts is one request (and file) per account", async () => {
        await openCombined();
        fireEvent.click(screen.getByText("Mine one"), { ctrlKey: true });
        fireEvent.click(screen.getByText("Mine two"), { ctrlKey: true });
        await userEvent.click(await screen.findByTitle("Download as a zip of .eml files"));
        await waitFor(() => expect(messageDownloads).toEqual([{ account: "me@example.com", ids: [10, 11] }]));
        await waitFor(() => expect(saved).toEqual(["me@example.com messages.zip"]));

        messageDownloads.length = 0;
        fireEvent.click(screen.getByText("Theirs three"), { ctrlKey: true });
        await userEvent.click(screen.getByTitle("Download as a zip of .eml files"));
        await waitFor(() => expect(messageDownloads).toEqual([{ account: "me@example.com", ids: [10, 11] }, { account: "you@example.com", ids: [12] }]));
      });
    });

    describe("download from the reading pane", () => {
      const saved: string[] = [];
      const realClick = HTMLAnchorElement.prototype.click;
      beforeEach(() => {
        saved.length = 0;
        URL.createObjectURL = () => "blob:test";
        URL.revokeObjectURL = () => {};
        HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
          saved.push(this.download);
        };
      });
      afterEach(() => {
        HTMLAnchorElement.prototype.click = realClick;
      });

      async function openMessage(opts: Parameters<typeof installMockFetch>[0] = {}) {
        installMockFetch(opts);
        render(<App />);
        await userEvent.click(await screen.findByText("default"));
        await openAccountInbox();
        await userEvent.click(await screen.findByText("Hello there"));
        return await screen.findByRole("button", { name: /download/i });
      }

      test("the toolbar's Download sits in its own group, just before Move, and saves the message as .eml", async () => {
        const download = await openMessage();
        const toolbar = download.parentElement!;
        const children = Array.from(toolbar.children);
        const at = children.indexOf(download);
        expect(children[at - 1]!.getAttribute("role")).toBe("none"); // separators before and after: a group of its own
        expect(children[at + 1]!.getAttribute("role")).toBe("none");
        expect(children[at + 2]!.textContent).toContain("Move");

        await userEvent.click(download);
        await waitFor(() => expect(saved).toEqual(["2024-05-01 Grüße.eml"]));
        expect(messageDownloads).toEqual([{ account: "me@example.com", ids: [10] }]);
      });

      test("it only reads, so it stays available on a disabled account", async () => {
        const download = await openMessage({ accountOverrides: { disabled: true } });
        expect(download.hasAttribute("disabled")).toBe(false);
        await userEvent.click(download);
        await waitFor(() => expect(messageDownloads).toHaveLength(1));
      });
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
      await userEvent.click(await screen.findByRole("option", { name: "Entwürfe" })); // the account's folders, minus INBOX where they all are

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

    test("the message id is hidden by default", async () => {
      await openDetails();
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

    test("the arrow (Expand all details) shows everything, including the message id, and collapses again", async () => {
      await openDetails();
      await userEvent.click(screen.getByRole("button", { name: "Expand all details" }));

      expect(screen.getByText("<abc123@mail.example.com>")).toBeTruthy();
      expect(screen.queryByText("Message-ID")).toBeNull(); // the id speaks for itself; no technical label
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
      expect(tabs).toEqual(["Inboxes", "UI", "Notifications", "AI", "Credentials"]);
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

    test("an OpenAI-compatible provider needs no key, suggests the LM Studio address and lets you choose among the server's models", async () => {
      installMockFetch();
      await login();
      await openAiTab();
      await userEvent.click(await screen.findByRole("button", { name: /add provider/i }));
      await userEvent.selectOptions(screen.getByLabelText("Vendor"), "openai-compatible");
      expect(screen.getByLabelText("API key (optional)")).toBeTruthy();
      expect((screen.getByLabelText(/Address/) as HTMLInputElement).placeholder).toBe("http://localhost:1234/v1");

      await userEvent.click(screen.getByRole("button", { name: "Find models" }));
      // Several models: the user chooses one (nothing is picked for them).
      const choice = (await screen.findByLabelText("Model")) as HTMLSelectElement;
      expect(choice.tagName).toBe("SELECT");
      expect(choice.value).toBe("");
      expect(Array.from(choice.options).map(o => o.value)).toEqual(["", "qwen/qwen3-8b", "llama-3"]);
      expect(calls("POST", "/api/ai/models")).toEqual([{ vendor: "openai-compatible", baseUrl: null, apiId: null }]);
      await userEvent.selectOptions(choice, "qwen/qwen3-8b");

      await userEvent.click(screen.getByRole("button", { name: "Save provider" }));
      await waitFor(() => expect(calls("POST", "/api/ai/apis")).toEqual([expect.objectContaining({ vendor: "openai-compatible", model: "qwen/qwen3-8b" })]));
      expect(await screen.findByText("OpenAI-compatible.qwen/qwen3-8b")).toBeTruthy();
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

    test("the provider list shows how much each provider has been used: calls and tokens in/out", async () => {
      installMockFetch({
        aiApis: [
          { id: 1, name: "Work", vendor: "anthropic", model: "claude-opus-5", baseUrl: null, hasKey: true, calls: 8, inputTokens: 12_345, outputTokens: 4_560 },
          { id: 2, name: "Local", vendor: "ollama", model: "llama3", baseUrl: null, hasKey: false, calls: 1, inputTokens: 950, outputTokens: 2_500_000 },
          { id: 3, name: "Idle", vendor: "openai", model: "gpt-5", baseUrl: null, hasKey: true },
        ],
      });
      await login();
      await openAiTab();

      expect(await screen.findByText("8 calls · 12k tokens in · 4.6k out")).toBeTruthy();
      expect(screen.getByText("1 call · 950 tokens in · 2.5M out")).toBeTruthy();
      expect(screen.getByText("Not used yet")).toBeTruthy();
      // The exact numbers are on hover.
      expect(screen.getByText("8 calls · 12k tokens in · 4.6k out").getAttribute("title")).toBe("12,345 tokens in, 4,560 tokens out");
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

    test("Summary is an extra tab after HTML; it is offered only with a Summarize skill (or an existing summary)", async () => {
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
      expect(tab.querySelector("svg")).toBeNull(); // no summary yet: no sparkles (they show once there is one)
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

    describe("dates and events found by the AI", () => {
    const saved: { name: string; text: Promise<string> }[] = [];
    const realClick = HTMLAnchorElement.prototype.click;
    const realCreate = URL.createObjectURL;
    beforeEach(() => {
      saved.length = 0;
      URL.createObjectURL = (blob: Blob) => {
        saved.push({ name: "", text: blob.text() });
        return "blob:test";
      };
      URL.revokeObjectURL = () => {};
      HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
        saved[saved.length - 1]!.name = this.download;
      };
    });
    afterEach(() => {
      HTMLAnchorElement.prototype.click = realClick;
      URL.createObjectURL = realCreate;
    });

    test("nothing is shown for a message without events", () => {
      render(<EventsButton events={[]} />);
      expect(screen.queryByRole("button", { name: /found/i })).toBeNull();
    });

    test("the button says how many were found — dates, or one date", () => {
      const { unmount } = render(<EventsButton events={[TEST_ICS_DEADLINE, TEST_ICS_CALL]} />);
      expect(screen.getByRole("button", { name: /^Found 2 dates$/ }).querySelector("svg.lucide-calendar-plus")).toBeTruthy();
      unmount();
      render(<EventsButton events={[TEST_ICS_DEADLINE]} />);
      expect(screen.getByRole("button", { name: /^Found 1 date$/ })).toBeTruthy();
    });

    test("each event is listed with its title, date and place, and downloads as its own .ics", async () => {
      render(<EventsButton events={[TEST_ICS_DEADLINE, TEST_ICS_CALL]} />);
      expect(screen.queryByText("Submit documents")).toBeNull(); // closed until asked
      await userEvent.click(screen.getByRole("button", { name: /found 2 dates/i }));

      const items = await screen.findAllByRole("menuitem");
      expect(items.map(item => item.textContent)).toEqual([expect.stringContaining("Submit documents"), expect.stringContaining("Call with Alice, Bob"), expect.stringContaining("All 2 in one file")]);
      expect(items[1]!.textContent).toContain("Phone; Berlin");
      expect(items[1]!.textContent).toContain("2026");

      await userEvent.click(items[1]!);
      await waitFor(() => expect(saved).toHaveLength(1));
      expect(saved[0]!.name).toBe("Call with Alice, Bob.ics");
      expect(await saved[0]!.text).toBe(TEST_ICS_CALL);
    });

    test("with several, the last entry downloads all of them in a single .ics", async () => {
      render(<EventsButton events={[TEST_ICS_DEADLINE, TEST_ICS_CALL]} />);
      await userEvent.click(screen.getByRole("button", { name: /found 2 dates/i }));
      await userEvent.click(await screen.findByRole("menuitem", { name: /all 2 in one file/i }));
      await waitFor(() => expect(saved).toHaveLength(1));
      const text = await saved[0]!.text;
      expect(saved[0]!.name).toBe("events.ics");
      expect(text.match(/BEGIN:VCALENDAR/g)).toHaveLength(1);
      expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(2);
      expect(text).toContain("SUMMARY:Submit documents");
      expect(text).toContain("SUMMARY:Call with Alice");
      expect(text.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    });

    test("a single event has no 'all in one file' entry", async () => {
      render(<EventsButton events={[TEST_ICS_DEADLINE]} />);
      await userEvent.click(screen.getByRole("button", { name: /found 1 date/i }));
      expect(await screen.findAllByRole("menuitem")).toHaveLength(1);
    });

    test("the Summary tab has the sparkles icon only once a summary exists", async () => {
      installMockFetch({ aiSkillCategories: ["summarize"] });
      await login();
      await userEvent.click(await screen.findByText("Hello there"));
      const tab = await screen.findByRole("tab", { name: "Summary" });
      expect(tab.querySelector("svg")).toBeNull();

      await userEvent.click(tab);
      await userEvent.click(await screen.findByRole("button", { name: "Summarize with AI" }));
      await screen.findByText(/Alice says hello/);
      expect(screen.getByRole("tab", { name: "Summary" }).querySelector("svg.lucide-sparkles")).toBeTruthy();
    });

    test("in the Summary tab it sits between the categories and the Summarize again button", async () => {
      installMockFetch({ aiSkillCategories: ["summarize", "categorize", "events"] });
      await login();
      await userEvent.click(await screen.findByText("Hello there"));
      await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(1));
      expect(screen.queryByRole("button", { name: /found/i })).toBeNull();

      await userEvent.click(await screen.findByRole("tab", { name: "Summary" }));
      await userEvent.click(await screen.findByRole("button", { name: "Summarize with AI" }));
      const found = await screen.findByRole("button", { name: /found 2 dates/i });
      const categories = screen.getByLabelText("Categories");
      const again = screen.getByRole("button", { name: "Summarize again" });
      expect(categories.compareDocumentPosition(found) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(found.compareDocumentPosition(again) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  describe("the reading pane header while a summary is generated", () => {
    async function openHello(opts: Parameters<typeof installMockFetch>[0]) {
      installMockFetch(opts);
      await login();
      await userEvent.click(await screen.findByText("Hello there"));
      await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(1));
    }

    test("the header has no Summarize button; starting one from the Summary tab shows that it is generating, until it is there", async () => {
      await openHello({ aiSkillCategories: ["summarize"], aiSummarizeDelayMs: 300 });
      expect(screen.queryByRole("button", { name: /summarize this message/i })).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();

      await userEvent.click(await screen.findByRole("tab", { name: "Summary" }));
      await userEvent.click(await screen.findByRole("button", { name: "Summarize with AI" }));
      const status = await screen.findByRole("status");
      expect(status.textContent).toContain("Generating the summary");
      expect(status.textContent).toContain("may take a moment");

      expect(await screen.findByText(/Alice says hello/)).toBeTruthy();
      await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    });

    test("the status belongs to the message it was started for", () => {
      const { rerender } = render(<MessageHeader email={{ ...EMAIL, aiSummary: null } as never} summarizing />);
      expect(screen.getByRole("status")).toBeTruthy();
      rerender(<MessageHeader email={{ ...EMAIL, aiSummary: "- done" } as never} summarizing />);
      expect(screen.queryByRole("status")).toBeNull();
    });
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

  describe("disabled accounts", () => {
    async function login() {
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await waitFor(() => expect(screen.getAllByText("me@example.com").length).toBeGreaterThan(0), { timeout: 3000 });
    }

    test("the account settings have a Disabled switch (Safety tab) that makes Read-only permanent", async () => {
      installMockFetch();
      await login();
      await userEvent.click(screen.getByTitle("More actions"));
      await userEvent.click(screen.getByText("Account settings"));
      await userEvent.click(await screen.findByRole("tab", { name: "Safety" }));

      const disabled = screen.getByLabelText("Disabled");
      const readOnly = screen.getByLabelText("Read-only");
      expect(disabled.getAttribute("aria-checked")).toBe("false");
      expect(readOnly.hasAttribute("disabled")).toBe(false);

      await userEvent.click(disabled);
      expect(readOnly.getAttribute("aria-checked")).toBe("true"); // implied
      expect(readOnly.hasAttribute("disabled")).toBe(true); // and not separately changeable
      expect(screen.getByText(/Always on while the account is disabled/)).toBeTruthy();

      await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
      await waitFor(() => expect(capturedAccountPatch?.disabled).toBe(true));
    });

    test("a disabled account is marked in the sidebar, has no Sync button, and can still be expanded and read", async () => {
      installMockFetch({ accountOverrides: { disabled: true } });
      await login();
      expect(screen.getByTitle("Disabled")).toBeTruthy();
      expect(screen.queryByTitle("Sync now")).toBeNull();

      await userEvent.click(screen.getAllByText("me@example.com")[0]!);
      expect(await screen.findByText("Entwürfe")).toBeTruthy(); // its folders are there
    });

    test("its messages open without being marked read, and every button that would change something is off", async () => {
      installMockFetch({ accountOverrides: { disabled: true } });
      await login();
      await openAccountInbox();
      await userEvent.click(await screen.findByText("Hello there")); // an unread message
      await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(1));

      for (const name of [/^reply$/i, /^forward$/i, /mark read/i, /^delete$/i]) {
        expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
      }
      expect(screen.getByRole("combobox", { name: /move/i }).hasAttribute("disabled")).toBe(true);
      expect(screen.getByRole("button", { name: /^new$/i }).hasAttribute("disabled")).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(emailPatches).toEqual([]); // no "mark as read" request
    });

    test("starring a message of a disabled account is refused up front, without a request", async () => {
      installMockFetch({ accountOverrides: { disabled: true } });
      await login();
      await openAccountInbox();
      await screen.findByText("Hello there");
      const row = screen.getByText("Hello there").closest("li")!;
      fireEvent.click(row.querySelector('[role="button"]')!); // the star
      expect((await screen.findAllByText(/is disabled — enable it in its account settings/)).length).toBeGreaterThan(0);
      expect(emailPatches).toEqual([]);
    });

    test("the automatic sync leaves disabled accounts alone", async () => {
      const realSetInterval = globalThis.setInterval;
      const ticks: (() => void)[] = [];
      globalThis.setInterval = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
        if (ms !== undefined && ms >= 60_000) {
          ticks.push(fn);
          return 0 as unknown as ReturnType<typeof setInterval>;
        }
        return realSetInterval(fn, ms, ...rest);
      }) as typeof setInterval;
      try {
        installMockFetch({ settings: { syncIntervalMinutes: 2 }, accountOverrides: { disabled: true } });
        await login();
        await waitFor(() => expect(ticks).toHaveLength(1));
        await act(async () => ticks[0]!());
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(downloadPosts).toEqual([]);
      } finally {
        globalThis.setInterval = realSetInterval;
      }
    });
  });

  describe("folder tree loading", () => {
    async function openTree() {
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await waitFor(() => expect(screen.getAllByText("me@example.com").length).toBeGreaterThan(0), { timeout: 3000 });
      await userEvent.click(screen.getAllByText("me@example.com")[0]!);
    }

    test("the remembered folder list shows at once; the slow live read then adds what changed", async () => {
      const withNew = [...FOLDERS, { path: "Neu", name: "Neu", delimiter: "/", specialUse: null, flags: [], total: 0, unread: 0 }];
      installMockFetch({ liveFolders: withNew });
      await openTree();

      expect(await screen.findByText("Entwürfe")).toBeTruthy(); // from the cache, not waiting for IMAP
      expect(screen.queryByText("Neu")).toBeNull();
      expect(await screen.findByText("Neu")).toBeTruthy(); // the live result arrives afterwards
      expect(liveFolderRequests).toBeGreaterThan(0);
    });

    test("when the live read fails, the tree that is showing stays and no error replaces it", async () => {
      installMockFetch({ liveFolders: "fail" });
      await openTree();

      expect(await screen.findByText("Entwürfe")).toBeTruthy();
      await waitFor(() => expect(liveFolderRequests).toBeGreaterThan(0));
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(screen.getByText("Entwürfe")).toBeTruthy();
      expect(screen.queryByText(/Couldn't read the folders/)).toBeNull();
    });

    test("when the mail server can't be reached, the stored folders are listed with a note explaining why", async () => {
      installMockFetch({ folderWarning: "Couldn't read the folders of me@example.com from imap.example.com: Unexpected close" });
      await openTree();

      expect(await screen.findByText("Entwürfe")).toBeTruthy(); // the stored folders, so the downloaded mail can be read
      const note = await screen.findByText("Server not reachable — showing the stored folders.");
      expect(note.getAttribute("title")).toContain("Unexpected close"); // the reason on hover
    });

    test("a folder named inbox in any case is labelled Inbox in the tree", async () => {
      const lower = [
        { path: "inbox", name: "inbox", delimiter: "/", specialUse: "\\Inbox", flags: [], total: 3, unread: 2 },
        { path: "Entwürfe", name: "Entwürfe", delimiter: "/", specialUse: "\\Drafts", flags: [], total: 0, unread: 0 },
      ];
      installMockFetch({ liveFolders: lower });
      await openTree();
      await waitFor(() => expect(screen.getAllByText("Inbox").length).toBeGreaterThan(1)); // the combined row and this account's
      expect(screen.queryByText("inbox")).toBeNull();
    });

    test("no note when the server answered", async () => {
      installMockFetch();
      await openTree();
      await screen.findByText("Entwürfe");
      await waitFor(() => expect(liveFolderRequests).toBeGreaterThan(0));
      expect(screen.queryByText(/Server not reachable/)).toBeNull();
    });

    test("refreshing counts (after a sync, say) doesn't ask IMAP again", async () => {
      installMockFetch();
      await openTree();
      await screen.findByText("Entwürfe");
      await waitFor(() => expect(liveFolderRequests).toBe(1)); // the one background read on load
      const before = liveFolderRequests;

      await userEvent.click(screen.getByTitle("Sync now"));
      await waitFor(() => expect(folderRequests).toBeGreaterThan(1)); // the post-sync refresh…
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(liveFolderRequests).toBe(before); // …used the cache, not another live read
    });
  });

  describe("syncing all Inboxes from the combined Inbox", () => {
    async function login() {
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await screen.findByText("Unified hello"); // the combined Inbox
    }

    test("the combined Inbox has a sync button that syncs the Inbox (only) of every account", async () => {
      installMockFetch({ extraAccounts: [{ email: "you@example.com" }, { email: "third@example.com" }] });
      await login();

      await userEvent.click(screen.getByTitle("Sync the Inboxes of all accounts"));
      await waitFor(() => expect(downloadAccounts.sort()).toEqual(["me@example.com", "third@example.com", "you@example.com"]));
      expect(downloadPosts).toEqual([{ folder: "INBOX" }, { folder: "INBOX" }, { folder: "INBOX" }]); // just the Inboxes, not every folder
    });

    test("in the row the sync button comes before the unread count, and the whole row still opens the combined Inbox", async () => {
      installMockFetch({ inboxUnread: 3 });
      await login();
      const row = screen.getByTitle("Inbox of all accounts");
      await waitFor(() => expect(row.textContent).toContain("3"));

      const sync = screen.getByTitle("Sync the Inboxes of all accounts");
      const badge = row.querySelector('[data-slot="badge"]')!;
      expect(sync.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // sync icon, then the count

      // Clicking the count opens the Inbox (from the Sent list); clicking the sync icon syncs without changing the view.
      await userEvent.click(screen.getByTitle("Sent of all accounts"));
      await screen.findByText("Unified outgoing");
      await userEvent.click(badge);
      expect(await screen.findByText("Unified hello")).toBeTruthy();

      await userEvent.click(screen.getByTitle("Sent of all accounts"));
      await screen.findByText("Unified outgoing");
      await userEvent.click(sync);
      await waitFor(() => expect(downloadAccounts).toEqual(["me@example.com"]));
      expect(screen.getByText("Unified outgoing")).toBeTruthy(); // still the Sent list
    });

    test("accounts excluded from automatic sync are left out", async () => {
      installMockFetch({ extraAccounts: [{ email: "gmail@example.com", excludeFromAutoSync: true }] });
      await login();

      await userEvent.click(screen.getByTitle("Sync the Inboxes of all accounts"));
      await waitFor(() => expect(downloadAccounts).toEqual(["me@example.com"]));
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(downloadAccounts).toEqual(["me@example.com"]);
    });

    test("disabled accounts are left out", async () => {
      installMockFetch({ extraAccounts: [{ email: "off@example.com", disabled: true }] });
      await login();

      await userEvent.click(screen.getByTitle("Sync the Inboxes of all accounts"));
      await waitFor(() => expect(downloadAccounts).toEqual(["me@example.com"]));
    });

    test("while accounts are syncing the button is a spinner with the count, and can't be pressed again", async () => {
      installMockFetch({ extraAccounts: [{ email: "you@example.com" }], syncStaysRunning: true });
      await login();

      await userEvent.click(screen.getByTitle("Sync the Inboxes of all accounts"));
      const spinner = await screen.findByTitle("Syncing 2 accounts…");
      expect(spinner.querySelector(".animate-spin")).toBeTruthy();
      expect(screen.queryByTitle("Sync the Inboxes of all accounts")).toBeNull();
      expect(downloadAccounts).toHaveLength(2); // no second round
    });

    test("when the syncs finish the app refreshes like after any sync, and the button is back", async () => {
      installMockFetch({ extraAccounts: [{ email: "you@example.com" }] });
      await login();
      const unreadBefore = unreadRequests;

      await userEvent.click(screen.getByTitle("Sync the Inboxes of all accounts"));
      await waitFor(() => expect(unreadRequests).toBeGreaterThan(unreadBefore));
      await waitFor(() => expect(screen.queryByTitle(/^Syncing/)).toBeNull());
      expect(screen.getByTitle("Sync the Inboxes of all accounts")).toBeTruthy();
    });
  });

  describe("passkey unlock of the saved password", () => {
    let authenticator: FakeAuthenticator | null = null;
    afterEach(() => {
      authenticator?.uninstall();
      authenticator = null;
    });
    const vaultKey = "psmail.passkeyVault.secure";

    async function pickSecure() {
      installMockFetch({ extraUsers: [{ id: 2, username: "secure" }] });
      render(<App />);
      await userEvent.click(await screen.findByText("secure"));
      return screen.findByPlaceholderText("Password");
    }
    async function signInAndRemember() {
      await userEvent.type(await pickSecure(), "secret123");
      await userEvent.click(screen.getByLabelText("Remember on this device"));
      await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
      await openAccountInbox();
    }

    test("without passkey support the sign-in form offers nothing extra", async () => {
      await pickSecure();
      expect(screen.queryByLabelText("Remember on this device")).toBeNull();
      expect(screen.queryByRole("button", { name: /unlock with passkey/i })).toBeNull();
    });

    test("signing in with 'Remember' stores the password encrypted, protected by a passkey", async () => {
      authenticator = installFakeAuthenticator();
      await signInAndRemember();

      await waitFor(() => expect(localStorage.getItem(vaultKey)).toBeTruthy());
      expect(localStorage.getItem(vaultKey)).not.toContain("secret123");
      expect(authenticator.prompts).toEqual({ create: 1, get: 1 });
      expect((await screen.findAllByText("Passkey unlock is set up on this device.")).length).toBeGreaterThan(0);
    });

    test("without ticking the box nothing is stored and no passkey is created", async () => {
      authenticator = installFakeAuthenticator();
      await userEvent.type(await pickSecure(), "secret123");
      await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
      await openAccountInbox();
      expect(localStorage.getItem(vaultKey)).toBeNull();
      expect(authenticator.prompts).toEqual({ create: 0, get: 0 });
    });

    test("next time the profile offers 'Unlock with passkey', which signs in without typing the password", async () => {
      authenticator = installFakeAuthenticator();
      await signInAndRemember();
      await waitFor(() => expect(localStorage.getItem(vaultKey)).toBeTruthy());

      await userEvent.click(screen.getByTitle("Sign out"));
      await userEvent.click(await screen.findByText("secure"));
      expect(screen.queryByLabelText("Remember on this device")).toBeNull(); // already set up
      loginPosts.length = 0;
      await userEvent.click(await screen.findByRole("button", { name: /unlock with passkey/i }));

      await openAccountInbox();
      expect(loginPosts.at(-1)).toEqual({ username: "secure", password: "secret123" }); // the decrypted password was used
      expect(authenticator.prompts.get).toBe(2); // one to set up, one to unlock
    });

    test("cancelling the passkey prompt shows why and leaves the password form usable", async () => {
      authenticator = installFakeAuthenticator();
      await signInAndRemember();
      await waitFor(() => expect(localStorage.getItem(vaultKey)).toBeTruthy());
      await userEvent.click(screen.getByTitle("Sign out"));
      await userEvent.click(await screen.findByText("secure"));

      authenticator.cancelNext();
      await userEvent.click(await screen.findByRole("button", { name: /unlock with passkey/i }));
      expect(await screen.findByText(/passkey prompt was cancelled/i)).toBeTruthy();
      expect(localStorage.getItem(vaultKey)).toBeTruthy(); // kept

      await userEvent.type(screen.getByPlaceholderText("Password"), "secret123");
      await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
      await openAccountInbox();
    });

    test("a saved password that no longer works (changed elsewhere) is dropped with an explanation", async () => {
      authenticator = installFakeAuthenticator();
      installMockFetch({ extraUsers: [{ id: 2, username: "secure" }] });
      // A vault for the OLD password, as it would be after the password was changed from another browser.
      const { savePassword } = await import("../../src/lib/passkeyVault");
      await savePassword("secure", "old-password");
      render(<App />);
      await userEvent.click(await screen.findByText("secure"));

      await userEvent.click(await screen.findByRole("button", { name: /unlock with passkey/i }));
      expect(await screen.findByText(/saved password no longer works/i)).toBeTruthy();
      expect(localStorage.getItem(vaultKey)).toBeNull();
      expect(screen.queryByRole("button", { name: /unlock with passkey/i })).toBeNull();
    });

    test("an authenticator without PRF: the sign-in works, the user is told nothing was stored", async () => {
      authenticator = installFakeAuthenticator({ prf: false });
      await signInAndRemember();
      expect((await screen.findAllByText(/doesn't support the PRF extension/)).length).toBeGreaterThan(0);
      expect(localStorage.getItem(vaultKey)).toBeNull();
    });

    test("Settings → Credentials shows the passkey unlock and can remove it; a password change removes it", async () => {
      authenticator = installFakeAuthenticator();
      await signInAndRemember();
      await waitFor(() => expect(localStorage.getItem(vaultKey)).toBeTruthy());

      await userEvent.click(screen.getByTitle("Settings"));
      await userEvent.click(await screen.findByRole("tab", { name: "Credentials" }));
      expect(await screen.findByText(/Passkey unlock is set up on this device: the sign-in screen/)).toBeTruthy();

      await userEvent.click(screen.getByRole("button", { name: "Remove" }));
      expect(localStorage.getItem(vaultKey)).toBeNull();
      expect(screen.queryByText(/Passkey unlock is set up on this device: the sign-in screen/)).toBeNull();
    });

    async function openCredentials() {
      await userEvent.click(screen.getByTitle("Settings"));
      await userEvent.click(await screen.findByRole("tab", { name: "Credentials" }));
    }

    test("Settings lists the passkeys and adds another one (unlocking with an existing one first); either then signs in", async () => {
      authenticator = installFakeAuthenticator();
      await signInAndRemember();
      await waitFor(() => expect(localStorage.getItem(vaultKey)).toBeTruthy());
      await openCredentials();
      expect(await screen.findByText(/^Passkey 1/)).toBeTruthy();
      expect(screen.queryByText(/^Passkey 2/)).toBeNull();

      authenticator.useDevice(1); // the backup security key registers now
      await userEvent.click(screen.getByRole("button", { name: /add another passkey/i }));
      expect(await screen.findByText(/^Passkey 2/)).toBeTruthy();
      expect(JSON.parse(localStorage.getItem(vaultKey)!).entries).toHaveLength(2);
      expect(localStorage.getItem(vaultKey)).not.toContain("secret123");

      // Sign out; only the second passkey is at hand (the first authenticator isn't): "Unlock with passkey" still works.
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      await userEvent.click(screen.getByTitle("Sign out"));
      authenticator.unplug(0);
      await userEvent.click(await screen.findByText("secure"));
      loginPosts.length = 0;
      await userEvent.click(await screen.findByRole("button", { name: /unlock with passkey/i }));
      await openAccountInbox();
      expect(loginPosts.at(-1)).toEqual({ username: "secure", password: "secret123" });
    });

    test("adding the same authenticator again is refused with an explanation, and nothing changes", async () => {
      authenticator = installFakeAuthenticator();
      await signInAndRemember();
      await waitFor(() => expect(localStorage.getItem(vaultKey)).toBeTruthy());
      const before = localStorage.getItem(vaultKey);
      await openCredentials();

      await userEvent.click(await screen.findByRole("button", { name: /add another passkey/i })); // same device: it refuses
      expect(await screen.findByText(/already set up for this profile/)).toBeTruthy();
      expect(localStorage.getItem(vaultKey)).toBe(before);
    });

    test("each passkey can be removed on its own; the last one takes the unlock feature away", async () => {
      authenticator = installFakeAuthenticator();
      await signInAndRemember();
      await waitFor(() => expect(localStorage.getItem(vaultKey)).toBeTruthy());
      await openCredentials();
      authenticator.useDevice(1);
      await userEvent.click(await screen.findByRole("button", { name: /add another passkey/i }));
      await screen.findByText(/^Passkey 2/);

      await userEvent.click(screen.getByTitle("Remove passkey 1"));
      expect(screen.queryByText(/^Passkey 2/)).toBeNull(); // one left (renumbered)
      expect(JSON.parse(localStorage.getItem(vaultKey)!).entries).toHaveLength(1);
      expect(screen.getByText(/Passkey unlock is set up on this device: the sign-in screen/)).toBeTruthy();

      await userEvent.click(screen.getByTitle("Remove passkey 1"));
      expect(localStorage.getItem(vaultKey)).toBeNull();
      expect(screen.queryByText(/Passkey unlock is set up on this device: the sign-in screen/)).toBeNull();
    });

    test("changing the password removes the (now stale) passkey unlock and says so", async () => {
      authenticator = installFakeAuthenticator();
      await signInAndRemember();
      await waitFor(() => expect(localStorage.getItem(vaultKey)).toBeTruthy());

      await userEvent.click(screen.getByTitle("Settings"));
      await userEvent.click(await screen.findByRole("tab", { name: "Credentials" }));
      await userEvent.type(screen.getByLabelText("Current password"), "secret123");
      await userEvent.type(screen.getByLabelText("New password"), "new-pw");
      await userEvent.type(screen.getByLabelText("Confirm new password"), "new-pw");
      await userEvent.click(screen.getByRole("button", { name: "Change password" }));

      expect((await screen.findAllByText(/Passkey unlock was removed from this device/)).length).toBeGreaterThan(0);
      expect(localStorage.getItem(vaultKey)).toBeNull();
    });
  });

  describe("categories in the message lists", () => {
    const labelled = { ...EMAIL, taxonomyList: ["finance", "invoice", "tax", "2024", "paid"] };
    const listProps = { loading: false, hasMore: false, loadingMore: false, onLoadMore: () => {}, selectedId: null, selectedIds: new Set<number>(), folder: "INBOX", onSelect: () => {}, onToggleFlag: () => {}, onEditDraft: () => {} };

    test("a message with categories shows the first four as chips, the rest as +N (all in the tooltip)", () => {
      render(<UiSettingsContext.Provider value={{ ...PLAIN_UI, showCategories: true }}><MessageList {...listProps} emails={[labelled as never]} /></UiSettingsContext.Provider>);
      const chips = screen.getByRole("list", { name: "Categories" });
      expect(Array.from(chips.querySelectorAll("li")).map(li => li.textContent)).toEqual(["finance", "invoice", "tax", "2024", "+1"]);
      expect(chips.getAttribute("title")).toBe("finance, invoice, tax, 2024, paid");
    });

    test("a message without categories shows no chips", () => {
      render(<MessageList {...listProps} emails={[EMAIL as never, { ...EMAIL, id: 11, taxonomyList: [] } as never]} />);
      expect(screen.queryByRole("list", { name: "Categories" })).toBeNull();
    });

    test("the combined lists (and search results) show them too", async () => {
      const row = { id: 10, accountEmail: "me@example.com", folder: "INBOX", uid: 1, isRead: false, isFlagged: false, subject: "Tagged one", from: [{ name: "Alice", address: "alice@example.com" }], date: NOW, taxonomyList: ["finance", "invoice"] };
      installMockFetch({ unifiedInboxRows: [row, { ...row, id: 11, subject: "Plain one", taxonomyList: undefined }] });
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      const tagged = (await screen.findByText("Tagged one")).closest("li")!;
      expect(within(tagged).getByRole("list", { name: "Categories" }).textContent).toBe("financeinvoice");
      expect(within(screen.getByText("Plain one").closest("li")!).queryByRole("list", { name: "Categories" })).toBeNull();
    });
  });

  describe("message toolbar", () => {
    const noop = () => {};
    const folders = ["Archive", "Work/Invoices", "Work/Projects", "Private"].map(path => ({ path, name: path.split("/").pop()!, delimiter: "/", specialUse: null, flags: [], total: 0, unread: 0 }));
    function renderToolbar(email: unknown = EMAIL, extra: { onMove?: (folder: string) => void } = {}) {
      return render(
        <MessageToolbar
          email={email as never}
          folders={folders}
          onReply={noop}
          onReplyAll={noop}
          onForward={noop}
          onDelete={noop}
          onMove={extra.onMove ?? noop}
          onDownload={noop}
          onToggleRead={noop}
          onEditDraft={noop}
          accountDisabled={false}
        />
      );
    }

    test("all the actions are always visible: no hiding, no arrow", () => {
      renderToolbar();
      for (const name of [/^reply$/i, /forward/i, /mark read|mark unread/i, /download/i, /delete/i]) {
        expect(screen.getByRole("button", { name })).toBeTruthy();
      }
      expect(screen.getByRole("combobox", { name: /move/i })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Message actions" })).toBeNull();
    });

    test("Move is a combobox: typing narrows the folders, Enter moves, and it lists no folder that doesn't match", async () => {
      const moved: string[] = [];
      renderToolbar(EMAIL, { onMove: f => moved.push(f) });
      await userEvent.click(screen.getByRole("combobox", { name: /move/i }));
      expect((await screen.findAllByRole("option")).map(o => o.textContent)).toEqual(["Archive", "Work/Invoices", "Work/Projects", "Private"]);

      await userEvent.type(screen.getByPlaceholderText("Find a folder…"), "proj");
      await waitFor(() => expect(screen.getAllByRole("option").map(o => o.textContent)).toEqual(["Work/Projects"]));
      await userEvent.keyboard("{Enter}");
      expect(moved).toEqual(["Work/Projects"]);
      await waitFor(() => expect(screen.queryByPlaceholderText("Find a folder…")).toBeNull()); // closed after choosing

      await userEvent.click(screen.getByRole("combobox", { name: /move/i }));
      await userEvent.type(await screen.findByPlaceholderText("Find a folder…"), "zzz");
      expect(await screen.findByText("No folder found.")).toBeTruthy();
    });
  });

  describe("AI is optional", () => {
    test("the reading-pane toolbar renders without any AI props at all", () => {
      const noop = () => {};
      render(
        <MessageToolbar
          email={EMAIL as never}
          folders={[]}
          onReply={noop}
          onReplyAll={noop}
          onForward={noop}
          onDelete={noop}
          onMove={noop}
          onDownload={noop}
          onToggleRead={noop}
          onEditDraft={noop}
          accountDisabled={false}
        />
      );
      expect(screen.getByRole("button", { name: /^reply$/i })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /translate/i })).toBeNull();
    });

    for (const [label, response] of [["null", null], ["an object", { error: "boom" }], ["a string", "<html>"]] as const) {
      test(`an odd skills answer (${label}) just means no skills: messages open, no AI buttons`, async () => {
        installMockFetch({ aiSkillsResponse: response });
        render(<App />);
        await userEvent.click(await screen.findByText("default"));
        await openAccountInbox();
        await userEvent.click(await screen.findByText("Hello there"));
        await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(1));
        expect(screen.getByRole("button", { name: /^reply$/i })).toBeTruthy();
        expect(screen.queryByRole("tab", { name: "Summary" })).toBeNull();
        expect(screen.queryByRole("button", { name: /translate/i })).toBeNull();
      });
    }
  });

  describe("the UI options (Settings → UI): opt-in, so the plain client is the default", () => {
    const PLAIN = { showConversations: false, showCategories: false, showUnreadBadges: false, textViewOnly: false };
    const conversation = { messages: [{ id: 9, folder: "INBOX", subject: "Vorher", from: { address: "a@example.com" }, snippet: "x", date: "2026-01-01T00:00:00Z", own: false, current: false }, { id: 10, folder: "INBOX", subject: "Hello there", from: { address: "a@example.com" }, snippet: "y", date: "2026-01-02T00:00:00Z", own: false, current: true }], repliedBy: null };

    async function openHello(opts: Parameters<typeof installMockFetch>[0]) {
      installMockFetch(opts);
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await openAccountInbox();
      await userEvent.click(await screen.findByText("Hello there"));
      await waitFor(() => expect(screen.getAllByText("Hello there").length).toBeGreaterThan(1));
    }

    test("without them: no unread badges, no conversation bar, no category filter", async () => {
      await openHello({ settings: PLAIN, inboxUnread: 3, conversation: conversation as never });
      expect(screen.getByTitle("Inbox of all accounts").textContent).not.toMatch(/\d/);
      expect(screen.queryByText(/Conversation · /)).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      expect(await screen.findByText("Filter by date…")).toBeTruthy();
      expect(screen.queryByText("Filter by category…")).toBeNull();
    });

    test("with them on, the same things show", async () => {
      await openHello({ inboxUnread: 3, conversation: conversation as never });
      await waitFor(() => expect(screen.getByTitle("Inbox of all accounts").textContent).toMatch(/\d/)); // opening the message already took one off
      expect(await screen.findByText(/Conversation · 2 messages/)).toBeTruthy();
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      expect(await screen.findByText("Filter by category…")).toBeTruthy();
    });

    test("text view only: the reading pane offers no other view", async () => {
      await openHello({ settings: { textViewOnly: true } });
      expect(screen.queryByRole("tab", { name: "Safe HTML" })).toBeNull();
      expect(screen.queryByRole("tab", { name: "HTML" })).toBeNull();
      expect(screen.queryByRole("tab", { name: "MD" })).toBeNull();
      expect(screen.queryByRole("tab", { name: "Plain" })).toBeNull();
      expect(await screen.findByLabelText("Message body")).toBeTruthy();
    });

    test("by default the reading pane still offers its views", async () => {
      await openHello({});
      expect(screen.getByRole("tab", { name: "Safe HTML" })).toBeTruthy();
      expect(screen.getByRole("tab", { name: "Text" })).toBeTruthy();
    });

    test("the UI tab lists all six options, off by default, and saves them", async () => {
      installMockFetch({ settings: PLAIN });
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await openAccountInbox();
      await userEvent.click(screen.getByTitle("Settings"));
      await userEvent.click(await screen.findByRole("tab", { name: "UI" }));
      for (const name of [
        "Show conversations",
        "Show categories",
        "Show unread badges",
        "Always show the text view",
        "Display dates instead of time expressions",
        "Display letter avatar",
      ])
        expect(screen.getByLabelText(name).getAttribute("aria-checked")).toBe("false");

      await userEvent.click(screen.getByLabelText("Show unread badges"));
      await userEvent.click(screen.getByLabelText("Always show the text view"));
      await userEvent.click(screen.getByLabelText("Display dates instead of time expressions"));
      await userEvent.click(screen.getByLabelText("Display letter avatar"));
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() =>
        expect(capturedSettingsPatches).toEqual([{ ...DEFAULT_PATCH, ...PLAIN, showUnreadBadges: true, textViewOnly: true, showAbsoluteDates: true, showLetterAvatar: true }])
      );
    });

    test("Display letter avatar: off by default, no avatar in the reading pane", async () => {
      await openHello({});
      expect(screen.queryByText("AL")).toBeNull(); // EMAIL's sender is "Alice" — the fallback would be her initials, "AL"
    });

    test("Display letter avatar: turned on, shows the sender's initials in the reading pane", async () => {
      await openHello({ settings: { showLetterAvatar: true } });
      expect(screen.getByText("AL")).toBeTruthy();
    });

    test("Display dates instead of time expressions: today's message shows a date, not a time, in the list", async () => {
      const now = new Date();
      installMockFetch({ emailDate: now.toISOString() });
      render(<App />);
      await userEvent.click(await screen.findByText("default"));
      await openAccountInbox();
      // Off by default: today's message shows a time (HH:MM), not a date, in its list row.
      const row = () => screen.getByText("Hello there").closest("li")!;
      expect(within(row()).getByText(/^\d{1,2}:\d{2}/)).toBeTruthy();
      cleanup();

      installMockFetch({ settings: { showAbsoluteDates: true }, emailDate: now.toISOString() });
      render(<App />); // still signed in from above
      await openAccountInbox();
      expect(within(row()).queryByText(/^\d{1,2}:\d{2}/)).toBeNull();
      const expectedDate = now.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      expect(within(row()).getByText(expectedDate)).toBeTruthy();
    });
  });
});
