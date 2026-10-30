import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Static SPA (ssr = false in +layout.ts): wt-server serves `build/` and falls back
    // to index.html for client-side routes.
    adapter: adapter({ fallback: "index.html" }),
    // `#shared` is a subpath import of the root package; TypeScript resolves `#…` via
    // the nearest package.json (web's has none), so declare it here — SvelteKit writes
    // it into the generated tsconfig `paths`. vite.config.ts keeps the bundler alias.
    alias: { "#shared": "../shared/src/index.ts" },
  },
};

export default config;
