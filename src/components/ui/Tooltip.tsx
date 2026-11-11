import { useId, useState, type ReactNode } from "react";
import { cn } from "./cn";

export interface TooltipProps {
  content: ReactNode;
  side?: "top" | "bottom";
  children: ReactNode;
  className?: string;
}

export function Tooltip({ content, side = "top", children, className }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();

  if (content === null || content === undefined || content === "") {
    return <>{children}</>;
  }

  return (
    <span
      className={cn("qj-tooltip-wrap", className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      aria-describedby={open ? tooltipId : undefined}
    >
      {children}
      {open && (
        <span
          id={tooltipId}
          role="tooltip"
          className={cn("qj-tooltip-bubble", side === "bottom" && "qj-tooltip-bubble--bottom")}
        >
          {content}
        </span>
      )}
    </span>
  );
}
