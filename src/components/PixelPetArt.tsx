import { useEffect, useState } from "react";
import type { BuiltinPetCharacter, PetAnimationState } from "../lib/appearanceCatalog";

/**
 * 16-bit Pixel Art renderer for Pi Desktop's built-in pets ("cat", "robot", "fox").
 *
 * Uses a crisp 16×16 logical pixel grid (`shapeRendering="crispEdges"`) with
 * multi-frame state animations (idle breathing/blinking/tail-wag, typing on a
 * mini laptop when running, magnifying glass / glasses in review, question
 * bubble when waiting, happy jump/wave, and dizzy stars on failure).
 */

type PaletteMap = Record<string, string>;

interface PixelSpriteFrame {
  rows: string[];
  palette: PaletteMap;
}

const CAT_PALETTE: PaletteMap = {
  O: "#1c1917", // Dark outline
  B: "#f59e0b", // Warm ginger coat
  D: "#d97706", // Darker ginger stripe/shade
  W: "#fffbeb", // Cream belly/muzzle/paws
  P: "#fb7185", // Pink inner ear / nose / blush
  E: "#1c1917", // Eye pupil
  H: "#ffffff", // Eye highlight
  L: "#64748b", // Laptop body
  S: "#38bdf8", // Laptop screen glow
  G: "#10b981", // Code / review accent
  R: "#ef4444", // Alert / error accent
  Y: "#facc15", // Sparkle / star
};

const ROBOT_PALETTE: PaletteMap = {
  O: "#1e293b", // Dark slate outline
  B: "#e2e8f0", // Silver-white chassis
  D: "#94a3b8", // Shaded metallic armor
  A: "#d97757", // Clay/terracotta antenna & core accent
  S: "#0f172a", // Visor screen dark
  E: "#38bdf8", // Cyan LED eyes
  G: "#4ade80", // Green active LED
  W: "#ffffff", // Highlight
  Y: "#facc15", // Spark / star
  R: "#f87171", // Error LED
  L: "#64748b", // Keyboard / desk
};

const FOX_PALETTE: PaletteMap = {
  O: "#271c19", // Deep espresso outline
  B: "#ea580c", // Rich rust-orange fur
  D: "#c2410c", // Shaded rust fur
  W: "#fff7ed", // Ivory cheeks, chest & tail tip
  T: "#431407", // Dark ear tips & paws
  P: "#fb7185", // Blush
  E: "#1c1917", // Eye
  H: "#ffffff", // Eye shine
  L: "#64748b", // Laptop
  S: "#38bdf8", // Screen glow
  Y: "#facc15", // Star / idea
  R: "#ef4444", // Error mark
};

