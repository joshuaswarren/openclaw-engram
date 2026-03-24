import { consolidatePreferences, buildQueryAwarePreferenceSection } from "./src/compounding/preference-consolidator.js";
import type { MemoryFile } from "./src/types.js";

// Simulate what extraction would produce from the LongMemEval preference conversation
const mockMemories: MemoryFile[] = [
  {
    path: "/tmp/test/fact-1.md",
    frontmatter: {
      id: "fact-1",
      category: "fact",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      source: "extraction",
      confidence: 0.9,
      confidenceTier: "explicit" as any,
      tags: ["video-editing"],
    },
    content: "The user is trying to learn more about advanced settings for video editing with Adobe Premiere Pro",
  },
  {
    path: "/tmp/test/pref-1.md", 
    frontmatter: {
      id: "pref-1",
      category: "preference",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      source: "extraction",
      confidence: 0.85,
      confidenceTier: "explicit" as any,
      tags: ["video-editing", "software"],
    },
    content: "The user enjoys using Adobe Premiere Pro for video editing",
  },
  {
    path: "/tmp/test/fact-2.md",
    frontmatter: {
      id: "fact-2",
      category: "fact",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      source: "extraction",
      confidence: 0.8,
      confidenceTier: "implied" as any,
      tags: ["photography"],
    },
    content: "The user uses a Sony camera for photography and is interested in high-quality photography gear",
  },
  {
    path: "/tmp/test/pref-2.md",
    frontmatter: {
      id: "pref-2",
      category: "preference",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      source: "extraction",
      confidence: 0.9,
      confidenceTier: "explicit" as any,
      tags: ["ai", "healthcare"],
    },
    content: "The user is interested in artificial intelligence in healthcare, particularly deep learning for medical image analysis",
  },
];

console.log("=== Testing IRC Preference Consolidation ===\n");

const result = consolidatePreferences(mockMemories, {
  maxPreferences: 20,
  includeCorrections: true,
  minConfidence: 0.3,
});

console.log("Preferences found:", result.preferences.length);
for (const p of result.preferences) {
  console.log(`  [${p.category}] ${p.statement}`);
  console.log(`    Keywords: ${p.keywords.join(", ")}`);
}
console.log("\n=== Recall Section ===");
console.log(result.recallSection ?? "(none)");

console.log("\n=== Query: 'video editing resources' ===");
const videoSection = buildQueryAwarePreferenceSection(result.preferences, "Can you recommend some resources where I can learn more about video editing?");
console.log(videoSection ?? "(none)");

console.log("\n=== Query: 'photography accessories' ===");
const photoSection = buildQueryAwarePreferenceSection(result.preferences, "Can you suggest some accessories that would complement my current photography setup?");
console.log(photoSection ?? "(none)");

console.log("\n=== Query: 'recent publications' ===");
const pubSection = buildQueryAwarePreferenceSection(result.preferences, "Can you recommend some recent publications or conferences that I might find interesting?");
console.log(pubSection ?? "(none)");
