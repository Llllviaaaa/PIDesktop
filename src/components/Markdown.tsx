import { Children, createContext, isValidElement, memo, useContext, useMemo, useState, type ComponentPropsWithoutRef, type MouseEvent, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import type { PluggableList } from "unified";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy, FileText } from "lucide-react";
import { useAppStore } from "../store";
import { showToast } from "../notifications";
import { stripCodeReviewDirectives } from "../lib/codeReview";
import { matchCodeBlockRenderer, useClientContributions } from "../lib/clientContributions";
import { isRichContentLanguage, parseRichContent } from "../lib/richContent";
import { INTELLIGENT_UI_FENCE_LANGUAGE, parseIntelligentUiFence } from "../lib/intelligentUi";
import { useIntelligentUiStore } from "../stores/intelligentUiStore";
import { SlotEntryHost } from "./common/ErrorBoundary";
import { DiagramBlock, diagramKindForLanguage } from "./DiagramBlock";
import { IntelligentUiCard } from "./IntelligentUiCard";
import { RichContent } from "./RichContent";
import { useFileActions } from "./WorkspaceOpeners";

/** When provided, file links open in the in-app document pane instead of the OS. */
export type OpenWorkspaceFile = (path: string, line?: number) => void;
export const WorkspaceFileOpenContext = createContext<OpenWorkspaceFile | null>(null);

const FILE_SCHEME = "pifile://";

/**
 * File tokens come in two conservative shapes:
 * - path with ≥1 separator and any short extension (src/App.tsx, D:\repo\a.rs)
 * - bare filename with a whitelisted code/doc extension (README.md, prd.md) —
 *   the whitelist keeps domains (pi.dev) and version numbers (1.30.0) unlinked.
 */
const BARE_FILE_EXTENSIONS =
  "tsx|ts|jsx|js|mjs|cjs|rs|py|go|java|rb|php|md|markdown|json|jsonc|css|scss|less|html|htm|svg|toml|yaml|yml|txt|xml|sql|ps1|bat|ini|cfg|conf|lock|csv|svelte|vue";
const PATH_FILE_TOKEN = String.raw`(?:[A-Za-z]:[\\/])?(?:\.{1,2}[\\/])?[\w.-]+(?:[\\/][\w.-]+)+\.[A-Za-z0-9]{1,6}`;
const BARE_FILE_TOKEN = String.raw`[\w-]+(?:\.[\w-]+)*\.(?:${BARE_FILE_EXTENSIONS})(?![\w.-])`;
const INLINE_FILE_RE = new RegExp(`^(${PATH_FILE_TOKEN}|${BARE_FILE_TOKEN})(?::(\\d+))?$`);
const TEXT_FILE_RE = new RegExp(
  String.raw`(?<![\w\u0060[(\\/.-])(${PATH_FILE_TOKEN}|${BARE_FILE_TOKEN})(?::(\d+)|\s?[（(]\s*line\s+(\d+)\s*[)）])?`,
  "g",
);

function fileHref(path: string, line?: string): string {
  return `${FILE_SCHEME}${encodeURIComponent(path)}${line ? `#L${line}` : ""}`;
}

/** Turn bare file-path tokens in prose (not inside code spans/fences) into pifile:// links. */
function linkifyFilePaths(markdown: string): string {
  const parts = markdown.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part.replace(TEXT_FILE_RE, (full, path: string, colonLine?: string, parenLine?: string) =>
        `[${full}](${fileHref(path, colonLine || parenLine)})`);
    })
    .join("");
}

function openFileRef(event: MouseEvent, href: string) {
  event.preventDefault();
  const path = decodeURIComponent(href.slice(FILE_SCHEME.length).split("#")[0]);
  const cwd = useAppStore.getState().cwd;
  const sep = cwd.includes("\\") ? "\\" : "/";
  const normalizedChild = sep === "\\" ? path.replace(/\//g, "\\") : path.replace(/\\/g, "/");
  const absolute = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path)
    ? path
    : cwd
      ? `${cwd.replace(/[\\/]+$/, "")}${sep}${normalizedChild}`
      : path;
  const fallback = () => {
    void navigator.clipboard.writeText(absolute).catch(() => undefined);
    showToast(`无法直接打开，已复制路径：${absolute}`, "info");
  };
  try {
    openPath(absolute).catch(fallback);
  } catch {
    fallback();
  }
}

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Bash",
  c: "C",
  cpp: "C++",
  cs: "C#",
  csharp: "C#",
  css: "CSS",
  dart: "Dart",
  diff: "Diff",
  go: "Go",
  html: "HTML",
  java: "Java",
  js: "JavaScript",
  json: "JSON",
  jsonc: "JSON",
  jsx: "JSX",
  kotlin: "Kotlin",
  md: "Markdown",
  markdown: "Markdown",
  mjs: "JavaScript",
  php: "PHP",
  "qianji-rich": "千机 Rich",
  "pidesktop-rich": "千机 Rich",
  "intelligent-ui": "Intelligent UI",
  ps1: "PowerShell",
  powershell: "PowerShell",
  py: "Python",
  python: "Python",
  rb: "Ruby",
  rs: "Rust",
  rust: "Rust",
  scss: "SCSS",
  sh: "Shell",
  sql: "SQL",
  svelte: "Svelte",
  swift: "Swift",
  toml: "TOML",
  ts: "TypeScript",
  tsx: "TSX",
  vue: "Vue",
  xml: "XML",
  yaml: "YAML",
  yml: "YAML",
  zsh: "Shell",
};