const CAT_FRAMES: Record<string, string[]> = {
  idle_0: [
    "................",
    "..OO........OO..",
    ".OBBO......OBBO.",
    ".OBPBOOOOOOBPBO.",
    ".OBBBBBBBBBBBBO.",
    ".OBDBBBBBBBDBBO.",
    ".OBBEOBBBBHEBBO.",
    ".OBBEEPBBPEEBBO.",
    ".OBBBBWWWWBBBBO.",
    "..OOOOOOOOOOOO..",
    "..OBBBWWWWBBBO..OO",
    "..OBBBWWWWBBBO.OBO",
    "..OBBBOOOOBBBO.OBO",
    "..OWWO....OWWOOOBO",
    "..OOOO....OOOOOOO.",
    "................",
  ],
  idle_1: [
    "................",
    "................",
    "..OO........OO..",
    ".OBBO......OBBO.",
    ".OBPBOOOOOOBPBO.",
    ".OBBBBBBBBBBBBO.",
    ".OBDBBBBBBBDBBO.",
    ".OBBOOBBBBOOBBO.",
    ".OBBBPPBBPPBBBO.",
    ".OBBBBWWWWBBBBO.",
    "..OOOOOOOOOOOO.OO.",
    "..OBBBWWWWBBBOOBO.",
    "..OBBBOOOOBBBOOBO.",
    "..OWWO....OWWOOBO.",
    "..OOOO....OOOOOO..",
    "................",
  ],
  waving_0: [
    "................",
    "..OO........OO..",
    ".OBBO......OBBO.",
    ".OBPBOOOOOOBPBO.",
    ".OBBBBBBBBBBBBO.",
    ".OBBHEBBBBHEBBO.",
    ".OBBEEPBBPEEBBO.",
    ".OBBBBWWWWBBBBO.",
    "OOOOOOOOOOOOOO..",
    "OWOBBBWWWWBBBO..",
    "OOOBBBWWWWBBBO.OO",
    "..OBBBOOOOBBBOOBO",
    "..OWWO....OWWOOBO",
    "..OOOO....OOOOOO.",
    "................",
    "................",
  ],
  waving_1: [
    ".OO.............",
    "OWWO........OO..",
    "OOOBO......OBBO.",
    ".OBPBOOOOOOBPBO.",
    ".OBBBBBBBBBBBBO.",
    ".OBBHEBBBBHEBBO.",
    ".OBBEEPBBPEEBBO.",
    ".OBBBBWWWWBBBBO.",
    "..OOOOOOOOOOOO..",
    "..OBBBWWWWBBBO.OO",
    "..OBBBWWWWBBBOOBO",
    "..OBBBOOOOBBBOOBO",
    "..OWWO....OWWOOBO",
    "..OOOO....OOOOOO.",
    "................",
    "................",
  ],
  jumping_0: [
    "..OO........OO..",
    ".OBBO......OBBO.",
    ".OBPBOOOOOOBPBO.",
    ".OBBBBBBBBBBBBO.",
    ".OBEOOBBBBOEBBO.",
    ".OBBPPWWWWPPBBO.",
    "..OOOOOOOOOOOO..",
    ".OOBBBWWWWBBBOO.",
    "OWOBBBWWWWBBBOWO",
    "OO.OBBOOOOBBO.OO",
    "...OWWO..OWWO...",
    "...OOOO..OOOO...",
    "................",
    "....OOOOOOOO....",
    "................",
    "................",
  ],
  running_0: [
    "................",
    "..OO........OO..",
    ".OBBO......OBBO.",
    ".OBPBOOOOOOBPBO.",
    ".OBBBBBBBBBBBBO.",
    ".OBBHEBBBBHEBBO.",
    ".OBBEEPBBPEEBBO.",
    ".OBBBBWWWWBBBBO.",
    "..OOOOOOOOOOOO..",
    "..OBBBWWWWBBBO..",
    ".OOWWOOOOOOWWOO.",
    ".OLLSSSSSSSSLLO.",
    ".OLLLLLLLLLLLLO.",
    ".OOOOOOOOOOOOOO.",
    "................",
    "................",
  ],
  running_1: [
    "................",
    "..OO........OO..",
    ".OBBO......OBBO.",
    ".OBPBOOOOOOBPBO.",
    ".OBBBBBBBBBBBBO.",
    ".OBBHEBBBBHEBBO.",
    ".OBBEEPBBPEEBBO.",
    ".OBBBBWWWWBBBBO.",
    "..OOOOOOOOOOOO..",
    "..OBBBWWWWBBBO..",
    ".OOBBWOOOOOWWOO.",
    ".OLLSGSSSSGSLLO.",
    ".OLLLLLLLLLLLLO.",
    ".OOOOOOOOOOOOOO.",
    "................",
    "................",
  ],
  waiting_0: [
    "...........YYYY.",
    "..OO......YY..YY",
    ".OBBO........YY.",
    ".OBPBOOOOOO.YY..",
    ".OBBBBBBBBBBBBO.",
    ".OBBHEBBBBHEBBO.",
    ".OBBEEPBBPEEBBO.",
    ".OBBBBWWWWBBBBO.",
    "..OOOOOOOOOOOO..",
    "..OBBBWWWWBBBO..",
    "..OBBBWWWWBBBO.OO",
    "..OBBBOOOOBBBOOBO",
    "..OWWO....OWWOOBO",
    "..OOOO....OOOOOO.",
    "................",
    "................",
  ],
  review_0: [
    "................",
    "..OO........OO..",
    ".OBBO......OBBO.",
    ".OBPBOOOOOOBPBO.",
    ".OBBBBBBBBBBBBO.",
    ".O.OOOO..OOOO.O.",
    ".O.OHEO..OHEO.O.",
    ".O.OOOO..OOOO.O.",
    ".OBBBBWWWWBBBBO.",
    "..OOOOOOOOOOOO..",
    "..OBBBWWWWBBBO..",
    "..OBBBWWWWBBBO..",
    "..OWWOOOOOOWWO..",
    "..OOOO....OOOO..",
    "................",
    "................",
  ],
  failed_0: [
    "....R......R....",
    "..OOR.R..R.ROO..",
    ".OBBO.R..R.OBBO.",
    ".OBPBOOOOOOBPBO.",
    ".OBBBBBBBBBBBBO.",
    ".OBEOEB..BEOEBO.",
    ".OBOEOB..BOEOBO.",
    ".OBEOEBWWBEOEBO.",
    "..OOOOOOOOOOOO..",
    "..OBBBWWWWBBBO..",
    "..OBBBWWWWBBBO..",
    "..OBBBOOOOBBBO..",
    "..OWWO....OWWO..",
    "..OOOO....OOOO..",
    "................",
    "................",
  ],
};

