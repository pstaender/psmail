import { useEffect, useMemo, useState } from "react";
import { LogOut, Mail, PanelLeftOpen, PenSquare, Search, X } from "lucide-react";
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
import { useEmailDetail } from "@/hooks/useEmailDetail";
import { useSearchResults } from "@/hooks/useSearchResults";
import { useResizableWidth } from "@/hooks/useResizableWidth";
import { useLocalStorageState } from "@/hooks/useLocalStorageState";
import { useAuth } from "@/contexts/AuthContext";
import { api, type BulkResult, type FolderInfo } from "@/lib/api";
import { editDraft, forwardDraft, replyDraft, withSignature } from "@/lib/compose";
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
function willSoftDelete(account: Account | null, email: EmailRecord, folders: FolderInfo[]): boolean {
  return (
    !!account &&
    !account.readOnly &&
    email.uid !== null &&
    account.supportsUidPlus === true &&
    !account.skipSoftDelete &&
    email.folder !== resolveSpecialFolder(folders, "\\Trash", "Trash")
  );
}

export function AppShell() {
  const { token, username, logout } = useAuth();
  const { accounts, loading: accountsLoading, refresh: refreshAccounts } = useAccounts();

  const [selectedAccountEmail, setSelectedAccountEmail] = useState<string | null>(null);
  const selectedAccount = accounts.find(a => a.email === selectedAccountEmail) ?? null;
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [selectedEmailId, setSelectedEmailId] = useState<number | null>(null);
  // Checked via Cmd/Ctrl+click, for bulk actions — independent of selectedEmailId (the reading pane).
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  // The reference point a Shift+click range is measured from — the last plain- or Cmd/Ctrl-clicked message.
  const [selectionAnchorId, setSelectionAnchorId] = useState<number | null>(null);
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
  const [searchQuery, setSearchQuery] = useState("");
  const {
    results: searchResults,
    loading: searchLoading,
    patchLocal: patchSearchResult,
    removeLocal: removeSearchResult,
  } = useSearchResults(searchQuery);
  const isSearching = searchQuery.trim().length > 0;

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

  const { emails, loading: emailsLoading, refresh: refreshEmails, patchLocal, removeLocal } = useEmails(
    selectedAccountEmail,
    selectedFolder
  );
  const { folders, loading: foldersLoading, error: foldersError, refresh: refreshFolders, patchCounts: patchFolderCounts } =
    useFolders(selectedAccountEmail);
  const { email: selectedEmail, setEmail: setSelectedEmailDetail } = useEmailDetail(selectedAccountEmail, selectedEmailId);

  // Mark-as-read on open, like every other mail client. Patches both the folder-scoped list
  // and the (separate) search results array, since a message can be open from either. Unlike
  // toggleRead (an explicit click), this doesn't roll back the optimistic local update on a
  // failed IMAP push — flipping the message back to unread right after the user just opened
  // and read it would be a confusing flicker. It does still surface the failure via toast.
  useEffect(() => {
    if (selectedEmail && !selectedEmail.isRead && selectedAccountEmail && token) {
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

  // Backspace/Delete deletes the open message (or the bulk selection, if there is one), same
  // as clicking the Delete button — skipped while typing anywhere (an input/textarea/editable
  // area, e.g. compose or search) or while a dialog that could itself need the key is open.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Backspace" && e.key !== "Delete") return;

      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (composeOpen || editingAccountEmail !== null || pendingDeleteAccount !== null || confirmDelete !== null) return;
      if (!(!isSearching && selectedIds.size > 0) && !selectedEmail) return;

      e.preventDefault();
      requestDelete();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function selectFolder(accountEmail: string, folder: string) {
    setSelectedAccountEmail(accountEmail);
    setSelectedFolder(folder);
    setSelectedEmailId(null);
    setSelectedIds(new Set());
    setSelectionAnchorId(null);
  }

  // Plain click reads the message as usual (and drops any bulk selection, like every
  // other mail client). Cmd/Ctrl+click toggles it in the bulk-action selection without
  // touching the reading pane, so you can build a selection while still reading. Shift+click
  // selects every message between the anchor (the last plain- or Cmd/Ctrl-clicked one) and
  // this one, replacing the current selection — the anchor itself doesn't move, so repeated
  // Shift+clicks grow/shrink the range from the same starting point.
  function selectEmail(email: EmailRecord, event: React.MouseEvent) {
    if (event.shiftKey) {
      const ids = emails.map(e => e.id);
      const anchorIndex = selectionAnchorId !== null ? ids.indexOf(selectionAnchorId) : -1;
      const targetIndex = ids.indexOf(email.id);

      if (anchorIndex === -1 || targetIndex === -1) {
        setSelectedIds(new Set([email.id]));
      } else {
        const [start, end] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
        setSelectedIds(new Set(ids.slice(start, end + 1)));
      }

      if (selectionAnchorId === null) setSelectionAnchorId(email.id);
      return;
    }

    if (event.metaKey || event.ctrlKey) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(email.id)) next.delete(email.id);
        else next.add(email.id);
        return next;
      });
      setSelectionAnchorId(email.id);
      return;
    }

    setSelectedIds(new Set());
    setSelectedEmailId(email.id);
    setSelectionAnchorId(email.id);
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

  function errorMessage(err: unknown, fallback: string): string {
    return err instanceof Error ? err.message : fallback;
  }

  // Flag/move/delete now push to the account's IMAP server (unless it's read-only), so these
  // calls can genuinely fail (bad connection, server rejects the write, ...) in a way they
  // couldn't when they only touched the local database. The optimistic local update is rolled
  // back on failure so the UI doesn't drift from what the server actually has.
  async function toggleFlag(email: EmailRecord) {
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

  async function toggleRead() {
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
    if (!token || !selectedAccountEmail || !selectedEmail) return;
    try {
      await api.moveEmail(token, selectedAccountEmail, selectedEmail.id, folder);
    } catch (err) {
      toast.error(errorMessage(err, "Failed to move message"));
      return;
    }
    removeLocal(selectedEmail.id);
    // Unlike the folder-scoped list, a moved message still matches the search — just with a
    // new folder — so it's patched in place rather than removed from the results.
    patchSearchResult(selectedEmail.id, { folder });
    patchFolderCounts(selectedEmail.folder, { total: -1, unread: selectedEmail.isRead ? 0 : -1 });
    patchFolderCounts(folder, { total: 1, unread: selectedEmail.isRead ? 0 : 1 });
    setSelectedEmailId(null);
    toast.success(`Moved to ${folder}`);
  }

  /**
   * Runs one bulk request for every selected message — a single shared IMAP connection
   * server-side (see runBulkAction in server/routes/emails.ts), instead of firing one request
   * per message — and reports how many of them actually succeeded.
   */
  async function runBulkAction(action: (ids: number[]) => Promise<BulkResult[]>, verb: string): Promise<BulkResult[]> {
    if (!token || !selectedAccountEmail) return [];
    const ids = [...selectedIds];
    setSelectedIds(new Set());

    let results: BulkResult[];
    try {
      results = await action(ids);
    } catch (err) {
      toast.error(errorMessage(err, `Failed to ${verb.toLowerCase()} message(s)`));
      return [];
    }

    const succeeded = results.filter(r => r.ok);
    const failed = results.length - succeeded.length;

    if (failed > 0) toast.error(`${verb} ${succeeded.length}/${results.length} message(s) — ${failed} failed`);
    else toast.success(`${verb} ${results.length} message(s)`);

    return succeeded;
  }

  async function bulkMarkRead(isRead: boolean) {
    if (!token || !selectedAccountEmail || !selectedFolder) return;
    const succeeded = await runBulkAction(
      ids => api.bulkUpdateEmails(token, selectedAccountEmail, ids, { isRead }),
      isRead ? "Marked as read" : "Marked as unread"
    );
    let unreadDelta = 0;
    succeeded.forEach(r => {
      const email = emails.find(e => e.id === r.id);
      if (email && email.isRead !== isRead) unreadDelta += isRead ? -1 : 1;
      patchLocal(r.id, { isRead });
    });
    if (unreadDelta !== 0) patchFolderCounts(selectedFolder, { unread: unreadDelta });
  }

  async function bulkDelete() {
    if (!token || !selectedAccountEmail || !selectedFolder) return;
    const succeeded = await runBulkAction(ids => api.bulkDeleteEmails(token, selectedAccountEmail, ids), "Deleted");
    let totalDelta = 0;
    let unreadDelta = 0;
    let trashTotal = 0;
    let trashUnread = 0;
    succeeded.forEach(r => {
      const email = emails.find(e => e.id === r.id);
      totalDelta -= 1;
      if (email && !email.isRead) unreadDelta -= 1;
      if (r.softDeleted) {
        trashTotal += 1;
        if (email && !email.isRead) trashUnread += 1;
      }
      removeLocal(r.id);
      if (selectedEmailId === r.id) setSelectedEmailId(null);
    });
    if (totalDelta !== 0 || unreadDelta !== 0) patchFolderCounts(selectedFolder, { total: totalDelta, unread: unreadDelta });
    if (trashTotal !== 0 || trashUnread !== 0) {
      patchFolderCounts(resolveSpecialFolder(folders, "\\Trash", "Trash"), { total: trashTotal, unread: trashUnread });
    }
  }

  async function bulkMove(folder: string) {
    if (!token || !selectedAccountEmail || !selectedFolder) return;
    const succeeded = await runBulkAction(
      ids => api.bulkMoveEmails(token, selectedAccountEmail, ids, folder),
      `Moved to ${folder} —`
    );
    let totalDelta = 0;
    let unreadDelta = 0;
    succeeded.forEach(r => {
      const email = emails.find(e => e.id === r.id);
      totalDelta -= 1;
      if (email && !email.isRead) unreadDelta -= 1;
      removeLocal(r.id);
      if (selectedEmailId === r.id) setSelectedEmailId(null);
    });
    if (totalDelta !== 0 || unreadDelta !== 0) {
      patchFolderCounts(selectedFolder, { total: totalDelta, unread: unreadDelta });
      patchFolderCounts(folder, { total: -totalDelta, unread: -unreadDelta });
    }
  }

  /**
   * Entry point for every "delete" trigger (the reading pane's Delete button, the bulk action
   * bar's Delete button, and the Backspace/Delete keyboard shortcut): deletes right away when
   * every message involved would only be soft-deleted (moved to Trash, easily undone), and
   * otherwise asks for confirmation first since that outcome is permanent. Bulk and single are
   * mutually exclusive by construction — selecting one clears the other (see selectEmail).
   */
  function requestDelete() {
    if (!isSearching && selectedIds.size > 0) {
      const selectedEmails = emails.filter(e => selectedIds.has(e.id));
      if (selectedEmails.length === 0) return;
      if (selectedEmails.every(e => willSoftDelete(selectedAccount, e, folders))) bulkDelete();
      else setConfirmDelete({ mode: "bulk", count: selectedEmails.length });
      return;
    }
    if (selectedEmail) {
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
          <span className="text-sm text-muted-foreground">{username}</span>
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
                selected={selected}
                onSelectFolder={selectFolder}
                onDeleteAccount={setPendingDeleteAccount}
                onEditAccount={setEditingAccountEmail}
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
          {!isSearching && selectedIds.size > 0 ? (
            <BulkActionBar
              count={selectedIds.size}
              folders={folders.filter(f => f.path !== selectedFolder)}
              onMarkRead={() => bulkMarkRead(true)}
              onMarkUnread={() => bulkMarkRead(false)}
              onMove={bulkMove}
              onDelete={requestDelete}
              onClear={() => setSelectedIds(new Set())}
            />
          ) : (
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="truncate text-sm font-medium">
                {isSearching ? `Search: "${searchQuery.trim()}"` : selectedFolder ?? "—"}
              </span>
              <Button size="sm" disabled={!selectedAccountEmail} onClick={() => openCompose(null)}>
                <PenSquare className="size-4" /> New
              </Button>
            </div>
          )}
          <div className="min-h-0 flex-1">
            {isSearching ? (
              <SearchResultList
                results={searchResults}
                loading={searchLoading}
                selectedId={selectedEmailId}
                onSelect={selectSearchResult}
              />
            ) : selectedAccountEmail && selectedFolder ? (
              <MessageList
                emails={emails}
                loading={emailsLoading}
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
              onViewChange={setPreferredBodyView}
              onReply={() => openCompose(replyDraft(selectedEmail))}
              onForward={() => openCompose(forwardDraft(selectedEmail))}
              onDelete={requestDelete}
              onMove={handleMove}
              onToggleRead={toggleRead}
              onEditDraft={() => openCompose(editDraft(selectedEmail))}
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
          onSent={() => {
            refreshEmails();
            refreshFolders();
            toast.success("Saved");
          }}
        />
      )}

      <EditAccountDialog
        account={accounts.find(a => a.email === editingAccountEmail) ?? null}
        open={editingAccountEmail !== null}
        onOpenChange={open => !open && setEditingAccountEmail(null)}
        onSaved={refreshAccounts}
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
