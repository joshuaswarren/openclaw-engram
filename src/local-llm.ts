import { log } from "./logger.js";
import type { PluginConfig } from "./types.js";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { ModelRegistry } from "./model-registry.js";

/**
 * Local LLM client for OpenAI-compatible endpoints (LM Studio, Ollama, MLX, etc.)
 *
 * Based on openclaw-tactician's provider detection patterns for consistency.
 * Provides privacy-preserving, cost-effective LLM operations with
 * graceful fallback to cloud providers when local LLM is unavailable.
 */
export type LocalLlmType = "lmstudio" | "ollama" | "mlx" | "vllm" | "generic";

interface LocalServerConfig {
  type: LocalLlmType;
  defaultPort: number;
  healthEndpoint: string;
  modelsEndpoint: string;
  detectFn: (response: unknown) => boolean;
}

const LOCAL_SERVERS: LocalServerConfig[] = [
  {
    type: "ollama",
    defaultPort: 11434,
    healthEndpoint: "/",
    modelsEndpoint: "/api/tags",
    detectFn: (resp) => typeof resp === "string" && resp.includes("Ollama"),
  },
  {
    type: "mlx",
    defaultPort: 8080,
    healthEndpoint: "/v1/models",
    modelsEndpoint: "/v1/models",
    detectFn: (resp) =>
      typeof resp === "object" &&
      resp !== null &&
      "data" in resp &&
      Array.isArray((resp as { data: unknown[] }).data),
  },
  {
    type: "lmstudio",
    defaultPort: 1234,
    healthEndpoint: "/v1/models",
    modelsEndpoint: "/v1/models",
    detectFn: (resp) =>
      typeof resp === "object" &&
      resp !== null &&
      "data" in resp &&
      Array.isArray((resp as { data: unknown[] }).data),
  },
  {
    type: "vllm",
    defaultPort: 8000,
    healthEndpoint: "/health",
    modelsEndpoint: "/v1/models",
    detectFn: (resp) => resp === "" || (typeof resp === "object" && resp !== null),
  },
];

export interface LocalModelInfo {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
}

export class LocalLlmClient {
  private config: PluginConfig;
  private isAvailable: boolean | null = null;
  private lastHealthCheck: number = 0;
  private detectedType: LocalLlmType | null = null;
  private cachedModelInfo: LocalModelInfo | null = null;
  private cachedLmsContext: number | null = null;
  private lastLmsCheck: number = 0;
  private modelRegistry?: ModelRegistry;
  private static readonly HEALTH_CHECK_INTERVAL_MS = 60000; // 1 minute
  private static readonly LMS_CACHE_INTERVAL_MS = 30000; // 30 seconds

  constructor(config: PluginConfig, modelRegistry?: ModelRegistry) {
    this.config = config;
    this.modelRegistry = modelRegistry;
  }

  /**
   * Set the ModelRegistry for caching detected capabilities
   */
  setModelRegistry(registry: ModelRegistry): void {
    this.modelRegistry = registry;
  }

  /**
   * Get the detected server type (null if not detected)
   */
  getDetectedType(): LocalLlmType | null {
    return this.detectedType;
  }