const ROBOT_FRAMES: Record<string, string[]> = {
  idle_0: [
    ".......AA.......",
    "......AAAA......",
    ".......OO.......",
    "...OOOOOOOOOO...",
    "..OBBBBBBBBBBO..",
    ".OBBSSSSSSSSBBO.",
    ".OBSEWSSSSWESBO.",
    ".OBSEESSSSEESBO.",
    ".OBSSSSSSSSSSBO.",
    "..OBBBBBBBBBBO..",
    "...OOOOOOOOOO...",
    "..OBBBAAAAABBO..",
    "..OBBBOOOOBBBO..",
    "...OO......OO...",
    "..OOOO....OOOO..",
    "................",
  ],
  idle_1: [
    ".......YY.......",
    "......YYYY......",
    ".......OO.......",
    "...OOOOOOOOOO...",
    "..OBBBBBBBBBBO..",
    ".OBBSSSSSSSSBBO.",
    ".OBSSSSSSSSSSBO.",
    ".OBSEESSSSEESBO.",
    ".OBSSSSSSSSSSBO.",
    "..OBBBBBBBBBBO..",
    "...OOOOOOOOOO...",
    "..OBBBGGGGGBBO..",
    "..OBBBOOOOBBBO..",
    "...OO......OO...",
    "..OOOO....OOOO..",
    "................",
  ],
  waving_0: [
    ".......YY.......",
    ".OO...YYYY......",
    "OBBO...OO.......",
    "OO.OOOOOOOOOO...",
    "..OBBBBBBBBBBO..",
    ".OBBSSSSSSSSBBO.",
    ".OBSEWSSSSWESBO.",
    ".OBSSSSSSSSSSBO.",
    "..OBBBBBBBBBBO..",
    "...OOOOOOOOOO...",
    "..OBBBAAAAABBO..",
    "..OBBBOOOOBBBO..",
    "...OO......OO...",
    "..OOOO....OOOO..",
    "................",
    "................",
  ],
  jumping_0: [
    ".......YY.......",
    "......YYYY......",
    "...OOOOOOOOOO...",
    "..OBBBBBBBBBBO..",
    ".OBBSSSSSSSSBBO.",
    ".OBSGWSSSSWGSBO.",
    ".OBSSSSSSSSSSBO.",
    "..OBBBBBBBBBBO..",
    ".O.OOOOOOOOOO.O.",
    "OBOBBBAAAAABBOBO",
    "OO.OBBOOOOBBO.OO",
    "...OO......OO...",
    "..OOOO....OOOO..",
    "................",
    "....OOOOOOOO....",
    "................",
  ],
  running_0: [
    ".......GG.......",
    "......GGGG......",
    ".......OO.......",
    "...OOOOOOOOOO...",
    "..OBBBBBBBBBBO..",
    ".OBBSSSSSSSSBBO.",
    ".OBSEWSSSSWESBO.",
    ".OBSEESSSSEESBO.",
    ".OBSSSSSSSSSSBO.",
    "..OBBBBBBBBBBO..",
    "...OOOOOOOOOO...",
    ".OOBBBGGGGGBBOO.",
    ".OLLEEEEEEEELLO.",
    ".OLLLLLLLLLLLLO.",
    ".OOOOOOOOOOOOOO.",
    "................",
  ],
  running_1: [
    ".......EE.......",
    "......EEEE......",
    ".......OO.......",
    "...OOOOOOOOOO...",
    "..OBBBBBBBBBBO..",
    ".OBBSSSSSSSSBBO.",
    ".OBSGWSSSSWGSBO.",
    ".OBSEESSSSEESBO.",
    ".OBSSSSSSSSSSBO.",
    "..OBBBBBBBBBBO..",
    "...OOOOOOOOOO...",
    ".OOBBBAAAAABBOO.",
    ".OLLEGGGGGGGLLO.",
    ".OLLLLLLLLLLLLO.",
    ".OOOOOOOOOOOOOO.",
    "................",
  ],
  waiting_0: [
    ".......YY..YYYY.",
    "......YYYY....YY",
    ".......OO....YY.",
    "...OOOOOOOOOO...",
    "..OBBBBBBBBBBO..",
    ".OBBSSSSSSSSBBO.",
    ".OBSYWSSSSWYSBO.",
    ".OBSSSSSSSSSSBO.",
    "..OBBBBBBBBBBO..",
    "...OOOOOOOOOO...",
    "..OBBBYYYYYBBO..",
    "..OBBBOOOOBBBO..",
    "...OO......OO...",
    "..OOOO....OOOO..",
    "................",
    "................",
  ],
  review_0: [
    ".......GG.......",
    "......GGGG......",
    ".......OO.......",
    "...OOOOOOOOOO...",
    "..OBBBBBBBBBBO..",
    ".OBBSSSSSSSSBBO.",
    ".OBSGGSSSSGGSBO.",
    ".OBSGWSSSSWGSBO.",
    ".OBSSSSSSSSSSBO.",
    "..OBBBBBBBBBBO..",
    "...OOOOOOOOOO...",
    "..OBBBGGGGGBBO..",
    "..OBBBOOOOBBBO..",
    "...OO......OO...",
    "..OOOO....OOOO..",
    "................",
  ],
  failed_0: [
    ".......RR.......",
    "......RRRR......",
    ".......OO.......",
    "...OOOOOOOOOO...",
    "..OBBBBBBBBBBO..",
    ".OBBSSSSSSSSBBO.",
    ".OBSRSRSSRSRSBO.",
    ".OBSSRSSSSSRSBO.",
    ".OBSRSRSSRSRSBO.",
    "..OBBBBBBBBBBO..",
    "...OOOOOOOOOO...",
    "..OBBBRRRRRBBO..",
    "..OBBBOOOOBBBO..",
    "...OO......OO...",
    "..OOOO....OOOO..",
    "................",
  ],
};

