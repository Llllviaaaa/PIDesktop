import type { Ref, SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "./cn";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange"> {
  options?: readonly SelectOption[];
  onValueChange?: (value: string) => void;
  onChange?: SelectHTMLAttributes<HTMLSelectElement>["onChange"];
  wrapperClassName?: string;
  ref?: Ref<HTMLSelectElement>;
}

export function Select({
  options,
  onValueChange,
  onChange,
  className,
  wrapperClassName,
  children,
  ref,
  ...rest
}: SelectProps) {
  return (
    <div className={cn("qj-select-wrap", wrapperClassName)}>
      <select
        ref={ref}
        className={cn("qj-select", className)}
        onChange={(event) => {
          onChange?.(event);
          onValueChange?.(event.target.value);
        }}
        {...rest}
      >
        {options
          ? options.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
              </option>
            ))
          : children}
      </select>
      <ChevronDown size={14} className="qj-select-chevron" aria-hidden="true" />
    </div>
  );
}
