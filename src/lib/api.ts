import type { NewMailResult } from "./notifications";
import type { AiApiInput, AiApiRecord, AiSkillInput, AiSkillRecord } from "../server/models/ai";
import type { AiCategory } from "../ai/categories";
import type { Account, DownloadJob, EmailRecord, User } from "../server/types";
import type { CreateAccountInput, UpdateAccountInput } from "../server/models/accounts";
import type { EmailInput } from "../server/models/emails";
import type { SearchResult } from "../server/models/search";
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

export interface Contact {
  address: string;
  name: string;
  fromCount: number;
  ccCount: number;
  sentCount: number;
  lastUsed: string;
  /** A suggestion from one of the user's other accounts (listed after this account's own). */
  other?: boolean;
}

export type UnifiedKind = "inbox" | "sent" | "imbox";

/** Server-persisted per-user preferences (GET/PATCH /api/settings). */
export interface UserSettings {
  bodyView?: "text" | "md" | "plain" | "safe" | "full";
  /** Minutes between automatic syncs of all accounts while the web client is open; unset = never. */
  syncIntervalMinutes?: number;
  /** Opt-in: the combined Inbox also lists mail from accounts' other incoming folders. */
  combinedInboxIncludesFolders?: boolean;
  /** Opt-in: the imbox (the important part of the combined Inbox) is listed between the combined Inbox and Sent. */
  imboxEnabled?: boolean;
  /** Opt-in: a browser notification when new mail arrives. */
  notifyBrowser?: boolean;
  /** Opt-in: an in-app toast (with preview and details) when new mail arrives. */
  notifyToast?: boolean;
  /** The toast's sound: crystal_clear (the default when unset), cute_bell, marimba or none. */
  notificationSound?: "crystal_clear" | "cute_bell" | "marimba" | "none";
  /** The language the translate skill translates into (unset = English). */
  aiTargetLanguage?: string;
}

export interface BulkResult {
  id: number;
  ok: boolean;
  error?: string;
  softDeleted?: boolean;
}

/** Hands a file to the browser as a download. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** The file name a Content-Disposition header proposes (the UTF-8 `filename*` form wins over the ASCII fallback). */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  if (utf8) {
    try {
      return decodeURIComponent(utf8);
    } catch {
      // fall through to the plain form
    }
  }
  return /filename="([^"]*)"/i.exec(header)?.[1] ?? null;
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

