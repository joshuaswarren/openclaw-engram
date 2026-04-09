/**
 * @remnic/plugin-openclaw — OpenClaw bridge plugin for Remnic.
 *
 * This package is the thin bridge between OpenClaw and the Remnic memory engine.
 * It re-exports the full plugin implementation from the root src/ (until Phase 1
 * core extraction moves framework-agnostic code to @remnic/core), and adds the
 * embedded/delegate bridge mode for multi-agent memory sharing.
 *
 * Modes:
 *   - Embedded: Starts EMO in-process AND exposes HTTP :4318 for external agents
 *   - Delegate: Connects to a running EMO daemon (set by `engram daemon install`)
 *
 * OpenClaw loads this package via `openclaw.plugin.json` → `main` field.
 */

// Re-export the full plugin — no modifications
export * from "../../../src/index.js";
export { default } from "../../../src/index.js";

// Bridge mode detection and health checks
export {
  detectBridgeMode,
  checkDaemonHealth,
  type BridgeMode,
  type BridgeConfig,
} from "./bridge.js";
