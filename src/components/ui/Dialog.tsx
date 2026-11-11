import { useEffect, useId, type HTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "./cn";
import { Button } from "./Button";

export interface DialogProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  hideCloseButton?: boolean;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  footer,
  children,
  className,
  hideCloseButton = false,
}: DialogProps) {
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onOpenChange?.(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  if (!open) return null;

  const content = (
    <div
      className="qj-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onOpenChange?.(false);
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descId : undefined}
        className={cn("qj-dialog-panel", className)}
      >
        {(title || description || !hideCloseButton) && (
          <div className="qj-dialog-header">
            <div>
              {title && (
                <h2 id={titleId} className="qj-dialog-title">
                  {title}
                </h2>
              )}
              {description && (
                <p id={descId} className="qj-dialog-description">
                  {description}
                </p>
              )}
            </div>
            {!hideCloseButton && (
              <Button
                variant="ghost"
                size="icon"
                aria-label="关闭对话框"
                onClick={() => onOpenChange?.(false)}
              >
                <X size={15} />
              </Button>
            )}
          </div>
        )}
        <div className="qj-dialog-body">{children}</div>
        {footer && <div className="qj-dialog-footer">{footer}</div>}
      </div>
    </div>
  );

  if (typeof document !== "undefined" && document.body) {
    return createPortal(content, document.body);
  }
  return content;
}

export function DialogSection({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-3", className)} {...rest} />;
}
