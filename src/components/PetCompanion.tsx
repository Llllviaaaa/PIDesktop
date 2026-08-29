import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { AppearancePetDefinition } from "../lib/appearanceCatalog";

const PET_POSITION_KEY = "pid-desktop:pet-position:v1";
const PET_MARGIN = 12;

interface PetPosition {
  x: number;
  y: number;
}

function readPetPosition(): PetPosition | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PET_POSITION_KEY) || "null") as Partial<PetPosition> | null;
    if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
      return { x: Number(parsed.x), y: Number(parsed.y) };
    }
  } catch {
    // Ignore stale or malformed local UI state.
  }
  return null;
}

function constrainPetPosition(position: PetPosition, width: number, height: number): PetPosition {
  return {
    x: Math.min(Math.max(PET_MARGIN, position.x), Math.max(PET_MARGIN, window.innerWidth - width - PET_MARGIN)),
    y: Math.min(Math.max(PET_MARGIN, position.y), Math.max(PET_MARGIN, window.innerHeight - height - PET_MARGIN)),
  };
}

function savePetPosition(position: PetPosition): void {
  window.localStorage.setItem(PET_POSITION_KEY, JSON.stringify(position));
}

export function PetAvatar({ pet, busy = false }: { pet: AppearancePetDefinition; busy?: boolean }) {
  if (pet.assetDataUrl) {
    return <img className="pet-avatar pet-avatar-image" src={pet.assetDataUrl} alt="" draggable={false} />;
  }

  const character = pet.builtinCharacter ?? "cat";
  if (character === "robot") {
    return (
      <svg className="pet-avatar" viewBox="0 0 96 96" aria-hidden="true">
        <path className="pet-shadow" d="M19 82c0-6 13-10 29-10s29 4 29 10-13 8-29 8-29-2-29-8Z" />
        <path className="pet-accent" d="M47 13h3v10h-3z" />
        <circle className="pet-accent" cx="49" cy="11" r="5" />
        <rect className="pet-body" x="21" y="23" width="55" height="54" rx="18" />
        <rect className="pet-face" x="28" y="31" width="41" height="29" rx="11" />
        <circle className="pet-eye pet-eye-left" cx="41" cy="45" r="4" />
        <circle className="pet-eye pet-eye-right" cx="57" cy="45" r="4" />
        <path className="pet-line" d="M42 54c4 3 9 3 13 0" />
        <path className="pet-line" d="M28 67h42M34 76v7m29-7v7" />
        {busy && <path className="pet-signal" d="M79 28c5 4 7 9 7 15M82 20c8 6 12 14 12 23" />}
      </svg>
    );
  }

  if (character === "fox") {
    return (
      <svg className="pet-avatar" viewBox="0 0 96 96" aria-hidden="true">
        <path className="pet-shadow" d="M16 82c0-6 14-10 32-10s32 4 32 10-14 8-32 8-32-2-32-8Z" />
        <path className="pet-tail" d="M69 58c19 4 21 20 7 26-8 4-17 0-20-6 12 2 18-5 13-20Z" />
        <path className="pet-body" d="M24 38 20 15l22 15h12l22-15-4 23c8 6 10 18 6 28-5 12-16 18-30 18S23 78 18 66c-4-10-2-22 6-28Z" />
        <path className="pet-face" d="M28 47c6-8 12-11 20-11s15 3 20 11c-3 19-10 28-20 28s-17-9-20-28Z" />
        <path className="pet-ear" d="m25 23 12 9-13 5Zm46 0-12 9 13 5Z" />
        <circle className="pet-eye pet-eye-left" cx="38" cy="51" r="3.5" />
        <circle className="pet-eye pet-eye-right" cx="58" cy="51" r="3.5" />
        <path className="pet-nose" d="M44 61h8l-4 5Z" />
        <path className="pet-line" d="M48 66c-2 4-6 5-9 3m9-3c2 4 6 5 9 3" />
      </svg>
    );
  }

  return (
    <svg className="pet-avatar" viewBox="0 0 96 96" aria-hidden="true">
      <path className="pet-shadow" d="M17 82c0-6 14-10 31-10s31 4 31 10-14 8-31 8-31-2-31-8Z" />
      <path className="pet-tail pet-line" d="M72 63c16-1 18 17 7 19-6 1-8-4-5-7" />
      <path className="pet-body" d="M24 36 23 16l17 13c3-1 6-2 9-2s6 1 9 2l17-13-2 21c7 7 9 17 6 27-4 13-15 20-30 20S23 77 19 64c-3-10-1-21 5-28Z" />
      <path className="pet-ear" d="m28 24 9 7-10 4Zm41 0-9 7 10 4Z" />
      <path className="pet-face" d="M29 47c6-8 12-11 20-11s14 3 20 11v16c-5 9-11 13-20 13s-15-4-20-13Z" />
      <circle className="pet-eye pet-eye-left" cx="39" cy="52" r="3.5" />
      <circle className="pet-eye pet-eye-right" cx="59" cy="52" r="3.5" />
      <path className="pet-nose" d="M45 61h8l-4 5Z" />
      <path className="pet-line" d="M49 66c-2 4-6 5-9 3m9-3c2 4 6 5 9 3M33 61l-10-2m11 6-11 2m42-6 10-2m-11 6 11 2" />
    </svg>
  );
}

