import assert from "node:assert/strict";
import {
  createCustomAppearanceTheme,
  mergeAppearanceCatalog,
  parseAppearancePet,
  parseAppearanceTheme,
  resolveAppearancePet,
  resolveAppearanceTheme,
} from "../src/lib/appearanceCatalog";
import { chooseIdlePetAnimation, choosePetMessage, nextPetIdleDelay } from "../src/lib/petInteractions";
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
assert.equal(parsedPet.spritesheet, undefined);

const animatedPet = await parseAppearancePet(
  JSON.stringify({
    id: "anya-chibi",
    displayName: "小阿尼亚",
    spritesheetPath: "spritesheet.webp",
    spritesheet: {
      states: {
        waving: { frameDurationMs: 140 },
      },
    },
    behavior: {
      idleAnimations: ["waving"],
      idleMinMs: 12_000,
      idleMaxMs: 24_000,
      messages: {
        waving: ["你好，我是阿尼亚", "一起工作吧"],
        failed: "我陪你再检查一次",
      },
    },
  }),
  { ...userPet, name: "anya-chibi", path: "C:\\Users\\demo\\.pi\\agent\\pets\\anya-chibi" },
  async (file) => ({
    path: file,
    fileName: "spritesheet.webp",
    mimeType: "image/webp",
    size: 3,
    kind: "image",
    data: "YWJj",
  }),
);

assert.equal(animatedPet.id, "pet:anya-chibi");
assert.equal(animatedPet.label, "小阿尼亚");
assert.equal(animatedPet.spritesheet?.columns, 8);
assert.equal(animatedPet.spritesheet?.rows, 9);
assert.equal(animatedPet.spritesheet?.states["running-left"].frames, 8);
assert.equal(animatedPet.spritesheet?.states.waving.frameDurationMs, 140);
assert.deepEqual(animatedPet.behavior?.idleAnimations, ["waving"]);
assert.equal(choosePetMessage(animatedPet, "waving", () => 0), "你好，我是阿尼亚");
assert.equal(chooseIdlePetAnimation(animatedPet, () => 0.9), "waving");
assert.equal(nextPetIdleDelay(animatedPet, () => 0.5), 18_000);

await assert.rejects(
  () => parseAppearancePet(
    JSON.stringify({ id: "bad-sheet", spritesheetPath: "spritesheet.webp", spritesheet: { columns: 0 } }),
    userPet,
    async (file) => ({ path: file, fileName: "spritesheet.webp", mimeType: "image/webp", size: 3, kind: "image", data: "YWJj" }),
  ),
  /spritesheet.columns/,
);

await assert.rejects(
  () => parseAppearancePet(
    JSON.stringify({
      id: "bad-behavior",
      asset: "pet.webp",
      behavior: { idleMinMs: 20_000, idleMaxMs: 10_000 },
    }),
    userPet,
    async (file) => ({ path: file, fileName: "pet.webp", mimeType: "image/webp", size: 3, kind: "image", data: "YWJj" }),
  ),
  /idleMaxMs/,
);

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
