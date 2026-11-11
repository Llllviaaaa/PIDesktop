import {
  Component,
  useCallback,
  useSyncExternalStore,
  type CSSProperties,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { AlertTriangle, PowerOff, RotateCw } from "lucide-react";
import type { WorkbenchSlotContext } from "../../lib/clientContributions";
import {
  clearClientRenderError,
  getClientPluginRuntimeMetaSnapshot,
  getClientSlotLockout,
  recordClientRenderError,
  subscribeClientPluginErrors,
} from "../../lib/clientPluginRuntime";
import { reportFrontendError } from "../../lib/crashLogger";
import { pluginClient } from "../../lib/pluginClient";

export interface SlotRenderableEntry<C = WorkbenchSlotContext> {
  id: string;
  pluginId?: string;
  render: (context: C) => ReactNode;
}

export interface SlotEntryHostProps<C = WorkbenchSlotContext> {
  entry: SlotRenderableEntry<C>;
  context: C;
  slotName: string;
  compact?: boolean;
  className?: string;
  style?: CSSProperties;
}

function SlotRenderBody<C>({
  render,
  context,
}: {
  render: (context: C) => ReactNode;
  context: C;
}): ReactNode {
  return render(context);
}

interface SlotCrashFallbackProps {
  pluginId?: string;
  entryId: string;
  slotName: string;
  message: string;
  compact?: boolean;
  onRetryLocal?: () => void;
}

function SlotCrashFallback({
  pluginId,
  entryId,
  slotName,
  message,
  compact = false,
  onRetryLocal,
}: SlotCrashFallbackProps) {
  const handleReload = useCallback(() => {
    if (pluginId !== undefined && pluginId !== "") {
      clearClientRenderError(pluginId, true);
      void pluginClient.reload({ id: pluginId }).catch((error: unknown) => {
        console.error(`[qianji-slot-boundary] failed to reload plugin "${pluginId}":`, error);
      });
    }
    onRetryLocal?.();
  }, [pluginId, onRetryLocal]);

  const handleDisable = useCallback(() => {
    if (pluginId === undefined || pluginId === "") return;
    clearClientRenderError(pluginId, false);
    void pluginClient.disable({ id: pluginId }).catch((error: unknown) => {
      console.error(`[qianji-slot-boundary] failed to disable plugin "${pluginId}":`, error);
    });
  }, [pluginId]);

  const label = pluginId ?? entryId;
  const isOverlay = slotName === "overlays";

  if (compact || isOverlay) {
    return (
      <div
        role="alert"
        data-testid={`plugin-slot-fallback-${entryId}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          padding: "2px 8px",
          borderRadius: "6px",
          fontSize: "12px",
          lineHeight: 1.4,
          background: "var(--qj-status-danger-bg, rgba(239, 68, 68, 0.12))",
          color: "var(--qj-status-danger, #dc2626)",
          border: "1px solid var(--qj-status-danger-border, rgba(239, 68, 68, 0.28))",
          pointerEvents: "auto",
          ...(isOverlay
            ? {
                position: "fixed",
                right: "16px",
                bottom: "16px",
                zIndex: 9999,
                boxShadow: "0 4px 12px rgba(0,0,0,0.16)",
              }
            : {}),
        }}
        title={`${label}: ${message}`}
      >
        <AlertTriangle size={12} aria-hidden="true" />
        <span style={{ maxWidth: "160px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          插件异常 ({label})
        </span>
        <button
          type="button"
          onClick={handleReload}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "3px",
            padding: "1px 6px",
            borderRadius: "4px",
            border: "1px solid currentColor",
            background: "transparent",
            color: "inherit",
            fontSize: "11px",
            cursor: "pointer",
          }}
        >
          <RotateCw size={10} aria-hidden="true" />
          重载插件
        </button>
        {pluginId !== undefined && pluginId !== "" && (
          <button
            type="button"
            onClick={handleDisable}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "3px",
              padding: "1px 6px",
              borderRadius: "4px",
              border: "1px solid currentColor",
              background: "transparent",
              color: "inherit",
              fontSize: "11px",
              cursor: "pointer",
            }}
          >
            <PowerOff size={10} aria-hidden="true" />
            停用插件
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      role="alert"
      data-testid={`plugin-slot-fallback-${entryId}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        padding: "12px 14px",
        margin: "8px",
        borderRadius: "10px",
        background: "var(--qj-status-danger-bg, rgba(239, 68, 68, 0.08))",
        color: "var(--qj-text-primary, inherit)",
        border: "1px solid var(--qj-status-danger-border, rgba(239, 68, 68, 0.28))",
        fontSize: "13px",
        pointerEvents: "auto",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: 600, color: "var(--qj-status-danger, #dc2626)" }}>
        <AlertTriangle size={15} aria-hidden="true" />
        <span>插件扩展槽位已隔离 ({label})</span>
      </div>
      <div
        style={{
          fontSize: "12px",
          color: "var(--qj-text-secondary, rgba(127, 127, 127, 0.95))",
          wordBreak: "break-word",
          fontFamily: "var(--font-mono, monospace)",
        }}
      >
        {message}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={handleReload}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            padding: "4px 10px",
            borderRadius: "6px",
            border: "1px solid var(--qj-border-default, rgba(127, 127, 127, 0.35))",
            background: "var(--qj-bg-elevated, rgba(255, 255, 255, 0.08))",
            color: "inherit",
            fontSize: "12px",
            cursor: "pointer",
          }}
        >
          <RotateCw size={12} aria-hidden="true" />
          重载插件
        </button>
        {pluginId !== undefined && pluginId !== "" && (
          <button
            type="button"
            onClick={handleDisable}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              padding: "4px 10px",
              borderRadius: "6px",
              border: "1px solid var(--qj-status-danger-border, rgba(239, 68, 68, 0.38))",
              background: "transparent",
              color: "var(--qj-status-danger, #dc2626)",
              fontSize: "12px",
              cursor: "pointer",
            }}
          >
            <PowerOff size={12} aria-hidden="true" />
            停用插件
          </button>
        )}
      </div>
    </div>
  );
}

