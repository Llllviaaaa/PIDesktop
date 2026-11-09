import assert from "node:assert/strict";
import {
  BUILTIN_APPEARANCE_CATALOG,
  mergeAppearanceCatalog,
  resolveAppearanceTheme,
  type AppearanceThemeDefinition,
} from "../src/lib/appearanceCatalog";
import { test } from "vitest";

test("minimalist appearance catalog and theme resolution", () => {
  assert.deepEqual(
    BUILTIN_APPEARANCE_CATALOG.themes.map((theme) => theme.id),
    ["system", "light", "dark"],
  );

  const light = resolveAppearanceTheme(BUILTIN_APPEARANCE_CATALOG, "light", false);
  assert.equal(light.id, "light");
  assert.equal(light.mode, "light");
  assert.equal(light.palette?.app, "#fcfcfc");
  assert.equal(light.palette?.sidebar, "#fcfcfc");
  assert.equal(light.palette?.accent, "#006ee4");

  const dark = resolveAppearanceTheme(BUILTIN_APPEARANCE_CATALOG, "dark", false);
  assert.equal(dark.id, "dark");
  assert.equal(dark.mode, "dark");
  assert.equal(dark.palette?.app, "#181819");
  assert.equal(dark.palette?.sidebar, "#181819");
  assert.equal(dark.palette?.accent, "#4b93ff");

  const systemLight = resolveAppearanceTheme(BUILTIN_APPEARANCE_CATALOG, "system", false);
  assert.equal(systemLight.mode, "light");
  assert.equal(systemLight.palette?.app, "#fcfcfc");

  const systemDark = resolveAppearanceTheme(BUILTIN_APPEARANCE_CATALOG, "system", true);
  assert.equal(systemDark.mode, "dark");
  assert.equal(systemDark.palette?.app, "#181819");

  const userTheme: AppearanceThemeDefinition = {
    id: "slate-custom",
    label: "User Slate",
    mode: "dark",
    scope: "user",
    palette: dark.palette,
  };
  const projectTheme: AppearanceThemeDefinition = {
    ...userTheme,
    label: "Project Slate",
    scope: "project",
  };

  const catalog = mergeAppearanceCatalog([userTheme, projectTheme]);
  assert.equal(catalog.themes.find((theme) => theme.id === "slate-custom")?.label, "Project Slate");
  assert.equal(resolveAppearanceTheme(catalog, "missing", false).id, "light");
});
