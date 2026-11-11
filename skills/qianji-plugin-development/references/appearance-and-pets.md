# Appearance Themes & Desktop Pet Overlays

Qianji supports hot-swappable color themes and interactive floating overlays (such as desktop pets or ambient companions) through standard Client plugins (`client.tsx` without any Host `index.ts` required).

---

## 1. Registering a Custom Appearance Theme

Use `ctx.contributions.registerTheme(theme)` inside `client.tsx` to add a selectable skin to **Settings → Appearance**:

```tsx
import type { Context } from "@deepseek-ai/cordis";

export const name = "nordic-aurora-theme";
export const inject = ["contributions"];

export function apply(ctx: Context): void {
  ctx.contributions.registerTheme({
    id: "nordic-aurora",
    label: "Nordic Aurora",
    mode: "dark",
    palette: {
      app: "#191d24",
      canvas: "#1e222a",
      sidebar: "#161920",
      panel: "#242933",
      panelSoft: "#292f3b",
      panelStrong: "#2e3440",
      hover: "rgba(136, 192, 208, 0.10)",
      active: "rgba(136, 192, 208, 0.16)",
      border: "#3b4252",
      borderStrong: "#434c5e",
      text: "#eceff4",
      text2: "#d8dee9",
      text3: "#9aa5b8",
      accent: "#88c0d0",
      accentSoft: "rgba(136, 192, 208, 0.16)",
      accentContrast: "#161920",
      codeBg: "#1b1f27",
    },
  });
}
```

### `AppearanceThemeInput` Fields
- `id`: Unique theme identifier (persisted in `settings.appearanceThemeId`).
- `label`: Display name shown in Settings → Appearance.
- `mode`: `"dark" | "light" | "system"`.
- `scope?`: Optional `"user" | "workspace" | "builtin"` (defaults to `"user"`).
- `palette?`: Optional `ThemePalette` keys (`app`, `canvas`, `sidebar`, `panel`, `panelSoft`, `panelStrong`, `hover`, `active`, `border`, `borderStrong`, `text`, `text2`, `text3`, `accent`, `accentSoft`, `accentContrast`, `success`, `warning`, `danger`, `info`, `codeBg`, `fontUi`, `fontCode`, `shadowSm`, `shadowMd`, `shadowLg`), which automatically populate both host variables and `--qj-*` semantic tokens!

Alternatively, drop a standalone `.json` theme file into `~/.qianji/themes/` or `<workspace>/.qianji/themes/` for zero-code palette customization.

---

## 2. Building a Desktop Pet / Floating Companion (`overlays` Slot)

Floating pets and ambient widgets mount into `ctx.contributions.registerOverlay(...)`.

### Mandatory Pointer-Event Safety Rule
The `.plugin-overlays-host` container enforces `pointer-events: none` so a broken or full-viewport overlay wrapper **can never block clicks on Qianji's chat or workbench**.
- **DO**: Keep your outer positioning container `pointer-events: none` and set `pointer-events: auto` **only** on the compact pet sprite or speech bubble (`<= 160px` footprint).
- **NEVER**: Set `pointer-events: auto` on a `position: fixed; inset: 0` wrapper unless an active modal dialog is open with an explicit Close / `Escape` handler.

```tsx
import { useEffect, useState } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { subscribeSessionActivity, useActiveSession, usePluginConfig } from "@qianji/client";

interface PetConfig {
  petName: string;
}

const PET_CSS = `
.pet-dock {
  position: fixed;
  right: 20px;
  bottom: 52px;
  z-index: 60;
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-elevated);
  color: var(--qj-text-primary);
  box-shadow: var(--qj-shadow-md);
  font-size: 12px;
  user-select: none;
  cursor: pointer;
}
`;

function CompanionPet() {
  const session = useActiveSession();
  const config = usePluginConfig<PetConfig>("companion-pet", { petName: "Mochi" });
  const [mood, setMood] = useState<"idle" | "working">("idle");

  useEffect(() => {
    setMood(session.isStreaming ? "working" : "idle");
    return subscribeSessionActivity((snap) => {
      setMood(snap.isStreaming ? "working" : "idle");
    });
  }, [session.isStreaming]);

  return (
    <div className="pet-dock" title={`${config.petName} (${mood})`}>
      <span>{mood === "working" ? "⚡" : "🐾"}</span>
      <span>{config.petName}: {mood === "working" ? "Thinking…" : "Ready"}</span>
    </div>
  );
}

export const name = "companion-pet-client";
export const inject = ["contributions", "styles"];

export function apply(ctx: Context): void {
  ctx.styles.inject(PET_CSS, "pet");
  ctx.contributions.registerOverlay({
    id: "companion-pet-overlay",
    render: () => <CompanionPet />,
  });
}
```
