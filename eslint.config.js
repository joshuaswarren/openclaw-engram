// ESLint flat config for openclaw-engram.
// Primary lint gate is `tsc --noEmit` (run via `npm run lint`).
// This config is provided for editor integration and CI tooling compatibility.
// Note: Biome (biome.json) handles formatting and additional lint rules.

export default [
  {
    ignores: ["dist/**", "node_modules/**", "*.map"],
  },
  {
    files: ["src/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"],
    rules: {
      // Prefer explicit types where helpful for documentation clarity
      "no-unused-vars": "warn",
      "no-console": "warn",
    },
  },
];
