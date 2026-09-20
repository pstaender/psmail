import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type FolderInfo } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";

const TOP_LEVEL = "";

/** Asks for a name (and optionally a parent) and creates the folder on the account's IMAP server. */
export function NewFolderDialog({
  accountEmail,
  folders,
  open,
  onOpenChange,
  onCreated,
}: {
  accountEmail: string;
  folders: FolderInfo[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Gets the server's folder list after the creation, and the new folder's path. */
  onCreated: (folders: FolderInfo[], path: string) => void;
}) {
  const { token } = useAuth();
  const [name, setName] = useState("");
  const [parent, setParent] = useState(TOP_LEVEL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setParent(TOP_LEVEL);
    setError(null);
  }, [open]);

  // A folder the server marked \Noinferiors can't have subfolders, so it isn't offered as a parent.
  const parents = folders.filter(f => !f.flags.includes("\\Noinferiors"));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.createFolder(token, accountEmail, name, parent === TOP_LEVEL ? null : parent);
      onCreated(result.folders, result.path);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>Creates the folder on the mail server of {accountEmail}, so every mail client sees it.</DialogDescription>
          </DialogHeader>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="space-y-1.5">
            <Label htmlFor="new-folder-name">Name</Label>
            <Input id="new-folder-name" autoFocus value={name} onChange={e => setName(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-folder-parent">Inside</Label>
            <select
              id="new-folder-parent"
              value={parent}
              onChange={e => setParent(e.target.value)}
              className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
            >
              <option value={TOP_LEVEL}>Top level</option>
              {parents.map(f => (
                <option key={f.path} value={f.path}>
                  {f.path.toUpperCase() === "INBOX" ? "Inbox" : f.path}
                </option>
              ))}
            </select>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || name.trim() === ""}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Create folder
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
