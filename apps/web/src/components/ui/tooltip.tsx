import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ComponentProps, ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { cn } from "../../lib/utils";

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({ children, ...props }: ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root {...props}>{children}</TooltipPrimitive.Root>;
}

export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({ className, sideOffset = 7, ...props }: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content className={cn("uiTooltipContent", className)} sideOffset={sideOffset} {...props} />
    </TooltipPrimitive.Portal>
  );
}

export function InfoTooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button className="infoTooltipTrigger" type="button" aria-label={label}>
          <CircleHelp size={14} aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  );
}
