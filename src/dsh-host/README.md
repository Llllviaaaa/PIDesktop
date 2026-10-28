# DSH host

PIDesktop's stand-ins for the DeepSeek Harness framework packages that the
UI under `src/dsh` and `src/better-sidebar` expects to find. Those packages
run unchanged; this directory supplies what DSH's own client framework would:

- `modules/`: one module per `@deepseek-ai/*` specifier the copied UI imports
  but PIDesktop does not carry. Types follow the upstream definitions for the
  members the UI uses; services that the UI reads from `ctx` are implemented
  here against PIDesktop (Pi sessions, Tauri commands).
- `boot.ts`: builds the cordis root context, provides the host services and
  loads the copied UI plugins in dependency order.
- `Frame.tsx`: renders the DSH slots into PIDesktop's own layout.
- `better-sidebar.ts`: loads better-sidebar's client half (`src/better-sidebar`)
  and provides the client services it reads: the module table its lazy chunks
  resolve through (the chunks themselves are split out by Vite), `connection`,
  `remote.session` (open in app / reveal, through PIDesktop's openers) and the
  composer draft (`conversation`, through the composer's textarea). Its routes
  are served by the Harness Host (`packages/host`), whose base the Tauri
  command `sidebar_host_base` hands out; the client reaches it through
  `__DSH_TRANSPORT__`.
- `modules/terminals.ts`: the terminal controller's Host half (`remote.terminal`)
  over Tauri's PTY commands, mirroring each shell into a headless xterm the
  way upstream's BrowserTerminal does. The copied client half in
  `src/dsh/terminal-controller` provides `webTerminals` from it, which both
  DSH's terminal tab and better-sidebar's bottom terminal use.
- `modules/gateway/`: the Gateway client's reconnecting `RemoteStream`
  (copied unchanged) over an always-connected connection (`modules/connection.ts`).
- `types/better-sidebar.d.ts`: what the host reaches in better-sidebar. Its
  sources type-check upstream against DSH's own host types (restated in its
  `context-types.ts`), so `dsh-better-sidebar/*` imports type-check against
  this declaration while Vite resolves them to the sources.

Specifiers resolve through `dsh-aliases.ts` (and `paths` in `tsconfig.json`).