interface SlotErrorBoundaryProps {
  pluginId?: string;
  entryId: string;
  slotName: string;
  slotKey: string;
  compact?: boolean;
  children: ReactNode;
}

interface SlotErrorBoundaryState {
  error: Error | null;
}

export class SlotErrorBoundary extends Component<SlotErrorBoundaryProps, SlotErrorBoundaryState> {
  override state: SlotErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): SlotErrorBoundaryState {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const { pluginId, slotKey, entryId } = this.props;
    recordClientRenderError(pluginId, slotKey, error);
    void reportFrontendError(`plugin-slot:${pluginId ?? entryId}:${slotKey}`, error, {
      extraStack: info.componentStack ?? undefined,
      level: "warn",
    });
  }

  private handleLocalReset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <SlotCrashFallback
          pluginId={this.props.pluginId}
          entryId={this.props.entryId}
          slotName={this.props.slotName}
          message={this.state.error.message || "插件渲染异常"}
          compact={this.props.compact}
          onRetryLocal={this.handleLocalReset}
        />
      );
    }
    return this.props.children;
  }
}

/**
 * Isolated Fiber + CSS `@scope` + circuit-breaker host for a single plugin contribution entry.
 * Evaluates `entry.render(context)` strictly inside `<SlotRenderBody>` beneath `<SlotErrorBoundary>`
 * so synchronous throws and dynamic React Hooks never leak into the parent host component.
 */
