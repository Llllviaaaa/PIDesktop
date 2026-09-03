import { Children, createContext, isValidElement, useContext, useMemo, useState, type ComponentPropsWithoutRef, type MouseEvent, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy, FileText } from "lucide-react";
import { usePiStore } from "../store";
import { stripCodeReviewDirectives } from "../lib/codeReview";
import { parseRichContent, RICH_CONTENT_LANGUAGE } from "../lib/richContent";
import { DiagramBlock, diagramKindForLanguage } from "./DiagramBlock";
import { RichContent } from "./RichContent";

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
  "tsx|ts|jsx|js|mjs|cjs|rs|py|go|java|rb|php|md|markdown|json|jsonc|css|scss|less|html|htm|toml|yaml|yml|txt|xml|sql|ps1|bat|ini|cfg|conf|lock|csv|svelte|vue";
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
  const { cwd, showToast } = usePiStore.getState();
  const absolute = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path)
    ? path
    : cwd
      ? `${cwd.replace(/[\\/]+$/, "")}\\${path.replace(/\//g, "\\")}`
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
  "pidesktop-rich": "PIDesktop Rich",
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
  const richDocument = useMemo(
    () => allowRichContent && language === RICH_CONTENT_LANGUAGE ? parseRichContent(text) : null,
    [allowRichContent, language, text],
  );
  if (richDocument) return <RichContent document={richDocument} />;
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
    .filter((line) => /(`{3,}|~{3,})[ \t]*pidesktop-rich/i.test(line))
    .length;
  let activeFence: { marker: "`" | "~"; length: number; rich: boolean } | null = null;
  let richStarts = 0;
  let richCompleted = 0;
  for (const line of markdown.split(/\r?\n/)) {
    if (!activeFence) {
      const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (!opening) continue;
      const rich = opening[2].trim().toLowerCase() === RICH_CONTENT_LANGUAGE;
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

function FileRef({ href, children }: { href: string; children?: ReactNode }) {
  const openInApp = useContext(WorkspaceFileOpenContext);
  return (
    <a
      className="file-ref"
      href={href}
      onClick={(event) => {
        if (!openInApp) {
          openFileRef(event, href);
          return;
        }
        event.preventDefault();
        const [encoded, hash] = href.slice(FILE_SCHEME.length).split("#");
        const path = decodeURIComponent(encoded);
        const line = hash?.startsWith("L") ? Number(hash.slice(1)) : undefined;
        openInApp(path, Number.isFinite(line) ? line : undefined);
      }}
    >
      <FileText size={13} strokeWidth={1.8} />
      <span>{children}</span>
    </a>
  );
}

interface MarkdownProps {
  content: string;
  allowRichContent?: boolean;
}

export function Markdown({ content, allowRichContent = false }: MarkdownProps) {
  const visibleContent = stripCodeReviewDirectives(content);
  const richContentEnabled = useMemo(
    () => allowRichContent && richContentFenceCount(visibleContent) === 1,
    [allowRichContent, visibleContent],
  );
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        urlTransform={(url) => url.startsWith(FILE_SCHEME) ? url : defaultUrlTransform(url)}
        components={{
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
              if (match) return <FileRef href={fileHref(match[1], match[2])}>{text.trim()}</FileRef>;
            }
            return <code className={className} {...rest}>{children}</code>;
          },
        }}
      >
        {linkifyFilePaths(visibleContent)}
      </ReactMarkdown>
    </div>
  );
}
