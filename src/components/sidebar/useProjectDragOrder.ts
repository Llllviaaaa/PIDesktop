import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { reorderSidebarWorkspaces, type SidebarOrder } from "../../lib/sidebarProjectOrder";
import type { ProjectConfig, SessionInfo } from "../../types";
import { pathsEqual, sameOrder, type ProjectDropTarget } from "./sidebarHelpers";

export interface UseProjectDragOrderOptions {
  sidebarRef: React.RefObject<HTMLElement | null>;
  trimmedQuery: string;
  groups: Array<[string, SessionInfo[]]>;
  projectConfig: (workspace: string) => ProjectConfig;
  sidebarOrder: SidebarOrder;
  setPersistedOrder: React.Dispatch<React.SetStateAction<SidebarOrder>>;
  closePopovers: () => void;
}

export function useProjectDragOrder({
  sidebarRef,
  trimmedQuery,
  groups,
  projectConfig,
  sidebarOrder,
  setPersistedOrder,
  closePopovers,
}: UseProjectDragOrderOptions) {
  const [draggingWorkspace, setDraggingWorkspace] = useState<string | null>(null);
  const [projectDropTarget, setProjectDropTarget] = useState<ProjectDropTarget | null>(null);
  const suppressProjectClickRef = useRef(false);
  const projectDragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    projectDragCleanupRef.current?.();
  }, []);

  const startProjectDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    workspace: string,
    pinned: boolean,
  ) => {
    if (event.button !== 0 || Boolean(trimmedQuery) || groups.length < 2) return;
    if ((event.target as Element | null)?.closest(".project-actions, .project-collapse-toggle, .project-rename-editor")) return;
    projectDragCleanupRef.current?.();
    const startY = event.clientY;
    const baselineGroupOrder = groups
      .filter(([candidate]) => projectConfig(candidate).pinned === pinned)
      .map(([candidate]) => candidate);
    if (baselineGroupOrder.length < 2) return;

    let started = false;
    let latestDrop: ProjectDropTarget | null = null;

    const cleanup = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("keydown", onKeyDown, true);
      if (projectDragCleanupRef.current === cleanup) projectDragCleanupRef.current = null;
      setDraggingWorkspace(null);
      setProjectDropTarget(null);
    };

    const computeDropTarget = (clientY: number): ProjectDropTarget | null => {
      const container = sidebarRef.current;
      if (!container) return null;
      const blocks = Array.from(container.querySelectorAll<HTMLElement>(".project-block[data-workspace]"))
        .filter((block) => (block.dataset.pinned === "true") === pinned && Boolean(block.dataset.workspace));
      if (blocks.length < 2) return null;

      let candidate: ProjectDropTarget | null = null;
      for (const block of blocks) {
        const rect = block.getBoundingClientRect();
        const blockWorkspace = block.dataset.workspace ?? "";
        if (clientY <= rect.top + rect.height / 2) {
          candidate = { workspace: blockWorkspace, position: "before" };
          break;
        }
      }
      if (!candidate) {
        const lastWorkspace = blocks[blocks.length - 1]?.dataset.workspace ?? "";
        candidate = lastWorkspace ? { workspace: lastWorkspace, position: "after" } : null;
      }
      if (!candidate || pathsEqual(candidate.workspace, workspace)) return null;
      const reordered = reorderSidebarWorkspaces(baselineGroupOrder, workspace, candidate.workspace, candidate.position);
      const baselineNormalized = reorderSidebarWorkspaces(baselineGroupOrder, workspace, workspace, "before");
      return sameOrder(reordered, baselineNormalized) ? null : candidate;
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (!started) {
        if (Math.abs(moveEvent.clientY - startY) < 5) return;
        started = true;
        suppressProjectClickRef.current = true;
        setDraggingWorkspace(workspace);
        closePopovers();
      }
      moveEvent.preventDefault();
      const nextDrop = computeDropTarget(moveEvent.clientY);
      latestDrop = nextDrop;
      setProjectDropTarget((current) => (
        current?.workspace === nextDrop?.workspace && current?.position === nextDrop?.position
          ? current
          : nextDrop
      ));
    };

    const finishDrag = (commit: boolean) => {
      const shouldCommit = commit && started && latestDrop !== null;
      const drop = latestDrop;
      cleanup();
      if (started) {
        window.setTimeout(() => {
          suppressProjectClickRef.current = false;
        }, 0);
      }
      if (shouldCommit && drop) {
        const allWorkspaces = [...sidebarOrder.workspaces, ...groups.map(([item]) => item)];
        const nextWorkspaces = reorderSidebarWorkspaces(allWorkspaces, workspace, drop.workspace, drop.position);
        setPersistedOrder((current) => ({ ...current, workspaces: nextWorkspaces }));
      }
    };

    const onPointerUp = () => finishDrag(true);
    const onPointerCancel = () => finishDrag(false);
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape" && started) {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        finishDrag(false);
      }
    };

    projectDragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("keydown", onKeyDown, true);
  };

  const consumeSuppressedProjectClick = () => {
    if (!suppressProjectClickRef.current) return false;
    suppressProjectClickRef.current = false;
    return true;
  };

  return {
    draggingWorkspace,
    projectDropTarget,
    consumeSuppressedProjectClick,
    startProjectDrag,
  };
}
