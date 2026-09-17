import type { Account, DownloadJob, EmailRecord, User } from "../server/types";
import type { CreateAccountInput, UpdateAccountInput } from "../server/models/accounts";
import type { EmailInput } from "../server/models/emails";
import type { ImapFolder } from "../server/services/imap";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface FolderInfo extends ImapFolder {
  total: number;
  unread: number;
}

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: { id: number; username: string };
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

async function request<T>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; formData?: FormData } = {}
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  let payload: BodyInit | undefined;
  if (opts.formData) {
    payload = opts.formData;
  } else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(opts.body);
  }

  const res = await fetch(path, { method, headers, body: payload });

  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, data.error ?? res.statusText);
  }
  if (res.status === 204) return undefined as T;

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return (await res.json()) as T;
  return undefined as T;
}

export const api = {
  listUsers: () => request<User[]>("GET", "/api/users"),
  createUser: (username: string, password: string) =>
    request<User>("POST", "/api/users", { body: { username, password } }),
  login: (username: string, password: string) =>
    request<LoginResult>("POST", "/api/auth/login", { body: { username, password } }),
  logout: (token: string) => request<{ ok: true }>("POST", "/api/auth/logout", { token }),

  listAccounts: (token: string) => request<Account[]>("GET", "/api/accounts", { token }),
  createAccount: (token: string, input: CreateAccountInput) =>
    request<Account>("POST", "/api/accounts", { token, body: input }),
  updateAccount: (token: string, email: string, input: UpdateAccountInput) =>
    request<Account>("PATCH", `/api/accounts/${enc(email)}`, { token, body: input }),
  deleteAccount: (token: string, email: string) =>
    request<void>("DELETE", `/api/accounts/${enc(email)}`, { token }),

  listFolders: (token: string, accountEmail: string) =>
    request<FolderInfo[]>("GET", `/api/accounts/${enc(accountEmail)}/folders`, { token }),

  listEmails: (token: string, accountEmail: string, folder: string, opts: { limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams({ folder });
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.offset) params.set("offset", String(opts.offset));
    return request<EmailRecord[]>("GET", `/api/accounts/${enc(accountEmail)}/emails?${params}`, { token });
  },
  getEmail: (token: string, accountEmail: string, emailId: number) =>
    request<EmailRecord>("GET", `/api/accounts/${enc(accountEmail)}/emails/${emailId}`, { token }),
  createDraft: (token: string, accountEmail: string, input: EmailInput) =>
    request<EmailRecord>("POST", `/api/accounts/${enc(accountEmail)}/emails`, { token, body: input }),
  updateEmail: (token: string, accountEmail: string, emailId: number, input: EmailInput) =>
    request<EmailRecord>("PATCH", `/api/accounts/${enc(accountEmail)}/emails/${emailId}`, { token, body: input }),
  deleteEmail: (token: string, accountEmail: string, emailId: number) =>
    request<void>("DELETE", `/api/accounts/${enc(accountEmail)}/emails/${emailId}`, { token }),
  moveEmail: (token: string, accountEmail: string, emailId: number, folder: string) =>
    request<EmailRecord>("PATCH", `/api/accounts/${enc(accountEmail)}/emails/${emailId}/move/${enc(folder)}`, { token }),
  sendEmail: (token: string, accountEmail: string, emailId: number) =>
    request<EmailRecord>("POST", `/api/accounts/${enc(accountEmail)}/emails/${emailId}/send`, { token }),

  uploadAttachment: (token: string, accountEmail: string, emailId: number, file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    return request<{ id: number; filename: string }>(
      "POST",
      `/api/accounts/${enc(accountEmail)}/emails/${emailId}/attachments`,
      { token, formData }
    );
  },
  deleteAttachment: (token: string, accountEmail: string, emailId: number, attachmentId: number) =>
    request<void>(
      "DELETE",
      `/api/accounts/${enc(accountEmail)}/emails/${emailId}/attachments/${attachmentId}`,
      { token }
    ),
  attachmentUrl: (accountEmail: string, emailId: number, attachmentId: number) =>
    `/api/accounts/${enc(accountEmail)}/emails/${emailId}/attachments/${attachmentId}`,

  /** Downloads happen via fetch (not a plain <a href>) so the Authorization header can be attached. */
  async downloadAttachment(token: string, accountEmail: string, emailId: number, attachmentId: number, filename: string) {
    const res = await fetch(api.attachmentUrl(accountEmail, emailId, attachmentId), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new ApiError(res.status, "Failed to download attachment");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  },

  listDownloadJobs: (token: string, accountEmail: string) =>
    request<DownloadJob[]>("GET", `/api/accounts/${enc(accountEmail)}/downloads`, { token }),
  triggerDownload: (token: string, accountEmail: string, folder: string) =>
    request<DownloadJob>("POST", `/api/accounts/${enc(accountEmail)}/downloads`, { token, body: { folder } }),
  getDownloadJob: (token: string, accountEmail: string, jobId: number) =>
    request<DownloadJob>("GET", `/api/accounts/${enc(accountEmail)}/downloads/${jobId}`, { token }),
};
