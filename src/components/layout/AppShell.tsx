import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LogOut, Mail, PanelLeftOpen, PenSquare, Search, Settings, X } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { AccountTree } from "@/components/sidebar/AccountTree";
import { SettingsDialog, type SettingsPatch } from "@/components/layout/SettingsDialog";
import { showNewMailToast } from "@/components/mail/newMailToast";
import { hasFinePointer } from "@/lib/pointer";
import type { AiSkillRecord } from "../../server/models/ai";
import { DEFAULT_NOTIFICATION_SOUND, playNotificationSound, showBrowserNotification, type NewMailPreview } from "@/lib/notifications";
import { EditAccountDialog } from "@/components/sidebar/EditAccountDialog";
import { ResizeHandle } from "@/components/layout/ResizeHandle";
import { EmptyState } from "@/components/mail/EmptyState";
import { MessageList } from "@/components/mail/MessageList";
import { BulkActionBar } from "@/components/mail/BulkActionBar";
import { SearchResultList } from "@/components/mail/SearchResultList";
import { MessageView } from "@/components/mail/MessageView";
import type { BodyView } from "@/components/mail/MessageBody";
import { ComposeDialog, type ComposeDraft } from "@/components/mail/ComposeDialog";
import { useAccounts } from "@/hooks/useAccounts";
import { useEmails } from "@/hooks/useEmails";
import { useFolders } from "@/hooks/useFolders";
import { useSyncJobs } from "@/hooks/useSyncJobs";
import { useEmailDetail } from "@/hooks/useEmailDetail";
import { useSearchResults } from "@/hooks/useSearchResults";
import { useResizableWidth } from "@/hooks/useResizableWidth";
import { useLocalStorageState } from "@/hooks/useLocalStorageState";
import { useAuth } from "@/contexts/AuthContext";
import { api, type BulkResult, type FolderInfo, type UnifiedKind, type UserSettings } from "@/lib/api";
import { editDraft, forwardDraft, replyAllDraft, replyDraft, withSignature } from "@/lib/compose";
import { resolveSpecialFolder } from "@/lib/folders";
import type { Account, EmailRecord } from "../../server/types";
import type { SearchResult } from "../../server/models/search";

/**
 * Whether deleting `email` would move it to Trash instead of permanently expunging it —
 * mirrors wantsSoftDelete in server/routes/emails.ts. Used purely to decide whether the
 * delete confirmation dialog is worth showing at all: skip it when the action is easily
 * undone (just move it back out of Trash), only ask when it's actually permanent. `folders`
 * (the account's live IMAP listing, already fetched anyway) resolves the real Trash path —
 * the server doesn't always call it literally "Trash" — so this stays in sync with what the
 * backend will actually decide.
 */
function willSoftDelete(account: Account | null, email: { uid: number | null; folder: string }, folders: FolderInfo[]): boolean {
  return (
    !!account &&
    !account.readOnly &&
    email.uid !== null &&
    account.supportsUidPlus === true &&
    !account.skipSoftDelete &&
    email.folder !== resolveSpecialFolder(folders, "\\Trash", "Trash")
  );
}

interface SelectionItem {
  id: number;
  accountEmail: string;
  folder: string;
  uid: number | null;
  isRead: boolean;
}

