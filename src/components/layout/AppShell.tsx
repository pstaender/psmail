import { useEffect, useMemo, useState } from "react";
import { LogOut, Mail, PenSquare, Search, X } from "lucide-react";
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
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/lib/api";
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
  const [pendingDeleteAccount, setPendingDeleteAccount] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeInitial, setComposeInitial] = useState<ComposeDraft | null>(null);
  // Remembered across messages (and folder/account switches) so the next message
  // opened reuses whatever body view the user was last reading with.
  const [preferredBodyView, setPreferredBodyView] = useState<BodyView | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const { results: searchResults, loading: searchLoading } = useSearchResults(searchQuery);
  const isSearching = searchQuery.trim().length > 0;

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

  // Mark-as-read on open, like every other mail client.
  useEffect(() => {
    if (selectedEmail && !selectedEmail.isRead && selectedAccountEmail && token) {
      api.updateEmail(token, selectedAccountEmail, selectedEmail.id, { isRead: true }).catch(() => {});
      patchLocal(selectedEmail.id, { isRead: true });
      setSelectedEmailDetail({ ...selectedEmail, isRead: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEmail?.id]);

  function selectFolder(accountEmail: string, folder: string) {
    setSelectedAccountEmail(accountEmail);
    setSelectedFolder(folder);
    setSelectedEmailId(null);
    setSelectedIds(new Set());
  }

  // Plain click reads the message as usual (and drops any bulk selection, like every
  // other mail client). Cmd/Ctrl+click instead toggles it in the bulk-action selection
  // without touching the reading pane, so you can build a selection while still reading.
  function selectEmail(email: EmailRecord, event: React.MouseEvent) {
    if (event.metaKey || event.ctrlKey) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(email.id)) next.delete(email.id);
        else next.add(email.id);
        return next;
      });
      return;
    }
    setSelectedIds(new Set());
    setSelectedEmailId(email.id);
  }

  // A search result can belong to a different account/folder than the one currently
  // selected in the sidebar; opening one switches the reading pane to that context
  // without clearing the search itself, so the result list stays browsable.
  function selectSearchResult(result: SearchResult) {
    setSelectedAccountEmail(result.accountEmail);
    setSelectedFolder(result.folder);
    setSelectedEmailId(result.id);
    setSelectedIds(new Set());
  }

  async function toggleFlag(email: EmailRecord) {
    if (!token || !selectedAccountEmail) return;
    const isFlagged = !email.isFlagged;
    patchLocal(email.id, { isFlagged });
    await api.updateEmail(token, selectedAccountEmail, email.id, { isFlagged });
  }

  async function toggleRead() {
    if (!token || !selectedAccountEmail || !selectedEmail) return;
    const isRead = !selectedEmail.isRead;
    patchLocal(selectedEmail.id, { isRead });
    setSelectedEmailDetail({ ...selectedEmail, isRead });
    await api.updateEmail(token, selectedAccountEmail, selectedEmail.id, { isRead });
  }

  async function handleDelete() {
    if (!token || !selectedAccountEmail || !selectedEmail) return;
    await api.deleteEmail(token, selectedAccountEmail, selectedEmail.id);
    removeLocal(selectedEmail.id);
    setSelectedEmailId(null);
    toast.success("Message deleted");
  }

  async function handleMove(folder: string) {
    if (!token || !selectedAccountEmail || !selectedEmail) return;
    await api.moveEmail(token, selectedAccountEmail, selectedEmail.id, folder);
    removeLocal(selectedEmail.id);
    setSelectedEmailId(null);
    toast.success(`Moved to ${folder}`);
  }

  /** Runs one API call per selected message and reports how many of them actually succeeded. */
  async function runBulkAction(action: (id: number) => Promise<unknown>, verb: string): Promise<number[]> {
    if (!token || !selectedAccountEmail) return [];
    const ids = [...selectedIds];
    const outcomes = await Promise.allSettled(ids.map(action));
    const succeeded = ids.filter((_, i) => outcomes[i]!.status === "fulfilled");
    const failed = ids.length - succeeded.length;

    if (failed > 0) toast.error(`${verb} ${succeeded.length}/${ids.length} message(s) — ${failed} failed`);
    else toast.success(`${verb} ${ids.length} message(s)`);

    setSelectedIds(new Set());
    return succeeded;
  }

  async function bulkMarkRead(isRead: boolean) {
    if (!token || !selectedAccountEmail) return;
    const succeeded = await runBulkAction(
      id => api.updateEmail(token, selectedAccountEmail, id, { isRead }),
      isRead ? "Marked as read" : "Marked as unread"
    );
    succeeded.forEach(id => patchLocal(id, { isRead }));
  }

  async function bulkDelete() {
    if (!token || !selectedAccountEmail) return;
    const succeeded = await runBulkAction(id => api.deleteEmail(token, selectedAccountEmail, id), "Deleted");
    succeeded.forEach(id => {
      removeLocal(id);
      if (selectedEmailId === id) setSelectedEmailId(null);
    });
  }

  async function bulkMove(folder: string) {
    if (!token || !selectedAccountEmail) return;
    const succeeded = await runBulkAction(id => api.moveEmail(token, selectedAccountEmail, id, folder), `Moved to ${folder} —`);
    succeeded.forEach(id => {
      removeLocal(id);
      if (selectedEmailId === id) setSelectedEmailId(null);
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
            placeholder='Search all mail… e.g. from:you@x.com amazon*sale "mountain bike"'
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
        <div className="w-60 shrink-0">
          <AccountTree
            accounts={accounts}
            loading={accountsLoading}
            refreshAccounts={refreshAccounts}
            selected={selected}
            onSelectFolder={selectFolder}
            onDeleteAccount={setPendingDeleteAccount}
          />
        </div>

        <div className="flex w-80 shrink-0 flex-col border-r">
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
