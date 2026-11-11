# CSS `@layer` + `@scope` Isolation & `--qj-*` Design Tokens

## 1. How Qianji Isolates Plugin Styles

Qianji enforces a deterministic CSS cascade order in `src/styles/index.css`:

```css
@layer theme, base, plugin-ui, legacy, skin, components, utilities;
```

When a client plugin calls `ctx.styles.inject(css, key?)` — or imports a relative `./styles.css` file — Qianji automatically wraps the stylesheet in:

```css
@layer plugin-ui {
  @scope ([data-qj-plugin="<plugin-id>"]) {
    /* your plugin CSS */
  }
}
```

And removes the `<style>` element automatically when the plugin reloads or disables.

### Rules for Stable Plugin Styling
1. **Never inject raw `<style>` tags into `document.head`**. Always use `ctx.styles.inject(css)` or `import "./styles.css"`.
2. **Never write `:root` or `body` overrides** inside plugin CSS (use `registerTheme` for theme extensions instead).
3. **Never hardcode hex colors** like `#ffffff` or `#111111` for surfaces/text — always reference `--qj-*` semantic tokens so light mode, dark mode, and custom user skins work without code changes.
4. **Use concise class names** (e.g. `.card`, `.toolbar`, `.badge`) safely: `@scope ([data-qj-plugin="<plugin-id>"])` prevents collisions with host classes and other plugins.

---

## 2. Semantic `--qj-*` Theme Tokens

Call `qianji_inspect(topic: "theme_tokens")` anytime to inspect the live token list. Core tokens available everywhere:

### Surfaces & Backgrounds
- `--qj-bg-app`: Main application canvas background
- `--qj-bg-surface`: Panel, card, and drawer surface
- `--qj-bg-elevated`: Floating popover, modal, and dropdown surface
- `--qj-bg-subtle`: Muted code block / secondary container fill
- `--qj-bg-hover`: Interactive hover background
- `--qj-bg-active`: Selected / pressed item background

### Typography
- `--qj-text-primary`: Primary body & heading text
- `--qj-text-secondary`: Supporting descriptions & metadata
- `--qj-text-muted`: Placeholders, timestamps, subtle hints
- `--qj-font-sans`: UI sans-serif font family
- `--qj-font-mono`: Monospace code font family

### Borders & Radii
- `--qj-border-default`: Standard 1px hairline divider / card border
- `--qj-border-strong`: Emphasized or focused container border
- `--qj-radius-sm`: `6px` (compact buttons, badges, inputs)
- `--qj-radius-md`: `10px` (cards, panels)
- `--qj-radius-lg`: `14px` (dialogs, large containers)

### Brand & Semantic Status
- `--qj-brand-primary`: User's active accent color
- `--qj-brand-soft`: Translucent accent tint (`12%` mix) for active pills/chips
- `--qj-status-success`: Positive / connected / passed state
- `--qj-status-warning`: Caution / pending approval state
- `--qj-status-danger`: Error / destructive action state

---

## 3. Clean Card & Button Pattern

```tsx
const WIDGET_CSS = `
.card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: var(--qj-radius-md);
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-surface);
  color: var(--qj-text-primary);
}
.meta {
  font-size: 12px;
  color: var(--qj-text-secondary);
}
.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: var(--qj-radius-sm);
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-elevated);
  color: var(--qj-text-primary);
  font-size: 12px;
  cursor: pointer;
}
.action-btn:hover {
  background: var(--qj-bg-hover);
}
`;
```
