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
  skipSoftDelete: boolean;
  /** Whether the IMAP server supports UIDPLUS, as of the last check — null if never checked. Soft-delete (move to Trash) is only offered when this is true. */
  supportsUidPlus: boolean | null;
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
  createdAt: string;
  updatedAt: string;
  attachments?: AttachmentRecord[];
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
