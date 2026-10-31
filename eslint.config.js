import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/**
 * Four environments live in this repository and they do not share globals:
 * the Vite renderer under src/, the assertion scripts under scripts/, the
 * Pi extensions under src-tauri/resources/ that run inside the Pi runtime,
 * and the Harness packages under packages/ that run in the Harness Host.
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
      // DeepSeek Harness packages kept as they are upstream (MIT); see dsh-aliases.ts.
      "src/dsh/**",
      // dsh-better-sidebar (MIT, © 2026 dsh-external), kept as it is upstream.
      "src/better-sidebar/**",
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
    },
  },

  {
    files: ["scripts/**/*.{ts,tsx,mjs}", "*.config.{js,ts}", "vite.config.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Assertion scripts report through stdout.
      "no-console": "off",
    },
  },

  {
    files: ["src-tauri/resources/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
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
