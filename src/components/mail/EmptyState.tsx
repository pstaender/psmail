import { Inbox, type LucideIcon } from "lucide-react";

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
      <Icon className="size-8 opacity-50" />
      <p className="font-medium">{title}</p>
      {description && <p className="text-sm">{description}</p>}
    </div>
  );
}
