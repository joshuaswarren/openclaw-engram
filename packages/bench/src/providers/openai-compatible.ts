/**
 * Minimal OpenAI-compatible provider for phase 1 bench execution.
 */

import type {
  CompletionOpts,
  CompletionResult,
  DiscoveredModel,
  LlmProvider,
  TokenUsage,
} from "./types.js";

export interface OpenAiCompatibleProviderConfig {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

interface ChatCompletionResponse {
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

interface ModelsResponse {
  data?: Array<{
    id: string;
    name?: string;
    context_length?: number;
    capabilities?: Array<"completion" | "embedding" | "vision">;
    quantization?: string;
    parameter_count?: string;
  }>;
}

class OpenAiCompatibleProvider implements LlmProvider {
  readonly provider = "openai" as const;
  readonly id: string;
  readonly name: string;

  private readonly config: Required<Pick<OpenAiCompatibleProviderConfig, "model">> &
    OpenAiCompatibleProviderConfig;
  private usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  constructor(config: OpenAiCompatibleProviderConfig) {
    this.config = config;
    this.id = `openai:${config.model}`;
    this.name = config.model;
  }

  async complete(
    prompt: string,
    opts: CompletionOpts = {},
  ): Promise<CompletionResult> {
    const startedAt = performance.now();
    const response = await fetch(this.urlFor("chat/completions"), {
      method: "POST",
      headers: this.headers(opts.headers),
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          ...(opts.systemPrompt
            ? [{ role: "system", content: opts.systemPrompt }]
            : []),
          { role: "user", content: prompt },
        ],
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI-compatible completion failed: ${response.status} ${response.statusText}`,
      );
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const promptTokens = payload.usage?.prompt_tokens ?? 0;
    const completionTokens = payload.usage?.completion_tokens ?? 0;

    this.recordUsage(promptTokens, completionTokens);

    return {
      text: readMessageText(payload),
      tokens: {
        input: promptTokens,
        output: completionTokens,
      },
      latencyMs: Math.round(performance.now() - startedAt),
      model: payload.model ?? this.config.model,
    };
  }

  async discover(): Promise<DiscoveredModel[]> {
    const response = await fetch(this.urlFor("models"), {
      method: "GET",
      headers: this.headers(),
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI-compatible model discovery failed: ${response.status} ${response.statusText}`,
      );
    }

    const payload = (await response.json()) as ModelsResponse;
    return (payload.data ?? []).map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      contextLength: model.context_length ?? 0,
      capabilities: model.capabilities ?? ["completion"],
      ...(model.quantization
        ? { quantization: model.quantization }
        : {}),
      ...(model.parameter_count
        ? { parameterCount: model.parameter_count }
        : {}),
    }));
  }

  getUsage(): TokenUsage {
    return { ...this.usage };
  }

  resetUsage(): void {
    this.usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
  }

  private headers(extraHeaders: Record<string, string> = {}): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.config.apiKey
        ? { authorization: `Bearer ${this.config.apiKey}` }
        : {}),
      ...(this.config.headers ?? {}),
      ...extraHeaders,
    };
  }

  private recordUsage(inputTokens: number, outputTokens: number): void {
    this.usage = {
      inputTokens: this.usage.inputTokens + inputTokens,
      outputTokens: this.usage.outputTokens + outputTokens,
      totalTokens:
        this.usage.totalTokens + inputTokens + outputTokens,
    };
  }

  private urlFor(pathname: string): string {
    const baseUrl = this.config.baseUrl ?? "https://api.openai.com/v1";
    const normalizedBase = baseUrl.endsWith("/")
      ? baseUrl.slice(0, -1)
      : baseUrl;
    const normalizedPath = pathname.startsWith("/")
      ? pathname.slice(1)
      : pathname;

    return `${normalizedBase}/${normalizedPath}`;
  }
}

function readMessageText(payload: ChatCompletionResponse): string {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => part.text ?? "")
      .join("")
      .trim();
  }

  return "";
}

export function createOpenAiCompatibleProvider(
  config: OpenAiCompatibleProviderConfig,
): LlmProvider {
  return new OpenAiCompatibleProvider(config);
}
