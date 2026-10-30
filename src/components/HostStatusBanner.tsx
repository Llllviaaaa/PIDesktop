import { useRuntime } from "../store/selectors";

/**
 * Says so while the Harness Host cannot be reached: reconnecting on its own,
 * or stopped after crashing too often, with a button to start it again.
 */
export function HostStatusBanner() {
  const { hostStatus, restartHost } = useRuntime("hostStatus", "restartHost");
  if (hostStatus === "connected") return null;
  const failed = hostStatus === "failed";
  return (
    <div className={`host-status-banner${failed ? " failed" : ""}`} role="status">
      <span>{failed ? "Harness 多次崩溃，已停止自动重启" : "Harness 已断开，正在重连…"}</span>
      {failed && (
        <button type="button" onClick={() => void restartHost()}>
          重新启动
        </button>
      )}
    </div>
  );
}
