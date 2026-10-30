import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    // NOTE: apartx-ui subpath aliases live in vite.config.ts `resolve.alias`
    // (array form) — SvelteKit's `kit.alias` matches subpaths of a bare key, so
    // `apartx-ui` would swallow `apartx-ui/styles/...`. The array form lets the
    // bare alias be an exact regex match instead.
  },
};

export default config;
