import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// The output is embedded into the Go binary (installer/gui.go), so it must be
// self-contained and relative: Wails serves these files from the app's own asset
// server, not from a web root.
export default defineConfig({
  // Relative asset URLs: Wails serves the embedded files from its own asset
  // server, and a relative base also lets the built page be opened directly.
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // One asset per type keeps the embedded payload small and the file list
    // predictable.
    assetsDir: "assets",
    sourcemap: false,
    target: "es2022",
  },
  server: {
    // `vite dev` is only for designing the UI outside Wails; the window itself
    // always loads the built files.
    port: 5273,
    strictPort: false,
  },
});
