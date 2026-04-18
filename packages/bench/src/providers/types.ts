/**
 * Minimal LLM provider contract for the bench engine.
 */

import type { BuiltInProvider } from "../types.js";

export interface CompletionOpts {
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
}

export interface CompletionResult {
  text: string;
  tokens: { input: number; output: number };
  latencyMs: number;
  model: string;
}

export interface DiscoveredModel {
  id: string;
  name: string;
  contextLength: number;
  capabilities: ("completion" | "embedding" | "vision")[];
  quantization?: string;
  parameterCount?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface LlmProvider {
  id: string;
  name: string;
  provider: BuiltInProvider;
  complete(prompt: string, opts?: CompletionOpts): Promise<CompletionResult>;
  embed?(texts: string[]): Promise<number[][]>;
  discover?(): Promise<DiscoveredModel[]>;
  getUsage(): TokenUsage;
  resetUsage(): void;
}
