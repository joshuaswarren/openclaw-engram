/**
 * @remnic/export-weclone
 *
 * WeClone-specific training-data export adapter that converts
 * Remnic memories into Alpaca-format fine-tuning datasets
 * compatible with WeClone / LLaMA Factory.
 */

export { wecloneExportAdapter } from "./adapter.js";
export { synthesizeTrainingPairs, type SynthesizerOptions } from "./synthesizer.js";
export { extractStyleMarkers, type StyleMarkers } from "./style-extractor.js";
export { sweepPii, type PrivacySweepResult } from "./privacy.js";