const FOX_FRAMES: Record<string, string[]> = {
  idle_0: [
    "................",
    ".OO..........OO.",
    ".OTOO......OOTO.",
    ".OBBBOOOOOOBBBO.",
    ".OBBBBBBBBBBBBO.",
    ".OBDBBBBBBBDBBO.",
    ".OBBHEBBBBHEBBO.",
    ".OBWWEEBBEEWWBO.",
    "..OWWWWWWWWWWO..",
    "...OOOOOOOOOO...",
    "..OBBBWWWWBBBOOO",
    "..OBBBWWWWBBBOWO",
    "..OBBBOOOOBBBOBO",
    "..OTTO....OTTOOO",
    "..OOOO....OOOO..",
    "................",
  ],
  idle_1: [
    "................",
    "................",
    ".OO..........OO.",
    ".OTOO......OOTO.",
    ".OBBBOOOOOOBBBO.",
    ".OBBBBBBBBBBBBO.",
    ".OBDBBBBBBBDBBO.",
    ".OBBOOBBBBOOBBO.",
    ".OBWWPPBBPPWWBO.",
    "..OWWWWWWWWWWO..",
    "...OOOOOOOOOOOO.",
    "..OBBBWWWWBBBOWO",
    "..OBBBOOOOBBBOBO",
    "..OTTO....OTTOOO",
    "..OOOO....OOOO..",
    "................",
  ],
  waving_0: [
    ".OO.............",
    "OTTO.........OO.",
    "OOOBOO.....OOTO.",
    ".OBBBOOOOOOBBBO.",
    ".OBBBBBBBBBBBBO.",
    ".OBBHEBBBBHEBBO.",
    ".OBWWEEBBEEWWBO.",
    "..OWWWWWWWWWWO..",
    "...OOOOOOOOOO...",
    "..OBBBWWWWBBBOOO",
    "..OBBBWWWWBBBOWO",
    "..OBBBOOOOBBBOBO",
    "..OTTO....OTTOOO",
    "..OOOO....OOOO..",
    "................",
    "................",
  ],
  jumping_0: [
    ".OO..........OO.",
    ".OTOO......OOTO.",
    ".OBBBOOOOOOBBBO.",
    ".OBBBBBBBBBBBBO.",
    ".OBBHEBBBBHEBBO.",
    ".OBWWPPBBPPWWBO.",
    "..OWWWWWWWWWWO..",
    ".O.OOOOOOOOOO.O.",
    "OTOBBBWWWWBBBOTO",
    "OO.OBBOOOOBBO.OO",
    "...OTTO..OTTO...",
    "...OOOO..OOOO...",
    "................",
    "....OOOOOOOO....",
    "................",
    "................",
  ],
  running_0: [
    "................",
    ".OO..........OO.",
    ".OTOO......OOTO.",
    ".OBBBOOOOOOBBBO.",
    ".OBBBBBBBBBBBBO.",
    ".OBBHEBBBBHEBBO.",
    ".OBWWEEBBEEWWBO.",
    "..OWWWWWWWWWWO..",
    "...OOOOOOOOOO...",
    "..OBBBWWWWBBBO..",
    ".OOTTOOOOOOTTOO.",
    ".OLLSSSSSSSSLLO.",
    ".OLLLLLLLLLLLLO.",
    ".OOOOOOOOOOOOOO.",
    "................",
    "................",
  ],
  running_1: [
    "................",
    ".OO..........OO.",
    ".OTOO......OOTO.",
    ".OBBBOOOOOOBBBO.",
    ".OBBBBBBBBBBBBO.",
    ".OBBHEBBBBHEBBO.",
    ".OBWWEEBBEEWWBO.",
    "..OWWWWWWWWWWO..",
    "...OOOOOOOOOO...",
    "..OBBBWWWWBBBO..",
    ".OOBBTOOOOOTTOO.",
    ".OLLSYSSSSYSLLO.",
    ".OLLLLLLLLLLLLO.",
    ".OOOOOOOOOOOOOO.",
    "................",
    "................",
  ],
  waiting_0: [
    "...........YYYY.",
    ".OO.......YY..YY",
    ".OTOO........YY.",
    ".OBBBOOOOOO..YY.",
    ".OBBBBBBBBBBBBO.",
    ".OBBHEBBBBHEBBO.",
    ".OBWWEEBBEEWWBO.",
    "..OWWWWWWWWWWO..",
    "...OOOOOOOOOO...",
    "..OBBBWWWWBBBOOO",
    "..OBBBWWWWBBBOWO",
    "..OBBBOOOOBBBOBO",
    "..OTTO....OTTOOO",
    "..OOOO....OOOO..",
    "................",
    "................",
  ],
  review_0: [
    "................",
    ".OO..........OO.",
    ".OTOO......OOTO.",
    ".OBBBOOOOOOBBBO.",
    ".OBBBBBBBBBBBBO.",
    ".O.OOOO..OOOO.O.",
    ".O.OHEO..OHEO.O.",
    ".O.OOOO..OOOO.O.",
    "..OWWWWWWWWWWO..",
    "...OOOOOOOOOO...",
    "..OBBBWWWWBBBOOO",
    "..OBBBWWWWBBBOWO",
    "..OTTOOOOOOTTOOO",
    "..OOOO....OOOO..",
    "................",
    "................",
  ],
  failed_0: [
    "....R......R....",
    ".OO.R.R..R.R.OO.",
    ".OTOO.R..R.OOTO.",
    ".OBBBOOOOOOBBBO.",
    ".OBBBBBBBBBBBBO.",
    ".OBEOEB..BEOEBO.",
    ".OBWWOE..EOWWBO.",
    "..OWWWWWWWWWWO..",
    "...OOOOOOOOOO...",
    "..OBBBWWWWBBBO..",
    "..OBBBWWWWBBBO..",
    "..OBBBOOOOBBBO..",
    "..OTTO....OTTO..",
    "..OOOO....OOOO..",
    "................",
    "................",
  ],
};

