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
    // The codebase leans on `any` in a few Pi payload boundaries and uses
    // non-null assertions sparingly; both are reported as warnings so a lint
    // run stays actionable instead of turning into a wall of errors.
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "warn",
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
      // The compiler-aware rules in eslint-plugin-react-hooks v7 fire 41 times
      // across code that predates them, mostly effects that seed state from Pi
      // events. They are warnings so the gate is adoptable today; work them
      // down and promote each one back to "error" as it reaches zero.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/use-memo": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
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