function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children);
  return "";
}

function codeFenceDetails(children: ReactNode): {
  codeEl: ReactElement<{ className?: string; children?: ReactNode }> | undefined;
  language: string;
  text: string;
} {
  const codeEl = Children.toArray(children).find((child) => {
    if (!isValidElement(child)) return false;
    if (child.type === "code") return true;
    const className = (child.props as { className?: string }).className || "";
    return className.includes("language-") || className.includes("hljs");
  }) as ReactElement<{ className?: string; children?: ReactNode }> | undefined;
  const language = /language-([^\s]+)/.exec(codeEl?.props.className || "")?.[1]?.toLowerCase() || "";
  const text = nodeText(codeEl?.props.children ?? children).replace(/\n$/, "");
  return { codeEl, language, text };
}

function CodeFence({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const { language, text } = codeFenceDetails(children);
  const label = language ? LANGUAGE_LABELS[language] || language : "";

  return (
    <div className="markdown-code">
      <div className="markdown-code-bar">
        <span>{label}</span>
        <button
          type="button"
          className="markdown-code-copy"
          title={copied ? "已复制" : "复制代码"}
          aria-label={copied ? "已复制" : "复制代码"}
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            }).catch(() => undefined);
          }}
        >
          {copied ? <Check size={13} strokeWidth={1.75} /> : <Copy size={13} strokeWidth={1.75} />}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

function MarkdownPre({ children, allowRichContent = false }: { children?: ReactNode; allowRichContent?: boolean }) {
  const { language, text } = codeFenceDetails(children);
  const intelligentUiEnabled = useIntelligentUiStore((state) => state.pluginEnabled);
  const { codeBlockRenderers } = useClientContributions();
  const cwd = useAppStore((state) => state.cwd);
  const sessionFile = useAppStore((state) => state.sessionFile);
  const richDocument = useMemo(
    () => allowRichContent && isRichContentLanguage(language) ? parseRichContent(text) : null,
    [allowRichContent, language, text],
  );
  const intelligentUiGroup = useMemo(() => {
    if (!intelligentUiEnabled || language !== INTELLIGENT_UI_FENCE_LANGUAGE) return null;
    const artifact = parseIntelligentUiFence(text);
    return artifact ? { id: artifact.id, versions: [artifact], latest: artifact } : null;
  }, [intelligentUiEnabled, language, text]);
  if (richDocument) return <RichContent document={richDocument} />;
  if (intelligentUiGroup) return <IntelligentUiCard group={intelligentUiGroup} mode="inline" />;
  const pluginRenderer = matchCodeBlockRenderer(codeBlockRenderers, language);
  if (pluginRenderer) {
    return (
      <SlotEntryHost
        entry={pluginRenderer}
        context={{ cwd, sessionFile, language, code: text }}
        slotName="markdown.codeBlock"
        className="markdown-plugin-block"
      />
    );
  }
  const diagramKind = diagramKindForLanguage(language);
  if (diagramKind) return <DiagramBlock kind={diagramKind} source={text} />;
  return <CodeFence>{children}</CodeFence>;
}

function MarkdownTable({ children, ...props }: ComponentPropsWithoutRef<"table">) {
  return (
    <div className="markdown-table-scroll" role="region" aria-label="表格内容，可横向滚动" tabIndex={0}>
      <table {...props}>{children}</table>
    </div>
  );
}

