import type { ButtonHTMLAttributes, Ref } from "react";
import { cn } from "./cn";

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  ref?: Ref<HTMLButtonElement>;
}

export function Switch({
  checked,
  onCheckedChange,
  onClick,
  className,
  disabled,
  ref,
  ...rest
}: SwitchProps) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={cn("qj-switch", className)}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented && !disabled) {
          onCheckedChange?.(!checked);
        }
      }}
      {...rest}
    >
      <span className="qj-switch-thumb" aria-hidden="true" />
    </button>
  );
}
