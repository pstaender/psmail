import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../../src/App";
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

const THIRD_EMAIL = {
  ...EMAIL,
  id: 12,
  uid: 3,
  subject: "Third message",
  from: [{ name: "Carol", address: "carol@example.com" }],
  plainText: "Hi from Carol",
  htmlText: "<p>Hi <b>from</b> Carol</p>",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const originalFetch = global.fetch;

function installMockFetch(opts: { failEmailPatch?: number; uidPlusSupported?: boolean } = {}) {
  // A fresh mutable copy per test (installMockFetch runs in beforeEach), so a PATCH in one
  // test can't leak into another, and so GET /api/accounts reflects a prior PATCH within a test.
  let currentAccount = { ...ACCOUNT };

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

    if (method === "GET" && path === "/api/users") return jsonResponse([USER]);
    if (method === "POST" && path === "/api/auth/login") {
      return jsonResponse({ token: "test-token", expiresAt: NOW, user: { id: 1, username: "default" } });
    }
    if (method === "GET" && path === "/api/accounts") return jsonResponse([currentAccount]);
    if (method === "PATCH" && path === "/api/accounts/me%40example.com") {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      currentAccount = { ...currentAccount, ...body };
      return jsonResponse(currentAccount);
    }
    if (method === "POST" && path === "/api/accounts/me%40example.com/imap-capabilities") {
      currentAccount = { ...currentAccount, supportsUidPlus: opts.uidPlusSupported ?? true };
      return jsonResponse(currentAccount);
    }
    if (method === "GET" && path === "/api/accounts/me%40example.com/folders") return jsonResponse(FOLDERS);
    if (method === "GET" && path === "/api/accounts/me%40example.com/emails") {
      return jsonResponse([EMAIL, SECOND_EMAIL, THIRD_EMAIL]);
    }
    if (method === "GET" && path === "/api/accounts/me%40example.com/emails/10") return jsonResponse(EMAIL);
    if (method === "GET" && path === "/api/accounts/me%40example.com/emails/11") return jsonResponse(SECOND_EMAIL);
    if (method === "GET" && path === "/api/accounts/me%40example.com/emails/12") return jsonResponse(THIRD_EMAIL);
    if (method === "PATCH" && path === "/api/accounts/me%40example.com/emails/10") return jsonResponse({ ...EMAIL, isRead: true });
    if (method === "PATCH" && path === "/api/accounts/me%40example.com/emails/11") return jsonResponse({ ...SECOND_EMAIL, isRead: true });
    if (method === "PATCH" && path === "/api/accounts/me%40example.com/emails/12") return jsonResponse({ ...THIRD_EMAIL, isRead: true });
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

    // MD tab sits between Text and Plain text, and shows the HTML converted to Markdown.
    const tabs = screen.getAllByRole("tab").map(t => t.textContent);
    expect(tabs.indexOf("Text")).toBeLessThan(tabs.indexOf("MD"));
    expect(tabs.indexOf("MD")).toBeLessThan(tabs.indexOf("Plain text"));
    await userEvent.click(screen.getByRole("tab", { name: "MD" }));
    await waitFor(() => expect(screen.getByText(/\*\*from\*\*/)).toBeTruthy());

    // Reply opens the compose dialog with the MarkdownEditor pre-filled with the quoted original.
    await userEvent.click(screen.getByText("Reply"));
    expect(await screen.findByText("New message")).toBeTruthy();
    const replyBody = document.querySelector(".psmail-markdown-editor .TinyMDE");
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

    await userEvent.click(await screen.findByText("default"));
    await userEvent.click(await screen.findByRole("button", { name: /sign in/i }));
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

  test("bulk-deleting a single Ctrl/Cmd-selected message skips the confirmation dialog", async () => {
    render(<App />);

    await userEvent.click(await screen.findByText("default"));
    await userEvent.click(await screen.findByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    fireEvent.click(await screen.findByText("Third message"), { ctrlKey: true });
    await waitFor(() => expect(screen.getByText("1 selected")).toBeTruthy());

    await userEvent.click(screen.getByTitle("Delete"));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(screen.queryByText("Third message")).toBeNull());
  });

  test("a failed IMAP push rolls back the optimistic flag toggle and shows an error", async () => {
    // Overrides the default beforeEach mock so this one email's PATCH simulates a failed
    // IMAP write (e.g. the account isn't read-only but the mail server rejected/dropped it).
    installMockFetch({ failEmailPatch: SECOND_EMAIL.id });
    render(<App />);

    await userEvent.click(await screen.findByText("default"));
    await userEvent.click(await screen.findByRole("button", { name: /sign in/i }));
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

    await userEvent.click(await screen.findByText("default"));
    await userEvent.click(await screen.findByRole("button", { name: /sign in/i }));
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

    await userEvent.click(await screen.findByText("default"));
    await userEvent.click(await screen.findByRole("button", { name: /sign in/i }));
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

    await userEvent.click(await screen.findByText("default"));
    await userEvent.click(await screen.findByRole("button", { name: /sign in/i }));
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

    await userEvent.click(await screen.findByText("default"));
    await userEvent.click(await screen.findByRole("button", { name: /sign in/i }));
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
    const hostField = screen.getByLabelText("Host", { selector: "#edit-imap-host" }) as HTMLInputElement;
    expect(hostField.value).toBe("imap.example.com");
    // Password fields are never prefilled (the API never returns them).
    expect((screen.getByLabelText("Password", { selector: "#edit-imap-pass" }) as HTMLInputElement).value).toBe("");

    await userEvent.click(screen.getByLabelText("Read-only"));
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(screen.queryByText("Account settings", { selector: "[data-slot=dialog-title]" })).toBeNull());
    await waitFor(() => expect(screen.getByTitle("Read-only")).toBeTruthy());
  });

  test("checking IMAP capabilities updates the soft-delete availability hint", async () => {
    installMockFetch({ uidPlusSupported: true });
    render(<App />);

    await userEvent.click(await screen.findByText("default"));
    await userEvent.click(await screen.findByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(screen.getAllByText("INBOX").length).toBeGreaterThan(0), { timeout: 3000 });

    await userEvent.click(screen.getByTitle("More actions"));
    await userEvent.click(screen.getByText("Account settings"));
    expect(await screen.findByText("Account settings", { selector: "[data-slot=dialog-title]" })).toBeTruthy();

    // Never checked yet (the fixture starts with supportsUidPlus: null).
    expect(screen.getByText(/Server capability not checked yet/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /check server capabilities/i }));
    await waitFor(() => expect(screen.getByText(/This server supports UIDPLUS/)).toBeTruthy());
  });
});
