import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { DSH_ALIASES } from "./dsh-aliases";
import type { Plugin } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * `vite build --mode e2e` only: load the Tauri stub (src/dev/tauriStub.ts)
 * before the app, for the browser E2E suite (e2e/). Other builds never see it.
 */
const e2eTauriStub: Plugin = {
  name: "pid-e2e-tauri-stub",
  // Before Vite bundles the page's scripts, so the stub is bundled ahead of main.tsx.
  transformIndexHtml: {
    order: "pre",
    handler: (html) => html.replace(
      '<script type="module" src="/src/main.tsx"></script>',
      '<script type="module" src="/src/dev/tauriStub.ts"></script>\n    <script type="module" src="/src/main.tsx"></script>',
    ),
  },
};

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === "e2e" ? [e2eTauriStub] : [])],
  resolve: { alias: DSH_ALIASES },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  build: {
    // The E2E build goes beside the real one, so building it never replaces dist/.
    outDir: mode === "e2e" ? "dist-e2e" : "dist",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react-markdown") || id.includes("node_modules/remark-") || id.includes("node_modules/rehype-") || id.includes("node_modules/highlight.js")) return "markdown";
          if (id.includes("node_modules/lucide-react")) return "icons";
          if (id.includes("node_modules/motion") || id.includes("node_modules/framer-motion")) return "motion";
          if (id.includes("node_modules/react") || id.includes("node_modules/zustand")) return "react-vendor";
        },
      },
    },
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    // Bind to IPv4 explicitly. `false` makes Vite pick `::1` on some systems,
    // which Tauri's dev-server check then can't reach.
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
