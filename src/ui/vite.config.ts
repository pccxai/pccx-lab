import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // Monaco editor pre-bundling: Monaco ships a very large ESM surface +
  // one web worker (`editor.worker`). `optimizeDeps.include` forces Vite
  // to pre-transform it during dev, avoiding the N-round request waterfall
  // that otherwise stalls first-editor-mount for seconds.
  optimizeDeps: {
    include: [
      "monaco-editor/esm/vs/editor/editor.worker",
      "monaco-editor/esm/vs/editor/editor.api",
    ],
  },
  // ES-module workers under Tauri's asset:// origin require format: "es"
  // so Vite emits `new Worker(url, { type: "module" })` call sites
  // compatible with WebKit's Worker spec.
  worker: {
    format: "es",
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
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
