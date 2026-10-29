import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { harnessRuntimes } from "../lib/harnessRuntime";
import { providerService } from "../lib/providerService";
import { scheduleClient } from "../lib/scheduleClient";

interface HarnessOfferProps {
  onSwitch: () => void;
  onStay: () => void;
}

interface Carryover {
  /** Providers the Host already has (imported from Pi's models.json and auth.json at startup). */
  hostProviders?: number;
  /** Providers set up in Pi that the Host does not have: OAuth logins and built-ins the harness cannot reach. */
  left?: string[];
  /** Scheduled tasks that move to the Host on the switch. */
  tasks?: number;
}

/**
 * The one-time offer to an install that runs on Pi to move to the Harness,
 * the default engine since P5d. It says what carries over and what does not,
 * read while the engine is still Pi; either answer is not asked again.
 */
export function HarnessOffer({ onSwitch, onStay }: HarnessOfferProps) {
  const [carryover, setCarryover] = useState<Carryover>({});

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      harnessRuntimes.call<{ providers: Array<{ id: string }> }>("provider.configs").then((result) => result.providers, () => undefined),
      providerService.list().catch(() => undefined),
      scheduleClient.list().then((tasks) => tasks.length, () => undefined),
    ]).then(([host, pi, tasks]) => {
      if (cancelled) return;
      const hostIds = new Set((host ?? []).map((provider) => provider.id));
      setCarryover({
        hostProviders: host?.length,
        left: host === undefined || pi === undefined ? undefined : pi.filter((provider) => provider.configured && !hostIds.has(provider.id)).map((provider) => provider.name),
        tasks,
      });
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="harness-offer" role="dialog" aria-modal="true" aria-labelledby="harness-offer-title">
        <header>
          <Sparkles size={18} strokeWidth={1.75} />
          <h2 id="harness-offer-title">切换到 Harness 引擎</h2>
        </header>
        <p>Harness 是 Pi Desktop 的自研引擎，现在是新任务的默认引擎。切换后：</p>
        <ul>
          <li>
            {carryover.hostProviders === undefined
              ? "Pi 的 models.json 中的模型 provider 会自动导入。"
              : `已从 Pi 导入 ${carryover.hostProviders} 个模型 provider，密钥加密保存在本机。`}
          </li>
          {carryover.left !== undefined && carryover.left.length > 0 && (
            <li className="harness-offer-warning">
              这些 provider 不会迁移，需要在“模型与连接”里用 API key 重新添加：{carryover.left.join("、")}。
            </li>
          )}
          <li>
            {carryover.tasks === undefined || carryover.tasks === 0
              ? "定时任务改由 Harness 执行。"
              : `${carryover.tasks} 个定时任务会迁移，改由 Harness 执行。`}
          </li>
          <li>已有的 Pi 任务仍在侧边栏，打开后继续在 Pi 上运行。</li>
        </ul>
        <p className="harness-offer-note">之后可以随时在 设置 › Agent 与安全 › Agent 引擎 中切换。Pi 引擎会在之后的版本移除。</p>
        <footer>
          <button type="button" className="secondary-button" onClick={onStay}>继续使用 Pi</button>
          <button type="button" className="primary-button" onClick={onSwitch}>切换到 Harness</button>
        </footer>
      </section>
    </div>
  );
}
