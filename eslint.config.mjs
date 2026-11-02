import js from "@eslint/js";
import next from "eslint-config-next/core-web-vitals";
import stylistic from "@stylistic/eslint-plugin";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".next/**",
      ".agents/**",
      ".codex-attachments/**",
      ".standards/**",
      "next-env.d.ts",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...next,
  {
    plugins: { "@stylistic": stylistic },
    rules: {
      "@stylistic/max-statements-per-line": ["error", { max: 1 }],
      "@stylistic/max-len": [
        "error",
        {
          code: 120,
          ignoreUrls: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreRegExpLiterals: true,
        },
      ],
      "@stylistic/jsx-one-expression-per-line": ["error", { allow: "single-child" }],
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly", URL: "readonly" } },
  },
);
