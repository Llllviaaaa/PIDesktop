import type { KeyboardEvent, ReactNode } from "react";
import { IconChevronDown, IconChevronUp } from "./DshIcons";

/*
 * Ports of DeepSeek Harness' `TextShimmer` and `DisclosureRow` primitives
 * (dsh-client-ui-primitives, MIT): the shared header every transcript flow row
 * (reasoning, tool call) is built from, with the host's running sweep.
 */

function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}

/**
 * Text with the host's running sweep: a masked copy in the shimmer tint slides
 * across the real content, so the base colors stay on the readable text.
 */
export function TextShimmer({
  active = false,
  className,
  contentClassName,
  children,
}: {
  active?: boolean;
  className?: string;
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <span className={cx("dshc-shimmer", className)} data-shimmer={active || undefined}>
      <span className={cx("dshc-shimmer-content", contentClassName)}>{children}</span>
      {active && (
        <span className="dshc-shimmer-decoration" aria-hidden="true" inert>
          <span className="dshc-shimmer-sweep">
            <span className={cx("dshc-shimmer-content", "dshc-shimmer-highlight", contentClassName)}>{children}</span>
          </span>
        </span>
      )}
    </span>
  );
}

/**
 * One disclosure header: [16px leading glyph] 6px [title 13/24] [collapsed
 * summary], with the idle glyph swapping to a chevron under the pointer and an
 * up-chevron while open. The whole row is the toggle when it can expand.
 */
export function DisclosureRow({
  icon,
  title,
  open,
  expandable,
  onToggle,
  running = false,
  keepContentWhenOpen = false,
  collapsedContent,
  children,
  className,
  rowClassName,
  titleClassName,
  rowTitle,
  onRowContextMenu,
}: {
  icon: ReactNode;
  title: ReactNode;
  open: boolean;
  expandable: boolean;
  onToggle: () => void;
  running?: boolean;
  keepContentWhenOpen?: boolean;
  collapsedContent?: ReactNode;
  children?: ReactNode;
  className?: string;
  rowClassName?: string;
  titleClassName?: string;
  rowTitle?: string;
  onRowContextMenu?: (event: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const leading = open
    ? <IconChevronUp className="dshc-chevron" />
    : expandable
      ? (
        <>
          <span className="dshc-icon-idle">{icon}</span>
          <IconChevronDown className="dshc-chevron dshc-chevron-hover" />
        </>
      )
      : icon;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!expandable || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onToggle();
  };
  return (
    <div className={cx("dshc-disclosure", className)} data-open={open || undefined}>
      <div
        className={cx("dshc-row", rowClassName)}
        data-disclosure-row=""
        data-expandable={expandable || undefined}
        role={expandable ? "button" : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        title={rowTitle}
        onClick={expandable ? onToggle : undefined}
        onKeyDown={expandable ? onKeyDown : undefined}
        onContextMenu={onRowContextMenu}
      >
        <span className="dshc-leading">{leading}</span>
        <TextShimmer active={running} className="dshc-row-shimmer" contentClassName="dshc-row-content">
          <span className={cx("dshc-title", titleClassName)}>{title}</span>
          {(keepContentWhenOpen || !open) && collapsedContent}
        </TextShimmer>
      </div>
      {open && children}
    </div>
  );
}
