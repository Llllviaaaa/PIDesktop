import assert from "node:assert/strict";
import {
  nextTranscriptDensity,
  normalizeTranscriptDensity,
  TRANSCRIPT_DENSITY_LABELS,
} from "../src/lib/transcriptDensity";

assert.equal(normalizeTranscriptDensity("summary"), "summary");
assert.equal(normalizeTranscriptDensity("verbose"), "verbose");
assert.equal(normalizeTranscriptDensity("normal"), "normal");
assert.equal(normalizeTranscriptDensity("nope"), "normal");
assert.equal(normalizeTranscriptDensity(undefined), "normal");
assert.equal(nextTranscriptDensity("summary"), "normal");
assert.equal(nextTranscriptDensity("normal"), "verbose");
assert.equal(nextTranscriptDensity("verbose"), "summary");
assert.equal(TRANSCRIPT_DENSITY_LABELS.summary, "摘要");

console.log("transcript-density: all assertions passed");
