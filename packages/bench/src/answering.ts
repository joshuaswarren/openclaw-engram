import type { BenchResponder } from "./adapters/types.js";

export type BenchmarkAnswerMode = "default" | "strict";

export type BenchmarkAnswerFormat =
  | "auto"
  | "choice-letter"
  | "choice-number"
  | "short"
  | "structured";

export interface BenchmarkAnswerResult {
  finalAnswer: string;
  recalledText: string;
  answeredText: string;
  latencyMs: number;
  tokens: {
    input: number;
    output: number;
  };
  model?: string;
}

export async function answerBenchmarkQuestion(options: {
  question: string;
  recalledText: string;
  responder?: BenchResponder;
  answerMode?: BenchmarkAnswerMode;
  answerFormat?: BenchmarkAnswerFormat;
}): Promise<BenchmarkAnswerResult> {
  if (!options.responder) {
    return {
      finalAnswer: options.recalledText,
      recalledText: options.recalledText,
      answeredText: options.recalledText,
      latencyMs: 0,
      tokens: {
        input: 0,
        output: 0,
      },
    };
  }

  const answerMode = options.answerMode ?? "default";
  const answerFormat =
    options.answerFormat === "auto" || options.answerFormat === undefined
      ? inferAnswerFormat(options.question)
      : options.answerFormat;
  const question =
    answerMode === "strict"
      ? buildStrictBenchmarkQuestion(options.question, answerFormat)
      : options.question;
  const response = await options.responder.respond(
    question,
    options.recalledText,
  );

  return {
    finalAnswer: response.text,
    recalledText: options.recalledText,
    answeredText: response.text,
    latencyMs: response.latencyMs,
    tokens: response.tokens,
    model: response.model,
  };
}

export function buildStrictBenchmarkQuestion(
  question: string,
  answerFormat: BenchmarkAnswerFormat = "auto",
): string {
  const resolvedFormat =
    answerFormat === "auto" ? inferAnswerFormat(question) : answerFormat;
  const instructions = [
    "Benchmark answer protocol:",
    "- Use only the supplied Remnic memory context as evidence.",
    "- Answer the benchmark question directly; do not add prefaces, caveats, or unsupported facts.",
    "- If the context is insufficient, answer \"unknown\".",
    "- Resolve relative temporal references from the timestamps or dated facts in the memory context when possible.",
    "- For date or year questions, prefer the absolute date or year over relative wording like yesterday or last year.",
  ];

  switch (resolvedFormat) {
    case "choice-letter":
      instructions.push(
        "- Return only the selected option letter, such as A, B, C, or D.",
      );
      break;
    case "choice-number":
      instructions.push("- Return only the selected option number.");
      break;
    case "structured":
      instructions.push(
        "- Preserve the requested structured output format exactly and omit unrelated explanation.",
      );
      break;
    case "short":
      instructions.push(
        "- Return the shortest complete answer that satisfies the question.",
      );
      break;
    case "auto":
      break;
    default: {
      const exhaustive: never = resolvedFormat;
      throw new Error(`Unhandled answer format: ${String(exhaustive)}`);
    }
  }

  return `${question}\n\n${instructions.join("\n")}`;
}

export function inferAnswerFormat(question: string): BenchmarkAnswerFormat {
  if (
    /\b[A-D]\.\s+/i.test(question) &&
    (/\bchoices?:/i.test(question) ||
      /\boptions?:/i.test(question) ||
      /final answer:\s*\[letter\]/i.test(question))
  ) {
    return "choice-letter";
  }
  if (/answer choices?:/i.test(question) && /\b1\.\s+/i.test(question)) {
    return "choice-number";
  }
  if (
    /final output format:/i.test(question) ||
    /===\s*traveler plan\s*===/i.test(question) ||
    /the recommendations are:/i.test(question)
  ) {
    return "structured";
  }
  return "auto";
}
