import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// Per-subpath aliases mirroring the apartx-ui `exports` map (same recipe as
// apartx-help). Array form so the bare `apartx-ui` can be an EXACT regex match —
// a plain string alias would also capture `apartx-ui/styles/...` as a prefix and
// mis-resolve. Subpath entries first so they win over the bare match.
const ui = (sub: string) => path.resolve(`./src/lib/apartx-ui/src/lib/${sub}`);
const apartxUiAliases = [
  { find: "apartx-ui/structure", replacement: ui("ui/structure") },
  { find: "apartx-ui/display", replacement: ui("ui/display") },
  { find: "apartx-ui/forms", replacement: ui("ui/forms") },
  { find: "apartx-ui/overlays", replacement: ui("ui/overlays") },
  { find: "apartx-ui/data", replacement: ui("ui/data") },
  { find: "apartx-ui/navigation", replacement: ui("navigation") },
  { find: "apartx-ui/hooks", replacement: ui("hooks") },
  { find: "apartx-ui/theme", replacement: ui("theme") },
  { find: "apartx-ui/styles", replacement: ui("styles") },
  { find: /^apartx-ui$/, replacement: ui("index.ts") },
  // shared HTTP contract — the root package's `#shared` subpath import; resolve the
  // source directly (the alias keeps Vite SSR/optimizeDeps happy).
  { find: /^#shared$/, replacement: path.resolve("../shared/src/index.ts") },
];

// The browser talks to the wt-server via same-origin `/api` (HttpWtClient with an
// empty base URL); Vite proxies it to the local server in dev so there's no CORS
// and SSE streams straight through. Override the target with WT_SERVER_PORT.
const WT_PORT = process.env.WT_SERVER_PORT ?? "4499";

export default defineConfig({
  // Tailwind v4 via the Vite plugin (matches the apartx-ui kit).
  plugins: [tailwindcss(), sveltekit()],
  resolve: { alias: apartxUiAliases },
  server: {
    proxy: {
      "/api": { target: `http://127.0.0.1:${WT_PORT}`, changeOrigin: true },
    },
  },
  // The vendored kit ships a tsconfig that `extends` a generated, gitignored
  // .svelte-kit artifact absent in the submodule. esbuild auto-resolves the
  // nearest tsconfig per file and chokes on that broken `extends`; an empty
  // tsconfigRaw stops the per-file lookup (kit is plain Svelte 5 + JS/TS).
  esbuild: { tsconfigRaw: "{}" },
  ssr: {
    // The kit uses extensionless internal imports Node's ESM resolver rejects
    // during SSR — let Vite bundle/resolve it (mirrors the kit's own config).
    noExternal: ["@material/material-color-utilities"],
  },
});
