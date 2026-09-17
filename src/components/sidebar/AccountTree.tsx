import { Loader2 } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AccountRow } from "./AccountRow";
import { AddAccountDialog } from "./AddAccountDialog";
import type { Account } from "../../server/types";

export function AccountTree({
  accounts,
  loading,
  refreshAccounts,
  selected,
  onSelectFolder,
  onDeleteAccount,
}: {
  accounts: Account[];
  loading: boolean;
  refreshAccounts: () => void;
  selected: { accountEmail: string; folder: string } | null;
  onSelectFolder: (accountEmail: string, folder: string) => void;
  onDeleteAccount: (accountEmail: string) => void;
}) {
  return (
    <div className="flex h-full flex-col border-r bg-muted/20">
      <div className="flex items-center gap-2 px-3 py-3">
        <span className="text-sm font-semibold">Accounts</span>
      </div>

      <ScrollArea className="flex-1 px-2">
        {loading && (
          <div className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        )}
        <div className="space-y-1 pb-2">
          {accounts.map(account => (
            <AccountRow
              key={account.id}
              account={account}
              selected={selected}
              onSelectFolder={onSelectFolder}
              onDeleteAccount={onDeleteAccount}
            />
          ))}
        </div>
      </ScrollArea>

      <div className="border-t p-2">
        <AddAccountDialog onCreated={refreshAccounts} />
      </div>
    </div>
  );
}
