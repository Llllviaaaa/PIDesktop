import type { InputHTMLAttributes, Ref } from "react";
import { cn } from "./cn";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement>;
}

export function Input({ className, ref, ...rest }: InputProps) {
  return <input ref={ref} className={cn("qj-input", className)} {...rest} />;
}
