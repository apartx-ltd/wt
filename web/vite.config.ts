import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// The browser talks to the wt-server via same-origin `/api` (HttpWtClient with an
// empty base URL); Vite proxies it to the local server in dev so there's no CORS
// and SSE streams straight through. Override the target with WT_SERVER_PORT.
const WT_PORT = process.env.WT_SERVER_PORT ?? "4499";

export default defineConfig({
  // Tailwind v4 via the Vite plugin (matches the apartx-ui kit).
  plugins: [tailwindcss(), sveltekit()],
  resolve: {
    // Shared HTTP contract — the root package's `#shared` subpath import; resolve the
    // source directly. `apartx-ui/*` resolves through the kit's own `exports`.
    alias: [{ find: /^#shared$/, replacement: path.resolve("../shared/src/index.ts") }],
  },
  // The kit is source-based (.svelte / .svelte.ts with TS syntax); dev pre-bundling
  // would parse its .svelte.ts as plain JS and fail. Serve it as source instead.
  optimizeDeps: { exclude: ["apartx-ui"] },
  server: {
    proxy: {
      "/api": { target: `http://127.0.0.1:${WT_PORT}`, changeOrigin: true },
    },
  },
  // esbuild auto-resolves the nearest tsconfig per file, so kit sources would be
  // compiled with the kit's own tsconfig.json (written for its checkout; older
  // revisions `extends` a generated .svelte-kit file the package lacks). An empty
  // tsconfigRaw stops that per-file lookup (the kit is plain Svelte 5 + TS).
  esbuild: { tsconfigRaw: "{}" },
});
