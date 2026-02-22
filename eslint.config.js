// ESLint flat config for openclaw-engram.
// Primary lint gate is `tsc --noEmit` (run via `npm run check-types`).
// This config is provided for editor integration and CI tooling compatibility.
// Note: Biome (biome.json) handles formatting and additional lint rules.

export default [
  {
    ignores: ["dist/**", "node_modules/**", "*.map"],
  },
];
