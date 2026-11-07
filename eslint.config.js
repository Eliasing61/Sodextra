import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "docs/**",
      ".sodextra/**",
      "apps/web/.next/**",
      "apps/web/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  {
    // Plain Node scripts (.mjs) outside the TypeScript projects.
    files: ["**/scripts/*.mjs"],
    languageOptions: { globals: { console: "readonly", fetch: "readonly", process: "readonly" } },
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
