import { ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { AiSkillRecord } from "../../server/models/ai";

/**
 * A button that runs an AI skill of one category. With a single skill, clicking it runs that skill; with several,
 * clicking opens a menu with one entry per skill — labelled with the skill's name — to choose
 * from. Renders nothing without a skill: no skill, no button.
 */
export function AiSkillButton({
  skills = [],
  busy,
  icon,
  label,
  title,
  variant = "ghost",
  disabled = false,
  onRun,
}: {
  skills?: AiSkillRecord[];
  busy: boolean;
  icon: React.ReactNode;
  label: string;
  title?: string;
  variant?: "ghost" | "outline";
  disabled?: boolean;
  onRun: (skillId: number) => void;
}) {
  if (skills.length === 0) return null;

  const button = (
    <Button variant={variant} size="sm" disabled={busy || disabled} title={title} onClick={skills.length === 1 ? () => onRun(skills[0]!.id) : undefined}>
      {busy ? <Loader2 className="size-4 animate-spin" /> : icon} {label}
      {skills.length > 1 && <ChevronDown className="size-3" />}
    </Button>
  );
  if (skills.length === 1) return button;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {skills.map(skill => (
          <DropdownMenuItem key={skill.id} onSelect={() => onRun(skill.id)}>
            {skill.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