export function AppShell() {
  const { token, username, logout } = useAuth();
  const { accounts, loading: accountsLoading, refresh: refreshAccounts } = useAccounts();

  const [selectedAccountEmail, setSelectedAccountEmail] = useState<string | null>(null);
  const selectedAccount = accounts.find(a => a.email === selectedAccountEmail) ?? null;
  // A disabled account is frozen (the server refuses every change): the UI doesn't even try.
  const isDisabledAccount = (email: string | null) => !!accounts.find(a => a.email === email)?.disabled;
  function refuseIfDisabled(email: string | null): boolean {
    if (!isDisabledAccount(email)) return false;
    toast.error(`Account "${email}" is disabled — enable it in its account settings to change it.`);
    return true;
  }
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [selectedEmailId, setSelectedEmailId] = useState<number | null>(null);
  // Checked via Cmd/Ctrl+click, for bulk actions — independent of selectedEmailId (the reading pane).
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  // The reference point a Shift+click range is measured from — the last plain- or Cmd/Ctrl-clicked message.
  const [selectionAnchorId, setSelectionAnchorId] = useState<number | null>(null);
  // Where the keyboard is in the list (arrow keys move it; with Shift it's the moving end of the selection range).
  const [cursorId, setCursorId] = useState<number | null>(null);
  const [pendingDeleteAccount, setPendingDeleteAccount] = useState<string | null>(null);
  // Set only when the pending delete is NOT a soft-delete (i.e. it would be permanent) — see
  // requestDelete/willSoftDelete. `count` is just for the confirmation dialog's copy.
  const [confirmDelete, setConfirmDelete] = useState<{ mode: "single" | "bulk"; count: number } | null>(null);
  const [editingAccountEmail, setEditingAccountEmail] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeInitial, setComposeInitial] = useState<ComposeDraft | null>(null);
  // Remembered across messages (and folder/account switches) so the next message
  // opened reuses whatever body view the user was last reading with.
  const [preferredBodyView, setPreferredBodyView] = useState<BodyView | null>(null);
  // Server-side user settings (GET/PATCH /api/settings): the reading tab, the auto-sync interval, and
  // the combined-Inbox option. Loaded once; edits merge the server's answer back in.
  const [settings, setSettings] = useState<UserSettings>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    if (!token) return;
    api
      .getSettings(token)
      .then(loaded => {
        setSettings(loaded);
        if (loaded.bodyView) setPreferredBodyView(loaded.bodyView);
      })
      .catch(() => {});
  }, [token]);
  // Which AI skills the user has set up: the summarize/translate/refine buttons are only offered for those.
  const [aiSkills, setAiSkills] = useState<AiSkillRecord[]>([]);
  const refreshAiSkills = useCallback(() => {
    if (!token) return;
    api.listAiSkills(token).then(setAiSkills).catch(() => {});
  }, [token]);
  useEffect(() => {
    refreshAiSkills();
  }, [refreshAiSkills]);

  async function saveAiLanguage(language: string | null) {
    if (token) setSettings(await api.updateSettings(token, { aiTargetLanguage: language }));
  }

  // The AI buttons of the reading pane: summarize (+ categorize when that skill exists) and translate. The result is
  // stored on the message by the server; here it is just put into the open message.
  const [aiBusy, setAiBusy] = useState<"summarize" | "translate" | null>(null);
  const openEmailId = useRef<number | null>(null);
  // Summarizing/translating again replaces a stored result (and costs another AI call), so it asks first.
  const [confirmAi, setConfirmAi] = useState<{ kind: "summarize" | "translate"; skillId: number } | null>(null);
  function requestAi(kind: "summarize" | "translate", skillId: number) {
    const alreadyDone = kind === "summarize" ? !!selectedEmail?.aiSummary : !!selectedEmail?.translatedText;
    if (alreadyDone) setConfirmAi({ kind, skillId });
    else runAi(kind, skillId);
  }
  async function runAi(kind: "summarize" | "translate", skillId: number) {
    if (refuseIfDisabled(selectedAccountEmail)) return;
    if (!token || !selectedAccountEmail || !selectedEmail) return;
    const id = selectedEmail.id;
    setAiBusy(kind);
    try {
      const result =
        kind === "summarize"
          ? await api.aiSummarize(token, selectedAccountEmail, id, skillId)
          : await api.aiTranslate(token, selectedAccountEmail, id, undefined, skillId);
      if (openEmailId.current === id) setSelectedEmailDetail(result.email);
      if ("taxonomyError" in result && result.taxonomyError) toast.error(`Categorizing failed: ${result.taxonomyError}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setAiBusy(null);
    }
  }

  // Only an explicit tab click lands here: a mail lacking the preferred tab just shows another one
  // without changing (or storing) the preference.
  function pickBodyView(view: BodyView) {
    setPreferredBodyView(view);
    if (token) api.updateSettings(token, { bodyView: view }).then(setSettings).catch(() => {});
  }
  // A cross-account mailbox (all Inboxes / all Sents) shown instead of one account's folder. The app
  // opens on the combined Inbox; picking a real folder in the sidebar leaves it, and a running search
  // takes precedence over it.
  const [unifiedView, setUnifiedView] = useState<UnifiedKind | null>("inbox");
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const {
    results: searchResults,
    loading: searchLoading,
    loadingMore: searchLoadingMore,
    hasMore: searchHasMore,
    loadMore: loadMoreSearchResults,
    refresh: refreshSearchResults,
    patchLocal: patchSearchResult,
    removeLocal: removeSearchResult,
  } = useSearchResults(searchQuery, unifiedView);
  const isSearching = searchQuery.trim().length > 0;
  // The cross-account result list (search hits or a unified mailbox) replaces the folder's message list.
  const showingResults = isSearching || unifiedView !== null;

  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorageState("psmail.sidebarCollapsed", false);
  const { width: sidebarWidth, startResize: startSidebarResize } = useResizableWidth("psmail.sidebarWidth", 240, 160, 480);
  const { width: messageListWidth, startResize: startMessageListResize } = useResizableWidth(
    "psmail.messageListWidth",
    320,
    240,
    640
  );

  useEffect(() => {
    if (!selectedAccountEmail && accounts.length > 0) {
      setSelectedAccountEmail(accounts[0]!.email);
      setSelectedFolder("INBOX");
    }
  }, [accounts, selectedAccountEmail]);

  const { emails, loading: emailsLoading, loadingMore, hasMore, loadMore, refresh: refreshEmails, patchLocal, removeLocal } = useEmails(
    selectedAccountEmail,
    selectedFolder
  );
  const { folders, loading: foldersLoading, error: foldersError, refresh: refreshFolders, patchCounts: patchRawFolderCounts } =
    useFolders(selectedAccountEmail);

  // Unread messages across every account's Inbox, for the combined Inbox's badge. Loaded from the
  // server (which knows all accounts, not just the selected one) and then nudged optimistically
  // alongside the per-folder counts below; re-read whenever something else could have changed it.
  const [unifiedInboxUnread, setUnifiedInboxUnread] = useState(0);
  const refreshUnifiedInboxUnread = useCallback(() => {
    if (!token) return;
    api.unifiedInboxUnread(token).then(r => setUnifiedInboxUnread(r.count)).catch(() => {});
  }, [token]);
  useEffect(() => {
    refreshUnifiedInboxUnread();
  }, [refreshUnifiedInboxUnread]);

  function patchFolderCounts(folder: string, deltas: { total?: number; unread?: number }) {
    patchRawFolderCounts(folder, deltas);
    if (folder === "INBOX" && deltas.unread) setUnifiedInboxUnread(count => Math.max(0, count + deltas.unread!));
  }

  // A sync finished for some account: pick up its new mail without disturbing anything else
  // (the folder tree refreshes in place; see useFolders). Reloads the open list only if it's this
  // account's folder, or the combined/search list that may include it.
  function handleSyncComplete(accountEmail: string) {
    if (accountEmail === selectedAccountEmail) refreshEmails();
    refreshSearchResults();
    refreshUnifiedInboxUnread();
    announceNewMail();
  }

  // New-mail announcements: the server says what arrived in the combined Inbox after the highest message
  // id seen so far. The starting point is read when the app loads, so mail that came in while it was
  // closed isn't announced, and every sync moves it forward whether or not notifications are on.
  const newMailBaseline = useRef<number | null>(null);
  useEffect(() => {
    if (!token) return;
    api.newMail(token).then(r => (newMailBaseline.current = r.latestId)).catch(() => {});
  }, [token]);

  const openNewMail = (mail: NewMailPreview) => {
    selectFolder(mail.accountEmail, mail.folder);
    setSelectedEmailId(mail.id);
  };

  async function announceNewMail() {
    if (!token || newMailBaseline.current === null) return;
    const result = await api.newMail(token, newMailBaseline.current).catch(() => null);
    if (!result) return;
    newMailBaseline.current = result.latestId;
    if (result.total === 0) return;

    const handlers = { openMail: openNewMail, openInbox: () => selectUnified("inbox") };
    if (settings.notifyBrowser) showBrowserNotification(result, handlers);
    if (settings.notifyToast) {
      showNewMailToast(result, handlers);
      playNotificationSound(settings.notificationSound ?? DEFAULT_NOTIFICATION_SOUND);
    }
  }

  const { jobs: syncJobs, start: startSync } = useSyncJobs(accounts, handleSyncComplete);

  // Automatic sync: while the app is open, every `syncIntervalMinutes` each account's Inbox is synced
  // (an account that's still busy with the previous run is skipped by startSync). Only the Inbox, to
  // keep the periodic IMAP traffic small — the other folders sync when the user clicks "Sync now".
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;
  const syncIntervalMinutes = settings.syncIntervalMinutes;
  useEffect(() => {
    if (!syncIntervalMinutes) return;
    const timer = setInterval(() => {
      for (const account of accountsRef.current) if (!account.disabled) startSync(account.email, { folder: "INBOX", silent: true });
    }, syncIntervalMinutes * 60_000);
    return () => clearInterval(timer);
  }, [syncIntervalMinutes, startSync]);

  async function saveSettings(patch: SettingsPatch) {
    if (!token) return;
    const includeChanged = (settings.combinedInboxIncludesFolders === true) !== patch.combinedInboxIncludesFolders;
    setSettings(await api.updateSettings(token, patch));
    // The combined Inbox's contents and badge depend on the option, and the server applies it per request.
    if (includeChanged) {
      refreshSearchResults();
      refreshUnifiedInboxUnread();
    }
  }
  const { email: selectedEmail, setEmail: setSelectedEmailDetail } = useEmailDetail(selectedAccountEmail, selectedEmailId);
  openEmailId.current = selectedEmail?.id ?? null;

  // Mark-as-read on open, like every other mail client. Patches both the folder-scoped list
  // and the (separate) search results array, since a message can be open from either. Unlike
  // toggleRead (an explicit click), this doesn't roll back the optimistic local update on a
  // failed IMAP push — flipping the message back to unread right after the user just opened
  // and read it would be a confusing flicker. It does still surface the failure via toast.
  useEffect(() => {
    if (selectedEmail && !selectedEmail.isRead && selectedAccountEmail && token && !isDisabledAccount(selectedAccountEmail)) {
      api.updateEmail(token, selectedAccountEmail, selectedEmail.id, { isRead: true }).catch(err => {
        toast.error(errorMessage(err, "Failed to sync read status to the mail server"));
      });
      patchLocal(selectedEmail.id, { isRead: true });
      patchSearchResult(selectedEmail.id, { isRead: true });
      patchFolderCounts(selectedEmail.folder, { unread: -1 });
      setSelectedEmailDetail({ ...selectedEmail, isRead: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEmail?.id]);

  // Keyboard shortcuts. All are skipped while a dialog is open (Radix traps focus inside it anyway,
  // and its own keys — Esc in particular — belong to it).
  //
  // - Esc closes the search (same as its "x") and takes focus out of the search box.
  // - Cmd/Ctrl+K focuses the search input, from anywhere (even while typing in another field).
  // - Cmd/Ctrl+A selects every loaded message in the list on screen (for the bulk actions) — only
  //   outside text fields, where it keeps its normal meaning.
  // - Cmd/Ctrl+R replies to the open message (instead of reloading the page) — only when one is open.
  // - Backspace/Delete deletes the open message (or the bulk selection, if there is one), same as
  //   clicking the Delete button — also skipped while typing in a text field.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const dialogOpen =
        composeOpen || settingsOpen || editingAccountEmail !== null || pendingDeleteAccount !== null || confirmDelete !== null || confirmAi !== null;
      if (dialogOpen) return;

      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      const mod = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
      const key = e.key.toLowerCase();

      if (e.key === "Escape") {
        if (searchQuery === "") return;
        e.preventDefault();
        setSearchQuery("");
        searchInputRef.current?.blur();
        return;
      }

      if (mod && key === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      if (mod && key === "a") {
        const { ids } = activeList();
        if (typing || ids.length === 0) return;
        e.preventDefault();
        setSelectedIds(new Set(ids));
        return;
      }

      if (mod && key === "r") {
        if (!selectedEmail) return;
        e.preventDefault();
        openCompose(replyDraft(selectedEmail));
        return;
      }

      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Only with a mouse-type pointer, outside text fields and open menus/lists (which use the arrows themselves).
        if (typing || !hasFinePointer() || target?.closest('[role="menu"], [role="listbox"], [role="combobox"]')) return;
        if (moveListCursor(e.key === "ArrowDown" ? 1 : -1, e.shiftKey)) e.preventDefault();
        return;
      }

      if (e.key !== "Backspace" && e.key !== "Delete") return;

      if (typing) return;
      if (selectedIds.size === 0 && !selectedEmail) return;

      e.preventDefault();
      requestDelete();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  /** The ids of the list on screen (folder messages, or search/combined results), in order, and how to open one in the reading pane. */
  function activeList(): { ids: number[]; open: (id: number) => void } {
    if (showingResults) {
      return {
        ids: searchResults.map(r => r.id),
        open: id => {
          const result = searchResults.find(r => r.id === id);
          if (result) selectSearchResult(result);
        },
      };
    }
    return { ids: emails.map(e => e.id), open: id => setSelectedEmailId(id) };
  }

  /**
   * Arrow up/down through the active list (folder list, search results or combined lists): shows the
   * next/previous message; with Shift, extends the bulk selection from the anchor to the new position
   * instead, like Shift+click. Returns whether the key did something.
   */
  function moveListCursor(direction: 1 | -1, extend: boolean): boolean {
    const { ids, open } = activeList();
    if (ids.length === 0) return false;

    const from = ids.indexOf(cursorId ?? selectionAnchorId ?? selectedEmailId ?? -1);
    const next = from === -1 ? (direction > 0 ? 0 : ids.length - 1) : Math.min(Math.max(from + direction, 0), ids.length - 1);
    const nextId = ids[next]!;

    if (extend) {
      const anchorId = selectionAnchorId ?? selectedEmailId ?? nextId;
      const anchor = ids.indexOf(anchorId);
      const [start, end] = anchor <= next ? [anchor, next] : [next, anchor];
      setSelectedIds(new Set(ids.slice(start, end + 1)));
      setSelectionAnchorId(anchorId);
    } else {
      setSelectedIds(new Set());
      open(nextId);
      setSelectionAnchorId(nextId);
    }
    setCursorId(nextId);
    return true;
  }

  // Keep the keyboard cursor's row in view as it moves.
  useEffect(() => {
    const id = cursorId ?? selectedEmailId;
    if (id !== null) document.querySelector(`[data-row-id="${id}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [cursorId, selectedEmailId]);

  function selectUnified(kind: UnifiedKind) {
    setUnifiedView(kind);
    setCursorId(null);
    setSearchQuery("");
    setSelectedEmailId(null);
    setSelectedIds(new Set());
    setSelectionAnchorId(null);
  }

  function selectFolder(accountEmail: string, folder: string) {
    setUnifiedView(null);
    setCursorId(null);
    setSelectedAccountEmail(accountEmail);
    setSelectedFolder(folder);
    setSelectedEmailId(null);
    setSelectedIds(new Set());
    setSelectionAnchorId(null);
  }

  /**
   * Cmd/Ctrl+click toggles a message in the bulk-action selection without touching the reading pane, so
   * you can build a selection while still reading. Shift+click selects every message between the anchor
   * (the last plain- or Cmd/Ctrl-clicked one) and this one, replacing the current selection — the anchor
   * itself doesn't move, so repeated Shift+clicks grow/shrink the range from the same starting point.
   * Shared by the folder list and the search/combined lists. Returns false for a plain click.
   */
  function handleSelectionClick(ids: number[], id: number, event: React.MouseEvent): boolean {
    if (event.shiftKey) {
      const anchorIndex = selectionAnchorId !== null ? ids.indexOf(selectionAnchorId) : -1;
      const targetIndex = ids.indexOf(id);

      if (anchorIndex === -1 || targetIndex === -1) {
        setSelectedIds(new Set([id]));
      } else {
        const [start, end] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
        setSelectedIds(new Set(ids.slice(start, end + 1)));
      }

      if (selectionAnchorId === null) setSelectionAnchorId(id);
      setCursorId(id);
      return true;
    }

    if (event.metaKey || event.ctrlKey) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setSelectionAnchorId(id);
      setCursorId(id);
      return true;
    }

    return false;
  }

  // A plain click reads the message as usual (and drops any bulk selection, like every other mail client).
  function selectEmail(email: EmailRecord, event: React.MouseEvent) {
    if (handleSelectionClick(emails.map(e => e.id), email.id, event)) return;

    setSelectedIds(new Set());
    setSelectedEmailId(email.id);
    setSelectionAnchorId(email.id);
    setCursorId(email.id);
  }

  // A search result can belong to a different account/folder than the one currently
  // selected in the sidebar; opening one switches the reading pane to that context
  // without clearing the search itself, so the result list stays browsable.
  function selectSearchResult(result: SearchResult) {
    setSelectedAccountEmail(result.accountEmail);
    setSelectedFolder(result.folder);
    setSelectedEmailId(result.id);
    setSelectedIds(new Set());
    setSelectionAnchorId(null);
  }

  function selectResult(result: SearchResult, event: React.MouseEvent) {
    if (handleSelectionClick(searchResults.map(r => r.id), result.id, event)) return;

    selectSearchResult(result);
    setSelectionAnchorId(result.id);
    setCursorId(result.id);
  }

  function errorMessage(err: unknown, fallback: string): string {
    return err instanceof Error ? err.message : fallback;
  }

  // Flag/move/delete now push to the account's IMAP server (unless it's read-only), so these
  // calls can genuinely fail (bad connection, server rejects the write, ...) in a way they
  // couldn't when they only touched the local database. The optimistic local update is rolled
  // back on failure so the UI doesn't drift from what the server actually has.
  async function toggleFlag(email: EmailRecord) {
    if (refuseIfDisabled(selectedAccountEmail)) return;
    if (!token || !selectedAccountEmail) return;
    const isFlagged = !email.isFlagged;
    patchLocal(email.id, { isFlagged });
    try {
      await api.updateEmail(token, selectedAccountEmail, email.id, { isFlagged });
    } catch (err) {
      patchLocal(email.id, { isFlagged: email.isFlagged });
      toast.error(errorMessage(err, "Failed to update flag"));
    }
  }

  // Star toggle for a row of the search / combined-Inbox lists. Unlike the folder list's toggleFlag, the
  // result can belong to any account, so its own accountEmail is used; the folder list's copy and an
  // open reading pane are kept in sync, and everything is rolled back if the server refuses.
  async function toggleResultFlag(result: SearchResult) {
    if (refuseIfDisabled(result.accountEmail)) return;
    if (!token) return;
    const isFlagged = !result.isFlagged;
    const apply = (value: boolean) => {
      patchSearchResult(result.id, { isFlagged: value });
      patchLocal(result.id, { isFlagged: value });
      if (selectedEmail?.id === result.id) setSelectedEmailDetail({ ...selectedEmail, isFlagged: value });
    };
    apply(isFlagged);
    try {
      await api.updateEmail(token, result.accountEmail, result.id, { isFlagged });
    } catch (err) {
      apply(result.isFlagged);
      toast.error(errorMessage(err, "Failed to update flag"));
    }
  }

  async function toggleRead() {
    if (refuseIfDisabled(selectedAccountEmail)) return;
    if (!token || !selectedAccountEmail || !selectedEmail) return;
    const previousIsRead = selectedEmail.isRead;
    const isRead = !previousIsRead;
    patchLocal(selectedEmail.id, { isRead });
    patchSearchResult(selectedEmail.id, { isRead });
    patchFolderCounts(selectedEmail.folder, { unread: isRead ? -1 : 1 });
    setSelectedEmailDetail({ ...selectedEmail, isRead });
    try {
      await api.updateEmail(token, selectedAccountEmail, selectedEmail.id, { isRead });
    } catch (err) {
      patchLocal(selectedEmail.id, { isRead: previousIsRead });
      patchSearchResult(selectedEmail.id, { isRead: previousIsRead });
      patchFolderCounts(selectedEmail.folder, { unread: isRead ? 1 : -1 });
      setSelectedEmailDetail({ ...selectedEmail, isRead: previousIsRead });
      toast.error(errorMessage(err, "Failed to update read status"));
    }
  }

  async function handleDelete() {
    if (refuseIfDisabled(selectedAccountEmail)) return;
    if (!token || !selectedAccountEmail || !selectedEmail) return;
    let result: { softDeleted: boolean };
    try {
      result = await api.deleteEmail(token, selectedAccountEmail, selectedEmail.id);
    } catch (err) {
      toast.error(errorMessage(err, "Failed to delete message"));
      return;
    }
    removeLocal(selectedEmail.id);
    removeSearchResult(selectedEmail.id);
    patchFolderCounts(selectedEmail.folder, { total: -1, unread: selectedEmail.isRead ? 0 : -1 });
    if (result.softDeleted) {
      patchFolderCounts(resolveSpecialFolder(folders, "\\Trash", "Trash"), {
        total: 1,
        unread: selectedEmail.isRead ? 0 : 1,
      });
    }
    setSelectedEmailId(null);
    toast.success(result.softDeleted ? "Moved to Trash" : "Message deleted");
  }

  async function handleMove(folder: string) {
    if (refuseIfDisabled(selectedAccountEmail)) return;
    if (!token || !selectedAccountEmail || !selectedEmail) return;
    try {
      await api.moveEmail(token, selectedAccountEmail, selectedEmail.id, folder);
    } catch (err) {
      toast.error(errorMessage(err, "Failed to move message"));
      return;
    }
    removeLocal(selectedEmail.id);
    // Unlike the folder-scoped list, a moved message still matches a search — just with a new
    // folder — so it's patched in place. A unified Inbox/Sent only lists that one folder, though,
    // so a moved message leaves it.
    if (unifiedView !== null && !isSearching) removeSearchResult(selectedEmail.id);
    else patchSearchResult(selectedEmail.id, { folder });
    patchFolderCounts(selectedEmail.folder, { total: -1, unread: selectedEmail.isRead ? 0 : -1 });
    patchFolderCounts(folder, { total: 1, unread: selectedEmail.isRead ? 0 : 1 });
    setSelectedEmailId(null);
    toast.success(`Moved to ${folder}`);
  }

  // What the bulk actions act on: the checked rows of whichever list is on screen. In the folder list they
  // all belong to the selected account; search/combined results can mix accounts.
  const selectionItems: SelectionItem[] = useMemo(() => {
    if (selectedIds.size === 0) return [];
    if (showingResults) {
      return searchResults
        .filter(r => selectedIds.has(r.id))
        .map(r => ({ id: r.id, accountEmail: r.accountEmail, folder: r.folder, uid: r.uid, isRead: r.isRead }));
    }
    return emails
      .filter(e => selectedIds.has(e.id))
      .map(e => ({ id: e.id, accountEmail: selectedAccountEmail ?? "", folder: e.folder, uid: e.uid, isRead: e.isRead }));
  }, [selectedIds, showingResults, searchResults, emails, selectedAccountEmail]);

  // The one account every selected message belongs to, if there is exactly one — Move needs that (folders
  // are per account), so the sidebar's account follows it and its folder list is what Move offers.
  const selectionAccount = selectionItems.length > 0 && selectionItems.every(i => i.accountEmail === selectionItems[0]!.accountEmail)
    ? selectionItems[0]!.accountEmail
    : null;
  useEffect(() => {
    if (showingResults && selectionAccount && selectionAccount !== selectedAccountEmail) setSelectedAccountEmail(selectionAccount);
  }, [showingResults, selectionAccount, selectedAccountEmail]);

  // A different result list (new search, another combined mailbox) starts with a clean selection.
  useEffect(() => {
    setSelectedIds(new Set());
    setSelectionAnchorId(null);
    setCursorId(null);
  }, [searchQuery.trim()]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Runs the bulk request for the selected messages — one request per account (each a single shared IMAP
   * connection server-side, see runBulkAction in server/routes/emails.ts, instead of one per message) —
   * and reports how many of them actually succeeded. Returns the successes with their list rows.
   */
  async function runBulkAction(
    perAccount: (accountEmail: string, ids: number[]) => Promise<BulkResult[]>,
    verb: string
  ): Promise<{ result: BulkResult; item: SelectionItem }[]> {
    if (!token) return [];
    const disabledItems = selectionItems.filter(item => isDisabledAccount(item.accountEmail));
    const items = selectionItems.filter(item => !isDisabledAccount(item.accountEmail));
    setSelectedIds(new Set());
    if (disabledItems.length > 0) {
      toast.error(`${disabledItems.length} message${disabledItems.length === 1 ? "" : "s"} skipped: the account is disabled and can't be changed.`);
    }
    if (items.length === 0) return [];

    const byAccount = new Map<string, SelectionItem[]>();
    for (const item of items) byAccount.set(item.accountEmail, [...(byAccount.get(item.accountEmail) ?? []), item]);

    const succeeded: { result: BulkResult; item: SelectionItem }[] = [];
    let failed = 0;
    for (const [accountEmail, group] of byAccount) {
      try {
        const results = await perAccount(accountEmail, group.map(i => i.id));
        for (const result of results) {
          const item = group.find(i => i.id === result.id);
          if (result.ok && item) succeeded.push({ result, item });
          else failed += 1;
        }
      } catch (err) {
        failed += group.length;
        toast.error(errorMessage(err, `Failed to ${verb.toLowerCase()} message(s)`));
      }
    }

    if (failed > 0) toast.error(`${verb} ${succeeded.length}/${items.length} message(s) — ${failed} failed`);
    else toast.success(`${verb} ${items.length} message(s)`);
    return succeeded;
  }

  /** Applies count changes to the sidebar's folder badges (only the selected account's are known here) and re-reads the combined Inbox's badge. */
  function applyCountChanges(changes: { item: SelectionItem; folder: string; total?: number; unread?: number }[]) {
    const perFolder = new Map<string, { total: number; unread: number }>();
    for (const change of changes) {
      if (change.item.accountEmail !== selectedAccountEmail) continue;
      const entry = perFolder.get(change.folder) ?? { total: 0, unread: 0 };
      entry.total += change.total ?? 0;
      entry.unread += change.unread ?? 0;
      perFolder.set(change.folder, entry);
    }
    for (const [folder, deltas] of perFolder) if (deltas.total !== 0 || deltas.unread !== 0) patchFolderCounts(folder, deltas);
    if (showingResults) refreshUnifiedInboxUnread();
  }

  async function bulkMarkRead(isRead: boolean) {
    if (!token) return;
    const succeeded = await runBulkAction(
      (accountEmail, ids) => api.bulkUpdateEmails(token, accountEmail, ids, { isRead }),
      isRead ? "Marked as read" : "Marked as unread"
    );
    succeeded.forEach(({ result, item }) => {
      patchLocal(result.id, { isRead });
      patchSearchResult(result.id, { isRead });
      if (selectedEmail?.id === result.id) setSelectedEmailDetail({ ...selectedEmail, isRead });
    });
    applyCountChanges(
      succeeded.filter(({ item }) => item.isRead !== isRead).map(({ item }) => ({ item, folder: item.folder, unread: isRead ? -1 : 1 }))
    );
  }

  async function bulkDelete() {
    if (!token) return;
    const trash = resolveSpecialFolder(folders, "\\Trash", "Trash");
    const succeeded = await runBulkAction((accountEmail, ids) => api.bulkDeleteEmails(token, accountEmail, ids), "Deleted");
    const changes: Parameters<typeof applyCountChanges>[0] = [];
    succeeded.forEach(({ result, item }) => {
      changes.push({ item, folder: item.folder, total: -1, unread: item.isRead ? 0 : -1 });
      if (result.softDeleted) changes.push({ item, folder: trash, total: 1, unread: item.isRead ? 0 : 1 });
      removeLocal(result.id);
      removeSearchResult(result.id);
      if (selectedEmailId === result.id) setSelectedEmailId(null);
    });
    applyCountChanges(changes);
  }

  async function bulkMove(folder: string) {
    if (!token) return;
    const succeeded = await runBulkAction(
      (accountEmail, ids) => api.bulkMoveEmails(token, accountEmail, ids, folder),
      `Moved to ${folder} —`
    );
    const changes: Parameters<typeof applyCountChanges>[0] = [];
    succeeded.forEach(({ result, item }) => {
      changes.push({ item, folder: item.folder, total: -1, unread: item.isRead ? 0 : -1 });
      changes.push({ item, folder, total: 1, unread: item.isRead ? 0 : 1 });
      removeLocal(result.id);
      // A moved message still matches a search (just in another folder) but leaves a combined Inbox/Sent.
      if (unifiedView !== null && !isSearching) removeSearchResult(result.id);
      else patchSearchResult(result.id, { folder });
      if (selectedEmailId === result.id) setSelectedEmailId(null);
    });
    applyCountChanges(changes);
  }

  /**
   * Entry point for every "delete" trigger (the reading pane's Delete button, the bulk action
   * bar's Delete button, and the Backspace/Delete keyboard shortcut): deletes right away when
   * every message involved would only be soft-deleted (moved to Trash, easily undone), and
   * otherwise asks for confirmation first since that outcome is permanent. Bulk and single are
   * mutually exclusive by construction — selecting one clears the other (see selectEmail).
   */
  function requestDelete() {
    if (selectedIds.size > 0) {
      if (selectionItems.length === 0) return;
      const soft = selectionItems.every(item =>
        willSoftDelete(
          accounts.find(a => a.email === item.accountEmail) ?? null,
          item,
          // Only the selected account's live folder list is at hand for resolving the Trash path.
          item.accountEmail === selectedAccountEmail ? folders : []
        )
      );
      if (soft) bulkDelete();
      else setConfirmDelete({ mode: "bulk", count: selectionItems.length });
      return;
    }
    if (selectedEmail) {
      if (refuseIfDisabled(selectedAccountEmail)) return;
      if (willSoftDelete(selectedAccount, selectedEmail, folders)) handleDelete();
      else setConfirmDelete({ mode: "single", count: 1 });
    }
  }

  function confirmDeleteAction() {
    if (!confirmDelete) return;
    if (confirmDelete.mode === "bulk") bulkDelete();
    else handleDelete();
    setConfirmDelete(null);
  }

  // New/reply/forward get the account's signature appended; continuing an existing draft
  // (editDraft sets `id`) doesn't — its body is already the draft's own finalized content.
  function openCompose(initial: ComposeDraft | null) {
    if (refuseIfDisabled(selectedAccountEmail)) return;
    setComposeInitial(initial?.id === undefined ? withSignature(initial, selectedAccount?.signature ?? null) : initial);
    setComposeOpen(true);
  }

  async function confirmDeleteAccount() {
    if (!token || !pendingDeleteAccount) return;
    await api.deleteAccount(token, pendingDeleteAccount);
    if (selectedAccountEmail === pendingDeleteAccount) {
      setSelectedAccountEmail(null);
      setSelectedFolder(null);
      setSelectedEmailId(null);
    }
    setPendingDeleteAccount(null);
    refreshAccounts();
  }

  const selected = useMemo(
    () => (selectedAccountEmail && selectedFolder ? { accountEmail: selectedAccountEmail, folder: selectedFolder } : null),
    [selectedAccountEmail, selectedFolder]
  );

  return (
    <div className="flex h-full flex-col">
      <Toaster position="bottom-right" />

      <header className="flex shrink-0 items-center justify-between gap-4 border-b px-4 py-2">
        <div className="flex items-center gap-2 shrink-0">
          <Mail className="size-5 text-primary" />
          <span className="font-semibold">P.S.Mail</span>
        </div>

        <div className="relative w-full max-w-md">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder='Search all mail…'
            className="h-8 pl-8 pr-8"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              title="Clear search"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
          >
            <Settings className="size-4" />
            {username === "default" ? "Settings" : username}
          </Button>
          <Button variant="ghost" size="icon" onClick={logout} title="Sign out">
            <LogOut className="size-4" />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {sidebarCollapsed ? (
          <div className="flex w-9 shrink-0 flex-col items-center border-r bg-muted/20 pt-3">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => setSidebarCollapsed(false)}
              title="Show accounts"
            >
              <PanelLeftOpen className="size-4" />
            </Button>
          </div>
        ) : (
          <>
            <div style={{ width: sidebarWidth }} className="shrink-0">
              <AccountTree
                accounts={accounts}
                loading={accountsLoading}
                refreshAccounts={refreshAccounts}
                selected={unifiedView ? null : selected}
                onSelectFolder={selectFolder}
                onDeleteAccount={setPendingDeleteAccount}
                onEditAccount={setEditingAccountEmail}
                unifiedInboxUnread={unifiedInboxUnread}
                syncJobs={syncJobs}
                onSync={email => startSync(email)}
                unifiedView={unifiedView}
                onSelectUnified={selectUnified}
                onCollapse={() => setSidebarCollapsed(true)}
                sharedFolders={{
                  accountEmail: selectedAccountEmail,
                  folders,
                  loading: foldersLoading,
                  error: foldersError,
                  refresh: refreshFolders,
                }}
              />
            </div>
            <ResizeHandle onPointerDown={startSidebarResize} />
          </>
        )}

        <div style={{ width: messageListWidth }} className="flex shrink-0 flex-col border-r">
          {selectionItems.length > 0 ? (
            <BulkActionBar
              count={selectionItems.length}
              canMove={selectionAccount !== null && selectionAccount === selectedAccountEmail}
              folders={folders.filter(f => !selectionItems.every(item => item.folder === f.path))}
              onMarkRead={() => bulkMarkRead(true)}
              onMarkUnread={() => bulkMarkRead(false)}
              onMove={bulkMove}
              onDelete={requestDelete}
              onClear={() => setSelectedIds(new Set())}
            />
          ) : (
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="truncate text-sm font-medium">
                {isSearching
                  ? `Search: "${searchQuery.trim()}"`
                  : unifiedView
                    ? `${unifiedView === "inbox" ? "Inbox" : "Sent"} · all accounts`
                    : selectedFolder ?? "—"}
              </span>
              <Button
                size="sm"
                disabled={!selectedAccountEmail || isDisabledAccount(selectedAccountEmail)}
                title={isDisabledAccount(selectedAccountEmail) ? "This account is disabled" : undefined}
                onClick={() => openCompose(null)}
              >
                <PenSquare className="size-4" /> New
              </Button>
            </div>
          )}
          <div className="min-h-0 flex-1">
            {showingResults ? (
              <SearchResultList
                results={searchResults}
                loading={searchLoading}
                hasMore={searchHasMore}
                loadingMore={searchLoadingMore}
                onLoadMore={loadMoreSearchResults}
                onToggleFlag={toggleResultFlag}
                showRecipient={unifiedView === "sent" && !isSearching}
                selectedId={selectedEmailId}
                selectedIds={selectedIds}
                onSelect={selectResult}
              />
            ) : selectedAccountEmail && selectedFolder ? (
              <MessageList
                emails={emails}
                loading={emailsLoading}
                hasMore={hasMore}
                loadingMore={loadingMore}
                onLoadMore={loadMore}
                selectedId={selectedEmailId}
                selectedIds={selectedIds}
                folder={selectedFolder}
                onSelect={selectEmail}
                onToggleFlag={toggleFlag}
                onEditDraft={email => openCompose(editDraft(email))}
              />
            ) : (
              <EmptyState title="No account selected" description="Add or select an account to see messages." />
            )}
          </div>
        </div>

        <ResizeHandle onPointerDown={startMessageListResize} />

        <div className="min-w-0 flex-1">
          {selectedEmail && selectedAccountEmail ? (
            <MessageView
              accountEmail={selectedAccountEmail}
              email={selectedEmail}
              folders={folders}
              preferredView={preferredBodyView}
              onViewChange={pickBodyView}
              onReply={() => openCompose(replyDraft(selectedEmail))}
              onReplyAll={() => openCompose(replyAllDraft(selectedEmail, selectedAccountEmail))}
              onForward={() => openCompose(forwardDraft(selectedEmail))}
              onDelete={requestDelete}
              onMove={handleMove}
              onToggleRead={toggleRead}
              onEditDraft={() => openCompose(editDraft(selectedEmail))}
              accountDisabled={isDisabledAccount(selectedAccountEmail)}
              aiSkills={aiSkills}
              aiBusy={aiBusy}
              onSummarize={skillId => requestAi("summarize", skillId)}
              onTranslate={skillId => requestAi("translate", skillId)}
            />
          ) : (
            <EmptyState title="Select a message" description="Choose a message from the list to read it here." />
          )}
        </div>
      </div>

      {selectedAccountEmail && (
        <ComposeDialog
          accountEmail={selectedAccountEmail}
          senderName={selectedAccount?.senderName ?? null}
          folders={folders}
          open={composeOpen}
          onOpenChange={setComposeOpen}
          initial={composeInitial}
          aiSkills={aiSkills}
          aiLanguage={settings.aiTargetLanguage ?? "English"}
          onSent={sent => {
            refreshEmails();
            refreshSearchResults();
            refreshUnifiedInboxUnread();
            refreshFolders();
            toast.success(sent ? "E-Mail sent" : "Saved");
          }}
        />
      )}

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        username={username}
        onSave={saveSettings}
        onSaveLanguage={saveAiLanguage}
        onAiChanged={refreshAiSkills}
      />

      <EditAccountDialog
        account={accounts.find(a => a.email === editingAccountEmail) ?? null}
        open={editingAccountEmail !== null}
        onOpenChange={open => !open && setEditingAccountEmail(null)}
        onSaved={refreshAccounts}
        accountCount={accounts.length}
      />

      <AlertDialog open={pendingDeleteAccount !== null} onOpenChange={open => !open && setPendingDeleteAccount(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {pendingDeleteAccount}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the account and all its locally synced messages and attachments. The mailbox on the server is
              untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeleteAccount}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmAi !== null} onOpenChange={open => !open && setConfirmAi(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmAi?.kind === "translate" ? "Translate again?" : "Summarize again?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAi?.kind === "translate"
                ? "This message has already been translated. Translating it again asks the AI once more and replaces the stored translation."
                : "This message has already been summarized. Summarizing it again asks the AI once more and replaces the stored summary (and categories)."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmAi) runAi(confirmAi.kind, confirmAi.skillId);
                setConfirmAi(null);
              }}
            >
              {confirmAi?.kind === "translate" ? "Translate again" : "Summarize again"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete !== null} onOpenChange={open => !open && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {confirmDelete && confirmDelete.count > 1 ? confirmDelete.count : ""} message
              {(confirmDelete?.count ?? 1) === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {/*This also deletes {(confirmDelete?.count ?? 1) === 1 ? "it" : "them"} from the account's mail server,
              unless the account is read-only — moved to Trash first if the server supports that safely, or
              permanently otherwise.*/}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeleteAction} autoFocus={true}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
