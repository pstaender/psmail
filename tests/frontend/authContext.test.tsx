import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth } from "../../src/contexts/AuthContext";
import { api } from "../../src/lib/api";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Exposes just enough of useAuth() to drive and observe it without the rest of the app. */
function Probe() {
  const { token, sessionExpiredMessage, login } = useAuth();
  return (
    <div>
      <span data-testid="token">{token ?? "none"}</span>
      <span data-testid="message">{sessionExpiredMessage ?? ""}</span>
      <button onClick={() => login("alice", "pw").catch(() => {})}>login</button>
    </div>
  );
}

const originalFetch = global.fetch;

describe("session expiry", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    global.fetch = originalFetch;
    cleanup();
    localStorage.clear();
  });

  test("a 401 on an authenticated request signs the client out and explains why", async () => {
    let expired = false;
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = (typeof input === "string" ? input : input.toString()).split("?")[0]!;
      const method = init?.method ?? "GET";
      if (path === "/api/auth/login" && method === "POST") {
        return jsonResponse({ token: "tok-1", expiresAt: "2099-01-01T00:00:00.000Z", user: { id: 1, username: "alice" } });
      }
      if (path === "/api/accounts" && method === "GET") {
        return expired ? jsonResponse({ error: "Session expired or invalid" }, 401) : jsonResponse([]);
      }
      return jsonResponse({ error: `not mocked: ${path}` }, 500);
    }) as typeof fetch;

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    await act(async () => screen.getByText("login").click());
    await waitFor(() => expect(screen.getByTestId("token").textContent).toBe("tok-1"));
    expect(screen.getByTestId("message").textContent).toBe(""); // nothing to explain right after a real login

    // Simulates the session going invalid while the app is already open (inactivity timeout, or a
    // server restart) -- the next request that notices is just an ordinary authenticated GET.
    expired = true;
    await act(async () => {
      await api.listAccounts("tok-1").catch(() => {});
    });

    expect(screen.getByTestId("token").textContent).toBe("none");
    expect(screen.getByTestId("message").textContent).toBe("Your session ended — please sign in again.");
    expect(localStorage.getItem("psmail.session")).toBeNull();
  });

  test("a 401 from login itself (wrong password) doesn't trigger the session-expired path", async () => {
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = (typeof input === "string" ? input : input.toString()).split("?")[0]!;
      if (path === "/api/auth/login" && (init?.method ?? "GET") === "POST") {
        return jsonResponse({ error: "Invalid credentials" }, 401);
      }
      return jsonResponse({ error: `not mocked: ${path}` }, 500);
    }) as typeof fetch;

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    await act(async () => {
      screen.getByText("login").click();
    });

    expect(screen.getByTestId("token").textContent).toBe("none");
    expect(screen.getByTestId("message").textContent).toBe(""); // a bad password isn't "your session ended"
  });
});
