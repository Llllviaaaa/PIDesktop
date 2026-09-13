export type TranscriptDensity = "summary" | "normal" | "verbose";

export const TRANSCRIPT_DENSITY_ORDER: TranscriptDensity[] = ["summary", "normal", "verbose"];

export const TRANSCRIPT_DENSITY_LABELS: Record<TranscriptDensity, string> = {
  summary: "摘要",
  normal: "普通",
  verbose: "详细",
};

export function normalizeTranscriptDensity(value: unknown): TranscriptDensity {
  return value === "summary" || value === "verbose" ? value : "normal";
}

export function nextTranscriptDensity(current: TranscriptDensity): TranscriptDensity {
  const index = TRANSCRIPT_DENSITY_ORDER.indexOf(normalizeTranscriptDensity(current));
  return TRANSCRIPT_DENSITY_ORDER[(index + 1) % TRANSCRIPT_DENSITY_ORDER.length];
}
