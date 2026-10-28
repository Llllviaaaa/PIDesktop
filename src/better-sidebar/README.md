# better-sidebar

[DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 0.26.0
at commit `454afaf` (MIT, © 2026 dsh-external; see `LICENSE`): the plugin's
`src/`, laid out as upstream. `client/` is the client half PIDesktop loads into
DSH's UI (`src/dsh-host/better-sidebar.ts`); the files beside it are the host
half, which the Harness Host loads as one of its plugins
(`packages/host/src/better-sidebar`), plus the modules both halves share.

## Changes from upstream

- `client/desktop-env.ts`: `hostHttpBase()` takes the Harness Host's base from
  `__DSH_TRANSPORT__.httpBaseUrl` first. The routes live on a different origin
  from PIDesktop's page, and the host answers CORS for it.
- `client/layout.css`: the `prefers-reduced-motion` block closes after its one
  rule. Upstream leaves it open, so browsers close it at the end of the file
  and the submenu rules below it apply only under reduced motion; Tailwind's
  parser rejects the file outright.

Lint and the app's type check do not run over this directory; the sources
type-check upstream against DSH's own host types.
