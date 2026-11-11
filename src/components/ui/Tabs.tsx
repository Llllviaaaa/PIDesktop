import {
  createContext,
  useContext,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "./cn";

interface TabsContextValue {
  value: string;
  onValueChange: (next: string) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

export interface TabsProps extends HTMLAttributes<HTMLDivElement> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  children: ReactNode;
}

export function Tabs({
  value: controlledValue,
  defaultValue = "",
  onValueChange,
  className,
  children,
  ...rest
}: TabsProps) {
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue);
  const currentValue = controlledValue !== undefined ? controlledValue : uncontrolledValue;

  const handleChange = (next: string) => {
    if (controlledValue === undefined) {
      setUncontrolledValue(next);
    }
    onValueChange?.(next);
  };

  return (
    <TabsContext.Provider value={{ value: currentValue, onValueChange: handleChange }}>
      <div className={className} {...rest}>
        {children}
      </div>
    </TabsContext.Provider>
  );
}

export function TabsList({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div role="tablist" className={cn("qj-tabs-list", className)} {...rest}>
      {children}
    </div>
  );
}

export interface TabsTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

export function TabsTrigger({ value, className, children, onClick, ...rest }: TabsTriggerProps) {
  const ctx = useContext(TabsContext);
  const selected = ctx?.value === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      className={cn("qj-tabs-trigger", className)}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          ctx?.onValueChange(value);
        }
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

export interface TabsContentProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
}

export function TabsContent({ value, className, children, ...rest }: TabsContentProps) {
  const ctx = useContext(TabsContext);
  if (ctx?.value !== value) return null;
  return (
    <div role="tabpanel" className={className} {...rest}>
      {children}
    </div>
  );
}
