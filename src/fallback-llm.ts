import { log } from "./logger.js";
import type { GatewayConfig, ModelProviderConfig } from "./types.js";

export interface FallbackLlmOptions {
  temperature?: number;
  maxTokens?: number;
}

export interface FallbackLlmResponse {
  content: string;
  modelUsed: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

interface ModelRef {
  providerId: string;
  modelId: string;
  providerConfig: ModelProviderConfig;
  modelString: string;
}

/**
 * Generic fallback LLM client that uses the gateway's default AI configuration
 * and walks through the full fallback chain (primary + fallbacks).
 * Supports OpenAI and Anthropic API formats.
 */
export class FallbackLlmClient {
  private gatewayConfig: GatewayConfig | undefined;

  constructor(gatewayConfig?: GatewayConfig) {
    this.gatewayConfig = gatewayConfig;
  }

  /**
   * Check if fallback is available (gateway config has at least one model).
   */
  isAvailable(): boolean {
    const models = this.getModelChain();
    return models.length > 0;
  }

  /**
   * Make a chat completion request using the gateway's default AI chain.
   * Tries primary first, then each fallback in order.
   */
  async chatCompletion(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options: FallbackLlmOptions = {},
  ): Promise<FallbackLlmResponse | null> {
    const models = this.getModelChain();
    if (models.length === 0) {
      log.warn("fallback LLM: no models configured in gateway");
      return null;
    }

    // Try each model in the chain
    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      const isFallback = i > 0;

      try {
        const result = await this.tryModel(model, messages, options);
        if (result) {
          if (isFallback) {
            log.info(`fallback LLM: succeeded using ${model.modelString} (fallback ${i})`);
          }
          return {
            content: result.content,
            modelUsed: model.modelString,
            usage: result.usage,
          };
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.debug(`fallback LLM: ${model.modelString} failed (${errorMsg}), trying next...`);
        // Continue to next model in chain
      }
    }

    log.warn(`fallback LLM: all ${models.length} models in chain failed`);
    return null;
  }

  /**
   * Make a request with structured output (Zod schema).
   * Returns parsed JSON or null on failure.
   */
  async parseWithSchema<T>(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    schema: { parse: (data: unknown) => T },
    options: FallbackLlmOptions = {},
  ): Promise<T | null> {
    const response = await this.chatCompletion(messages, options);
    if (!response?.content) return null;

    try {
      // Extract JSON from response
      const content = response.content.trim();
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? jsonMatch[0] : content;
      const parsed = JSON.parse(jsonStr);
      return schema.parse(parsed);
    } catch (err) {
      log.warn("fallback LLM: failed to parse structured output:", err);
      return null;
    }
  }

  /**
   * Get the full model chain from gateway config.
   * Returns array of models in order: [primary, fallback1, fallback2, ...]
   */
  private getModelChain(): ModelRef[] {
    const chain: ModelRef[] = [];
    const providers = this.gatewayConfig?.models?.providers;
    const defaultModelConfig = this.gatewayConfig?.agents?.defaults?.model;

    if (!providers) return chain;

    // Build list of model strings: primary + fallbacks
    const modelStrings: string[] = [];

    if (defaultModelConfig?.primary) {
      modelStrings.push(defaultModelConfig.primary);
    }

    if (Array.isArray(defaultModelConfig?.fallbacks)) {
      for (const fb of defaultModelConfig.fallbacks) {
        if (typeof fb === "string" && !modelStrings.includes(fb)) {
          modelStrings.push(fb);
        }
      }
    }

    // Parse each model string and look up provider config
    for (const modelString of modelStrings) {
      const modelRef = this.parseModelString(modelString, providers);
      if (modelRef) {
        chain.push(modelRef);
      }
    }

    return chain;
  }

  /**
   * Parse a "provider/model" string and look up its config.
   */
  private parseModelString(
    modelString: string,
    providers: Record<string, ModelProviderConfig>,
  ): ModelRef | null {
    // Parse "provider/model" format (e.g., "openai/gpt-5.2", "anthropic/claude-opus-4-6")
    const parts = modelString.split("/");
    if (parts.length < 2) {
      log.warn(`fallback LLM: invalid model format: ${modelString}`);
      return null;
    }

    const providerId = parts[0];
    const modelId = parts.slice(1).join("/"); // Handle cases like "openai/gpt-5.2-turbo"

    const providerConfig = providers[providerId];
    if (!providerConfig) {
      log.warn(`fallback LLM: provider not found: ${providerId}`);
      return null;
    }

    return { providerId, modelId, providerConfig, modelString };
  }

  /**
   * Try to call a single model.
   */
  private async tryModel(
    model: ModelRef,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options: FallbackLlmOptions,
  ): Promise<{ content: string; usage?: FallbackLlmResponse["usage"] } | null> {
    switch (model.providerConfig.api) {
      case "anthropic-messages":
        return await this.callAnthropic(model.providerConfig, model.modelId, messages, options);
      case "openai-completions":
      default:
        return await this.callOpenAI(model.providerConfig, model.modelId, messages, options);
    }
  }

  /**
   * Call OpenAI-compatible API.
   */
  private async callOpenAI(
    config: ModelProviderConfig,
    modelId: string,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options: FallbackLlmOptions,
  ): Promise<{ content: string; usage?: FallbackLlmResponse["usage"] } | null> {
    const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...config.headers,
    };

    // Handle auth
    if (config.apiKey) {
      if (config.authHeader !== false) {
        headers["Authorization"] = `Bearer ${config.apiKey}`;
      }
    }

    const body = {
      model: modelId,
      messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 4096,
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${error}`);
    }

    const data = (await response.json()) as {
      choices: Array<{
        message: {
          content: string;
        };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Empty response from OpenAI API");
    }

    return {
      content,
      usage: data.usage
        ? {
            inputTokens: data.usage.prompt_tokens,
            outputTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
    };
  }

  /**
   * Call Anthropic Messages API.
   */
  private async callAnthropic(
    config: ModelProviderConfig,
    modelId: string,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options: FallbackLlmOptions,
  ): Promise<{ content: string; usage?: FallbackLlmResponse["usage"] } | null> {
    const url = `${config.baseUrl.replace(/\/$/, "")}/messages`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...config.headers,
    };

    // Handle auth - Anthropic uses x-api-key header
    if (config.apiKey) {
      headers["x-api-key"] = config.apiKey;
    }

    // Extract system message (Anthropic handles it separately)
    const systemMessage = messages.find((m) => m.role === "system")?.content;
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    // Convert messages to Anthropic format
    const anthropicMessages = nonSystemMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const body: Record<string, unknown> = {
      model: modelId,
      messages: anthropicMessages,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.3,
    };

    if (systemMessage) {
      body.system = systemMessage;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${error}`);
    }

    const data = (await response.json()) as {
      content: Array<{
        type: string;
        text: string;
      }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
      };
    };

    const content = data.content?.[0]?.text;
    if (!content) {
      throw new Error("Empty response from Anthropic API");
    }

    return {
      content,
      usage: data.usage
        ? {
            inputTokens: data.usage.input_tokens,
            outputTokens: data.usage.output_tokens,
            totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
          }
        : undefined,
    };
  }
}