export function SlotEntryHost<C = WorkbenchSlotContext>({
  entry,
  context,
  slotName,
  compact = false,
  className,
  style,
}: SlotEntryHostProps<C>) {
  const pluginId = entry.pluginId;
  const slotKey = `${slotName}:${entry.id}`;

  const metaSnapshot = useSyncExternalStore(
    subscribeClientPluginErrors,
    getClientPluginRuntimeMetaSnapshot,
    getClientPluginRuntimeMetaSnapshot,
  );
  const getLockoutSnapshot = () => {
    const state = getClientSlotLockout(pluginId, slotKey);
    return state.locked ? `locked:${state.message ?? ""}` : "";
  };
  const lockout = useSyncExternalStore(
    subscribeClientPluginErrors,
    getLockoutSnapshot,
    getLockoutSnapshot,
  );

  const meta = pluginId !== undefined ? metaSnapshot[pluginId] : undefined;
  const boundaryKey = `${pluginId ?? "builtin"}:${meta?.etag ?? "static"}:${meta?.configKey ?? "{}"}:${meta?.reloadEpoch ?? 0}:${slotKey}`;
  const wrapperStyle: CSSProperties | undefined =
    style ?? (className !== undefined ? undefined : { display: "contents" });

  return (
    <div
      data-qj-plugin={pluginId ?? "builtin"}
      data-qj-slot={slotName}
      data-qj-entry={entry.id}
      className={className}
      style={wrapperStyle}
    >
      {lockout.startsWith("locked:") ? (
        <SlotCrashFallback
          pluginId={pluginId}
          entryId={entry.id}
          slotName={slotName}
          message={lockout.slice("locked:".length) || "插件渲染异常"}
          compact={compact}
        />
      ) : (
        <SlotErrorBoundary
          key={boundaryKey}
          pluginId={pluginId}
          entryId={entry.id}
          slotName={slotName}
          slotKey={slotKey}
          compact={compact}
        >
          <SlotRenderBody render={entry.render} context={context} />
        </SlotErrorBoundary>
      )}
    </div>
  );
}

export interface RegionErrorBoundaryProps {
  region: string;
  resetKey?: string | number | null;
  compact?: boolean;
  children: ReactNode;
}

interface RegionErrorBoundaryState {
  error: Error | null;
  prevResetKey: string | number | null | undefined;
}

/**
 * Fault boundary around major host UI regions (`Sidebar`, `Message`, `Composer`,
 * `RightWorkbench`, `BottomWorkbench`, `SettingsModal`) so a local rendering bug
 * never unmounts the entire window.
 */
export class RegionErrorBoundary extends Component<RegionErrorBoundaryProps, RegionErrorBoundaryState> {
  override state: RegionErrorBoundaryState = {
    error: null,
    prevResetKey: this.props.resetKey,
  };

  static getDerivedStateFromError(error: unknown): Partial<RegionErrorBoundaryState> {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  static getDerivedStateFromProps(
    props: RegionErrorBoundaryProps,
    state: RegionErrorBoundaryState,
  ): Partial<RegionErrorBoundaryState> | null {
    if (props.resetKey !== state.prevResetKey) {
      return {
        error: null,
        prevResetKey: props.resetKey,
      };
    }
    return null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    void reportFrontendError(`region-boundary:${this.props.region}`, error, {
      extraStack: info.componentStack ?? undefined,
    });
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div
          role="alert"
          data-testid={`region-error-${this.props.region}`}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            padding: this.props.compact ? "6px 10px" : "12px 16px",
            margin: this.props.compact ? "4px 0" : "8px",
            borderRadius: "8px",
            background: "var(--qj-status-danger-bg, rgba(239, 68, 68, 0.08))",
            border: "1px solid var(--qj-status-danger-border, rgba(239, 68, 68, 0.28))",
            color: "var(--qj-text-primary, inherit)",
            fontSize: "12px",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
            <AlertTriangle size={14} aria-hidden="true" style={{ color: "var(--qj-status-danger, #dc2626)" }} />
            <span>
              {this.props.region} 区域渲染异常：{this.state.error.message}
            </span>
          </span>
          <button
            type="button"
            onClick={this.handleReset}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              padding: "3px 8px",
              borderRadius: "5px",
              border: "1px solid var(--qj-border-default, rgba(127, 127, 127, 0.35))",
              background: "transparent",
              color: "inherit",
              fontSize: "12px",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <RotateCw size={11} aria-hidden="true" />
            重试渲染
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export { PluginSlot, type PluginSlotContextMap, type PluginSlotName, type PluginSlotProps } from "./PluginSlot";

