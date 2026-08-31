import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import {
  currentMonitor,
  getAllWindows,
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
  primaryMonitor,
} from "@tauri-apps/api/window";
import type { AppearancePetDefinition, PetAnimationState } from "../lib/appearanceCatalog";
import type { PetActivityItem } from "../lib/petActivity";
import { clampPetSize, PetActionMenu, PetActivityTray, PetAvatar, usePetInteractionController } from "./PetCompanion";

export const DESKTOP_PET_EVENT = "desktop-pet:update";
export const DESKTOP_PET_NAVIGATE_EVENT = "desktop-pet:navigate";
export const DESKTOP_PET_DISABLE_EVENT = "desktop-pet:disable";
export const DESKTOP_PET_STATE_KEY = "pid-desktop:desktop-pet-state:v1";
const DESKTOP_PET_POSITION_KEY = "pid-desktop:desktop-pet-window-position:v1";
const WINDOW_MARGIN = 24;

type PetPanel = "menu" | "activity" | null;

export interface DesktopPetNavigationRequest {
  notificationId?: string;
  cwd: string;
  sessionFile: string | null;
}

export interface DesktopPetWindowState {
  enabled: boolean;
  pet: AppearancePetDefinition;
  petSize: number;
  busy: boolean;
  activity: PetAnimationState;
  activities: PetActivityItem[];
}

const DEFAULT_STATE: DesktopPetWindowState = {
  enabled: true,
  pet: { id: "cat", label: "代码猫", scope: "builtin", builtinCharacter: "cat" },
  petSize: 96,
  busy: false,
  activity: "idle",
  activities: [],
};

function isPetAnimationState(value: unknown): value is PetAnimationState {
  return ["idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review"].includes(String(value));
}

function readState(): DesktopPetWindowState {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DESKTOP_PET_STATE_KEY) || "null") as DesktopPetWindowState | null;
    if (parsed?.pet?.id && typeof parsed.busy === "boolean") {
      return {
        ...parsed,
        petSize: clampPetSize(parsed.petSize),
        activity: isPetAnimationState(parsed.activity) ? parsed.activity : parsed.busy ? "running" : "idle",
        activities: Array.isArray(parsed.activities) ? parsed.activities : [],
      };
    }
  } catch {
    // Ignore stale local UI state and wait for the main window update.
  }
  return DEFAULT_STATE;
}

function readPosition(): PhysicalPosition | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DESKTOP_PET_POSITION_KEY) || "null") as { x?: number; y?: number } | null;
    if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
      return new PhysicalPosition(Number(parsed.x), Number(parsed.y));
    }
  } catch {
    // Ignore stale or malformed window coordinates.
  }
  return null;
}

function savePosition(position: PhysicalPosition): void {
  window.localStorage.setItem(DESKTOP_PET_POSITION_KEY, JSON.stringify({ x: position.x, y: position.y }));
}

