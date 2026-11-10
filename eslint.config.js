import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/**
 * Three environments live in this repository and they do not share globals:
 * the Vite renderer under src/, the assertion suites under tests/ and the
 * scripts under scripts/, and the Harness packages under packages/ that run in
 * the Harness Host.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "dist-e2e/**",
      "test-results/**",
      "playwright-report/**",
      "node_modules/**",
      "src-tauri/target/**",
      "src-tauri/gen/**",
      // Vendored tooling, not project source.
      ".gitnexus/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // `any` is tolerated at a few Pi payload boundaries. Non-null assertions are
    // errors: every one that existed was a guarantee the type checker could be
    // shown instead.
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },

  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-hooks/exhaustive-deps": "error",
      // Data from the backend goes through TanStack Query (src/lib/queries.ts),
      // state that follows a prop through useSyncOnChange, and clocks through
      // useSyncExternalStore. An effect only talks to things outside React.
      "react-hooks/set-state-in-effect": "error",
      // Renderer code only talks to the Harness Host over the wire protocol (docs/adr/0005).
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@qianji/*", "!@qianji/protocol", "@qianji/protocol/**", "@pid/*", "@pid/**"],
              message: "Renderer code under src/ may only import @qianji/protocol from @qianji/* (ADR 0005).",
            },
            {
              regex: "(?:^|[\\\\/])packages(?:[\\\\/]|$)",
              message: "Renderer code under src/ must not import packages/ by path; use @qianji/protocol (ADR 0005).",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            ":matches(ImportExpression, TSImportType) > :matches(Literal.source[value=/^(?:@qianji\\/(?!protocol$)|@pid\\/)/], TemplateLiteral.source[expressions.length=0][quasis.0.value.cooked=/^(?:@qianji\\/(?!protocol$)|@pid\\/)/])",
          message: "Renderer code under src/ may only import @qianji/protocol from @qianji/* (ADR 0005).",
        },
        {
          selector:
            ":matches(ImportExpression, TSImportType) > :matches(Literal.source[value=/(?:^|[\\\\/])packages(?:[\\\\/]|$)/], TemplateLiteral.source[expressions.length=0][quasis.0.value.cooked=/(?:^|[\\\\/])packages(?:[\\\\/]|$)/])",
          message: "Renderer code under src/ must not import packages/ by path; use @qianji/protocol (ADR 0005).",
        },
      ],
    },
  },

  {
    files: ["scripts/**/*.{ts,tsx,mjs}", "tests/**/*.{ts,tsx}", "*.config.{js,ts}", "vite.config.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Assertion scripts report through stdout.
      "no-console": "off",
    },
  },

  {
    // Harness packages (docs/adr/0005) run in the Bun-compiled host, never in the page.
    files: ["packages/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
