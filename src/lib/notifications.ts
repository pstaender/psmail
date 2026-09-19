import crystalClear from "../sounds/crystal_clear.mp3";
import cuteBell from "../sounds/cute_bell.mp3";
import marimba from "../sounds/marimba.mp3";
import type { EmailAddress } from "../server/types";

export interface NewMailPreview {
  id: number;
  accountEmail: string;
  folder: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string | null;
  date: string | null;
  snippet: string;
}

export interface NewMailResult {
  latestId: number;
  total: number;
  messages: NewMailPreview[];
}

/** What the notification should open when clicked. */
export interface NewMailHandlers {
  openMail: (mail: NewMailPreview) => void;
  openInbox: () => void;
}

export const NOTIFICATION_SOUNDS = [
  { id: "crystal_clear", label: "Crystal clear", url: crystalClear },
  { id: "cute_bell", label: "Cute bell", url: cuteBell },
  { id: "marimba", label: "Marimba", url: marimba },
  { id: "none", label: "No sound", url: null },
] as const;

export const DEFAULT_NOTIFICATION_SOUND = "crystal_clear";

/** Plays one of the bundled sounds (a stored `null`/unknown id means the default). Best effort: browsers can refuse autoplay, which is fine. */
export function playNotificationSound(id: string | null | undefined): void {
  const sound = NOTIFICATION_SOUNDS.find(s => s.id === (id ?? DEFAULT_NOTIFICATION_SOUND));
  if (!sound?.url) return;
  try {
    new Audio(sound.url).play()?.catch(() => {});
  } catch {
    // No audio support — silently skip.
  }
}

export function senderLabel(addresses: EmailAddress[]): string {
  const first = addresses[0];
  if (!first) return "Unknown sender";
  return first.name || first.address;
}

/** "Alice, Bob and 3 more" for the distinct senders among the previewed messages (`total` counts all new mail, previews only the newest few). */
export function sendersSummary(result: NewMailResult): string {
  const names = [...new Set(result.messages.map(m => senderLabel(m.from)))];
  const shown = names.slice(0, 3);
  const others = names.length - shown.length;
  const list = shown.join(", ");
  return others > 0 || result.total > result.messages.length ? `${list} and others` : list;
}

export function newMailsTitle(total: number): string {
  return `${total} new mails`;
}

/** Whether the browser lets us show desktop notifications right now. */
export function browserNotificationsGranted(): boolean {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

/**
 * The browser (desktop) notification for new mail: for one message just who it's from and the
 * subject — deliberately no content, since these can show on a locked screen — and for several a
 * count. Clicking it focuses the tab and opens that message, or the combined Inbox.
 */
export function showBrowserNotification(result: NewMailResult, handlers: NewMailHandlers): void {
  if (!browserNotificationsGranted() || result.total === 0) return;

  const single = result.total === 1 ? result.messages[0] : undefined;
  const title = single ? senderLabel(single.from) : newMailsTitle(result.total);
  const body = single ? single.subject || "(no subject)" : `From ${sendersSummary(result)}`;

  // One tag: a newer notification replaces the previous one instead of piling up.
  const notification = new Notification(title, { body, tag: "psmail-new-mail" });
  notification.onclick = () => {
    window.focus();
    notification.close();
    if (single) handlers.openMail(single);
    else handlers.openInbox();
  };
}
