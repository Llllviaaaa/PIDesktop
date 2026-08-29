import { useEffect, useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, PhysicalPosition, primaryMonitor } from "@tauri-apps/api/window";
import type { AppearancePetDefinition } from "../lib/appearanceCatalog";
import { PetAvatar } from "./PetCompanion";

export const DESKTOP_PET_EVENT = "desktop-pet:update";
export const DESKTOP_PET_STATE_KEY = "pid-desktop:desktop-pet-state:v1";
const DESKTOP_PET_POSITION_KEY = "pid-desktop:desktop-pet-window-position:v1";
const WINDOW_MARGIN = 24;

export interface DesktopPetWindowState {
  enabled: boolean;
  pet: AppearancePetDefinition;
  busy: boolean;
}

const DEFAULT_STATE: DesktopPetWindowState = {
  enabled: true,
  pet: { id: "cat", label: "代码猫", scope: "builtin", builtinCharacter: "cat" },
  busy: false,
};

function readState(): DesktopPetWindowState {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DESKTOP_PET_STATE_KEY) || "null") as DesktopPetWindowState | null;
    if (parsed?.pet?.id && typeof parsed.busy === "boolean") return parsed;
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
  const isTauri = "__TAURI_INTERNALS__" in window;
  const petWindow = useMemo(() => isTauri ? getCurrentWindow() : null, [isTauri]);
  const visualClass = state.pet.builtinCharacter ?? "custom";
  const label = state.pet.label || "桌面宠物";

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
      stopUpdated = await listen<DesktopPetWindowState>(DESKTOP_PET_EVENT, (event) => setState(event.payload));
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
    const deltas: Partial<Record<string, { x: number; y: number }>> = {
      ArrowLeft: { x: -8, y: 0 },
      ArrowRight: { x: 8, y: 0 },
      ArrowUp: { x: 0, y: -8 },
      ArrowDown: { x: 0, y: 8 },
    };
    const delta = deltas[event.key];
    if (!delta || !petWindow) return;
    event.preventDefault();
    void petWindow.outerPosition()
      .then((position) => petWindow.setPosition(new PhysicalPosition(position.x + delta.x, position.y + delta.y)))
      .catch(() => undefined);
  };

  const beginDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !petWindow) return;
    event.preventDefault();
    void petWindow.startDragging().catch(() => undefined);
  };

  return (
    <main className={`desktop-pet-window pet-${visualClass}${state.busy ? " busy" : ""}`} aria-label={`${label}${state.busy ? "正在工作" : "空闲"}`}>
      <button
        type="button"
        className="desktop-pet-button"
        title={`${label} · 拖动改变桌面位置`}
        aria-label={`${label}，可拖动改变桌面位置`}
        onPointerDown={beginDrag}
        onKeyDown={nudgeWindow}
      >
        <PetAvatar pet={state.pet} busy={state.busy} />
      </button>
    </main>
  );
}
