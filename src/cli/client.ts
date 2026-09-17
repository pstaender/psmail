/** Thin fetch-based client the CLI uses to talk to the running API server, exactly like the future webclient will. */

export class CliApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

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

  createAccount(input: Record<string, unknown>) {
    return this.request<{ id: number; email: string }>("POST", "/api/accounts", input);
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
