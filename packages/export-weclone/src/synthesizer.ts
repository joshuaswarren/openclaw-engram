/**
 * Training-pair synthesizer.
 *
 * Converts Remnic's flat TrainingExportRecord[] — where
 * `instruction` is a category path and `output` is raw memory
 * content — into natural conversational question-answer pairs
 * suitable for WeClone / LLaMA Factory fine-tuning.
 *
 * Uses template-based question generation (no LLM calls).
 */

import type { TrainingExportRecord } from "@remnic/core";
import type { StyleMarkers } from "./style-extractor.js";

export interface SynthesizerOptions {
  styleMarkers?: StyleMarkers;
  maxPairsPerRecord?: number;
}

/** Default limit for pairs generated per input record. */
const DEFAULT_MAX_PAIRS = 1;

/**
 * Question templates keyed by top-level category.
 * Each array provides variety; the synthesizer picks
 * based on record index for deterministic output.
 */
const QUESTION_TEMPLATES: Record<string, string[]> = {
  preferences: [
    "What kind of {topic} do you like?",
    "What's your preference for {topic}?",
    "What are your favorite {topic}?",
  ],
  opinions: [
    "What do you think about {topic}?",
    "How do you feel about {topic}?",
    "What's your opinion on {topic}?",
  ],
  expertise: [
    "Tell me about {topic}.",
    "What do you know about {topic}?",
    "Can you explain {topic}?",
  ],
  personal: [
    "Can you tell me about your {topic}?",
    "Tell me about your {topic}.",
    "What can you share about your {topic}?",
  ],
};

const DEFAULT_TEMPLATES = [
  "Tell me about {topic}.",
  "What can you share about {topic}?",
];

/**
 * Synthesize natural conversational training pairs from
 * category-tagged memory records.
 */
export function synthesizeTrainingPairs(
  records: TrainingExportRecord[],
  options?: SynthesizerOptions,
): TrainingExportRecord[] {
  const maxPairs = options?.maxPairsPerRecord ?? DEFAULT_MAX_PAIRS;
  const style = options?.styleMarkers;
  const result: TrainingExportRecord[] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const { topCategory, subTopic } = parseCategory(record.instruction);
    const templates = QUESTION_TEMPLATES[topCategory] ?? DEFAULT_TEMPLATES;

    const pairCount = Math.min(maxPairs, templates.length);

    for (let j = 0; j < pairCount; j++) {
      const templateIndex = (i + j) % templates.length;
      const question = templates[templateIndex].replace("{topic}", subTopic);
      let output = record.output;

      if (style?.usesLowercase) {
        output = output.toLowerCase();
      }

      result.push({
        instruction: question,
        input: "",
        output,
        category: record.category,
        confidence: record.confidence,
        sourceIds: record.sourceIds,
      });
    }
  }

  return result;
}

// ── Internals ────────────────────────────────────────────

/**
 * Parse a category path like "preferences/food" into its
 * top-level category and sub-topic for template insertion.
 */
function parseCategory(categoryPath: string): {
  topCategory: string;
  subTopic: string;
} {
  const parts = categoryPath.split("/").filter((p) => p.length > 0);

  if (parts.length === 0) {
    return { topCategory: "", subTopic: "this" };
  }

  const topCategory = parts[0].toLowerCase();
  // Use the last segment as the human-readable topic,
  // replacing underscores/hyphens with spaces
  const rawTopic = parts[parts.length - 1];
  const subTopic = rawTopic.replace(/[-_]/g, " ").toLowerCase() || "this";

  return { topCategory, subTopic };
}