export function DesktopPetWindow() {
  const [state, setState] = useState(readState);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; started: boolean } | null>(null);
  const ignoreClickRef = useRef(false);
  const clickTimerRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const isTauri = "__TAURI_INTERNALS__" in window;
  const petWindow = useMemo(() => isTauri ? getCurrentWindow() : null, [isTauri]);
  const visualClass = state.pet.builtinCharacter ?? "custom";
  const label = state.pet.label || "桌面宠物";
  const interactionController = usePetInteractionController(state.pet, state.activity);
  const animationState = interactionController.animationState;
  const petSize = clampPetSize(state.petSize);

  useEffect(() => () => {
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
  }, []);

  const resizePetWindow = useCallback(async (panel: PetPanel, size: number) => {
    if (!petWindow) return;
    const [position, currentSize, scaleFactor, monitor] = await Promise.all([
      petWindow.outerPosition(),
      petWindow.outerSize(),
      petWindow.scaleFactor(),
      currentMonitor(),
    ]);
    const collapsedSize = { width: size + 48, height: size + 28 };
    const logicalSize = panel === "activity"
      ? { width: Math.max(320, collapsedSize.width), height: size + 286 }
      : panel === "menu"
        ? { width: Math.max(280, collapsedSize.width), height: size + 158 }
        : collapsedSize;
    const targetSize = new PhysicalSize(
      Math.round(logicalSize.width * scaleFactor),
      Math.round(logicalSize.height * scaleFactor),
    );
    if (currentSize.width === targetSize.width && currentSize.height === targetSize.height) return;
    let x = position.x + currentSize.width - targetSize.width;
    let y = position.y + currentSize.height - targetSize.height;
    if (monitor) {
      const area = monitor.workArea;
      x = Math.min(area.position.x + area.size.width - targetSize.width, Math.max(area.position.x, x));
      y = Math.min(area.position.y + area.size.height - targetSize.height, Math.max(area.position.y, y));
    }
    await petWindow.setSize(targetSize);
    await petWindow.setPosition(new PhysicalPosition(x, y));
  }, [petWindow]);

  useEffect(() => {
    const panel: PetPanel = activityOpen ? "activity" : menuOpen ? "menu" : null;
    void resizePetWindow(panel, petSize).catch(() => undefined);
  }, [activityOpen, menuOpen, petSize, resizePetWindow]);

  useEffect(() => {
    document.documentElement.classList.add("desktop-pet-document");
    document.body.classList.add("desktop-pet-document");
    return () => {
      document.documentElement.classList.remove("desktop-pet-document");
      document.body.classList.remove("desktop-pet-document");
    };
  }, []);

  useEffect(() => {
    if (!petWindow) return;
    let disposed = false;
    let stopMoved: (() => void) | undefined;
    let stopUpdated: (() => void) | undefined;
    void (async () => {
      const monitor = await primaryMonitor();
      const size = await petWindow.outerSize();
      const saved = readPosition();
      if (monitor) {
        const area = monitor.workArea;
        const margin = Math.round(WINDOW_MARGIN * monitor.scaleFactor);
        const maxX = area.position.x + area.size.width - size.width;
        const maxY = area.position.y + area.size.height - size.height;
        const initial = saved ?? new PhysicalPosition(maxX - margin, maxY - margin);
        await petWindow.setPosition(new PhysicalPosition(
          Math.min(maxX, Math.max(area.position.x, initial.x)),
          Math.min(maxY, Math.max(area.position.y, initial.y)),
        ));
      } else if (saved) {
        await petWindow.setPosition(saved);
      }
      stopMoved = await petWindow.onMoved(({ payload }) => savePosition(payload));
      stopUpdated = await listen<DesktopPetWindowState>(DESKTOP_PET_EVENT, (event) => setState({
        ...event.payload,
        petSize: clampPetSize(event.payload.petSize),
        activity: isPetAnimationState(event.payload.activity)
          ? event.payload.activity
          : event.payload.busy ? "running" : "idle",
        activities: Array.isArray(event.payload.activities) ? event.payload.activities : [],
      }));
      if (disposed) {
        stopMoved();
        stopUpdated();
      }
    })().catch(() => undefined);
    return () => {
      disposed = true;
      stopMoved?.();
      stopUpdated?.();
    };
  }, [petWindow]);

  const nudgeWindow = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      setMenuOpen(false);
      setActivityOpen(false);
      return;
    }
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10") || event.key.toLowerCase() === "m") {
      event.preventDefault();
      setMenuOpen((open) => !open);
      setActivityOpen(false);
      return;
    }
    const deltas: Partial<Record<string, { x: number; y: number }>> = {
      ArrowLeft: { x: -8, y: 0 },
      ArrowRight: { x: 8, y: 0 },
      ArrowUp: { x: 0, y: -8 },
      ArrowDown: { x: 0, y: 8 },
    };
    const delta = deltas[event.key];
    if (!delta || !petWindow) return;
    event.preventDefault();
    interactionController.playInteraction(
      event.key === "ArrowLeft" ? "running-left" : event.key === "ArrowRight" ? "running-right" : "jumping",
      520,
    );
    void petWindow.outerPosition()
      .then((position) => petWindow.setPosition(new PhysicalPosition(position.x + delta.x, position.y + delta.y)))
      .catch(() => undefined);
  };

  const beginDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !petWindow) return;
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.pointerType !== "mouse") {
      longPressTimerRef.current = window.setTimeout(() => {
        ignoreClickRef.current = true;
        setMenuOpen(true);
        longPressTimerRef.current = null;
      }, 560);
    }
  };

  const continueDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.started || !petWindow) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaX) + Math.abs(deltaY) <= 4) return;
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    drag.started = true;
    ignoreClickRef.current = true;
    setMenuOpen(false);
    setActivityOpen(false);
    interactionController.playInteraction(deltaX < 0 ? "running-left" : "running-right", 720);
    void petWindow.startDragging().catch(() => undefined);
  };

  const finishDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const schedulePrimaryAction = () => {
    if (ignoreClickRef.current) {
      ignoreClickRef.current = false;
      return;
    }
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    clickTimerRef.current = window.setTimeout(() => {
      if (state.activities.length > 0) {
        setMenuOpen(false);
        setActivityOpen((open) => !open);
      } else {
        openMainWindow();
      }
      clickTimerRef.current = null;
    }, 220);
  };

  const jump = () => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    setMenuOpen(false);
    setActivityOpen(false);
    interactionController.playInteraction("jumping", 900);
  };

  const resetPosition = () => {
    setMenuOpen(false);
    setActivityOpen(false);
    void (async () => {
      await resizePetWindow(null, petSize);
      if (!petWindow) return;
      const monitor = await primaryMonitor();
      if (!monitor) return;
      const size = await petWindow.outerSize();
      const area = monitor.workArea;
      const margin = Math.round(WINDOW_MARGIN * monitor.scaleFactor);
      await petWindow.setPosition(new PhysicalPosition(
        area.position.x + area.size.width - size.width - margin,
        area.position.y + area.size.height - size.height - margin,
      ));
      interactionController.playInteraction("idle", 1_200, `${label}回到这里了`);
    })().catch(() => undefined);
  };

  const focusMainWindow = async () => {
    const windows = await getAllWindows();
    const mainWindow = windows.find((windowHandle) => windowHandle.label === "main");
    if (!mainWindow) return;
    await mainWindow.show();
    await mainWindow.unminimize();
    await mainWindow.setFocus();
  };

  const openMainWindow = () => {
    setMenuOpen(false);
    setActivityOpen(false);
    interactionController.playInteraction("waving", 1_250, "回到主程序吧");
    void focusMainWindow().catch(() => undefined);
  };

  const openActivity = (activity: PetActivityItem) => {
    setActivityOpen(false);
    void focusMainWindow()
      .then(() => emitTo<DesktopPetNavigationRequest>("main", DESKTOP_PET_NAVIGATE_EVENT, {
        notificationId: activity.notificationId,
        cwd: activity.cwd,
        sessionFile: activity.sessionFile,
      }))
      .catch(() => undefined);
  };

  const hidePet = () => {
    setMenuOpen(false);
    setActivityOpen(false);
    void emitTo("main", DESKTOP_PET_DISABLE_EVENT, {})
      .then(() => petWindow?.hide())
      .catch(() => undefined);
  };

  const rootStyle = { "--pet-size": `${petSize}px` } as CSSProperties;

  return (
    <main className={`desktop-pet-window pet-${visualClass} pet-state-${animationState}${state.busy ? " busy" : ""}${menuOpen ? " menu-open" : ""}${activityOpen ? " activity-open" : ""}`} style={rootStyle} aria-label={`${label}${state.busy ? "正在工作" : "空闲"}`}>
      {interactionController.message && !menuOpen && !activityOpen && <span className="pet-status" role="status">{interactionController.message}</span>}
      {menuOpen && (
        <PetActionMenu
          onAction={(action) => {
            setMenuOpen(false);
            interactionController.playInteraction(action.state, action.durationMs);
          }}
          onReset={resetPosition}
          onOpenApp={openMainWindow}
          onHide={hidePet}
        />
      )}
      {activityOpen && state.activities.length > 0 && (
        <PetActivityTray
          activities={state.activities}
          onClose={() => setActivityOpen(false)}
          onOpen={openActivity}
        />
      )}
      <button
        type="button"
        className="desktop-pet-button"
        title={label}
        aria-label={`${label}，单击查看活动，右键打开菜单`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onPointerDown={beginDrag}
        onPointerMove={continueDrag}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onKeyDown={nudgeWindow}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenuOpen((open) => !open);
          setActivityOpen(false);
        }}
        onClick={schedulePrimaryAction}
        onDoubleClick={jump}
      >
        <PetAvatar pet={state.pet} busy={state.busy} state={animationState} />
        {state.activities.length > 0 && (
          <span className={`pet-activity-badge status-${state.activities[0].status}`} aria-hidden="true">
            {Math.min(9, state.activities.length)}
          </span>
        )}
      </button>
    </main>
  );
}
