# Third-Party Notices

Pi Desktop installers include the Harness Host as one executable compiled with Bun, so users do not need a global Node.js or npm installation for the core agent workflow.

## Pi coding agent

- Package: `@earendil-works/pi-coding-agent` (no longer bundled or depended on since 0.3)
- Upstream: https://github.com/earendil-works/pi
- License: MIT
- Copyright: Mario Zechner and contributors
- Used for: the one-time import reads Pi's session, `models.json` and `auth.json` formats, and `packages/host/src/pi-builtins.ts` lists provider endpoints taken from Pi's model catalog. The test samples in `packages/host/test/fixtures/pi-sessions` were written by Pi's `SessionManager`.

## Bun runtime

- Package: `bun`
- Upstream: https://github.com/oven-sh/bun
- License: MIT
- Copyright: Jarred Sumner and contributors

## Open Vetta

- Upstream: https://github.com/openvetta/open-vetta
- License: Apache-2.0
- Copyright: 2026 Vetta
- Used for: the desktop visual design. The palette values, tree-branch list styling, work-log gutters and the user-bubble entry spring in `src/styles/` and `src/components/Message.tsx` are adapted from Open Vetta's `apps/desktop` and `packages/theme-ui` sources.

This product includes software developed at Vetta (https://www.openvetta.com).

## dsh-claude-style

- Package: `dsh-claude-style`
- Upstream: https://github.com/Nwflower/dsh-claude-style
- License: MIT
- Copyright: Nwflower
- Used for: Claude Code Desktop warm ivory/dark palettes, clay accent tokens, composer card/popover geometry, turn navigator rail, file-change row merging, and transcript disclosure styling in `src/styles/` and `src/components/`.

## DeepSeek Harness client UI

- Packages: `@deepseek-ai/dsh-client-ui-chat`, `@deepseek-ai/dsh-client-ui-tool`, `@deepseek-ai/dsh-client-ui-primitives`
- License: MIT
- Copyright: 2026 DeepSeek
- Used for: the transcript's structure and geometry — the user bubble, message icon actions and clocks, the turn-process divider, process groups, reasoning and tool disclosure rows, text shimmer, result cards and Markdown rhythm in `src/components/Message.tsx`, `src/components/ToolCall.tsx`, `src/components/TranscriptPrimitives.tsx`, `src/styles/skin-messages.css`, and the outline icon artwork in `src/components/DshIcons.tsx`.

## Fonts

- Inter (`@fontsource-variable/inter`) — SIL Open Font License 1.1, Copyright The Inter Project Authors
- Noto Serif (`@fontsource-variable/noto-serif`) — SIL Open Font License 1.1, Copyright The Noto Project Authors
- JetBrains Mono (`@fontsource-variable/jetbrains-mono`) — SIL Open Font License 1.1, Copyright The JetBrains Mono Project Authors

The generated runtime also includes the license identifiers and available license files for bundled transitive npm dependencies in `runtime-licenses.json` and `licenses/`.

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