function selectFrames(
  character: BuiltinPetCharacter,
  state: PetAnimationState,
): { frames: string[][]; palette: PaletteMap; intervalMs: number } {
  const table = character === "robot" ? ROBOT_FRAMES : character === "fox" ? FOX_FRAMES : CAT_FRAMES;
  const palette = character === "robot" ? ROBOT_PALETTE : character === "fox" ? FOX_PALETTE : CAT_PALETTE;
  const idle0 = table.idle_0 ?? [];
  const idle1 = table.idle_1 ?? idle0;

  switch (state) {
    case "running":
    case "running-left":
    case "running-right":
      return {
        frames: [table.running_0 ?? idle0, table.running_1 ?? table.running_0 ?? idle0],
        palette,
        intervalMs: 220,
      };
    case "waving":
      return {
        frames: [table.waving_0 ?? idle0, table.waving_1 ?? idle0],
        palette,
        intervalMs: 260,
      };
    case "jumping":
      return {
        frames: [table.jumping_0 ?? idle0, idle0],
        palette,
        intervalMs: 260,
      };
    case "waiting":
      return {
        frames: [table.waiting_0 ?? idle0, idle0],
        palette,
        intervalMs: 480,
      };
    case "review":
      return {
        frames: [table.review_0 ?? idle0, idle0],
        palette,
        intervalMs: 650,
      };
    case "failed":
      return {
        frames: [table.failed_0 ?? idle0, idle1],
        palette,
        intervalMs: 420,
      };
    case "idle":
    default:
      return {
        frames: [idle0, idle0, idle0, idle1],
        palette,
        intervalMs: 680,
      };
  }
}

