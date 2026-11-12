/**
 * Shared building blocks for Settings pages: layout cards, rows, the switch,
 * the custom select and the shortcut recorder, plus the form defaults.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { DEFAULT_APP_SETTINGS } from "@qianji/protocol";
import type { AppSettings, SettingsDisplayMode } from "../../types";

export function normalizeSettingsDisplayMode(value?: string | null): SettingsDisplayMode {
  return value === "modal" ? "modal" : "page";
}

export function formatShortcutChord(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
): string | null {
  const rawKey = event.key;
  if (!rawKey || ["Control", "Shift", "Alt", "Meta", "Dead", "Unidentified"].includes(rawKey)) {
    return null;
  }
  const isFunctionKey = /^F(?:[1-9]|1[0-2])$/i.test(rawKey);
  const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
  if (!hasModifier && !isFunctionKey) {
    return null;
  }
  const normalizedKey = rawKey === " "
    ? "Space"
    : rawKey.length === 1
      ? rawKey.toUpperCase()
      : isFunctionKey
        ? rawKey.toUpperCase()
        : rawKey;
  return [
    event.ctrlKey || event.metaKey ? "Ctrl" : "",
    event.altKey ? "Alt" : "",
    event.shiftKey ? "Shift" : "",
    normalizedKey,
  ].filter(Boolean).join("+");
}

export function ShortcutRecorder({
  label,
  value,
  defaultValue,
  onChange,
}: {
  label: string;
  value: string;
  defaultValue: string;
  onChange: (next: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const current = value.trim() || defaultValue;
  const isCustom = current.toLowerCase() !== defaultValue.toLowerCase();

  return (
    <div className="settings-shortcut-control">
      <button
        type="button"
        className={`settings-shortcut-recorder${recording ? " is-recording" : ""}`}
        aria-label={label}
        data-shortcut-recorder={recording ? "true" : undefined}
        data-escape-layer={recording ? "" : undefined}
        onClick={() => setRecording((prev) => !prev)}
        onBlur={() => setRecording(false)}
        onKeyDown={(event) => {
          if (!recording) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setRecording(false);
            return;
          }
          if (event.key === "Tab") {
            setRecording(false);
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          const chord = formatShortcutChord(event);
          if (!chord) return;
          onChange(chord);
          setRecording(false);
        }}
      >
        <kbd>{recording ? "按下组合键…" : current}</kbd>
      </button>
      {isCustom && (
        <button
          type="button"
          className="secondary-button settings-inline-btn"
          onClick={() => {
            setRecording(false);
            onChange(defaultValue);
          }}
        >
          恢复默认
        </button>
      )}
    </div>
  );
}

export const DEFAULTS: AppSettings = { ...DEFAULT_APP_SETTINGS };

export const NAV_SPRING = { type: "spring" as const, stiffness: 520, damping: 38, mass: 0.7 };

export type Update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-layered-section">
      <h2>{title}</h2>
      <div className="settings-soft-card">{children}</div>
    </section>
  );
}

export function Row({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <span>
        <strong>{title}</strong>
        {description && <small>{description}</small>}
      </span>
      <div>{children}</div>
    </div>
  );
}

export function SettingsSwitch({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`settings-switch ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

export function SettingsSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const current = options.find((opt) => opt.value === value)?.label ?? value;

  return (
    <div className="settings-custom-select" ref={rootRef}>
      <button
        type="button"
        className="settings-select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{current}</span>
        <ChevronDown size={14} strokeWidth={1.8} />
      </button>
      {open && (
        <div className="settings-select-popover" role="listbox" data-escape-layer>
          {options.map((opt) => {
            const selected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={selected}
                className={selected ? "selected" : ""}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                <span>{opt.label}</span>
                {selected && <Check size={13} strokeWidth={2.2} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
