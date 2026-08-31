import type { AppearancePetDefinition, PetAnimationState } from "./appearanceCatalog";

export type PetActionId = "wave" | "jump" | "focus" | "review" | "rest";

export interface PetActionDefinition {
  id: PetActionId;
  label: string;
  state: PetAnimationState;
  durationMs: number;
}

export const PET_ACTIONS: PetActionDefinition[] = [
  { id: "wave", label: "打招呼", state: "waving", durationMs: 1_250 },
  { id: "jump", label: "跳一下", state: "jumping", durationMs: 900 },
  { id: "focus", label: "专注", state: "running", durationMs: 1_800 },
  { id: "review", label: "检查", state: "review", durationMs: 1_800 },
  { id: "rest", label: "休息", state: "idle", durationMs: 1_500 },
];

const DEFAULT_MESSAGES: Record<PetAnimationState, string[]> = {
  idle: ["我在这里", "随时可以开始"],
  "running-right": ["去右边看看"],
  "running-left": ["去左边看看"],
  waving: ["你好呀", "我在呢"],
  jumping: ["好耶！", "状态不错！"],
  failed: ["这一步没成功，再看看日志", "别急，我陪你一起排查"],
  waiting: ["需要你确认一下", "等你做决定"],
  running: ["正在处理任务", "我在专心工作"],
  review: ["让我仔细检查改动", "正在核对代码"],
};

const DEFAULT_IDLE_ANIMATIONS: Array<Extract<PetAnimationState, "waving" | "jumping">> = ["waving", "jumping"];

function choose<T>(values: T[], random: () => number): T {
  return values[Math.min(values.length - 1, Math.floor(random() * values.length))];
}

export function choosePetMessage(
  pet: AppearancePetDefinition,
  state: PetAnimationState,
  random: () => number = Math.random,
): string {
  const custom = pet.behavior?.messages?.[state];
  return choose(custom?.length ? custom : DEFAULT_MESSAGES[state], random);
}

export function chooseIdlePetAnimation(
  pet: AppearancePetDefinition,
  random: () => number = Math.random,
): Extract<PetAnimationState, "waving" | "jumping"> | null {
  const configured = pet.behavior?.idleAnimations;
  const animations = configured === undefined ? DEFAULT_IDLE_ANIMATIONS : configured;
  return animations.length > 0 ? choose(animations, random) : null;
}

export function nextPetIdleDelay(pet: AppearancePetDefinition, random: () => number = Math.random): number {
  const minimum = pet.behavior?.idleMinMs ?? 18_000;
  const maximum = Math.max(minimum, pet.behavior?.idleMaxMs ?? 42_000);
  return Math.round(minimum + (maximum - minimum) * random());
}
