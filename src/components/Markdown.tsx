import { createContext, useContext, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { FileText } from "lucide-react";
import { usePiStore } from "../store";
import "highlight.js/styles/github-dark.css";

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
}

export function Markdown({ content }: MarkdownProps) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
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
        {linkifyFilePaths(content)}
      </ReactMarkdown>
    </div>
  );
}
