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
  retryOptions?: { maxAttempts?: number; baseBackoffMs?: number; timeoutMs?: number };
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

/**
 * `local-llm` targets a user-hosted OpenAI-compatible endpoint
 * (llama.cpp, vLLM, LM Studio, etc.). `baseUrl` is required at the
 * CLI layer — it mirrors the plugin's `localLlmUrl` config and is
 * what tells the bench which local server to talk to. The transport
 * is intentionally OpenAI-compatible: `/v1/chat/completions` +
 * `/v1/models`. Issue #566 slice 5.
 */
export interface LocalLlmProviderConfig extends ProviderBaseConfig {
  provider?: "local-llm";
  baseUrl: string;
}

export type ProviderFactoryConfig =
  | (OpenAiCompatibleProviderConfig & { provider: "openai" | "litellm" })
  | (AnthropicProviderConfig & { provider: "anthropic" })
  | (OllamaProviderConfig & { provider: "ollama" })
  | (LocalLlmProviderConfig & { provider: "local-llm" });

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