  /**
   * Fetch with timeout for health checks
   */
  private async fetchWithTimeout(
    url: string,
    timeoutMs: number = 2000
  ): Promise<{ ok: boolean; data: unknown }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return { ok: false, data: null };
      }

      const contentType = response.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        return { ok: true, data: await response.json() };
      } else {
        return { ok: true, data: await response.text() };
      }
    } catch (err) {
      clearTimeout(timeout);
      return { ok: false, data: null };
    }
  }

  /**
   * Check if local LLM is available
   * Uses 127.0.0.1 instead of localhost to avoid DNS issues (consistent with tactician)
   */
  async checkAvailability(): Promise<boolean> {
    // Cache health check results for 1 minute
    const now = Date.now();
    if (this.isAvailable !== null && now - this.lastHealthCheck < LocalLlmClient.HEALTH_CHECK_INTERVAL_MS) {
      return this.isAvailable;
    }

    // Normalize URL - replace localhost with 127.0.0.1, remove trailing slashes
    const baseUrl = this.config.localLlmUrl
      .replace("localhost", "127.0.0.1")
      .replace(/\/+$/, "");

    // Try to detect which server type is running
    for (const serverConfig of LOCAL_SERVERS) {
      const healthUrl = `${baseUrl}${serverConfig.healthEndpoint}`;
      log.debug(`checking ${serverConfig.type} at ${healthUrl}`);

      const result = await this.fetchWithTimeout(healthUrl);
      if (result.ok && serverConfig.detectFn(result.data)) {
        this.isAvailable = true;
        this.detectedType = serverConfig.type;
        this.lastHealthCheck = now;
        log.info(`detected ${serverConfig.type} at ${baseUrl}`);
        return true;
      }
    }

    // Generic check if specific detection failed
    try {
      const modelsUrl = `${baseUrl}/v1/models`;
      const result = await this.fetchWithTimeout(modelsUrl);
      if (result.ok) {
        this.isAvailable = true;
        this.detectedType = "generic";
        this.lastHealthCheck = now;
        log.info(`detected generic OpenAI-compatible server at ${baseUrl}`);
        return true;
      }
    } catch {
      // Fall through to unavailable
    }

    this.isAvailable = false;
    this.detectedType = null;
    this.lastHealthCheck = now;
    log.debug("local LLM not available at", baseUrl);
    return false;
  }

  /**
   * Try to get context window from LM Studio settings.json as fallback.
   * This reads the defaultContextLength setting which is what LM Studio uses
   * when loading models without explicit context configuration.
   */
  private getContextFromLmStudioSettings(): number | null {
    try {
      const homeDir = process.env.HOME || `/Users/${process.env.USER || "joshuawarren"}`;
      const settingsPath = `${homeDir}/.cache/lm-studio/settings.json`;

      if (!existsSync(settingsPath)) {
        log.debug(`LM Studio settings: file not found at ${settingsPath}`);
        return null;
      }

      const content = readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(content) as {
        defaultContextLength?: {
          type?: string;
          value?: number;
        };
      };

      if (settings.defaultContextLength?.value) {
        const contextWindow = settings.defaultContextLength.value;
        log.debug(`LM Studio settings: found default context length: ${contextWindow}`);
        return contextWindow;
      }

      return null;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.debug(`LM Studio settings: failed to read - ${errorMsg}`);
      return null;
    }
  }

  /**
   * Try to get context window from LMS CLI (LM Studio specific).
   * Uses --json flag for reliable parsing.
   * Returns null if LMS CLI is not available or model not found.
   */
  private getContextFromLmsCli(modelId: string): number | null {
    try {
      // Check if lms CLI exists in common locations
      // Note: process.env.HOME may not be set in launchd environment
      const homeDir = process.env.HOME || `/Users/${process.env.USER || "joshuawarren"}`;
      const lmsPaths = [
        `${homeDir}/.cache/lm-studio/bin/lms`,
        "/usr/local/bin/lms",
        "/opt/homebrew/bin/lms",
      ];

      const lmsPath = lmsPaths.find((p) => existsSync(p));
      if (!lmsPath) {
        log.debug(`LMS CLI: not found in standard locations (checked: ${lmsPaths.join(", ")})`);
        return null;
      }

      // Run lms ps --json to get loaded models with context
      // Use spawnSync with shell and explicit PATH to ensure lms can find its dependencies
      log.debug(`LMS CLI: running: ${lmsPath} ps --json`);
      const result = spawnSync(lmsPath, ["ps", "--json"], {
        encoding: "utf-8",
        timeout: 5000,
        shell: false, // Don't use shell for JSON output - more reliable
        env: {
          ...process.env,
          PATH: `/Users/joshuawarren/.cache/lm-studio/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH || ""}`,
          HOME: `/Users/joshuawarren`,
        },
      });

      if (result.error) {
        log.debug(`LMS CLI: spawn error - ${result.error.message}`);
        return null;
      }

      if (result.stderr && result.stderr.trim()) {
        log.debug(`LMS CLI: stderr - ${result.stderr.slice(0, 200)}`);
      }

      const output = result.stdout || "";
      if (!output.trim()) {
        log.debug("LMS CLI: empty output - LM Studio may not be running or no models loaded");
        return null;
      }

      // Parse JSON output
      let models: Array<{
        identifier?: string;
        modelKey?: string;
        contextLength?: number;
        maxContextLength?: number;
      }>;

      try {
        models = JSON.parse(output) as typeof models;
      } catch (parseErr) {
        log.debug(`LMS CLI: JSON parse error - ${parseErr}`);
        return null;
      }

      if (!Array.isArray(models) || models.length === 0) {
        log.debug("LMS CLI: no models loaded");
        return null;
      }

      // Find the model matching our configured model ID
      const model = models.find((m) =>
        m.identifier === modelId ||
        m.modelKey === modelId ||
        (m.identifier?.includes(modelId.replace(/@\d+bit$/, "")))
      );

      if (!model) {
        log.debug(`LMS CLI: model "${modelId}" not found in loaded models: ${models.map(m => m.identifier).join(", ")}`);
        return null;
      }

      // Use contextLength (actual configured) or fall back to maxContextLength (model max)
      const contextWindow = model.contextLength || model.maxContextLength;

      if (contextWindow) {
        log.info(`LMS CLI detected context window: ${contextWindow} for ${modelId} (max: ${model.maxContextLength})`);
        return contextWindow;
      }

      return null;
    } catch (err) {
      // LMS CLI not available or failed
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.debug(`LMS CLI: failed - ${errorMsg}`);
      return null;
    }
  }

  /**
   * Get full model info from LMS CLI including context length and max context length.
   * Returns null if LMS CLI is unavailable or model not found.
   */
  private getLmsModelInfo(modelId: string): { contextLength: number; maxContextLength: number; identifier: string } | null {
    try {
      const result = spawnSync("lms", ["ps", "--json"], {
        encoding: "utf-8",
        timeout: 5000,
        shell: false,
      });

      if (result.error) {
        return null;
      }

      const output = result.stdout || "";
      if (!output.trim()) {
        return null;
      }

      let models: Array<{
        identifier?: string;
        modelKey?: string;
        contextLength?: number;
        maxContextLength?: number;
      }>;

      try {
        models = JSON.parse(output) as typeof models;
      } catch {
        return null;
      }

      if (!Array.isArray(models) || models.length === 0) {
        return null;
      }

      const model = models.find((m) =>
        m.identifier === modelId ||
        m.modelKey === modelId ||
        (m.identifier?.includes(modelId.replace(/@\d+bit$/, "")))
      );

      if (!model || !model.contextLength) {
        return null;
      }

      return {
        contextLength: model.contextLength,
        maxContextLength: model.maxContextLength || model.contextLength,
        identifier: model.identifier || modelId,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get context window for the configured model, using cache if available.
   * This method caches the result to avoid repeated LMS CLI calls.
   * Order: ModelRegistry (persistent) -> memory cache -> LMS CLI -> settings.json
   */
  getCachedContextWindow(modelId: string): number | null {
    const now = Date.now();

    // 1. Check ModelRegistry for persisted context window
    if (this.modelRegistry) {
      const caps = this.modelRegistry.getCapabilities(modelId);
      if (caps.source === "lmstudio" && caps.contextWindow) {
        log.debug(`ModelRegistry: using persisted LM Studio context: ${caps.contextWindow}`);
        // Also update memory cache
        this.cachedLmsContext = caps.contextWindow;
        this.lastLmsCheck = now;
        return caps.contextWindow;
      }
    }

    // 2. Return in-memory cached value if still valid
    if (this.cachedLmsContext && now - this.lastLmsCheck < LocalLlmClient.LMS_CACHE_INTERVAL_MS) {
      log.debug(`LMS CLI: returning in-memory cached context: ${this.cachedLmsContext}`);
      return this.cachedLmsContext;
    }

    // 3. Try LMS CLI (authoritative source)
    const lmsInfo = this.getLmsModelInfo(modelId);
    if (lmsInfo?.contextLength) {
      this.cachedLmsContext = lmsInfo.contextLength;
      this.lastLmsCheck = now;
      // Calculate appropriate output tokens based on context size
      // Use 12.5% of context window, capped at 16K (generous but safe)
      const calculatedOutputTokens = Math.min(Math.floor(lmsInfo.contextLength / 8), 16384);
      const outputTokens = Math.max(calculatedOutputTokens, 4096); // Minimum 4K
      // Persist to ModelRegistry with detected capabilities
      if (this.modelRegistry) {
        this.modelRegistry.setCapabilities(modelId, {
          maxPositionEmbeddings: lmsInfo.maxContextLength || lmsInfo.contextLength,
          contextWindow: lmsInfo.contextLength,
          supportsExtendedContext: (lmsInfo.maxContextLength || lmsInfo.contextLength) > 65536,
          typicalOutputTokens: outputTokens,
          source: "lmstudio",
        });
        log.info(`LMS CLI: Stored capabilities for ${modelId}: ${lmsInfo.contextLength} context, ${outputTokens} output tokens`);
      }
      return lmsInfo.contextLength;
    }

    // Legacy: Try LMS CLI context only (fallback)
    const legacyContext = this.getContextFromLmsCli(modelId);
    if (legacyContext) {
      this.cachedLmsContext = legacyContext;
      this.lastLmsCheck = now;
      // Persist to ModelRegistry with calculated output tokens
      if (this.modelRegistry) {
        const calculatedOutputTokens = Math.min(Math.floor(legacyContext / 8), 16384);
        const outputTokens = Math.max(calculatedOutputTokens, 4096);
        this.modelRegistry.setCapabilities(modelId, {
          maxPositionEmbeddings: legacyContext,
          contextWindow: legacyContext,
          supportsExtendedContext: false,
          typicalOutputTokens: outputTokens,
          source: "lmstudio",
        });
      }
      return legacyContext;
    }

    // 4. Fall back to LM Studio settings.json
    const settingsContext = this.getContextFromLmStudioSettings();
    if (settingsContext) {
      log.info(`LM Studio settings: using default context: ${settingsContext}`);
      this.cachedLmsContext = settingsContext;
      this.lastLmsCheck = now;
      return settingsContext;
    }

    return null;
  }

  /**
   * Clear the LMS context cache. Call this when the model changes.
   */
  clearContextCache(): void {
    this.cachedLmsContext = null;
    this.lastLmsCheck = 0;
    log.debug("LMS CLI: context cache cleared");
  }

  /**
   * Query the local LLM server for loaded model information.
   * Returns null if unavailable or if the model is not found.
   */
  async getLoadedModelInfo(): Promise<LocalModelInfo | null> {
    const baseUrl = this.config.localLlmUrl
      .replace("localhost", "127.0.0.1")
      .replace(/\/+$/, "");

    // Handle URL construction - localLlmUrl may already include /v1
    const modelsUrl = baseUrl.endsWith("/v1")
      ? `${baseUrl}/models`
      : `${baseUrl}/v1/models`;
    log.info(`Fetching model info from ${modelsUrl}`);

    try {
      const result = await this.fetchWithTimeout(modelsUrl, 3000);
      if (!result.ok) {
        log.warn(`Local LLM: Failed to fetch models from ${modelsUrl} - server returned error`);
        return null;
      }
      if (!result.data) {
        log.warn(`Local LLM: No data returned from ${modelsUrl}`);
        return null;
      }

      const data = result.data as {
        data?: Array<{
          id?: string;
          object?: string;
          owned_by?: string;
          // LM Studio specific fields
          max_context_length?: number;
          max_tokens?: number;
          // Ollama specific
          name?: string;
          details?: {
            parameter_size?: string;
            family?: string;
          };
        }>;
      };

      if (!Array.isArray(data.data) || data.data.length === 0) {
        log.warn("Local LLM returned no models");
        return null;
      }

      // Verbose model listings are noisy on every gateway restart. Keep it debug-only.
      const modelIds = data.data.map((m) => m.id).filter(Boolean);
      log.debug(
        `Local LLM: Found ${modelIds.length} model(s). First 10: ${modelIds.slice(0, 10).join(", ")}`,
      );

      // Find the model matching our configured model ID
      const configuredModel = this.config.localLlmModel;
      let model = data.data.find((m) => m.id === configuredModel);

      // If not found by exact match, try partial match (handle suffixes like @4bit)
      if (!model) {
        model = data.data.find((m) =>
          configuredModel.includes(m.id || "") ||
          (m.id || "").includes(configuredModel.replace(/@\d+bit$/, ""))
        );
      }

      // If still not found, use the first loaded model and warn
      if (!model) {
        model = data.data[0];
        const availablePreview = data.data
          .map((m) => m.id)
          .filter(Boolean)
          .slice(0, 10)
          .join(", ");
        log.warn(
          `Configured model "${configuredModel}" not found in local LLM. ` +
          `Using "${model.id}" instead. Available (first 10): ${availablePreview}`
        );
      }

      // Extract context window - try multiple field names
      let contextWindow = model.max_context_length || model.max_tokens;

      // If API doesn't report context window, try LMS CLI (LM Studio specific)
      if (!contextWindow) {
        log.info("Local LLM: API did not report context window, trying LMS CLI...");
        const lmsContext = this.getCachedContextWindow(model.id || "");
        if (lmsContext) {
          contextWindow = lmsContext;
        }
      }

      this.cachedModelInfo = {
        id: model.id || "unknown",
        contextWindow: contextWindow,
        maxTokens: model.max_tokens,
      };

      log.info(
        `Local LLM model detected: ${this.cachedModelInfo.id}, ` +
        `context window: ${contextWindow?.toLocaleString() || "unknown (may use default)"}`
      );

      return this.cachedModelInfo;
    } catch (err) {
      log.warn(`Failed to fetch model info: ${err}`);
      return null;
    }
  }

  /**
   * Check if the configured model is available and get its actual context window.
   * Warns if there's a mismatch between expected and actual context.
   */
  async validateModelConfig(expectedContextWindow?: number): Promise<{
    available: boolean;
    actualContextWindow?: number;
    warnings: string[];
  }> {
    const warnings: string[] = [];

    const modelInfo = await this.getLoadedModelInfo();
    if (!modelInfo) {
      return { available: false, warnings: ["Could not query local LLM for model info"] };
    }

    // If we have expected context and the server reports one, check for mismatch
    if (expectedContextWindow && modelInfo.contextWindow) {
      if (modelInfo.contextWindow < expectedContextWindow) {
        warnings.push(
          `Context window mismatch: Model ${modelInfo.id} supports ${modelInfo.contextWindow.toLocaleString()} tokens, ` +
          `but engram is configured for ${expectedContextWindow.toLocaleString()}. ` +
          `Set localLlmMaxContext: ${modelInfo.contextWindow} in config to avoid errors.`
        );
      }
    }

    // Warn if server doesn't report context window (common with some local LLM setups)
    if (!modelInfo.contextWindow) {
      warnings.push(
        `Local LLM server did not report context window for ${modelInfo.id}. ` +
        `If you get "context length exceeded" errors, set localLlmMaxContext in config.`
      );
    }

    return {
      available: true,
      actualContextWindow: modelInfo.contextWindow,
      warnings,
    };
  }

  /**
   * Make a chat completion request to local LLM
   */
  async chatCompletion(
    messages: Array<{ role: string; content: string }>,
    options: {
      temperature?: number;
      maxTokens?: number;
      responseFormat?: { type: string };
    } = {}
  ): Promise<{
    content: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  } | null> {
    log.debug(
      `local LLM chatCompletion: localLlmEnabled=${this.config.localLlmEnabled}, model=${this.config.localLlmModel}`,
    );
    if (!this.config.localLlmEnabled) {
      log.debug("local LLM: disabled, returning null");
      return null;
    }

    const isAvailable = await this.checkAvailability();
    if (!isAvailable) {
      log.debug(
        `local LLM: checkAvailability returned false for ${this.config.localLlmUrl}`,
      );
      return null;
    }

    try {
      const startedAtMs = Date.now();
      const requestBody: Record<string, unknown> = {
        model: this.config.localLlmModel,
        messages,
        temperature: options.temperature ?? 0.7,
        // Use max_tokens consistent with cloud models
        max_tokens: options.maxTokens ?? 4096,
      };

      // Skip response_format for local LLMs - they don't support json_object type
      // The prompts already instruct the model to output JSON
      // Only send if it's json_schema type which some local LLMs support
      if (options.responseFormat?.type === "json_schema") {
        requestBody.response_format = options.responseFormat;
      }

      // Normalize URL (use 127.0.0.1 instead of localhost)
      const baseUrl = this.config.localLlmUrl
        .replace("localhost", "127.0.0.1")
        .replace(/\/+$/, "");
      const chatUrl = `${baseUrl}/chat/completions`;

      const requestBodyJson = JSON.stringify(requestBody);
      log.debug(
        `local LLM: sending request to ${chatUrl} with model ${this.config.localLlmModel}`,
      );
      // Avoid logging request bodies by default (can contain sensitive user content).
      log.debug(`local LLM: request body length=${requestBodyJson.length}`);

      // Write request body to file for debugging
      if (this.config.debug) {
        try {
          const { writeFileSync } = await import("node:fs");
          writeFileSync("/tmp/engram-last-request.json", requestBodyJson);
        } catch {
          /* ignore */
        }
      }

      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), this.config.localLlmTimeoutMs);
      const response = await fetch(chatUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: abort.signal,
      });
      clearTimeout(timeout);

      log.debug(
        `local LLM: received response, status=${response.status}, ok=${response.ok}`,
      );

      if (!response.ok) {
        let reason = "";
        try {
          const errorText = await response.text();
          // Try to extract a stable error message without logging content.
          try {
            const parsed = JSON.parse(errorText) as { error?: { message?: string } };
            reason = parsed?.error?.message ? ` — ${parsed.error.message}` : "";
          } catch {
            // Keep a short preview in debug only.
            log.debug(`local LLM error body: ${errorText.slice(0, 500)}`);
          }
        } catch (e) {
          log.debug(`local LLM failed to read error body: ${e}`);
        }
        log.warn(
          `local LLM request failed: ${response.status} ${response.statusText}${reason}`,
        );
        return null;
      }

      const data = (await response.json()) as {
        choices?: Array<{
          message?: { content?: string };
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };

      log.debug(
        `local LLM response: choices=${data.choices?.length}, usage=${JSON.stringify(data.usage)}`,
      );

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        log.warn(`local LLM returned empty content. choices=${JSON.stringify(data.choices)?.slice(0, 200)}`);
        return null;
      }

      // Estimate tokens if not provided by local LLM
      const usage = data.usage
        ? {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
            totalTokens: data.usage.total_tokens ?? 0,
          }
        : this.estimateTokens(messages, content);

      const durationMs = Date.now() - startedAtMs;
      if (this.config.slowLogEnabled && durationMs >= this.config.slowLogThresholdMs) {
        const promptChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
        log.warn(
          `SLOW local LLM: durationMs=${durationMs} model=${this.config.localLlmModel} url=${chatUrl} promptChars=${promptChars} outputTokens=${usage.completionTokens} totalTokens=${usage.totalTokens}`,
        );
      }

      log.debug("local LLM: request succeeded, tokens:", usage.totalTokens);
      return { content, usage };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(`local LLM request error: ${errMsg}`);
      this.isAvailable = false; // Mark as unavailable on error
      return null;
    }
  }

  /**
   * Estimate tokens when local LLM doesn't return usage stats
   * Rough estimate: 1 token ≈ 4 characters
   */
  private estimateTokens(
    messages: Array<{ role: string; content: string }>,
    response: string
  ): { promptTokens: number; completionTokens: number; totalTokens: number } {
    const promptChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    const promptTokens = Math.ceil(promptChars / 4);
    const completionTokens = Math.ceil(response.length / 4);

    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  }

  /**
   * Try local LLM first, fallback to cloud provider if configured
   */
  async withFallback<T>(
    localOperation: () => Promise<T | null>,
    fallbackOperation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    // Try local LLM first if enabled
    if (this.config.localLlmEnabled) {
      const localResult = await localOperation();
      if (localResult !== null) {
        log.debug(`${operationName}: used local LLM`);
        return localResult;
      }

      // Local failed or unavailable
      if (this.config.localLlmFallback) {
        log.info(`${operationName}: local LLM unavailable, falling back to cloud`);
      } else {
        throw new Error(`${operationName}: local LLM unavailable and fallback disabled`);
      }
    }

    // Use fallback (cloud provider)
    return fallbackOperation();
  }
}
