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
