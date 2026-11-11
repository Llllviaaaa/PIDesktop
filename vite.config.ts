import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * `vite build --mode e2e` only: load the Tauri stub (src/dev/tauriStub.ts)
 * before the app, for the browser E2E suite (e2e/). Other builds never see it.
 */
const e2eTauriStub: Plugin = {
  name: "qianji-e2e-tauri-stub",
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
          const norm = id.replace(/\\/g, "/");
          if (
            /\/node_modules\/(?:react-markdown|remark-|rehype-|highlight\.js|lowlight|unified|micromark|mdast-|hast-|unist-|vfile|dompurify)/.test(norm)
          ) {
            return "markdown";
          }
          if (norm.includes("/node_modules/@xterm/")) return "xterm";
          if (
            norm.includes("/node_modules/@codemirror/")
            && !norm.includes("/node_modules/@codemirror/lang-")
          ) {
            return "codemirror-core";
          }
          if (norm.includes("/node_modules/motion/") || norm.includes("/node_modules/framer-motion/")) return "motion";
          if (/\/node_modules\/(?:react|react-dom|scheduler|zustand|@tanstack)\//.test(norm)) {
            return "react-vendor";
          }
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
