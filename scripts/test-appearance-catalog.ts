import assert from "node:assert/strict";
import {
  createCustomAppearanceTheme,
  mergeAppearanceCatalog,
  parseAppearancePet,
  parseAppearanceTheme,
  resolveAppearancePet,
  resolveAppearanceTheme,
} from "../src/lib/appearanceCatalog";
import type { ResourceItem } from "../src/types";

const userTheme: ResourceItem = {
  kind: "theme",
  name: "ocean",
  path: "C:\\Users\\demo\\.pi\\agent\\themes\\ocean.json",
  scope: "user",
};

const parsedTheme = parseAppearanceTheme(JSON.stringify({
  name: "ocean",
  label: "Ocean",
  vars: { ink: "#e8f1f5", accent: "#2ba6a6", muted: "#6e8792" },
  colors: { text: "ink", accent: "accent", muted: "muted", border: "accent" },
  export: { pageBg: "#10232c", cardBg: "#17333d" },
}), userTheme);

assert.equal(parsedTheme.id, "theme:ocean");
assert.equal(parsedTheme.mode, "dark");
assert.equal(parsedTheme.palette?.accent, "#2ba6a6");
assert.equal(parsedTheme.palette?.panel, "#17333d");

const customTheme = createCustomAppearanceTheme("#102030", "#f2f4f6", "#58a67c");
assert.equal(customTheme.id, "custom");
assert.equal(customTheme.mode, "dark");
assert.equal(customTheme.palette?.app, "#102030");
assert.equal(customTheme.palette?.accent, "#58a67c");

const userPet: ResourceItem = {
  kind: "pet",
  name: "orb",
  path: "C:\\Users\\demo\\.pi\\agent\\pets\\orb",
  scope: "user",
};
let requestedAsset = "";
const parsedPet = await parseAppearancePet(
  JSON.stringify({ id: "orb", name: "光球", asset: "sprites/orb.webp" }),
  userPet,
  async (file) => {
    requestedAsset = file;
    return {
      path: file,
      fileName: "orb.webp",
      mimeType: "image/webp",
      size: 3,
      kind: "image",
      data: "YWJj",
    };
  },
);

assert.equal(requestedAsset, "C:\\Users\\demo\\.pi\\agent\\pets\\orb\\sprites\\orb.webp");
assert.equal(parsedPet.id, "pet:orb");
assert.equal(parsedPet.assetDataUrl, "data:image/webp;base64,YWJj");

const projectTheme = { ...parsedTheme, label: "Project Ocean", scope: "project" as const };
const catalog = mergeAppearanceCatalog([parsedTheme, projectTheme], [parsedPet]);
assert.equal(catalog.themes.find((theme) => theme.id === "theme:ocean")?.label, "Project Ocean");
assert.equal(resolveAppearanceTheme(catalog, "missing", false).id, "light");
assert.equal(resolveAppearancePet(catalog, "pet:orb").label, "光球");
assert.equal(resolveAppearancePet(catalog, "missing").id, "cat");

await assert.rejects(
  () => parseAppearancePet(JSON.stringify({ name: "bad", asset: "../outside.png" }), userPet, async () => {
    throw new Error("unreachable");
  }),
  /相对图片路径/,
);

console.log("appearance catalog tests passed");
