import type { BenchResponder } from "./adapters/types.js";

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

  const response = await options.responder.respond(
    options.question,
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
