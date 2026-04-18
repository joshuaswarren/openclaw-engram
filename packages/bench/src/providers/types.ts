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

export interface ProviderBaseConfig {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface OpenAiCompatibleProviderConfig extends ProviderBaseConfig {
  provider?: "openai" | "litellm";
}

export interface AnthropicProviderConfig extends ProviderBaseConfig {
  provider?: "anthropic";
  anthropicVersion?: string;
}

export interface OllamaProviderConfig extends ProviderBaseConfig {
  provider?: "ollama";
}

export type ProviderFactoryConfig =
  | (OpenAiCompatibleProviderConfig & { provider: "openai" | "litellm" })
  | (AnthropicProviderConfig & { provider: "anthropic" })
  | (OllamaProviderConfig & { provider: "ollama" });

export interface ProviderDiscoveryResult {
  provider: BuiltInProvider;
  models: DiscoveredModel[];
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
