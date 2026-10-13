import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useSyncOnChange } from "../hooks/useSyncOnChange";
import {
  ArrowUp,
  CircleAlert,
  CircleCheck,
  Coffee,
  ExternalLink,
  EyeOff,
  Hand,
  LoaderCircle,
  OctagonAlert,
  Play,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import type { AppearancePetDefinition, PetAnimationState } from "../lib/appearanceCatalog";
import type { PetActivityItem, PetActivityStatus } from "../lib/petActivity";
import {
  chooseIdlePetAnimation,
  choosePetMessage,
  nextPetIdleDelay,
  PET_ACTIONS,
  type PetActionDefinition,
  type PetActionId,
} from "../lib/petInteractions";
import { PixelPetSvg } from "./PixelPetArt";

const PET_POSITION_KEY = "pid-desktop:pet-position:v1";
const PET_MARGIN = 12;
export const PET_SIZE_MIN = 80;
export const PET_SIZE_MAX = 224;

export function clampPetSize(value: number | undefined): number {
  return Math.min(PET_SIZE_MAX, Math.max(PET_SIZE_MIN, Number(value) || 96));
}

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

function PetSpritesheetAvatar({
  pet,
  spritesheet,
  state,
}: {
  pet: AppearancePetDefinition;
  spritesheet: NonNullable<AppearancePetDefinition["spritesheet"]>;
  state: PetAnimationState;
}) {
  const [frame, setFrame] = useState(0);
  const sequence = spritesheet.states[state] ?? spritesheet.states.idle;

  // A new pet, state or animation starts from its first frame.
  useSyncOnChange([pet.id, sequence.frameDurationMs, sequence.frames, sequence.loop, state], () => setFrame(0));

  useEffect(() => {
    if (sequence.frames <= 1 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => {
      setFrame((current) => current + 1 < sequence.frames ? current + 1 : sequence.loop ? 0 : current);
    }, sequence.frameDurationMs);
    return () => window.clearInterval(timer);
  }, [pet.id, sequence.frameDurationMs, sequence.frames, sequence.loop, state]);

  const positionX = spritesheet.columns <= 1 ? 0 : (frame / (spritesheet.columns - 1)) * 100;
  const positionY = spritesheet.rows <= 1 ? 0 : (sequence.row / (spritesheet.rows - 1)) * 100;
  const style: CSSProperties = {
    width: "auto",
    height: "100%",
    aspectRatio: `${spritesheet.cellWidth} / ${spritesheet.cellHeight}`,
    marginInline: "auto",
    backgroundImage: `url(${pet.assetDataUrl})`,
    backgroundSize: `${spritesheet.columns * 100}% ${spritesheet.rows * 100}%`,
    backgroundPosition: `${positionX}% ${positionY}%`,
  };
  return <span className="pet-avatar pet-avatar-sprite" style={style} aria-hidden="true" />;
}

export function PetAvatar({
  pet,
  busy = false,
  state = busy ? "running" : "idle",
}: {
  pet: AppearancePetDefinition;
  busy?: boolean;
  state?: PetAnimationState;
}) {
  if (pet.assetDataUrl && pet.spritesheet) {
    return <PetSpritesheetAvatar pet={pet} spritesheet={pet.spritesheet} state={state} />;
  }
  if (pet.assetDataUrl) {
    return <img className="pet-avatar pet-avatar-image" src={pet.assetDataUrl} alt="" draggable={false} />;
  }

  const character = pet.builtinCharacter ?? "cat";
  return <PixelPetSvg character={character} state={state} />;
}

export function usePetInteractionController(pet: AppearancePetDefinition, activity: PetAnimationState) {
  const [interaction, setInteraction] = useState<PetAnimationState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const interactionTimerRef = useRef<number | null>(null);
  const messageTimerRef = useRef<number | null>(null);
  const previousActivityRef = useRef(activity);

  const showMessage = useCallback((text: string, durationMs = 2_800) => {
    if (messageTimerRef.current !== null) window.clearTimeout(messageTimerRef.current);
    setMessage(text);
    messageTimerRef.current = window.setTimeout(() => {
      setMessage(null);
      messageTimerRef.current = null;
    }, durationMs);
  }, []);

  const playInteraction = useCallback((state: PetAnimationState, durationMs: number, text?: string) => {
    if (interactionTimerRef.current !== null) window.clearTimeout(interactionTimerRef.current);
    setInteraction(state);
    showMessage(text ?? choosePetMessage(pet, state));
    interactionTimerRef.current = window.setTimeout(() => {
      setInteraction(null);
      interactionTimerRef.current = null;
    }, durationMs);
  }, [pet, showMessage]);

  useEffect(() => {
    const previous = previousActivityRef.current;
    previousActivityRef.current = activity;
    if (previous === activity || activity === "idle") return;
    showMessage(choosePetMessage(pet, activity), activity === "failed" || activity === "waiting" ? 4_200 : 3_200);
  }, [activity, pet, showMessage]);

  useEffect(() => {
    if (activity !== "idle" || interaction !== null) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(() => {
        if (document.visibilityState !== "visible") {
          schedule();
          return;
        }
        const next = chooseIdlePetAnimation(pet);
        if (next) playInteraction(next, next === "jumping" ? 900 : 1_250);
      }, nextPetIdleDelay(pet));
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [activity, interaction, pet, playInteraction]);

  useEffect(() => () => {
    if (interactionTimerRef.current !== null) window.clearTimeout(interactionTimerRef.current);
    if (messageTimerRef.current !== null) window.clearTimeout(messageTimerRef.current);
  }, []);

  return {
    animationState: interaction ?? activity,
    message,
    playInteraction,
    dismissMessage: () => setMessage(null),
  };
}

const ACTION_ICONS: Record<PetActionId, typeof Hand> = {
  wave: Hand,
  jump: ArrowUp,
  focus: Play,
  review: Search,
  rest: Coffee,
};

const ACTIVITY_META: Record<PetActivityStatus, { label: string; icon: typeof CircleAlert }> = {
  "needs-input": { label: "需要输入", icon: CircleAlert },
  blocked: { label: "已阻塞", icon: OctagonAlert },
  ready: { label: "已完成", icon: CircleCheck },
  running: { label: "运行中", icon: LoaderCircle },
};

export function PetActivityTray({
  activities,
  onOpen,
  onClose,
}: {
  activities: PetActivityItem[];
  onOpen: (activity: PetActivityItem) => void;
  onClose: () => void;
}) {
  return (
    <section className="pet-activity-tray" aria-label="宠物活动">
      <header>
        <span>活动</span>
        <small>{activities.length}</small>
        <button type="button" title="收起活动" aria-label="收起活动" onClick={onClose}><X size={14} /></button>
      </header>
      <div className="pet-activity-list" role="list">
        {activities.map((activity) => {
          const meta = ACTIVITY_META[activity.status];
          const Icon = meta.icon;
          return (
            <button
              key={activity.id}
              type="button"
              className={`pet-activity-item status-${activity.status}`}
              role="listitem"
              onClick={() => onOpen(activity)}
            >
              <Icon className={activity.status === "running" ? "spinner-icon" : ""} size={16} />
              <span>
                <strong>{activity.title}</strong>
                <small>{meta.label} · {activity.body}</small>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function PetActionMenu({
  onAction,
  onReset,
  onOpenApp,
  onHide,
}: {
  onAction: (action: PetActionDefinition) => void;
  onReset: () => void;
  onOpenApp?: () => void;
  onHide?: () => void;
}) {
  return (
    <div className="pet-action-menu" role="menu" aria-label="宠物互动">
      {PET_ACTIONS.map((action) => {
        const Icon = ACTION_ICONS[action.id];
        return (
          <button key={action.id} type="button" role="menuitem" onClick={() => onAction(action)}>
            <Icon size={14} />
            <span>{action.label}</span>
          </button>
        );
      })}
      <button type="button" role="menuitem" onClick={onReset}>
        <RotateCcw size={14} />
        <span>归位</span>
      </button>
      {onOpenApp && (
        <button type="button" role="menuitem" className="pet-action-wide" onClick={onOpenApp}>
          <ExternalLink size={14} />
          <span>打开 Pi Desktop</span>
        </button>
      )}
      {onHide && (
        <button type="button" role="menuitem" className="pet-action-wide" onClick={onHide}>
          <EyeOff size={14} />
          <span>关闭宠物</span>
        </button>
      )}
    </div>
  );
}

export function PetCompanion({
  pet,
  busy,
  activity = busy ? "running" : "idle",
  size = 96,
  activities = [],
  onOpenActivity,
  onHide,
}: {
  pet: AppearancePetDefinition;
  busy: boolean;
  activity?: PetAnimationState;
  size?: number;
  activities?: PetActivityItem[];
  onOpenActivity?: (activity: PetActivityItem) => void;
  onHide?: () => void;
}) {
  const rootRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    originX: number;
    originY: number;
    startX: number;
    startY: number;
    lastX: number;
    moved: boolean;
  } | null>(null);
  const ignoreClickRef = useRef(false);
  const clickTimerRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const [position, setPosition] = useState<PetPosition | null>(readPetPosition);
  const [dragging, setDragging] = useState(false);
  const [dragDirection, setDragDirection] = useState<"running-left" | "running-right">("running-right");
  const [menuOpen, setMenuOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const interactionController = usePetInteractionController(pet, activity);
  const petSize = clampPetSize(size);

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
  }, [petSize]);

  useEffect(() => () => {
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutsidePointer = (event: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [menuOpen]);

  const clearLongPress = () => {
    if (longPressTimerRef.current === null) return;
    window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  };

  const moveTo = (next: PetPosition) => {
    const element = rootRef.current;
    if (!element) return;
    setPosition(constrainPetPosition(next, element.offsetWidth, element.offsetHeight));
  };

  const finishDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    clearLongPress();
    dragRef.current = null;
    ignoreClickRef.current = ignoreClickRef.current || drag.moved;
    setDragging(false);
    if (drag.moved) {
      const rect = rootRef.current?.getBoundingClientRect();
      if (rect) savePetPosition({ x: rect.left, y: rect.top });
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const nudgePet = (event: KeyboardEvent<HTMLButtonElement>) => {
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
    const directions: Partial<Record<string, PetPosition>> = {
      ArrowLeft: { x: -8, y: 0 },
      ArrowRight: { x: 8, y: 0 },
      ArrowUp: { x: 0, y: -8 },
      ArrowDown: { x: 0, y: 8 },
    };
    const delta = directions[event.key];
    if (!delta) return;
    event.preventDefault();
    interactionController.playInteraction(
      event.key === "ArrowLeft" ? "running-left" : event.key === "ArrowRight" ? "running-right" : "jumping",
      520,
    );
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

  const resetPosition = () => {
    const element = rootRef.current;
    if (!element) return;
    const next = constrainPetPosition({
      x: window.innerWidth - element.offsetWidth - 24,
      y: window.innerHeight - element.offsetHeight - 28,
    }, element.offsetWidth, element.offsetHeight);
    setPosition(next);
    savePetPosition(next);
    setMenuOpen(false);
    setActivityOpen(false);
    interactionController.playInteraction("idle", 1_200, `${pet.label}回到这里了`);
  };

  const schedulePrimaryAction = () => {
    if (ignoreClickRef.current) {
      ignoreClickRef.current = false;
      return;
    }
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    clickTimerRef.current = window.setTimeout(() => {
      if (activities.length > 0) {
        setMenuOpen(false);
        setActivityOpen((open) => !open);
      } else {
        interactionController.playInteraction("waving", 1_250);
      }
      clickTimerRef.current = null;
    }, 220);
  };

  const jump = () => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    interactionController.playInteraction("jumping", 900);
    setActivityOpen(false);
  };

  const visualClass = pet.builtinCharacter ?? "custom";
  const label = pet.label || "桌面宠物";
  const animationState = dragging ? dragDirection : interactionController.animationState;
  const menuBelow = (position?.y ?? PET_MARGIN) < petSize + 48;
  const menuAlignment = (position?.x ?? PET_MARGIN) < 120
    ? "menu-align-left"
    : (position?.x ?? PET_MARGIN) > window.innerWidth - 252
      ? "menu-align-right"
      : "";
  const rootStyle = {
    ...(position ? { left: position.x, top: position.y } : {}),
    "--pet-size": `${petSize}px`,
  } as CSSProperties;

  return (
    <aside
      ref={rootRef}
      className={`desktop-pet pet-${visualClass} pet-state-${animationState}${busy ? " busy" : ""}${dragging ? " dragging" : ""}${menuOpen ? " menu-open" : ""}${activityOpen ? " activity-open" : ""}${(menuOpen || activityOpen) && menuBelow ? " menu-below" : ""}${(menuOpen || activityOpen) && menuAlignment ? ` ${menuAlignment}` : ""}`}
      style={rootStyle}
      aria-label={`${label}${busy ? "正在工作" : "空闲"}`}
    >
      {interactionController.message && !menuOpen && <span className="pet-status" role="status">{interactionController.message}</span>}
      {menuOpen && (
        <PetActionMenu
          onAction={(action) => {
            setMenuOpen(false);
            interactionController.playInteraction(action.state, action.durationMs);
          }}
          onReset={resetPosition}
          onHide={onHide}
        />
      )}
      {activityOpen && activities.length > 0 && (
        <PetActivityTray
          activities={activities}
          onClose={() => setActivityOpen(false)}
          onOpen={(item) => {
            setActivityOpen(false);
            onOpenActivity?.(item);
          }}
        />
      )}
      <button
        type="button"
        className="desktop-pet-button"
        title={label}
        aria-label={activities.length > 0 ? `${label}，单击查看活动，右键打开菜单` : `${label}，右键打开互动菜单`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
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
            lastX: event.clientX,
            moved: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          if (event.pointerType !== "mouse") {
            longPressTimerRef.current = window.setTimeout(() => {
              ignoreClickRef.current = true;
              setMenuOpen(true);
              longPressTimerRef.current = null;
            }, 560);
          }
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          const deltaX = event.clientX - drag.startX;
          const deltaY = event.clientY - drag.startY;
          if (Math.abs(deltaX) + Math.abs(deltaY) > 4) {
            if (!drag.moved) {
              drag.moved = true;
              clearLongPress();
              setDragging(true);
              setMenuOpen(false);
              setActivityOpen(false);
            }
            if (Math.abs(event.clientX - drag.lastX) > 1) {
              setDragDirection(event.clientX < drag.lastX ? "running-left" : "running-right");
            }
          }
          drag.lastX = event.clientX;
          if (drag.moved) moveTo({ x: drag.originX + deltaX, y: drag.originY + deltaY });
        }}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onKeyDown={nudgePet}
        onContextMenu={(event) => {
          event.preventDefault();
          clearLongPress();
          setMenuOpen((open) => !open);
          setActivityOpen(false);
        }}
        onClick={schedulePrimaryAction}
        onDoubleClick={jump}
      >
        <PetAvatar pet={pet} busy={busy} state={animationState} />
        {activities.length > 0 && (
          <span className={`pet-activity-badge status-${activities[0].status}`} aria-hidden="true">
            {Math.min(9, activities.length)}
          </span>
        )}
      </button>
    </aside>
  );
}
