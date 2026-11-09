# `@pid/intelligent-ui`

Built-in Intelligent UI plugin (`intelligent-ui`) for Pi Desktop, inspired by `dsh-intelligent-ui` and modern Generative UI architectures.

## Features

- **`render_ui` & `update_ui` tools**: Allows models to compose interactive interfaces inline in conversations, with automatic per-widget version history (`v1`, `v2`, ...) that follows session branches and rewinds.
- **Dual rendering engines**:
  - `engine: "declarative"` — Native Cool-Gray Minimalist component tree (`controls`, `stats`, `chart`, `table`, `tabs`, `form`, `callout`, `checklist`) with reactive local state and pure formula bindings.
  - `engine: "html"` — Strictly isolated `<iframe sandbox="allow-scripts">` escape pod for bespoke SVG/Canvas simulations, visualizers, and interactive mini-apps.
- **System prompt integration**: Teaches models when and how to render interactive UIs instead of static prose walls; cleanly unregisters when disabled in Settings → Plugins.
- **`/ui` slash command**: Lists session widgets or triggers interactive UI generation on demand.
