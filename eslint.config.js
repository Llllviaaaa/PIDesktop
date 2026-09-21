import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/**
 * Three environments live in this repository and they do not share globals:
 * the Vite renderer under src/, the assertion scripts under scripts/, and the
 * Pi extensions under src-tauri/resources/ that run inside the Pi runtime.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src-tauri/target/**",
      "src-tauri/gen/**",
      "src-tauri/resources/pi-runtime/**",
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
      // The remaining set-state-in-effect warnings are data loading on mount
      // (setLoading before a fetch), a clock, and two effects that also write
      // localStorage. Replacing those means choosing a data-loading approach,
      // not a mechanical fix. Resets that follow a prop use useSyncOnChange.
      "react-hooks/set-state-in-effect": "warn",
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
);
