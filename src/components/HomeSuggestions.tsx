import { Bug, FlaskConical, Map as MapIcon, Wrench, type LucideIcon } from "lucide-react";

/** Starting points for a coding task in the chosen project (Settings → 显示建议提示词). */
export const HOME_SUGGESTIONS: ReadonlyArray<{ label: string; prompt: string; icon: LucideIcon }> = [
  { label: "解释项目结构", prompt: "解释这个项目的结构：主要模块、它们之间的关系，以及程序从哪里启动。", icon: MapIcon },
  { label: "检查最近的改动", prompt: "看一下这个项目最近的改动，找出可能有问题的地方，并说明原因。", icon: Bug },
  { label: "补充测试", prompt: "为最近改动的代码补充测试，先说明打算覆盖哪些情况。", icon: FlaskConical },
  { label: "跑通构建", prompt: "运行这个项目的构建和测试，如果有失败，找出原因并修复。", icon: Wrench },
];

/** The home page's suggestion chips; a pick fills the composer for the user to edit or send. */
export function HomeSuggestions({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="home-suggestions" aria-label="建议提示词">
      {HOME_SUGGESTIONS.map(({ label, prompt, icon: Icon }) => (
        <button key={label} type="button" className="home-suggestion" title={prompt} onClick={() => onPick(prompt)}>
          <Icon size={14} strokeWidth={1.7} aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
