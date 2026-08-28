import { defineConfig } from "vite";

export default defineConfig({
  root: "client",
  // Pixi 8 requires a modern browser regardless, and the client uses
  // top-level await to init the renderer before anything else runs.
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      output: {
        // Pixi selects its renderer backend through a dynamic import. Left to
        // Rollup's default splitting, that import landed in a chunk cycle with
        // the entry and never settled: app.init() hung forever and the page sat
        // blank with no error. Giving Pixi its own chunk breaks the cycle.
        // (inlineDynamicImports is not the answer here -- flattening Pixi's
        // circular modules into one scope trips a temporal-dead-zone error.)
        manualChunks: { pixi: ["pixi.js"] },
      },
    },
  },
  server: {
    port: 5173,
    proxy: { "/ws": { target: "ws://localhost:8090", ws: true } },
  },
});
