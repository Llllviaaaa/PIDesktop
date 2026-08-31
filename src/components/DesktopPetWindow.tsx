import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  currentMonitor,
  getAllWindows,
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
  primaryMonitor,
} from "@tauri-apps/api/window";
import type { AppearancePetDefinition, PetAnimationState } from "../lib/appearanceCatalog";
import { PetActionMenu, PetAvatar, usePetInteractionController } from "./PetCompanion";

export const DESKTOP_PET_EVENT = "desktop-pet:update";
export const DESKTOP_PET_STATE_KEY = "pid-desktop:desktop-pet-state:v1";
const DESKTOP_PET_POSITION_KEY = "pid-desktop:desktop-pet-window-position:v1";
const WINDOW_MARGIN = 24;
const COLLAPSED_WINDOW_SIZE = { width: 132, height: 112 };
const EXPANDED_WINDOW_SIZE = { width: 244, height: 228 };

export interface DesktopPetWindowState {
  enabled: boolean;
  pet: AppearancePetDefinition;
  busy: boolean;
  activity: PetAnimationState;
}

const DEFAULT_STATE: DesktopPetWindowState = {
  enabled: true,
  pet: { id: "cat", label: "代码猫", scope: "builtin", builtinCharacter: "cat" },
  busy: false,
  activity: "idle",
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
        activity: isPetAnimationState(parsed.activity) ? parsed.activity : parsed.busy ? "running" : "idle",
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

  useEffect(() => () => {
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
  }, []);

  const resizePetWindow = useCallback(async (expanded: boolean) => {
    if (!petWindow) return;
    const [position, currentSize, scaleFactor, monitor] = await Promise.all([
      petWindow.outerPosition(),
      petWindow.outerSize(),
      petWindow.scaleFactor(),
      currentMonitor(),
    ]);
    const logicalSize = expanded ? EXPANDED_WINDOW_SIZE : COLLAPSED_WINDOW_SIZE;
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
    void resizePetWindow(menuOpen).catch(() => undefined);
  }, [menuOpen, resizePetWindow]);

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
        activity: isPetAnimationState(event.payload.activity)
          ? event.payload.activity
          : event.payload.busy ? "running" : "idle",
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
      return;
    }
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10") || event.key.toLowerCase() === "m") {
      event.preventDefault();
      setMenuOpen((open) => !open);
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

  const scheduleWave = () => {
    if (ignoreClickRef.current) {
      ignoreClickRef.current = false;
      return;
    }
    setMenuOpen(false);
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    clickTimerRef.current = window.setTimeout(() => {
      interactionController.playInteraction("waving", 1_250);
      clickTimerRef.current = null;
    }, 220);
  };

  const jump = () => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    setMenuOpen(false);
    interactionController.playInteraction("jumping", 900);
  };

  const resetPosition = () => {
    setMenuOpen(false);
    void (async () => {
      await resizePetWindow(false);
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

  const openMainWindow = () => {
    setMenuOpen(false);
    interactionController.playInteraction("waving", 1_250, "回到主程序吧");
    void getAllWindows()
      .then(async (windows) => {
        const mainWindow = windows.find((windowHandle) => windowHandle.label === "main");
        if (!mainWindow) return;
        await mainWindow.show();
        await mainWindow.unminimize();
        await mainWindow.setFocus();
      })
      .catch(() => undefined);
  };

  return (
    <main className={`desktop-pet-window pet-${visualClass} pet-state-${animationState}${state.busy ? " busy" : ""}${menuOpen ? " menu-open" : ""}`} aria-label={`${label}${state.busy ? "正在工作" : "空闲"}`}>
      {interactionController.message && !menuOpen && <span className="pet-status" role="status">{interactionController.message}</span>}
      {menuOpen && (
        <PetActionMenu
          onAction={(action) => {
            setMenuOpen(false);
            interactionController.playInteraction(action.state, action.durationMs);
          }}
          onReset={resetPosition}
          onOpenApp={openMainWindow}
        />
      )}
      <button
        type="button"
        className="desktop-pet-button"
        title={label}
        aria-label={`${label}，右键打开互动菜单`}
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
        }}
        onClick={scheduleWave}
        onDoubleClick={jump}
      >
        <PetAvatar pet={state.pet} busy={state.busy} state={animationState} />
      </button>
    </main>
  );
}
