import type { ButtonHTMLAttributes, Ref } from "react";
import { cn } from "./cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = "secondary",
  size = "md",
  type = "button",
  className,
  children,
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn("qj-btn", `qj-btn--${variant}`, `qj-btn--${size}`, className)}
      {...rest}
    >
      {children}
    </button>
  );
}
