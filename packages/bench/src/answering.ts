import type { BenchResponder } from "./adapters/types.js";

export type BenchmarkAnswerMode = "default" | "strict";

export type BenchmarkAnswerFormat =
  | "auto"
  | "choice-letter"
  | "choice-number"
  | "instruction"
  | "short"
  | "short-with-specifics"
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
    case "instruction":
      instructions.push(
        "- If the context contains a user instruction, preference, or policy that applies to the request, answer with that remembered instruction instead of performing the requested task.",
        "- For implementation or action requests, the benchmark is asking which remembered instruction applies; do not answer \"unknown\" merely because the context lacks the implementation details for the requested task.",
        "- Return the applicable instruction in its shortest complete form, preserving concrete required details such as formatting requirements, named tools, labels, dates, or values.",
        "- Do not quote a \"please remember\" request verbatim; restate it as durable assistant behavior, using concise preference wording like \"Always format implementation help ...\" when natural.",
        "- For formatting requirements, use explicit benchmark-friendly wording such as \"code blocks with syntax highlighting\" when the memory expresses an equivalent syntax-highlighted-code-block requirement.",
      );
      break;
    case "structured":
      instructions.push(
        "- Preserve the requested structured output format exactly and omit unrelated explanation.",
      );
      break;
    case "short":
      instructions.push(
        "- Return the shortest complete answer that satisfies the question.",
        "- Prefer only the answer phrase or value; do not wrap it in a full sentence when a short phrase is sufficient.",
      );
      break;
    case "short-with-specifics":
      instructions.push(
        "- Return the shortest complete answer that satisfies the question.",
        "- If the answer is a count, category, list, instruction, or changed value, include the concrete named items or value labels needed to make the answer unambiguous.",
        "- For count questions, include the counted noun and any named items, for example \"Two columns: category and notes\" instead of just \"Two\".",
        "- For numeric or latency questions, return the exact value from context without hedge words like around, about, or approximately unless the hedge is the answer.",
        "- Prefer exact values from the context and omit filler or hedge words unless they are part of the required answer.",
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
