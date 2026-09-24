/**
 * Which editor a workspace opens in, and how workspace paths become the
 * absolute paths the editor launcher needs.
 *
 * The choice is remembered per project (a Unity project wants Rider, a web
 * app wants VS Code), then falls back to the Settings default, then to the
 * first editor found on this machine.
 */
import type { WorkspaceEditorInfo } from "../types";
import { normalizeLocalPath } from "./pathIdentity";

const STORAGE_KEY = "pid-desktop:project-editors:v1";

type EditorStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): EditorStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readChoices(storage: EditorStorage | null): Record<string, string> {
  if (!storage) return {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

export function projectEditorChoice(workspace: string, storage: EditorStorage | null = defaultStorage()): string | null {
  if (!workspace) return null;
  return readChoices(storage)[normalizeLocalPath(workspace)] ?? null;
}

export function rememberProjectEditor(workspace: string, editorId: string, storage: EditorStorage | null = defaultStorage()) {
  if (!workspace || !storage) return;
  const choices = readChoices(storage);
  choices[normalizeLocalPath(workspace)] = editorId;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(choices));
  } catch {
    // Blocked storage keeps the choice for this session only (the Settings default still applies).
  }
}

/** Project choice → Settings default → first detected editor. Only installed editors qualify. */
export function preferredEditorFor(
  workspace: string,
  editors: WorkspaceEditorInfo[],
  settingsDefault: string | null | undefined,
  storage: EditorStorage | null = defaultStorage(),
): WorkspaceEditorInfo | null {
  const byId = (id: string | null | undefined) => (id ? editors.find((editor) => editor.id === id) ?? null : null);
  return byId(projectEditorChoice(workspace, storage))
    ?? (settingsDefault && settingsDefault !== "system" ? byId(settingsDefault) : null)
    ?? editors[0]
    ?? null;
}

export function isAbsoluteLocalPath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)/.test(path);
}

/** Resolves a workspace-relative path (as tools and diffs print it) against the workspace. */
export function resolveWorkspacePath(workspace: string, path: string): string {
  const trimmed = path.trim().replace(/^\.[\\/]/, "");
  if (isAbsoluteLocalPath(trimmed) || !workspace) return trimmed;
  const windows = /^[A-Za-z]:[\\/]/.test(workspace) || workspace.includes("\\");
  const separator = windows ? "\\" : "/";
  const base = workspace.replace(/[\\/]+$/, "");
  return `${base}${separator}${windows ? trimmed.replace(/\//g, "\\") : trimmed.replace(/\\/g, "/")}`;
}

/** The path relative to the workspace when it lives inside it; otherwise the path unchanged. */
export function relativeWorkspacePath(workspace: string, path: string): string {
  const absolute = normalizeLocalPath(resolveWorkspacePath(workspace, path));
  const root = normalizeLocalPath(workspace);
  if (root && absolute.startsWith(`${root}/`)) {
    const original = resolveWorkspacePath(workspace, path).replace(/\\/g, "/");
    return original.slice(original.length - (absolute.length - root.length - 1));
  }
  return path.replace(/\\/g, "/");
}
