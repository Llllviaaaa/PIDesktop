import { useCallback, useEffect, useRef, useState } from "react";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import {
  CircleAlert,
  Download,
  ExternalLink,
  PackageCheck,
  PackageOpen,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { pi } from "../lib/pi";
import type { PackageCatalogDetail, PackageCatalogItem, ResourceItem } from "../types";

type PackageScope = "user" | "project";
type MarketplaceTab = "discover" | "installed";

function packageNameFromSource(source: string) {
  const value = source.trim().replace(/^npm:/, "");
  if (value.startsWith("@")) {
    const slash = value.indexOf("/");
    const version = slash >= 0 ? value.lastIndexOf("@") : -1;
    return version > slash ? value.slice(0, version) : value;
  }
  return value.split("@")[0];
}

function formatPackageDownloads(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M/月`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K/月`;
  return `${value.toLocaleString()}/月`;
}

function formatPackageSize(value: number) {
  if (!value) return "未知";
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function packageDescription(value: string | null | undefined, fallback: string) {
  if (!value) return fallback;
  const parsed = new DOMParser().parseFromString(value, "text/html").body.textContent || "";
  return parsed.replace(/\s+/g, " ").trim() || fallback;
}

function packageKinds(detail: PackageCatalogDetail | null, item?: PackageCatalogItem) {
  const entries: Array<[string, string[] | undefined]> = [
    ["扩展", detail?.extensions],
    ["技能", detail?.skills],
    ["提示词", detail?.prompts],
    ["主题", detail?.themes],
  ];
  const declared = entries.filter(([, paths]) => paths && paths.length > 0).map(([label]) => label);
  if (declared.length > 0) return declared;
  const keywords = item?.keywords || detail?.keywords || [];
  const labels = { 扩展: "extension", 技能: "skill", 提示词: "prompt", 主题: "theme" } as Record<string, string>;
  const inferred = entries.filter(([label]) => keywords.some((keyword) => keyword.toLowerCase() === labels[label])).map(([label]) => label);
  return inferred.length > 0 ? inferred : ["软件包"];
}

export function PluginMarketplacePage({ cwd }: { cwd: string }) {
  const [tab, setTab] = useState<MarketplaceTab>("discover");
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<{ items: PackageCatalogItem[]; total: number }>({ items: [], total: 0 });
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [selectedName, setSelectedName] = useState("");
  const [selectedDetail, setSelectedDetail] = useState<PackageCatalogDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [resources, setResources] = useState<ResourceItem[]>([]);
  const [resourcesLoading, setResourcesLoading] = useState(true);
  const [scope, setScope] = useState<PackageScope>("user");
  const [pendingInstall, setPendingInstall] = useState<{ source: string; label: string } | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualSource, setManualSource] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const detailRequestRef = useRef(0);
  const packages = resources.filter((item) => item.kind === "package");
  const looseResources = resources.filter((item) => item.kind !== "package");

  const reloadResources = useCallback(async () => {
    if (!("__TAURI_INTERNALS__" in window)) {
      setResourcesLoading(false);
      return;
    }
    setResourcesLoading(true);
    try {
      setResources(await pi.listResources(cwd));
    } catch (error) {
      setNotice({ tone: "error", text: `无法读取已安装插件：${String(error)}` });
    } finally {
      setResourcesLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void reloadResources();
  }, [reloadResources]);

  const installedScopes = (name: string) => packages
    .filter((item) => packageNameFromSource(item.path) === name)
    .map((item) => item.scope);

  const loadDetail = async (name: string) => {
    const requestId = ++detailRequestRef.current;
    setSelectedName(name);
    setSelectedDetail(null);
    setDetailError("");
    setDetailLoading(true);
    try {
      const detail = await pi.packageDetail(name);
      if (detailRequestRef.current === requestId) setSelectedDetail(detail);
    } catch (error) {
      if (detailRequestRef.current === requestId) setDetailError(String(error));
    } finally {
      if (detailRequestRef.current === requestId) setDetailLoading(false);
    }
  };

  useEffect(() => {
    if (tab !== "discover") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setCatalogLoading(true);
      setCatalogError("");
      void pi.searchPackages(query, 0, 30).then((result) => {
        if (cancelled) return;
        setCatalog({ items: result.items, total: result.total });
        setSelectedName((current) => {
          const next = result.items.some((item) => item.name === current) ? current : (result.items[0]?.name || "");
          if (next && next !== current) void loadDetail(next);
          return next;
        });
      }).catch((error) => {
        if (!cancelled) setCatalogError(String(error));
      }).finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });
    }, query ? 280 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, reloadKey, tab]);

  const runAction = async (action: "install" | "remove" | "update", source?: string, actionScope: PackageScope = scope) => {
    setBusyKey(`${action}:${source || "all"}:${actionScope}`);
    setNotice(null);
    try {
      const output = await pi.packageAction(action, source, cwd, actionScope);
      const result = output || (action === "install" ? "安装完成" : action === "remove" ? "已移除" : "更新完成");
      setNotice({ tone: "success", text: action === "install" ? `${result}。新建任务后加载新增能力。` : result });
      await reloadResources();
      setPendingInstall(null);
      if (action === "install") setManualSource("");
    } catch (error) {
      setNotice({ tone: "error", text: String(error) });
    } finally {
      setBusyKey("");
    }
  };

  const refresh = () => {
    if (tab === "discover") {
      pi.clearPackageCatalogCache();
      setReloadKey((value) => value + 1);
    } else {
      void reloadResources();
    }
  };

  const selectedItem = catalog.items.find((item) => item.name === selectedName);
  const selectedScopes = installedScopes(selectedName);
  const selectedSource = selectedName ? `npm:${selectedName}` : "";
  const capabilityRows = selectedDetail ? [
    ["扩展", selectedDetail.extensions],
    ["技能", selectedDetail.skills],
    ["提示词", selectedDetail.prompts],
    ["主题", selectedDetail.themes],
  ].filter(([, paths]) => paths.length > 0) as Array<[string, string[]]> : [];

  return <section className="plugins-page">
    <header className="work-center-header plugins-page-header">
      <div>
        <span><h1>插件</h1><p>发现并管理为 Pi 添加扩展、技能、提示词和主题的软件包。</p></span>
      </div>
      <div className="work-center-header-actions">
        <button type="button" className="icon-button" title="打开 Pi 官方插件目录" onClick={() => void openUrl("https://pi.dev/packages")}><ExternalLink size={16} /></button>
        <button type="button" className="icon-button" title="刷新插件" disabled={catalogLoading || Boolean(busyKey)} onClick={refresh}><RefreshCw className={catalogLoading && tab === "discover" ? "spinner-icon" : ""} size={16} /></button>
      </div>
    </header>

    <div className="plugins-page-content">
      <div className="marketplace-commandbar">
        <div className="marketplace-tabs" role="tablist" aria-label="插件页面">
          <button role="tab" aria-selected={tab === "discover"} className={tab === "discover" ? "active" : ""} onClick={() => setTab("discover")}><PackageOpen size={14} />发现</button>
          <button role="tab" aria-selected={tab === "installed"} className={tab === "installed" ? "active" : ""} onClick={() => setTab("installed")}><PackageCheck size={14} />已安装 <span>{packages.length}</span></button>
        </div>
        {tab === "discover" && <label className="marketplace-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Pi 插件" />{query && <button title="清除搜索" onClick={() => setQuery("")}><X size={13} /></button>}</label>}
        <button className="secondary-button compact" disabled={Boolean(busyKey)} onClick={() => void runAction("update")}><Download size={13} />全部更新</button>
        <button className={`secondary-button compact ${manualOpen ? "active" : ""}`} onClick={() => setManualOpen((value) => !value)}><Plus size={13} />从来源安装</button>
      </div>

      {manualOpen && <div className="marketplace-manual">
        <label><span>软件包来源</span><input autoFocus value={manualSource} onChange={(event) => setManualSource(event.target.value)} placeholder="npm:package、Git 地址或本地路径" /></label>
        <div className="scope-segment" aria-label="安装作用域"><button className={scope === "user" ? "active" : ""} onClick={() => setScope("user")}>所有工作区</button><button className={scope === "project" ? "active" : ""} onClick={() => setScope("project")}>当前项目</button></div>
        <button className="primary-button" disabled={!manualSource.trim() || Boolean(busyKey)} onClick={() => setPendingInstall({ source: manualSource.trim(), label: manualSource.trim() })}>检查并安装</button>
      </div>}

      {notice && <div className={`marketplace-notice ${notice.tone}`}><span>{notice.text}</span><button title="关闭" onClick={() => setNotice(null)}><X size={13} /></button></div>}

      {tab === "discover" ? <div className="marketplace-browser">
        <section className="marketplace-results" aria-label="软件包搜索结果">
          <header><strong>{query ? `“${query}”` : "热门插件"}</strong><span>{catalog.total.toLocaleString()} 个结果</span></header>
          <div className="marketplace-result-list">
            {catalogLoading && catalog.items.length === 0 ? <div className="marketplace-empty"><RefreshCw className="spinner-icon" size={18} />正在读取 Pi 目录…</div> : catalogError ? <div className="marketplace-empty error"><CircleAlert size={18} />{catalogError}<button className="secondary-button compact" onClick={() => setReloadKey((value) => value + 1)}>重试</button></div> : catalog.items.length === 0 ? <div className="marketplace-empty"><Search size={18} />没有匹配的插件</div> : catalog.items.map((item) => {
              const scopes = installedScopes(item.name);
              return <button key={item.name} className={selectedName === item.name ? "active" : ""} onClick={() => void loadDetail(item.name)}>
                <span className="marketplace-package-icon"><PackageOpen size={16} /></span>
                <span className="marketplace-package-copy"><strong>{item.name}</strong><small>{packageDescription(item.description, "未提供说明")}</small><em>{item.author || "未知作者"} · {formatPackageDownloads(item.downloads)}</em></span>
                {scopes.length > 0 ? <PackageCheck className="installed-check" size={15} /> : <code>v{item.version}</code>}
              </button>;
            })}
          </div>
        </section>

        <section className="marketplace-detail" aria-label="软件包详情">
          {!selectedName ? <div className="marketplace-empty"><PackageOpen size={22} />选择一个插件查看详情</div> : detailLoading ? <div className="marketplace-empty"><RefreshCw className="spinner-icon" size={18} />正在读取清单…</div> : detailError ? <div className="marketplace-empty error"><CircleAlert size={18} />{detailError}</div> : selectedDetail && <>
            <header className="marketplace-detail-header">
              <span><span className="marketplace-detail-icon"><PackageOpen size={20} /></span><span><strong>{selectedDetail.name}</strong><small>v{selectedDetail.version} · {selectedDetail.author || "未知作者"}</small></span></span>
              <div className="marketplace-detail-actions">
                <div className="scope-segment compact" aria-label="安装作用域"><button className={scope === "user" ? "active" : ""} onClick={() => setScope("user")}>全局</button><button className={scope === "project" ? "active" : ""} onClick={() => setScope("project")}>项目</button></div>
                {selectedScopes.includes(scope) ? <><button className="secondary-button compact" disabled={Boolean(busyKey)} onClick={() => void runAction("update", selectedSource, scope)}><RefreshCw size={13} />更新</button><button className="icon-button danger" title={`从${scope === "project" ? "当前项目" : "所有工作区"}移除`} disabled={Boolean(busyKey)} onClick={() => void runAction("remove", selectedSource, scope)}><Trash2 size={14} /></button></> : <button className="primary-button" disabled={Boolean(busyKey)} onClick={() => setPendingInstall({ source: selectedSource, label: selectedDetail.name })}><Download size={13} />安装</button>}
              </div>
            </header>

            <p className="marketplace-description">{packageDescription(selectedDetail.description, "此软件包未提供说明。")}</p>
            {selectedDetail.imageUrl && <button className="marketplace-preview" title="打开预览图片" onClick={() => void openUrl(selectedDetail.imageUrl!)}><img src={selectedDetail.imageUrl} alt={`${selectedDetail.name} 预览`} /></button>}
            <div className="marketplace-kinds">{packageKinds(selectedDetail, selectedItem).map((kind) => <span key={kind}>{kind}</span>)}</div>
            {capabilityRows.length > 0 && <section className="marketplace-capabilities"><h3>包含的能力</h3>{capabilityRows.map(([kind, paths]) => <div key={kind}><strong>{kind}</strong><span>{paths.map((path) => <code key={path}>{path}</code>)}</span></div>)}</section>}
            <dl className="marketplace-metadata">
              <div><dt>许可证</dt><dd>{selectedDetail.license}</dd></div>
              <div><dt>包体积</dt><dd>{formatPackageSize(selectedDetail.unpackedSize)}</dd></div>
              <div><dt>依赖</dt><dd>{selectedDetail.dependencyCount} 个运行时 · {selectedDetail.peerDependencyCount} 个对等</dd></div>
              <div><dt>完整性</dt><dd title={selectedDetail.integrity}>{selectedDetail.integrity ? `${selectedDetail.integrity.slice(0, 18)}…` : "未声明"}</dd></div>
            </dl>
            <div className="marketplace-links"><button onClick={() => void openUrl(selectedDetail.npmUrl)}><ExternalLink size={13} />npm</button>{selectedDetail.repositoryUrl && <button onClick={() => void openUrl(selectedDetail.repositoryUrl!)}><ExternalLink size={13} />源代码</button>}{selectedDetail.homepageUrl && <button onClick={() => void openUrl(selectedDetail.homepageUrl!)}><ExternalLink size={13} />主页</button>}{selectedDetail.videoUrl && <button onClick={() => void openUrl(selectedDetail.videoUrl!)}><ExternalLink size={13} />演示</button>}</div>
            <div className="marketplace-security"><ShieldAlert size={16} /><span><strong>完整系统访问</strong>Pi 扩展可以执行代码，技能可以引导 Agent 执行命令。安装前请检查作者与源代码。</span></div>
          </>}
        </section>
      </div> : <section className="installed-packages">
        <header><span><strong>已安装的插件</strong><small>用户级插件用于所有工作区，项目级插件只用于当前项目。</small></span><button className="secondary-button compact" disabled={Boolean(busyKey)} onClick={() => void runAction("update")}><RefreshCw size={13} />检查更新</button></header>
        {resourcesLoading ? <div className="marketplace-empty"><RefreshCw className="spinner-icon" size={18} />正在读取 Pi 设置…</div> : packages.length === 0 ? <div className="marketplace-empty"><PackageOpen size={22} />尚未安装 Pi 插件<button className="secondary-button compact" onClick={() => setTab("discover")}>浏览目录</button></div> : <div className="installed-package-list">{packages.map((item) => <div key={`${item.scope}-${item.path}`}><span className="marketplace-package-icon"><PackageCheck size={16} /></span><span><strong>{item.name}</strong><small>{item.path}</small></span><code>{item.version ? `v${item.version}` : "版本未知"}</code><em>{item.scope === "project" ? "当前项目" : "所有工作区"}</em><button className="icon-button" title="更新" disabled={Boolean(busyKey)} onClick={() => void runAction("update", item.path, item.scope)}><RefreshCw size={14} /></button><button className="icon-button danger" title="移除" disabled={Boolean(busyKey)} onClick={() => void runAction("remove", item.path, item.scope)}><Trash2 size={14} /></button></div>)}</div>}
        {looseResources.length > 0 && <div className="loose-resources"><h3>本地资源</h3>{looseResources.map((item) => <button key={`${item.kind}-${item.path}`} onClick={() => void openPath(item.path).catch(() => undefined)}><span className={`resource-kind ${item.kind}`}>{({ extension: "扩展", skill: "技能", prompt: "提示词", theme: "主题" } as Record<string, string>)[item.kind] || item.kind}</span><span><strong>{item.name}</strong><small>{item.path}</small></span><em>{item.scope === "project" ? "项目" : "用户"}</em></button>)}</div>}
      </section>}

      {pendingInstall && <div className="marketplace-confirm" role="alertdialog" aria-label="确认安装软件包">
        <ShieldAlert size={18} />
        <span><strong>确认安装 {pendingInstall.label}</strong><small>它将获得与 Pi 相同的本机访问能力。{scope === "project" ? "配置会写入当前项目的 .pi/settings.json。" : "配置会写入 ~/.pi/agent/settings.json，并用于所有工作区。"}</small></span>
        <div className="scope-segment" aria-label="确认安装作用域"><button className={scope === "user" ? "active" : ""} onClick={() => setScope("user")}>所有工作区</button><button className={scope === "project" ? "active" : ""} onClick={() => setScope("project")}>当前项目</button></div>
        <button className="secondary-button" disabled={Boolean(busyKey)} onClick={() => setPendingInstall(null)}>取消</button>
        <button className="primary-button" disabled={Boolean(busyKey)} onClick={() => void runAction("install", pendingInstall.source, scope)}>{busyKey ? "正在安装…" : "确认安装"}</button>
      </div>}
    </div>
  </section>;
}
