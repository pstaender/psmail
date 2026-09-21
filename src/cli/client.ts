/** Thin fetch-based client the CLI uses to talk to the running API server, exactly like the future webclient will. */

export class CliApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type AccountResult = { account: string; examined: number; important: number; notImportant: number; skipped?: string };

/** What the server says while it classifies (see classifyImboxStream). */
export type ClassifyEvent =
  | { type: "start"; accounts: string[]; force: boolean }
  | { type: "account"; account: string; total: number; folders: string[] }
  | { type: "progress"; account: string; done: number; total: number; important: number }
  | { type: "message"; account: string; id: number; subject: string | null; from: string; important: boolean; score: number; ruledOut?: string; reasons: string[] }
  | ({ type: "account-done" } & AccountResult)
  | { type: "done"; results: AccountResult[]; seconds: number }
  | { type: "error"; message: string };

export class ApiClient {
  private baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl = process.env.PSMAIL_API_URL ?? "http://localhost:3001") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  setToken(token: string) {
    this.token = token;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const payload = await res.json().catch(() => ({ error: res.statusText }));
      throw new CliApiError(res.status, payload.error ?? res.statusText);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  login(username: string, password: string) {
    return this.request<{ token: string; expiresAt: string; user: { id: number; username: string } }>(
      "POST",
      "/api/auth/login",
      { username, password }
    );
  }

  createUser(username: string, password: string) {
    return this.request<{ id: number; username: string }>("POST", "/api/users", { username, password });
  }

  listUsers() {
    return this.request<{ id: number; username: string }[]>("GET", "/api/users");
  }

  listAccounts() {
    return this.request<{ id: number; email: string }[]>("GET", "/api/accounts");
  }

  createAccount(input: Record<string, unknown>) {
    return this.request<{ id: number; email: string }>("POST", "/api/accounts", input);
  }

  deleteAccount(accountEmail: string) {
    return this.request<void>("DELETE", `/api/accounts/${encodeURIComponent(accountEmail)}`);
  }

  /** Classifies stored mail for the imbox: the given accounts (addresses), or every account; `force` redoes messages that have a verdict. */
  classifyImbox(accounts: string[] | undefined, force: boolean) {
    return this.request<{ results: { account: string; examined: number; important: number; notImportant: number; skipped?: string }[] }>(
      "POST",
      "/api/imbox/classify",
      { accounts, force }
    );
  }

  /**
   * Like classifyImbox, but the server reports what it is doing while it works — events, one per line: `start`, `account`, `progress`,
   * `message` (with `verbose`), `account-done`, `done`, `error`. `onEvent` gets each as it arrives; resolves with the final results.
   */
  async classifyImboxStream(
    options: { accounts?: string[]; force: boolean; verbose: boolean },
    onEvent: (event: ClassifyEvent) => void
  ): Promise<ClassifyEvent & { type: "done" }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(`${this.baseUrl}/api/imbox/classify`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...options, stream: true }),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({ error: res.statusText }));
      throw new CliApiError(res.status, payload.error ?? res.statusText);
    }

    // A server that predates the streaming answers with plain JSON: treat that as one `done`.
    if (!(res.headers.get("content-type") ?? "").includes("ndjson")) {
      const { results } = (await res.json()) as { results: ClassifyEvent extends { results: infer R } ? R : never };
      const done = { type: "done" as const, results, seconds: 0 };
      onEvent(done);
      return done;
    }

    let final: (ClassifyEvent & { type: "done" }) | null = null;
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const handle = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as ClassifyEvent;
      if (event.type === "error") throw new Error(`The server stopped: ${event.message}`);
      if (event.type === "done") final = event;
      onEvent(event);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        handle(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    }
    handle(buffer);
    if (!final) throw new Error("The server closed the connection before it was done.");
    return final;
  }

  /** Why a message is (not) important: score and reasons, computed now. */
  explainImbox(accountEmail: string, emailId: number) {
    return this.request<{
      stored: boolean | null;
      manual: boolean;
      important: boolean;
      score: number;
      ruledOut?: string;
      decidedBy?: string;
      reasons: { signal: string; points: number; detail?: string }[];
    }>("GET", `/api/accounts/${encodeURIComponent(accountEmail)}/emails/${emailId}/imbox`);
  }

  triggerDownload(accountEmail: string, folder?: string) {
    return this.request<{ id: number; status: string; progressTotal: number }>(
      "POST",
      `/api/accounts/${encodeURIComponent(accountEmail)}/downloads`,
      { folder }
    );
  }

  getDownloadJob(accountEmail: string, jobId: number) {
    return this.request<{
      id: number;
      status: string;
      progressCurrent: number;
      progressTotal: number;
      error: string | null;
    }>("GET", `/api/accounts/${encodeURIComponent(accountEmail)}/downloads/${jobId}`);
  }
}
