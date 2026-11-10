# `@qianji/commands`

Slash command registry (`ctx.commands`) for the Harness Host (ADR 0002, 0003).

Built-in plugins and external dynamic plugins register slash commands with `ctx.effect(() => ctx.commands.register(...))` or dynamic workspace providers with `ctx.effect(() => ctx.commands.registerProvider(...))`. Commands either produce immediate Markdown output, expand into an agent prompt, or trigger a client UI action (`clear` / `compact`).