async function request<T>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; formData?: FormData; signal?: AbortSignal; onResponse?: (res: Response) => void } = {}
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

  const res = await fetch(path, { method, headers, body: payload, signal: opts.signal });
  opts.onResponse?.(res);

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
  checkImapCapabilities: (token: string, email: string) =>
    request<Account>("POST", `/api/accounts/${enc(email)}/imap-capabilities`, { token }),

  /**
   * Without `live`: the server's last known folder list (instant; counts are always fresh). With it: re-read from IMAP,
   * which can be slow. `onWarning` gets the reason when the server couldn't be reached and the list is only what is
   * stored locally (null when it could).
   */
  listFolders: (token: string, accountEmail: string, opts: { live?: boolean; onWarning?: (warning: string | null) => void } = {}) =>
    request<FolderInfo[]>("GET", `/api/accounts/${enc(accountEmail)}/folders${opts.live ? "?live=1" : ""}`, {
      token,
      onResponse: res => {
        const warning = res.headers.get("x-folders-warning");
        opts.onWarning?.(warning ? decodeURIComponent(warning) : null);
      },
    }),

  /** Creates a folder on the account's IMAP server (nested in `parent`, or at the top level) and returns the new folder list. */
  createFolder: (token: string, accountEmail: string, name: string, parent?: string | null) =>
    request<{ path: string; folders: FolderInfo[] }>("POST", `/api/accounts/${enc(accountEmail)}/folders`, {
      token,
      body: { name, parent: parent ?? undefined },
    }),

  listEmails: (token: string, accountEmail: string, folder: string, opts: { limit?: number; offset?: number; after?: string; before?: string; categories?: string[] } = {}) => {
    const params = new URLSearchParams({ folder });
    for (const category of opts.categories ?? []) params.append("category", category);
    if (opts.after) params.set("after", opts.after);
    if (opts.before) params.set("before", opts.before);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.offset) params.set("offset", String(opts.offset));
    return request<EmailRecord[]>("GET", `/api/accounts/${enc(accountEmail)}/emails?${params}`, { token });
  },
  /** This account's matching contacts, followed by matches from the user's other accounts (marked `other`). */
  suggestContacts: (token: string, accountEmail: string, query: string, signal?: AbortSignal) =>
    request<Contact[]>("GET", `/api/accounts/${enc(accountEmail)}/contacts?${new URLSearchParams({ q: query, scope: "all" })}`, {
      token,
      signal,
    }),
  getEmail: (token: string, accountEmail: string, emailId: number) =>
    request<EmailRecord>("GET", `/api/accounts/${enc(accountEmail)}/emails/${emailId}`, { token }),
  createDraft: (token: string, accountEmail: string, input: EmailInput) =>
    request<EmailRecord>("POST", `/api/accounts/${enc(accountEmail)}/emails`, { token, body: input }),
  updateEmail: (token: string, accountEmail: string, emailId: number, input: EmailInput) =>
    request<EmailRecord>("PATCH", `/api/accounts/${enc(accountEmail)}/emails/${emailId}`, { token, body: input }),
  deleteEmail: (token: string, accountEmail: string, emailId: number) =>
    request<{ softDeleted: boolean }>("DELETE", `/api/accounts/${enc(accountEmail)}/emails/${emailId}`, { token }),
  moveEmail: (token: string, accountEmail: string, emailId: number, folder: string) =>
    request<EmailRecord>("PATCH", `/api/accounts/${enc(accountEmail)}/emails/${emailId}/move/${enc(folder)}`, { token }),
  sendEmail: (token: string, accountEmail: string, emailId: number) =>
    request<EmailRecord>("POST", `/api/accounts/${enc(accountEmail)}/emails/${emailId}/send`, { token }),

  // Bulk actions share a single IMAP connection across the whole batch server-side, unlike
  // firing one request per message — see runBulkAction in server/routes/emails.ts.
  bulkUpdateEmails: (token: string, accountEmail: string, ids: number[], input: EmailInput) =>
    request<BulkResult[]>("PATCH", `/api/accounts/${enc(accountEmail)}/emails/bulk`, { token, body: { ids, ...input } }),
  bulkDeleteEmails: (token: string, accountEmail: string, ids: number[]) =>
    request<BulkResult[]>("DELETE", `/api/accounts/${enc(accountEmail)}/emails/bulk`, { token, body: { ids } }),
  bulkMoveEmails: (token: string, accountEmail: string, ids: number[], folder: string) =>
    request<BulkResult[]>("PATCH", `/api/accounts/${enc(accountEmail)}/emails/bulk/move/${enc(folder)}`, {
      token,
      body: { ids },
    }),

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
    saveBlob(await res.blob(), filename);
  },

  /**
   * Saves the messages as .eml files: one message as the file itself, several as one zip (the server streams it, so
   * a big selection doesn't pile up there). Returns the name of the saved file.
   */
  async downloadMessages(token: string, accountEmail: string, ids: number[]): Promise<string> {
    const res = await fetch(`/api/accounts/${enc(accountEmail)}/emails/download`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, data.error ?? res.statusText);
    }
    const filename = filenameFromDisposition(res.headers.get("content-disposition")) ?? (ids.length === 1 ? "message.eml" : "messages.zip");
    saveBlob(await res.blob(), filename);
    return filename;
  },

  listDownloadJobs: (token: string, accountEmail: string) =>
    request<DownloadJob[]>("GET", `/api/accounts/${enc(accountEmail)}/downloads`, { token }),
  /** Syncs every folder of the account, or just `folder` when given. */
  triggerDownload: (token: string, accountEmail: string, folder?: string) =>
    request<DownloadJob>("POST", `/api/accounts/${enc(accountEmail)}/downloads`, { token, body: folder ? { folder } : {} }),
  getDownloadJob: (token: string, accountEmail: string, jobId: number) =>
    request<DownloadJob>("GET", `/api/accounts/${enc(accountEmail)}/downloads/${jobId}`, { token }),

  /** Renames the signed-in user; the sign-in name changes, nothing else. A name that is taken is a 409. */
  changeUsername: (token: string, username: string) =>
    request<{ id: number; username: string }>("POST", "/api/auth/change-username", { token, body: { username } }),
  /** Changes the signed-in user's password (the server re-encrypts the accounts' saved passwords) and signs out their other sessions. */
  changePassword: (token: string, currentPassword: string, newPassword: string) =>
    request<{ ok: true; otherSessionsSignedOut: number }>("POST", "/api/auth/change-password", {
      token,
      body: { currentPassword, newPassword },
    }),
  // ---- AI (Settings → AI, and the summarize/translate/refine buttons) ----
  listAiApis: (token: string) => request<AiApiRecord[]>("GET", "/api/ai/apis", { token }),
  createAiApi: (token: string, input: AiApiInput) => request<AiApiRecord>("POST", "/api/ai/apis", { token, body: input }),
  updateAiApi: (token: string, id: number, input: AiApiInput) => request<AiApiRecord>("PATCH", `/api/ai/apis/${id}`, { token, body: input }),
  deleteAiApi: (token: string, id: number) => request<void>("DELETE", `/api/ai/apis/${id}`, { token }),
  testAiApi: (token: string, id: number) => request<{ ok: true; answer: string }>("POST", `/api/ai/apis/${id}/test`, { token }),
  listAiSkills: (token: string) => request<AiSkillRecord[]>("GET", "/api/ai/skills", { token }),
  createAiSkill: (token: string, input: AiSkillInput) => request<AiSkillRecord>("POST", "/api/ai/skills", { token, body: input }),
  updateAiSkill: (token: string, id: number, input: AiSkillInput) => request<AiSkillRecord>("PATCH", `/api/ai/skills/${id}`, { token, body: input }),
  deleteAiSkill: (token: string, id: number) => request<void>("DELETE", `/api/ai/skills/${id}`, { token }),
  /** Composing: the user's skill of `category` applied to `text`; nothing is stored. */
  aiRun: (token: string, category: Exclude<AiCategory, "categorize" | "events">, text: string, language?: string, skillId?: number) =>
    request<{ text: string }>("POST", "/api/ai/run", { token, body: { category, text, language, skillId } }),
  /** Summarizes a message (and categorizes it, and looks for dates and events, if those skills exist); all are stored on the message. */
  aiSummarize: (token: string, accountEmail: string, emailId: number, skillId?: number) =>
    request<{ email: EmailRecord; taxonomyError?: string; eventsError?: string }>("POST", `/api/accounts/${enc(accountEmail)}/emails/${emailId}/ai/summarize`, {
      token,
      body: { skillId },
    }),
  aiTranslate: (token: string, accountEmail: string, emailId: number, language?: string, skillId?: number) =>
    request<{ email: EmailRecord }>("POST", `/api/accounts/${enc(accountEmail)}/emails/${emailId}/ai/translate`, {
      token,
      body: { language, skillId },
    }),
  getSettings: (token: string) => request<UserSettings>("GET", "/api/settings", { token }),
  /** Shallow-merges into the stored settings; a key set to null is removed. */
  updateSettings: (token: string, patch: { [K in keyof UserSettings]?: UserSettings[K] | null }) =>
    request<UserSettings>("PATCH", "/api/settings", { token, body: patch }),
  /** New unread combined-Inbox mail since `afterId`; without it, just the current `latestId` to start from. */
  newMail: (token: string, afterId?: number) =>
    request<NewMailResult>("GET", `/api/unified/inbox/new${afterId === undefined ? "" : `?afterId=${afterId}`}`, { token }),
  /** Unread messages across all accounts' Inboxes — the combined Inbox's badge. */
  unifiedInboxUnread: (token: string) => request<{ count: number }>("GET", "/api/unified/inbox/unread", { token }),
  /** Newest-first messages across all accounts' Inboxes (`inbox`) or Sent folders (`sent`). */
  listUnified: (token: string, kind: UnifiedKind, opts: { limit?: number; offset?: number; after?: string; before?: string; categories?: string[] } = {}) => {
    const params = new URLSearchParams();
    for (const category of opts.categories ?? []) params.append("category", category);
    if (opts.after) params.set("after", opts.after);
    if (opts.before) params.set("before", opts.before);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.offset) params.set("offset", String(opts.offset));
    return request<SearchResult[]>("GET", `/api/unified/${kind}?${params}`, { token });
  },
  /** Searches across every account the user owns. See src/server/models/search.ts for query syntax. */
  /** The categories (AI labels) the user's messages have, most used first, with how many messages carry each. */
  listCategories: (token: string) => request<{ label: string; count: number }[]>("GET", "/api/categories", { token }),
  search: (token: string, query: string, opts: { limit?: number; offset?: number; after?: string; before?: string; categories?: string[]; fullText?: boolean } = {}) => {
    const params = new URLSearchParams({ q: query });
    for (const category of opts.categories ?? []) params.append("category", category);
    if (opts.fullText) params.set("fulltext", "1");
    if (opts.after) params.set("after", opts.after);
    if (opts.before) params.set("before", opts.before);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.offset) params.set("offset", String(opts.offset));
    return request<SearchResult[]>("GET", `/api/search?${params}`, { token });
  },
};
