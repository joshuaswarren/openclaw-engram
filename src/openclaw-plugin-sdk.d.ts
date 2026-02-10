declare module "openclaw/plugin-sdk" {
  export interface OpenClawLogger {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  }

  export interface OpenClawPluginApi {
    logger: OpenClawLogger;
    /** Plugin-specific config block from openclaw.json */
    pluginConfig?: Record<string, unknown>;
    /** Gateway config snapshot (models/providers/agents defaults) */
    config?: unknown;
    on: (
      hook:
        | "before_agent_start"
        | "agent_end"
        | "before_compaction"
        | "after_compaction"
        | string,
      handler: (...args: any[]) => any,
    ) => void;

    registerService: (spec: {
      id: string;
      start?: () => Promise<void> | void;
      stop?: () => Promise<void> | void;
    }) => void;
  }
}
