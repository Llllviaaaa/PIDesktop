# Codex UI reference

Pi Desktop uses publicly documented Codex interaction patterns as design references. Third-party screenshots are not redistributed in this repository; follow the source links to inspect the current upstream UI.

Primary references:

- [Codex environments](https://learn.chatgpt.com/docs/environments/modes) - new chat composer and environment controls
- [Code review](https://learn.chatgpt.com/docs/code-review) - inline review comments and diff presentation
- [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model) - tool preambles, hosted web search, and cited answers

## What the official composer actually looks like

From the documented dark-mode composer:

1. **Near-black full bleed background** — not busy gradients.
2. **One large rounded rectangle** (~22px radius), medium charcoal fill, soft border — not double-stacked chrome.
3. **Placeholder**: `Ask Codex anything, @ to add files, / for commands` — quiet gray.
4. **Toolbar sparse**: `+` left; few icons + **circular send** right (gray disc, white arrow).
5. **Environment under the field** as **text tabs**: `Local` · `Worktree` · `Cloud` pill — **not** icon-heavy boxed toggles inside the toolbar.
6. No avatar rails, no “hero” marketing headers on panels.

## Code review visual language

From the documented inline code review UI:

- Diff line numbers muted; **green gutter bar** on changed lines.
- Comment is a **floating dark card** over the code with severity badge (`P1`), title, body, `Dismiss`.
- Restraint: almost no decoration outside the card and gutter.

## Secondary sources (text, not pixels)

- [Beginner’s guide](https://getpushtoprod.substack.com/p/complete-beginners-guide-to-openais): “IDE-like” — project sidebar, threads, terminal, code review panel; worktrees visible in sidebar.
- [Medium UI review](https://medium.com/@ariaxhan/i-tested-openais-new-codex-desktop-app-the-ui-is-the-real-product-c2c59bdcb5f6): top-right **Changes / Terminal / IDE** toggles; run control with environment.

## Implication for Pi Desktop

Match **structure and restraint**, not every Codex feature (no Cloud tab product).

### Search and browser boundary

- Web search is an inline conversation tool: show a short running/completed row, the query, and cited sources.
- Search completion never navigates the workspace or opens a browser by itself.
- A source opens only after an explicit user click.
- The application browser accepts URLs only. Interactive page inspection remains a separate Agent browser tool and permission boundary.

### Layout alignment shipped

| Region | Codex pattern | Pi Desktop |
| --- | --- | --- |
| Shell | Near-black, quiet chrome | `#0a0a0b` stage + slim topbar |
| Sidebar | Projects → threads, New chat | Project groups + thread rows, 新对话 |
| Top-right | Changes / Terminal toggles | Icon panel toggles (changes, terminal, browser…) |
| Center | Thread title subtle; chat column | Thin title; ~720px conversation |
| Composer | Rounded card + env tabs under field | Aligned (no Cloud product tab) |
| New task | Centered prompt + composer | Heading + composer + pill starters |
