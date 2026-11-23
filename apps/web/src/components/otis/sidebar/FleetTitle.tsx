import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

export function FleetTitle({ title, detail }: { title: string; detail?: string | null }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="block min-w-0 truncate" />}>{title}</TooltipTrigger>
      <TooltipPopup>
        {title}
        {detail && <div>{detail}</div>}
      </TooltipPopup>
    </Tooltip>
  );
}
