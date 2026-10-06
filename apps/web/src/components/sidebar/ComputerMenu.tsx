import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon, ServerIcon } from "lucide-react";
import type { EnvironmentPresentation } from "../../state/environments";
import { ALL_ENVIRONMENTS_CHAT_LOCATION_SCOPE } from "../../uiStateStore";
import { ComputerIdentityBadge } from "../ComputerBadge";
import { Menu, MenuTrigger, MenuPopup, MenuRadioGroup, MenuRadioItem } from "../ui/menu";
import { SidebarMenuButton } from "../ui/sidebar";

export function ComputerMenu({
  environments,
  selectedEnvironmentId,
  onSelect,
}: {
  environments: ReadonlyArray<Pick<EnvironmentPresentation, "environmentId" | "label" | "color">>;
  selectedEnvironmentId: EnvironmentId | null;
  onSelect: (value: string) => void;
}) {
  const selected = environments.find(
    (environment) => environment.environmentId === selectedEnvironmentId,
  );
  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarMenuButton
            aria-label="Browse computers"
            className="min-w-0 w-full bg-sidebar-row-hover ps-[calc(var(--sidebar-row-content-inset)-1px)] focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
          />
        }
      >
        {selected ? (
          <ComputerIdentityBadge
            name={selected.label}
            color={selected.color}
            className="min-w-0 flex-1 text-sm text-sidebar-foreground"
          />
        ) : (
          <>
            <ServerIcon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">All computers</span>
          </>
        )}
        <ChevronDownIcon className="size-4 shrink-0" />
      </MenuTrigger>
      <MenuPopup align="start" className="w-(--anchor-width)">
        <MenuRadioGroup
          value={selectedEnvironmentId ?? ALL_ENVIRONMENTS_CHAT_LOCATION_SCOPE}
          onValueChange={onSelect}
        >
          {environments.map((environment) => (
            <MenuRadioItem
              key={environment.environmentId}
              value={environment.environmentId}
              closeOnClick
            >
              <ComputerIdentityBadge
                name={environment.label}
                color={environment.color}
                className="text-sm text-foreground"
              />
            </MenuRadioItem>
          ))}
          <MenuRadioItem value={ALL_ENVIRONMENTS_CHAT_LOCATION_SCOPE} closeOnClick>
            <ServerIcon className="size-4 shrink-0" />
            <span>All computers</span>
          </MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
