import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../../src/App";

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
const ACCOUNT = {
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
  createdAt: NOW,
  updatedAt: NOW,
};
const FOLDERS = [{ path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", flags: [], total: 1, unread: 1 }];
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
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const originalFetch = global.fetch;

function installMockFetch() {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const path = url.split("?")[0]!;

    if (method === "GET" && path === "/api/users") return jsonResponse([USER]);
    if (method === "POST" && path === "/api/auth/login") {
      return jsonResponse({ token: "test-token", expiresAt: NOW, user: { id: 1, username: "default" } });
    }
    if (method === "GET" && path === "/api/accounts") return jsonResponse([ACCOUNT]);
    if (method === "GET" && path === "/api/accounts/me%40example.com/folders") return jsonResponse(FOLDERS);
    if (method === "GET" && path === "/api/accounts/me%40example.com/emails") return jsonResponse([EMAIL, SECOND_EMAIL]);
    if (method === "GET" && path === "/api/accounts/me%40example.com/emails/10") return jsonResponse(EMAIL);
    if (method === "GET" && path === "/api/accounts/me%40example.com/emails/11") return jsonResponse(SECOND_EMAIL);
    if (method === "PATCH" && path === "/api/accounts/me%40example.com/emails/10") return jsonResponse({ ...EMAIL, isRead: true });
    if (method === "PATCH" && path === "/api/accounts/me%40example.com/emails/11") return jsonResponse({ ...SECOND_EMAIL, isRead: true });
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

    // Login screen
    await waitFor(() => expect(screen.getByText("P.S.Mail")).toBeTruthy());
    const userButton = await screen.findByText("default");
    await userEvent.click(userButton);

    const signInButton = await screen.findByRole("button", { name: /sign in/i });
    await userEvent.click(signInButton);

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

  test("remembers the last body view across messages, downgrading Full HTML to Safe HTML", async () => {
    render(<App />);

    function isTabSelected(name: string): boolean {
      return screen.getByRole("tab", { name }).getAttribute("aria-selected") === "true";
    }

    await userEvent.click(await screen.findByText("default"));
    await userEvent.click(await screen.findByRole("button", { name: /sign in/i }));
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

  test("searching switches the message list to results and opening one reads it", async () => {
    render(<App />);

    await userEvent.click(await screen.findByText("default"));
    await userEvent.click(await screen.findByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    const searchBox = screen.getByPlaceholderText(/search all mail/i);
    await userEvent.type(searchBox, "second");

    // Debounced, so this only resolves once the (mocked) search actually ran.
    await waitFor(() => expect(screen.getByText(/Search: "second"/)).toBeTruthy(), { timeout: 2000 });
    await waitFor(() => expect(screen.getAllByText("Second message").length).toBeGreaterThan(0), { timeout: 2000 });

    // Opening the result reads it, same as opening any other message.
    await userEvent.click(screen.getAllByText("Second message")[0]!);
    await waitFor(() => expect(screen.getAllByText(/Bob/).length).toBeGreaterThan(0));

    // Clearing the search returns to the normal folder view without losing the reading pane.
    await userEvent.click(screen.getByTitle("Clear search"));
    await waitFor(() => expect(screen.queryByText(/Search:/)).toBeNull());
    expect(screen.getAllByText("Second message").length).toBeGreaterThan(0);
  });
});