function richContentFenceCount(markdown: string): number {
  const allRichOpeners = markdown
    .split(/\r?\n/)
    .filter((line) => /(`{3,}|~{3,})[ \t]*(?:qianji-rich|pidesktop-rich)/i.test(line))
    .length;
  let activeFence: { marker: "`" | "~"; length: number; rich: boolean } | null = null;
  let richStarts = 0;
  let richCompleted = 0;
  for (const line of markdown.split(/\r?\n/)) {
    if (!activeFence) {
      const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (!opening) continue;
      const rich = isRichContentLanguage(opening[2]);
      if (rich) richStarts += 1;
      activeFence = { marker: opening[1][0] as "`" | "~", length: opening[1].length, rich };
      continue;
    }
    const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (!closing || closing[1][0] !== activeFence.marker || closing[1].length < activeFence.length) continue;
    if (activeFence.rich) richCompleted += 1;
    activeFence = null;
  }
  return allRichOpeners === richStarts && richStarts === richCompleted ? richCompleted : -1;
}

function parseFileHref(href: string): { path: string; line?: number } {
  const [encoded, hash] = href.slice(FILE_SCHEME.length).split("#");
  const line = hash?.startsWith("L") ? Number(hash.slice(1)) : undefined;
  return { path: decodeURIComponent(encoded), line: line !== undefined && Number.isFinite(line) ? line : undefined };
}

function FileRef({ href, children }: { href: string; children?: ReactNode }) {
  const openInApp = useContext(WorkspaceFileOpenContext);
  const fileActions = useFileActions();
  const editor = fileActions?.preferredEditor;
  return (
    <a
      className="file-ref"
      href={href}
      title={editor ? `单击预览 · Ctrl+单击在 ${editor.name} 中打开 · 右键查看更多` : undefined}
      onContextMenu={(event) => {
        if (!fileActions) return;
        const { path, line } = parseFileHref(href);
        fileActions.showMenu(event, path, line);
      }}
      onClick={(event) => {
        if ((event.ctrlKey || event.metaKey) && fileActions) {
          event.preventDefault();
          const { path, line } = parseFileHref(href);
          fileActions.openInEditor(path, line);
          return;
        }
        if (!openInApp) {
          openFileRef(event, href);
          return;
        }
        event.preventDefault();
        const { path, line } = parseFileHref(href);
        openInApp(path, line);
      }}
    >
      <FileText size={13} strokeWidth={1.8} />
      <span>{children}</span>
    </a>
  );
}

const REMARK_PLUGINS: PluggableList = [remarkGfm];
const REHYPE_PLUGINS: PluggableList = [[rehypeHighlight, { detect: false, ignoreMissing: true }]];
const markdownUrlTransform = (url: string) =>
  url.startsWith(FILE_SCHEME) ? url : defaultUrlTransform(url);

interface MarkdownProps {
  content: string;
  allowRichContent?: boolean;
}

export const Markdown = memo(function Markdown({ content, allowRichContent = false }: MarkdownProps) {
  const visibleContent = useMemo(() => stripCodeReviewDirectives(content), [content]);
  const linkedMarkdown = useMemo(() => linkifyFilePaths(visibleContent), [visibleContent]);
  const richContentEnabled = useMemo(
    () => allowRichContent && richContentFenceCount(visibleContent) === 1,
    [allowRichContent, visibleContent],
  );
  const components = useMemo<Components>(
    () => ({
      pre: ({ children }) => <MarkdownPre allowRichContent={richContentEnabled}>{children}</MarkdownPre>,
      table: ({ children, node: _node, ...props }) => <MarkdownTable {...props}>{children}</MarkdownTable>,
      a: ({ href, children }) => {
        if (href?.startsWith(FILE_SCHEME)) return <FileRef href={href}>{children}</FileRef>;
        return (
          <a
            href={href}
            onClick={(event) => {
              if (!href) return;
              event.preventDefault();
              void openUrl(href);
            }}
          >
            {children}
          </a>
        );
      },
      code: ({ className, children, ...rest }) => {
        const text = typeof children === "string"
          ? children
          : Array.isArray(children) && children.length === 1 && typeof children[0] === "string"
            ? children[0]
            : null;
        if (!className && text) {
          const match = INLINE_FILE_RE.exec(text.trim());
          // A path in inline code stays a code chip whose text is the file link (dsh-claude-style file mentions).
          if (match) return <code className="file-mention"><FileRef href={fileHref(match[1], match[2])}>{text.trim()}</FileRef></code>;
        }
        return <code className={className} {...rest}>{children}</code>;
      },
    }),
    [richContentEnabled],
  );

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        urlTransform={markdownUrlTransform}
        components={components}
      >
        {linkedMarkdown}
      </ReactMarkdown>
    </div>
  );
});
