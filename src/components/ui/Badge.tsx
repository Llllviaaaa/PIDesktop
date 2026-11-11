import type { HTMLAttributes, Ref } from "react";
import { cn } from "./cn";

export type BadgeVariant = "neutral" | "brand" | "success" | "warning" | "danger";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  ref?: Ref<HTMLSpanElement>;
}

export function Badge({
  variant = "neutral",
  className,
  children,
  ref,
  ...rest
}: BadgeProps) {
  return (
    <span
      ref={ref}
      className={cn(
        "qj-badge",
        variant !== "neutral" && `qj-badge--${variant}`,
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
