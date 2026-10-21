# DeepSeek Harness packages

Copied from [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
at commit `5719020` (MIT, © 2026 DeepSeek; see `LICENSE`). Each directory is
the package's `src/`, resolved by its npm name through `dsh-aliases.ts` and the
`paths` in `tsconfig.json`, so imports read as they do upstream.

| Directory        | Package                                   |
| ---------------- | ----------------------------------------- |
| `primitives`     | `@deepseek-ai/dsh-client-ui-primitives`   |
| `dockkit`        | `@deepseek-ai/dsh-client-ui-dockkit`      |
| `store`          | `@deepseek-ai/dsh-client-store`           |
| `brand`          | `@deepseek-ai/dsh-brand`                  |
| `code-language`  | `@deepseek-ai/dsh-util-code-language`     |
| `workspace-path` | `@deepseek-ai/dsh-util-workspace-path`    |
| `util-values`    | `@deepseek-ai/dsh-util-values`            |
| `util-crypto`    | `@deepseek-ai/dsh-util-crypto`            |
| `slots`          | `@deepseek-ai/dsh-client-ui-slots`        |
| `renderer`       | `@deepseek-ai/dsh-client-ui-renderer`     |
| `resources`      | `@deepseek-ai/dsh-client-resources`       |
| `ui-session`     | `@deepseek-ai/dsh-client-ui-session`      |
| `sidebar-right`  | `@deepseek-ai/dsh-client-ui-sidebar-right`|
| `sidebar-browser`| `@deepseek-ai/dsh-client-ui-sidebar-browser` |
| `sidebar-terminal` | `@deepseek-ai/dsh-client-ui-sidebar-terminal` |
| `sidebar-documentpreview` | `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` |
| `terminal-controller` | `@deepseek-ai/dsh-api-terminal-controller` (`client/` and `types.ts` only; the Host half is `src/dsh-host/modules/terminals.ts`) |
| `deque`          | `@deepseek-ai/dsh-deque`                  |
| `theme`          | `ui-theme/src/styles` (token sheets only) |
| `locale/locales` | `locale/src/locales` (the shared `common` dictionaries) |

The framework packages these import but PIDesktop does not carry (cordis
services, sessions, layout, shortcuts, …) are stood in for by `src/dsh-host`.

## Changes from upstream

Keep this list complete, so an upstream update can be diffed and re-applied.

- `primitives/FishLogo.tsx`, `primitives/BrandWordmark.tsx`: DeepSeek's logo
  and wordmark artwork removed; the exports remain and render nothing.
- React 19 typings (PIDesktop runs React 19, upstream React 18):
  - `dockkit/components/TabLayout.tsx`, `primitives/JsonTree.tsx`: `useRef()`
    calls given an explicit `undefined` initial value.
  - `primitives/markdown/useViewportHighlighting.ts`: the target ref accepts
    `RefObject<Element | null>`.
  - `primitives/TextShimmer.tsx`: `inert` passed as a boolean; React 19 reads
    the empty string React 18 needed as false.
  - `sidebar-right/client/shell/SidebarRight.tsx`: `panelRef` typed
    `RefObject<HTMLDivElement | null>`.
  - `sidebar-terminal/client/terminal.tsx`: the terminal, fit and theme refs
    typed `| undefined` with an explicit `undefined` initial value.
- TypeScript 5.9 typings (upstream builds with a newer checker):
  - `sidebar-right/client/tab-domain.ts`: `openTab`'s generic params cast to
    the non-generic options type when forwarded to `openTabIn`.
- One type-check program (upstream checks each package on its own, so a
  package never sees another's `SidebarRightTabParamsMap` entries; here every
  entry merges and `navigation.params` becomes the union of all of them):
  - `sidebar-browser/client/view/BrowserBody.tsx`: the initial URL reads the
    params as `SidebarRightTabParamsFor<'browser'>`.
  - `sidebar-terminal/client/index.ts`: `target` reads the params as
    `SidebarRightTabParamsMap['terminal'] | undefined`.

Lint does not run over this directory (`eslint.config.js`); the type checker does.
