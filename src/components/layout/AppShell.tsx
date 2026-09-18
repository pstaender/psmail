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
import { api, type BulkResult } from "@/lib/api";
import { forwardDraft, replyDraft } from "@/lib/compose";
import type { EmailRecord } from "../../server/types";
import type { SearchResult } from "../../server/models/search";

export function AppShell() {
  const { token, username, logout } = useAuth();
  const { accounts, loading: accountsLoading, refresh: refreshAccounts } = useAccounts();

  const [selectedAccountEmail, setSelectedAccountEmail] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [selectedEmailId, setSelectedEmailId] = useState<number | null>(null);
  // Checked via Cmd/Ctrl+click, for bulk actions — independent of selectedEmailId (the reading pane).
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  // The reference point a Shift+click range is measured from — the last plain- or Cmd/Ctrl-clicked message.
  const [selectionAnchorId, setSelectionAnchorId] = useState<number | null>(null);
  const [pendingDeleteAccount, setPendingDeleteAccount] = useState<string | null>(null);
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
  const { folders, refresh: refreshFolders } = useFolders(selectedAccountEmail);
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
      setSelectedEmailDetail({ ...selectedEmail, isRead: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEmail?.id]);

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
    setSelectedEmailDetail({ ...selectedEmail, isRead });
    try {
      await api.updateEmail(token, selectedAccountEmail, selectedEmail.id, { isRead });
    } catch (err) {
      patchLocal(selectedEmail.id, { isRead: previousIsRead });
      patchSearchResult(selectedEmail.id, { isRead: previousIsRead });
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
    if (!token || !selectedAccountEmail) return;
    const succeeded = await runBulkAction(
      ids => api.bulkUpdateEmails(token, selectedAccountEmail, ids, { isRead }),
      isRead ? "Marked as read" : "Marked as unread"
    );
    succeeded.forEach(r => patchLocal(r.id, { isRead }));
  }

  async function bulkDelete() {
    if (!token || !selectedAccountEmail) return;
    const succeeded = await runBulkAction(ids => api.bulkDeleteEmails(token, selectedAccountEmail, ids), "Deleted");
    succeeded.forEach(r => {
      removeLocal(r.id);
      if (selectedEmailId === r.id) setSelectedEmailId(null);
    });
  }

  async function bulkMove(folder: string) {
    if (!token || !selectedAccountEmail) return;
    const succeeded = await runBulkAction(
      ids => api.bulkMoveEmails(token, selectedAccountEmail, ids, folder),
      `Moved to ${folder} —`
    );
    succeeded.forEach(r => {
      removeLocal(r.id);
      if (selectedEmailId === r.id) setSelectedEmailId(null);
    });
  }

  function openCompose(initial: ComposeDraft | null) {
    setComposeInitial(initial);
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
              onDelete={bulkDelete}
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
              onDelete={handleDelete}
              onMove={handleMove}
              onToggleRead={toggleRead}
            />
          ) : (
            <EmptyState title="Select a message" description="Choose a message from the list to read it here." />
          )}
        </div>
      </div>

      {selectedAccountEmail && (
        <ComposeDialog
          accountEmail={selectedAccountEmail}
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
    </div>
  );
}
