# Appearance extensions

PIDesktop loads Pi theme files and desktop pet manifests from both user and project scopes:

- User themes: `~/.pi/agent/themes/*.json`
- Project themes: `<workspace>/.pi/themes/*.json`
- User pets: `~/.pi/agent/pets/<pet>/pet.json`
- Project pets: `<workspace>/.pi/pets/<pet>/pet.json`

The same locations are available from **Settings > Appearance > Appearance extensions**. Choose the user or project scope, then import an extension, open its directory, or rescan after editing files. Imported definitions become available in the theme and pet pickers immediately.

The built-in **Custom** theme stores background, foreground, and accent colors in the desktop settings. File-based themes can define the full palette and replace a user definition with a project definition of the same generated ID.

Project definitions replace user definitions with the same generated ID. Theme files use Pi's existing theme schema. Their saved ID is `theme:<name>`.

A pet directory contains a `pet.json` manifest and a local image. PNG, WebP, GIF, JPEG, and SVG assets supported by the attachment reader can be used.

```json
{
  "id": "my-pet",
  "name": "My Pet",
  "asset": "my-pet.webp"
}
```

The saved pet ID is `pet:<id>`. The asset path must stay inside the pet directory. Animated GIF or WebP files retain their animation; PIDesktop also applies the standard working-state motion.

## Interactive spritesheet pets

For state-aware interaction, a pet can use the 8-by-9 spritesheet contract instead of a single image:

```json
{
  "id": "my-animated-pet",
  "name": "My Animated Pet",
  "spritesheetPath": "spritesheet.webp",
  "spritesheet": {
    "columns": 8,
    "rows": 9,
    "cellWidth": 192,
    "cellHeight": 208
  },
  "behavior": {
    "idleAnimations": ["waving", "jumping"],
    "idleMinMs": 18000,
    "idleMaxMs": 42000,
    "messages": {
      "waving": ["你好呀", "我在呢"],
      "waiting": "需要你确认一下",
      "failed": ["别急，我陪你一起排查"]
    }
  }
}
```

Rows map to these states in order: `idle`, `running-right`, `running-left`, `waving`, `jumping`, `failed`, `waiting`, `running`, and `review`. Their default frame counts are 6, 8, 8, 4, 5, 8, 6, 6, and 6. Unused cells must be transparent.

PIDesktop selects states from task activity and direct interaction: dragging or arrow keys use directional movement, a click waves, a double click jumps, approval prompts wait, active tasks work, failures react, and the review workspace reviews. State rows can override `row`, `frames`, `frameDurationMs`, and `loop` under `spritesheet.states` when a compatible custom layout is needed.

Right-clicking the pet opens its action menu. Touch users can long-press instead. The optional `behavior` block controls autonomous idle animation timing and state-aware speech. Set `idleAnimations` to an empty array to disable autonomous actions for a pet. It accepts `waving` and `jumping`; delays range from 5 seconds to 5 minutes, and each state supports up to eight messages of 80 characters each.
