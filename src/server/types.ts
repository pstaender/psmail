export interface User {
  id: number;
  username: string;
  authMethod: string;
  createdAt: string;
  updatedAt: string;
}

export interface Account {
  id: number;
  userId: number;
  email: string;
  displayName: string | null;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUsername: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername: string;
  readOnly: boolean;
  /** Disabled accounts aren't synced or written to; they stay readable (and always count as read-only). */
  disabled: boolean;
  skipSoftDelete: boolean;
  /** Left out of the global syncs (the interval sync and "sync all Inboxes"); syncing the account itself still works. */
  excludeFromAutoSync: boolean;
  /** Whether the IMAP server supports UIDPLUS, as of the last check — null if never checked. Soft-delete (move to Trash) is only offered when this is true. */
  supportsUidPlus: boolean | null;
  /** From display name used on outgoing mail sent from this account, instead of the bare address. */
  senderName: string | null;
  /** Markdown, appended to new/reply/forward compositions from this account. */
  signature: string | null;
  /** 1-based place in the sidebar's account list (see setAccountPosition). */
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface EmailRecord {
  id: number;
  accountId: number;
  folder: string;
  uid: number | null;
  isDraft: boolean;
  isRead: boolean;
  isFlagged: boolean;
  messageId: string | null;
  inReplyTo: string | null;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  replyTo: EmailAddress[];
  subject: string | null;
  date: string | null;
  returnPath: string | null;
  received: string[];
  mimeVersion: string | null;
  contentType: string | null;
  authenticationResults: string | null;
  dkim: string | null;
  spf: string | null;
  plainText: string | null;
  htmlText: string | null;
  headersRaw: string | null;
  size: number | null;
  /** 2-6 short category labels from the categorize skill (empty until run). */
  taxonomyList: string[];
  /** Events the "find dates and events" skill found, each a complete VCALENDAR (.ics) text; empty until run (or when there were none). */
  calendarEvents: string[];
  /** Classified as important (shown in the imbox): true / false, or null while it has not been classified. */
  imbox: boolean | null;
  /** Summary from the summarize skill, kept once computed. */
  aiSummary: string | null;
  /** Translation from the translate skill, and the language it is in. */
  translatedText: string | null;
  translatedLanguage: string | null;
  createdAt: string;
  updatedAt: string;
  attachments?: AttachmentRecord[];
  /** Number of real (non-inline) attachments — set on message-list rows, where `attachments` itself isn't loaded. */
  attachmentCount?: number;
  /** On message-list rows that are part of a conversation or were answered: see models/conversations.ts. Absent otherwise. */
  conversation?: { replied: boolean; related: number };
}

export interface AttachmentRecord {
  id: number;
  emailId: number;
  filename: string;
  contentType: string | null;
  contentId: string | null;
  isInline: boolean;
  size: number;
}

export type DownloadStatus = "pending" | "running" | "completed" | "failed";

export interface DownloadJob {
  id: number;
  accountId: number;
  folder: string | null;
  status: DownloadStatus;
  progressCurrent: number;
  progressTotal: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class NotFoundError extends ApiError {
  constructor(message = "Not found") {
    super(404, message);
  }
}

export class BadRequestError extends ApiError {
  constructor(message = "Bad request") {
    super(400, message);
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = "Unauthorized") {
    super(401, message);
  }
}

export class ConflictError extends ApiError {
  constructor(message = "Conflict") {
    super(409, message);
  }
}