function renderPixelGrid({ rows, palette }: PixelSpriteFrame) {
  const rects: Array<{ key: string; x: number; y: number; width: number; fill: string }> = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x] ?? ".";
      const fill = palette[ch];
      if (!fill) {
        x += 1;
        continue;
      }
      let run = 1;
      while (x + run < row.length && row[x + run] === ch) {
        run += 1;
      }
      rects.push({ key: `${y}-${x}`, x, y, width: run, fill });
      x += run;
    }
  });
  return rects;
}

export function PixelPetSvg({
  character = "cat",
  state = "idle",
  className = "pet-avatar pixel-pet-svg",
}: {
  character?: BuiltinPetCharacter;
  state?: PetAnimationState;
  className?: string;
}) {
  const { frames, palette, intervalMs } = selectFrames(character, state);
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    if (frames.length <= 1 || typeof window === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % frames.length);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [frames.length, intervalMs, character, state]);

  const activeRows = frames[frameIndex % frames.length] ?? frames[0] ?? [];
  const rects = renderPixelGrid({ rows: activeRows, palette });
  const flipX = state === "running-left";

  return (
    <svg
      className={className}
      viewBox="0 0 18 16"
      shapeRendering="crispEdges"
      aria-hidden="true"
      style={flipX ? { transform: "scaleX(-1)" } : undefined}
    >
      <ellipse cx="8" cy="14.6" rx="5.5" ry="1" fill="rgba(20, 20, 19, 0.14)" />
      {rects.map((r) => (
        <rect key={r.key} x={r.x} y={r.y} width={r.width} height={1} fill={r.fill} />
      ))}
    </svg>
  );
}