export function PetCompanion({ pet, busy }: { pet: AppearancePetDefinition; busy: boolean }) {
  const rootRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    originX: number;
    originY: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const ignoreClickRef = useRef(false);
  const [position, setPosition] = useState<PetPosition | null>(readPetPosition);
  const [dragging, setDragging] = useState(false);
  const [showStatus, setShowStatus] = useState(false);

  useEffect(() => {
    const keepOnScreen = () => {
      const element = rootRef.current;
      if (!element) return;
      setPosition((current) => {
        const initial = current ?? {
          x: window.innerWidth - element.offsetWidth - 24,
          y: window.innerHeight - element.offsetHeight - 28,
        };
        const next = constrainPetPosition(initial, element.offsetWidth, element.offsetHeight);
        savePetPosition(next);
        return next;
      });
    };
    keepOnScreen();
    window.addEventListener("resize", keepOnScreen);
    return () => window.removeEventListener("resize", keepOnScreen);
  }, []);

  useEffect(() => {
    if (!showStatus) return;
    const timer = window.setTimeout(() => setShowStatus(false), 2200);
    return () => window.clearTimeout(timer);
  }, [showStatus, busy]);

  const moveTo = (next: PetPosition) => {
    const element = rootRef.current;
    if (!element) return;
    setPosition(constrainPetPosition(next, element.offsetWidth, element.offsetHeight));
  };

  const finishDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    ignoreClickRef.current = drag.moved;
    setDragging(false);
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) savePetPosition({ x: rect.left, y: rect.top });
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const nudgePet = (event: KeyboardEvent<HTMLButtonElement>) => {
    const directions: Partial<Record<string, PetPosition>> = {
      ArrowLeft: { x: -8, y: 0 },
      ArrowRight: { x: 8, y: 0 },
      ArrowUp: { x: 0, y: -8 },
      ArrowDown: { x: 0, y: 8 },
    };
    const delta = directions[event.key];
    if (!delta) return;
    event.preventDefault();
    const rect = rootRef.current?.getBoundingClientRect();
    const current = position ?? { x: rect?.left ?? PET_MARGIN, y: rect?.top ?? PET_MARGIN };
    const element = rootRef.current;
    if (!element) return;
    const next = constrainPetPosition(
      { x: current.x + delta.x, y: current.y + delta.y },
      element.offsetWidth,
      element.offsetHeight,
    );
    moveTo(next);
    savePetPosition(next);
  };

  const visualClass = pet.builtinCharacter ?? "custom";
  const label = pet.label || "桌面宠物";

  return (
    <aside
      ref={rootRef}
      className={`desktop-pet pet-${visualClass}${busy ? " busy" : ""}${dragging ? " dragging" : ""}`}
      style={position ? { left: position.x, top: position.y } : undefined}
      aria-label={`${label}${busy ? "正在工作" : "空闲"}`}
    >
      {showStatus && <span className="pet-status" role="status">{busy ? "正在跟进任务" : "准备就绪"}</span>}
      <button
        type="button"
        className="desktop-pet-button"
        title={`${label} · 拖动改变位置`}
        aria-label={`${label}，可拖动改变位置`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const rect = rootRef.current?.getBoundingClientRect();
          if (!rect) return;
          dragRef.current = {
            pointerId: event.pointerId,
            originX: rect.left,
            originY: rect.top,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          const deltaX = event.clientX - drag.startX;
          const deltaY = event.clientY - drag.startY;
          if (Math.abs(deltaX) + Math.abs(deltaY) > 4) drag.moved = true;
          moveTo({ x: drag.originX + deltaX, y: drag.originY + deltaY });
        }}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onKeyDown={nudgePet}
        onClick={() => {
          if (ignoreClickRef.current) {
            ignoreClickRef.current = false;
            return;
          }
          setShowStatus((visible) => !visible);
        }}
      >
        <PetAvatar pet={pet} busy={busy} />
      </button>
    </aside>
  );
}
